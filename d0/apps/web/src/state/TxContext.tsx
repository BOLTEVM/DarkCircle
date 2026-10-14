import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, CircleDashed, ExternalLink, Loader2, XCircle } from 'lucide-react';
import {
  BroadcastError,
  ChainMismatchError,
  SimulationError,
  assertWalletOnChain,
  explorerTxUrl,
  prepareTransaction,
  receiptSucceeded,
  sendPrepared,
  waitForConfirmations,
  type TxDraft,
} from '@darkorder/core';
import { Button, Modal, Notice } from '../components/primitives.js';
import { useNetwork } from './NetworkContext.js';
import { useWallet } from './WalletContext.js';

/** Pages listen for this to re-read chain state after a confirmed transaction. */
export const CHAIN_CHANGED_EVENT = 'darkorder:chain-changed';

export function announceChainChanged(): void {
  window.dispatchEvent(new CustomEvent(CHAIN_CHANGED_EVENT));
}

export interface TxStep {
  label: string;
  /** Built at run time, so a later step can depend on an earlier one having confirmed. `from` is filled in by the runner. */
  build: () => Omit<TxDraft, 'from'> | Promise<Omit<TxDraft, 'from'>>;
}

type Phase = 'waiting' | 'simulating' | 'signing' | 'confirming' | 'done' | 'failed' | 'skipped';

interface StepState {
  label: string;
  phase: Phase;
  hash?: string;
  confirmations?: number;
  error?: string;
}

interface TxRun {
  title: string;
  steps: StepState[];
  busy: boolean;
  outcome: 'running' | 'ok' | 'failed';
}

interface TxApi {
  /** Runs the steps in order through the user's wallet. Resolves the last hash only if every step confirmed. */
  run: (title: string, steps: TxStep[]) => Promise<string | null>;
}

const Ctx = createContext<TxApi | null>(null);

export const TxProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { network, rpc, deployment } = useNetwork();
  const { wallet, address, addressProblem } = useWallet();
  const [runState, setRunState] = useState<TxRun | null>(null);
  const abort = useRef<AbortController | null>(null);

  const patch = (i: number, s: Partial<StepState>) =>
    setRunState((r) => (r ? { ...r, steps: r.steps.map((st, j) => (j === i ? { ...st, ...s } : st)) } : r));

  const run = useCallback(
    async (title: string, steps: TxStep[]): Promise<string | null> => {
      setRunState({ title, busy: true, outcome: 'running', steps: steps.map((s) => ({ label: s.label, phase: 'waiting' })) });
      const fail = (i: number, message: string) => {
        patch(i, { phase: 'failed', error: message });
        for (let j = i + 1; j < steps.length; j++) patch(j, { phase: 'skipped' });
        setRunState((r) => (r ? { ...r, busy: false, outcome: 'failed' } : r));
        return null;
      };

      // Defence in depth: the pages never offer actions in these states, and neither does this.
      if (!deployment) return fail(0, 'The DarkOrder protocol is not deployed on this network; nothing can be sent.');
      if (!wallet || !address) return fail(0, 'Connect your wallet first.');
      if (addressProblem) return fail(0, addressProblem);

      abort.current = new AbortController();
      let lastHash: string | null = null;
      for (let i = 0; i < steps.length; i++) {
        let hash: string | undefined;
        try {
          patch(i, { phase: 'simulating' });
          await assertWalletOnChain(wallet.provider, network.chainId);
          const step = steps[i];
          if (!step) throw new Error('missing step');
          const tx = await step.build();
          const prepared = await prepareTransaction(rpc, network, { from: address, ...tx });
          patch(i, { phase: 'signing' });
          hash = await sendPrepared(wallet.provider, prepared, wallet.namespace);
          lastHash = hash;
          patch(i, { phase: 'confirming', hash, confirmations: 0 });
          const receipt = await waitForConfirmations(rpc, hash, {
            confirmations: network.confirmations,
            timeoutMs: 15 * 60_000,
            signal: abort.current.signal,
            onProgress: (p) => patch(i, { confirmations: p.confirmations }),
          });
          if (!receiptSucceeded(receipt)) return fail(i, 'The transaction was mined but reverted. Its gas was spent; nothing else changed.');
          patch(i, { phase: 'done' });
        } catch (e) {
          const err = e as Error & { code?: number };
          const message =
            err instanceof SimulationError || err instanceof ChainMismatchError || err instanceof BroadcastError
              ? err.message
              : err?.code === 4001 || /reject|denied|cancel/i.test(err?.message ?? '')
                ? 'You declined the request in your wallet. Nothing was sent.'
                : (err?.message ?? String(e));
          if (hash) patch(i, { hash });
          announceChainChanged();
          return fail(i, message);
        }
      }
      setRunState((r) => (r ? { ...r, busy: false, outcome: 'ok' } : r));
      announceChainChanged();
      return lastHash;
    },
    [deployment, wallet, address, addressProblem, network, rpc]
  );

  const close = () => {
    if (runState?.busy) return;
    setRunState(null);
  };

  return (
    <Ctx.Provider value={{ run }}>
      {children}
      <Modal open={runState !== null} onClose={close} title={runState?.title ?? ''} locked={runState?.busy ?? false} width="md">
        {runState && (
          <div className="space-y-4">
            <ol className="space-y-3">
              {runState.steps.map((s, i) => (
                <li key={i} className="flex gap-3 rounded-lg border border-line bg-ink-deep px-4 py-3">
                  <StepIcon phase={s.phase} />
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="text-bone">{s.label}</div>
                    <div className="mt-0.5 text-xs text-bone-mute">{phaseText(s, network.confirmations)}</div>
                    {s.error && <div className="mt-1.5 text-xs leading-relaxed text-rose-300">{s.error}</div>}
                    {s.hash && (
                      <div className="mt-1.5 flex items-center gap-2 font-mono text-[11px] text-bone-dim">
                        <span className="truncate">{s.hash}</span>
                        {explorerTxUrl(network, s.hash) && (
                          <a
                            href={explorerTxUrl(network, s.hash)!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="shrink-0 text-gold hover:text-gold-light"
                            aria-label="Open in explorer"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            {runState.busy && (
              <Notice tone="gold">
                Keep this page open. On Quai a transaction that fails is charged its whole gas limit, so each step is simulated before your wallet is asked to
                sign.
              </Notice>
            )}
            {!runState.busy && (
              <div className="flex justify-end">
                <Button variant={runState.outcome === 'ok' ? 'primary' : 'secondary'} onClick={close}>
                  {runState.outcome === 'ok' ? 'Done' : 'Close'}
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </Ctx.Provider>
  );
};

function StepIcon({ phase }: { phase: Phase }) {
  if (phase === 'done') return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" aria-label="Confirmed" />;
  if (phase === 'failed') return <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" aria-label="Failed" />;
  if (phase === 'waiting' || phase === 'skipped') return <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-bone-mute" aria-label={phase} />;
  return <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-gold" aria-label="In progress" />;
}

function phaseText(s: StepState, needed: number): string {
  switch (s.phase) {
    case 'waiting':
      return 'Waiting for the previous step.';
    case 'simulating':
      return 'Checking your wallet network and simulating on chain…';
    case 'signing':
      return 'Approve it in your wallet.';
    case 'confirming':
      return `Sent. Confirmations ${Math.min(s.confirmations ?? 0, needed)} of ${needed}…`;
    case 'done':
      return 'Confirmed.';
    case 'failed':
      return s.hash ? 'Stopped after sending: check the explorer before retrying.' : 'Stopped before anything was sent.';
    case 'skipped':
      return 'Not attempted.';
  }
}

export function useTx(): TxApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTx must be used inside TxProvider');
  return v;
}
