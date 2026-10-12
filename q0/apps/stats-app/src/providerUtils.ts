/**
 * Quai Network & Pelagus Provider Resolution and Transaction Helpers
 */

/**
 * Resolves the active Quai Network provider, prioritizing Pelagus and filtering multi-provider collisions.
 */
export function getQuaiProvider(): any | null {
  if (typeof window === 'undefined') return null;
  // `?nowallet=1` (the crash screen's "Open without wallet detection") skips every injected provider.
  if (read(() => new URLSearchParams(window.location.search).has('nowallet')) === true) return null;

  // 1. Dedicated Pelagus injected provider
  const pelagus = read(() => window.pelagus);
  if (pelagus) return pelagus;

  // 2. Dedicated Quai injected provider
  const quai = read(() => window.quai);
  if (quai) return quai;

  // 3. Multi-wallet provider arrays (e.g. EIP-6963 or window.ethereum.providers)
  const eth = read(() => window.ethereum as any);
  if (!eth) return null;
  const list = read(() => eth.providers);
  if (Array.isArray(list)) {
    const hit = list.find(p => read(() => Boolean(p && (p.isPelagus || p.isQuai))) === true);
    if (hit) return hit;
  }

  // 4./5. Window.ethereum itself (Pelagus/Quai, or whatever else the browser injects, such as Brave Wallet)
  return eth;
}

/**
 * Read a property of an injected object without letting it throw. Wallet extensions and in-app browsers inject
 * getters, proxies and half-implemented providers; a page that trusts them blank-screens when one misbehaves.
 */
function read<T>(get: () => T): T | undefined {
  try {
    return get();
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to a provider event. Returns the unsubscribe function, and never throws: a provider whose `on` is missing,
 * throws, or does not know the event simply gives no live updates.
 */
export function subscribeProvider(provider: any, event: string, handler: (...args: any[]) => void): () => void {
  try {
    if (!provider || typeof provider.on !== 'function') return () => {};
    provider.on(event, handler);
  } catch {
    return () => {};
  }
  return () => {
    try {
      if (typeof provider.removeListener === 'function') provider.removeListener(event, handler);
      else if (typeof provider.off === 'function') provider.off(event, handler);
    } catch {
      /* the provider is gone or never supported it */
    }
  };
}

/**
 * Filters an accounts array to find a Cyprus-1 shard address (prefixed with 0x00).
 * Quai Network assigns shard addresses deterministically based on byte prefixes.
 */
export function getCyprus1Address(accounts: string[]): string | null {
  if (!accounts || accounts.length === 0) return null;
  const cyprus1 = accounts.find(addr => addr && addr.toLowerCase().startsWith('0x00'));
  return cyprus1 || accounts[0];
}

/**
 * Requests accounts from the provider, trying the native Quai RPC method first.
 */
export async function requestWalletAccounts(provider: any): Promise<string[]> {
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('No compatible Quai / Pelagus provider available.');
  }

  try {
    return await provider.request({ method: 'quai_requestAccounts' });
  } catch (quaiErr: any) {
    // If user explicitly rejected the request, don't fall back
    if (quaiErr?.code === 4001 || quaiErr?.message?.includes('User rejected')) {
      throw quaiErr;
    }
    // Fallback to standard EVM method
    return await provider.request({ method: 'eth_requestAccounts' });
  }
}

/**
 * Silently reads already-authorized accounts from the provider without prompting the user.
 */
export async function getAuthorizedAccounts(provider: any): Promise<string[]> {
  if (!provider || typeof provider.request !== 'function') return [];

  try {
    return await provider.request({ method: 'quai_accounts' });
  } catch {
    try {
      return await provider.request({ method: 'eth_accounts' });
    } catch {
      return [];
    }
  }
}

/**
 * Submits a transaction to Quai Network, attempting quai_sendTransaction first before eth_sendTransaction.
 */
export async function sendWalletTransaction(provider: any, txParams: any): Promise<string> {
  if (!provider || typeof provider.request !== 'function') {
    throw new Error('Provider does not support RPC requests.');
  }

  try {
    return await provider.request({
      method: 'quai_sendTransaction',
      params: [txParams]
    });
  } catch (err: any) {
    // Check if error indicates quai_sendTransaction is not supported
    const isMethodNotFound =
      err?.code === -32601 ||
      err?.message?.includes('Method not found') ||
      err?.message?.includes('does not exist');

    if (isMethodNotFound) {
      return await provider.request({
        method: 'eth_sendTransaction',
        params: [txParams]
      });
    }
    throw err;
  }
}
