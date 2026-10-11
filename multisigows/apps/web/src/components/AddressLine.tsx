import React from 'react';
import { groupAddress } from '@safebuddy/core';

/**
 * Every address a user confirms is shown in full, in groups of four, with its address-book
 * label when there is one. Cyprus-1 addresses all start 0x00, so abbreviations are easy to spoof.
 */
export const AddressLine: React.FC<{ address: string; label?: string | null; testId?: string }> = ({ address, label, testId }) => (
  <div className="min-w-0">
    {label && <div className="text-[10px] font-semibold text-emerald-300">{label}</div>}
    <div className="font-mono text-[11px] text-slate-100 break-words leading-relaxed" data-testid={testId} title={address}>
      {groupAddress(address)}
    </div>
  </div>
);
