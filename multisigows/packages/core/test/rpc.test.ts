import { describe, it, expect } from 'vitest';
import {
  QuaiRpcClient,
  QuaiRpcError,
  resolveCyprus1Endpoint
} from '../src/rpc.js';

describe('@safebuddy/core: rpc module', () => {
  const validCyprus1Addr = '0x00eDf2d16AfbC028FB1e879559b07997Af79539f';
  const invalidAddr = '0x1234567890123456789012345678901234567890';

  it('resolves Cyprus-1 zone endpoint correctly', () => {
    expect(resolveCyprus1Endpoint('testnet')).toBe('https://orchard.rpc.quai.network/cyprus1');
    expect(resolveCyprus1Endpoint('mainnet')).toBe('https://rpc.quai.network/cyprus1');
    expect(resolveCyprus1Endpoint('https://my-node.quai.network/cyprus1')).toBe(
      'https://my-node.quai.network/cyprus1'
    );
  });

  it('pre-validates and rejects non-0x00 address before network transmission', async () => {
    const client = new QuaiRpcClient('testnet');

    await expect(client.quai_getBalance(invalidAddr)).rejects.toThrow(
      'Quai RPC pre-validation failed for getBalance'
    );

    await expect(client.quai_call(invalidAddr, '0x')).rejects.toThrow(
      'Quai RPC pre-validation failed for call destination'
    );

    await expect(client.quai_getTransactionCount(invalidAddr)).rejects.toThrow(
      'Quai RPC pre-validation failed for getTransactionCount'
    );
  });

  it('queries native balance (quai_getBalance) with mocked fetch', async () => {
    let requestedMethod = '';
    let requestedParams: any[] = [];

    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      requestedMethod = body.method;
      requestedParams = body.params;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x1bc16d674ec80000' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const client = new QuaiRpcClient('testnet', { fetchFn: mockFetch });
    const balance = await client.quai_getBalance(validCyprus1Addr);

    expect(requestedMethod).toBe('quai_getBalance');
    expect(requestedParams[0]).toBe(validCyprus1Addr);
    expect(balance).toBe(2000000000000000000n); // 2.0 QUAI
  });

  it('executes read-only call (quai_call)', async () => {
    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x0000000000000000000000000000000000000000000000000000000000000002' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const client = new QuaiRpcClient('testnet', { fetchFn: mockFetch });
    const result = await client.quai_call(validCyprus1Addr, '0xe75235b8'); // getThreshold()

    expect(result).toBe('0x0000000000000000000000000000000000000000000000000000000000000002');
  });

  it('submits raw transaction and retrieves receipt', async () => {
    const mockTxHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      if (body.method === 'quai_sendRawTransaction') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: mockTxHash }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      if (body.method === 'quai_getTransactionReceipt') {
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              status: '0x1',
              transactionHash: mockTxHash,
              blockNumber: '0x10',
              gasUsed: '0x5208'
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: null }));
    };

    const client = new QuaiRpcClient('testnet', { fetchFn: mockFetch });
    const txHash = await client.quai_sendRawTransaction('0x02f870...');
    expect(txHash).toBe(mockTxHash);

    const receipt = await client.quai_getTransactionReceipt(mockTxHash);
    expect(receipt).not.toBeNull();
    expect(receipt?.status).toBe('0x1');
    expect(receipt?.transactionHash).toBe(mockTxHash);
  });

  it('queries transaction count, gas estimate, and gas price', async () => {
    const mockFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(init?.body as string);
      if (body.method === 'quai_getTransactionCount') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x5' }));
      }
      if (body.method === 'quai_estimateGas') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0xa410' }));
      }
      if (body.method === 'quai_gasPrice') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x3b9aca00' }));
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x0' }));
    };

    const client = new QuaiRpcClient('testnet', { fetchFn: mockFetch });

    const nonce = await client.quai_getTransactionCount(validCyprus1Addr);
    expect(nonce).toBe(5n);

    const gasEst = await client.quai_estimateGas({ to: validCyprus1Addr });
    expect(gasEst).toBe(42000n);

    const gasPrice = await client.quai_gasPrice();
    expect(gasPrice).toBe(1000000000n);
  });

  it('retries on rate limit (HTTP 429) with backoff before succeeding', async () => {
    let callCount = 0;

    const mockFetch: typeof fetch = async (_url, init) => {
      callCount++;
      const body = JSON.parse(init?.body as string);
      if (callCount === 1) {
        return new Response('Rate limited', { status: 429, statusText: 'Too Many Requests' });
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x10' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const client = new QuaiRpcClient('testnet', {
      fetchFn: mockFetch,
      initialDelayMs: 10,
      maxRetries: 2
    });

    const blockNum = await client.getBlockNumber();
    expect(callCount).toBe(2);
    expect(blockNum).toBe(16n);
  });
});
