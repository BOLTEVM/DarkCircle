import fs from 'node:fs';
import path from 'node:path';
import { getAddress, keccak256, toBeHex, zeroPadValue } from 'ethers';
import {
  vaultInterface,
  factoryInterface,
  computeVaultTxHash,
  VAULT_PROXY_RUNTIME_CODE,
  PINNED_CONTRACTS,
  ERC1967_IMPLEMENTATION_SLOT,
  TX_STATUSES,
} from '@darksafe/core';

/**
 * A small in-memory Quai node for the web tests. It serves the real pinned bytecode (from
 * the Hardhat artifacts) and answers the vault and factory views the way the contracts do,
 * so the app's whole verification pipeline runs as it would against a chain.
 */

const ARTIFACTS = path.resolve(__dirname, '../../../packages/contracts/artifacts/contracts/v2');

function runtime(name: string): string {
  const file = path.join(ARTIFACTS, `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${file}: run \`pnpm -F @darksafe/contracts compile\` first.`);
  return JSON.parse(fs.readFileSync(file, 'utf8')).deployedBytecode;
}

export interface FakeTx {
  to: string;
  value: bigint;
  data: string;
  gasLimit: bigint;
  expiration: number;
  executionDelay: number;
  proposer: string;
  proposedAt: number;
  approvedAt: number;
  executed?: boolean;
  failed?: boolean;
  cancelled?: boolean;
  expired?: boolean;
  approvals: string[];
}

export interface FakeVault {
  address: string;
  owners: string[];
  threshold: number;
  minExecutionDelay: number;
  balance: bigint;
  txs: FakeTx[];
  /** Created by the factory (isWallet). */
  registered?: boolean;
}

export interface FakeNodeOptions {
  chainId: number;
  factory: string;
  implementation: string;
  vaults: FakeVault[];
  head?: bigint;
  timestamp?: number;
  /** Extra contract code by address (e.g. an impostor). */
  codes?: Record<string, string>;
  /** Replace a stored transaction's calldata in answers without changing its hash. */
  tamperData?: { vault: string; index: number; data: string };
}

export interface FakeReceipt {
  hash: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

export function fakeQuaiNode(opts: FakeNodeOptions) {
  const head = opts.head ?? 1000n;
  const timestamp = opts.timestamp ?? 1_790_000_000;
  const factoryCode = runtime('DarkSafeVaultFactory');
  const implCode = runtime('DarkSafeVault');
  const receipts = new Map<string, FakeReceipt>();
  const calls: string[] = [];
  const lc = (a: string) => a.toLowerCase();
  const vaultAt = (a: string) => opts.vaults.find((v) => lc(v.address) === lc(a));

  const hashOf = (v: FakeVault, i: number) => {
    const t = v.txs[i]!;
    return computeVaultTxHash({
      vault: v.address,
      chainId: opts.chainId,
      to: t.to,
      value: t.value,
      data: t.data,
      gasLimit: t.gasLimit,
      expiration: t.expiration,
      executionDelay: t.executionDelay,
      nonce: i,
    }).toLowerCase();
  };
  const indexOf = (v: FakeVault, h: string) => v.txs.findIndex((_, i) => hashOf(v, i) === lc(h));
  const statusOf = (v: FakeVault, t: FakeTx) => {
    if (t.executed) return t.failed ? 5 : 4;
    if (t.cancelled) return 6;
    if (t.expired || timestamp > t.expiration) return 7;
    if (t.approvals.length < v.threshold) return 1;
    if (t.approvedAt === 0) return t.executionDelay === 0 ? 3 : 2;
    return timestamp < t.approvedAt + t.executionDelay ? 2 : 3;
  };

  function vaultCall(v: FakeVault, data: string): string {
    const fn = vaultInterface.parseTransaction({ data });
    if (!fn) throw new Error('unknown vault call');
    const enc = (...values: unknown[]) => vaultInterface.encodeFunctionResult(fn.name, values);
    const h = fn.args.length > 0 ? String(fn.args[0]) : '';
    switch (fn.name) {
      case 'getOwners':
        return enc(v.owners);
      case 'getThreshold':
      case 'threshold':
        return enc(v.threshold);
      case 'minExecutionDelay':
        return enc(v.minExecutionDelay);
      case 'txNonce':
      case 'getTransactionCount':
        return enc(v.txs.length);
      case 'getTransactionHashes': {
        const [offset, limit] = [Number(fn.args[0]), Number(fn.args[1])];
        return enc(v.txs.slice(offset, offset + limit).map((_, k) => hashOf(v, offset + k)));
      }
      case 'getTransaction': {
        const i = indexOf(v, h);
        const t = v.txs[i];
        const tamper = opts.tamperData && lc(opts.tamperData.vault) === lc(v.address) && opts.tamperData.index === i;
        return enc(
          t
            ? {
                to: t.to,
                gasLimit: t.gasLimit,
                executionDelay: t.executionDelay,
                value: t.value,
                proposer: t.proposer,
                proposedAt: t.proposedAt,
                expiration: t.expiration,
                approvedAt: t.approvedAt,
                executed: Boolean(t.executed),
                failed: Boolean(t.failed),
                cancelled: Boolean(t.cancelled),
                expired: Boolean(t.expired),
                data: tamper ? opts.tamperData!.data : t.data,
              }
            : { to: getAddress('0x' + '00'.repeat(20)), gasLimit: 0, executionDelay: 0, value: 0, proposer: getAddress('0x' + '00'.repeat(20)), proposedAt: 0, expiration: 0, approvedAt: 0, executed: false, failed: false, cancelled: false, expired: false, data: '0x' }
        );
      }
      case 'status': {
        const t = v.txs[indexOf(v, h)];
        return enc(t ? statusOf(v, t) : 0);
      }
      case 'getApprovals':
        return enc(v.txs[indexOf(v, h)]?.approvals ?? []);
      case 'getApprovalCount':
        return enc(v.txs[indexOf(v, h)]?.approvals.length ?? 0);
      // Simulations of writes (the app simulates before sending): succeed with the ABI's return.
      case 'approveTransaction':
      case 'revokeApproval':
      case 'cancelTransaction':
      case 'expireTransaction':
        return '0x';
      case 'executeTransaction':
        return enc(true);
      case 'proposeTransaction':
        return enc('0x' + '00'.repeat(32));
      default:
        throw new Error(`fake node: vault.${fn.name} not implemented`);
    }
  }

  function factoryCall(data: string): string {
    const fn = factoryInterface.parseTransaction({ data });
    if (!fn) throw new Error('unknown factory call');
    switch (fn.name) {
      case 'implementation':
        return factoryInterface.encodeFunctionResult('implementation', [opts.implementation]);
      case 'proxyCodeHash':
        return factoryInterface.encodeFunctionResult('proxyCodeHash', [PINNED_CONTRACTS.DarkSafeVaultProxyV2.runtimeCodeHash]);
      case 'isWallet':
        return factoryInterface.encodeFunctionResult('isWallet', [Boolean(vaultAt(fn.args[0])?.registered ?? true)]);
      default:
        throw new Error(`fake node: factory.${fn.name} not implemented`);
    }
  }

  function handle(method: string, params: any[]): unknown {
    calls.push(method);
    switch (method) {
      case 'quai_blockNumber':
        return toBeHex(head);
      case 'quai_chainId':
        return toBeHex(opts.chainId);
      case 'quai_getBlockByNumber':
        return { hash: keccak256(toBeHex(head, 32)), woHeader: { number: toBeHex(head), timestamp: toBeHex(timestamp) }, header: { number: [] } };
      case 'quai_getCode': {
        const a = lc(params[0]);
        if (a === lc(opts.factory)) return factoryCode;
        if (a === lc(opts.implementation)) return implCode;
        if (vaultAt(a)) return VAULT_PROXY_RUNTIME_CODE;
        return opts.codes?.[a] ?? opts.codes?.[getAddress(a)] ?? '0x';
      }
      case 'quai_getStorageAt':
        if (vaultAt(params[0]) && lc(params[1]) === ERC1967_IMPLEMENTATION_SLOT) return zeroPadValue(opts.implementation, 32);
        return '0x' + '00'.repeat(32);
      case 'quai_getBalance':
        return toBeHex(vaultAt(params[0])?.balance ?? 0n);
      case 'quai_call': {
        const { to, data } = params[0];
        if (to && lc(to) === lc(opts.factory)) return factoryCall(data);
        const v = to ? vaultAt(to) : undefined;
        if (v && lc(params[0].from ?? '') !== lc(v.address)) return vaultCall(v, data);
        return '0x'; // simulated inner calls from the vault succeed
      }
      case 'quai_estimateGas':
        return '0x186a0';
      case 'quai_createAccessList':
        return { accessList: [] };
      case 'quai_getTransactionReceipt': {
        const r = receipts.get(lc(params[0]));
        return r
          ? { blockHash: keccak256(toBeHex(head, 32)), blockNumber: toBeHex(head), status: '0x1', logs: r.logs, transactionHash: r.hash, contractAddress: null }
          : null;
      }
      default:
        throw Object.assign(new Error(`fake node: ${method} not implemented`), { code: -32601 });
    }
  }

  async function fetchFn(_url: string, init?: RequestInit): Promise<Response> {
    const body = JSON.parse(String(init?.body));
    try {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: handle(body.method, body.params ?? []) }), { status: 200 });
    } catch (err: any) {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: err.code ?? -32000, message: err.message } }), { status: 200 });
    }
  }

  return { fetch: fetchFn, handle, calls, receipts, opts, statusName: (v: FakeVault, i: number) => TX_STATUSES[statusOf(v, v.txs[i]!)], hashOf };
}

/** A Pelagus-like wallet whose own node is `node`, and which applies vault calls it is asked to send. */
export function fakePelagus(account: string, node: ReturnType<typeof fakeQuaiNode>, onSend?: (tx: any) => FakeReceipt) {
  const sent: any[] = [];
  return {
    sent,
    provider: {
      isPelagus: true,
      request: async ({ method, params }: { method: string; params?: any[] }) => {
        if (method === 'quai_requestAccounts' || method === 'quai_accounts') return [account];
        if (method === 'quai_sendTransaction') {
          const tx = params![0];
          sent.push(tx);
          const receipt = onSend?.(tx) ?? { hash: keccak256(toBeHex(sent.length, 32)), logs: [] };
          node.receipts.set(receipt.hash.toLowerCase(), receipt);
          return receipt.hash;
        }
        return node.handle(method, params ?? []);
      },
      on: () => undefined,
      removeListener: () => undefined,
    },
  };
}
