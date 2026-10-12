import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  QuaiRpcClient,
  QuaiReceipt,
  FetchLike,
  ReadSource,
  VaultDeployment,
  VerifiedVault,
  VaultTransaction,
  ChainClock,
  TransactionReview,
  ProposalDraft,
  NoDeploymentError,
  BroadcastError,
  resolveDeployment,
  assertVaultAuthentic,
  readVaultAcrossSources,
  readRecentTransactions,
  readChainClock,
  verifyVaultTransaction,
  reviewAllowsWrite,
  prepareQuaiTransaction,
  waitForConfirmations,
  receiptSucceeded,
  vaultCalls,
  proposedHashFromLogs,
  parseVaultLogs,
  simulateVaultCall,
  describeVaultRevert,
  decodeVaultCall,
  isCyprus1QuaiAddress,
  validateCyprus1Address,
  SimulationError,
} from '@darksafe/core';
import { AddressBookEntry, KnownVault, SafeState } from '../types/index.js';
import { useWallet } from './WalletContext.js';
import {
  resolveWebNetworkConfig,
  isVaultCreationAllowed,
  requiredConfirmations,
  RECEIPT_TIMEOUT_MS,
  factoryOverride,
  secondaryRpcUrl,
} from '../config/network.js';

const NETWORK_CONFIG = resolveWebNetworkConfig();
const REFRESH_INTERVAL_MS = 30_000;
const RECENT_TRANSACTIONS = 25;

export const MAINNET_GATE_MESSAGE =
  'DarkSafe vaults are not yet enabled on Quai mainnet: the vault contract has not had an independent security audit. ' +
  'Use Orchard testnet, or set VITE_ALLOW_MAINNET_VAULTS=true in a build you control and accept that risk.';

// v2 uses new keys: v1 vault entries are never shown as v2 vaults.
const KNOWN_VAULTS_STORAGE_KEY = 'darksafe.vaults.v2';
const ADDRESS_BOOK_STORAGE_KEY = `darksafe.addressbook.v1.${NETWORK_CONFIG.chainId}`;

function isKnownVault(v: any): v is KnownVault {
  return (
    v !== null &&
    typeof v === 'object' &&
    typeof v.address === 'string' &&
    isCyprus1QuaiAddress(v.address) &&
    typeof v.factory === 'string' &&
    isCyprus1QuaiAddress(v.factory) &&
    Number.isInteger(v.chainId) &&
    typeof v.addedAt === 'number' &&
    (v.name === undefined || (typeof v.name === 'string' && v.name.length <= 64))
  );
}

function isAddressBookEntry(e: any): e is AddressBookEntry {
  return (
    e !== null &&
    typeof e === 'object' &&
    typeof e.address === 'string' &&
    validateCyprus1Address(e.address).isValid &&
    typeof e.label === 'string' &&
    e.label.length > 0 &&
    e.label.length <= 40 &&
    typeof e.addedAt === 'number'
  );
}

function loadJsonArray<T>(key: string, guard: (v: unknown) => v is T): T[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(guard) : [];
  } catch {
    return [];
  }
}

function saveJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage unavailable (private mode, quota): in-memory state still works.
  }
}

const EMPTY_SAFE_STATE: SafeState = {
  address: '',
  name: '',
  chainId: NETWORK_CONFIG.chainId,
  owners: [],
  threshold: 0,
  minExecutionDelay: 0,
  txNonce: 0,
  balance: null,
  isLoading: false,
  isDeployed: false,
  error: null,
  verification: 'none',
  sourceReports: [],
  problems: [],
  block: null,
  lastVerifiedAt: null,
};

export type ActionKind = 'approve' | 'revoke' | 'execute' | 'cancel' | 'expire';

export interface ActionProgress {
  kind: ActionKind | 'propose';
  /** The vault transaction acted on (null while proposing). */
  hash: string | null;
  stage: string;
  chainTxHash?: string;
}

export interface ActionResult {
  chainTxHash: string;
  /** For proposals, the new vault transaction hash. */
  vaultTxHash: string | null;
  /** Plain-language outcome, e.g. "Executed" or "Timelock started". */
  outcome: string;
}

interface SafeContextValue {
  safeState: SafeState;
  knownVaults: KnownVault[];
  deployment: VaultDeployment | null;
  deploymentError: string | null;
  transactions: VaultTransaction[];
  clock: ChainClock | null;
  rpcClient: QuaiRpcClient;
  sources: ReadSource[];
  /** Addresses this vault has already paid, plus the address book (lower-case). */
  knownRecipients: ReadonlySet<string>;
  addressBook: AddressBookEntry[];
  saveAddress: (address: string, label: string) => void;
  removeAddress: (address: string) => void;
  labelFor: (address: string) => string | null;
  refreshSafeState: () => Promise<void>;
  selectVault: (address: string) => void;
  /** Saves a vault that has already passed assertVaultAuthentic (and, after creation, assertVaultMatchesParams). */
  registerVerifiedVault: (vault: VerifiedVault, name?: string) => void;
  /** Adds an existing vault; refused unless it is a genuine vault created by the DarkSafe factory. */
  addExistingVault: (address: string, name?: string) => Promise<VerifiedVault>;
  forgetVault: (address: string) => void;
  /** Reads and cross-checks everything the review screen shows. */
  reviewTransaction: (hash: string, nonce?: number) => Promise<TransactionReview>;
  proposeDraft: (draft: ProposalDraft) => Promise<ActionResult>;
  runAction: (kind: ActionKind, hash: string, nonce: number) => Promise<ActionResult>;
  progress: ActionProgress | null;
  /** Why writes are blocked right now, or null if they are allowed. */
  writeBlockReason: string | null;
}

const SafeContext = createContext<SafeContextValue | null>(null);

function makeRpc(url: string): QuaiRpcClient {
  const safeFetch: FetchLike = (u, init) => {
    if (!init) return fetch(u);
    const { signal, ...rest } = init;
    return fetch(u, rest);
  };
  return new QuaiRpcClient(url, { maxRetries: 1, timeoutMs: 8000, fetchFn: safeFetch });
}

export const SafeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { signer, sendPrepared, readSource, extensionName } = useWallet();
  const rpcClient = useMemo(() => makeRpc(NETWORK_CONFIG.rpcUrl), []);
  const secondaryClient = useMemo(() => {
    const url = secondaryRpcUrl();
    return url ? makeRpc(url) : null;
  }, []);
  const sources = useMemo<ReadSource[]>(() => {
    const list: ReadSource[] = [{ name: 'App RPC', rpc: rpcClient }];
    if (secondaryClient) list.push({ name: 'Second RPC', rpc: secondaryClient });
    if (readSource) list.push({ name: `${extensionName ?? 'Wallet'} node`, rpc: readSource });
    return list;
  }, [rpcClient, secondaryClient, readSource, extensionName]);

  const [deployment, setDeployment] = useState<VaultDeployment | null>(null);
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  const [knownVaults, setKnownVaults] = useState<KnownVault[]>(() => loadJsonArray(KNOWN_VAULTS_STORAGE_KEY, isKnownVault));
  const knownVaultsRef = useRef(knownVaults);
  knownVaultsRef.current = knownVaults;
  const [addressBook, setAddressBook] = useState<AddressBookEntry[]>(() => loadJsonArray(ADDRESS_BOOK_STORAGE_KEY, isAddressBookEntry));

  const [safeAddress, setSafeAddress] = useState('');
  const [safeState, setSafeState] = useState<SafeState>(EMPTY_SAFE_STATE);
  const [transactions, setTransactions] = useState<VaultTransaction[]>([]);
  const [clock, setClock] = useState<ChainClock | null>(null);
  const [progress, setProgress] = useState<ActionProgress | null>(null);
  const refreshing = useRef(false);
  // A refresh requested while one is running (e.g. a wallet connected, adding a source) runs next.
  const refreshAgain = useRef(false);
  const latestRefresh = useRef<() => Promise<void>>(async () => undefined);

  // The factory is verified on chain before anything relies on it.
  useEffect(() => {
    let cancelled = false;
    resolveDeployment(rpcClient, NETWORK_CONFIG.chainId, factoryOverride())
      .then((d) => {
        if (!cancelled) setDeployment(d);
      })
      .catch((err) => {
        if (cancelled) return;
        setDeploymentError(
          err instanceof NoDeploymentError
            ? `DarkSafe v2 is not deployed on ${NETWORK_CONFIG.name === 'mainnet' ? 'Quai mainnet' : 'Orchard'} yet, so vaults cannot be created or opened here.`
            : `Could not verify the DarkSafe factory: ${err?.message ?? err}`
        );
      });
    return () => {
      cancelled = true;
    };
  }, [rpcClient]);

  // Pick the most recent vault for this network; it is verified on chain before it is shown as live.
  useEffect(() => {
    const forThisChain = knownVaults.filter((v) => v.chainId === NETWORK_CONFIG.chainId);
    if (forThisChain.length === 0) return;
    const mostRecent = forThisChain.reduce((a, b) => (b.addedAt > a.addedAt ? b : a));
    setSafeAddress(mostRecent.address);
    setSafeState({ ...EMPTY_SAFE_STATE, address: mostRecent.address, name: mostRecent.name || '', isLoading: true, verification: 'verifying' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshSafeState = useCallback(async () => {
    if (!safeAddress || !deployment) return;
    if (refreshing.current) {
      refreshAgain.current = true;
      return;
    }
    refreshing.current = true;
    setSafeState((prev) => ({ ...prev, isLoading: true, verification: prev.lastVerifiedAt ? prev.verification : 'verifying' }));
    try {
      const read = await readVaultAcrossSources(sources, safeAddress, deployment);
      const snap = read.value.snapshot;
      const [txs, chainClock] = await Promise.all([
        readRecentTransactions(rpcClient, safeAddress, snap.txNonce, { count: RECENT_TRANSACTIONS, tag: read.block }),
        readChainClock(rpcClient),
      ]);
      setTransactions(txs);
      setClock(chainClock);
      setSafeState((prev) => ({
        ...prev,
        address: read.value.address,
        owners: snap.owners,
        threshold: snap.threshold,
        minExecutionDelay: snap.minExecutionDelay,
        txNonce: snap.txNonce,
        balance: snap.balance,
        isDeployed: true,
        isLoading: false,
        error: read.status === 'disagreement' ? 'Independent sources disagree about this vault. Every action is blocked until they agree.' : null,
        verification: read.status,
        sourceReports: read.reports,
        problems: read.problems,
        block: read.block,
        lastVerifiedAt: Date.now(),
      }));
    } catch (err: any) {
      setSafeState((prev) => ({
        ...prev,
        isLoading: false,
        verification: 'error',
        error: `Could not verify this vault on chain; figures shown are the last good read and actions are disabled. ${err?.message || err}`,
      }));
    } finally {
      refreshing.current = false;
      if (refreshAgain.current) {
        refreshAgain.current = false;
        setTimeout(() => latestRefresh.current(), 0);
      }
    }
  }, [safeAddress, deployment, sources, rpcClient]);
  latestRefresh.current = refreshSafeState;

  useEffect(() => {
    if (!safeAddress || !deployment) return;
    refreshSafeState();
    const timer = setInterval(refreshSafeState, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [safeAddress, deployment, refreshSafeState]);

  const persistKnownVaults = useCallback((vaults: KnownVault[]) => {
    setKnownVaults(vaults);
    saveJson(KNOWN_VAULTS_STORAGE_KEY, vaults);
  }, []);

  const selectVault = useCallback((address: string) => {
    if (!isCyprus1QuaiAddress(address)) return;
    const entry = knownVaultsRef.current.find((v) => v.address.toLowerCase() === address.toLowerCase());
    setSafeAddress(entry?.address ?? address);
    setTransactions([]);
    setSafeState({ ...EMPTY_SAFE_STATE, address: entry?.address ?? address, name: entry?.name || '', isLoading: true, verification: 'verifying' });
  }, []);

  const registerVerifiedVault = useCallback(
    (vault: VerifiedVault, name?: string) => {
      if (!isVaultCreationAllowed()) throw new Error(MAINNET_GATE_MESSAGE);
      const entry: KnownVault = {
        address: vault.address,
        chainId: NETWORK_CONFIG.chainId,
        name: name?.slice(0, 64),
        addedAt: Date.now(),
        factory: vault.deployment.factory,
      };
      persistKnownVaults([...knownVaultsRef.current.filter((v) => v.address.toLowerCase() !== vault.address.toLowerCase()), entry]);
      setSafeAddress(vault.address);
      setTransactions([]);
      setSafeState({ ...EMPTY_SAFE_STATE, address: vault.address, name: entry.name || '', isLoading: true, verification: 'verifying' });
    },
    [persistKnownVaults]
  );

  const addExistingVault = useCallback(
    async (address: string, name?: string) => {
      if (!isVaultCreationAllowed()) throw new Error(MAINNET_GATE_MESSAGE);
      if (!deployment) throw new Error(deploymentError ?? 'The DarkSafe factory has not been verified yet.');
      const vault = await assertVaultAuthentic(rpcClient, address.trim(), deployment);
      registerVerifiedVault(vault, name);
      return vault;
    },
    [deployment, deploymentError, rpcClient, registerVerifiedVault]
  );

  const forgetVault = useCallback(
    (address: string) => {
      persistKnownVaults(knownVaultsRef.current.filter((v) => v.address.toLowerCase() !== address.toLowerCase()));
      if (safeAddress.toLowerCase() === address.toLowerCase()) {
        setSafeAddress('');
        setTransactions([]);
        setSafeState(EMPTY_SAFE_STATE);
      }
    },
    [persistKnownVaults, safeAddress]
  );

  // ---------------------------------------------------------------- address book

  const saveAddress = useCallback((address: string, label: string) => {
    const val = validateCyprus1Address(address);
    const clean = label.trim().slice(0, 40);
    if (!val.isValid || !val.checksumAddress || !clean) return;
    setAddressBook((prev) => {
      const next = [...prev.filter((e) => e.address.toLowerCase() !== address.toLowerCase()), { address: val.checksumAddress!, label: clean, addedAt: Date.now() }];
      saveJson(ADDRESS_BOOK_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const removeAddress = useCallback((address: string) => {
    setAddressBook((prev) => {
      const next = prev.filter((e) => e.address.toLowerCase() !== address.toLowerCase());
      saveJson(ADDRESS_BOOK_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const labelFor = useCallback(
    (address: string) => {
      if (address.toLowerCase() === safeAddress.toLowerCase()) return 'This vault';
      return addressBook.find((e) => e.address.toLowerCase() === address.toLowerCase())?.label ?? null;
    },
    [addressBook, safeAddress]
  );

  const knownRecipients = useMemo(() => {
    const set = new Set<string>(addressBook.map((e) => e.address.toLowerCase()));
    for (const tx of transactions) {
      if (!tx.executed || tx.failed) continue;
      const d = decodeVaultCall({ vault: safeAddress, to: tx.to, value: tx.value, data: tx.data });
      if (d.kind === 'native-transfer') set.add(d.to.toLowerCase());
      if (d.kind === 'erc20-transfer') set.add(d.recipient.toLowerCase());
      if (d.kind === 'erc20-approve') set.add(d.spender.toLowerCase());
    }
    return set;
  }, [addressBook, transactions, safeAddress]);

  // ---------------------------------------------------------------- writes

  const isOwner = Boolean(signer && safeState.owners.some((o) => o.toLowerCase() === signer.address.toLowerCase()));
  // Everything except ownership: anyone may formally expire a transaction.
  const baseBlockReason = !deployment
    ? deploymentError ?? 'Verifying the DarkSafe factory...'
    : !safeAddress
      ? 'No vault selected.'
      : safeState.verification === 'disagreement'
        ? 'Independent sources disagree about this vault, so every action is blocked.'
        : safeState.error || safeState.lastVerifiedAt === null
          ? 'This vault has not been verified on chain yet.'
          : !signer
            ? 'Connect a Quai wallet to act on this vault.'
            : null;
  const writeBlockReason = baseBlockReason ?? (isOwner ? null : 'The connected account is not an owner of this vault.');

  const sendVaultCall = useCallback(
    async (data: string, update: (stage: string, chainTxHash?: string) => void) => {
      if (!signer) throw new Error('Connect a Quai wallet first.');
      update('Simulating on chain...');
      const prepared = await prepareQuaiTransaction(rpcClient, { from: signer.address, to: safeAddress, data });
      update('Confirm in your wallet...');
      const chainTxHash = await sendPrepared(prepared);
      const confirmations = requiredConfirmations();
      update(`Waiting for ${confirmations} confirmations...`, chainTxHash);
      const receipt: QuaiReceipt = await waitForConfirmations(rpcClient, chainTxHash, {
        confirmations,
        timeoutMs: RECEIPT_TIMEOUT_MS,
        onProgress: (p) => update(p.stage === 'pending' ? 'Waiting to be mined...' : `Confirmations: ${Math.min(p.confirmations, confirmations)}/${confirmations}`, chainTxHash),
      });
      if (!receiptSucceeded(receipt)) throw new BroadcastError(`Transaction ${chainTxHash} reverted on chain.`, chainTxHash);
      return { receipt, chainTxHash, prepared };
    },
    [signer, rpcClient, safeAddress, sendPrepared]
  );

  const reviewTransaction = useCallback(
    async (hash: string, nonce?: number) => {
      if (!deployment || !safeAddress) throw new Error('No verified vault selected.');
      return verifyVaultTransaction({ sources, address: safeAddress, deployment, chainId: NETWORK_CONFIG.chainId, hash, nonce });
    },
    [deployment, safeAddress, sources]
  );

  const withProgress = useCallback(
    async <T,>(kind: ActionProgress['kind'], hash: string | null, run: (update: (stage: string, chainTxHash?: string) => void) => Promise<T>): Promise<T> => {
      const update = (stage: string, chainTxHash?: string) => setProgress({ kind, hash, stage, chainTxHash });
      update('Starting...');
      try {
        return await run(update);
      } catch (err: any) {
        if (err instanceof SimulationError) {
          const named = describeVaultRevert(err.revertData);
          throw new Error(named ? `The vault would reject this: ${named}. Nothing was sent.` : err.message);
        }
        throw err;
      } finally {
        setProgress(null);
        refreshSafeState();
      }
    },
    [refreshSafeState]
  );

  const proposeDraft = useCallback(
    async (draft: ProposalDraft): Promise<ActionResult> => {
      if (writeBlockReason) throw new Error(writeBlockReason);
      return withProgress('propose', null, async (update) => {
        const { receipt, chainTxHash } = await sendVaultCall(vaultCalls.propose(draft), update);
        const vaultTxHash = proposedHashFromLogs(receipt.logs, safeAddress);
        return { chainTxHash, vaultTxHash, outcome: 'Proposed, with your approval recorded' };
      });
    },
    [writeBlockReason, withProgress, sendVaultCall, safeAddress]
  );

  const runAction = useCallback(
    async (kind: ActionKind, hash: string, nonce: number): Promise<ActionResult> => {
      const block = kind === 'expire' ? baseBlockReason : writeBlockReason;
      if (block) throw new Error(block);
      return withProgress(kind, hash, async (update) => {
        // Check again immediately before sending: nothing shown in the review may have changed.
        update('Re-verifying the transaction...');
        const review = await reviewTransaction(hash, nonce);
        if (!reviewAllowsWrite(review)) throw new Error('Independent sources disagree about this transaction. Nothing was sent.');
        if (kind === 'execute' && review.tx.to.toLowerCase() !== safeAddress.toLowerCase()) {
          const sim = await simulateVaultCall(rpcClient, { vault: safeAddress, to: review.tx.to, value: review.tx.value, data: review.tx.data, gasLimit: review.tx.gasLimit });
          if (!sim.ok) {
            throw new Error(
              `The call would fail right now (${sim.reason}). A failed call marks the transaction failed for good, so nothing was sent.`
            );
          }
        }
        const { receipt, chainTxHash } = await sendVaultCall(vaultCalls[kind](hash), update);
        const events = parseVaultLogs(receipt.logs, safeAddress).filter((e) => String(e.args.txHash).toLowerCase() === hash.toLowerCase());
        const names = new Set(events.map((e) => e.name));
        const outcome = names.has('TransactionFailed')
          ? 'Executed, but the call failed; the transaction is now closed as failed'
          : names.has('TransactionExecuted')
            ? 'Executed'
            : kind === 'execute' && names.has('ThresholdReached')
              ? 'Timelock started; execute again once it has passed'
              : { approve: 'Approved', revoke: 'Approval revoked', cancel: 'Cancelled', expire: 'Marked expired', execute: 'Confirmed' }[kind];
        return { chainTxHash, vaultTxHash: hash, outcome };
      });
    },
    [baseBlockReason, writeBlockReason, withProgress, reviewTransaction, safeAddress, rpcClient, sendVaultCall]
  );

  return (
    <SafeContext.Provider
      value={{
        safeState,
        knownVaults,
        deployment,
        deploymentError,
        transactions,
        clock,
        rpcClient,
        sources,
        knownRecipients,
        addressBook,
        saveAddress,
        removeAddress,
        labelFor,
        refreshSafeState,
        selectVault,
        registerVerifiedVault,
        addExistingVault,
        forgetVault,
        reviewTransaction,
        proposeDraft,
        runAction,
        progress,
        writeBlockReason,
      }}
    >
      {children}
    </SafeContext.Provider>
  );
};

export function useSafe(): SafeContextValue {
  const context = useContext(SafeContext);
  if (!context) throw new Error('useSafe must be used within a SafeProvider');
  return context;
}
