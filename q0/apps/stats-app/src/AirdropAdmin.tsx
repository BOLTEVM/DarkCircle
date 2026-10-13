import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CalendarClock, Download, Gift, RefreshCw, Upload } from 'lucide-react';
import {
  AIRDROP_DEFAULTS,
  AIRDROP_MIN_CLAIM_WINDOW_SECONDS,
  QUAINANCE_BDELTA_PAIR,
  TOKEN_REGISTRY,
  airdropTx,
  auditDistribution,
  buildDistribution,
  createBatch,
  erc20Tx,
  formatUnits,
  planAirdrop,
  readAirdropState,
  snapshotPool,
  tryParseUnits,
  type AirdropContractState,
  type StakePosition
} from 'quai-service';
import { AddrLink, Badge, Field, Notice, Spinner, box, input, muted, smallBtn } from './ui';
import { describeTxError, sendContractCall } from './farmSend';

/** The scheduled snapshot (.github/workflows/airdrop-snapshot.yml): 21 October 2026, 12:00 UTC. */
const NEXT_SNAPSHOT_MS = Date.UTC(2026, 9, 21, 12, 0, 0);
const CONTRACT_KEY = 'circleswap.airdrop.contract';

type Snap =
  | { status: 'idle' }
  | { status: 'running'; windows: number; found: number }
  | { status: 'error'; message: string }
  | {
      status: 'done';
      source: 'chain' | 'file';
      block: number | null;
      positions: StakePosition[];
      warnings: string[];
      complete: boolean;
    };

const fmt = (n: bigint, d = 2) => Number(formatUnits(n, 18, d)).toLocaleString('en-US', { maximumFractionDigits: d });
const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readStored(): string {
  try {
    return localStorage.getItem(CONTRACT_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * The Q0 + QAXE airdrop to BDELTA stakers on Quainance: take the snapshot (in the background, with progress), see exactly who
 * gets what, download the distribution file, and walk the contract steps (deposit, set the root once, sweep after the deadline).
 * Nothing here sends anything until a button is pressed and the wallet confirms.
 */
export default function AirdropAdmin({ wallet }: { wallet: string | null }) {
  const [totalAText, setTotalAText] = useState(formatUnits(AIRDROP_DEFAULTS.totalA, 18, 0));
  const [totalBText, setTotalBText] = useState(formatUnits(AIRDROP_DEFAULTS.totalB, 18, 0));
  const [thresholdText, setThresholdText] = useState(formatUnits(AIRDROP_DEFAULTS.thresholdWei, 18, 0));
  const [multiplierText, setMultiplierText] = useState('1.5');
  const [countBurned, setCountBurned] = useState(false);
  const [excludeText, setExcludeText] = useState('');
  const [snap, setSnap] = useState<Snap>({ status: 'idle' });
  const runId = useRef(0);

  const [contract, setContract] = useState(readStored);
  const [state, setState] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; value?: AirdropContractState; error?: string }>({ status: 'idle' });
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'ok' | 'danger' | 'warn' | 'info'; body: ReactNode } | null>(null);
  const [windowDays, setWindowDays] = useState('30');
  const [typedRoot, setTypedRoot] = useState('');

  const Q0 = TOKEN_REGISTRY.Q0;
  const QAXE = TOKEN_REGISTRY.QAXE;

  // ---- 1. snapshot, in the background ------------------------------------------------------------------------------------
  const take = useCallback(async () => {
    const id = ++runId.current;
    setSnap({ status: 'running', windows: 0, found: 0 });
    try {
      const s = await snapshotPool(TOKEN_REGISTRY.BDELTA.address, QUAINANCE_BDELTA_PAIR, {
        onProgress: (windows, found) => {
          if (runId.current === id) setSnap({ status: 'running', windows, found });
        }
      });
      if (runId.current !== id) return; // superseded or cancelled
      const warnings: string[] = [];
      if (!s.complete) warnings.push('The transfer history did not reach the pool’s first mint, so a burner may be missing.');
      for (const h of s.contractHolders) warnings.push(`${h} is a contract holding liquidity: whoever is behind it is not counted.`);
      for (const u of s.unattributed) warnings.push(u + '.');
      setSnap({ status: 'done', source: 'chain', block: s.block, positions: s.positions, warnings, complete: s.complete });
    } catch (e: any) {
      if (runId.current === id) setSnap({ status: 'error', message: e?.message || 'The snapshot failed.' });
    }
  }, []);

  const cancel = () => {
    runId.current++;
    setSnap({ status: 'idle' });
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const saved = JSON.parse(await file.text());
      if (!Array.isArray(saved.positions)) throw new Error('This is not a snapshot file (it has no positions).');
      const positions: StakePosition[] = saved.positions.map((p: any) => ({ account: String(p.account), held: BigInt(p.held), burned: BigInt(p.burned) }));
      runId.current++;
      setSnap({
        status: 'done',
        source: 'file',
        block: Number.isFinite(Number(saved.block)) ? Number(saved.block) : null,
        positions,
        warnings: Array.isArray(saved.warnings) ? saved.warnings.map(String) : [],
        complete: true
      });
    } catch (e: any) {
      setSnap({ status: 'error', message: `Could not read that file: ${e?.message ?? 'unreadable'}` });
    }
  };

  // ---- 2. the plan --------------------------------------------------------------------------------------------------------
  const params = useMemo(() => {
    const totalA = tryParseUnits(totalAText, 18);
    const totalB = tryParseUnits(totalBText, 18);
    const thresholdWei = tryParseUnits(thresholdText, 18);
    const m = Number(multiplierText);
    const burnerMultiplierBps = Number.isFinite(m) && m >= 1 && m <= 10 ? BigInt(Math.round(m * 10_000)) : null;
    const exclude = excludeText.split(/[\s,;]+/).filter(Boolean);
    const badExclude = exclude.filter(a => !isAddress(a));
    return { totalA, totalB, thresholdWei, burnerMultiplierBps, exclude, badExclude };
  }, [totalAText, totalBText, thresholdText, multiplierText, excludeText]);

  const planned = useMemo(() => {
    if (snap.status !== 'done') return null;
    const { totalA, totalB, thresholdWei, burnerMultiplierBps, exclude, badExclude } = params;
    if (totalA === null || totalB === null || thresholdWei === null || burnerMultiplierBps === null || badExclude.length) return { error: 'Check the figures above: one of them is not a valid number or address.' as string };
    try {
      return { plan: planAirdrop(snap.positions, { totalA, totalB, thresholdWei, burnerMultiplierBps, countBurned, exclude }) };
    } catch (e: any) {
      return { error: e?.message || 'The plan could not be built.' };
    }
  }, [snap, params, countBurned]);
  const plan = planned && 'plan' in planned ? planned.plan : null;

  const contractAddr = isAddress(contract) ? contract.trim().toLowerCase() : null;
  const dist = useMemo(() => {
    if (!plan || plan.entries.length === 0 || snap.status !== 'done') return null;
    try {
      return buildDistribution({
        plan,
        chainId: 9,
        contract: contractAddr,
        tokenA: { address: Q0.address.toLowerCase(), symbol: 'Q0' },
        tokenB: { address: QAXE.address.toLowerCase(), symbol: 'QAXE' },
        snapshotBlock: snap.block
      });
    } catch {
      return null;
    }
  }, [plan, snap, contractAddr, Q0.address, QAXE.address]);
  const problems = useMemo(() => (dist ? auditDistribution(dist) : []), [dist]);

  // ---- 3. the contract ----------------------------------------------------------------------------------------------------
  const refreshContract = useCallback(async () => {
    if (!contractAddr) {
      setState({ status: 'idle' });
      return;
    }
    setState(s => ({ status: 'loading', value: s.value }));
    try {
      setState({ status: 'ready', value: await readAirdropState(createBatch(), contractAddr) });
    } catch (e: any) {
      setState({ status: 'error', error: e?.message || 'Could not read the contract.' });
    }
  }, [contractAddr]);
  useEffect(() => {
    void refreshContract();
    try {
      if (contractAddr) localStorage.setItem(CONTRACT_KEY, contractAddr);
    } catch {
      /* private mode: the address is just not remembered */
    }
  }, [contractAddr, refreshContract]);

  const cs = state.value;
  const isContractOwner = Boolean(wallet && cs && cs.owner.toLowerCase() === wallet.toLowerCase());
  const rightTokens = Boolean(cs && cs.tokenA.toLowerCase() === Q0.address.toLowerCase() && cs.tokenB.toLowerCase() === QAXE.address.toLowerCase());
  const needA = dist ? BigInt(dist.totalA) : 0n;
  const needB = dist ? BigInt(dist.totalB) : 0n;
  const shortA = cs && needA > cs.balanceA ? needA - cs.balanceA : 0n;
  const shortB = cs && needB > cs.balanceB ? needB - cs.balanceB : 0n;
  const funded = Boolean(cs && dist && shortA === 0n && shortB === 0n);
  const rootMatches = Boolean(cs && dist && cs.rootSet && cs.merkleRoot === dist.merkleRoot);
  const days = Number(windowDays);
  const windowOk = Number.isFinite(days) && days * 86_400 >= AIRDROP_MIN_CLAIM_WINDOW_SECONDS;
  const afterDeadline = Boolean(cs && cs.rootSet && Date.now() / 1000 > cs.claimDeadline);

  const run = async (key: string, label: string, to: string, data: string) => {
    if (!wallet) return setToast({ tone: 'warn', body: 'Connect the wallet first.' });
    setBusy(key);
    setToast(null);
    try {
      await sendContractCall(wallet, to, data, { gasMultiplier: 1.5 });
      setToast({ tone: 'ok', body: `${label}: confirmed.` });
    } catch (e: any) {
      setToast({ tone: 'danger', body: describeTxError(e) });
    } finally {
      setBusy(null);
      void refreshContract();
    }
  };

  const nextIn = Math.ceil((NEXT_SNAPSHOT_MS - Date.now()) / 86_400_000);

  return (
    <section className="glass-card farm-admin-section" id="airdrop-admin">
      <h3 className="farm-admin-title"><Gift size={18} /> Airdrop: Q0 + QAXE to Quainance BDELTA stakers</h3>
      <p style={{ ...muted, fontSize: '0.8rem', marginTop: 0 }}>
        {fmt(AIRDROP_DEFAULTS.totalA, 0)} Q0 and {fmt(AIRDROP_DEFAULTS.totalB, 0)} QAXE, shared by everyone with at least {fmt(AIRDROP_DEFAULTS.thresholdWei, 0)} BDELTA
        staked on Quainance in proportion to their stake; a liquidity burner counts 1.5x. Nothing is sent until you press a button and confirm in your wallet.
      </p>

      <Notice tone="info">
        <CalendarClock size={13} style={{ verticalAlign: 'middle' }} /> The next snapshot is taken for you on <strong>21 October 2026, 12:00 UTC</strong>
        {nextIn > 0 ? ` (in ${nextIn} day${nextIn === 1 ? '' : 's'})` : ''} by the “Airdrop snapshot” workflow; its files are kept as a download on that run. You can also take one here at any time.
      </Notice>

      {/* figures */}
      <div className="farm-admin-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.6rem', margin: '0.75rem 0' }}>
        <Field label="Q0 in the pot"><input style={{ ...input, fontFamily: 'monospace' }} inputMode="decimal" value={totalAText} onChange={e => setTotalAText(e.target.value)} /></Field>
        <Field label="QAXE in the pot"><input style={{ ...input, fontFamily: 'monospace' }} inputMode="decimal" value={totalBText} onChange={e => setTotalBText(e.target.value)} /></Field>
        <Field label="Minimum BDELTA staked"><input style={{ ...input, fontFamily: 'monospace' }} inputMode="decimal" value={thresholdText} onChange={e => setThresholdText(e.target.value)} /></Field>
        <Field label="Burner multiplier"><input style={{ ...input, fontFamily: 'monospace' }} inputMode="decimal" value={multiplierText} onChange={e => setMultiplierText(e.target.value)} /></Field>
      </div>
      <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', fontSize: '0.82rem', marginBottom: '0.6rem' }}>
        <input type="checkbox" checked={countBurned} onChange={e => setCountBurned(e.target.checked)} style={{ marginTop: '0.2rem' }} />
        <span>Count burned liquidity as stake too. Off: only what is still staked counts toward the minimum and the share, and burning earns the multiplier.</span>
      </label>
      <Field label="Accounts that do not take part" hint="One address per line, e.g. the team’s own wallets or a protocol contract.">
        <textarea style={{ ...input, fontFamily: 'monospace', minHeight: '3.2rem' }} value={excludeText} onChange={e => setExcludeText(e.target.value)} placeholder="0x00…" spellCheck={false} />
      </Field>
      {params.badExclude.length > 0 && <Notice tone="danger">Not an address: {params.badExclude.join(', ')}</Notice>}

      {/* snapshot */}
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', margin: '0.8rem 0' }}>
        <button type="button" className="btn-primary" style={{ fontSize: '0.8rem', padding: '0.45rem 0.9rem' }} onClick={() => void take()} disabled={snap.status === 'running'}>
          {snap.status === 'running' ? <><Spinner /> Reading the chain…</> : <><RefreshCw size={13} /> Take a snapshot now</>}
        </button>
        {snap.status === 'running' && <button type="button" style={smallBtn} onClick={cancel}>Cancel</button>}
        <label style={{ ...smallBtn, cursor: 'pointer' }}>
          <Upload size={12} /> Load a snapshot file
          <input type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={e => { void loadFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
        {snap.status === 'running' && <small style={muted}>{snap.windows} blocks ranges read, {snap.found} transfers found. You can leave this tab open and keep working.</small>}
      </div>
      {snap.status === 'error' && <Notice tone="danger">{snap.message}</Notice>}
      {snap.status === 'done' && (
        <p style={{ ...muted, fontSize: '0.78rem', margin: '0 0 0.5rem' }}>
          Snapshot {snap.source === 'chain' ? 'read from the chain' : 'loaded from a file'}{snap.block !== null ? ` at block ${snap.block.toLocaleString('en-US')}` : ''}: {snap.positions.length} account{snap.positions.length === 1 ? '' : 's'} with liquidity.
        </p>
      )}
      {snap.status === 'done' && snap.warnings.map((w, i) => <Notice key={i} tone="warn">{w}</Notice>)}
      {planned && 'error' in planned && <Notice tone="danger">{planned.error}</Notice>}

      {/* the plan */}
      {plan && (
        <>
          <p style={{ fontSize: '0.85rem', margin: '0.4rem 0' }}>
            <strong>{plan.entries.length}</strong> eligible of {plan.accounts} &middot; {plan.burners} burner{plan.burners === 1 ? '' : 's'} &middot; {plan.belowThreshold} below the minimum &middot; rounding left over: {plan.dustA.toString()} / {plan.dustB.toString()} wei
          </p>
          {plan.entries.length === 0 ? (
            <Notice tone="warn">Nobody is eligible under these figures, so there is nothing to distribute.</Notice>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--text-muted)' }}>
                    <th>#</th><th>Account</th><th>Staked BDELTA</th><th>Burner</th><th>Q0</th><th>QAXE</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.entries.map(e => (
                    <tr key={e.account} style={{ borderTop: '1px solid var(--panel-border)' }}>
                      <td>{e.index}</td>
                      <td><AddrLink address={e.account} /></td>
                      <td>{fmt(e.stake)}</td>
                      <td>{e.burner ? <Badge severity="ok" title={`Burned ${fmt(e.burned)} BDELTA of liquidity`}>1.5x</Badge> : '—'}</td>
                      <td>{fmt(e.amountA)}</td>
                      <td>{fmt(e.amountB)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* the file */}
      {dist && (
        <>
          <div style={{ ...box, marginTop: '0.8rem', fontSize: '0.8rem' }}>
            <div>Merkle root <code style={{ wordBreak: 'break-all' }}>{dist.merkleRoot}</code></div>
            <div>The contract must hold <strong>{fmt(BigInt(dist.totalA), 6)} Q0</strong> and <strong>{fmt(BigInt(dist.totalB), 6)} QAXE</strong></div>
            {problems.length === 0 ? <Badge severity="ok">The file passes its own audit</Badge> : <Notice tone="danger">The file failed its audit: {problems.slice(0, 3).join(' ')}</Notice>}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
            <button type="button" style={smallBtn} disabled={problems.length > 0} onClick={() => download(`distribution-${dist.merkleRoot.slice(2, 10)}.json`, dist)}>
              <Download size={12} /> Download the distribution file
            </button>
            {snap.status === 'done' && (
              <button type="button" style={smallBtn} onClick={() => download(`snapshot-${snap.block ?? 'file'}.json`, { block: snap.block, positions: snap.positions.map(p => ({ account: p.account, held: p.held.toString(), burned: p.burned.toString() })), warnings: snap.warnings })}>
                <Download size={12} /> Download the snapshot
              </button>
            )}
          </div>
        </>
      )}

      {/* the contract steps */}
      <h4 style={{ margin: '1.2rem 0 0.4rem', fontSize: '0.95rem' }}>The contract</h4>
      <Field label="Claim contract address" hint="Deploy CircleswapAirdrop (q0/packages/contracts) with the owner, Q0 and QAXE, then paste its address.">
        <input style={{ ...input, fontFamily: 'monospace' }} value={contract} onChange={e => setContract(e.target.value)} placeholder="0x00…" spellCheck={false} />
      </Field>
      {contract.trim() !== '' && !contractAddr && <Notice tone="danger">That is not an address.</Notice>}
      {state.status === 'loading' && !cs && <div style={muted}><Spinner /> Reading the contract…</div>}
      {state.status === 'error' && <Notice tone="danger">{state.error}</Notice>}
      {cs && (
        <div style={{ ...box, fontSize: '0.82rem', display: 'grid', gap: '0.25rem' }}>
          <div>Owner <AddrLink address={cs.owner} /> {isContractOwner ? <Badge severity="ok">you</Badge> : wallet ? <Badge severity="warn">not the connected wallet</Badge> : null}</div>
          <div>Tokens <AddrLink address={cs.tokenA} /> / <AddrLink address={cs.tokenB} /> {rightTokens ? <Badge severity="ok">Q0 and QAXE</Badge> : <Badge severity="danger">not Q0 and QAXE</Badge>}</div>
          <div>Holds {fmt(cs.balanceA)} Q0 and {fmt(cs.balanceB)} QAXE</div>
          <div>
            {cs.rootSet ? (
              <>Root set <code style={{ wordBreak: 'break-all' }}>{cs.merkleRoot}</code> &middot; claims until {new Date(cs.claimDeadline * 1000).toUTCString()} &middot; claimed {fmt(cs.claimedA)} Q0 + {fmt(cs.claimedB)} QAXE of {fmt(cs.totalA)} + {fmt(cs.totalB)}</>
            ) : (
              'No root set yet: claims are closed.'
            )}
          </div>
          {cs.rootSet && dist && (rootMatches ? <Badge severity="ok">The file above matches the contract’s root</Badge> : <Notice tone="danger">The file above does NOT match the root on the contract. Do not publish it as this airdrop.</Notice>)}
        </div>
      )}
      {toast && <Notice tone={toast.tone}>{toast.body}</Notice>}

      {cs && !rightTokens && <Notice tone="danger">This contract does not pay Q0 and QAXE. Nothing will be sent to it from here.</Notice>}
      {cs && rightTokens && dist && !cs.rootSet && (
        <div style={{ display: 'grid', gap: '0.6rem', marginTop: '0.6rem' }}>
          <div>
            <strong style={{ fontSize: '0.85rem' }}>1. Deposit</strong>{' '}
            {funded ? (
              <Badge severity="ok">funded</Badge>
            ) : (
              <>
                <small style={muted}>send what is short; any wallet holding the tokens can do it</small>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
                  {shortA > 0n && (
                    <button type="button" className="btn-primary" style={{ fontSize: '0.78rem', padding: '0.4rem 0.8rem' }} disabled={busy !== null || !wallet} onClick={() => void run('depositA', 'Q0 deposit', cs.tokenA, erc20Tx.transfer(contractAddr!, shortA))}>
                      {busy === 'depositA' ? <Spinner /> : null} Send {fmt(shortA)} Q0
                    </button>
                  )}
                  {shortB > 0n && (
                    <button type="button" className="btn-primary" style={{ fontSize: '0.78rem', padding: '0.4rem 0.8rem' }} disabled={busy !== null || !wallet} onClick={() => void run('depositB', 'QAXE deposit', cs.tokenB, erc20Tx.transfer(contractAddr!, shortB))}>
                      {busy === 'depositB' ? <Spinner /> : null} Send {fmt(shortB)} QAXE
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          <div>
            <strong style={{ fontSize: '0.85rem' }}>2. Set the root (once, final)</strong>
            <p style={{ ...muted, fontSize: '0.78rem', margin: '0.2rem 0' }}>
              This opens claims and can never be changed. Publish the file first, and check it. Type the first ten characters of the root to confirm: <code>{dist.merkleRoot.slice(0, 10)}</code>
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
              <input style={{ ...input, maxWidth: '12rem', fontFamily: 'monospace' }} value={typedRoot} onChange={e => setTypedRoot(e.target.value.trim())} placeholder={dist.merkleRoot.slice(0, 10)} />
              <input style={{ ...input, maxWidth: '5rem' }} inputMode="numeric" value={windowDays} onChange={e => setWindowDays(e.target.value)} aria-label="Days claims stay open" />
              <small style={muted}>days open (at least 14)</small>
              <button
                type="button"
                className="btn-primary"
                style={{ fontSize: '0.78rem', padding: '0.4rem 0.8rem' }}
                disabled={busy !== null || !isContractOwner || !funded || problems.length > 0 || !windowOk || typedRoot.toLowerCase() !== dist.merkleRoot.slice(0, 10).toLowerCase()}
                onClick={() => void run('root', 'Root set', contractAddr!, airdropTx.setMerkleRoot(dist.merkleRoot, needA, needB, Math.floor(Date.now() / 1000) + Math.ceil(days * 86_400) + 600))}
              >
                {busy === 'root' ? <Spinner /> : null} Open claims
              </button>
            </div>
            {!isContractOwner && <small style={muted}>Only the contract’s owner can send this.</small>}
          </div>
        </div>
      )}

      {cs && rightTokens && cs.rootSet && (
        <div style={{ marginTop: '0.6rem' }}>
          <strong style={{ fontSize: '0.85rem' }}>3. After the window closes</strong>
          <p style={{ ...muted, fontSize: '0.78rem', margin: '0.2rem 0' }}>
            {afterDeadline ? 'The window is closed: whatever was not claimed can be returned to the owner.' : 'The owner cannot touch the two tokens before the deadline.'}
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" style={smallBtn} disabled={busy !== null || !isContractOwner || !afterDeadline} onClick={() => void run('sweepA', 'Q0 returned', contractAddr!, airdropTx.sweep(cs.tokenA, cs.owner))}>Return unclaimed Q0</button>
            <button type="button" style={smallBtn} disabled={busy !== null || !isContractOwner || !afterDeadline} onClick={() => void run('sweepB', 'QAXE returned', contractAddr!, airdropTx.sweep(cs.tokenB, cs.owner))}>Return unclaimed QAXE</button>
          </div>
        </div>
      )}
    </section>
  );
}
