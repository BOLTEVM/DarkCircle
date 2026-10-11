/**
 * In-Memory Quai Zone Ledger Simulation
 * DarkCircle Protocol
 *
 * Models a single Quai zone (default Cyprus-1, chain id 9) with QUAI as the native asset and the
 * Quai rule that a multi-contract transaction sent without an access list reverts and burns its
 * whole gas limit. Gas is otherwise not metered.
 */

import crypto from "node:crypto";
import type {
  SimAccount,
  SimBlock,
  SimTransaction,
  SimTransactionRequest,
  SimTransactionReceipt,
  SimCallRequest,
  SimContract,
  SimStateSnapshot
} from "../types/sim.ts";
import type { ERC20Token } from "./erc20Token.ts";
import {
  DEFAULT_QUAI_NETWORK,
  QUAI_ORCHARD_CHAIN_ID,
  QUAI_ORCHARD_CYPRUS1,
  QUAI_MAINNET_CHAIN_ID,
  type QuaiNetwork
} from "../quai/networks.ts";
import type { QuaiAccessListEntry } from "../quai/rpc.ts";

export const DEFAULT_NATIVE_BALANCE: bigint = 100n * 10n ** 18n; // 100 QUAI default
export const MAX_UINT256: bigint = 2n ** 256n - 1n;
export const DEFAULT_GAS_LIMIT: bigint = 30_000_000n;
export const STANDARD_TX_GAS: bigint = 21_000n;
export const DEFAULT_CHAIN_ID: number = QUAI_MAINNET_CHAIN_ID;
export const DEFAULT_GAS_PRICE: bigint = 1_000_000_000n;

export class SimulatedBlockchain {
  public chainId: number = DEFAULT_CHAIN_ID;
  public network: QuaiNetwork = DEFAULT_QUAI_NETWORK;
  public readonly nativeSymbol = "QUAI";
  public accounts: Map<string, SimAccount> = new Map();
  public blocks: SimBlock[] = [];
  public currentBlockNumber: number = 1000;
  public transactions: Map<string, SimTransaction> = new Map();
  public receipts: Map<string, SimTransactionReceipt> = new Map();
  public contracts: Map<string, SimContract> = new Map();
  public tokens: Map<string, ERC20Token> = new Map();

  private _currentTimeOffset: number = 0;
  private _snapshots: Map<number, SimStateSnapshot> = new Map();
  private _snapshotCounter: number = 0;

  constructor(chainId: number = DEFAULT_CHAIN_ID, network?: QuaiNetwork) {
    this.chainId = chainId;
    this.network =
      network ?? (chainId === QUAI_ORCHARD_CHAIN_ID ? QUAI_ORCHARD_CYPRUS1 : DEFAULT_QUAI_NETWORK);
    // Exactly matches test harness: starts at block 1001 with 1 initial block
    this.createBlock();
  }

  /**
   * Deterministic Account Provisioning (100 ETH default)
   */
  public getOrCreateAccount(address: string): SimAccount {
    const norm = address.toLowerCase();
    let account = this.accounts.get(norm);
    if (!account) {
      account = {
        address: norm,
        nativeBalance: DEFAULT_NATIVE_BALANCE,
        nonce: 0,
        tokens: new Map(),
        allowances: new Map()
      };
      this.accounts.set(norm, account);
    }
    return account;
  }

  /**
   * Native Balance Operations
   */
  public getBalance(address: string): bigint {
    return this.getOrCreateAccount(address).nativeBalance;
  }

  public setBalance(address: string, amount: bigint): void {
    if (amount < 0n) throw new Error("BALANCE_CANNOT_BE_NEGATIVE");
    this.getOrCreateAccount(address).nativeBalance = amount;
  }

  public fundAccount(address: string, amount: bigint): void {
    if (amount < 0n) throw new Error("FUND_AMOUNT_CANNOT_BE_NEGATIVE");
    const acc = this.getOrCreateAccount(address);
    acc.nativeBalance += amount;
  }

  public transferNative(from: string, to: string, amount: bigint): boolean {
    if (amount < 0n) throw new Error("TRANSFER_AMOUNT_CANNOT_BE_NEGATIVE");
    const sender = this.getOrCreateAccount(from);
    if (sender.nativeBalance < amount) return false;
    const receiver = this.getOrCreateAccount(to);
    sender.nativeBalance -= amount;
    receiver.nativeBalance += amount;
    return true;
  }

  public getNonce(address: string): number {
    return this.getOrCreateAccount(address).nonce;
  }

  public incrementNonce(address: string): number {
    const acc = this.getOrCreateAccount(address);
    const prev = acc.nonce;
    acc.nonce += 1;
    return prev;
  }

  /**
   * Token Ledger Operations (100% compatible with test harness)
   */
  public mintToken(token: string, to: string, amount: bigint): void {
    if (amount < 0n) throw new Error("MINT_AMOUNT_CANNOT_BE_NEGATIVE");
    const tokenNorm = token.toLowerCase();

    if (tokenNorm === "native") {
      this.fundAccount(to, amount);
      return;
    }

    const acc = this.getOrCreateAccount(to);
    const current = acc.tokens.get(tokenNorm) || 0n;
    acc.tokens.set(tokenNorm, current + amount);

    const tokenInstance = this.tokens.get(tokenNorm);
    if (tokenInstance) {
      tokenInstance._addTotalSupply(amount);
    }
  }

  public burnToken(token: string, from: string, amount: bigint): boolean {
    if (amount < 0n) throw new Error("BURN_AMOUNT_CANNOT_BE_NEGATIVE");
    const tokenNorm = token.toLowerCase();

    if (tokenNorm === "native") {
      const acc = this.getOrCreateAccount(from);
      if (acc.nativeBalance < amount) return false;
      acc.nativeBalance -= amount;
      return true;
    }

    const acc = this.getOrCreateAccount(from);
    const current = acc.tokens.get(tokenNorm) || 0n;
    if (current < amount) return false;
    acc.tokens.set(tokenNorm, current - amount);

    const tokenInstance = this.tokens.get(tokenNorm);
    if (tokenInstance) {
      tokenInstance._subTotalSupply(amount);
    }
    return true;
  }

  public getTokenBalance(token: string, account: string): bigint {
    const tokenNorm = token.toLowerCase();
    if (tokenNorm === "native") {
      return this.getBalance(account);
    }
    const acc = this.getOrCreateAccount(account);
    return acc.tokens.get(tokenNorm) || 0n;
  }

  public transferToken(token: string, from: string, to: string, amount: bigint): boolean {
    if (amount < 0n) throw new Error("TRANSFER_AMOUNT_CANNOT_BE_NEGATIVE");
    const tokenNorm = token.toLowerCase();

    if (tokenNorm === "native") {
      return this.transferNative(from, to, amount);
    }

    const sender = this.getOrCreateAccount(from);
    const receiver = this.getOrCreateAccount(to);
    const senderBal = sender.tokens.get(tokenNorm) || 0n;
    if (senderBal < amount) return false;
    sender.tokens.set(tokenNorm, senderBal - amount);
    const receiverBal = receiver.tokens.get(tokenNorm) || 0n;
    receiver.tokens.set(tokenNorm, receiverBal + amount);
    return true;
  }

  public setTokenAllowance(token: string, owner: string, spender: string, amount: bigint): void {
    if (amount < 0n) throw new Error("ALLOWANCE_CANNOT_BE_NEGATIVE");
    const ownerAcc = this.getOrCreateAccount(owner);
    const tokenNorm = token.toLowerCase();
    const spenderNorm = spender.toLowerCase();
    let tokenAllowances = ownerAcc.allowances.get(tokenNorm);
    if (!tokenAllowances) {
      tokenAllowances = new Map();
      ownerAcc.allowances.set(tokenNorm, tokenAllowances);
    }
    tokenAllowances.set(spenderNorm, amount);
  }

  public getTokenAllowance(token: string, owner: string, spender: string): bigint {
    const ownerAcc = this.getOrCreateAccount(owner);
    const tokenNorm = token.toLowerCase();
    const spenderNorm = spender.toLowerCase();
    return ownerAcc.allowances.get(tokenNorm)?.get(spenderNorm) || 0n;
  }

  public transferFromToken(
    token: string,
    spender: string,
    from: string,
    to: string,
    amount: bigint
  ): boolean {
    const currentAllowance = this.getTokenAllowance(token, from, spender);
    if (currentAllowance < amount) return false;

    // EIP-20: If allowance is 2^256 - 1, do not decrement
    if (currentAllowance !== MAX_UINT256) {
      this.setTokenAllowance(token, from, spender, currentAllowance - amount);
    }

    return this.transferToken(token, from, to, amount);
  }

  /**
   * Block Mining & Advancement
   */
  public createBlock(transactions?: SimTransaction[], customTimestamp?: number): number {
    this.currentBlockNumber++;
    const nowSec = Math.floor(Date.now() / 1000) + this._currentTimeOffset;
    const prevBlock = this.blocks.length > 0 ? this.blocks[this.blocks.length - 1] : undefined;
    const timestamp =
      customTimestamp !== undefined
        ? customTimestamp
        : prevBlock
        ? Math.max(nowSec, prevBlock.timestamp + 1)
        : nowSec;

    const parentHash = prevBlock
      ? prevBlock.hash
      : "0x0000000000000000000000000000000000000000000000000000000000000000";
    const hash = this._generateBlockHash(this.currentBlockNumber, timestamp, parentHash);

    const block: SimBlock = {
      number: this.currentBlockNumber,
      hash,
      parentHash,
      timestamp,
      transactions: transactions ? [...transactions] : [],
      gasUsed: 0n,
      gasLimit: DEFAULT_GAS_LIMIT
    };
    this.blocks.push(block);
    return this.currentBlockNumber;
  }

  public mine(count: number = 1, intervalSeconds: number = 12): number {
    let lastBlock = this.currentBlockNumber;
    for (let i = 0; i < count; i++) {
      this._currentTimeOffset += intervalSeconds;
      lastBlock = this.createBlock();
    }
    return lastBlock;
  }

  public fastForward(seconds: number): number {
    this._currentTimeOffset += seconds;
    return Math.floor(Date.now() / 1000) + this._currentTimeOffset;
  }

  public get latestBlock(): SimBlock {
    return this.blocks[this.blocks.length - 1];
  }

  public getBlock(blockNumberOrHash: number | string): SimBlock | undefined {
    if (typeof blockNumberOrHash === "number") {
      return this.blocks.find((b) => b.number === blockNumberOrHash);
    }
    const norm = blockNumberOrHash.toLowerCase();
    return this.blocks.find((b) => b.hash.toLowerCase() === norm);
  }

  /**
   * Records a transaction that was executed by a contract simulation outside executeTransaction (the
   * shielded pool's unshield) so it has a hash, a receipt with logs, and a place in the current block.
   * This is what lets payment verification read Transfer logs exactly as it would on Quai.
   */
  public recordSyntheticTransaction(params: {
    from: string;
    to: string;
    logs: Array<Omit<import("../types/sim.ts").SimLog, "blockNumber" | "transactionHash">>;
    extra?: Record<string, unknown>;
  }): { txHash: string; blockNumber: number } {
    const txHash = "0x" + crypto.randomBytes(32).toString("hex");
    const fromNorm = params.from.toLowerCase();
    const toNorm = params.to.toLowerCase();
    const block = this.latestBlock;
    const tx: SimTransaction = {
      hash: txHash,
      from: fromNorm,
      to: toNorm,
      value: 0n,
      nonce: this.getOrCreateAccount(fromNorm).nonce++,
      gasLimit: STANDARD_TX_GAS,
      gasPrice: DEFAULT_GAS_PRICE,
      data: "0x",
      blockNumber: this.currentBlockNumber,
      timestamp: block.timestamp,
      status: "success",
      ...(params.extra ?? {})
    } as SimTransaction;
    (tx as any).timestamp = block.timestamp;
    block.transactions.push(tx);
    block.gasUsed += STANDARD_TX_GAS;
    this.transactions.set(txHash, tx);
    this.receipts.set(txHash, {
      transactionHash: txHash,
      blockNumber: this.currentBlockNumber,
      blockHash: block.hash,
      from: fromNorm,
      to: toNorm,
      status: 1,
      gasUsed: STANDARD_TX_GAS,
      logs: params.logs.map((l) => ({
        ...l,
        address: l.address.toLowerCase(),
        blockNumber: this.currentBlockNumber,
        transactionHash: txHash
      }))
    });
    return { txHash, blockNumber: this.currentBlockNumber };
  }

  /**
   * Builds the access list Quai requires for a call touching `to` plus `touched` other contracts
   * (the shape quai_createAccessList returns: one entry per contract).
   */
  public createAccessList(to: string, touched: string[] = []): QuaiAccessListEntry[] {
    const seen = new Set<string>();
    const out: QuaiAccessListEntry[] = [];
    for (const addr of [to, ...touched]) {
      const norm = addr.toLowerCase();
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({ address: norm, storageKeys: [] });
    }
    return out;
  }

  /**
   * Quai's multi-contract rule: without an access list naming every contract the call touches, the
   * transaction reverts and consumes 100% of its gas limit. Returns null when the list is
   * sufficient; otherwise burns gasLimit * gasPrice QUAI from `from` (capped at its balance) and
   * returns the burned amount.
   */
  public burnIfAccessListMissing(
    from: string,
    required: string[],
    accessList: QuaiAccessListEntry[] | undefined,
    gasLimit: bigint,
    gasPrice: bigint = DEFAULT_GAS_PRICE
  ): bigint | null {
    if (required.length === 0) return null;
    const listed = new Set((accessList ?? []).map((e) => e.address.toLowerCase()));
    if (required.every((a) => listed.has(a.toLowerCase()))) return null;
    const sender = this.getOrCreateAccount(from);
    const cost = gasLimit * gasPrice;
    const burned = cost < sender.nativeBalance ? cost : sender.nativeBalance;
    sender.nativeBalance -= burned;
    return burned;
  }

  /**
   * Transaction Execution with Authentic EVM Calldata Dispatch
   */
  public executeTransaction(req: SimTransactionRequest): SimTransactionReceipt {
    const fromNorm = req.from.toLowerCase();
    const toNorm = req.to.toLowerCase();
    const sender = this.getOrCreateAccount(fromNorm);
    const value = req.value ?? 0n;
    const txHash = "0x" + crypto.randomBytes(32).toString("hex");

    if (value < 0n) throw new Error("TRANSACTION_VALUE_CANNOT_BE_NEGATIVE");

    if (sender.nativeBalance < value) {
      const receipt: SimTransactionReceipt = {
        transactionHash: txHash,
        blockNumber: this.currentBlockNumber,
        blockHash: this.latestBlock.hash,
        from: fromNorm,
        to: toNorm,
        status: 0,
        gasUsed: STANDARD_TX_GAS,
        logs: [],
        error: "INSUFFICIENT_NATIVE_BALANCE"
      };
      this.receipts.set(txHash, receipt);
      return receipt;
    }

    // Deduct native balance
    if (value > 0n) {
      this.transferNative(fromNorm, toNorm, value);
    }

    sender.nonce++;

    const tx: SimTransaction = {
      hash: txHash,
      from: fromNorm,
      to: toNorm,
      value,
      nonce: sender.nonce - 1,
      gasLimit: req.gasLimit ?? STANDARD_TX_GAS,
      gasPrice: req.gasPrice ?? DEFAULT_GAS_PRICE,
      data: req.data ?? "0x",
      accessList: req.accessList,
      blockNumber: this.currentBlockNumber,
      timestamp: this.latestBlock.timestamp,
      status: "success",
      tokenTransfer: req.tokenTransfer
    };

    let status: 1 | 0 = 1;
    let logs: SimTransactionReceipt["logs"] = [];
    let returnData: string | undefined = undefined;
    let error: string | undefined = undefined;

    // Check if target is a registered contract
    const contract = this.contracts.get(toNorm);
    let gasUsed = STANDARD_TX_GAS;
    if (contract && req.data && req.data !== "0x") {
      const touched = contract.touchedContracts?.(req.data) ?? [];
      const burned = this.burnIfAccessListMissing(
        fromNorm,
        touched.length > 0 ? [toNorm, ...touched] : [],
        req.accessList,
        tx.gasLimit!,
        tx.gasPrice!
      );
      if (burned !== null) {
        status = 0;
        error = "ERR_QUAI_ACCESS_LIST_MISSING: multi-contract call without an access list reverts and burns the full gas limit";
        gasUsed = tx.gasLimit!;
        tx.status = "reverted";
        tx.error = error;
      } else {
        const result = contract.handleTransaction(tx);
        status = result.status;
        logs = result.logs;
        returnData = result.returnData;
        error = result.error;
        tx.status = status === 1 ? "success" : "reverted";
        tx.error = error;
      }
      // EVM semantics: a reverted call returns the attached native value to the sender.
      if (status === 0 && value > 0n) {
        this.transferNative(toNorm, fromNorm, value);
      }
    } else if (req.tokenTransfer) {
      const tokenSuccess = this.transferToken(
        req.tokenTransfer.token,
        req.tokenTransfer.from,
        req.tokenTransfer.to,
        req.tokenTransfer.amount
      );
      if (!tokenSuccess) {
        status = 0;
        error = "TOKEN_TRANSFER_FAILED";
        tx.status = "reverted";
        tx.error = error;
      }
    }

    const receipt: SimTransactionReceipt = {
      transactionHash: txHash,
      blockNumber: this.currentBlockNumber,
      blockHash: this.latestBlock.hash,
      from: fromNorm,
      to: toNorm,
      status,
      gasUsed,
      logs,
      returnData,
      error
    };

    this.latestBlock.transactions.push(tx);
    this.latestBlock.gasUsed += receipt.gasUsed;
    this.transactions.set(txHash, tx);
    this.receipts.set(txHash, receipt);

    return receipt;
  }

  /**
   * Read-only EVM Contract Call (like eth_call)
   */
  public call(req: SimCallRequest): string {
    const toNorm = req.to.toLowerCase();
    const contract = this.contracts.get(toNorm);
    if (!contract) {
      throw new Error(`NO_CONTRACT_AT_ADDRESS: ${req.to}`);
    }
    return contract.handleCall(req.data, req.from);
  }

  public getTransaction(txHash: string): SimTransaction | undefined {
    return this.transactions.get(txHash.toLowerCase()) || this.transactions.get(txHash);
  }

  public getTransactionReceipt(txHash: string): SimTransactionReceipt | undefined {
    return this.receipts.get(txHash.toLowerCase()) || this.receipts.get(txHash);
  }

  /**
   * Contract & Token Registries
   */
  public registerContract(contract: SimContract): void {
    this.contracts.set(contract.address.toLowerCase(), contract);
  }

  public registerToken(tokenInstance: ERC20Token): void {
    const addr = tokenInstance.address.toLowerCase();
    this.tokens.set(addr, tokenInstance);
    this.contracts.set(addr, tokenInstance);
  }

  public getToken(address: string): ERC20Token | undefined {
    return this.tokens.get(address.toLowerCase());
  }

  /**
   * State Snapshots & Revert (for unit tests & sandboxing)
   */
  public snapshot(): number {
    const id = ++this._snapshotCounter;
    const clonedAccounts = new Map<string, SimAccount>();

    for (const [addr, acc] of this.accounts.entries()) {
      const clonedTokens = new Map<string, bigint>(acc.tokens);
      const clonedAllowances = new Map<string, Map<string, bigint>>();
      for (const [t, m] of acc.allowances.entries()) {
        clonedAllowances.set(t, new Map(m));
      }
      clonedAccounts.set(addr, {
        address: acc.address,
        nativeBalance: acc.nativeBalance,
        nonce: acc.nonce,
        tokens: clonedTokens,
        allowances: clonedAllowances
      });
    }

    this._snapshots.set(id, {
      id,
      blockNumber: this.currentBlockNumber,
      timestamp: this.latestBlock.timestamp,
      accounts: clonedAccounts,
      blocksCount: this.blocks.length
    });

    return id;
  }

  public revert(snapshotId: number): boolean {
    const snap = this._snapshots.get(snapshotId);
    if (!snap) return false;

    this.currentBlockNumber = snap.blockNumber;
    this.accounts = snap.accounts;
    this.blocks = this.blocks.slice(0, snap.blocksCount);

    for (const id of Array.from(this._snapshots.keys())) {
      if (id >= snapshotId) {
        this._snapshots.delete(id);
      }
    }
    return true;
  }

  private _generateBlockHash(blockNumber: number, timestamp: number, parentHash: string): string {
    return (
      "0x" +
      crypto
        .createHash("sha256")
        .update(`block:${blockNumber}:${timestamp}:${parentHash}`)
        .digest("hex")
    );
  }
}
