import type { InjectedProviderLike } from '@darksafe/core';

/**
 * Detecting and subscribing to the injected Quai wallet, written for the wallets that actually exist in the wild.
 *
 * Extensions and in-app browsers inject getters, proxies and half-implemented providers (an `on` that throws for an
 * event it does not know, a property that is a getter denying access, `null` entries in a providers list). Code that
 * trusts them throws inside an effect, and a React tree with an uncaught effect error is removed entirely. Every read
 * and every subscription here is therefore guarded: the worst a misbehaving wallet can do is be reported as absent or
 * give no live updates.
 */

export interface InjectedWallet {
  provider: InjectedProviderLike & {
    on?: (event: string, handler: (...args: any[]) => void) => void;
    removeListener?: (event: string, handler: (...args: any[]) => void) => void;
  };
  providerName: string;
  /** Speaks quai_* (Pelagus, Blip) rather than eth_*. */
  isQuaiNative: boolean;
}

/** Runs a read that may throw (a getter, a proxy) and returns undefined instead. */
export function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** True for an object whose `request` is a function. Reading it must not be able to throw. */
function speaksEip1193(candidate: unknown): boolean {
  return safeRead(() => typeof (candidate as any)?.request === 'function') === true;
}

/**
 * Only wallets that can actually sign Quai transactions are accepted. Pelagus and Blip inject window.pelagus /
 * window.blip / window.quai and speak quai_*; they do not use EIP-6963. window.ethereum is trusted only when it
 * identifies itself as one of them, so a generic Ethereum wallet (which cannot build Quai transactions) is never used.
 */
export function detectInjectedWallet(target: unknown = typeof window === 'undefined' ? undefined : window): InjectedWallet | null {
  if (!target) return null;
  const get = (key: string): any => safeRead(() => (target as any)[key]);
  const flag = (obj: any, key: string): boolean => safeRead(() => Boolean(obj?.[key])) === true;

  const pelagus = get('pelagus');
  if (speaksEip1193(pelagus)) return { provider: pelagus, providerName: 'Pelagus', isQuaiNative: true };

  const blip = get('blip');
  if (speaksEip1193(blip)) return { provider: blip, providerName: 'Blip', isQuaiNative: true };

  const quai = get('quai');
  if (speaksEip1193(quai)) {
    const name = flag(quai, 'isPelagus') ? 'Pelagus' : flag(quai, 'isBlip') ? 'Blip' : 'Quai Wallet';
    return { provider: quai, providerName: name, isQuaiNative: true };
  }

  const bolt = get('boltWallet');
  if (speaksEip1193(bolt)) return { provider: bolt, providerName: 'BoltWallet', isQuaiNative: false };

  const eth = get('ethereum');
  if (speaksEip1193(eth) && (flag(eth, 'isPelagus') || flag(eth, 'isBlip'))) {
    return { provider: eth, providerName: flag(eth, 'isBlip') ? 'Blip' : 'Pelagus', isQuaiNative: true };
  }
  return null;
}

/**
 * Subscribe to wallet events. Returns the unsubscribe function and never throws: a provider that has no `on`, throws on an
 * event it does not know, or is gone by cleanup time just gives no live updates for that event.
 */
export function subscribeProvider(provider: InjectedWallet['provider'], handlers: Record<string, (...args: any[]) => void>): () => void {
  const attached: [string, (...args: any[]) => void][] = [];
  for (const [event, handler] of Object.entries(handlers)) {
    try {
      if (typeof provider.on !== 'function') break;
      provider.on(event, handler);
      attached.push([event, handler]);
    } catch {
      /* this provider does not support this event; the others may still work */
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
