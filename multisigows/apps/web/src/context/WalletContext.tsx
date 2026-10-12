import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  validateCyprus1Address,
  shortAddress,
  InjectedProviderLike,
  PreparedTx,
  RpcLike,
  injectedProviderSource,
  readWalletChainId,
  sendPreparedTransaction,
  ChainMismatchError,
} from '@darksafe/core';
import { ConnectedSigner, SignerMode } from '../types/index.js';
import { detectInjectedWallet, subscribeProvider, type InjectedWallet } from '../lib/injectedWallet.js';
import { resolveWebNetworkConfig } from '../config/network.js';

const NETWORK_CONFIG = resolveWebNetworkConfig();

async function readAccounts(wallet: InjectedWallet): Promise<string[]> {
  const method = wallet.isQuaiNative ? 'quai_accounts' : 'eth_accounts';
  try {
    const accounts = await wallet.provider.request({ method });
    return Array.isArray(accounts) ? accounts : [];
  } catch {
    return [];
  }
}

interface WalletContextValue {
  signer: ConnectedSigner | null;
  mode: SignerMode;
  isConnecting: boolean;
  hasExtension: boolean;
  extensionName: string | null;
  isQuaiNativeExtension: boolean;
  /** The chain the wallet reports right now, or null if unknown. */
  walletChainId: number | null;
  expectedChainId: number;
  isOnExpectedChain: boolean;
  error: string | null;
  connectEip1193: () => Promise<void>;
  disconnect: () => void;
  /**
   * Re-checks, immediately before any write, that the wallet is still present, still on
   * the expected chain, and still has the connected account selected.
   */
  ensureWriteReady: () => Promise<InjectedWallet>;
  /**
   * The wallet's own node, used as an independent read source (v2 vaults approve on chain,
   * so nothing is ever signed off chain). Null when no Quai wallet is connected.
   */
  readSource: RpcLike | null;
  /** Sends a transaction already simulated and sized by prepareQuaiTransaction. */
  sendPrepared: (prepared: PreparedTx) => Promise<string>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export const WalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode] = useState<SignerMode>('eip1193');
  const [signer, setSigner] = useState<ConnectedSigner | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [wallet, setWallet] = useState<InjectedWallet | null>(null);
  const [walletChainId, setWalletChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const signerRef = useRef<ConnectedSigner | null>(null);
  signerRef.current = signer;

  useEffect(() => {
    setWallet(detectInjectedWallet());
  }, []);

  useEffect(() => {
    if (!wallet) return;
    const provider = wallet.provider;

    const onAccountsChanged = (accounts: unknown) => {
      const next = Array.isArray(accounts) ? String(accounts[0] ?? '') : '';
      const current = signerRef.current;
      if (current && next.toLowerCase() !== current.address.toLowerCase()) {
        setSigner(null);
        setError('The account selected in your wallet changed. Reconnect to continue.');
      }
    };
    const onChainChanged = (chainId: unknown) => {
      const parsed = typeof chainId === 'string' ? parseInt(chainId, 16) : typeof chainId === 'number' ? chainId : null;
      setWalletChainId(Number.isFinite(parsed) ? parsed : null);
    };
    const onDisconnect = () => {
      setSigner(null);
      setWalletChainId(null);
    };

    // never throws: a provider that rejects an event just gives no live updates for it
    return subscribeProvider(provider, {
      accountsChanged: onAccountsChanged,
      chainChanged: onChainChanged,
      disconnect: onDisconnect,
    });
  }, [wallet]);

  const connectEip1193 = useCallback(async () => {
    setIsConnecting(true);
    setError(null);
    try {
      const detected = detectInjectedWallet();
      if (!detected) {
        throw new Error('No Quai wallet found. Install Pelagus (recommended) to sign with DarkSafe.');
      }
      setWallet(detected);
      const { provider, providerName, isQuaiNative } = detected;

      const accounts: string[] = await provider.request({
        method: isQuaiNative ? 'quai_requestAccounts' : 'eth_requestAccounts',
        params: [],
      });
      if (!accounts || accounts.length === 0) {
        throw new Error('No accounts selected in the wallet.');
      }

      const primaryAccount = accounts[0]!;
      const validation = validateCyprus1Address(primaryAccount);
      if (!validation.isValid || !validation.checksumAddress) {
        throw new Error(
          `${providerName} account ${primaryAccount} is not a Cyprus-1 (0x00-prefixed) address. Switch to a Cyprus-1 account in ${providerName}.`
        );
      }

      const chainId = await readWalletChainId(provider);
      setWalletChainId(chainId);

      setSigner({
        address: validation.checksumAddress,
        label: shortAddress(validation.checksumAddress),
        mode: 'eip1193',
        providerName,
        isOwner: true,
      });
    } catch (err: any) {
      console.warn('Extension connection warning:', err);
      setError(err?.message || 'Failed to connect extension');
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setSigner(null);
  }, []);

  const ensureWriteReady = useCallback(async (): Promise<InjectedWallet> => {
    const detected = detectInjectedWallet();
    const current = signerRef.current;
    if (!detected || !current) {
      throw new Error('Connect your Quai wallet before signing or sending anything.');
    }

    const chainId = await readWalletChainId(detected.provider);
    setWalletChainId(chainId);
    if (chainId !== NETWORK_CONFIG.chainId) {
      throw new ChainMismatchError(NETWORK_CONFIG.chainId, chainId);
    }

    const accounts = await readAccounts(detected);
    if (accounts.length > 0 && accounts[0]!.toLowerCase() !== current.address.toLowerCase()) {
      setSigner(null);
      throw new Error('The account selected in your wallet no longer matches the connected account. Reconnect first.');
    }
    return detected;
  }, []);

  const sendPrepared = useCallback(
    async (prepared: PreparedTx): Promise<string> => {
      const { provider, providerName, isQuaiNative } = await ensureWriteReady();
      const current = signerRef.current!;
      if (prepared.from.toLowerCase() !== current.address.toLowerCase()) {
        throw new Error('This transaction was prepared for a different account. Nothing was sent.');
      }
      try {
        return await sendPreparedTransaction(
          provider,
          prepared,
          isQuaiNative ? 'quai_sendTransaction' : 'eth_sendTransaction'
        );
      } catch (err: any) {
        if (err?.code === 4001) throw new Error(`You rejected the transaction in ${providerName}.`);
        throw new Error(`${providerName} failed to send the transaction: ${err?.message || err}`);
      }
    },
    [ensureWriteReady]
  );

  const readSource = useMemo(
    () => (signer && wallet?.isQuaiNative ? injectedProviderSource(wallet.provider) : null),
    [signer, wallet]
  );

  return (
    <WalletContext.Provider
      value={{
        signer,
        mode,
        isConnecting,
        hasExtension: wallet !== null,
        extensionName: wallet?.providerName ?? null,
        isQuaiNativeExtension: wallet?.isQuaiNative ?? false,
        walletChainId,
        expectedChainId: NETWORK_CONFIG.chainId,
        isOnExpectedChain: walletChainId === NETWORK_CONFIG.chainId,
        error,
        connectEip1193,
        disconnect,
        ensureWriteReady,
        readSource,
        sendPrepared,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
};

export function useWallet(): WalletContextValue {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}
