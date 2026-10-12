import React, { useEffect, useMemo, useState } from 'react';
import { formatUnits } from 'ethers';
import { X, ShieldAlert, ShieldCheck, AlertTriangle, AlertCircle, Loader2, Copy, Check, ExternalLink, Info } from 'lucide-react';
import {
  ProposalDraft,
  TransactionReview,
  DecodedCall,
  RiskFlag,
  TokenInfo,
  CallSimulation,
  CYPRUS1_TOKENS,
  decodeVaultCall,
  describeRisk,
  highestRisk,
  vaultWillReject,
  summarizeCall,
  confirmationChallenge,
  challengeSatisfied,
  transactionActions,
  estimatedChainNow,
  simulateVaultCall,
  readTokenInfo,
  readTransactionStatus,
  codeAt,
  computeVaultTxHash,
  formatDuration,
  formatUtc,
} from '@darksafe/core';
import { useSafe, ActionKind, ActionResult } from '../../context/SafeContext.js';
import { useWallet } from '../../context/WalletContext.js';
import { resolveWebNetworkConfig } from '../../config/network.js';
import { AddressLine } from '../AddressLine.js';

const NETWORK_CONFIG = resolveWebNetworkConfig();

export type ReviewTarget = { mode: 'propose'; draft: ProposalDraft } | { mode: 'existing'; hash: string; nonce: number };

interface Props {
  target: ReviewTarget | null;
  onClose: () => void;
}

const LEVEL_STYLE: Record<RiskFlag['level'], string> = {
  critical: 'bg-red-950/60 border-red-700/70 text-red-200',
  high: 'bg-orange-950/50 border-orange-700/60 text-orange-200',
  medium: 'bg-amber-950/40 border-amber-700/50 text-amber-200',
  info: 'bg-slate-900 border-slate-700 text-slate-300',
};

function knownToken(address: string): TokenInfo | null {
  const hit = Object.values(CYPRUS1_TOKENS).find((t: any) => t.address && t.address.toLowerCase() === address.toLowerCase()) as
    | { symbol: string; decimals: number }
    | undefined;
  return hit ? { symbol: hit.symbol, decimals: hit.decimals } : null;
}

/** The address that receives funds or rights in this call, for first-time and contract checks. */
function counterparty(d: DecodedCall): string | null {
  if (d.kind === 'native-transfer') return d.to;
  if (d.kind === 'erc20-transfer') return d.recipient;
  if (d.kind === 'erc20-approve') return d.spender;
  return null;
}

export const TransactionReviewModal: React.FC<Props> = ({ target, onClose }) => {
  const { safeState, rpcClient, clock, knownRecipients, labelFor, saveAddress, reviewTransaction, proposeDraft, runAction, progress, writeBlockReason } =
    useSafe();
  const { signer } = useWallet();

  const [review, setReview] = useState<TransactionReview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [recipientIsContract, setRecipientIsContract] = useState<boolean | null>(null);
  const [cancellable, setCancellable] = useState<Set<string> | undefined>(undefined);
  const [simulation, setSimulation] = useState<CallSimulation | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [saveLabel, setSaveLabel] = useState('');

  const vault = safeState.address;
  const tx = target?.mode === 'existing' ? review?.tx ?? null : null;
  const fields = target?.mode === 'propose' ? target.draft : tx;

  const decoded: DecodedCall | null = useMemo(() => {
    if (!fields || !vault) return null;
    if (target?.mode === 'existing') return review?.decoded ?? null;
    return decodeVaultCall({ vault, to: fields.to, value: fields.value, data: fields.data });
  }, [fields, vault, target, review]);

  // Load the review (existing) and the facts the risk rules need.
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setReview(null);
    setLoadError(null);
    setResult(null);
    setActionError(null);
    setTyped('');
    setSimulation(null);
    if (target.mode === 'existing') {
      reviewTransaction(target.hash, target.nonce)
        .then((r) => !cancelled && setReview(r))
        .catch((err) => !cancelled && setLoadError(err?.message ?? String(err)));
    }
    return () => {
      cancelled = true;
    };
  }, [target, reviewTransaction]);

  useEffect(() => {
    if (!decoded || !fields || !vault) return;
    let cancelled = false;
    const party = counterparty(decoded);
    setRecipientIsContract(null);
    setToken(null);
    setCancellable(undefined);
    if (party) codeAt(rpcClient, party).then((c) => !cancelled && setRecipientIsContract(c !== '0x')).catch(() => undefined);
    if (decoded.kind === 'erc20-transfer' || decoded.kind === 'erc20-approve') {
      const known = knownToken(decoded.token);
      if (known) setToken(known);
      else readTokenInfo(rpcClient, decoded.token).then((t) => !cancelled && setToken(t));
    }
    if (decoded.kind === 'admin' && decoded.call.fn === 'cancelByConsensus') {
      const targetHash = decoded.call.txHash;
      readTransactionStatus(rpcClient, vault, targetHash)
        .then((s) => !cancelled && setCancellable(['Pending', 'Timelocked', 'Executable', 'Expired'].includes(s) ? new Set([targetHash]) : new Set()))
        .catch(() => undefined);
    }
    const self = fields.to.toLowerCase() === vault.toLowerCase();
    if (target?.mode === 'propose' || (tx && !tx.executed && !tx.cancelled)) {
      simulateVaultCall(rpcClient, { vault, to: fields.to, value: self ? 0n : fields.value, data: fields.data, gasLimit: self ? undefined : fields.gasLimit })
        .then((s) => !cancelled && setSimulation(s))
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [decoded, fields, vault, rpcClient, target, tx]);

  if (!target) return null;

  const snapshotForRisk = review?.vault.snapshot ?? {
    owners: safeState.owners,
    threshold: safeState.threshold,
    minExecutionDelay: safeState.minExecutionDelay,
    balance: safeState.balance ?? undefined,
  };
  const risks: RiskFlag[] = decoded
    ? describeRisk(decoded, {
        vault,
        owners: snapshotForRisk.owners,
        threshold: snapshotForRisk.threshold,
        minExecutionDelay: snapshotForRisk.minExecutionDelay,
        balance: snapshotForRisk.balance ?? undefined,
        knownRecipients,
        recipientIsContract,
        cancellableTransactions: cancellable,
      })
    : [];
  const level = highestRisk(risks);
  const challenge = decoded ? confirmationChallenge(decoded) : null;
  const challengeOk = challengeSatisfied(challenge, typed);
  const isSelf = fields ? fields.to.toLowerCase() === vault.toLowerCase() : false;
  const effectiveDelay = fields
    ? target.mode === 'propose'
      ? isSelf
        ? 0
        : Math.max(safeState.minExecutionDelay, target.draft.requestedDelay)
      : (fields as any).executionDelay ?? 0
    : 0;
  const expectedHash =
    target.mode === 'propose' && fields
      ? computeVaultTxHash({
          vault,
          chainId: NETWORK_CONFIG.chainId,
          to: fields.to,
          value: fields.value,
          data: fields.data,
          gasLimit: fields.gasLimit,
          expiration: fields.expiration,
          executionDelay: effectiveDelay,
          nonce: safeState.txNonce,
        })
      : review?.tx.hash ?? null;
  const party = decoded ? counterparty(decoded) : null;
  const chainNow = clock ? estimatedChainNow(clock) : Math.floor(Date.now() / 1000);
  const actions = review && tx ? transactionActions(tx, review.vault.snapshot, signer?.address ?? null, chainNow) : null;
  const verificationBlocks = target.mode === 'existing' && (!review || review.agreement === 'disagreement');

  const run = async (kind: ActionKind | 'propose') => {
    setBusy(true);
    setActionError(null);
    try {
      const r = kind === 'propose' ? await proposeDraft((target as { draft: ProposalDraft }).draft) : await runAction(kind, target.mode === 'existing' ? target.hash : '', target.mode === 'existing' ? target.nonce : 0);
      setResult(r);
    } catch (err: any) {
      setActionError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const needsChallenge = (kind: ActionKind | 'propose') => challenge !== null && (kind === 'propose' || kind === 'approve' || kind === 'execute');
  const button = (kind: ActionKind | 'propose', label: string, primary = false) => {
    const blocked = Boolean(kind === 'expire' ? false : writeBlockReason) || verificationBlocks || (needsChallenge(kind) && !challengeOk) || busy;
    return (
      <button
        key={kind}
        onClick={() => run(kind)}
        disabled={blocked}
        data-testid={`action-${kind}`}
        className={`px-4 py-2 rounded-xl text-xs font-bold disabled:opacity-40 disabled:cursor-not-allowed ${
          primary ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950' : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
        }`}
      >
        {busy && progress ? progress.stage : label}
      </button>
    );
  };

  const copyHash = () => {
    if (!expectedHash) return;
    navigator.clipboard?.writeText(expectedHash);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl max-w-2xl w-full max-h-[92vh] overflow-y-auto p-6 shadow-2xl relative text-xs">
        <button onClick={onClose} disabled={busy} className="absolute top-4 right-4 p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800">
          <X className="w-5 h-5" />
        </button>
        <h3 className="text-base font-bold text-white mb-1">{target.mode === 'propose' ? 'Review before proposing' : 'Review transaction'}</h3>
        <p className="text-slate-400 mb-4">
          Your wallet will only show a call to the vault. Everything that matters is here: check it, and compare the digest with
          the other owners or with <span className="font-mono">darksafe-verify</span>.
        </p>

        {loadError && (
          <div className="mb-4 bg-red-950/60 border border-red-700 rounded-xl p-3 text-red-200 flex items-start space-x-2" data-testid="review-error">
            <ShieldAlert className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              <strong>Verification failed.</strong> {loadError}
            </span>
          </div>
        )}
        {target.mode === 'existing' && !review && !loadError && (
          <div className="flex items-center space-x-2 text-slate-400 mb-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Reading and cross-checking the transaction...</span>
          </div>
        )}

        {review && (
          <div
            data-testid="review-agreement"
            className={`mb-4 rounded-xl p-3 border flex items-start space-x-2 ${
              review.agreement === 'agreed'
                ? 'bg-emerald-950/40 border-emerald-700/50 text-emerald-200'
                : review.agreement === 'single-source'
                  ? 'bg-amber-950/40 border-amber-700/50 text-amber-200'
                  : 'bg-red-950/60 border-red-700 text-red-200'
            }`}
          >
            {review.agreement === 'disagreement' ? <ShieldAlert className="w-4 h-4 mt-0.5" /> : <ShieldCheck className="w-4 h-4 mt-0.5" />}
            <div>
              <div className="font-semibold">
                {review.agreement === 'agreed'
                  ? `Hash re-derived from its contents; ${review.reports.filter((r) => r.outcome === 'ok').length} independent sources agree at block ${review.block}.`
                  : review.agreement === 'single-source'
                    ? `Hash re-derived from its contents, but only one source could be checked (block ${review.block}).`
                    : 'Sources disagree about this transaction. Do not act on it.'}
              </div>
              {review.problems.map((p) => (
                <div key={p} className="text-[11px] opacity-90">
                  {p}
                </div>
              ))}
            </div>
          </div>
        )}

        {decoded && fields && (
          <>
            {level === 'critical' && (
              <div className="mb-3 bg-red-950/70 border-2 border-red-600 rounded-xl p-3 text-red-100 font-semibold flex items-start space-x-2" data-testid="critical-banner">
                <AlertTriangle className="w-5 h-5 flex-shrink-0 text-red-400" />
                <span>{summarizeCall(decoded, token ?? undefined)}. Read every line below before continuing.</span>
              </div>
            )}
            {level !== 'critical' && <div className="mb-3 text-sm font-semibold text-white">{summarizeCall(decoded, token ?? undefined)}</div>}

            <div className="space-y-2 mb-3" data-testid="risk-flags">
              {risks.map((r) => (
                <div key={r.code} className={`border rounded-lg px-2.5 py-1.5 ${LEVEL_STYLE[r.level]}`}>
                  <span className="font-bold uppercase text-[9px] mr-1.5">{r.level}</span>
                  {r.message}
                </div>
              ))}
              {vaultWillReject(risks) && (
                <div className="border rounded-lg px-2.5 py-1.5 bg-red-950/60 border-red-700 text-red-200">The vault will reject this as it stands.</div>
              )}
            </div>

            <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-3 space-y-3 mb-3">
              <div>
                <div className="text-slate-500 mb-0.5">Destination{isSelf ? ' (this vault: an admin change)' : ''}</div>
                <AddressLine address={fields.to} label={labelFor(fields.to)} testId="review-to" />
              </div>
              {party && party.toLowerCase() !== fields.to.toLowerCase() && (
                <div>
                  <div className="text-slate-500 mb-0.5">{decoded.kind === 'erc20-approve' ? 'Spender' : 'Recipient'}</div>
                  <AddressLine address={party} label={labelFor(party)} />
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-slate-500 mb-0.5">QUAI sent</div>
                  <div className="font-mono text-slate-100">{formatUnits(fields.value, 18)} QUAI</div>
                  <div className="font-mono text-[10px] text-slate-500">{fields.value.toString()} wei</div>
                </div>
                {(decoded.kind === 'erc20-transfer' || decoded.kind === 'erc20-approve') && (
                  <div>
                    <div className="text-slate-500 mb-0.5">Token amount</div>
                    <div className="font-mono text-slate-100">
                      {decoded.kind === 'erc20-approve' && decoded.unlimited ? 'Unlimited' : token ? `${formatUnits(decoded.amount, token.decimals)} ${token.symbol}` : 'unknown token'}
                    </div>
                    <div className="font-mono text-[10px] text-slate-500">{decoded.amount.toString()} base units</div>
                  </div>
                )}
                <div>
                  <div className="text-slate-500 mb-0.5">Timelock after quorum</div>
                  <div className="text-slate-100">{effectiveDelay ? formatDuration(effectiveDelay) : 'none'}</div>
                </div>
                <div>
                  <div className="text-slate-500 mb-0.5">Expires</div>
                  <div className="text-slate-100">{formatUtc(Number(fields.expiration))}</div>
                </div>
                {!isSelf && (
                  <div>
                    <div className="text-slate-500 mb-0.5">Gas committed to the call</div>
                    <div className="font-mono text-slate-100">{fields.gasLimit.toString()}</div>
                  </div>
                )}
              </div>
              <div>
                <div className="text-slate-500 mb-0.5">
                  Calldata {fields.data !== '0x' ? `(selector ${fields.data.slice(0, 10)}, ${(fields.data.length - 2) / 2} bytes)` : '(none)'}
                </div>
                {fields.data !== '0x' && <div className="font-mono text-[10px] text-slate-300 break-all bg-slate-900 rounded p-2 max-h-24 overflow-y-auto">{fields.data}</div>}
              </div>
              {expectedHash && (
                <div>
                  <div className="text-slate-500 mb-0.5 flex items-center space-x-1">
                    <span>{target.mode === 'propose' ? 'Expected transaction hash (if no one else proposes first)' : 'Transaction hash'}</span>
                    <button onClick={copyHash} className="p-0.5 text-slate-400 hover:text-white" title="Copy">
                      {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </button>
                  </div>
                  <div className="font-mono text-[10px] text-slate-300 break-all">{expectedHash}</div>
                </div>
              )}
              {review && (
                <div>
                  <div className="text-slate-500 mb-0.5">Review digest (read it to the other owners)</div>
                  <div className="font-mono text-base text-emerald-300 tracking-wider" data-testid="review-digest">
                    {review.digestDisplay}
                  </div>
                </div>
              )}
            </div>

            {simulation && (
              <div
                className={`mb-3 rounded-lg px-2.5 py-1.5 border ${simulation.ok ? 'bg-slate-900 border-slate-700 text-slate-300' : 'bg-red-950/50 border-red-700 text-red-200'}`}
                data-testid="simulation"
              >
                {simulation.ok
                  ? 'Simulated against the latest block: the call succeeds right now.'
                  : `Simulated against the latest block: the call would fail right now (${simulation.reason}).${
                      target.mode === 'existing' ? ' Executing it would close the transaction as failed.' : ''
                    }`}
              </div>
            )}

            {tx && (
              <div className="mb-3 bg-slate-950/60 border border-slate-800 rounded-xl p-3">
                <div className="flex justify-between mb-1.5">
                  <span className="text-slate-400">
                    Status <strong className="text-slate-100">{tx.status}</strong>
                  </span>
                  <span className="text-slate-400">
                    Approvals {tx.approvals.length}/{review!.vault.snapshot.threshold}
                  </span>
                </div>
                {actions?.executableAfter && tx.status === 'Timelocked' && (
                  <div className="text-slate-400 mb-1.5">
                    Executable from {formatUtc(actions.executableAfter)} (chain time), in about {formatDuration(actions.executableAfter - chainNow)}.
                  </div>
                )}
                <div className="grid grid-cols-1 gap-1">
                  {review!.vault.snapshot.owners.map((o) => {
                    const ok = tx.approvals.some((a) => a.toLowerCase() === o.toLowerCase());
                    return (
                      <div key={o} className={`flex items-center space-x-2 ${ok ? 'text-emerald-300' : 'text-slate-500'}`}>
                        <span>{ok ? '✓' : '○'}</span>
                        <span className="font-mono text-[10px]">{o}</span>
                        {labelFor(o) && <span className="text-[10px]">({labelFor(o)})</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {party && !labelFor(party) && party.toLowerCase() !== vault.toLowerCase() && (
              <div className="mb-3 flex items-center space-x-2">
                <input
                  value={saveLabel}
                  onChange={(e) => setSaveLabel(e.target.value)}
                  placeholder="Label to save this address (optional)"
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-slate-200"
                />
                <button
                  onClick={() => {
                    saveAddress(party, saveLabel);
                    setSaveLabel('');
                  }}
                  disabled={!saveLabel.trim()}
                  className="px-3 py-1.5 bg-slate-800 rounded-lg text-slate-200 disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            )}

            {challenge && !result && (
              <div className="mb-3 bg-red-950/40 border border-red-800 rounded-xl p-3" data-testid="challenge">
                <label className="block text-red-200 mb-1.5">{challenge.prompt}</label>
                <input
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  className="w-full bg-slate-950 border border-red-800 rounded-lg px-2 py-1.5 font-mono text-slate-100"
                  data-testid="challenge-input"
                />
              </div>
            )}
          </>
        )}

        {actionError && (
          <div className="mb-3 bg-red-950/50 border border-red-800 rounded-xl p-3 text-red-200 flex items-start space-x-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{actionError}</span>
          </div>
        )}
        {result && (
          <div className="mb-3 bg-emerald-950/50 border border-emerald-700 rounded-xl p-3 text-emerald-200 space-y-1" data-testid="action-result">
            <div className="font-semibold">{result.outcome}.</div>
            <a
              href={`${NETWORK_CONFIG.explorerUrl}/tx/${result.chainTxHash}`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center space-x-1 underline font-mono break-all"
            >
              <span>{result.chainTxHash}</span>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
        {writeBlockReason && !result && (
          <div className="mb-3 text-slate-400 flex items-center space-x-1.5">
            <Info className="w-3.5 h-3.5" />
            <span>{writeBlockReason}</span>
          </div>
        )}

        {!result && (
          <div className="flex flex-wrap justify-end gap-2">
            {target.mode === 'propose' && button('propose', 'Propose and approve', true)}
            {actions?.canApprove && button('approve', 'Approve', true)}
            {actions?.needsClockStart && button('execute', 'Start timelock', true)}
            {actions?.canExecute && button('execute', 'Execute', true)}
            {actions?.canRevoke && button('revoke', 'Revoke my approval')}
            {actions?.canCancel && button('cancel', 'Cancel')}
            {actions?.canExpire && button('expire', 'Mark expired')}
          </div>
        )}
      </div>
    </div>
  );
};
