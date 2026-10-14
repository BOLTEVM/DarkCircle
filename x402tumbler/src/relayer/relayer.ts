/**
 * DarkCircle production relayer: core service
 * File: src/relayer/relayer.ts
 *
 * A separate process that accepts an unshield proof and a payment request, checks it against the
 * pool on the zone, simulates it, sends it from its own funded account, waits for confirmation and
 * returns the receipt (RELAYER_PLAN.md §2). It never sees a spending key, a viewing key, a note or
 * a blinding factor: the request carries a proof and public fields only.
 *
 * Refusal contract: every reject path throws RelayerError with one of the names in
 * src/relayer/types.ts — the HTTP layer maps names to status codes and the log records names only.
 *
 * Quoting (phase-1 decision 2): fee = max(minFee, unshieldGasEstimate × gasPrice × headroom) with
 * headroom 2.5 (Orchard call costs observed at 0.43x–2.47x of the simulator). The client binds the
 * fee in the proof before relaying; the binding rule is enforced here at relay time: a request whose
 * fee is below the current quote is refused (FEE_BELOW_QUOTE). The relayer can never be asked for
 * more than was quoted, because the proof binds the fee.
 */

import { Interface, getAddress } from "ethers";
import type { QuaiRpcClient } from "../quai/rpc.ts";
import { toQuaiChecksum } from "../quai/address.ts";
import { RelayStore } from "./store.ts";
import { UNSHIELD_SELECTOR, type QuaiTxSigner } from "./signer.ts";
import { RelayerError, type RelayQuote, type RelayRecord, type RelayRequest } from "./types.ts";

const POOL_READ_IFACE = new Interface([
  "function nullifierSpent(uint256 nullifier) view returns (bool)",
  "function isKnownRoot(uint256 root) view returns (bool)"
]);

export const POOL_UNSHIELD_IFACE = new Interface([
  "function unshield((uint256[2] a, uint256[2][2] b, uint256[2] c) proof, (uint256 root, uint256 nullifier, uint256 changeCommitment, address recipient, uint256 amount, address relayer, uint256 fee) pay)"
]);

export interface RelayerConfig {
  /** The pool this relayer serves — the only contract its key may ever call. */
  poolAddress: string;
  /** The pool's token. A request naming any other token is refused (one relayer per pool). */
  tokenAddress: string;
  /** Published minimum fee, base units of the pool token. */
  minFee: bigint;
  /** Gas×price×headroom component of the quote. */
  unshieldGasEstimate: bigint;
  /** Multiplied onto the gas cost: 150 means ×2.5. */
  gasHeadroomPercent: number;
  /** How many blocks a quote stays at least as good as its issue-time value. */
  quoteValidityBlocks: number;
  /** QUAI floor: at or below it the relayer takes itself offline (ERR_RELAYER_GAS_FLOOR). */
  minGasBalance: bigint;
  /** Confirmations before a relay counts as final (≥ 2; Orchard saw ~25-block reorgs). */
  confirmationsRequired: number;
  /** Resend attempts for a nullifier across reorgs/drops before giving up. */
  maxRelayAttempts: number;
  /** Blocks without any receipt before a pending relay is marked dropped. */
  txTimeoutBlocks: number;
}

/**
 * The nonce manager. The hint is persisted BEFORE a transaction is broadcast, so a crash between
 * send and record never reuses a nonce; on start the hint is reconciled with the on-chain pending
 * count, so a nonce the chain never saw (dropped tx) is not skipped either.
 */
export class NonceManager {
  private next: number | null = null;
  private readonly store: RelayStore;
  private readonly rpc: QuaiRpcClient;
  private readonly address: string;

  constructor(store: RelayStore, rpc: QuaiRpcClient, address: string) {
    this.store = store;
    this.rpc = rpc;
    this.address = address;
  }

  public async acquire(): Promise<number> {
    if (this.next === null) {
      const onChain = await this.rpc.getTransactionCount(this.address);
      this.next = Math.max(onChain, this.store.nonceHint);
    }
    const nonce = this.next;
    this.next = nonce + 1;
    this.store.setNonceHint(this.next);
    return nonce;
  }

  /** Returns a nonce whose send failed, so a later acquire reuses it. */
  public release(nonce: number): void {
    if (this.next !== null && nonce < this.next) {
      this.next = nonce;
      this.store.setNonceHint(nonce);
    }
  }
}

export interface RelayerDeps {
  rpc: QuaiRpcClient;
  signer: QuaiTxSigner;
  store: RelayStore;
  config: RelayerConfig;
  log?: (msg: string) => void;
}

export class DarkCircleRelayer {
  public readonly config: RelayerConfig;
  public readonly signerAddress: string;

  private readonly rpc: QuaiRpcClient;
  private readonly signer: QuaiTxSigner;
  private readonly store: RelayStore;
  private readonly nonces: NonceManager;
  private readonly log: (msg: string) => void;

  private online = true;
  private offlineReason?: string;
  private reconciling = false;
  private gasFloorTripped = false;
  /** Per-nullifier serialization: concurrent relays of one nullifier send exactly one transaction. */
  private readonly nullifierLocks = new Map<string, Promise<unknown>>();

  constructor(deps: RelayerDeps) {
    this.rpc = deps.rpc;
    this.signer = deps.signer;
    this.store = deps.store;
    this.config = deps.config;
    this.log = deps.log ?? (() => {});
    this.signerAddress = deps.signer.address;
    this.nonces = new NonceManager(deps.store, deps.rpc, deps.signer.address);
    // Config sanity at boot, not at first request.
    toQuaiChecksum(deps.config.poolAddress);
    toQuaiChecksum(deps.config.tokenAddress);
    if (deps.config.confirmationsRequired < 2) {
      throw new Error("ERR_RELAYER_CONFIG: confirmationsRequired must be at least 2 (reorg-aware, O-10)");
    }
  }

  // ------------------------------------------------------------------ operator controls

  public setOnline(online: boolean, reason?: string): void {
    this.online = online;
    this.offlineReason = online ? undefined : reason?.trim() || undefined;
    this.log(`relayer ${online ? "online" : "OFFLINE"}${this.offlineReason ? `: ${this.offlineReason}` : ""}`);
  }

  public isOnline(): boolean {
    return this.online && !this.gasFloorTripped;
  }

  public isReconciling(): boolean {
    return this.reconciling;
  }

  /** What /health serves: operator-facing state, no key material, no client payloads. */
  public health(): { online: boolean; reconciling: boolean; relayer: string; pool: string; token: string; inFlight: number } {
    return {
      online: this.isOnline(),
      reconciling: this.reconciling,
      relayer: this.signerAddress,
      pool: this.config.poolAddress,
      token: this.config.tokenAddress,
      inFlight: this.store.inFlight().length
    };
  }

  // ------------------------------------------------------------------ quoting

  public async getQuote(): Promise<RelayQuote> {
    const quoteBlock = await this.rpc.blockNumber();
    const gasPrice = BigInt(await this.rpc.request<string>("quai_gasPrice"));
    const headroom = 100n + BigInt(this.config.gasHeadroomPercent);
    const gasComponent = (this.config.unshieldGasEstimate * gasPrice * headroom) / 100n;
    const fee = this.config.minFee > gasComponent ? this.config.minFee : gasComponent;
    return {
      relayer: this.signerAddress,
      feeToken: toQuaiChecksum(this.config.tokenAddress),
      estimatedFeeUnits: fee.toString(),
      expiresAtBlock: quoteBlock + this.config.quoteValidityBlocks,
      gasPrice: gasPrice.toString(),
      quoteBlock
    };
  }

  // ------------------------------------------------------------------ relay

  public async relay(req: RelayRequest): Promise<RelayRecord> {
    // Serialize per nullifier so a double submit (sequential or concurrent) can never both pass the
    // idempotency check and both send. The lock key is the raw nullifier field; a malformed one
    // still serializes fine and is refused inside relayInner.
    const key = String(req?.payment?.nullifier ?? "unknown");
    const prev = this.nullifierLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => current);
    this.nullifierLocks.set(key, tail);
    await prev;
    try {
      return await this.relayInner(req);
    } finally {
      release();
      if (this.nullifierLocks.get(key) === tail) this.nullifierLocks.delete(key);
    }
  }

  private async relayInner(req: RelayRequest): Promise<RelayRecord> {
    await this.assertServing();

    // 1. One relayer per pool: the token must be the one this pool settles.
    if (toQuaiChecksum(req.token).toLowerCase() !== toQuaiChecksum(this.config.tokenAddress).toLowerCase()) {
      throw new RelayerError("TOKEN_POOL_MISMATCH", `this relayer settles ${this.config.tokenAddress} only`);
    }

    // 2. Shape checks before anything touches the chain.
    const payment = this.parsePayment(req);

    // 3. The proof binds the relayer; a request naming anyone else is refused.
    if (getAddress(payment.relayer).toLowerCase() !== this.signerAddress.toLowerCase()) {
      throw new RelayerError("RELAYER_ADDRESS_MISMATCH", "the proof names a different relayer");
    }

    // 4. The fee must meet the current quote. The proof binds the fee, so this is the whole check:
    //    the relayer can never be asked for more than the client already proved.
    const quote = await this.getQuote();
    if (payment.fee < BigInt(quote.estimatedFeeUnits)) {
      throw new RelayerError("FEE_BELOW_QUOTE", `fee ${payment.fee} below quoted ${quote.estimatedFeeUnits}`);
    }

    const nullifierHex = "0x" + payment.nullifier.toString(16);

    // 5. Idempotency: a nullifier with a live transaction returns the original record, never a
    //    second send. reverted / dropped / reorged records fall through to the re-checked resend.
    const existing = this.store.get(nullifierHex);
    if (existing && (existing.status === "pending" || existing.status === "confirmed")) {
      this.log(`idempotent replay of ${nullifierHex}: returning ${existing.txHash ?? existing.status}`);
      return existing;
    }
    if (existing && existing.attempts >= this.config.maxRelayAttempts) {
      throw new RelayerError("RELAY_ATTEMPTS_EXHAUSTED", `${existing.attempts} attempts for ${nullifierHex}`);
    }

    // 6. On-chain prechecks: a spent nullifier or an unknown root is refused before any gas is used.
    if (await this.readPoolBool("nullifierSpent", payment.nullifier)) {
      if (existing && existing.status !== "confirmed") {
        // The chain says spent but we have no confirmation on record (we crashed between send and
        // confirm): adopt the spend instead of sending a second transaction.
        this.log(`nullifier ${nullifierHex} is spent on chain; marking confirmed by adoption`);
        return this.store.update(nullifierHex, { status: "confirmed", lastError: undefined });
      }
      throw new RelayerError("NULLIFIER_ALREADY_SPENT");
    }
    if (!(await this.readPoolBool("isKnownRoot", payment.root))) {
      throw new RelayerError("UNKNOWN_ROOT", `root 0x${payment.root.toString(16)} is not in the pool's history`);
    }

    // 7. Simulate the exact call on the zone. A step that would revert is refused here, because a
    //    revert on Quai burns the entire gas limit.
    const calldata = POOL_UNSHIELD_IFACE.encodeFunctionData("unshield", [
      [req.proof.a, req.proof.b, req.proof.c],
      [payment.root, payment.nullifier, payment.changeCommitment, payment.recipient, payment.amount, payment.relayer, payment.fee]
    ]);
    let prepared;
    try {
      prepared = await this.rpc.prepareContractCall({
        from: this.signerAddress,
        to: this.config.poolAddress,
        data: calldata
      });
    } catch (err) {
      throw new RelayerError("RELAY_SIMULATION_FAILED", (err as Error).message);
    }

    // 8. Sign (the signer is policy-guarded: pool address + unshield selector only) and broadcast.
    const nonce = await this.nonces.acquire();
    let txHash: string;
    try {
      const gasPrice = BigInt(await this.rpc.request<string>("quai_gasPrice"));
      const raw = await this.signer.sign({ ...prepared, nonce, gasPrice });
      txHash = await this.rpc.request<string>("quai_sendRawTransaction", [raw]);
    } catch (err) {
      this.nonces.release(nonce);
      throw err;
    }

    const head = await this.rpc.blockNumber();
    const base = {
      txHash,
      nonce,
      fee: payment.fee.toString(),
      recipient: payment.recipient,
      amount: payment.amount.toString(),
      submittedAtBlock: head,
      lastError: undefined
    };
    const record = existing
      ? this.store.update(nullifierHex, { ...base, status: "pending", attempts: existing.attempts + 1 })
      : this.store.insert({
          nullifier: nullifierHex,
          status: "pending",
          attempts: 1,
          confirmations: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          ...base
        });
    this.log(`relayed ${nullifierHex} as ${txHash} (nonce ${nonce}, fee ${record.fee})`);
    return record;
  }

  public status(nullifier: string): RelayRecord | undefined {
    return this.store.get(nullifier);
  }

  // ------------------------------------------------------------------ confirmations & reorgs

  /**
   * Advances every in-flight (and recently settled) relay against the chain head.
   *  - receipt with enough confirmations  -> confirmed
   *  - receipt, status 0                  -> reverted (nullifier NOT spent; relay() may retry)
   *  - no receipt inside the timeout      -> dropped (relay() may retry)
   *  - a confirmed/pending receipt that disappears, or a receipt from a block ahead of the head
   *    (a lying or lagging RPC)           -> reorged: the chain is re-read before any resend, and
   *                                          resend happens only through relay(), never here.
   */
  public async sync(): Promise<void> {
    let head: number;
    try {
      head = await this.rpc.blockNumber();
    } catch (err) {
      this.log(`sync skipped: cannot read the chain head: ${(err as Error).message}`);
      return;
    }

    for (const rec of this.store.all()) {
      if (!rec.txHash) continue;
      if (rec.status === "dropped" || rec.status === "reverted") continue;

      const receipt = await this.rpc.getTransactionReceipt(rec.txHash).catch(() => null);
      const receiptBlock = receipt?.blockNumber !== undefined ? Number(receipt.blockNumber) : null;

      if (receipt && receiptBlock !== null && receiptBlock > head) {
        // A receipt from the future is stale or lying RPC state: do not count it.
        this.log(`sync: ignoring receipt for ${rec.txHash} at block ${receiptBlock} > head ${head}`);
        continue;
      }

      if (!receipt) {
        if (rec.status === "confirmed" || rec.status === "reorged") {
          await this.handleReorg(rec, head);
        } else if (rec.submittedAtBlock !== undefined && head - rec.submittedAtBlock > this.config.txTimeoutBlocks) {
          this.store.update(rec.nullifier, { status: "dropped", lastError: "ERR_RPC_TX_DROPPED" });
          this.log(`sync: ${rec.txHash} produced no receipt within ${this.config.txTimeoutBlocks} blocks; marked dropped`);
        }
        continue;
      }

      if (Number(receipt.status) !== 1) {
        this.store.update(rec.nullifier, { status: "reverted", lastError: "the unshield reverted on chain (gas burned; nullifier not spent)" });
        continue;
      }

      const confirmations = head - Number(receipt.blockNumber) + 1;
      if (confirmations >= this.config.confirmationsRequired) {
        if (rec.status !== "confirmed") this.log(`sync: ${rec.txHash} confirmed (${confirmations} blocks)`);
        this.store.update(rec.nullifier, { status: "confirmed", confirmations });
      } else {
        this.store.update(rec.nullifier, { status: "pending", confirmations });
      }
    }
  }

  private async handleReorg(rec: RelayRecord, head: number): Promise<void> {
    const nullifierBig = BigInt(rec.nullifier);
    const spent = await this.readPoolBool("nullifierSpent", nullifierBig);
    if (spent) {
      // The spend re-landed (the same transaction or a re-send): wait for its receipt to return.
      this.store.update(rec.nullifier, { status: "reorged", lastError: `reorg past block ${head}; nullifier is spent on chain, waiting for the transaction to re-land` });
    } else {
      this.store.update(rec.nullifier, {
        status: "reorged",
        txHash: undefined,
        lastError: "reorged out; the nullifier is unspent — re-POST the same relay request to resend"
      });
      this.log(`sync: ${rec.nullifier} reorged out and unspent; a re-POSTed relay will resend it`);
    }
  }

  /** Reconcile on start: read the chain for every in-flight nullifier before accepting new work. */
  public async reconcile(): Promise<void> {
    this.reconciling = true;
    try {
      this.log(`reconciling ${this.store.inFlight().length} in-flight relay(s) against the chain`);
      await this.sync();
      // Re-read the on-chain nonce so a nonce gap opened while we were down is not skipped.
      const onChain = await this.rpc.getTransactionCount(this.signerAddress);
      this.store.setNonceHint(Math.max(onChain, this.store.nonceHint));
    } finally {
      this.reconciling = false;
      this.log("reconcile complete; accepting work");
    }
  }

  // ------------------------------------------------------------------ internals

  private async assertServing(): Promise<void> {
    if (this.reconciling) throw new RelayerError("ERR_RELAYER_RECONCILING", "reading the chain for in-flight nullifiers; retry shortly");
    if (!this.online) {
      throw new RelayerError("ERR_RELAYER_OFFLINE", this.offlineReason ?? "taken offline by the operator");
    }
    const balance = await this.rpc.getBalance(this.signerAddress);
    if (balance <= this.config.minGasBalance) {
      this.gasFloorTripped = true;
      throw new RelayerError(
        "ERR_RELAYER_GAS_FLOOR",
        `gas balance ${balance} QUAI wei at or below the floor ${this.config.minGasBalance}; top up the relayer key`
      );
    }
    this.gasFloorTripped = false;
  }

  private async readPoolBool(fn: "nullifierSpent" | "isKnownRoot", arg: bigint): Promise<boolean> {
    const raw = await this.rpc.call({ to: this.config.poolAddress, data: POOL_READ_IFACE.encodeFunctionData(fn, [arg]) });
    return Boolean(POOL_READ_IFACE.decodeFunctionResult(fn, raw)[0]);
  }

  private parsePayment(req: RelayRequest): {
    root: bigint;
    nullifier: bigint;
    changeCommitment: bigint;
    recipient: string;
    amount: bigint;
    relayer: string;
    fee: bigint;
  } {
    try {
      const p = req.payment;
      const root = BigInt(p.root);
      const nullifier = BigInt(p.nullifier);
      const changeCommitment = BigInt(p.changeCommitment);
      const amount = BigInt(p.amount);
      const fee = BigInt(p.fee);
      const recipient = getAddress(p.recipient);
      const relayer = getAddress(p.relayer);
      const field = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
      if (nullifier === 0n || nullifier >= field) throw new Error("nullifier out of range");
      if (changeCommitment >= field) throw new Error("change commitment out of range");
      if (root <= 0n || root >= field) throw new Error("root out of range");
      if (amount <= 0n) throw new Error("amount must be positive");
      if (fee < 0n) throw new Error("fee cannot be negative");
      for (const [label, pair] of [["a", req.proof.a], ["c", req.proof.c]] as const) {
        for (const v of pair) {
          const b = BigInt(v);
          if (b < 0n || b >= field) throw new Error(`proof.${label} not a field element`);
        }
      }
      for (const row of req.proof.b) {
        for (const v of row) {
          const b = BigInt(v);
          if (b < 0n || b >= field) throw new Error("proof.b not a field element");
        }
      }
      return { root, nullifier, changeCommitment, recipient, amount, relayer, fee };
    } catch (err) {
      if (err instanceof RelayerError) throw err;
      throw new RelayerError("ERR_BAD_REQUEST", (err as Error).message);
    }
  }
}

export { UNSHIELD_SELECTOR };
