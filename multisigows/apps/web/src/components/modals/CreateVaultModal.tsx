import React, { useState } from 'react';
import { getAddress } from 'ethers';
import { X, Shield, Plus, Trash2, AlertCircle, CheckCircle2, Wallet, ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import {
  validateCyprus1Address,
  isCyprus1QuaiAddress,
  prepareQuaiTransaction,
  waitForConfirmations,
  receiptSucceeded,
  assertVaultAuthentic,
  assertVaultMatchesParams,
  BroadcastError,
  mineVaultSalt,
  createWalletCall,
  walletCreatedFromLogs,
  factoryInterface,
  callAt,
  codeAt,
  assessVaultConfig,
  VAULT_PRESETS,
  VAULT_LIMITS,
  formatDuration,
} from '@safebuddy/core';
import { useWallet } from '../../context/WalletContext.js';
import { useSafe, MAINNET_GATE_MESSAGE } from '../../context/SafeContext.js';
import { resolveWebNetworkConfig, isVaultCreationAllowed, requiredConfirmations, RECEIPT_TIMEOUT_MS } from '../../config/network.js';
import { AddressLine } from '../AddressLine.js';

interface CreateVaultModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type Step = 'connect' | 'owners' | 'security' | 'review';

const NETWORK_CONFIG = resolveWebNetworkConfig();
const CREATION_ALLOWED = isVaultCreationAllowed(NETWORK_CONFIG);
const CONFIRMATIONS = requiredConfirmations(NETWORK_CONFIG);
const HOUR = 3600;
/** A day on mainnet; an hour on Orchard so testing does not take days. */
const DEFAULT_DELAY = NETWORK_CONFIG.name === 'mainnet' ? 24 * HOUR : HOUR;
const GRADE_STYLE: Record<string, string> = {
  A: 'bg-emerald-950/50 border-emerald-700/60 text-emerald-200',
  B: 'bg-lime-950/40 border-lime-700/50 text-lime-200',
  C: 'bg-amber-950/40 border-amber-700/50 text-amber-200',
  D: 'bg-red-950/50 border-red-700/60 text-red-200',
};

function ownerProblem(raw: string): string | null {
  const v = validateCyprus1Address(raw);
  if (!v.isValid) return v.error ?? 'Not a Cyprus-1 address.';
  if (!isCyprus1QuaiAddress(raw)) return 'This is a Qi-ledger address; it can never approve anything.';
  if (/^0x0{39}[01]$/i.test(raw)) return 'The zero address and 0x…01 cannot be owners.';
  return null;
}

export const CreateVaultModal: React.FC<CreateVaultModalProps> = ({ isOpen, onClose }) => {
  const { signer, connectEip1193, isConnecting, error: walletError, sendPrepared, isOnExpectedChain, walletChainId } = useWallet();
  const { registerVerifiedVault, rpcClient, deployment, deploymentError } = useSafe();

  const [step, setStep] = useState<Step>('connect');
  const [owners, setOwners] = useState<string[]>(['']);
  const [threshold, setThreshold] = useState<number>(1);
  const [delayHours, setDelayHours] = useState<string>(String(DEFAULT_DELAY / HOUR));
  const [vaultName, setVaultName] = useState('');
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deployStage, setDeployStage] = useState<string | null>(null);

  if (!isOpen) return null;

  const reset = () => {
    setStep('connect');
    setOwners(['']);
    setThreshold(1);
    setDelayHours(String(DEFAULT_DELAY / HOUR));
    setVaultName('');
    setDeployError(null);
    setDeployStage(null);
  };

  const handleClose = () => {
    if (isDeploying) return;
    reset();
    onClose();
  };

  const trimmedOwners = owners.map((o) => o.trim()).filter(Boolean);
  const lowerOwners = trimmedOwners.map((o) => o.toLowerCase());
  const hasDuplicates = new Set(lowerOwners).size !== lowerOwners.length;
  const allOwnersValid =
    trimmedOwners.length > 0 &&
    trimmedOwners.length <= VAULT_LIMITS.MAX_OWNERS &&
    owners.every((o) => o.trim() && ownerProblem(o.trim()) === null) &&
    !hasDuplicates;

  const delaySeconds = Math.round(Number(delayHours) * HOUR);
  const delayValid = delayHours.trim() !== '' && Number.isFinite(delaySeconds) && delaySeconds >= 0 && delaySeconds <= VAULT_LIMITS.MAX_EXECUTION_DELAY;
  const assessment = assessVaultConfig(trimmedOwners.length, threshold, delayValid ? delaySeconds : 0);
  const canStart = Boolean(signer) && CREATION_ALLOWED && deployment !== null;

  const goToOwnersStep = async () => {
    if (!signer) {
      await connectEip1193();
      return;
    }
    setOwners((prev) => (prev.length === 1 && !prev[0] ? [signer.address] : prev));
    setStep('owners');
  };

  const applyPreset = (id: string) => {
    const p = VAULT_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setOwners((prev) => {
      const filled = prev.filter((o) => o.trim());
      return filled.length >= p.owners ? filled : [...filled, ...Array(p.owners - filled.length).fill('')];
    });
    setThreshold(p.threshold);
    setDelayHours(String(p.delaySeconds / HOUR));
    setStep('owners');
  };

  const handleCreate = async () => {
    if (!signer || !deployment) {
      setDeployError(!signer ? 'Wallet disconnected. Reconnect and try again.' : deploymentError ?? 'No verified factory.');
      return;
    }
    if (!CREATION_ALLOWED) {
      setDeployError(MAINNET_GATE_MESSAGE);
      return;
    }
    setIsDeploying(true);
    setDeployError(null);
    let txHash: string | null = null;
    try {
      const checksummed = trimmedOwners.map((o) => getAddress(o));
      const params = { owners: checksummed, threshold, minExecutionDelay: delaySeconds };

      setDeployStage('Finding a Cyprus-1 address for the vault...');
      const mined = mineVaultSalt({ factory: deployment.factory, implementation: deployment.implementation, creator: signer.address, params });
      const predictedRaw = await callAt(
        rpcClient,
        deployment.factory,
        factoryInterface.encodeFunctionData('predictWalletAddress', [signer.address, checksummed, threshold, delaySeconds, mined.salt])
      );
      const predicted = getAddress(factoryInterface.decodeFunctionResult('predictWalletAddress', predictedRaw)[0]);
      if (predicted !== mined.address) {
        throw new Error(`The factory predicts ${predicted}, but this app computed ${mined.address}. Refusing to create.`);
      }
      if ((await codeAt(rpcClient, predicted)) !== '0x') throw new Error(`${predicted} already has code. Try again (a new salt is mined each time).`);

      setDeployStage('Simulating the creation...');
      const prepared = await prepareQuaiTransaction(rpcClient, {
        from: signer.address,
        to: deployment.factory,
        data: createWalletCall(checksummed, threshold, delaySeconds, mined.salt),
      });

      setDeployStage('Confirm in your wallet...');
      txHash = await sendPrepared(prepared);

      setDeployStage(`Waiting for ${CONFIRMATIONS} confirmations...`);
      const receipt = await waitForConfirmations(rpcClient, txHash, {
        confirmations: CONFIRMATIONS,
        timeoutMs: RECEIPT_TIMEOUT_MS,
        onProgress: (p) =>
          setDeployStage(p.stage === 'pending' ? 'Waiting to be mined...' : `Confirmations: ${Math.min(p.confirmations, CONFIRMATIONS)}/${CONFIRMATIONS}`),
      });
      if (!receiptSucceeded(receipt)) throw new Error(`Creation transaction ${txHash} reverted on chain. Nothing was saved.`);
      const created = walletCreatedFromLogs(receipt.logs, deployment.factory);
      if (created.wallet !== predicted) {
        throw new Error(`The factory created ${created.wallet}, not the predicted ${predicted}. Nothing was saved.`);
      }

      setDeployStage('Verifying the new vault on chain...');
      const vault = await assertVaultAuthentic(rpcClient, created.wallet, deployment);
      assertVaultMatchesParams(vault, params);
      registerVerifiedVault(vault, vaultName.trim() || undefined);
      handleClose();
    } catch (err: any) {
      const message = err?.message || 'Creation failed.';
      const hash = err instanceof BroadcastError ? err.txHash : txHash;
      setDeployError(hash && !message.includes(hash) ? `${message} (transaction ${hash}; check the explorer before retrying)` : message);
    } finally {
      setIsDeploying(false);
      setDeployStage(null);
    }
  };

  const stepIndex = ['connect', 'owners', 'security', 'review'].indexOf(step);
  const back = (to: Step) => (
    <button
      onClick={() => setStep(to)}
      disabled={isDeploying}
      className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold flex items-center space-x-1.5 disabled:opacity-50"
    >
      <ArrowLeft className="w-3.5 h-3.5" />
      <span>Back</span>
    </button>
  );
  const next = (to: Step, enabled: boolean, onClick?: () => void) => (
    <button
      onClick={onClick ?? (() => setStep(to))}
      disabled={!enabled}
      className={`px-5 py-2 rounded-xl text-xs font-bold flex items-center space-x-1.5 ${
        enabled ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950' : 'bg-slate-800 text-slate-500 cursor-not-allowed'
      }`}
    >
      <span>Continue</span>
      <ArrowRight className="w-3.5 h-3.5" />
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-lg w-full p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto">
        <button onClick={handleClose} className="absolute top-4 right-4 p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors">
          <X className="w-5 h-5" />
        </button>

        <div className="flex items-center space-x-2 mb-2">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
            <Shield className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white">Create a New Vault</h3>
            <p className="text-xs text-slate-400">
              A SafeBuddy v2 vault on {NETWORK_CONFIG.name === 'mainnet' ? 'Quai Mainnet' : 'Quai Orchard Testnet'} (Cyprus-1)
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-1.5 mb-5 mt-3">
          {['Connect', 'Owners', 'Security', 'Review & Create'].map((label, i) => (
            <div key={label} className="flex-1 flex items-center">
              <div className={`h-1.5 flex-1 rounded-full ${i <= stepIndex ? 'bg-emerald-500' : 'bg-slate-800'}`} title={label} />
            </div>
          ))}
        </div>

        {(walletError || deployError) && (
          <div className="mb-4 bg-red-950/40 border border-red-800/50 rounded-xl p-3 text-xs text-red-300 flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{deployError || walletError}</span>
          </div>
        )}

        {step === 'connect' && (
          <div className="space-y-3 text-xs">
            {!CREATION_ALLOWED && (
              <div className="bg-amber-950/40 border border-amber-700/50 rounded-xl p-3 text-amber-200 leading-relaxed" data-testid="mainnet-gate">
                {MAINNET_GATE_MESSAGE}
              </div>
            )}
            {CREATION_ALLOWED && deploymentError && (
              <div className="bg-amber-950/40 border border-amber-700/50 rounded-xl p-3 text-amber-200 leading-relaxed" data-testid="deployment-missing">
                {deploymentError}
              </div>
            )}
            <p className="text-slate-400 leading-relaxed">
              A Quai wallet (Pelagus) creates the vault through the SafeBuddy factory. You choose the owners; the wallet that
              creates it does not have to be one.
            </p>
            {signer && !isOnExpectedChain && (
              <div className="bg-red-950/40 border border-red-800/50 rounded-xl p-3 text-red-300">
                Your wallet is on chain {walletChainId ?? 'unknown'}; this app is configured for {NETWORK_CONFIG.name} (chain {NETWORK_CONFIG.chainId}).
                Switch networks in your wallet first.
              </div>
            )}
            {signer ? (
              <div className="bg-emerald-950/40 border border-emerald-500/40 rounded-xl p-3 flex items-center justify-between">
                <div>
                  <div className="font-semibold text-slate-200">{signer.providerName} Connected</div>
                  <div className="font-mono text-[10px] text-slate-400">{signer.address}</div>
                </div>
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
              </div>
            ) : (
              <button
                onClick={connectEip1193}
                disabled={isConnecting}
                className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center space-x-2"
              >
                <Wallet className="w-3.5 h-3.5" />
                <span>{isConnecting ? 'Requesting Accounts...' : 'Connect Wallet'}</span>
              </button>
            )}
            {canStart && (
              <div className="grid grid-cols-2 gap-2 pt-1">
                {VAULT_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setOwners((prev) => (prev.length === 1 && !prev[0] && signer ? [signer.address] : prev));
                      applyPreset(p.id);
                    }}
                    className="text-left bg-slate-950 border border-slate-800 hover:border-emerald-600 rounded-xl p-2.5"
                  >
                    <div className="font-semibold text-slate-200">{p.label}</div>
                    <div className="text-[10px] text-slate-500">{p.description}</div>
                  </button>
                ))}
              </div>
            )}
            <div className="flex justify-end pt-2">{next('owners', canStart, goToOwnersStep)}</div>
          </div>
        )}

        {step === 'owners' && (
          <div className="space-y-3 text-xs">
            <label className="block text-slate-300 font-semibold">Vault Name (optional, stored only in this browser)</label>
            <input
              type="text"
              placeholder="e.g. Treasury Vault"
              value={vaultName}
              maxLength={64}
              onChange={(e) => setVaultName(e.target.value)}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 text-xs"
            />
            <label className="block text-slate-300 font-semibold pt-1">Owners (Cyprus-1 Quai addresses, up to {VAULT_LIMITS.MAX_OWNERS})</label>
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {owners.map((owner, idx) => {
                const problem = owner.trim() ? ownerProblem(owner.trim()) : null;
                const isDup = owner.trim() && lowerOwners.filter((o) => o === owner.trim().toLowerCase()).length > 1;
                return (
                  <div key={idx} className="flex items-center space-x-2">
                    <input
                      type="text"
                      placeholder="0x00..."
                      value={owner}
                      onChange={(e) => setOwners((prev) => prev.map((o, i) => (i === idx ? e.target.value : o)))}
                      className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 font-mono text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 text-xs"
                    />
                    {owner.trim() &&
                      (!problem && !isDup ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                      ) : (
                        <span title={isDup ? 'Duplicate owner' : problem ?? ''}>
                          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                        </span>
                      ))}
                    {owners.length > 1 && (
                      <button onClick={() => setOwners((prev) => prev.filter((_, i) => i !== idx))} className="p-1.5 text-slate-500 hover:text-red-400">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {owners.map((o) => (o.trim() ? ownerProblem(o.trim()) : null)).find(Boolean) && (
              <p className="text-red-400 text-[11px]">{owners.map((o) => (o.trim() ? ownerProblem(o.trim()) : null)).find(Boolean)}</p>
            )}
            {owners.length < VAULT_LIMITS.MAX_OWNERS && (
              <button onClick={() => setOwners((prev) => [...prev, ''])} className="text-emerald-400 hover:text-emerald-300 font-semibold flex items-center space-x-1">
                <Plus className="w-3.5 h-3.5" />
                <span>Add owner</span>
              </button>
            )}
            {hasDuplicates && <p className="text-red-400 text-[11px]">Owner addresses must be unique.</p>}
            <div className="flex justify-between pt-2">
              {back('connect')}
              {next('security', allOwnersValid, () => {
                setThreshold((t) => Math.min(Math.max(1, t), trimmedOwners.length || 1));
                setStep('security');
              })}
            </div>
          </div>
        )}

        {step === 'security' && (
          <div className="space-y-4 text-xs">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">
                Approvals needed ({threshold} of {trimmedOwners.length})
              </label>
              <input
                type="range"
                min={1}
                max={Math.max(1, trimmedOwners.length)}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </div>
            <div>
              <label className="block text-slate-300 font-semibold mb-1">Timelock after quorum (hours, up to 720)</label>
              <input
                type="number"
                min={0}
                max={720}
                step="any"
                value={delayHours}
                onChange={(e) => setDelayHours(e.target.value)}
                className="w-40 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 font-mono text-slate-200"
                data-testid="delay-hours"
              />
              <p className="text-slate-500 mt-1">
                Approved transactions wait this long before anyone can execute them, so owners can spot and cancel a bad one.
                Admin changes (owners, threshold, delay) are not delayed.
              </p>
            </div>
            <div className={`border rounded-xl p-3 ${GRADE_STYLE[assessment.grade]}`} data-testid="config-grade">
              <div className="font-bold mb-1">Configuration grade {assessment.grade}</div>
              {assessment.notes.map((n) => (
                <div key={n}>{n}</div>
              ))}
            </div>
            <div className="flex justify-between pt-2">
              {back('owners')}
              {next('review', delayValid)}
            </div>
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-3 text-xs">
            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 space-y-2">
              <div className="flex justify-between">
                <span className="text-slate-400">Name</span>
                <span className="text-slate-200 font-semibold">{vaultName.trim() || '(unnamed)'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Network</span>
                <span className="text-slate-200 font-mono">
                  {NETWORK_CONFIG.name} ({NETWORK_CONFIG.chainId})
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Approvals needed</span>
                <span className="text-slate-200 font-semibold">
                  {threshold} of {trimmedOwners.length}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Timelock</span>
                <span className="text-slate-200 font-semibold">{delaySeconds ? formatDuration(delaySeconds) : 'none'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Grade</span>
                <span className="text-slate-200 font-semibold">{assessment.grade}</span>
              </div>
              <div>
                <span className="text-slate-400 block mb-1">Owners</span>
                <div className="space-y-1.5">
                  {trimmedOwners.map((o) => (
                    <AddressLine key={o} address={getAddress(o)} />
                  ))}
                </div>
              </div>
              {deployment && (
                <div>
                  <span className="text-slate-400 block mb-1">Factory (verified against the pinned build)</span>
                  <AddressLine address={deployment.factory} />
                </div>
              )}
            </div>

            <div className="bg-amber-950/30 border border-amber-800/40 rounded-xl p-2.5 text-[11px] text-amber-300 space-y-1">
              <p>
                Creating sends a real transaction from your wallet and costs gas. It is simulated first and nothing is sent if the
                simulation fails.
              </p>
              <p>
                The vault is saved only after {CONFIRMATIONS} confirmations and an on-chain check that it is a genuine factory vault
                with exactly these owners, threshold and timelock.
              </p>
            </div>

            <div className="flex justify-between pt-2">
              {back('security')}
              <button
                onClick={handleCreate}
                disabled={isDeploying || !CREATION_ALLOWED || !isOnExpectedChain || !deployment}
                className="px-5 py-2 rounded-xl text-xs font-bold bg-emerald-500 hover:bg-emerald-400 text-slate-950 flex items-center space-x-1.5 disabled:opacity-60"
              >
                {isDeploying && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                <span>{isDeploying ? deployStage || 'Creating...' : 'Create Vault'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
