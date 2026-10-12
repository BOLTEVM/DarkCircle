import { describe, it, expect, vi } from 'vitest';
import { detectInjectedWallet, subscribeProvider, safeRead } from '../src/lib/injectedWallet.js';

// Wallet extensions and in-app browsers inject all sorts of objects. A page that trusts them throws inside an
// effect and, with React, loses the whole tree. These tests pin the contract: detection and subscription never throw.

const okProvider = (extra: Record<string, unknown> = {}) => ({ request: async () => [], ...extra });

describe('detectInjectedWallet', () => {
  it('finds Pelagus, Blip and a generic Quai provider, in that order', () => {
    expect(detectInjectedWallet({ pelagus: okProvider(), blip: okProvider() })?.providerName).toBe('Pelagus');
    expect(detectInjectedWallet({ blip: okProvider() })?.providerName).toBe('Blip');
    const quai = detectInjectedWallet({ quai: okProvider({ isPelagus: true }) });
    expect(quai?.providerName).toBe('Pelagus');
    expect(quai?.isQuaiNative).toBe(true);
    expect(detectInjectedWallet({ quai: okProvider() })?.providerName).toBe('Quai Wallet');
  });

  it('uses window.ethereum only when it identifies itself as a Quai wallet', () => {
    expect(detectInjectedWallet({ ethereum: okProvider({ isMetaMask: true }) })).toBeNull();
    expect(detectInjectedWallet({ ethereum: okProvider({ isBraveWallet: true }) })).toBeNull();
    expect(detectInjectedWallet({ ethereum: okProvider({ isBlip: true }) })?.providerName).toBe('Blip');
    expect(detectInjectedWallet({ ethereum: okProvider({ isPelagus: true }) })?.providerName).toBe('Pelagus');
  });

  it('treats a generic eth_* wallet as unusable rather than guessing', () => {
    expect(detectInjectedWallet({ boltWallet: okProvider() })?.isQuaiNative).toBe(false);
    expect(detectInjectedWallet({})).toBeNull();
    expect(detectInjectedWallet(undefined)).toBeNull();
  });

  it('survives a getter that throws, on every injection point', () => {
    const hostile = {};
    for (const key of ['pelagus', 'blip', 'quai', 'boltWallet', 'ethereum']) {
      Object.defineProperty(hostile, key, {
        get() {
          throw new Error(`${key} getter denied`);
        },
        enumerable: true
      });
    }
    expect(() => detectInjectedWallet(hostile)).not.toThrow();
    expect(detectInjectedWallet(hostile)).toBeNull();
  });

  it('survives a proxy that throws on any property read', () => {
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('provider getter denied');
        }
      }
    );
    expect(detectInjectedWallet({ pelagus: proxy })).toBeNull();
    // a later, healthy provider is still found
    expect(detectInjectedWallet({ pelagus: proxy, quai: okProvider() })?.providerName).toBe('Quai Wallet');
  });

  it('ignores a provider whose request is not a function', () => {
    expect(detectInjectedWallet({ pelagus: { request: 'nope' } })).toBeNull();
    expect(detectInjectedWallet({ pelagus: null, quai: undefined })).toBeNull();
  });

  it('reads an isPelagus flag that throws as false instead of failing', () => {
    const quai = okProvider();
    Object.defineProperty(quai, 'isPelagus', {
      get() {
        throw new Error('flag denied');
      }
    });
    expect(detectInjectedWallet({ quai })?.providerName).toBe('Quai Wallet');
  });
});

describe('subscribeProvider', () => {
  it('attaches every handler and detaches them all', () => {
    const on = vi.fn();
    const removeListener = vi.fn();
    const handlers = { accountsChanged: vi.fn(), chainChanged: vi.fn(), disconnect: vi.fn() };
    const off = subscribeProvider({ request: async () => null, on, removeListener }, handlers);
    expect(on).toHaveBeenCalledTimes(3);
    off();
    expect(removeListener).toHaveBeenCalledTimes(3);
    expect(removeListener).toHaveBeenCalledWith('chainChanged', handlers.chainChanged);
  });

  it('does not throw when the provider has no on()', () => {
    const off = subscribeProvider({ request: async () => null }, { accountsChanged: () => {} });
    expect(() => off()).not.toThrow();
  });

  it('keeps going when one event is unsupported and only detaches what was attached', () => {
    const attached: string[] = [];
    const removed: string[] = [];
    const provider = {
      request: async () => null,
      on(event: string) {
        if (event === 'disconnect') throw new Error('Unsupported event');
        attached.push(event);
      },
      removeListener(event: string) {
        removed.push(event);
      }
    };
    const off = subscribeProvider(provider, { accountsChanged: () => {}, disconnect: () => {}, chainChanged: () => {} });
    expect(attached).toEqual(['accountsChanged', 'chainChanged']);
    off();
    expect(removed).toEqual(['accountsChanged', 'chainChanged']);
  });

  it('does not throw if removeListener throws during cleanup', () => {
    const provider = {
      request: async () => null,
      on() {},
      removeListener() {
        throw new Error('already gone');
      }
    };
    const off = subscribeProvider(provider, { accountsChanged: () => {}, chainChanged: () => {} });
    expect(() => off()).not.toThrow();
  });
});

describe('safeRead', () => {
  it('returns the value, or undefined when the read throws', () => {
    expect(safeRead(() => 7)).toBe(7);
    expect(
      safeRead(() => {
        throw new Error('x');
      })
    ).toBeUndefined();
  });
});
