import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, CheckCircle2 } from 'lucide-react';
import {
  erc20Tx,
  farmTx,
  formatUnits,
  getAllowance,
  tryParseUnits,
  type FarmRow,
  type FarmState
} from 'quai-service';
import { AddrLink, Field, Modal, Notice, Spinner, input, muted, smallBtn } from './ui';
import { describeTxError, sendContractCall } from './farmSend';

export interface RewardLabels {
  a: { symbol: string; decimals: number };
  b: { symbol: string; decimals: number };
}

interface Props {
  mode: 'stake' | 'unstake';
  row: FarmRow;
  farm: FarmState;
  wallet: string;
  rewards: RewardLabels;
  onClose: () => void;
  /** Called after a transaction confirmed, so the page re-reads the farm. */
  onDone: () => void;
  /** Opens the add-liquidity dialog: how a wallet gets the pool tokens of a pair. */
  onGetLp?: () => void;
  /** Opens the swap tab: how a wallet gets a single token (Q0, BDELTA) to deposit. */
  onGetToken?: () => void;
}

type Step = 'IDLE' | 'APPROVING' | 'SENDING' | 'DONE';

export default function FarmActionModal({ mode, row, farm, wallet, rewards, onClose, onDone, onGetLp, onGetToken }: Props) {
  const stake = mode === 'stake';
  const position = row.position;
  const decimals = row.stakeDecimals;
  const max = stake ? position?.walletBalance ?? 0n : position?.staked ?? 0n;
  const symbol = row.kind === 'LP' ? `${row.label} pool tokens` : row.label;
  // A single token whose decimals the contract did not answer cannot be sized safely: no amount is parsed or sent.
  const decimalsKnown = row.stakeDecimalsKnown;

  const [text, setText] = useState('');
  const [step, setStep] = useState<Step>('IDLE');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [feeNote, setFeeNote] = useState<string | null>(null);
  const [emergency, setEmergency] = useState(false);
  const [emergencyAck, setEmergencyAck] = useState(false);

  const amount = useMemo(() => tryParseUnits(text, decimals), [text, decimals]);
  const busy = step === 'APPROVING' || step === 'SENDING';
  const tooMuch = amount !== null && amount > max;
  const valid = decimalsKnown && amount !== null && amount > 0n && !tooMuch;
  const paused = farm.paused;

  // Dust: an input with more places than the token has is refused rather than silently rounded.
  const placesError = text.trim() !== '' && amount === null ? `Enter a number with at most ${decimals} decimal places.` : null;

  useEffect(() => {
    setError(null);
  }, [text, emergency]);

  const unfunded = farm.inventoryA.available === 0n || farm.inventoryB.available === 0n;

  const run = async () => {
    if (!valid || amount === null) return;
    setError(null);
    setTxHash(null);
    try {
      if (stake) {
        // Read the allowance at signing time, not from the page's last refresh: it may have changed.
        const allowance = await getAllowance(row.lpToken, wallet, farm.address);
        if (allowance < amount) {
          setStep('APPROVING');
          await sendContractCall(wallet, row.lpToken, erc20Tx.approve(farm.address, amount), { gasMultiplier: 1.5 });
        }
      }
      setStep('SENDING');
      const data = stake ? farmTx.deposit(row.pid, amount) : farmTx.withdraw(row.pid, amount);
      const res = await sendContractCall(wallet, farm.address, data, {
        gasMultiplier: 1.5,
        onPrepared: p => setFeeNote(`Network fee up to ${formatUnits(p.maxFee, 18, 4)} QUAI (unused gas is refunded).`),
        onSubmitted: setTxHash
      });
      setTxHash(res.txHash);
      setStep('DONE');
      setText('');
      onDone();
    } catch (e: any) {
      setError(describeTxError(e));
      setStep('IDLE');
    }
  };

  const runEmergency = async () => {
    setError(null);
    try {
      setStep('SENDING');
      const res = await sendContractCall(wallet, farm.address, farmTx.emergencyWithdraw(row.pid), {
        gasMultiplier: 1.5,
        onSubmitted: setTxHash
      });
      setTxHash(res.txHash);
      setStep('DONE');
      onDone();
    } catch (e: any) {
      setError(describeTxError(e));
      setStep('IDLE');
    }
  };

  const pendingA = position?.pendingA ?? 0n;
  const pendingB = position?.pendingB ?? 0n;
  const hasPending = pendingA > 0n || pendingB > 0n;

  return (
    <Modal
      title={`${stake ? 'Deposit' : 'Withdraw'} ${row.label}`}
      icon={stake ? <ArrowDownToLine size={18} style={{ color: 'var(--accent-neon)' }} /> : <ArrowUpFromLine size={18} style={{ color: 'var(--accent-plasma)' }} />}
      onClose={onClose}
      maxWidth={480}
      locked={busy}
    >
      {row.kind !== 'LP' && (
        <p style={{ ...muted, fontSize: '0.8rem', margin: '0 0 0.6rem' }}>
          Deposit {row.label} itself. You earn {rewards.a.symbol} + {rewards.b.symbol} for as long as it is deposited, and you can take your {row.label} back at any time.
        </p>
      )}
      {!decimalsKnown && (
        <Notice tone="danger">
          <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} />
          This token&apos;s contract did not say how many decimals it has, so an amount cannot be sized safely. Nothing is sent from here.
        </Notice>
      )}
      {stake && paused && (
        <Notice tone="warn">
          <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} />
          Deposits are paused. You can still withdraw.
        </Notice>
      )}

      <Field
        label={stake ? 'Amount to deposit' : 'Amount to withdraw'}
        hint={
          <>
            {stake ? 'In your wallet' : 'Deposited'}: <strong>{formatUnits(max, decimals, 6)}</strong> {symbol}
            {stake && max === 0n && onGetLp && row.kind === 'LP' && (
              <>
                {' '}
                &middot;{' '}
                <button type="button" style={{ ...smallBtn, padding: '0.1rem 0.45rem' }} onClick={onGetLp}>
                  Add to a pool first
                </button>
              </>
            )}
            {stake && max === 0n && onGetToken && row.kind !== 'LP' && (
              <>
                {' '}
                &middot;{' '}
                <button type="button" style={{ ...smallBtn, padding: '0.1rem 0.45rem' }} onClick={onGetToken}>
                  Get {row.label}
                </button>
              </>
            )}
          </>
        }
      >
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input
            style={{ ...input, flex: 1, fontFamily: 'monospace' }}
            inputMode="decimal"
            placeholder="0.0"
            value={text}
            disabled={busy || !decimalsKnown}
            onChange={e => setText(e.target.value)}
            aria-label="Amount"
          />
          <button type="button" style={smallBtn} disabled={busy || max === 0n || !decimalsKnown} onClick={() => setText(formatUnits(max, decimals, decimals))}>
            MAX
          </button>
        </div>
      </Field>
      {placesError && <Notice tone="danger">{placesError}</Notice>}
      {tooMuch && <Notice tone="danger">That is more than you {stake ? 'hold' : 'have deposited'}.</Notice>}

      {stake ? (
        <Notice tone="info">
          Depositing also pays out anything you have already earned here.
          {row.aprMax !== undefined && <> Holding QRB adds up to {Number(farm.boostBps) / 100}% to your rewards.</>}
        </Notice>
      ) : (
        <Notice tone="info">
          Withdrawing also pays what you have earned{hasPending ? <>: {formatUnits(pendingA, rewards.a.decimals, 4)} {rewards.a.symbol} + {formatUnits(pendingB, rewards.b.decimals, 4)} {rewards.b.symbol}</> : ''}. It works even while deposits are paused.
        </Notice>
      )}

      {unfunded && (
        <Notice tone="warn">
          The farm has {farm.inventoryA.available === 0n && farm.inventoryB.available === 0n ? 'no rewards to give out' : 'run out of one reward'} yet. What you earn is recorded and paid once it is topped up. Your deposit is never used to pay rewards.
        </Notice>
      )}

      {error && <Notice tone="danger"><AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} />{error}</Notice>}
      {feeNote && step === 'SENDING' && <p style={{ ...muted, fontSize: '0.75rem', marginBottom: '0.6rem' }}>{feeNote}</p>}
      {step === 'DONE' && txHash && (
        <Notice tone="ok">
          <CheckCircle2 size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} />
          Done: <AddrLink address={txHash} tx />
        </Notice>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '0.5rem' }}>
        <button type="button" style={smallBtn} onClick={onClose} disabled={busy}>
          {step === 'DONE' ? 'Close' : 'Cancel'}
        </button>
        <button type="button" className="btn-primary" disabled={!valid || busy || (stake && paused)} onClick={() => void run()}>
          {step === 'APPROVING' ? (
            <>
              <Spinner /> Approve in wallet…
            </>
          ) : step === 'SENDING' ? (
            <>
              <Spinner /> {stake ? 'Depositing…' : 'Withdrawing…'}
            </>
          ) : stake ? (
            'Deposit'
          ) : (
            'Withdraw'
          )}
        </button>
      </div>

      {!stake && (position?.staked ?? 0n) > 0n && (
        <details style={{ marginTop: '1rem' }} open={emergency} onToggle={e => setEmergency((e.target as HTMLDetailsElement).open)}>
          <summary style={{ cursor: 'pointer', fontSize: '0.8rem', color: 'var(--text-muted)' }}>Emergency exit (skip rewards)</summary>
          <div style={{ marginTop: '0.6rem' }}>
            <Notice tone="danger">
              Takes out your <strong>whole</strong> deposit right away and gives up <strong>all</strong> rewards in this pool
              {hasPending ? <>, including the {formatUnits(pendingA, rewards.a.decimals, 4)} {rewards.a.symbol} and {formatUnits(pendingB, rewards.b.decimals, 4)} {rewards.b.symbol} you have earned</> : ''}.
              Use it only if a normal withdrawal fails.
            </Notice>
            <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontSize: '0.8rem', marginBottom: '0.6rem' }}>
              <input type="checkbox" checked={emergencyAck} onChange={e => setEmergencyAck(e.target.checked)} disabled={busy} />
              I understand I give up my rewards.
            </label>
            <button type="button" className="btn-primary" style={{ background: 'var(--error)' }} disabled={!emergencyAck || busy} onClick={() => void runEmergency()}>
              Emergency withdraw
            </button>
          </div>
        </details>
      )}
    </Modal>
  );
}
