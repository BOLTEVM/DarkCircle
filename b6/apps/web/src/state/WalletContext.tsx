import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { checkAddress, readWalletChainId } from '@darkquestate/core';
import { detectInjectedWallet, firstAccount, subscribeProvider, type InjectedWallet } from '../lib/injectedWallet.js';
import { LOCAL_ENABLED, readStored, writeStored } from '../lib/env.js';
import { useNetwork } from './NetworkContext.js';

interface WalletState {
  wallet: InjectedWallet | null;
  address: string | null;
  /** Why the connected address cannot be used here (another zone, a Qi address), if it cannot. */
  addressProblem: string | null;
  chainId: number | null;
  onExpectedChain: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshChain: () => Promise<void>;
  /** Local dev chain only: pick which unlocked account acts. */
  dev: { accounts: string[]; select: (a: string) => void } | null;
}

const Ctx = createContext<WalletState | null>(null);
const CONNECTED_KEY = 'darkquestate.wallet.connected';
const CHAIN_POLL_MS = 3_000;

export const WalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { network } = useNetwork();
  const isLocal = LOCAL_ENABLED && network.name === 'local';
  const [injected, setInjected] = useState<InjectedWallet | null>(() => detectInjectedWallet());
  const [devWallet, setDevWallet] = useState<InjectedWallet | null>(null);
  const [devAccounts, setDevAccounts] = useState<string[]>([]);
  const devAccountRef = useRef<string | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wallet = isLocal ? devWallet : injected;

  // Extensions can inject after the page loads: look again a few times and on focus.
  useEffect(() => {
    if (injected) return;
    const retry = () => setInjected((cur) => cur ?? detectInjectedWallet());
    const timers = [400, 1500, 4000].map((ms) => setTimeout(retry, ms));
    window.addEventListener('focus', retry);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('focus', retry);
    };
  }, [injected]);

  // The dev wallet is imported lazily so production bundles never contain it.
  useEffect(() => {
    if (!isLocal) return;
    let alive = true;
    import('../lib/devWallet.js').then(async ({ createDevWallet, listDevAccounts }) => {
      const accounts = await listDevAccounts(network.rpcUrl).catch(() => []);
      if (!alive) return;
      setDevAccounts(accounts);
      devAccountRef.current = devAccountRef.current ?? accounts[0] ?? null;
      setDevWallet(createDevWallet(network.rpcUrl, () => devAccountRef.current));
    });
    return () => {
      alive = false;
    };
  }, [isLocal, network.rpcUrl]);

  const refreshChain = useCallback(async () => {
    if (!wallet) return setChainId(null);
    setChainId(await readWalletChainId(wallet.provider));
  }, [wallet]);

  const accountsMethod = (w: InjectedWallet, prompt: boolean) => `${w.namespace}_${prompt ? 'requestAccounts' : 'accounts'}`;

  const connect = useCallback(async () => {
    if (!wallet) {
      setError('No Quai wallet found. Install Pelagus (or open this page in Blip), then reload.');
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const account = firstAccount(await wallet.provider.request({ method: accountsMethod(wallet, true) }));
      if (!account) throw new Error('The wallet returned no account.');
      setAddress(account);
      writeStored(CONNECTED_KEY, '1');
      await refreshChain();
    } catch (e) {
      setError((e as Error)?.message ?? 'The wallet refused the connection.');
    } finally {
      setConnecting(false);
    }
  }, [wallet, refreshChain]);

  const disconnect = useCallback(() => {
    writeStored(CONNECTED_KEY, '0');
    setAddress(null);
    setChainId(null);
  }, []);

  // Quiet reconnect (no prompt) when this browser connected before; switching networks swaps wallets.
  useEffect(() => {
    setAddress(null);
    setChainId(null);
    if (!wallet || (!isLocal && readStored(CONNECTED_KEY) !== '1')) return;
    let alive = true;
    wallet.provider
      .request({ method: accountsMethod(wallet, false) })
      .then((r) => {
        const a = firstAccount(r);
        if (alive && a) {
          setAddress(a);
          refreshChain();
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [wallet, isLocal, refreshChain]);

  // Live updates: events when the wallet sends them, polling because some never do (a wallet
  // switched to another network after connecting must not keep showing the old chain).
  useEffect(() => {
    if (!wallet || !address) return;
    const off = subscribeProvider(wallet.provider, {
      accountsChanged: (accounts: unknown) => setAddress(firstAccount(accounts)),
      chainChanged: () => {
        refreshChain();
      },
    });
    const timer = setInterval(refreshChain, CHAIN_POLL_MS);
    const onVisible = () => document.visibilityState === 'visible' && refreshChain();
    window.addEventListener('focus', refreshChain);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      off();
      clearInterval(timer);
      window.removeEventListener('focus', refreshChain);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [wallet, address, refreshChain]);

  const addressProblem = useMemo(() => {
    if (!address) return null;
    const check = checkAddress(address, network.addressRule);
    return check.ok ? null : `Your wallet's active address cannot act on Cyprus-1: ${check.error} Switch to a Cyprus-1 account in your wallet.`;
  }, [address, network.addressRule]);

  const value = useMemo<WalletState>(
    () => ({
      wallet,
      address: address ? (checkAddress(address, 'any').address ?? address) : null,
      addressProblem,
      chainId,
      onExpectedChain: chainId === network.chainId,
      connecting,
      error,
      connect,
      disconnect,
      refreshChain,
      dev: isLocal
        ? {
            accounts: devAccounts,
            select: (a: string) => {
              devAccountRef.current = a;
              setAddress(a);
              refreshChain();
            },
          }
        : null,
    }),
    [wallet, address, addressProblem, chainId, network.chainId, connecting, error, connect, disconnect, refreshChain, isLocal, devAccounts]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useWallet must be used inside WalletProvider');
  return v;
}
