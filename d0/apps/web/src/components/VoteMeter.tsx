import React from 'react';
import type { VotingProposalView } from '@darkorder/core';

/** Yes / no / abstain as one bar, with the support-threshold line drawn in. */
export const VoteMeter: React.FC<{ proposal: VotingProposalView; thresholdBps: number; totalSupply: bigint }> = ({ proposal, thresholdBps, totalSupply }) => {
  const voted = proposal.yes + proposal.no + proposal.abstain;
  const denom = voted > 0n ? voted : 1n;
  const pct = (v: bigint) => Number((v * 10_000n) / denom) / 100;
  const thresholdPct = thresholdBps / 100;
  const participationPct = totalSupply > 0n ? Number((voted * 10_000n) / totalSupply) / 100 : 0;

  return (
    <div>
      <div className="relative h-3 overflow-hidden rounded-full bg-ink-deep" role="img" aria-label={`yes ${pct(proposal.yes)}%, no ${pct(proposal.no)}%, abstain ${pct(proposal.abstain)}%`}>
        <div className="absolute inset-y-0 left-0 bg-emerald-400/80" style={{ width: `${pct(proposal.yes)}%` }} />
        <div className="absolute inset-y-0 bg-rose-400/80" style={{ left: `${pct(proposal.yes)}%`, width: `${pct(proposal.no)}%` }} />
        <div
          className="absolute inset-y-0 bg-bone-mute/50"
          style={{ left: `${pct(proposal.yes) + pct(proposal.no)}%`, width: `${pct(proposal.abstain)}%` }}
        />
        <div className="absolute inset-y-0 w-px bg-gold" style={{ left: `${thresholdPct}%` }} title={`support threshold ${thresholdPct}% of votes cast`} />
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-bone-mute">
        <span className="text-emerald-300">yes {pct(proposal.yes)}%</span>
        <span className="text-rose-300">no {pct(proposal.no)}%</span>
        <span>abstain {pct(proposal.abstain)}%</span>
        <span className="ml-auto">participation {participationPct}% of supply</span>
      </div>
    </div>
  );
};
