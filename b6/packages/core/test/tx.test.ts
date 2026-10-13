import { describe, expect, it } from 'vitest';
import { brokerageInterface } from '../src/abi.js';
import { MAINNET, LOCAL } from '../src/config.js';
import { RpcClient } from '../src/rpc.js';
import {
  ChainMismatchError,
  SimulationError,
  assertWalletOnChain,
  callGasLimit,
  prepareTransaction,
  sendPrepared,
  waitForConfirmations,
} from '../src/tx.js';

const FROM = '0x001598Ce5966385c9290B1b87079f1bE620CF2A2';
const DESK = '0x0000000000000000000000000000000000005d0e';

type Handler = (method: string, params: unknown[]) => unknown;

/** A JSON-RPC endpoint in a function: records every method called. */
function fakeNode(handler: Handler) {
  const seen: string[] = [];
  const fetchFn = async (_url: string, init?: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init!.body));
    seen.push(method);
    try {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: handler(method, params) }));
    } catch (e) {
      const err = e as { message: string; data?: string };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: err.message, data: err.data } }));
    }
  };
  return { seen, fetchFn };
}

const ok: Handler = (method) => {
  if (method === 'quai_call') return '0x';
  if (method === 'quai_estimateGas') return '0x186a0'; // 100,000
  if (method === 'quai_createAccessList') return { accessList: [{ address: DESK, storageKeys: [] }], gasUsed: '0x1' };
  throw new Error(`unexpected ${method}`);
};

describe('prepareTransaction', () => {
  it('simulates, estimates, attaches the access list and pads gas 30%', async () => {
    const node = fakeNode(ok);
    const rpc = new RpcClient(MAINNET, { fetchFn: node.fetchFn });
    const prepared = await prepareTransaction(rpc, MAINNET, { from: FROM.toLowerCase(), to: DESK, data: '0x1234', value: 5n });
    expect(node.seen).toEqual(['quai_call', 'quai_estimateGas', 'quai_createAccessList']);
    expect(prepared.from).toBe(FROM);
    expect(prepared.gasLimit).toBe(130_000n);
    expect(prepared.accessList).toEqual([{ address: DESK, storageKeys: [] }]);
  });

  it('sends nothing when the simulation reverts, and says why in words', async () => {
    const data = brokerageInterface.encodeErrorResult('ListingNotActive', [7]);
    const node = fakeNode((m) => {
      if (m === 'quai_call') throw Object.assign(new Error('execution reverted'), { data });
      return ok(m, []);
    });
    const rpc = new RpcClient(MAINNET, { fetchFn: node.fetchFn });
    const p = prepareTransaction(rpc, MAINNET, { from: FROM, to: DESK, data: '0x' }).then(
      () => null,
      (e) => e
    );
    const err = await p;
    expect(err).toBeInstanceOf(SimulationError);
    expect(err.message).toMatch(/no longer active/);
    expect(node.seen).toEqual(['quai_call']);
  });

  it('refuses when the access-list simulation reports a VM error inside a successful result', async () => {
    const node = fakeNode((m, p) => (m === 'quai_createAccessList' ? { accessList: [], error: 'execution reverted' } : ok(m, p)));
    const rpc = new RpcClient(MAINNET, { fetchFn: node.fetchFn });
    const err = await prepareTransaction(rpc, MAINNET, { from: FROM, to: DESK, data: '0x' }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(SimulationError);
    expect(err.message).toMatch(/whole gas limit/);
  });

  it('refuses addresses outside Cyprus-1 before touching the network', async () => {
    const node = fakeNode(ok);
    const rpc = new RpcClient(MAINNET, { fetchFn: node.fetchFn });
    await expect(prepareTransaction(rpc, MAINNET, { from: '0x1234567890123456789012345678901234567890', to: DESK, data: '0x' })).rejects.toThrow(
      /another Quai zone/
    );
    expect(node.seen).toEqual([]);
  });

  it('talks eth_* to the local dev chain and skips the Quai-only access list', async () => {
    const node = fakeNode((m) => (m === 'eth_call' ? '0x' : m === 'eth_estimateGas' ? '0x5208' : null));
    const rpc = new RpcClient(LOCAL, { fetchFn: node.fetchFn });
    const prepared = await prepareTransaction(rpc, LOCAL, { from: '0x1234567890123456789012345678901234567890', to: DESK, data: '0x' });
    expect(node.seen).toEqual(['eth_call', 'eth_estimateGas']);
    expect(prepared.accessList).toEqual([]);
  });

  it('caps the gas limit', () => {
    expect(callGasLimit(100n)).toBe(130n);
    expect(callGasLimit(10n ** 12n)).toBe(45_000_000n);
  });
});

describe('wallet hand-off', () => {
  it('uses Pelagus field names (gasLimit, accessList) and checks the returned hash', async () => {
    const calls: { method: string; params?: unknown[] }[] = [];
    const wallet = {
      request: async (a: { method: string; params?: unknown[] }) => {
        calls.push(a);
        return '0x' + 'ab'.repeat(32);
      },
    };
    const hash = await sendPrepared(
      wallet,
      { from: FROM, to: DESK, data: '0x12', value: 10n, gasLimit: 130_000n, estimatedGas: 100_000n, accessList: [{ address: DESK, storageKeys: [] }] },
      'quai'
    );
    expect(hash).toMatch(/^0x(ab){32}$/);
    expect(calls[0]!.method).toBe('quai_sendTransaction');
    expect(calls[0]!.params![0]).toEqual({ from: FROM, to: DESK, data: '0x12', gasLimit: '0x1fbd0', value: '0xa', accessList: [{ address: DESK, storageKeys: [] }] });

    const bad = { request: async () => 'not-a-hash' };
    await expect(sendPrepared(bad, { from: FROM, to: DESK, data: '0x', gasLimit: 1n, estimatedGas: 1n, accessList: [] }, 'quai')).rejects.toThrow(
      /not a transaction hash/
    );
  });

  it('refuses to send when the wallet is on another chain', async () => {
    const orchardWallet = { request: async ({ method }: { method: string }) => (method === 'quai_chainId' ? '0x3a98' : null) };
    await expect(assertWalletOnChain(orchardWallet, 9)).rejects.toBeInstanceOf(ChainMismatchError);
    await expect(assertWalletOnChain(orchardWallet, 15000)).resolves.toBeUndefined();
  });
});

describe('waitForConfirmations', () => {
  it('waits for depth and restarts the count when the receipt moves (reorg)', async () => {
    let head = 100;
    let polls = 0;
    const node = fakeNode((m) => {
      if (m === 'quai_getTransactionReceipt') {
        polls++;
        // first sighting in block A, then reorged into block B
        const blockHash = polls <= 1 ? '0xaaa' : '0xbbb';
        return { blockHash, blockNumber: polls <= 1 ? '0x64' : '0x65', status: '0x1', logs: [], transactionHash: '0x' + '1'.repeat(64) };
      }
      if (m === 'quai_blockNumber') return '0x' + (head++).toString(16);
      return null;
    });
    const rpc = new RpcClient(MAINNET, { fetchFn: node.fetchFn });
    const progress: number[] = [];
    const receipt = await waitForConfirmations(rpc, '0x' + '1'.repeat(64), {
      confirmations: 3,
      timeoutMs: 5_000,
      pollMs: 1,
      onProgress: (p) => progress.push(p.confirmations),
    });
    expect(receipt.blockHash).toBe('0xbbb');
    expect(progress).toContain(0); // the reorg reset
  });
});
