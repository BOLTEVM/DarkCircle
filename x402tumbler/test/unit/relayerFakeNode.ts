/**
 * DarkCircle relayer tests: scripted Quai zone node
 * File: test/unit/relayerFakeNode.ts
 *
 * A transport-level fake of a Quai zone endpoint: it answers the quai_* JSON-RPC methods the
 * relayer uses, accepts signed transactions (decoding the relayer's RLP to verify the wire format
 * round-trips and the sender recovers), mines blocks, and models reorgs, dropped transactions,
 * reverted transactions and stale/lying receipts. No network, no real chain.
 */

import { AbiCoder, decodeRlp, encodeRlp, getAddress, id as keccakId, keccak256, recoverAddress } from "ethers";
import type { JsonRpcTransport, QuaiAccessListEntry, QuaiReceipt } from "../../src/quai/rpc.ts";
import { POOL_UNSHIELD_IFACE } from "../../src/relayer/relayer.ts";

export interface DecodedQuaiTx {
  chainId: bigint;
  nonce: bigint;
  gasPrice: bigint;
  gas: bigint;
  to: string;
  value: bigint;
  data: string;
  accessList: QuaiAccessListEntry[];
  yParity: number;
  r: string;
  s: string;
  /** Recovered sender (ecrecover against the Quai signing digest). */
  from: string;
  hash: string;
}

const rpcError = (message: string) => Object.assign(new Error(message), { code: -32000 });

const NULLIFIER_SPENT_SEL = keccakId("nullifierSpent(uint256)").slice(0, 10).toLowerCase();
const IS_KNOWN_ROOT_SEL = keccakId("isKnownRoot(uint256)").slice(0, 10).toLowerCase();

export class FakeQuaiNode {
  public chainId = 15000;
  public nodeLocation = ["0x0", "0x0"];
  public blockNumber = 1000;
  public gasPrice = 1n;
  public readonly balances = new Map<string, bigint>();
  public readonly nonces = new Map<string, number>();
  public readonly spentNullifiers = new Set<string>();
  public readonly knownRoots = new Set<string>();
  private spentAtBlock = Infinity;

  /** The node simulates the pool's simulation endpoints. */
  public simulationFails = false;
  public estimateGas = 100_000n;
  public accessListFor: (to: string, data: string) => QuaiAccessListEntry[] = (to) => [
    { address: to.toLowerCase(), storageKeys: [] }
  ];

  /** Behavior toggles for adversarial scenarios. */
  public revertNextTx = false;
  public loseNextReceipt = false;
  public undoSpendOnReorg = false;
  public staleReceiptBlock: number | null = null; // receipts report this block regardless of the real one
  public futureReceipt = false; // receipts claim a block ahead of the head

  public readonly sent: DecodedQuaiTx[] = [];
  private readonly receipts = new Map<string, { receipt: QuaiReceipt; block: number; status: number }>();
  /** nullifier per sent tx hash, moved into spentNullifiers when the tx is mined successfully. */
  private readonly minedSpend = new Map<string, string | null>();

  public readonly poolAddress: string;
  public readonly relayerAddress: string;

  constructor(poolAddress: string, relayerAddress: string) {
    this.poolAddress = poolAddress;
    this.relayerAddress = relayerAddress;
    this.balances.set(relayerAddress.toLowerCase(), 1_000n);
    this.nonces.set(relayerAddress.toLowerCase(), 0);
  }

  // ---------------------------------------------------------------- mining & reorg

  public mineBlocks(count = 1): void {
    for (let i = 0; i < count; i++) {
      this.blockNumber++;
      for (const [, r] of this.receipts) {
        if (r.block === -1) {
          r.block = this.blockNumber;
          r.receipt.blockNumber = "0x" + this.blockNumber.toString(16);
        }
      }
      for (const [hash, nullifier] of this.minedSpend) {
        if (nullifier && this.receipts.get(hash)?.block === this.blockNumber && this.receipts.get(hash)?.status === 1) {
          this.spentNullifiers.add(nullifier);
          this.spentAtBlock = this.blockNumber;
        }
      }
    }
  }

  /**
   * A reorg of `depth` blocks: the head rewinds and every receipt from the orphaned range
   * disappears (getTransactionReceipt goes back to null). With `undoSpend`, the spends from
   * orphaned blocks are undone too — exactly what a real unshield reorg does.
   */
  public reorg(depth: number, opts: { undoSpend?: boolean } = {}): void {
    const newHead = this.blockNumber - depth;
    for (const [hash, r] of this.receipts) {
      if (r.block > newHead) this.receipts.delete(hash);
    }
    if ((opts.undoSpend ?? this.undoSpendOnReorg) && newHead < this.spentAtBlock) {
      this.spentNullifiers.clear();
    }
    this.blockNumber = newHead;
  }

  // ---------------------------------------------------------------- transport

  public transport: JsonRpcTransport = async (method, params) => {
    switch (method) {
      case "quai_chainId":
        return "0x" + this.chainId.toString(16);
      case "quai_nodeLocation":
        return this.nodeLocation;
      case "quai_blockNumber":
        return "0x" + this.blockNumber.toString(16);
      case "quai_gasPrice":
        return "0x" + this.gasPrice.toString(16);
      case "quai_getBalance": {
        const bal = this.balances.get(String(params[0]).toLowerCase()) ?? 0n;
        return "0x" + bal.toString(16);
      }
      case "quai_getTransactionCount": {
        const n = this.nonces.get(String(params[0]).toLowerCase()) ?? 0;
        return "0x" + n.toString(16);
      }
      case "quai_createAccessList": {
        if (this.simulationFails) return { error: "execution reverted" };
        const tx = params[0] as { to: string; data: string };
        return { accessList: this.accessListFor(tx.to, tx.data), gasUsed: "0x" + this.estimateGas.toString(16) };
      }
      case "quai_estimateGas": {
        if (this.simulationFails) throw rpcError("execution reverted");
        return "0x" + this.estimateGas.toString(16);
      }
      case "quai_call":
        return this.handleCall(params[0] as { to: string; data: string });
      case "quai_sendRawTransaction":
        return this.handleSend(String(params[0]));
      case "quai_getTransactionReceipt":
        return this.handleReceipt(String(params[0]));
      default:
        throw rpcError(`unsupported method ${method}`);
    }
  };

  private handleCall(tx: { to: string; data: string }): string {
    const data = tx.data.toLowerCase();
    const coder = AbiCoder.defaultAbiCoder();
    if (data.startsWith(NULLIFIER_SPENT_SEL)) {
      const [n] = coder.decode(["uint256"], "0x" + data.slice(10));
      return coder.encode(["bool"], [this.spentNullifiers.has(BigInt(n).toString())]);
    }
    if (data.startsWith(IS_KNOWN_ROOT_SEL)) {
      const [r] = coder.decode(["uint256"], "0x" + data.slice(10));
      return coder.encode(["bool"], [this.knownRoots.has(BigInt(r).toString())]);
    }
    throw rpcError(`unsupported call selector ${data.slice(0, 10)}`);
  }

  private handleSend(raw: string): string {
    const decoded = decodeSignedQuaiTransaction(raw);
    const from = decoded.from.toLowerCase();
    if (from !== this.relayerAddress.toLowerCase()) {
      throw rpcError(`invalid sender ${decoded.from}`);
    }
    const expectedNonce = this.nonces.get(from) ?? 0;
    if (decoded.nonce !== BigInt(expectedNonce)) {
      throw rpcError(`invalid nonce: got ${decoded.nonce}, expected ${expectedNonce}`);
    }
    this.nonces.set(from, expectedNonce + 1);
    this.sent.push(decoded);

    const status = this.revertNextTx ? 0 : 1;
    this.revertNextTx = false;
    const hash = decoded.hash;
    if (!this.loseNextReceipt) {
      this.receipts.set(hash, {
        receipt: {
          status,
          blockNumber: "0x0", // filled at mine time
          transactionHash: hash,
          from: decoded.from,
          to: decoded.to,
          gasUsed: "0x" + this.estimateGas.toString(16)
        },
        block: -1,
        status
      });
    }
    this.loseNextReceipt = false;
    this.minedSpend.set(hash, status === 1 ? this.extractNullifier(decoded.data) : null);
    return hash;
  }

  private extractNullifier(data: string): string | null {
    try {
      const parsed = POOL_UNSHIELD_IFACE.parseTransaction({ data });
      if (!parsed) return null;
      return BigInt((parsed.args as unknown as { pay: { nullifier: bigint } }).pay.nullifier).toString();
    } catch {
      return null;
    }
  }

  private handleReceipt(hash: string): QuaiReceipt | null {
    const entry = this.receipts.get(hash);
    if (!entry || entry.block === -1) return null;
    const receipt = { ...entry.receipt };
    if (this.staleReceiptBlock !== null) receipt.blockNumber = "0x" + this.staleReceiptBlock.toString(16);
    if (this.futureReceipt) receipt.blockNumber = "0x" + (this.blockNumber + 100).toString(16);
    return receipt;
  }
}

/**
 * Decodes a signed Quai transaction and so verifies the relayer's wire format: the field order
 * [chainId, nonce, gasPrice, gas, to, value, data, accessList, yParity, r, s], and that the sender
 * recovers with standard ecrecover against keccak256(RLP(unsigned fields)).
 */
export function decodeSignedQuaiTransaction(raw: string): DecodedQuaiTx {
  const fields = decodeRlp(raw) as string[];
  if (fields.length !== 11) throw new Error(`expected 11 RLP fields, got ${fields.length}`);
  const [chainId, nonce, gasPrice, gas, to, value, data, accessList, yParity, r, s] = fields;
  // RLP decodes a zero byte-string as "0x"; normalize back before converting.
  const bi = (v: string): bigint => (v === "" || v === "0x" ? 0n : BigInt(v));
  const digest = keccak256(encodeRlp(fields.slice(0, 8)));
  const from = recoverAddress(digest, { r, s, yParity: Number(bi(yParity)) as 0 | 1 });
  return {
    chainId: bi(chainId),
    nonce: bi(nonce),
    gasPrice: bi(gasPrice),
    gas: bi(gas),
    to: getAddress(to === "" || to === "0x" ? "0x0000000000000000000000000000000000000000" : to),
    value: bi(value),
    data,
    accessList: (accessList as unknown as [string, string[]][]).map(([address, storageKeys]) => ({
      address: getAddress(address === "" || address === "0x" ? "0x0000000000000000000000000000000000000000" : address),
      storageKeys
    })),
    yParity: Number(bi(yParity)),
    r,
    s,
    from,
    hash: keccak256(raw)
  };
}
