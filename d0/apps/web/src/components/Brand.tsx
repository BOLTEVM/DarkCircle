import React from 'react';
import { cx } from './primitives.js';

/** The DarkOrder lockup: the DarkCircle suite sigil plus the wordmark. */
export const BrandLockup: React.FC<{ assetBase: string; size?: 'sm' | 'md'; className?: string }> = ({ assetBase, size = 'md', className }) => (
  <span className={cx('inline-flex items-center gap-2.5', className)}>
    <img src={`${assetBase}0.png`} alt="DarkCircle sigil" className={cx('rounded-full ring-1 ring-gold/30', size === 'sm' ? 'h-7 w-7' : 'h-9 w-9')} />
    <span className="leading-none">
      <span className={cx('block font-display tracking-wide text-bone', size === 'sm' ? 'text-base' : 'text-lg')}>DarkOrder</span>
      <span className="mt-0.5 block text-[10px] uppercase tracking-[0.22em] text-gold">Grand Guild Halls</span>
    </span>
  </span>
);

export const PoweredByBolt: React.FC<{ assetBase: string }> = ({ assetBase }) => (
  <span className="inline-flex items-center gap-2 text-bone-mute">
    <span>Powered by</span>
    <img src={`${assetBase}Boltfont.png`} alt="Bolt" className="h-4 opacity-80" />
  </span>
);
