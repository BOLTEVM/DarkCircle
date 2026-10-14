import React, { useMemo, useState } from 'react';
import { getAddress, keccak256, AbiCoder, concat, dataSlice, toBeHex, zeroPadValue } from 'ethers';
import { X, Rocket, AlertCircle, CheckCircle2, Circle, Loader2, ExternalLink } from 'lucide-react';
import {
  prepareQuaiTransaction,
  waitForConfirmations,
  receiptSucceeded,
  isCyprus1QuaiAddress,
  verifyFactory,
  codeAt,
  PINNED_CONTRACTS,
  QuaiRpcClient,
} from '@darksafe/core';
import { useWallet } from '../../context/WalletContext.js';
import { useSafe } from '../../context/SafeContext.js';
import {
  resolveWebNetworkConfig,
  isVaultCreationAllowed,
  requiredConfirmations,
  saveFactoryOverride,
  RECEIPT_TIMEOUT_MS,
} from '../../config/network.js';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const NETWORK_CONFIG = resolveWebNetworkConfig();
const ALLOWED = isVaultCreationAllowed(NETWORK_CONFIG);
const CONFIRMATIONS = requiredConfirmations(NETWORK_CONFIG);
const NETWORK_LABEL = NETWORK_CONFIG.name === 'mainnet' ? 'Quai Mainnet' : 'Quai Orchard Testnet';

/** The Orchard factory that rehearsed this release. Mainnet is offered only while it still verifies against the pinned build. */
const ORCHARD_REHEARSAL_FACTORY = '0x004aB9E83Ed1B93bE7ded9f4672b317699C890Ca';
const MAINNET_PHRASE = 'DEPLOY TO MAINNET';
const IS_MAINNET = NETWORK_CONFIG.name === 'mainnet';

interface Artifact {
  bytecode: string;
  deployedBytecode: string;
}

// import.meta.glob yields an empty map (not a build error) when the contracts have not been compiled.
const ARTIFACTS = import.meta.glob('../../../../../packages/contracts/artifacts/contracts/v2/*/*.json');

async function loadArtifact(name: string): Promise<Artifact> {
  const key = Object.keys(ARTIFACTS).find((k) => k.endsWith(`/${name}.sol/${name}.json`));
  if (!key) throw new Error(`The ${name} build is missing. Run \`pnpm -F @darksafe/contracts exec hardhat compile\` and reload.`);
  const load = ARTIFACTS[key];
  if (!load) throw new Error(`The ${name} build is missing.`);
  const mod: any = await load();
  return (mod.default ?? mod) as Artifact;
}

/** Quai's CREATE: keccak256(from ++ nonce as 8-byte big-endian ++ init data)[12:]. It hashes the init data, so salts can be ground. */
function quaiCreateAddress(from: string, nonce: number, data: string): string {
  return getAddress(dataSlice(keccak256(concat([from, zeroPadValue(toBeHex(nonce), 8), data])), 12));
}

/** Appends a 4-byte salt to the init data (constructors ignore it) until the CREATE address lands in Cyprus-1. */
function grind(from: string, nonce: number, data: string): { data: string; predicted: string } {
  let salt = nonce >>> 0;
  for (let i = 0; i < 200_000; i++) {
    const candidate = data + salt.toString(16).padStart(8, '0');
    const predicted = quaiCreateAddress(from, nonce, candidate);
    if (isCyprus1QuaiAddress(predicted)) return { data: candidate, predicted };
    salt = (salt + 1) >>> 0;
  }
  throw new Error('Could not find an in-zone contract address.');
}

type StepState = 'todo' | 'active' | 'done' | 'error';

export const DeployProtocolModal: React.FC<Props> = ({ isOpen, onClose }) => {
  const { signer, connectEip1193, isConnecting, error: walletError, sendPrepared, ensureWriteReady, isOnExpectedChain, readSource } = useWallet();
  const { rpcClient, deployment, reloadDeployment } = useSafe();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [implAddress, setImplAddress] = useState<string | null>(null);
  const [implTx, setImplTx] = useState<string | null>(null);
  const [factoryAddress, setFactoryAddress] = useState<string | null>(null);
  const [factoryTx, setFactoryTx] = useState<string | null>(null);
  const [builds, setBuilds] = useState<'unknown' | 'ok' | string>('unknown');
  const [balance, setBalance] = useState<bigint | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [ackUnaudited, setAckUnaudited] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const [rehearsal, setRehearsal] = useState<'checking' | 'ok' | string>('checking');

  // Build + balance checks feed the launch checklist; they run when the modal is open and the wallet is known.
  React.useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const [v, f] = await Promise.all([loadArtifact('DarkSafeVault'), loadArtifact('DarkSafeVaultFactory')]);
        const okVault = keccak256(v.bytecode) === PINNED_CONTRACTS.DarkSafeVaultV2.creationCodeHash;
        const okFactory = keccak256(f.bytecode) === PINNED_CONTRACTS.DarkSafeVaultFactoryV2.creationCodeHash;
        if (!cancelled) setBuilds(okVault && okFactory ? 'ok' : 'The compiled contracts differ from the pinned build (pinned.ts). Run `pnpm -F @darksafe/contracts pin` only if you changed them on purpose.');
      } catch (e: any) {
        if (!cancelled) setBuilds(e?.message ?? 'Contract build unavailable.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  React.useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    rpcClient
      .rawRequest<string>('quai_gasPrice', [])
      .then((h) => !cancelled && setGasPrice(BigInt(h)))
      .catch(() => !cancelled && setGasPrice(null));
    if (IS_MAINNET) {
      verifyFactory(new QuaiRpcClient('testnet'), ORCHARD_REHEARSAL_FACTORY)
        .then(() => !cancelled && setRehearsal('ok'))
        .catch((e: any) => !cancelled && setRehearsal(`The Orchard rehearsal factory did not verify: ${e?.message ?? e}`));
    }
    return () => {
      cancelled = true;
    };
  }, [isOpen, rpcClient]);

  // Balance: read from the app RPC and the wallet's own node, and trust the higher. Orchard nodes lag each other by
  // ~30 blocks, so a freshly funded account can read 0 on one node while the wallet already shows it.
  const [balanceNote, setBalanceNote] = useState<string | null>(null);
  const [balanceTick, setBalanceTick] = useState(0);
  React.useEffect(() => {
    if (!isOpen || !signer) {
      setBalance(null);
      setBalanceNote(null);
      return;
    }
    let cancelled = false;
    const read = async (src: { rawRequest<T = any>(m: string, p?: unknown[]): Promise<T> } | null): Promise<bigint | null> => {
      if (!src) return null;
      try {
        return BigInt(await src.rawRequest<string>('quai_getBalance', [getAddress(signer.address), 'latest']));
      } catch {
        return null;
      }
    };
    Promise.all([read(rpcClient), read(readSource)]).then(([app, wallet]) => {
      if (cancelled) return;
      const values = [app, wallet].filter((v): v is bigint => v !== null);
      setBalance(values.length ? values.reduce((a, b) => (a > b ? a : b)) : null);
      const fmt = (v: bigint | null) => (v === null ? 'unavailable' : `${(Number(v) / 1e18).toFixed(2)} QUAI`);
      setBalanceNote(`${signer.address}: app RPC ${fmt(app)}, wallet node ${fmt(wallet)}`);
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, signer, rpcClient, readSource, balanceTick]);

  // Worst case: both creation limits charged in full (a revert burns the whole limit); receipts have used up to 2.5x the simulator.
  const worstCase = gasPrice === null
    ? null
    : (BigInt(PINNED_CONTRACTS.DarkSafeVaultV2.runtimeBytes) + BigInt(PINNED_CONTRACTS.DarkSafeVaultFactoryV2.runtimeBytes)) * 1250n * gasPrice;
  const fmtQuai = (w: bigint) => `${(Number(w) / 1e18).toFixed(2)} QUAI`;

  const done = Boolean(deployment) || Boolean(factoryAddress && !busy && !error);

  const checklist = useMemo(
    () => [
      { label: `Network is ${NETWORK_LABEL}`, ok: ALLOWED, hint: 'Mainnet needs VITE_ALLOW_MAINNET_VAULTS=true and an audited tag; v2 has had no independent audit.' },
      { label: 'Contract builds match the pinned hashes', ok: builds === 'ok', hint: builds !== 'ok' && builds !== 'unknown' ? builds : 'Checking…' },
      { label: 'Quai wallet connected (Pelagus)', ok: Boolean(signer), hint: 'Connect the wallet that will pay for deployment.' },
      { label: `Wallet is on chain ${NETWORK_CONFIG.chainId}`, ok: Boolean(signer) && isOnExpectedChain, hint: IS_MAINNET ? 'Switch the wallet network to Quai Mainnet, Cyprus-1.' : 'Switch the wallet network to Orchard / Cyprus-1.' },
      {
        label: worstCase !== null ? `Deployer covers the worst case (${fmtQuai(worstCase)})` : 'Deployer covers the worst-case gas',
        ok: balance !== null && worstCase !== null && balance >= worstCase,
        hint: balance === null ? 'Connect a wallet to read its balance.' : `Balance is ${fmtQuai(balance)}. A revert is charged the whole gas limit; fund the peak. ${balanceNote ?? ''}`,
      },
      ...(IS_MAINNET
        ? [
            { label: 'Orchard rehearsal factory verifies against the pinned build', ok: rehearsal === 'ok', hint: rehearsal === 'checking' ? 'Checking…' : rehearsal },
            { label: 'Unaudited release acknowledged', ok: ackUnaudited, hint: 'DarkSafe v2 has had no independent audit.' },
            { label: `Typed confirmation "${MAINNET_PHRASE}"`, ok: phrase.trim() === MAINNET_PHRASE, hint: 'Type it exactly in the box below.' },
          ]
        : []),
      { label: 'No factory is live yet', ok: !deployment, hint: 'A verified factory already exists for this network.' },
    ],
    [builds, signer, isOnExpectedChain, balance, balanceNote, deployment, worstCase, rehearsal, ackUnaudited, phrase]
  );
  const ready = checklist.every((c) => c.ok) && acknowledged;
  const nameForNetwork = IS_MAINNET ? 'Quai Mainnet' : 'Quai Orchard Testnet';

  if (!isOpen) return null;

  const close = () => {
    if (!busy) onClose();
  };

  const sendCreation = async (label: string, from: string, data: string, runtimeBytes: number, predicted: string): Promise<string> => {
    setStage(`Simulating ${label}…`);
    const prepared = await prepareQuaiTransaction(rpcClient, { from, data }, { creationRuntimeBytes: runtimeBytes });
    setStage(`Confirm ${label} in your wallet…`);
    const hash = await sendPrepared(prepared);
    if (label.startsWith('implementation')) setImplTx(hash);
    else setFactoryTx(hash);
    const receipt = await waitForConfirmations(rpcClient, hash, {
      confirmations: CONFIRMATIONS,
      timeoutMs: RECEIPT_TIMEOUT_MS,
      onProgress: (p) =>
        setStage(p.stage === 'pending' ? `Waiting for ${label} to be mined…` : `${label}: ${Math.min(p.confirmations, CONFIRMATIONS)}/${CONFIRMATIONS} confirmations`),
    });
    if (!receiptSucceeded(receipt)) throw new Error(`${label} reverted on chain (tx ${hash}).`);
    const created = receipt.contractAddress ? getAddress(receipt.contractAddress) : null;
    if (created !== predicted) throw new Error(`${label} landed at ${created}, expected ${predicted}. Nothing was recorded; check tx ${hash}.`);
    return created;
  };

  const handleDeploy = async () => {
    if (!signer) return;
    setBusy(true);
    setError(null);
    try {
      await ensureWriteReady();
      const [vaultArt, factoryArt] = await Promise.all([loadArtifact('DarkSafeVault'), loadArtifact('DarkSafeVaultFactory')]);
      if (keccak256(vaultArt.bytecode) !== PINNED_CONTRACTS.DarkSafeVaultV2.creationCodeHash) throw new Error('Vault build differs from the pinned build.');
      if (keccak256(factoryArt.bytecode) !== PINNED_CONTRACTS.DarkSafeVaultFactoryV2.creationCodeHash) throw new Error('Factory build differs from the pinned build.');
      const from = getAddress(signer.address);

      // Resume: an implementation from an earlier attempt is reused only if its code is exactly the pinned one.
      let impl = implAddress;
      if (!impl) {
        const nonce = Number(await rpcClient.quai_getTransactionCount(from, 'pending'));
        const g = grind(from, nonce, vaultArt.bytecode);
        impl = await sendCreation('implementation', from, g.data, PINNED_CONTRACTS.DarkSafeVaultV2.runtimeBytes, g.predicted);
        if (keccak256(await codeAt(rpcClient, impl)) !== PINNED_CONTRACTS.DarkSafeVaultV2.runtimeCodeHash) {
          throw new Error('Implementation code on chain does not match the pinned build.');
        }
        setImplAddress(impl);
      }

      const nonce = Number(await rpcClient.quai_getTransactionCount(from, 'pending'));
      const ctor = AbiCoder.defaultAbiCoder().encode(['address'], [impl]).slice(2);
      const g = grind(from, nonce, factoryArt.bytecode + ctor);
      const factory = await sendCreation('factory', from, g.data, PINNED_CONTRACTS.DarkSafeVaultFactoryV2.runtimeBytes, g.predicted);

      setStage('Verifying the factory against the pinned build…');
      const verified = await verifyFactory(rpcClient, factory);
      if (verified.implementation !== impl) throw new Error('Factory points at a different implementation than the one just deployed.');
      setFactoryAddress(factory);
      saveFactoryOverride(factory, NETWORK_CONFIG.chainId);
      reloadDeployment();
    } catch (e: any) {
      setError(e?.message ?? 'Deployment failed.');
    } finally {
      setBusy(false);
      setStage(null);
    }
  };

  const explorer = (kind: 'tx' | 'address', v: string) => `${NETWORK_CONFIG.explorerUrl}/${kind}/${v}`;
  const stepState = (n: 1 | 2): StepState => {
    if (n === 1) return implAddress ? 'done' : busy && !implTx ? 'active' : busy && implTx ? 'active' : 'todo';
    return factoryAddress ? 'done' : busy && implAddress ? 'active' : 'todo';
  };
  const stepIcon = (s: StepState) =>
    s === 'done' ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : s === 'active' ? <Loader2 className="w-4 h-4 text-amber-300 animate-spin" /> : <Circle className="w-4 h-4 text-slate-600" />;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm" data-testid="deploy-modal">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto">
        <button onClick={close} className="absolute top-4 right-4 p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800">
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-2 mb-4">
          <div className="w-8 h-8 rounded-lg bg-amber-500/20 text-amber-300 flex items-center justify-center">
            <Rocket className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Deploy DarkSafe v2</h3>
            <p className="text-xs text-slate-400">Implementation + factory on {NETWORK_LABEL} (Cyprus-1)</p>
          </div>
        </div>

        {(walletError || error) && (
          <div className="mb-4 bg-red-950/40 border border-red-800/50 rounded-xl p-3 text-xs text-red-300 flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{error || walletError}</span>
          </div>
        )}

        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wide">Launch checklist</h4>
          <button type="button" onClick={() => setBalanceTick((n) => n + 1)} disabled={busy} className="text-xs text-emerald-400 hover:text-emerald-300" data-testid="recheck">
            Re-check
          </button>
        </div>
        <ul className="space-y-1.5 mb-4" data-testid="launch-checklist">
          {checklist.map((c) => (
            <li key={c.label} className="flex items-start space-x-2 text-xs">
              {c.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" /> : <Circle className="w-4 h-4 text-amber-400 flex-shrink-0" />}
              <div>
                <div className={c.ok ? 'text-slate-200' : 'text-amber-200'}>{c.label}</div>
                {!c.ok && <div className="text-slate-500">{c.hint}</div>}
              </div>
            </li>
          ))}
          {IS_MAINNET && (
            <>
              <li className="flex items-start space-x-2 text-xs">
                <input id="ackun" type="checkbox" className="mt-0.5" checked={ackUnaudited} onChange={(e) => setAckUnaudited(e.target.checked)} disabled={busy} />
                <label htmlFor="ackun" className="text-slate-300">
                  I understand DarkSafe v2 is unaudited and that this puts it on Quai mainnet, where it will hold real funds.
                </label>
              </li>
              <li className="text-xs">
                <input
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  disabled={busy}
                  placeholder={MAINNET_PHRASE}
                  aria-label="Type the confirmation phrase"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 font-mono text-slate-200"
                  data-testid="mainnet-phrase"
                />
              </li>
            </>
          )}
          <li className="flex items-start space-x-2 text-xs">
            <input id="ack" type="checkbox" className="mt-0.5" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} disabled={busy} />
            <label htmlFor="ack" className="text-slate-300">
              I understand this sends two real contract-creation transactions from my wallet, and that v2 is unaudited.
            </label>
          </li>
        </ul>

        <div className="space-y-2 mb-4 text-xs bg-slate-950/60 border border-slate-800 rounded-xl p-3">
          <div className="flex items-center space-x-2">
            {stepIcon(stepState(1))}
            <span className="text-slate-200">1. Vault implementation</span>
            {implAddress && (
              <a className="text-emerald-400 inline-flex items-center space-x-1" href={explorer('address', implAddress)} target="_blank" rel="noreferrer">
                <span className="font-mono">{implAddress.slice(0, 10)}…</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
          <div className="flex items-center space-x-2">
            {stepIcon(stepState(2))}
            <span className="text-slate-200">2. Vault factory</span>
            {factoryAddress && (
              <a className="text-emerald-400 inline-flex items-center space-x-1" href={explorer('address', factoryAddress)} target="_blank" rel="noreferrer">
                <span className="font-mono">{factoryAddress.slice(0, 10)}…</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
          {stage && <div className="text-amber-200 pt-1">{stage}</div>}
          {(implTx || factoryTx) && !done && <div className="text-slate-500">Do not close this tab until both confirm.</div>}
        </div>

        {done ? (
          <div className="space-y-3">
            <div className="bg-emerald-950/40 border border-emerald-700/50 rounded-xl p-3 text-xs text-emerald-200">
              Factory verified on chain against the pinned build. Vault creation is now available.
              {factoryAddress && (
                <div className="mt-1 font-mono break-all text-emerald-300">
                  {factoryAddress}
                </div>
              )}
              <div className="mt-1 text-emerald-200/70">
                Saved in this browser. To make it permanent, set VITE_V2_FACTORY_ADDRESS to this address or record it with the deploy script.
              </div>
            </div>
            <button onClick={onClose} className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm">
              Done
            </button>
          </div>
        ) : !signer ? (
          <button
            onClick={() => connectEip1193()}
            disabled={isConnecting}
            className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm disabled:opacity-50"
          >
            {isConnecting ? 'Connecting…' : 'Connect Quai wallet'}
          </button>
        ) : (
          <button
            onClick={handleDeploy}
            disabled={!ready || busy}
            className={`w-full py-2.5 rounded-xl font-bold text-sm ${ready && !busy ? 'bg-amber-400 hover:bg-amber-300 text-slate-950' : 'bg-slate-800 text-slate-500 cursor-not-allowed'}`}
            data-testid="deploy-button"
          >
            {busy ? 'Deploying…' : implAddress ? 'Resume: deploy factory' : 'Deploy implementation + factory'}
          </button>
        )}
      </div>
    </div>
  );
};
