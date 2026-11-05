import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Coins, Droplets, ExternalLink, PieChart, RefreshCw, ShieldCheck, TrendingUp } from 'lucide-react';
import {
  DEPLOYED,
  applySlippage,
  encodeApprove,
  encodeClaimWithdrawal,
  encodeDepositNative,
  encodeDepositWquai,
  encodeProcessWithdrawals,
  encodeRequestWithdrawal,
  formatUnits,
  liquidStakingRateE18,
  parseUnits,
  prepareContractCall,
  previewLiquidStakingDeposit,
  previewLiquidStakingRedeem,
  waitForReceipt,
  type LPReserves,
  type LiquidWithdrawalRequest,
  type PoolInfo
} from 'quai-service';
import { describeTxError } from './farmSend';
import { getQuaiProvider, sendWalletTransaction } from './providerUtils';
import { useLiquidStaking } from './useLiquidStaking';
import { AddrLink, Badge, Notice, box, muted, row, smallBtn } from './ui';

interface Props {
  walletAddress: string | null;
  pools: PoolInfo[];
  poolReserves: Record<string, LPReserves>;
  onConnect: () => void | Promise<void>;
  onDone: () => void;
}

const DEADLINE_SECONDS = 20 * 60;
const PROCESS_BATCH = 25n;
const amount = (value: string): bigint | null => {
  if (!value.trim()) return null;
  try {
    const parsed = parseUnits(value);
    return parsed >= 0n ? parsed : null;
  } catch {
    return null;
  }
};
const display = (value: bigint | null | undefined, decimals = 6): string =>
  value === null || value === undefined ? '—' : formatUnits(value, 18, decimals);
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);

export default function LiquidStakingPage({ walletAddress, pools, poolReserves, onConnect, onDone }: Props) {
  const vault = DEPLOYED.LIQUID_STAKING;
  const { snapshot, requests, status, yieldInfo, yieldError, error: readError, updatedAt, refreshing, refresh } = useLiquidStaking(vault, walletAddress);
  const [mode, setMode] = useState<'DEPOSIT' | 'WITHDRAW'>('DEPOSIT');
  const [asset, setAsset] = useState<'QUAI' | 'WQUAI'>('QUAI');
  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [slippage, setSlippage] = useState(0.5);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feeNote, setFeeNote] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const assetsIn = amount(depositAmount);
  const sharesOut = amount(withdrawAmount);
  const expectedShares = snapshot && assetsIn !== null ? previewLiquidStakingDeposit(assetsIn, snapshot.managedAssets, snapshot.shareSupply) : null;
  const expectedAssets = snapshot && sharesOut !== null ? previewLiquidStakingRedeem(sharesOut, snapshot.managedAssets, snapshot.shareSupply) : null;
  const protocolRate = snapshot ? liquidStakingRateE18(snapshot.managedAssets, snapshot.shareSupply) : null;
  const positionValue = snapshot?.wallet ? previewLiquidStakingRedeem(snapshot.wallet.shareBalance, snapshot.managedAssets, snapshot.shareSupply) : null;
  const backing = snapshot ? snapshot.idleAssets + snapshot.strategyAssets : null;
  const investedPct = snapshot && backing && backing > 0n ? Number((snapshot.strategyAssets * 10_000n) / backing) / 100 : null;

  const market = useMemo(() => {
    if (!snapshot) return { pool: null, rate: null as bigint | null };
    const pool = pools.find(p => p.dex === 'CIRCLESWAP' && p.tokens.includes('STQUAI') && p.tokens.includes('WQUAI')) ?? null;
    if (!pool) return { pool, rate: null };
    const reserves = poolReserves[pool.pair.toLowerCase()];
    if (!reserves) return { pool, rate: null };
    const stIs0 = reserves.token0.toLowerCase() === snapshot.stQUAI.toLowerCase();
    const st = BigInt(stIs0 ? reserves.reserve0 : reserves.reserve1);
    const w = BigInt(stIs0 ? reserves.reserve1 : reserves.reserve0);
    return { pool, rate: st > 0n && w > 0n ? (w * 10n ** 18n) / st : null };
  }, [pools, poolReserves, snapshot]);

  const marketPremium = useMemo(() => {
    if (!market.rate || !protocolRate || protocolRate <= 0n) return null;
    const pct = ((Number(market.rate) / Number(protocolRate)) - 1) * 100;
    return Number.isFinite(pct) ? pct : null;
  }, [market.rate, protocolRate]);

  const send = async (data: string, value: bigint = 0n, gasMultiplier = 1.35): Promise<string> => {
    if (!walletAddress || !vault || !snapshot) throw new Error('Connect a wallet and wait for the vault to load.');
    const provider = getQuaiProvider();
    if (!provider) throw new Error('No Quai wallet found. Install Pelagus and connect it.');
    const prepared = await prepareContractCall(walletAddress, vault, data, gasMultiplier, undefined, value);
    if (value > 0n && snapshot.wallet && snapshot.wallet.nativeBalance < value + prepared.maxFee) {
      throw new Error(`Keep enough QUAI for gas: this deposit needs up to ${formatUnits(value + prepared.maxFee, 18, 6)} QUAI including the maximum network fee.`);
    }
    setFeeNote(`Maximum network fee at the current gas price: ${formatUnits(prepared.maxFee, 18, 6)} QUAI. Unused gas is refunded.`);
    const hash = await sendWalletTransaction(provider, prepared.tx);
    setTxHash(hash);
    await waitForReceipt(hash);
    return hash;
  };

  const run = async (label: string, action: () => Promise<void>) => {
    if (!walletAddress) {
      await onConnect();
      return;
    }
    setBusy(label);
    setError(null);
    setFeeNote(null);
    setTxHash(null);
    try {
      await action();
      await refresh();
      onDone();
    } catch (e: any) {
      setError(describeTxError(e));
    } finally {
      setBusy(null);
    }
  };

  const deposit = () => run('Preparing deposit…', async () => {
    if (!snapshot || assetsIn === null || assetsIn <= 0n || !expectedShares || expectedShares <= 0n) throw new Error('Enter an amount that mints stQUAI.');
    const balance = asset === 'QUAI' ? snapshot.wallet?.nativeBalance : snapshot.wallet?.wquaiBalance;
    if (balance === undefined || assetsIn > balance) throw new Error(`Insufficient ${asset} balance.`);
    const minShares = applySlippage(expectedShares, slippage);
    if (asset === 'WQUAI') {
      if ((snapshot.wallet?.wquaiVaultAllowance ?? 0n) < assetsIn) {
        setBusy(`Approve exactly ${depositAmount} WQUAI for this deposit…`);
        const provider = getQuaiProvider();
        if (!provider || !walletAddress) throw new Error('No Quai wallet found.');
        const prepared = await prepareContractCall(walletAddress, snapshot.wquai, encodeApprove(vault!, assetsIn), 1.2);
        const approvalHash = await sendWalletTransaction(provider, prepared.tx);
        setTxHash(approvalHash);
        await waitForReceipt(approvalHash);
      }
      setBusy('Confirm the WQUAI deposit in your wallet…');
      await send(encodeDepositWquai(assetsIn, minShares, deadline()));
    } else {
      setBusy('Confirm the QUAI deposit in your wallet…');
      await send(encodeDepositNative(minShares, deadline()), assetsIn);
    }
    setDepositAmount('');
  });

  const requestWithdrawal = () => run('Preparing withdrawal request…', async () => {
    if (!snapshot || sharesOut === null || sharesOut <= 0n || !expectedAssets || expectedAssets <= 0n) throw new Error('Enter an stQUAI amount with redeemable value.');
    if ((snapshot.wallet?.shareBalance ?? 0n) < sharesOut) throw new Error('Insufficient stQUAI balance.');
    setBusy('Confirm the withdrawal request in your wallet…');
    await send(encodeRequestWithdrawal(sharesOut, applySlippage(expectedAssets, slippage), walletAddress!));
    setWithdrawAmount('');
  });

  const processWithdrawals = () => run('Preparing withdrawal liquidity…', async () => {
    setBusy('Confirm withdrawal processing in your wallet…');
    await send(encodeProcessWithdrawals(PROCESS_BATCH), 0n, 1.5);
  });

  const claim = (request: LiquidWithdrawalRequest) => run(`Preparing claim #${request.id}…`, async () => {
    setBusy(`Confirm claim #${request.id} in your wallet…`);
    await send(encodeClaimWithdrawal(request.id));
  });

  if (!vault) {
    return (
      <div className="liquid-staking-shell">
        <div className="glass-card">
          <h2 className="section-title"><Coins size={22} /> QUAI Liquid Staking</h2>
          <Notice tone="info">The audited yield strategy and liquid-staking vault have not been deployed yet. No staking transaction can be sent from this page.</Notice>
        </div>
      </div>
    );
  }

  const depositBalance = asset === 'QUAI' ? snapshot?.wallet?.nativeBalance : snapshot?.wallet?.wquaiBalance;
  const insufficientDeposit = assetsIn !== null && depositBalance !== undefined && assetsIn > depositBalance;
  const insufficientShares = sharesOut !== null && snapshot?.wallet && sharesOut > snapshot.wallet.shareBalance;
  const dueUnprocessed = requests.filter(r => !r.claimed && !r.processed && r.claimableAt * 1000n <= BigInt(now));

  return (
    <div className="liquid-staking-shell">
      <div className="liquid-staking-heading">
        <div>
          <div className="swap-eyebrow">Non-rebasing QUAI yield shares</div>
          <h2 className="section-title"><Coins size={24} style={{ color: 'var(--accent-neon)' }} /> QUAI Liquid Staking</h2>
          <p style={{ ...muted, fontSize: '0.85rem', lineHeight: 1.5 }}>Deposit QUAI or WQUAI for transferable stQUAI. Withdrawals use a fixed-value request and cooldown.</p>
        </div>
        <button type="button" style={smallBtn} onClick={() => void refresh()} disabled={refreshing || busy !== null}>
          <RefreshCw size={14} className={refreshing ? 'loader' : ''} /> Refresh
        </button>
      </div>

      <Notice tone="warn">
        <strong>Strategy risk, not validator staking.</strong> Quai uses proof of work. This vault’s yield and loss exposure come from its immutable external strategy; no APY is promised. Review the strategy before depositing. {snapshot && <>Strategy: <AddrLink address={snapshot.strategy} /></>}
      </Notice>

      {(status === 'loading' || status === 'error') && !snapshot && (
        <Notice tone={status === 'error' ? 'danger' : 'info'}>{status === 'error' ? readError : 'Reading the vault from Cyprus-1…'}</Notice>
      )}
      {readError && snapshot && <Notice tone="warn">Showing the last successful read from {updatedAt ? new Date(updatedAt).toLocaleTimeString() : 'earlier'}: {readError}</Notice>}

      <div className="liquid-staking-stats">
        <div className="glass-card"><span>Vault assets</span><strong>{display(snapshot?.managedAssets, 4)} QUAI</strong><small>Backing outstanding stQUAI; excludes fixed claims</small></div>
        <div className="glass-card"><span>stQUAI supply</span><strong>{display(snapshot?.shareSupply, 4)}</strong><small>Includes the permanently locked deployment seed</small></div>
        <div className="glass-card"><span>Protocol rate</span><strong>{protocolRate ? display(protocolRate, 8) : '—'}</strong><small>QUAI value of 1 stQUAI at the current vault rate</small></div>
        <div className="glass-card"><span>Your stQUAI</span><strong>{walletAddress ? display(snapshot?.wallet?.shareBalance, 6) : '—'}</strong><small>{walletAddress ? `Worth ${display(positionValue, 6)} QUAI at the vault rate` : 'Connect a wallet to see your position'}</small></div>
      </div>

      <div className="liquid-staking-grid">
        <section className="glass-card">
          <div className="liquid-staking-tabs" role="tablist" aria-label="Liquid staking action">
            <button type="button" role="tab" aria-selected={mode === 'DEPOSIT'} onClick={() => setMode('DEPOSIT')} disabled={busy !== null}><ArrowDownToLine size={16} /> Deposit</button>
            <button type="button" role="tab" aria-selected={mode === 'WITHDRAW'} onClick={() => setMode('WITHDRAW')} disabled={busy !== null}><ArrowUpFromLine size={16} /> Withdraw</button>
          </div>

          {mode === 'DEPOSIT' ? (
            <>
              <div style={{ ...box, marginBottom: '0.85rem' }}>
                <div style={{ ...row, fontSize: '0.75rem', ...muted, marginBottom: '0.5rem' }}>
                  <span>You deposit</span>
                  <span>Balance: {walletAddress ? display(depositBalance) : '—'}</span>
                </div>
                <div className="liquid-staking-amount">
                  <input aria-label="Deposit amount" inputMode="decimal" placeholder="0.0" value={depositAmount} disabled={busy !== null || !snapshot} onChange={e => setDepositAmount(e.target.value)} />
                  <button type="button" style={smallBtn} disabled={busy !== null || depositBalance === undefined || depositBalance <= 0n} onClick={() => setDepositAmount(formatUnits(depositBalance!, 18, 18))}>MAX</button>
                  <select aria-label="Deposit asset" value={asset} disabled={busy !== null} onChange={e => { setAsset(e.target.value as 'QUAI' | 'WQUAI'); setDepositAmount(''); }}>
                    <option value="QUAI">QUAI</option>
                    <option value="WQUAI">WQUAI</option>
                  </select>
                </div>
              </div>
              <div style={{ ...row, marginBottom: '0.75rem', fontSize: '0.82rem' }}><span style={muted}>Estimated stQUAI</span><strong>{display(expectedShares)}</strong></div>
              {asset === 'WQUAI' && <p className="liquid-staking-help">If needed, the wallet first approves exactly this WQUAI amount for the vault. No unlimited vault approval is used.</p>}
              {asset === 'QUAI' && <p className="liquid-staking-help">Leave enough native QUAI for the network fee. The transaction is simulated before your wallet opens.</p>}
              {insufficientDeposit && <Notice tone="danger">Insufficient {asset} balance.</Notice>}
              <Slippage value={slippage} onChange={setSlippage} disabled={busy !== null} />
              <button className="btn-primary liquid-staking-primary" type="button" onClick={deposit} disabled={busy !== null || !snapshot || (!!walletAddress && (assetsIn === null || assetsIn <= 0n || !expectedShares || expectedShares <= 0n || insufficientDeposit))}>
                {!walletAddress ? 'Connect Wallet' : busy && mode === 'DEPOSIT' ? 'Working…' : 'Deposit & Mint stQUAI'}
              </button>
            </>
          ) : (
            <>
              <div style={{ ...box, marginBottom: '0.85rem' }}>
                <div style={{ ...row, fontSize: '0.75rem', ...muted, marginBottom: '0.5rem' }}>
                  <span>You burn</span>
                  <span>Balance: {walletAddress ? display(snapshot?.wallet?.shareBalance) : '—'}</span>
                </div>
                <div className="liquid-staking-amount">
                  <input aria-label="Withdrawal stQUAI amount" inputMode="decimal" placeholder="0.0" value={withdrawAmount} disabled={busy !== null || !snapshot} onChange={e => setWithdrawAmount(e.target.value)} />
                  <button type="button" style={smallBtn} disabled={busy !== null || !snapshot?.wallet?.shareBalance} onClick={() => setWithdrawAmount(formatUnits(snapshot!.wallet!.shareBalance, 18, 18))}>MAX</button>
                  <strong style={{ padding: '0 0.4rem' }}>stQUAI</strong>
                </div>
              </div>
              <div style={{ ...row, marginBottom: '0.75rem', fontSize: '0.82rem' }}><span style={muted}>Fixed claim estimate</span><strong>{display(expectedAssets)} QUAI</strong></div>
              <p className="liquid-staking-help">Your stQUAI is burned when the request is submitted. Its QUAI value is then fixed; after {snapshot ? formatDelay(snapshot.withdrawalDelaySeconds) : 'the cooldown'}, claim native QUAI to this wallet.</p>
              {insufficientShares && <Notice tone="danger">Insufficient stQUAI balance.</Notice>}
              <Slippage value={slippage} onChange={setSlippage} disabled={busy !== null} />
              <button className="btn-primary liquid-staking-primary" type="button" onClick={requestWithdrawal} disabled={busy !== null || !snapshot || (!!walletAddress && (sharesOut === null || sharesOut <= 0n || !expectedAssets || expectedAssets <= 0n || Boolean(insufficientShares)))}>
                {!walletAddress ? 'Connect Wallet' : busy && mode === 'WITHDRAW' ? 'Working…' : 'Request Withdrawal'}
              </button>
            </>
          )}

          {busy && <Notice tone="info">{busy}</Notice>}
          {feeNote && !busy && <p className="liquid-staking-help">{feeNote}</p>}
          {error && <Notice tone="danger">{error}</Notice>}
          {txHash && !busy && !error && <Notice tone="ok">Transaction confirmed. <a className="link-hash" href={`https://quaiscan.io/tx/${txHash}`} target="_blank" rel="noreferrer">View transaction <ExternalLink size={11} /></a></Notice>}
        </section>

        <section className="glass-card">
          <h3 className="liquid-staking-card-title"><Droplets size={18} /> stQUAI market</h3>
          <div className="liquid-staking-detail"><span>AMM spot rate</span><strong>{market.rate ? `${display(market.rate, 8)} WQUAI` : 'No liquid pool quote'}</strong></div>
          <div className="liquid-staking-detail"><span>Protocol redemption rate</span><strong>{protocolRate ? `${display(protocolRate, 8)} QUAI` : '—'}</strong></div>
          <div className="liquid-staking-detail"><span>AMM premium / discount</span><strong>{marketPremium === null ? '—' : `${marketPremium >= 0 ? '+' : ''}${marketPremium.toFixed(2)}%`}</strong></div>
          <p className="liquid-staking-help">{market.pool ? 'The AMM rate is a spot quote before fees and price impact, not an instant redemption guarantee.' : 'There is no stQUAI / WQUAI pool yet, so the protocol withdrawal is the only exit.'} Protocol withdrawals follow the cooldown on the left.</p>
          <div style={{ marginTop: '1rem', borderTop: '1px solid var(--panel-border)', paddingTop: '0.85rem' }}>
            <div className="liquid-staking-detail"><span>Fixed claims outstanding</span><strong>{display(snapshot?.claimLiabilities, 4)} QUAI</strong></div>
            <div className="liquid-staking-detail"><span>Processed claim liquidity</span><strong>{display(snapshot?.processedLiabilities, 4)} QUAI</strong></div>
            <div className="liquid-staking-detail"><span>Vault</span><AddrLink address={vault} /></div>
            {snapshot && <div className="liquid-staking-detail"><span>stQUAI token</span><AddrLink address={snapshot.stQUAI} /></div>}
          </div>
        </section>
      </div>

      <section className="glass-card" style={{ marginTop: '1.25rem' }}>
        <h3 className="liquid-staking-card-title"><TrendingUp size={18} /> Yield &amp; allocation</h3>
        <div className="liquid-staking-grid">
          <div>
            <div className="liquid-staking-detail"><span>Realised yield since launch</span><strong>{formatApr(yieldInfo?.sinceLaunchApr)}</strong></div>
            <div className="liquid-staking-detail"><span>Trailing 7 days</span><strong>{yieldInfo && !yieldInfo.weekAgo ? 'Vault is under 7 days old' : formatApr(yieldInfo?.trailing7dApr)}</strong></div>
            <div className="liquid-staking-detail"><span>Rate at launch → now</span><strong>{yieldInfo ? `${display(yieldInfo.launch.rateE18, 8)} → ${display(yieldInfo.latest.rateE18, 8)} QUAI` : '—'}</strong></div>
            <div className="liquid-staking-detail"><span>Live since</span><strong>{yieldInfo ? new Date(yieldInfo.launch.timestamp * 1000).toLocaleDateString() : '—'}</strong></div>
            <p className="liquid-staking-help">Measured from the vault's own redemption rate on chain, annualised without compounding. Yield exists only when the strategy receives real revenue: there is no emission and no promised APY. {yieldError && !yieldInfo && <>({yieldError})</>}</p>
          </div>
          <div>
            <div className="liquid-staking-detail"><span><PieChart size={13} /> Idle buffer (vault WQUAI)</span><strong>{display(snapshot?.idleAssets, 4)} QUAI</strong></div>
            <div className="liquid-staking-detail"><span>In the yield strategy</span><strong>{display(snapshot?.strategyAssets, 4)} QUAI{investedPct !== null ? ` · ${investedPct.toFixed(2)}%` : ''}</strong></div>
            <div className="liquid-staking-detail"><span>Withdrawal cooldown</span><strong>{snapshot ? formatDelay(snapshot.withdrawalDelaySeconds) : '—'}</strong></div>
            <div className="liquid-staking-detail"><span>Status</span><strong>{!snapshot ? '—' : snapshot.vaultPaused ? 'Deposits paused' : snapshot.strategyPaused ? 'Open · strategy paused' : 'Open'}</strong></div>
            <div className="liquid-staking-detail"><span>Strategy</span>{snapshot ? <AddrLink address={snapshot.strategy} /> : <strong>—</strong>}</div>
            {snapshot?.facilitator && <div className="liquid-staking-detail"><span>Revenue facilitator</span><AddrLink address={snapshot.facilitator} /></div>}
            <p className="liquid-staking-help">The buffer pays claims directly; only the owner can move it into the strategy, and never below what processed claims need.</p>
          </div>
        </div>
      </section>

      <section className="glass-card" style={{ marginTop: '1.25rem' }}>
        <div className="liquid-staking-heading">
          <div><h3 className="liquid-staking-card-title"><ShieldCheck size={18} /> Your withdrawal requests</h3><p className="liquid-staking-help">Up to the latest 200 vault requests are scanned; only claims payable to this wallet appear.</p></div>
          {dueUnprocessed.length > 0 && <button type="button" style={smallBtn} onClick={processWithdrawals} disabled={busy !== null}>Process up to {PROCESS_BATCH.toString()} due requests</button>}
        </div>
        {!walletAddress ? <Notice tone="info">Connect your wallet to see withdrawal requests.</Notice> : requests.length === 0 ? <p style={{ ...muted, fontSize: '0.85rem' }}>No withdrawal requests for this wallet in the scanned history.</p> : (
          <div className="liquid-staking-requests">
            {requests.map(request => <RequestRow key={request.id.toString()} request={request} now={now} busy={busy !== null} onClaim={() => void claim(request)} />)}
          </div>
        )}
      </section>

      <p className="liquid-staking-footnote"><AlertTriangle size={13} /> stQUAI can lose value if the strategy loses assets. Smart-contract, liquidity, and strategy risks remain; review the immutable contracts before using the vault.</p>
    </div>
  );
}

function Slippage({ value, onChange, disabled }: { value: number; onChange: (value: number) => void; disabled: boolean }) {
  return (
    <label className="liquid-staking-slippage">Minimum-received protection
      <span><input aria-label="Slippage tolerance" type="number" min={0} max={50} step={0.1} value={value} disabled={disabled} onChange={e => onChange(Math.max(0, Math.min(50, Number(e.target.value) || 0)))} />% slippage</span>
    </label>
  );
}

function RequestRow({ request, now, busy, onClaim }: { request: LiquidWithdrawalRequest; now: number; busy: boolean; onClaim: () => void }) {
  const claimable = request.claimableAt * 1000n <= BigInt(now);
  const state = request.claimed ? 'Claimed' : !claimable ? 'Cooling down' : request.processed ? 'Ready' : 'Ready · processing may be needed';
  return (
    <div className="liquid-staking-request">
      <div><strong>Request #{request.id.toString()}</strong><span>{display(request.assets)} QUAI</span></div>
      <div><Badge severity={request.claimed ? 'neutral' : claimable ? 'ok' : 'info'}>{state}</Badge><span>{request.claimed ? 'Paid to this wallet' : claimable ? 'Cooldown complete' : `Claimable ${new Date(Number(request.claimableAt) * 1000).toLocaleString()}`}</span></div>
      {!request.claimed && <button type="button" style={smallBtn} onClick={onClaim} disabled={busy || !claimable}>Claim QUAI</button>}
    </div>
  );
}

function formatApr(apr: number | null | undefined): string {
  if (apr === null || apr === undefined) return '—';
  return `${apr.toFixed(2)}% APR`;
}

function formatDelay(seconds: bigint): string {
  if (seconds % 86400n === 0n) return `${seconds / 86400n} day${seconds === 86400n ? '' : 's'}`;
  if (seconds % 3600n === 0n) return `${seconds / 3600n} hour${seconds === 3600n ? '' : 's'}`;
  return `${seconds} seconds`;
}
