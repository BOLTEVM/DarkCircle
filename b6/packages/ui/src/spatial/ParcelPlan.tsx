import React, { useId, useMemo } from 'react';
import { formatArea, niceScaleMetres, parcelAreaSqm, parseParcelGeoJson, projectParcel } from '@darkquestate/core';
import { cx } from '../components/primitives.js';

export interface ParcelPlanProps {
  geoJson: string;
  /** Shown in the corner tag (usually the parcel id). */
  label?: string;
  className?: string;
  /** Compact: no scale bar or area readout (listing cards). */
  compact?: boolean;
  tone?: 'gold' | 'muted' | 'rose';
}

const W = 400;
const H = 260;

/**
 * The parcel boundary drawn as a site plan: true aspect ratio, north up, scale bar and area.
 * Pure SVG, so a page of listing cards costs no WebGL contexts.
 */
export const ParcelPlan: React.FC<ParcelPlanProps> = ({ geoJson, label, className, compact = false, tone = 'gold' }) => {
  // useId() contains colons, which break url(#...) references in some browsers.
  const hatchId = `hatch-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const plan = useMemo(() => {
    const parsed = parseParcelGeoJson(geoJson);
    if (!parsed.ok || !parsed.polygon) return null;
    const { points, metresPerUnit } = projectParcel(parsed.polygon, W, H, compact ? 0.16 : 0.14);
    const bar = niceScaleMetres(metresPerUnit * 90);
    return {
      d: points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ' Z',
      vertices: points.slice(0, -1),
      area: formatArea(parcelAreaSqm(parsed.polygon)),
      barUnits: bar / metresPerUnit,
      barLabel: bar >= 1000 ? `${bar / 1000} km` : `${bar} m`,
    };
  }, [geoJson, compact]);

  const stroke = tone === 'rose' ? '#fb7185' : tone === 'muted' ? '#7c7a73' : '#c9a45c';

  if (!plan) {
    return (
      <div className={cx('blueprint flex items-center justify-center text-xs text-bone-mute', className)} style={{ aspectRatio: `${W} / ${H}` }}>
        No boundary on record
      </div>
    );
  }

  return (
    <div className={cx('blueprint relative overflow-hidden', className)} style={{ aspectRatio: `${W} / ${H}` }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="absolute inset-0 h-full w-full" role="img" aria-label={`Parcel boundary${label ? ` of ${label}` : ''}, ${plan.area}`}>
        <defs>
          <pattern id={hatchId} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke={stroke} strokeOpacity="0.22" strokeWidth="1" />
          </pattern>
        </defs>
        <path d={plan.d} fill={`url(#${hatchId})`} stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" />
        <path d={plan.d} fill={stroke} fillOpacity="0.06" stroke="none" />
        {plan.vertices.map(([x, y], i) => (
          <rect key={i} x={x - 2.5} y={y - 2.5} width="5" height="5" fill="#0a0b0d" stroke={stroke} strokeWidth="1.2" />
        ))}
        {/* north arrow */}
        <g transform={`translate(${W - 26}, 24)`} opacity="0.85">
          <path d="M0,-12 L5,6 L0,2 L-5,6 Z" fill={stroke} />
          <text y="20" textAnchor="middle" fontSize="9" fill="#b9b6ad" fontFamily="ui-monospace, monospace">
            N
          </text>
        </g>
        {!compact && (
          <g transform={`translate(16, ${H - 16})`}>
            <line x1="0" y1="0" x2={plan.barUnits} y2="0" stroke="#b9b6ad" strokeWidth="1.5" />
            <line x1="0" y1="-4" x2="0" y2="4" stroke="#b9b6ad" strokeWidth="1.5" />
            <line x1={plan.barUnits} y1="-4" x2={plan.barUnits} y2="4" stroke="#b9b6ad" strokeWidth="1.5" />
            <text x={plan.barUnits + 6} y="3.5" fontSize="10" fill="#b9b6ad" fontFamily="ui-monospace, monospace">
              {plan.barLabel}
            </text>
          </g>
        )}
      </svg>
      {label && (
        <div className="absolute left-3 top-3 rounded border border-line bg-ink/80 px-2 py-0.5 font-mono text-[10px] tracking-wide text-bone-dim backdrop-blur">
          {label}
        </div>
      )}
      {!compact && (
        <div className="absolute bottom-2.5 right-3 rounded border border-line bg-ink/80 px-2 py-0.5 font-mono text-[10px] text-bone-dim backdrop-blur">
          {plan.area}
        </div>
      )}
    </div>
  );
};
