import type { InjectedWallet } from './injectedWallet.js';

/**
 * DEV ONLY. A stand-in wallet for the local Hardhat chain: it forwards requests to the node,
 * whose well-known dev accounts are unlocked, and answers account requests with whichever
 * account the developer picked. It is loaded only by a dev server started with
 * VITE_DARKORDER_LOCAL=1; production builds never include it.
 */
export function createDevWallet(rpcUrl: string, getAccount: () => string | null): InjectedWallet {
  let id = 1;
  const node = async (method: string, params: unknown[] = []) => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: id++, method, params }),
    });
    const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (json.error) throw new Error(json.error.message ?? `${method} failed`);
    return json.result;
  };
  return {
    name: 'Dev wallet (local Hardhat)',
    namespace: 'eth',
    provider: {
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
          const a = getAccount();
          return a ? [a] : [];
        }
        if (method === 'eth_sendTransaction') {
          const tx = (params?.[0] ?? {}) as { from?: string };
          if (!tx.from || tx.from.toLowerCase() !== getAccount()?.toLowerCase()) throw new Error('Dev wallet: sender is not the selected account.');
        }
        return node(method, params ?? []);
      },
    },
  };
}

export async function listDevAccounts(rpcUrl: string): Promise<string[]> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_accounts', params: [] }),
  });
  const json = (await res.json()) as { result?: string[] };
  return json.result ?? [];
}
