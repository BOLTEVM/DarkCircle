import type { InjectedProviderLike } from '@darkquestate/core';

/**
 * Finding the injected Quai wallet, written for the wallets that exist in the wild (ported from
 * DarkSafe). Extensions inject getters, proxies and half-implemented providers; every read and
 * subscription here is guarded, so the worst a misbehaving wallet can do is look absent.
 */

export interface InjectedWallet {
  provider: InjectedProviderLike & {
    on?: (event: string, handler: (...args: any[]) => void) => void;
    removeListener?: (event: string, handler: (...args: any[]) => void) => void;
  };
  name: string;
  /** JSON-RPC namespace the wallet speaks for accounts and sending. */
  namespace: 'quai' | 'eth';
}

export function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function speaksEip1193(candidate: unknown): boolean {
  return safeRead(() => typeof (candidate as { request?: unknown })?.request === 'function') === true;
}

/**
 * Only wallets that can sign Quai transactions are accepted. Pelagus and Blip inject
 * window.pelagus / window.blip / window.quai and speak quai_*; they do not implement EIP-6963.
 * window.ethereum is used only when it identifies itself as one of them: a generic Ethereum
 * wallet cannot build a Quai transaction.
 */
export function detectInjectedWallet(target: unknown = typeof window === 'undefined' ? undefined : window): InjectedWallet | null {
  if (!target) return null;
  const get = (key: string): any => safeRead(() => (target as Record<string, unknown>)[key]);
  const flag = (obj: any, key: string): boolean => safeRead(() => Boolean(obj?.[key])) === true;

  const pelagus = get('pelagus');
  if (speaksEip1193(pelagus)) return { provider: pelagus, name: 'Pelagus', namespace: 'quai' };
  const blip = get('blip');
  if (speaksEip1193(blip)) return { provider: blip, name: 'Blip', namespace: 'quai' };
  const quai = get('quai');
  if (speaksEip1193(quai)) {
    return { provider: quai, name: flag(quai, 'isPelagus') ? 'Pelagus' : flag(quai, 'isBlip') ? 'Blip' : 'Quai wallet', namespace: 'quai' };
  }
  const eth = get('ethereum');
  if (speaksEip1193(eth) && (flag(eth, 'isPelagus') || flag(eth, 'isBlip'))) {
    return { provider: eth, name: flag(eth, 'isBlip') ? 'Blip' : 'Pelagus', namespace: 'quai' };
  }
  return null;
}

/** Subscribes to wallet events; never throws. Returns the unsubscribe function. */
export function subscribeProvider(provider: InjectedWallet['provider'], handlers: Record<string, (...args: any[]) => void>): () => void {
  const attached: [string, (...args: any[]) => void][] = [];
  for (const [event, handler] of Object.entries(handlers)) {
    try {
      if (typeof provider.on !== 'function') break;
      provider.on(event, handler);
      attached.push([event, handler]);
    } catch {
      /* this provider does not support this event */
    }
  }
  return () => {
    for (const [event, handler] of attached) {
      try {
        provider.removeListener?.(event, handler);
      } catch {
        /* nothing to detach */
      }
    }
  };
}

/** First account from a request result, or null. */
export function firstAccount(result: unknown): string | null {
  return Array.isArray(result) && typeof result[0] === 'string' ? result[0] : null;
}
