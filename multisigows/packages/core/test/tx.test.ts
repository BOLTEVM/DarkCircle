import { describe, it, expect } from 'vitest';
import { QuaiRpcClient, FetchLike } from '../src/rpc.js';
import {
  prepareQuaiTransaction,
  sendPreparedTransaction,
  waitForConfirmations,
  assertWalletOnChain,
  creationGasLimit,
  callGasLimit,
  SimulationError,
  BroadcastError,
  ChainMismatchError,
  MAX_GAS_LIMIT,
} from '../src/tx.js';

type Handler = (params: any[]) => { result?: unknown; error?: { code: number; message: string; data?: string } };

function fakeNode(handlers: Record<string, Handler>, calls: Array<{ method: string; params: any[] }> = []) {
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    calls.push({ method: body.method, params: body.params });
    const handler = handlers[body.method];
    if (!handler) throw new Error(`unexpected RPC ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, ...handler(body.params) }), { status: 200 });
  };
  return new QuaiRpcClient('https://node.test/cyprus1', { fetchFn, maxRetries: 0 });
}

const FROM = '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170';
const VAULT = '0x0060938367f4F711A467e2f562ECe51A7a7158f0';

describe('prepareQuaiTransaction', () => {
  it('sizes a creation from runtime bytes, ignores the estimate, and sends no access list', async () => {
    const calls: any[] = [];
    const rpc = fakeNode(
      {
        quai_call: () => ({ result: '0x6080' }),
        quai_estimateGas: () => ({ result: '0x451c3a' }),
      },
      calls
    );
    const prepared = await prepareQuaiTransaction(rpc, { from: FROM, data: '0x6080' }, { creationRuntimeBytes: 6422 });
    expect(prepared.gasLimit).toBe(6422n * 1250n);
    expect(prepared.estimatedGas).toBe(0x451c3an);
    expect(prepared.accessList).toBeUndefined();
    expect(calls.map((c) => c.method)).not.toContain('quai_createAccessList');
  });

  it('refuses to send a creation whose simulation reverts', async () => {
    const rpc = fakeNode({
      quai_call: () => ({ error: { code: 3, message: 'execution reverted: Owners required at deployment' } }),
    });
    await expect(
      prepareQuaiTransaction(rpc, { from: FROM, data: '0x6080' }, { creationRuntimeBytes: 6422 })
    ).rejects.toThrow(/Simulation failed, nothing was sent: execution reverted: Owners required/);
  });

  it('attaches the access list and pads the estimate for a contract call', async () => {
    const list = [{ address: VAULT, storageKeys: ['0x' + '00'.repeat(32)] }];
    const rpc = fakeNode({
      quai_call: () => ({ result: '0x' }),
      quai_estimateGas: () => ({ result: '0x186a0' }),
      quai_createAccessList: () => ({ result: { accessList: list, gasUsed: '0x1' } }),
    });
    const prepared = await prepareQuaiTransaction(rpc, { from: FROM, to: VAULT, data: '0x12345678' });
    expect(prepared.accessList).toEqual(list);
    expect(prepared.gasLimit).toBe(130_000n);
    expect(prepared.simulationResult).toBe('0x');
  });

  it('refuses when quai_createAccessList reports a revert inside a successful result', async () => {
    const rpc = fakeNode({
      quai_call: () => ({ result: '0x' }),
      quai_estimateGas: () => ({ result: '0x186a0' }),
      quai_createAccessList: () => ({ result: { accessList: [], error: 'execution reverted', gasUsed: '0x99be0' } }),
    });
    await expect(prepareQuaiTransaction(rpc, { from: FROM, to: VAULT, data: '0x12' })).rejects.toBeInstanceOf(
      SimulationError
    );
  });

  it('rejects non-Cyprus-1 senders and creations without a runtime size', async () => {
    const rpc = fakeNode({});
    await expect(
      prepareQuaiTransaction(rpc, { from: '0x1234567890123456789012345678901234567890', to: VAULT, data: '0x' })
    ).rejects.toThrow(/Sender is not a Cyprus-1 address/);
    await expect(prepareQuaiTransaction(rpc, { from: FROM, data: '0x6080' })).rejects.toThrow(/runtime size/);
  });

  it('caps every gas limit below the block gas limit', () => {
    expect(creationGasLimit(10_000_000)).toBe(MAX_GAS_LIMIT);
    expect(callGasLimit(100_000_000n)).toBe(MAX_GAS_LIMIT);
  });
});

describe('sendPreparedTransaction', () => {
  it('uses the Pelagus field names and omits `to` for a creation', async () => {
    let sent: any;
    const provider = {
      request: async ({ method, params }: any) => {
        sent = { method, params };
        return '0x' + 'ab'.repeat(32);
      },
    };
    await sendPreparedTransaction(provider, {
      from: FROM,
      data: '0x60',
      gasLimit: 8_027_500n,
      estimatedGas: 1n,
      simulationResult: '0x',
    });
    expect(sent.method).toBe('quai_sendTransaction');
    expect(sent.params[0]).toEqual({ from: FROM, data: '0x60', gasLimit: '0x7a7d6c' });
    expect('to' in sent.params[0]).toBe(false);
  });

  it('rejects a malformed hash from the wallet', async () => {
    const provider = { request: async () => 'not-a-hash' };
    await expect(
      sendPreparedTransaction(provider, {
        from: FROM,
        to: VAULT,
        data: '0x',
        gasLimit: 1n,
        estimatedGas: 1n,
        simulationResult: '0x',
      })
    ).rejects.toThrow(/unexpected transaction hash/);
  });
});

describe('assertWalletOnChain', () => {
  it('passes on the expected chain and fails closed otherwise', async () => {
    await expect(assertWalletOnChain({ request: async () => '0x9' }, 9)).resolves.toBeUndefined();
    await expect(assertWalletOnChain({ request: async () => '0x3a98' }, 9)).rejects.toBeInstanceOf(ChainMismatchError);
    await expect(
      assertWalletOnChain(
        {
          request: async () => {
            throw new Error('unsupported');
          },
        },
        9
      )
    ).rejects.toThrow(/Could not read the wallet's network/);
  });
});

describe('waitForConfirmations', () => {
  const HASH = '0x' + 'cd'.repeat(32);
  const receipt = (blockHash: string, blockNumber = '0x64') => ({
    blockHash,
    blockNumber,
    status: '0x1',
    contractAddress: VAULT,
    transactionHash: HASH,
    logs: [],
  });

  it('waits until the receipt is N blocks deep', async () => {
    let head = 0x64;
    const rpc = fakeNode({
      quai_getTransactionReceipt: () => ({ result: receipt('0xaa') }),
      quai_blockNumber: () => ({ result: '0x' + (head++).toString(16) }),
    });
    const seen: number[] = [];
    const final = await waitForConfirmations(rpc, HASH, {
      confirmations: 3,
      timeoutMs: 5_000,
      pollMs: 1,
      onProgress: (p) => seen.push(p.confirmations),
    });
    expect(final.blockHash).toBe('0xaa');
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(3);
  });

  it('never returns a receipt whose block was reorged out between the depth check and the final re-read', async () => {
    // poll 1: mined in 0xaa at depth 2, but the final re-read already sees 0xbb
    const hashes = ['0xaa', '0xbb', '0xbb', '0xbb'];
    let i = 0;
    let head = 0x65;
    const rpc = fakeNode({
      quai_getTransactionReceipt: () => ({ result: receipt(hashes[Math.min(i++, hashes.length - 1)]!) }),
      quai_blockNumber: () => ({ result: '0x' + (head++).toString(16) }),
    });
    const final = await waitForConfirmations(rpc, HASH, { confirmations: 2, timeoutMs: 5_000, pollMs: 1 });
    expect(final.blockHash).toBe('0xbb');
  });

  it('keeps the tx hash when it times out', async () => {
    const rpc = fakeNode({ quai_getTransactionReceipt: () => ({ result: null }) });
    const err = await waitForConfirmations(rpc, HASH, { confirmations: 1, timeoutMs: 20, pollMs: 5 }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(BroadcastError);
    expect(err.txHash).toBe(HASH);
  });
});
