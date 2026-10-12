import { Percent } from 'lucide-react';
import { DEPLOYED, type DexId } from 'quai-service';
import { Spinner, box, muted } from './ui';
import { pctText } from './YieldBoard';
import { useFarm } from './useFarm';
import { useYieldBoard } from './useYieldBoard';

/**
 * What the selected pool earns, shown inside the liquidity dialog so the yield is in front of anyone about to deposit.
 * Same numbers and same labels as the Farms page (one shared cache), never a separate calculation.
 */
export default function PoolYieldLine({ dex, symA, symB }: { dex: DexId; symA: string; symB: string }) {
  const { farm } = useFarm(DEPLOYED.MASTERCHEF, null);
  const board = useYieldBoard(farm);

  const row = board.rows.find(
    r => r.dex === dex && ((r.token0.symbol === symA && r.token1.symbol === symB) || (r.token0.symbol === symB && r.token1.symbol === symA))
  );

  if (board.status === 'loading') {
    return (
      <div style={{ ...box, marginBottom: '0.75rem', fontSize: '0.75rem', ...muted }}>
        <Spinner /> Reading this pool&apos;s yield…
      </div>
    );
  }
  if (board.status === 'error') return null;

  if (!row) {
    return (
      <div style={{ ...box, marginBottom: '0.75rem', fontSize: '0.75rem', ...muted, lineHeight: 1.45 }}>
        <strong style={{ color: '#fff' }}><Percent size={12} style={{ verticalAlign: 'middle' }} /> Yield</strong>
        <div style={{ marginTop: '0.25rem' }}>
          {symA} / {symB} has no pool yet, so there is no history. Whoever adds the first tokens earns the 0.30% fee on every swap; farm rewards start once the pool is added to the farm.
        </div>
      </div>
    );
  }

  const r = row.reward;
  return (
    <div style={{ ...box, marginBottom: '0.75rem', fontSize: '0.78rem', lineHeight: 1.5 }}>
      <div style={{ fontWeight: 700, color: '#fff', marginBottom: '0.25rem' }}>
        <Percent size={13} style={{ verticalAlign: 'middle', marginRight: '0.25rem' }} />
        {row.name} earns: <span style={{ color: row.totalApr ? 'var(--success)' : undefined }}>{pctText(row.totalApr)}</span>
        {row.totalAprBoosted !== null && <span style={{ ...muted, fontWeight: 400 }}> a year (up to {pctText(row.totalAprBoosted)} with QRB)</span>}
      </div>
      <div style={muted}>
        Trading fees <strong style={{ color: '#fff' }}>{pctText(row.feeApr)}</strong> ({row.swaps} swap{row.swaps === 1 ? '' : 's'} in {Math.round(row.windowDays)} days)
        {' · '}
        Farm rewards <strong style={{ color: '#fff' }}>{pctText(r.apr)}</strong>
        {r.status === 'FARMING' ? (r.projected ? ' (in the farm, nobody deposited yet)' : ' (in the farm)') : r.status === 'NOT_FARMING' ? ' (estimate: not in the farm yet)' : ''}
        {row.thin && ' · small pool: this moves a lot with each trade'}
      </div>
    </div>
  );
}
