/**
 * DarkCircle: Quai zone JSON-RPC client
 * File: src/quai/rpc.ts
 *
 * Thin JSON-RPC 2.0 client for a Quai *zone* endpoint. It exists (instead of ethers' provider)
 * because Quai transactions carry no r/s/v, so ethers v6 `getBlock(n, true)` throws `missing r`,
 * and because Quai needs a few rules ethers does not know about:
 *   - contract calls only work on a zone endpoint (Prime/Region answer "call can only called in
 *     zone chain"), so `assertZone()` checks quai_chainId and quai_nodeLocation up front;
 *   - every address must be EIP-55 checksummed or the node answers "address has invalid checksum";
 *   - a multi-contract transaction sent without an access list reverts and burns its ENTIRE gas
 *     limit, so `prepareContractCall()` attaches quai_createAccessList output and refuses to
 *     return a transaction when the node reports a VM error.
 * This client only reads and prepares; it never signs or broadcasts.
 */

import { Interface, TypedDataEncoder, id as keccakId } from "ethers";
import { toQuaiChecksum } from "./address.ts";
import { DEFAULT_QUAI_NETWORK, type QuaiNetwork } from "./networks.ts";
import type { QuaiToken } from "./tokens.ts";

export type JsonRpcTransport = (method: string, params: unknown[]) => Promise<unknown>;

export interface QuaiAccessListEntry {
  address: string;
  storageKeys: string[];
}

export interface QuaiCallRequest {
  from?: string;
  to: string;
  data?: string;
  value?: bigint;
  gasLimit?: bigint;
  accessList?: QuaiAccessListEntry[];
}

export interface PreparedQuaiTransaction {
  from?: string;
  to: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit: string;
  accessList: QuaiAccessListEntry[];
}

export interface QuaiRpcOptions {
  network?: QuaiNetwork;
  /** Replaces the HTTP transport (used by tests and by callers that already own a connection). */
  transport?: JsonRpcTransport;
  timeoutMs?: number;
  /** Extra gas on top of quai_estimateGas. A revert burns the whole limit, so keep this modest. */
  gasBufferPercent?: number;
}

const hex = (n: bigint) => "0x" + n.toString(16);

export function httpTransport(url: string, timeoutMs: number): JsonRpcTransport {
  let nextId = 1;
  return async (method, params) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        signal: controller.signal
      });
      if (!res.ok) {
        throw new Error(`ERR_QUAI_RPC_HTTP_${res.status}: ${method}`);
      }
      const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
      if (body.error) {
        throw new Error(`ERR_QUAI_RPC: ${method}: ${body.error.message}`);
      }
      return body.result;
    } finally {
      clearTimeout(timer);
    }
  };
}

export class QuaiRpcClient {
  public readonly network: QuaiNetwork;
  private readonly transport: JsonRpcTransport;
  private readonly gasBufferPercent: number;
  private zoneVerified = false;

  constructor(options: QuaiRpcOptions = {}) {
    this.network = options.network ?? DEFAULT_QUAI_NETWORK;
    this.transport = options.transport ?? httpTransport(this.network.rpcUrl, options.timeoutMs ?? 15_000);
    this.gasBufferPercent = options.gasBufferPercent ?? 20;
  }

  public async request<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    try {
      return (await this.transport(method, params)) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/only called in zone chain/i.test(msg)) {
        throw new Error(
          `ERR_QUAI_NOT_ZONE_ENDPOINT: ${this.network.rpcUrl} is not a zone endpoint; contract calls need /${this.network.zone.name}`
        );
      }
      throw err;
    }
  }

  /** Confirms the endpoint is the configured zone on the configured chain. Cached after success. */
  public async assertZone(): Promise<void> {
    if (this.zoneVerified) return;
    const chainId = Number(await this.request<string>("quai_chainId"));
    if (chainId !== this.network.chainId) {
      throw new Error(
        `ERR_QUAI_CHAIN_ID_MISMATCH: endpoint reports chain ${chainId}, expected ${this.network.chainId}`
      );
    }
    const loc = await this.request<string[]>("quai_nodeLocation");
    const [region, zone] = (loc ?? []).map((v) => Number(v));
    if (loc?.length !== 2 || region !== this.network.zone.region || zone !== this.network.zone.zone) {
      throw new Error(
        `ERR_QUAI_ZONE_MISMATCH: endpoint location ${JSON.stringify(loc)}, expected ` +
          `[${this.network.zone.region},${this.network.zone.zone}] (${this.network.zone.name})`
      );
    }
    this.zoneVerified = true;
  }

  public async blockNumber(): Promise<number> {
    return Number(await this.request<string>("quai_blockNumber"));
  }

  public async getBalance(address: string): Promise<bigint> {
    return BigInt(await this.request<string>("quai_getBalance", [toQuaiChecksum(address), "latest"]));
  }

  public async getCode(address: string): Promise<string> {
    return this.request<string>("quai_getCode", [toQuaiChecksum(address), "latest"]);
  }

  public async getTransactionCount(address: string): Promise<number> {
    return Number(await this.request<string>("quai_getTransactionCount", [toQuaiChecksum(address), "pending"]));
  }

  public async call(req: QuaiCallRequest): Promise<string> {
    return this.request<string>("quai_call", [this.toRpcTx(req), "latest"]);
  }

  public async getTransactionReceipt(txHash: string): Promise<QuaiReceipt | null> {
    return this.request<QuaiReceipt | null>("quai_getTransactionReceipt", [txHash]);
  }

  private toRpcTx(req: QuaiCallRequest): Record<string, unknown> {
    const tx: Record<string, unknown> = { to: toQuaiChecksum(req.to) };
    if (req.from) tx.from = toQuaiChecksum(req.from);
    if (req.data) tx.data = req.data;
    if (req.value !== undefined) tx.value = hex(req.value);
    if (req.gasLimit !== undefined) tx.gas = hex(req.gasLimit);
    if (req.accessList) tx.accessList = req.accessList;
    return tx;
  }

  /**
   * Builds a transaction that is safe to sign on Quai: access list attached from
   * quai_createAccessList and gas limit from quai_estimateGas plus a modest buffer.
   * Throws (ERR_QUAI_SIMULATION_FAILED) instead of returning a transaction that would revert and
   * burn its whole gas limit.
   */
  public async prepareContractCall(req: QuaiCallRequest): Promise<PreparedQuaiTransaction> {
    await this.assertZone();
    const rpcTx = this.toRpcTx(req);

    const listed = await this.request<{
      accessList?: QuaiAccessListEntry[];
      gasUsed?: string;
      error?: string;
    }>("quai_createAccessList", [rpcTx]);
    if (!listed || listed.error) {
      throw new Error(`ERR_QUAI_SIMULATION_FAILED: createAccessList: ${listed?.error ?? "empty response"}`);
    }
    const accessList = (listed.accessList ?? []).map((e) => ({
      address: toQuaiChecksum(e.address),
      storageKeys: e.storageKeys ?? []
    }));

    const estimate = BigInt(await this.request<string>("quai_estimateGas", [{ ...rpcTx, accessList }]));
    const gasLimit = estimate + (estimate * BigInt(this.gasBufferPercent)) / 100n;

    return {
      from: req.from ? toQuaiChecksum(req.from) : undefined,
      to: toQuaiChecksum(req.to),
      data: req.data ?? "0x",
      value: hex(req.value ?? 0n),
      chainId: this.network.chainId,
      gasLimit: hex(gasLimit),
      accessList
    };
  }

  /**
   * Simulates a CONTRACT CREATION (no `to`) from `from`: returns the access list the node computes for it and
   * quai_estimateGas with that list attached. A constructor that calls another contract (the pool calls its
   * hasher) makes this a multi-contract transaction, which on Quai reverts and burns its whole gas limit when
   * sent without a list. Throws ERR_QUAI_SIMULATION_FAILED when either call reports an error, so nothing that
   * would revert is ever handed to a wallet. Read-only: nothing is signed or sent.
   */
  public async simulateCreation(req: { from: string; data: string }): Promise<{ accessList: QuaiAccessListEntry[]; estimate: bigint; simulatedGasUsed: bigint | null }> {
    await this.assertZone();
    const tx = { from: toQuaiChecksum(req.from), data: req.data };
    let listed: { accessList?: QuaiAccessListEntry[]; gasUsed?: string; error?: string } | null;
    try {
      listed = await this.request("quai_createAccessList", [tx]);
    } catch (err) {
      throw new Error(`ERR_QUAI_SIMULATION_FAILED: createAccessList: ${(err as Error).message}`);
    }
    if (!listed || listed.error) throw new Error(`ERR_QUAI_SIMULATION_FAILED: createAccessList: ${listed?.error ?? "empty response"}`);
    const accessList = (listed.accessList ?? []).map((e) => ({ address: toQuaiChecksum(e.address), storageKeys: e.storageKeys ?? [] }));
    let estimate: bigint;
    try {
      estimate = BigInt(await this.request<string>("quai_estimateGas", [{ ...tx, accessList }]));
    } catch (err) {
      throw new Error(`ERR_QUAI_SIMULATION_FAILED: estimateGas: ${(err as Error).message}`);
    }
    return { accessList, estimate, simulatedGasUsed: listed.gasUsed ? BigInt(listed.gasUsed) : null };
  }

  /** The latest block's gas limit (a transaction above it is refused outright). */
  public async blockGasLimit(): Promise<bigint> {
    const block = await this.request<{ header?: { gasLimit?: string }; woHeader?: { gasLimit?: string }; gasLimit?: string } | null>("quai_getBlockByNumber", ["latest", false]);
    const raw = block?.header?.gasLimit ?? block?.woHeader?.gasLimit ?? block?.gasLimit;
    if (!raw) throw new Error("ERR_QUAI_RPC: the latest block carries no gas limit");
    return BigInt(raw);
  }

  /** Reads name/symbol/decimals/code from chain and compares them with a registry entry. */
  public async verifyToken(token: QuaiToken): Promise<TokenVerification> {
    await this.assertZone();
    const iface = new Interface([
      "function name() view returns (string)",
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)"
    ]);
    const read = async (fn: string) => {
      const raw = await this.call({ to: token.address, data: iface.encodeFunctionData(fn) });
      return iface.decodeFunctionResult(fn, raw)[0];
    };
    const code = await this.getCode(token.address);
    const codeBytes = code === "0x" ? 0 : (code.length - 2) / 2;
    const problems: string[] = [];
    if (codeBytes === 0) problems.push("no contract code at address");
    let onChain = { name: "", symbol: "", decimals: -1 };
    let permitDomainOk: boolean | undefined;
    if (codeBytes > 0) {
      onChain = {
        name: String(await read("name")),
        symbol: String(await read("symbol")),
        decimals: Number(await read("decimals"))
      };
      if (onChain.symbol !== token.symbol) problems.push(`symbol ${onChain.symbol} != ${token.symbol}`);
      if (onChain.name !== token.name) problems.push(`name ${onChain.name} != ${token.name}`);
      if (onChain.decimals !== token.decimals) problems.push(`decimals ${onChain.decimals} != ${token.decimals}`);

      // A permit signature is only valid for the exact EIP-712 domain the contract uses; if ours is
      // wrong, every gasless sweep would fail on chain after passing in the simulation.
      if (token.permit && token.permitDomain) {
        const ds = new Interface(["function DOMAIN_SEPARATOR() view returns (bytes32)"]);
        const rawSep = await this.call({ to: token.address, data: ds.encodeFunctionData("DOMAIN_SEPARATOR") });
        const onChainSep = String(ds.decodeFunctionResult("DOMAIN_SEPARATOR", rawSep)[0]).toLowerCase();
        const expectedSep = TypedDataEncoder.hashDomain({
          name: token.permitDomain.name,
          version: token.permitDomain.version,
          chainId: this.network.chainId,
          verifyingContract: token.address
        }).toLowerCase();
        permitDomainOk = onChainSep === expectedSep;
        if (!permitDomainOk) problems.push(`permit DOMAIN_SEPARATOR ${onChainSep} != expected ${expectedSep}`);
      }
    }
    return { token, codeBytes, onChain, permitDomainOk, ok: problems.length === 0, problems };
  }

  /** Reports which optional selectors a token's bytecode carries (deposit/withdraw, permit). */
  public async probeCapabilities(token: QuaiToken): Promise<{ wrapsNative: boolean; permit: boolean }> {
    const code = (await this.getCode(token.address)).toLowerCase();
    const has = (sig: string) => code.includes(keccakId(sig).slice(2, 10));
    return {
      wrapsNative: has("deposit()") && has("withdraw(uint256)"),
      permit: has("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)")
    };
  }
}

export interface TokenVerification {
  token: QuaiToken;
  codeBytes: number;
  onChain: { name: string; symbol: string; decimals: number };
  /** For permit tokens: whether the contract's DOMAIN_SEPARATOR matches the registry's domain. */
  permitDomainOk?: boolean;
  ok: boolean;
  problems: string[];
}

export interface QuaiReceipt {
  status?: string | number;
  blockNumber?: string;
  transactionHash?: string;
  from?: string;
  to?: string;
  /** Present only on a contract-creation receipt. */
  contractAddress?: string;
  gasUsed?: string;
  logs?: Array<{ address: string; topics: string[]; data: string }>;
}
