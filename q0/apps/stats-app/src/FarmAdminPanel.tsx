import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Coins, KeyRound, PauseCircle, PlayCircle, RefreshCw, ShieldCheck, Sprout, Wrench } from 'lucide-react';
import {
  AMM_DEX_IDS,
  DEXES,
  SINGLE_STAKE_POOLS,
  TOKEN_SELECTORS,
  analyzePairs,
  batchQuaiCall,
  checkAddPool,
  checkEmission,
  checkSetPool,
  erc20Tx,
  farmTx,
  fetchQuaiUsd,
  formatUnits,
  hasErrors,
  loadPairSnapshots,
  ownerRisk,
  quaiRpcCall,
  ratePerSecondFromDaily,
  readFarmState,
  readPairs,
  runwaySeconds,
  singleStakeCandidates,
  tryParseUnits,
  SECONDS_PER_DAY,
  POOL_COUNT_MAX,
  type Check,
  type FarmBatch,
  type FarmRow,
  type FarmState,
  type FarmTokenInfo,
  type PairAnalysis,
  type PairInfo,
  type SingleStakeCandidate
} from 'quai-service';
import { AddrLink, Badge, CopyButton, Field, Notice, Spinner, box, input, muted, smallBtn } from './ui';
import { describeTxError, sendContractCall } from './farmSend';
import { formatUsd } from './TokenPicker';
import './singleStake.css';
import AirdropAdmin from './AirdropAdmin';

interface Props {
  farm: FarmState;
  rows: FarmRow[];
  tokens: Record<string, FarmTokenInfo | undefined>;
  rewards: { a: { symbol: string; decimals: number }; b: { symbol: string; decimals: number } };
  wallet: string | null;
  isOwner: boolean;
  isPendingOwner: boolean;
  quaiUsd: number | null;
  /** Re-read the farm after a transaction. */
  onChanged: () => Promise<void>;
  /** A pool (its LP or token address, lower case) to have ticked and scrolled into view: the Add to farm button on a row. */
  focusPool?: string | null;
  onFocusShown?: () => void;
}

const batch: FarmBatch = calls => batchQuaiCall(calls);
const DAYS = (n: number) => n * SECONDS_PER_DAY;
const word = (a: string) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');

const TONE: Record<Check['level'], 'info' | 'warn' | 'danger'> = { info: 'info', warning: 'warn', error: 'danger' };

function Checks({ checks }: { checks: Check[] }) {
  if (checks.length === 0) return null;
  // errors first: they are the reason the button is disabled
  const order = { error: 0, warning: 1, info: 2 } as const;
  return (
    <>
      {[...checks].sort((a, b) => order[a.level] - order[b.level]).map(c => (
        <Notice key={c.code} tone={TONE[c.level]}>{c.message}</Notice>
      ))}
    </>
  );
}

/** The transaction a multisig or timelock would have to submit, for when the connected wallet is not the owner. */
function Calldata({ to, data, label }: { to: string; data: string; label: string }) {
  const json = JSON.stringify({ to, data, value: '0' }, null, 2);
  return (
    <details style={{ marginTop: '0.4rem' }}>
      <summary style={{ cursor: 'pointer', fontSize: '0.75rem', color: 'var(--text-muted)' }}>Transaction for a multisig: {label}</summary>
      <pre style={{ ...box, fontSize: '0.7rem', overflowX: 'auto', margin: '0.4rem 0' }}>{json}</pre>
      <CopyButton text={json} label="Copy transaction" />
    </details>
  );
}

function Section({ icon, title, children, hint }: { icon: ReactNode; title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="glass-card farm-admin-section">
      <h3 className="farm-admin-title">{icon} {title}</h3>
      {hint && <p style={{ ...muted, fontSize: '0.8rem', marginTop: 0 }}>{hint}</p>}
      {children}
    </section>
  );
}

export default function FarmAdminPanel({ farm, rows, tokens, rewards, wallet, isOwner, isPendingOwner, quaiUsd, onChanged, focusPool, onFocusShown }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: 'ok' | 'danger' | 'warn' | 'info'; body: ReactNode } | null>(null);

  const guard = (): string | null =>
    !wallet ? 'Connect the owner wallet first.' : !isOwner ? 'Only the farm owner can send this. Use the multisig transaction below.' : null;

  /** One owner transaction with uniform busy/toast handling. */
  const send = async (key: string, label: string, to: string, data: string): Promise<boolean> => {
    const blocked = guard();
    if (blocked) {
      setToast({ tone: 'warn', body: blocked });
      return false;
    }
    setBusy(key);
    setToast(null);
    try {
      const res = await sendContractCall(wallet!, to, data, { gasMultiplier: 1.5 });
      setToast({ tone: 'ok', body: <>{label} confirmed. <AddrLink address={res.txHash} tx /></> });
      await onChanged();
      return true;
    } catch (e: any) {
      setToast({ tone: 'danger', body: describeTxError(e) });
      return false;
    } finally {
      setBusy(null);
    }
  };

  // ---- 1. control & integrity ------------------------------------------------------------------------------------
  const [integrity, setIntegrity] = useState<{ title: string; address: string; verdict: 'ok' | 'bad' | 'unknown'; detail: string }[] | null>(null);
  const [ownerIsContract, setOwnerIsContract] = useState<boolean | null>(null);

  const runIntegrity = useCallback(async () => {
    setIntegrity(null);
    try {
      // the code-comparison tooling carries the contracts' hashes and the quais SDK: load it only when this panel opens
      const dep = await import('quai-service/deploy');
      const reader = dep.makeReader((m, p) => quaiRpcCall(m, p));
      const out: { title: string; address: string; verdict: 'ok' | 'bad' | 'unknown'; detail: string }[] = [];
      const check = async (title: string, name: 'CircleswapMasterChef' | 'Qrb', address: string) => {
        try {
          const m = await dep.matchCode(reader, name, address);
          out.push({
            title,
            address,
            verdict: m.state === 'ok' ? 'ok' : 'bad',
            detail:
              m.state === 'ok'
                ? `Exactly the compiled ${name} (${m.size} bytes, code hash checked).`
                : m.state === 'missing'
                  ? 'No contract code at this address.'
                  : `Not the compiled ${name}: ${m.size} bytes found, ${m.wantSize} expected${m.state === 'wrong-code' ? ' (same length, different code)' : ''}.`
          });
        } catch (e: any) {
          out.push({ title, address, verdict: 'unknown', detail: `Could not be read: ${e.message}` });
        }
      };
      await check('Farm contract', 'CircleswapMasterChef', farm.address);
      if (farm.qrb) await check('Boost source (Qrb)', 'Qrb', farm.qrb);
      const ownerCode = await reader.getCode(farm.owner);
      setOwnerIsContract(Boolean(ownerCode) && ownerCode !== '0x');
      setIntegrity(out);
    } catch (e: any) {
      setIntegrity([{ title: 'Integrity check', address: farm.address, verdict: 'unknown', detail: `Could not run: ${e.message}` }]);
    }
  }, [farm.address, farm.qrb, farm.owner]);

  useEffect(() => {
    void runIntegrity();
  }, [runIntegrity]);

  // ---- 2. reward balances ----------------------------------------------------------------------------------------
  const [walletBalances, setWalletBalances] = useState<{ a?: bigint; b?: bigint }>({});
  useEffect(() => {
    if (!wallet) {
      setWalletBalances({});
      return;
    }
    let live = true;
    void batch([
      { to: farm.rewardTokenA, data: TOKEN_SELECTORS.balanceOf + word(wallet) },
      { to: farm.rewardTokenB, data: TOKEN_SELECTORS.balanceOf + word(wallet) }
    ]).then(([a, b]) => {
      if (!live) return;
      const num = (h?: string) => (h && /^0x[0-9a-fA-F]{1,64}$/.test(h) ? BigInt(h) : undefined);
      setWalletBalances({ a: num(a), b: num(b) });
    });
    return () => {
      live = false;
    };
  }, [wallet, farm.rewardTokenA, farm.rewardTokenB, farm.inventoryA.balance, farm.inventoryB.balance]);

  // ---- 3. pair discovery -----------------------------------------------------------------------------------------
  const [discovery, setDiscovery] = useState<{ state: 'loading' | 'ready' | 'error'; pairs: PairAnalysis[]; total: number; error?: string }>({ state: 'loading', pairs: [], total: 0 });
  const discover = useCallback(async () => {
    setDiscovery(d => ({ ...d, state: 'loading' }));
    try {
      // Every DEX the app can route through: a pool on Quaiswap or Quainance can be farmed too (the contract takes any LP
      // token), and its Add to farm button on the Pools tab must lead to something to tick.
      const [res, usd] = await Promise.all([loadPairSnapshots(AMM_DEX_IDS, { maxPerDex: 1000 }), quaiUsd ? Promise.resolve(quaiUsd) : fetchQuaiUsd()]);
      const analysed = analyzePairs(res.pairs, { quaiUsd: usd });
      const total = Object.values(res.totals).reduce((s, n) => s + (n ?? 0), 0);
      setDiscovery({ state: 'ready', pairs: analysed, total: total || analysed.length, error: res.errors.length ? res.errors.join('; ') : undefined });
    } catch (e: any) {
      setDiscovery({ state: 'error', pairs: [], total: 0, error: e?.message || 'Could not list the AMM’s pairs.' });
    }
  }, [quaiUsd]);
  useEffect(() => {
    void discover();
  }, [discover]);

  const farmed = useMemo(() => new Set(farm.pools.map(p => p.lpToken.toLowerCase())), [farm.pools]);
  const candidates = useMemo(
    () =>
      discovery.pairs
        .filter(p => !farmed.has(p.pair.toLowerCase()))
        .sort((x, y) => (y.tvlUsd ?? -1) - (x.tvlUsd ?? -1) || y.index - x.index),
    [discovery.pairs, farmed]
  );
  const factoryPairs = useMemo(() => new Set(discovery.pairs.map(p => p.pair.toLowerCase())), [discovery.pairs]);

  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [allocText, setAllocText] = useState<Record<string, string>>({});
  const allocOf = (pair: string): bigint | null => tryParseUnits(allocText[pair.toLowerCase()] ?? '100', 0);

  const pairInfoOf = (p: PairAnalysis): PairInfo => ({
    lpToken: p.pair.toLowerCase(),
    token0: p.token0.address.toLowerCase(),
    token1: p.token1.address.toLowerCase(),
    reserve0: p.reserve0,
    reserve1: p.reserve1,
    totalSupply: p.totalSupply
  });

  const candidateChecks = (p: PairAnalysis): Check[] => {
    const a = allocOf(p.pair);
    if (a === null) return [{ level: 'error', code: 'ALLOC_NOT_A_NUMBER', message: 'Allocation must be a whole number.' }];
    return checkAddPool({ lpToken: p.pair, allocPoint: a, farm, isContract: true, pair: pairInfoOf(p), isFactoryPool: p.dex === 'CIRCLESWAP' });
  };

  // Single-token pools in the plan (stake Q0 or BDELTA itself) that the deployed farm does not have yet. The plan's
  // weights are only the starting value of the input; whether a pool is in the farm is read from the farm.
  const singles = useMemo(() => singleStakeCandidates(farm, SINGLE_STAKE_POOLS).filter(c => c.state === 'NOT_IN_FARM'), [farm]);
  const singleKey = singles.map(c => c.stakeToken).join(',');
  const [singleCode, setSingleCode] = useState<Record<string, boolean | undefined>>({});
  useEffect(() => {
    let live = true;
    setSingleCode({});
    if (!singleKey) return;
    void (async () => {
      try {
        const dep = await import('quai-service/deploy');
        const found: Record<string, boolean> = {};
        for (const token of singleKey.split(',')) {
          const code = await quaiRpcCall('quai_getCode', [dep.checksum(token), 'latest']);
          found[token] = Boolean(code) && code !== '0x';
        }
        if (live) setSingleCode(found);
      } catch {
        /* stays unknown: adding is held until the token contract is confirmed */
      }
    })();
    return () => {
      live = false;
    };
  }, [singleKey]);

  const singleAllocOf = (token: string): bigint | null =>
    tryParseUnits(allocText[token] ?? (SINGLE_STAKE_POOLS.find(p => p.stakeToken === token)?.allocPoint ?? 100n).toString(), 0);
  const singleSymbol = (c: SingleStakeCandidate) => tokens[c.stakeToken]?.symbol ?? c.symbol;
  const singleChecks = (c: SingleStakeCandidate): Check[] => {
    const a = singleAllocOf(c.stakeToken);
    if (a === null) return [{ level: 'error', code: 'ALLOC_NOT_A_NUMBER', message: 'Allocation must be a whole number.' }];
    if (singleCode[c.stakeToken] === undefined) return [{ level: 'error', code: 'CHECKING_TOKEN', message: 'Checking the token contract…' }];
    return checkAddPool({ lpToken: c.stakeToken, allocPoint: a, farm, isContract: singleCode[c.stakeToken] === true });
  };

  // Add to farm on a row: tick that pool and bring it into view, once the list has loaded.
  useEffect(() => {
    if (!focusPool || discovery.state !== 'ready') return;
    const isPair = candidates.some(c => c.pair.toLowerCase() === focusPool);
    const isSingle = singles.some(c => c.stakeToken === focusPool);
    if (isPair || isSingle) setPicked(p => ({ ...p, [focusPool]: true }));
    const timer = setTimeout(() => {
      document.getElementById(`farm-candidate-${focusPool}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      onFocusShown?.();
    }, 60);
    return () => clearTimeout(timer);
  }, [focusPool, discovery.state, candidates, singles, onFocusShown]);

  const chosen = candidates.filter(c => picked[c.pair.toLowerCase()]);
  const chosenSingles = singles.filter(c => picked[c.stakeToken]);
  // one list for both kinds, so a single transaction batch, one total and one button cover everything ticked
  interface AddItem { label: string; token: string; alloc: bigint | null; pair?: PairInfo; isFactoryPool?: boolean }
  const addItems: AddItem[] = [
    ...chosen.map<AddItem>(c => ({ label: `${c.token0.symbol || '?'} / ${c.token1.symbol || '?'}`, token: c.pair, alloc: allocOf(c.pair), pair: pairInfoOf(c), isFactoryPool: c.dex === 'CIRCLESWAP' })),
    ...chosenSingles.map<AddItem>(c => ({ label: `${singleSymbol(c)} (single token)`, token: c.stakeToken, alloc: singleAllocOf(c.stakeToken) }))
  ];
  const chosenErrors = chosen.some(c => hasErrors(candidateChecks(c))) || chosenSingles.some(c => hasErrors(singleChecks(c)));
  const newTotal = addItems.reduce((s, c) => s + (c.alloc ?? 0n), 0n);
  const totalAfter = farm.totalAllocPoint + newTotal;
  const shareAfter = (alloc: bigint) => (totalAfter === 0n ? 0 : Number((alloc * 1_000_000n) / totalAfter) / 10_000);

  const addChosen = async () => {
    const blocked = guard();
    if (blocked) return setToast({ tone: 'warn', body: blocked });
    setBusy('addpools');
    setToast(null);
    const added: string[] = [];
    const skipped: string[] = [];
    try {
      for (const item of addItems) {
        // The contract accepts a duplicate pool; the page must not. Re-read the farm before every add.
        const fresh = await readFarmState(batch, farm.address);
        const alloc = item.alloc!;
        const checks = checkAddPool({ lpToken: item.token, allocPoint: alloc, farm: fresh, isContract: true, pair: item.pair, isFactoryPool: item.isFactoryPool });
        const label = item.label;
        if (hasErrors(checks)) {
          skipped.push(`${label}: ${checks.find(k => k.level === 'error')!.message}`);
          continue;
        }
        await sendContractCall(wallet!, farm.address, farmTx.addPool(alloc, item.token), { gasMultiplier: 1.5 });
        added.push(label);
      }
      setPicked({});
      setToast({
        tone: skipped.length ? 'warn' : 'ok',
        body: (
          <>
            Added {added.length} pool{added.length === 1 ? '' : 's'}{added.length ? `: ${added.join(', ')}` : ''}.
            {skipped.length > 0 && <> Skipped: {skipped.join(' ')}</>}
          </>
        )
      });
    } catch (e: any) {
      setToast({ tone: 'danger', body: `${added.length ? `Added ${added.join(', ')} before stopping. ` : ''}${describeTxError(e)}` });
    } finally {
      setBusy(null);
      await onChanged();
    }
  };

  // custom address (a single asset, or an LP from another DEX)
  const [customAddr, setCustomAddr] = useState('');
  const [customAlloc, setCustomAlloc] = useState('100');
  const [customResult, setCustomResult] = useState<{ checks: Check[]; label: string } | null>(null);
  const checkCustom = async () => {
    const addr = customAddr.trim();
    const alloc = tryParseUnits(customAlloc, 0);
    if (alloc === null) return setCustomResult({ checks: [{ level: 'error', code: 'ALLOC_NOT_A_NUMBER', message: 'Allocation must be a whole number.' }], label: addr });
    let isContract = false;
    let pair: PairInfo | undefined;
    if (/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      try {
        const dep = await import('quai-service/deploy');
        const code = await quaiRpcCall('quai_getCode', [dep.checksum(addr), 'latest']);
        isContract = Boolean(code) && code !== '0x';
        if (isContract) pair = (await readPairs(batch, [addr]))[addr.toLowerCase()];
      } catch {
        isContract = false;
      }
    }
    const checks = checkAddPool({ lpToken: addr, allocPoint: alloc, farm, isContract, pair, isFactoryPool: pair?.token0 ? factoryPairs.has(addr.toLowerCase()) : undefined });
    setCustomResult({ checks, label: addr });
  };
  const customReady = customResult && customResult.label === customAddr.trim() && !hasErrors(customResult.checks);

  // ---- 4. allocations --------------------------------------------------------------------------------------------
  const [allocEdits, setAllocEdits] = useState<Record<number, string>>({});
  const changes = farm.pools
    .map(p => ({ pool: p, next: allocEdits[p.pid] === undefined ? null : tryParseUnits(allocEdits[p.pid], 0), raw: allocEdits[p.pid] }))
    .filter(c => c.raw !== undefined && (c.next === null || c.next !== c.pool.allocPoint));
  const changeChecks = changes.flatMap(c => (c.next === null ? [{ level: 'error' as const, code: `BAD_${c.pool.pid}`, message: `Pool #${c.pool.pid}: allocation must be a whole number.` }] : checkSetPool(c.pool.pid, c.next, farm)));
  const totalAfterEdits = farm.pools.reduce((s, p) => {
    const e = allocEdits[p.pid] === undefined ? null : tryParseUnits(allocEdits[p.pid], 0);
    return s + (e ?? p.allocPoint);
  }, 0n);
  const applyAllocations = async () => {
    for (const c of changes) {
      if (c.next === null) continue;
      const ok = await send(`setpool:${c.pool.pid}`, `Pool #${c.pool.pid} allocation`, farm.address, farmTx.setPool(c.pool.pid, c.next));
      if (!ok) break;
    }
    setAllocEdits({});
  };

  // ---- 5. emission -----------------------------------------------------------------------------------------------
  const perDay = (rate: bigint, decimals: number) => formatUnits(rate * BigInt(SECONDS_PER_DAY), decimals, 6);
  const [dailyA, setDailyA] = useState<string | null>(null);
  const [dailyB, setDailyB] = useState<string | null>(null);
  const shownA = dailyA ?? perDay(farm.rewardAPerSecond, rewards.a.decimals);
  const shownB = dailyB ?? perDay(farm.rewardBPerSecond, rewards.b.decimals);
  const nextA = ratePerSecondFromDaily(shownA, rewards.a.decimals);
  const nextB = ratePerSecondFromDaily(shownB, rewards.b.decimals);
  const emissionChecks: Check[] =
    nextA === null || nextB === null
      ? [{ level: 'error', code: 'RATE_NOT_A_NUMBER', message: 'Enter a number of tokens per day for both rewards.' }]
      : checkEmission({ rateA: nextA, rateB: nextB, farm });
  const emissionChanged = nextA !== null && nextB !== null && (nextA !== farm.rewardAPerSecond || nextB !== farm.rewardBPerSecond);
  const priceA = tokens[farm.rewardTokenA.toLowerCase()]?.priceUsd;
  const priceB = tokens[farm.rewardTokenB.toLowerCase()]?.priceUsd;

  // ---- 6. funding ------------------------------------------------------------------------------------------------
  const [fundText, setFundText] = useState<{ a: string; b: string }>({ a: '', b: '' });
  const need = (rate: bigint, available: bigint) => {
    const burn = rate * BigInt(DAYS(30)) + (rate * BigInt(DAYS(30)) * farm.boostBps) / 10_000n;
    return burn > available ? burn - available : 0n;
  };
  const fund = async (which: 'a' | 'b') => {
    const token = which === 'a' ? farm.rewardTokenA : farm.rewardTokenB;
    const dec = which === 'a' ? rewards.a.decimals : rewards.b.decimals;
    const amount = tryParseUnits(fundText[which], dec);
    if (amount === null || amount === 0n) return setToast({ tone: 'danger', body: 'Enter an amount to send to the farm.' });
    const held = which === 'a' ? walletBalances.a : walletBalances.b;
    if (held !== undefined && amount > held) return setToast({ tone: 'danger', body: 'That is more than your wallet holds.' });
    // funding is a plain token transfer from the connected wallet, so it does not need to be the owner
    if (!wallet) return setToast({ tone: 'warn', body: 'Connect a wallet that holds the reward token.' });
    setBusy(`fund:${which}`);
    setToast(null);
    try {
      const res = await sendContractCall(wallet, token, erc20Tx.transfer(farm.address, amount), { gasMultiplier: 1.5 });
      setToast({ tone: 'ok', body: <>Sent to the farm. <AddrLink address={res.txHash} tx /></> });
      setFundText(t => ({ ...t, [which]: '' }));
      await onChanged();
    } catch (e: any) {
      setToast({ tone: 'danger', body: describeTxError(e) });
    } finally {
      setBusy(null);
    }
  };

  // ---- 7. ownership ----------------------------------------------------------------------------------------------
  const [newOwner, setNewOwner] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const newOwnerValid = /^0x00[0-9a-fA-F]{38}$/.test(newOwner.trim()) && !/^0x0{40}$/i.test(newOwner.trim());
  const sameOwner = newOwner.trim().toLowerCase() === farm.owner.toLowerCase();

  const risk = ownerIsContract === null ? null : ownerRisk(ownerIsContract);
  const inventoryRunA = runwaySeconds(farm.inventoryA.available, farm.rewardAPerSecond, farm.boostBps);
  const inventoryRunB = runwaySeconds(farm.inventoryB.available, farm.rewardBPerSecond, farm.boostBps);

  return (
    <div className="farm-admin">
      {!wallet && <Notice tone="info">Connect the owner wallet to send transactions. Everything below is readable without one, and every action also shows its raw transaction for a multisig.</Notice>}
      {wallet && !isOwner && !isPendingOwner && (
        <Notice tone="warn">
          This wallet is not the farm owner (<AddrLink address={farm.owner} />). You can read everything and copy transactions, but only the owner can send them.
        </Notice>
      )}
      {toast && <Notice tone={toast.tone}>{toast.body}</Notice>}

      {/* control & integrity */}
      <Section icon={<ShieldCheck size={18} />} title="Control &amp; integrity" hint="Read live from the chain every time this panel opens.">
        {integrity === null ? (
          <div style={{ ...muted, fontSize: '0.85rem' }}><Spinner /> Checking the contracts…</div>
        ) : (
          integrity.map(i => (
            <div key={i.title} className="farm-admin-row">
              <span>{i.verdict === 'ok' ? <CheckCircle2 size={14} style={{ color: 'var(--success)' }} /> : <AlertTriangle size={14} style={{ color: i.verdict === 'bad' ? 'var(--error)' : 'var(--warning)' }} />}</span>
              <span><strong>{i.title}</strong> <AddrLink address={i.address} /><br /><small style={muted}>{i.detail}</small></span>
              <Badge severity={i.verdict === 'ok' ? 'ok' : i.verdict === 'bad' ? 'danger' : 'warn'}>{i.verdict === 'ok' ? 'Verified' : i.verdict === 'bad' ? 'Mismatch' : 'Unknown'}</Badge>
            </div>
          ))
        )}
        <div className="farm-admin-row">
          <span><Sprout size={14} /></span>
          <span><strong>Upgradeable?</strong> No.<br /><small style={muted}>A plain contract: reward tokens and boost source are fixed forever. Pools, shares and emission are the owner's to change; staked tokens are not.</small></span>
          <Badge severity="ok">Fixed code</Badge>
        </div>
        {risk && <Notice tone={risk.level === 'warning' ? 'warn' : 'info'}><KeyRound size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} />{risk.message}</Notice>}
        {farm.pendingOwner && (
          <Notice tone="warn">
            Ownership transfer pending to <AddrLink address={farm.pendingOwner} />. It completes only when that address accepts.
            {isPendingOwner && (
              <> <button type="button" className="btn-primary" style={{ marginLeft: '0.5rem', padding: '0.3rem 0.8rem', fontSize: '0.75rem' }} disabled={busy !== null} onClick={() => void send('accept', 'Ownership accepted', farm.address, farmTx.acceptOwnership())}>Accept ownership</button></>
            )}
          </Notice>
        )}
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={smallBtn} onClick={() => void runIntegrity()}><RefreshCw size={12} /> Re-check</button>
          {farm.paused ? (
            <button type="button" className="btn-primary" style={{ fontSize: '0.78rem', padding: '0.4rem 0.9rem' }} disabled={busy !== null || !isOwner} onClick={() => void send('unpause', 'Unpaused', farm.address, farmTx.unpause())}>
              <PlayCircle size={14} /> Resume deposits &amp; harvests
            </button>
          ) : (
            <button type="button" style={{ ...smallBtn, borderColor: 'var(--warning)' }} disabled={busy !== null || !isOwner} onClick={() => void send('pause', 'Paused', farm.address, farmTx.pause())} title="Stops new deposits and harvests. Unstaking keeps working.">
              <PauseCircle size={14} /> Pause deposits &amp; harvests
            </button>
          )}
        </div>
        <Calldata to={farm.address} data={farm.paused ? farmTx.unpause() : farmTx.pause()} label={farm.paused ? 'unpause()' : 'pause()'} />
      </Section>

      {/* add pools */}
      <Section
        icon={<Sprout size={18} />}
        title="Add pools"
        hint="Every pool on Circleswap, Quaiswap and Quainance that is not farming yet, and the single-token pools (stake Q0 or BDELTA itself). Tick the ones to add, set a reward weight, and sign once per pool."
      >
        {discovery.state === 'loading' && <div style={{ ...muted, fontSize: '0.85rem' }}><Spinner /> Listing every pool…</div>}
        {discovery.state === 'error' && <Notice tone="danger">{discovery.error} <button type="button" style={smallBtn} onClick={() => void discover()}>Retry</button></Notice>}
        {discovery.error && discovery.state === 'ready' && <Notice tone="warn">Some pairs could not be read: {discovery.error}</Notice>}
        {discovery.state === 'ready' && (
          <>
            <p style={{ ...muted, fontSize: '0.8rem', margin: '0 0 0.5rem' }}>
              {candidates.length} of {discovery.total} pool{discovery.total === 1 ? '' : 's'} not farming &middot; {farm.pools.length} farming
              {farm.pools.length >= POOL_COUNT_MAX ? ' (limit reached)' : ''}
            </p>
            {candidates.length === 0 && <div style={{ ...box, fontSize: '0.85rem' }}>Every pool is already in the farm. New pools appear here as soon as they are created.</div>}
            {candidates.map(c => {
              const key = c.pair.toLowerCase();
              const checks = candidateChecks(c);
              const errs = checks.filter(k => k.level === 'error');
              const isPicked = Boolean(picked[key]);
              const alloc = allocOf(c.pair);
              const flagDanger = c.flags.some(f => f.severity === 'danger');
              return (
                <div key={key} id={`farm-candidate-${key}`} className="farm-candidate">
                  <label className="farm-candidate-head">
                    <input type="checkbox" checked={isPicked} onChange={e => setPicked(p => ({ ...p, [key]: e.target.checked }))} disabled={errs.some(k => k.code !== 'ALLOC_NOT_A_NUMBER')} />
                    <strong>{c.token0.symbol || '?'} / {c.token1.symbol || '?'}</strong>
                    <Badge severity={c.dex === 'CIRCLESWAP' ? 'info' : 'neutral'}>{DEXES[c.dex].label}</Badge>
                    <span style={muted}>{c.tvlUsd !== null ? `${formatUsd(c.tvlUsd)} liquidity` : 'unpriced'}</span>
                    <AddrLink address={c.pair} />
                    {c.flags.map(f => (
                      <Badge key={f.code} severity={f.severity === 'danger' ? 'danger' : f.severity === 'warn' ? 'warn' : 'neutral'} title={f.detail}>{f.label}</Badge>
                    ))}
                  </label>
                  {isPicked && (
                    <div className="farm-candidate-body">
                      <Field label="Reward weight" hint={alloc !== null ? `Becomes ${shareAfter(alloc).toFixed(1)}% of all rewards once the ticked pools are added` : undefined}>
                        <input style={{ ...input, maxWidth: '10rem', fontFamily: 'monospace' }} inputMode="numeric" value={allocText[key] ?? '100'} onChange={e => setAllocText(t => ({ ...t, [key]: e.target.value }))} />
                      </Field>
                      {flagDanger && <Notice tone="danger">This pair carries a danger flag above. Farming it points rewards at it and lends it credibility; check it before adding.</Notice>}
                      <Checks checks={checks.filter(k => k.code !== 'CIRCLESWAP_POOL')} />
                    </div>
                  )}
                </div>
              );
            })}
          </>
        )}

        {singles.length > 0 && (
          <>
            <p style={{ ...muted, fontSize: '0.8rem', margin: '0.9rem 0 0.5rem' }}>
              Single-token pools &middot; deposit the token itself and earn {rewards.a.symbol} + {rewards.b.symbol} &middot; {singles.length} not in the farm yet
            </p>
            {singles.map(c => {
              const key = c.stakeToken;
              const checks = singleChecks(c);
              const errs = checks.filter(k => k.level === 'error');
              const isPicked = Boolean(picked[key]);
              const alloc = singleAllocOf(key);
              const sym = singleSymbol(c);
              return (
                <div key={key} id={`farm-candidate-${key}`} className="farm-candidate farm-candidate-single">
                  <label className="farm-candidate-head">
                    <input type="checkbox" checked={isPicked} onChange={e => setPicked(p => ({ ...p, [key]: e.target.checked }))} disabled={errs.some(k => k.code !== 'ALLOC_NOT_A_NUMBER')} />
                    <strong>Stake {sym}</strong>
                    <Badge severity="neutral">Single token</Badge>
                    <span style={muted}>Earn {rewards.a.symbol} + {rewards.b.symbol}</span>
                    <AddrLink address={key} />
                  </label>
                  {isPicked && (
                    <div className="farm-candidate-body">
                      <Field label="Reward weight" hint={alloc !== null ? `Becomes ${shareAfter(alloc).toFixed(1)}% of all rewards once the ticked pools are added` : undefined}>
                        <input style={{ ...input, maxWidth: '10rem', fontFamily: 'monospace' }} inputMode="numeric" value={allocText[key] ?? c.allocPoint.toString()} onChange={e => setAllocText(t => ({ ...t, [key]: e.target.value }))} />
                      </Field>
                      <Checks checks={checks.filter(k => k.code !== 'SINGLE_ASSET')} />
                    </div>
                  )}
                  {!isPicked && errs.length > 0 && errs[0].code !== 'ALLOC_NOT_A_NUMBER' && (
                    <small style={muted}>{errs[0].message}</small>
                  )}
                </div>
              );
            })}
          </>
        )}

        {addItems.length > 0 && (
          <>
            <Notice tone="info">
              Adding {addItems.length} pool{addItems.length === 1 ? '' : 's'} with {newTotal.toString()} new weight changes every existing pool's share: they keep their weights, but the total grows from {farm.totalAllocPoint.toString()} to {totalAfter.toString()}.
            </Notice>
            <button type="button" className="btn-primary" disabled={busy !== null || chosenErrors || !isOwner} onClick={() => void addChosen()}>
              {busy === 'addpools' ? <><Spinner /> Adding…</> : `Add ${addItems.length} pool${addItems.length === 1 ? '' : 's'}`}
            </button>
            {!isOwner && <small style={{ ...muted, marginLeft: '0.6rem' }}>Only the owner can send this.</small>}
            {addItems.length === 1 && addItems[0].alloc !== null && <Calldata to={farm.address} data={farmTx.addPool(addItems[0].alloc, addItems[0].token)} label={addItems[0].pair ? 'addPool(weight, pair)' : 'addPool(weight, token)'} />}
          </>
        )}

        <details style={{ marginTop: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.85rem' }}>Add by address (single asset or another DEX's LP)</summary>
          <div style={{ marginTop: '0.6rem' }}>
            <Field label="Token or LP contract" hint="Cyprus-1 addresses begin with 0x00.">
              <input style={{ ...input, fontFamily: 'monospace' }} value={customAddr} onChange={e => { setCustomAddr(e.target.value); setCustomResult(null); }} placeholder="0x00…" />
            </Field>
            <Field label="Reward weight">
              <input style={{ ...input, maxWidth: '10rem', fontFamily: 'monospace' }} inputMode="numeric" value={customAlloc} onChange={e => { setCustomAlloc(e.target.value); setCustomResult(null); }} />
            </Field>
            <button type="button" style={smallBtn} onClick={() => void checkCustom()} disabled={!customAddr.trim()}>Check</button>
            {customResult && customResult.label === customAddr.trim() && <div style={{ marginTop: '0.6rem' }}><Checks checks={customResult.checks} /></div>}
            {customReady && (
              <button
                type="button"
                className="btn-primary"
                disabled={busy !== null || !isOwner}
                onClick={() => void send('addcustom', 'Pool added', farm.address, farmTx.addPool(tryParseUnits(customAlloc, 0)!, customAddr.trim()))}
              >
                {busy === 'addcustom' ? <Spinner /> : 'Add pool'}
              </button>
            )}
          </div>
        </details>
      </Section>

      {/* allocations */}
      <Section icon={<Wrench size={18} />} title="Reward weights" hint="Each pool earns its weight divided by the total. Changing one changes every share.">
        {rows.length === 0 ? (
          <div style={{ ...box, fontSize: '0.85rem' }}>No pools yet.</div>
        ) : (
          <div className="farm-admin-table">
            {rows.map(r => {
              const raw = allocEdits[r.pid];
              const next = raw === undefined ? r.allocPoint : tryParseUnits(raw, 0);
              const share = next === null || totalAfterEdits === 0n ? null : Number((next * 1_000_000n) / totalAfterEdits) / 10_000;
              return (
                <div key={r.pid} className="farm-admin-row">
                  <span>#{r.pid}</span>
                  <span><strong>{r.label}</strong><br /><small style={muted}>{r.sharePct.toFixed(1)}% now{share !== null && raw !== undefined ? ` → ${share.toFixed(1)}%` : ''}</small></span>
                  <input
                    aria-label={`Weight for pool ${r.pid}`}
                    style={{ ...input, maxWidth: '8rem', fontFamily: 'monospace' }}
                    inputMode="numeric"
                    value={raw ?? r.allocPoint.toString()}
                    onChange={e => setAllocEdits(s => ({ ...s, [r.pid]: e.target.value }))}
                  />
                </div>
              );
            })}
          </div>
        )}
        <Checks checks={changeChecks} />
        {changes.length > 0 && (
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn-primary" disabled={busy !== null || hasErrors(changeChecks) || !isOwner} onClick={() => void applyAllocations()}>
              {busy?.startsWith('setpool') ? <><Spinner /> Applying…</> : `Apply ${changes.length} change${changes.length === 1 ? '' : 's'}`}
            </button>
            <button type="button" style={smallBtn} onClick={() => setAllocEdits({})}>Reset</button>
          </div>
        )}
        {changes.length === 1 && changes[0].next !== null && <Calldata to={farm.address} data={farmTx.setPool(changes[0].pool.pid, changes[0].next)} label="setPool(pid, weight)" />}
      </Section>

      {/* emission */}
      <Section icon={<Coins size={18} />} title="Emission" hint="Tokens the farm hands out per day, split across pools by weight. Applies from the moment it confirms; earlier rewards are settled at the old rate.">
        <div className="farm-admin-two">
          <Field label={`${rewards.a.symbol} per day`}>
            <input style={{ ...input, fontFamily: 'monospace' }} inputMode="decimal" value={shownA} onChange={e => setDailyA(e.target.value)} />
          </Field>
          <Field label={`${rewards.b.symbol} per day`}>
            <input style={{ ...input, fontFamily: 'monospace' }} inputMode="decimal" value={shownB} onChange={e => setDailyB(e.target.value)} />
          </Field>
        </div>
        {nextA !== null && nextB !== null && priceA !== undefined && priceB !== undefined && (
          <p style={{ ...muted, fontSize: '0.8rem' }}>
            About {formatUsd(Number(formatUnits(nextA * BigInt(SECONDS_PER_DAY), rewards.a.decimals, 6)) * priceA + Number(formatUnits(nextB * BigInt(SECONDS_PER_DAY), rewards.b.decimals, 6)) * priceB)} of rewards per day at today's prices.
          </p>
        )}
        <Checks checks={emissionChecks} />
        <button
          type="button"
          className="btn-primary"
          disabled={busy !== null || hasErrors(emissionChecks) || !emissionChanged || !isOwner}
          onClick={() => nextA !== null && nextB !== null && void send('emission', 'Emission updated', farm.address, farmTx.setEmissionRates(nextA, nextB)).then(() => { setDailyA(null); setDailyB(null); })}
        >
          {busy === 'emission' ? <Spinner /> : 'Update emission'}
        </button>
        {nextA !== null && nextB !== null && emissionChanged && <Calldata to={farm.address} data={farmTx.setEmissionRates(nextA, nextB)} label="setEmissionRates(a, b)" />}
      </Section>

      {/* funding */}
      <Section
        icon={<Coins size={18} />}
        title="Fund rewards"
        hint="The farm pays rewards only from tokens it holds. Anyone can send tokens to it; there is no function to take them back out, so send what you intend farmers to earn."
      >
        {(['a', 'b'] as const).map(which => {
          const sym = which === 'a' ? rewards.a.symbol : rewards.b.symbol;
          const dec = which === 'a' ? rewards.a.decimals : rewards.b.decimals;
          const inv = which === 'a' ? farm.inventoryA : farm.inventoryB;
          const rate = which === 'a' ? farm.rewardAPerSecond : farm.rewardBPerSecond;
          const run = which === 'a' ? inventoryRunA : inventoryRunB;
          const held = which === 'a' ? walletBalances.a : walletBalances.b;
          const missing = need(rate, inv.available);
          return (
            <div key={which} className="farm-fund">
              <div>
                <strong>{sym}</strong>
                <div style={{ ...muted, fontSize: '0.8rem' }}>
                  Available to pay: {formatUnits(inv.available, dec, 4)} &middot; lasts {run === null ? 'indefinitely (no emission)' : run >= DAYS(365) ? 'over a year' : `${(run / SECONDS_PER_DAY).toFixed(1)} days`}
                  {missing > 0n && <> &middot; 30 days needs <strong>{formatUnits(missing, dec, 2)}</strong> more</>}
                </div>
                <div style={{ ...muted, fontSize: '0.8rem' }}>
                  Your wallet: {held === undefined ? '—' : formatUnits(held, dec, 4)} {sym}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <input style={{ ...input, maxWidth: '10rem', fontFamily: 'monospace' }} inputMode="decimal" placeholder="0.0" value={fundText[which]} onChange={e => setFundText(t => ({ ...t, [which]: e.target.value }))} aria-label={`Amount of ${sym} to send`} />
                {held !== undefined && held > 0n && <button type="button" style={smallBtn} onClick={() => setFundText(t => ({ ...t, [which]: formatUnits(held, dec, dec) }))}>MAX</button>}
                <button type="button" className="btn-primary" disabled={busy !== null || !fundText[which].trim()} onClick={() => void fund(which)}>
                  {busy === `fund:${which}` ? <Spinner /> : `Send ${sym}`}
                </button>
              </div>
            </div>
          );
        })}
        <small style={muted}>Funding address: <AddrLink address={farm.address} /> <CopyButton text={farm.address} /></small>
      </Section>

      {/* ownership */}
      <Section
        icon={<KeyRound size={18} />}
        title="Transfer ownership"
        hint="Two steps: you nominate a new owner, then that address must accept. Until it does, you keep control, and you can nominate someone else."
      >
        <Field label="New owner (a multisig or the AMM timelock is safest)">
          <input style={{ ...input, fontFamily: 'monospace' }} value={newOwner} onChange={e => setNewOwner(e.target.value)} placeholder="0x00…" />
        </Field>
        {newOwner.trim() && !newOwnerValid && <Notice tone="danger">That is not a Cyprus-1 address (0x00…).</Notice>}
        {newOwnerValid && sameOwner && <Notice tone="info">That is already the owner.</Notice>}
        {newOwnerValid && !sameOwner && (
          <>
            <Notice tone="warn">
              Nominating <strong>{newOwner.trim()}</strong>. If you mistype it or nobody holds its key, nothing is lost (it never accepts) but you will have wasted a transaction. Once it accepts, <strong>you lose all control</strong> of this farm.
            </Notice>
            <Field label="Type TRANSFER to confirm">
              <input style={{ ...input, maxWidth: '12rem' }} value={confirmText} onChange={e => setConfirmText(e.target.value)} />
            </Field>
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || confirmText.trim() !== 'TRANSFER' || !isOwner}
              onClick={() => void send('transfer', 'Ownership nominated', farm.address, farmTx.transferOwnership(newOwner.trim())).then(ok => ok && (setNewOwner(''), setConfirmText('')))}
            >
              {busy === 'transfer' ? <Spinner /> : 'Nominate new owner'}
            </button>
            <Calldata to={farm.address} data={farmTx.transferOwnership(newOwner.trim())} label="transferOwnership(newOwner)" />
          </>
        )}
      </Section>

      {/* the Q0 + QAXE airdrop to Quainance BDELTA stakers: snapshot, plan, Merkle tree, deposit, claims */}
      <AirdropAdmin wallet={wallet} />
    </div>
  );
}
