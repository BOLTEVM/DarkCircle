/**
 * DarkCircle: Enterprise-grade x402 Tumbler for Corporate Privacy
 * Railgun Smart Wallet & Shielded Pool Contract Simulation
 *
 * Implements:
 * - Incremental Merkle Tree (16 depth, 65536 capacity, 64 historical roots ring buffer)
 * - BN254 Poseidon note commitment hashing
 * - Nullifier registry preventing double-spends (ERROR_NULLIFIER_ALREADY_SPENT), on CANONICAL field elements
 * - Private Proof of Innocence (PPOI) screening via Sparse Merkle Tree & PPOIValidator
 * - Standby window quarantine and depositor-only unshield rules
 * - In-memory token custody, atomic unshield, and event journaling
 *
 * Trust modes
 * -----------
 * "verified" (default): shield() pulls funds from the depositor (allowance + balance), and unshield()
 *   checks the full unshield statement from a witness (see unshieldVerifier.ts): note membership,
 *   ownership, nullifier binding, value conservation, anti-front-running hash, and a sanctions origin
 *   read from the pool's own deposit record. A caller can no longer drain the pool with a fresh nullifier.
 * "trusted-harness": the earlier behaviour, where the pool believes the request. It exists so the
 *   pre-audit adversarial suites keep exercising their scenarios; it is never a safe configuration and
 *   is reported as such by status() and by the shielded-transaction checklist.
 */

import crypto from "node:crypto";
import { ethers } from "ethers";
import { Fp, BN254_SCALAR_FIELD } from "../crypto/field.ts";
import { poseidon4 } from "../crypto/poseidon.ts";
import { IncrementalMerkleTree } from "../crypto/merkleTree.ts";
import { SparseMerkleTree } from "../crypto/smt.ts";
import { assertQuaiPaymentAddress } from "../quai/address.ts";
import { DEFAULT_QUAI_NETWORK, type QuaiNetwork } from "../quai/networks.ts";
import type { QuaiAccessListEntry } from "../quai/rpc.ts";
import type { SerializedNote } from "../types/crypto.ts";
import type { ShieldResult } from "../types/railgun.ts";
import type { PPOIValidator } from "../ppoi/ppoiValidator.ts";
import type { SanctionsRegistry } from "../ppoi/sanctionsList.ts";
import type { UnshieldValidationRequest } from "../types/ppoi.ts";
import type {
  ShieldedUTXO,
  UnshieldRequest,
  PoolEvent,
  UnshieldResult,
  SimLog
} from "../types/sim.ts";
import { SIM_POOL_ADDRESS } from "./defaults.ts";
import { verifyUnshieldStatement } from "./unshieldVerifier.ts";

export type { UnshieldRequest, ShieldedUTXO, PoolEvent, UnshieldResult };
export type PoolTrustMode = "verified" | "trusted-harness";

const TOPIC_TRANSFER = ethers.id("Transfer(address,address,uint256)");

/** 32-byte padded topic for an address; legacy harness labels that are not hex are hashed instead. */
function padAddress(addr: string): string {
  try {
    return ethers.zeroPadValue(addr, 32);
  } catch {
    return ethers.zeroPadValue(ethers.id(addr).slice(0, 42), 32);
  }
}

/**
 * Interface for the underlying simulated blockchain ledger.
 */
export interface ISimulatedBlockchain {
  currentBlockNumber: number;
  createBlock(): number;
  transferToken(token: string, from: string, to: string, amount: bigint): boolean;
  transferFromToken?(token: string, spender: string, from: string, to: string, amount: bigint): boolean;
  getTokenBalance?(token: string, account: string): bigint;
  blocks?: Array<{ number: number; timestamp: number; transactions: any[] }>;
  /** Records a transaction with logs in the current block so receipts and Transfer events exist. */
  recordSyntheticTransaction?(params: {
    from: string;
    to: string;
    logs: Array<Omit<SimLog, "blockNumber" | "transactionHash">>;
    extra?: Record<string, unknown>;
  }): { txHash: string; blockNumber: number };
}

/**
 * Options for configuring RailgunSmartWallet.
 */
export interface RailgunPoolOptions {
  contractAddress?: string;
  depth?: number;
  maxHistoricalRoots?: number;
  standbyWindowSeconds?: number;
  ppoiValidator?: PPOIValidator;
  sanctionsRegistry?: SanctionsRegistry;
  customHasher?: (...inputs: (bigint | string | number)[]) => bigint;
  /** "verified" (default) or the explicit, unsafe "trusted-harness". */
  mode?: PoolTrustMode;
  /** Quai network the pool lives on; recipients, relayers and depositors must be valid addresses there. */
  network?: QuaiNetwork;
  /** Token allowlist (addresses). When omitted, verified pools accept any token the ledger knows. */
  allowedTokens?: string[];
}

/**
 * Merkle Tree wrapper extending IncrementalMerkleTree to expose public leaves array.
 */
export class PoolIncrementalMerkleTree extends IncrementalMerkleTree {
  public leaves: bigint[] = [];

  public override insert(leaf: bigint): number {
    const normalized = Fp.mod(leaf);
    const leafIndex = super.insert(normalized);
    this.leaves.push(normalized);
    return leafIndex;
  }
}

/**
 * Safely converts an Ethereum address or label string to a BN254 field element.
 * If the string is standard hex, parses it as BigInt modulo p.
 * If the string is an arbitrary label (e.g. "0xDepositorOrigin"), hashes it deterministically.
 */
export function addressToBigInt(addr: string | bigint): bigint {
  if (typeof addr === "bigint") {
    return Fp.mod(addr);
  }
  const clean = addr.trim().toLowerCase();
  if (/^0x[0-9a-f]{1,64}$/.test(clean)) {
    return BigInt(clean) % BN254_SCALAR_FIELD;
  }
  const hash = crypto.createHash("sha256").update(clean).digest("hex");
  return BigInt("0x" + hash) % BN254_SCALAR_FIELD;
}

export interface SolvencyRow {
  token: string;
  poolBalance: bigint;
  liabilities: bigint;
  ok: boolean;
}

/**
 * Production-grade Railgun Smart Wallet Contract Simulation.
 */
export class RailgunSmartWallet {
  public merkleTree: PoolIncrementalMerkleTree;
  /** Legacy string view of spent nullifiers (raw and canonical decimal spellings). */
  public nullifiers: Set<string> = new Set();
  /** Authoritative set: canonical field elements, so hex/decimal/padded spellings collide. */
  public spentNullifiers: Set<bigint> = new Set();
  public spentCommitments: Set<string> = new Set();
  public sanctionsSMT: SparseMerkleTree;
  public blockchain: ISimulatedBlockchain;
  public contractAddress: string = SIM_POOL_ADDRESS;
  public utxoRegistry: Map<string, ShieldedUTXO> = new Map();
  public standbyWindowSeconds: number = 0;
  public poolEvents: Array<PoolEvent> = [];
  public ppoiValidator?: PPOIValidator;
  public sanctionsRegistry?: SanctionsRegistry;
  public readonly mode: PoolTrustMode;
  public readonly network: QuaiNetwork;
  public readonly allowedTokens?: Set<string>;
  private readonly customHasher?: (...inputs: (bigint | string | number)[]) => bigint;

  constructor(blockchain: ISimulatedBlockchain, options?: RailgunPoolOptions) {
    this.blockchain = blockchain;
    const depth = options?.depth ?? 16;
    const maxHistoricalRoots = options?.maxHistoricalRoots ?? 64;

    this.merkleTree = new PoolIncrementalMerkleTree(depth, maxHistoricalRoots);
    this.sanctionsSMT = new SparseMerkleTree(256);

    // Compatibility shim: ensure sanctionsSMT has .set(key, value)
    if (typeof (this.sanctionsSMT as any).set !== "function") {
      (this.sanctionsSMT as any).set = (k: bigint, v: bigint) => this.sanctionsSMT.insert(k, v);
    }

    this.mode = options?.mode ?? "verified";
    this.network = options?.network ?? (blockchain as any).network ?? DEFAULT_QUAI_NETWORK;
    if (options?.allowedTokens) {
      this.allowedTokens = new Set(options.allowedTokens.map((t) => t.toLowerCase()));
    }
    if (options?.contractAddress) this.contractAddress = options.contractAddress;
    if (options?.standbyWindowSeconds !== undefined) this.standbyWindowSeconds = options.standbyWindowSeconds;
    if (options?.ppoiValidator) this.ppoiValidator = options.ppoiValidator;
    if (options?.sanctionsRegistry) this.sanctionsRegistry = options.sanctionsRegistry;
    if (options?.customHasher) this.customHasher = options.customHasher;
  }

  public get verified(): boolean {
    return this.mode === "verified";
  }

  /** Read-only snapshot for status displays and the pre-flight checklist. */
  public status(): {
    mode: PoolTrustMode;
    contractAddress: string;
    network: string;
    root: bigint;
    leafCount: number;
    capacity: number;
    spentNullifiers: number;
    standbyWindowSeconds: number;
    ppoiValidatorAttached: boolean;
  } {
    return {
      mode: this.mode,
      contractAddress: this.contractAddress,
      network: this.network.id,
      root: this.merkleTree.root,
      leafCount: this.merkleTree.nextIndex,
      capacity: this.merkleTree.capacity,
      spentNullifiers: this.spentNullifiers.size,
      standbyWindowSeconds: this.standbyWindowSeconds,
      ppoiValidatorAttached: !!this.ppoiValidator
    };
  }

  /**
   * Registers an address as sanctioned in the internal SMT and optional sanctions registry.
   */
  public registerSanctionedAddress(address: string): bigint {
    const key = addressToBigInt(address);
    if (typeof (this.sanctionsSMT as any).set === "function") {
      (this.sanctionsSMT as any).set(key, 1n);
    } else {
      this.sanctionsSMT.insert(key, 1n);
    }

    if (this.sanctionsRegistry) {
      try {
        this.sanctionsRegistry.addSanctionedAddress(address);
      } catch {
        this.sanctionsRegistry.addSanctionedCommitment(key);
      }
    }
    return this.sanctionsSMT.root;
  }

  /**
   * Computes note commitment using Poseidon hashing over BN254.
   */
  public computeCommitment(
    recipientNpk: bigint,
    token: string,
    amount: bigint,
    blinding: bigint
  ): bigint {
    if (this.customHasher) {
      return this.customHasher(recipientNpk, token.toLowerCase(), amount, blinding);
    }
    return poseidon4(recipientNpk, token, amount, blinding);
  }

  private tokenBalance(token: string, account: string): bigint {
    return this.blockchain.getTokenBalance ? this.blockchain.getTokenBalance(token, account) : 0n;
  }

  /**
   * Shields ERC-20 tokens into the private pool, creating a new UTXO commitment leaf.
   *
   * Verified pools take custody: the depositor must hold the tokens and have approved the pool, and
   * the amount is pulled in the same call. Trusted-harness pools only do the bookkeeping (the caller is
   * expected to have moved the tokens), which lets a caller create notes the pool never received.
   */
  public shield(
    token: string,
    amount: bigint,
    recipientNpk: bigint,
    blinding: bigint,
    memo: string = "",
    depositorAddress?: string,
    /** PPOI lineage: who the funds really came from (the payer). Defaults to the depositor. */
    originAddress?: string
  ): ShieldResult & { leafIndex: number; commitment: bigint; root: bigint; depositTimestamp: number } {
    if (amount <= 0n) {
      throw new Error("SHIELD_AMOUNT_MUST_BE_POSITIVE");
    }

    if (this.verified) {
      if (amount >= 1n << 128n) throw new Error("ERR_VALUE_OUT_OF_RANGE");
      if (!depositorAddress) throw new Error("ERR_DEPOSITOR_REQUIRED: verified pools need the depositing address");
      try {
        assertQuaiPaymentAddress(depositorAddress, this.network);
      } catch (err) {
        throw new Error(`ERR_QUAI_RECIPIENT_INVALID: ${(err as Error).message}`);
      }
      if (this.allowedTokens && !this.allowedTokens.has(token.toLowerCase())) {
        throw new Error(`ERR_TOKEN_NOT_ALLOWED: ${token}`);
      }
      Fp.canonical(recipientNpk, "npk");
      Fp.canonical(blinding, "blinding");
    }

    const commitment = this.computeCommitment(recipientNpk, token, amount, blinding);
    if (this.verified && this.utxoRegistry.has(commitment.toString())) {
      // The registry maps commitment -> deposit origin; a second deposit of the same note would
      // overwrite the origin and launder a note past sanctions screening.
      throw new Error("ERR_COMMITMENT_EXISTS");
    }
    if (this.merkleTree.nextIndex >= this.merkleTree.capacity) {
      throw new Error(`MERKLE_TREE_FULL: capacity of ${this.merkleTree.capacity} leaves exceeded`);
    }

    if (this.verified) {
      const pulled =
        typeof this.blockchain.transferFromToken === "function" &&
        this.blockchain.transferFromToken(token, this.contractAddress, depositorAddress!, this.contractAddress, amount);
      if (!pulled) throw new Error("ERR_SHIELD_FUNDING_FAILED: depositor balance or allowance to the pool is insufficient");
    }

    const leafIndex = this.merkleTree.insert(commitment);
    const depositTimestamp = Math.floor(Date.now() / 1000);

    const utxo: ShieldedUTXO = {
      commitment,
      leafIndex,
      token: token.toLowerCase(),
      value: amount,
      blinding,
      rho: blinding,
      npk: recipientNpk,
      memo,
      depositorAddress: (originAddress ?? depositorAddress)?.toLowerCase(),
      depositTimestamp
    };
    this.utxoRegistry.set(commitment.toString(), utxo);

    const event: PoolEvent = {
      type: "SHIELD",
      leafIndex,
      commitment,
      token: token.toLowerCase(),
      amount,
      depositorAddress: (originAddress ?? depositorAddress)?.toLowerCase(),
      memo,
      timestamp: depositTimestamp,
      blockNumber: this.blockchain.currentBlockNumber
    };
    this.poolEvents.push(event);

    const serializedNote: SerializedNote = {
      npk: Fp.toHex(recipientNpk),
      token: token.toLowerCase(),
      value: amount.toString(),
      rho: Fp.toHex(blinding),
      memo,
      leafIndex,
      commitment: Fp.toHex(commitment)
    };

    return {
      leafIndex,
      commitment,
      root: this.merkleTree.root,
      treeRoot: this.merkleTree.root,
      note: serializedNote,
      // The wallet's copy of the note must carry THIS value: PPOI binds the note to the pool's own record, so
      // a timestamp re-read from the clock after this call can differ by a second and strand the note.
      depositTimestamp
    };
  }

  /**
   * Executes a private unshield withdrawal from the pool to a destination address.
   * `ctx.sender` is msg.sender for the recorded transaction (the relayer); `ctx.accessList` is the Quai
   * access list it carried.
   */
  public unshield(
    req: UnshieldRequest,
    ctx?: { sender?: string; accessList?: QuaiAccessListEntry[] }
  ): UnshieldResult {
    // 1. Canonical public inputs ------------------------------------------------------------
    let rootBigInt: bigint;
    let nullifierKey: bigint | undefined;
    const rawNullifierStr = String(req.nullifier);
    const nullifierStr = rawNullifierStr.toLowerCase();

    if (this.verified) {
      // Reject malformed / out-of-range spellings outright; verifyUnshieldStatement re-derives them.
      rootBigInt = Fp.canonical(req.merkleRoot, "merkleRoot");
      nullifierKey = Fp.canonical(req.nullifier, "nullifier");
    } else {
      try {
        rootBigInt = typeof req.merkleRoot === "string" ? BigInt(req.merkleRoot) : req.merkleRoot;
      } catch {
        throw new Error("EXPIRED_MERKLE_ROOT");
      }
      try {
        nullifierKey = Fp.canonical(req.nullifier as any, "nullifier");
      } catch {
        nullifierKey = undefined; // legacy harness labels: fall back to string identity
      }
    }

    // 2. Root validity, nullifier uniqueness ---------------------------------------------------
    const isRootValid =
      this.merkleTree.historicalRoots.includes(rootBigInt) ||
      this.merkleTree.root === rootBigInt ||
      this.merkleTree.isValidRoot(rootBigInt);
    if (!isRootValid) {
      throw new Error("EXPIRED_MERKLE_ROOT");
    }

    if (
      (nullifierKey !== undefined && this.spentNullifiers.has(nullifierKey)) ||
      this.nullifiers.has(nullifierStr) ||
      this.nullifiers.has(rawNullifierStr)
    ) {
      throw new Error("ERROR_NULLIFIER_ALREADY_SPENT");
    }

    if (req.amount < 0n || req.relayerFee < 0n) {
      throw new Error("ERR_AMOUNT_INVALID: amount and relayer fee must not be negative");
    }

    // 3. Statement verification (verified pools) --------------------------------------------
    let proven: ReturnType<typeof verifyUnshieldStatement> | undefined;
    if (this.verified) {
      proven = verifyUnshieldStatement(req, this);
      if (this.spentCommitments.has(proven.inputCommitment.toString() + ":" + req.witness!.leafIndex)) {
        throw new Error("ERROR_NULLIFIER_ALREADY_SPENT");
      }
    }

    // 4. Private Proof of Innocence (PPOI) & Sanctions verification ---------------------------
    // Verified pools screen the origin recorded at deposit; the request's own claim is not trusted.
    const originRecord = proven?.origin ?? this.findMatchingUTXO(req);
    const claimedOrigin =
      proven?.origin.depositorAddress ??
      (typeof req.ppoiProof?.depositOrigin === "string" ? req.ppoiProof.depositOrigin : undefined);

    if (this.verified && !req.ppoiProof) {
      throw new Error("PPOI_PROOF_REQUIRED");
    }
    if (req.ppoiProof) {
      if (!req.ppoiProof.isNonSanctioned) {
        throw new Error("PPOI_SANCTIONED_INPUT");
      }

      const originForScreening = claimedOrigin ?? req.ppoiProof.depositOrigin;
      if (originForScreening !== undefined && originForScreening !== null) {
        const originKey =
          typeof originForScreening === "string" ? addressToBigInt(originForScreening) : originForScreening;

        if (this.sanctionsSMT.get(originKey) !== 0n) {
          throw new Error("PPOI_SANCTIONED_INPUT");
        }
        if (this.verified && this.sanctionsRegistry && typeof originForScreening === "string") {
          let listed = false;
          try {
            listed = this.sanctionsRegistry.isSanctioned(originForScreening);
          } catch {
            listed = false;
          }
          if (listed) throw new Error("PPOI_SANCTIONED_INPUT");
        }
      }

      if (this.ppoiValidator) {
        if (this.verified && !(req.ppoiProof as any).smtProof) {
          throw new Error("PPOI_PROOF_REQUIRED");
        }
        if ((req.ppoiProof as any).smtProof) {
          const originStr =
            typeof claimedOrigin === "string"
              ? claimedOrigin
              : originRecord?.depositorAddress || "0x0000000000000000000000000000000000000000";

          const valReq: UnshieldValidationRequest = {
            merkleRoot: req.merkleRoot.toString(),
            nullifier: req.nullifier.toString(),
            recipient: req.recipient,
            token: req.token,
            amount: req.amount,
            relayerFee: req.relayerFee,
            relayerAddress: req.relayerAddress,
            depositOrigin: originStr,
            depositTimestamp:
              originRecord?.depositTimestamp ??
              (req.ppoiProof as any).depositTimestamp ??
              Math.floor(Date.now() / 1000),
            ppoiProof: req.ppoiProof as any
          };

          const valResult = this.ppoiValidator.validateUnshield(valReq);
          if (!valResult.success) {
            throw new Error(valResult.errorCode || "PPOI_COMPLIANCE_FAILED");
          }
        }
      }
    }

    // 5. Standby window: during the active window, only the depositor can unshield -------------
    if (this.standbyWindowSeconds > 0 && req.ppoiProof) {
      const originKey =
        typeof claimedOrigin === "string" ? addressToBigInt(claimedOrigin) : (req.ppoiProof.depositOrigin as bigint);

      const utxo =
        proven?.origin ??
        Array.from(this.utxoRegistry.values()).find((u) => {
          if (!u.depositorAddress) return false;
          if (originKey !== undefined && addressToBigInt(u.depositorAddress) === originKey) {
            return true;
          }
          if (
            typeof req.ppoiProof.depositOrigin === "string" &&
            u.depositorAddress.toLowerCase() === req.ppoiProof.depositOrigin.toLowerCase()
          ) {
            return true;
          }
          return false;
        });

      if (utxo) {
        const elapsed = Math.floor(Date.now() / 1000) - utxo.depositTimestamp;
        if (
          elapsed < this.standbyWindowSeconds &&
          utxo.depositorAddress?.toLowerCase() !== req.recipient.toLowerCase()
        ) {
          throw new Error(
            "STANDBY_WINDOW_ACTIVE_ONLY_DEPOSITOR_UNSHIELD_ALLOWED: ERROR_STANDBY_WINDOW_ACTIVE"
          );
        }
      }
    }

    // 6. Atomicity pre-checks: everything that can fail must fail BEFORE any state changes ----
    const hasChange =
      req.changeCommitment !== undefined && req.changeCommitment !== null && BigInt(req.changeCommitment) > 0n;
    if (this.tokenBalance(req.token, this.contractAddress) < req.amount + req.relayerFee &&
        typeof this.blockchain.getTokenBalance === "function") {
      throw new Error(
        this.tokenBalance(req.token, this.contractAddress) < req.amount
          ? "INSUFFICIENT_POOL_BALANCE"
          : "INSUFFICIENT_POOL_BALANCE_FOR_FEE"
      );
    }
    if (hasChange && this.merkleTree.nextIndex >= this.merkleTree.capacity) {
      throw new Error(`MERKLE_TREE_FULL: capacity of ${this.merkleTree.capacity} leaves exceeded`);
    }
    if (this.verified && hasChange && this.utxoRegistry.has(BigInt(req.changeCommitment as any).toString())) {
      // A change commitment equal to an existing note would overwrite that note's deposit origin.
      throw new Error("ERR_COMMITMENT_EXISTS");
    }

    // 7. Effects ----------------------------------------------------------------------------
    const okRecipient = this.blockchain.transferToken(req.token, this.contractAddress, req.recipient, req.amount);
    if (!okRecipient) {
      throw new Error("INSUFFICIENT_POOL_BALANCE");
    }
    if (req.relayerFee > 0n) {
      const okRelayer = this.blockchain.transferToken(req.token, this.contractAddress, req.relayerAddress, req.relayerFee);
      if (!okRelayer) {
        // Cannot happen after the pre-check; undo the recipient leg rather than leave a half-executed withdrawal.
        this.blockchain.transferToken(req.token, req.recipient, this.contractAddress, req.amount);
        throw new Error("INSUFFICIENT_POOL_BALANCE_FOR_FEE");
      }
    }

    // Record nullifiers to prevent double-spends
    if (nullifierKey !== undefined) this.spentNullifiers.add(nullifierKey);
    this.nullifiers.add(nullifierStr);
    this.nullifiers.add(rawNullifierStr);
    if (nullifierKey !== undefined) this.nullifiers.add(nullifierKey.toString());
    if (proven) {
      this.spentCommitments.add(proven.inputCommitment.toString() + ":" + req.witness!.leafIndex);
    }

    // Insert change commitment into Merkle tree if present, inheriting the parent's deposit origin
    let changeLeafIndex: number | undefined;
    if (hasChange) {
      const changeBigInt =
        typeof req.changeCommitment === "string" ? BigInt(req.changeCommitment) : (req.changeCommitment as bigint);
      changeLeafIndex = this.merkleTree.insert(changeBigInt);
      if (originRecord) {
        this.utxoRegistry.set(changeBigInt.toString(), {
          commitment: changeBigInt,
          leafIndex: changeLeafIndex,
          token: req.token.toLowerCase(),
          value: proven ? proven.changeValue : 0n,
          blinding: req.witness?.changeNote?.rho ?? 0n,
          rho: req.witness?.changeNote?.rho,
          npk: req.witness?.changeNote?.npk,
          memo: "change_note",
          depositorAddress: originRecord.depositorAddress,
          depositTimestamp: originRecord.depositTimestamp
        });
      }
    }

    // Mine block, record the transaction with its Transfer logs, and journal the pool event
    const blockNumber = this.blockchain.createBlock();
    const sender = ctx?.sender ?? req.relayerAddress;
    const logs: Array<Omit<SimLog, "blockNumber" | "transactionHash">> = [
      {
        address: req.token.toLowerCase(),
        topics: [TOPIC_TRANSFER, padAddress(this.contractAddress), padAddress(req.recipient)],
        data: ethers.toBeHex(req.amount, 32)
      }
    ];
    if (req.relayerFee > 0n) {
      logs.push({
        address: req.token.toLowerCase(),
        topics: [TOPIC_TRANSFER, padAddress(this.contractAddress), padAddress(req.relayerAddress)],
        data: ethers.toBeHex(req.relayerFee, 32)
      });
    }
    let txHash: string;
    if (typeof this.blockchain.recordSyntheticTransaction === "function") {
      txHash = this.blockchain.recordSyntheticTransaction({
        from: sender,
        to: this.contractAddress,
        logs,
        extra: {
          accessList: ctx?.accessList,
          token: req.token,
          recipient: req.recipient,
          amount: req.amount,
          fee: req.relayerFee
        }
      }).txHash;
    } else {
      txHash = "0x" + crypto.randomBytes(32).toString("hex");
    }

    const event: PoolEvent = {
      type: "UNSHIELD",
      txHash,
      nullifier: nullifierStr,
      recipient: req.recipient,
      token: req.token,
      amount: req.amount,
      fee: req.relayerFee,
      relayer: req.relayerAddress,
      blockNumber,
      timestamp: Math.floor(Date.now() / 1000)
    };
    this.poolEvents.push(event);

    return {
      txHash,
      blockNumber,
      nullifier: nullifierStr,
      recipient: req.recipient,
      amount: req.amount,
      fee: req.relayerFee,
      relayer: req.relayerAddress,
      changeLeafIndex,
      inputCommitment: proven ? proven.inputCommitment.toString() : undefined
    };
  }

  /**
   * Solvency: for each token, the pool must hold at least the value of every unspent note it knows of.
   * Unbacked notes are how a shielded pool gets drained, so tests and the checklist assert this.
   */
  public solvency(): SolvencyRow[] {
    const liabilities = new Map<string, bigint>();
    for (const u of this.utxoRegistry.values()) {
      if (this.spentCommitments.has(u.commitment.toString() + ":" + u.leafIndex)) continue;
      liabilities.set(u.token, (liabilities.get(u.token) ?? 0n) + u.value);
    }
    return Array.from(liabilities.entries()).map(([token, owed]) => {
      const held = this.tokenBalance(token, this.contractAddress);
      return { token, poolBalance: held, liabilities: owed, ok: held >= owed };
    });
  }

  private findMatchingUTXO(req: UnshieldRequest): ShieldedUTXO | undefined {
    if (req.ppoiProof?.depositOrigin !== undefined) {
      const originKey =
        typeof req.ppoiProof.depositOrigin === "string"
          ? addressToBigInt(req.ppoiProof.depositOrigin)
          : req.ppoiProof.depositOrigin;
      return Array.from(this.utxoRegistry.values()).find((u) => {
        if (!u.depositorAddress) return false;
        return addressToBigInt(u.depositorAddress) === originKey;
      });
    }
    return undefined;
  }
}

/**
 * Enterprise Railgun Pool alias
 */
export class RailgunPool extends RailgunSmartWallet {}
