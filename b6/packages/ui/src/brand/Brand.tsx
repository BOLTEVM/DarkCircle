import React from 'react';
import { cx } from '../components/primitives.js';

/**
 * Suite brand assets (0.png, Boltfont.png) are black glyphs with white outlines, drawn for dark
 * grounds. At small sizes the outline is under a pixel, so on this always-dark site they are
 * shown inverted. The filter sits on the <img> only, never on an element with its own background.
 */

export const BOLT_URL = 'https://boltevm.com';

export const BrandLockup: React.FC<{ assetBase: string; className?: string; size?: 'sm' | 'md' }> = ({ assetBase, className, size = 'md' }) => (
  <span className={cx('inline-flex items-center gap-2.5', className)}>
    <span className={cx('flex items-center justify-center rounded-md border border-gold/40 bg-ink-deep', size === 'sm' ? 'h-7 w-7' : 'h-9 w-9')}>
      <img src={`${assetBase}0.png`} alt="" className={cx('invert', size === 'sm' ? 'h-4' : 'h-5')} width={27} height={20} />
    </span>
    <span className={cx('font-display leading-none tracking-wide text-bone', size === 'sm' ? 'text-base' : 'text-xl')}>
      Dark<span className="text-gold">Questate</span>
    </span>
  </span>
);

export const PoweredByBolt: React.FC<{ assetBase: string; className?: string }> = ({ assetBase, className }) => (
  <a
    href={BOLT_URL}
    target="_blank"
    // noreferrer: the site sits next to wallet state, so no URL or opener leaks out
    rel="noopener noreferrer"
    className={cx('group inline-flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-bone-mute transition-colors hover:text-bone-dim', className)}
  >
    <span>Powered by</span>
    <img src={`${assetBase}Boltfont.png`} alt="BOLT" width={63} height={18} className="h-[18px] w-auto opacity-80 invert transition-opacity group-hover:opacity-100" />
  </a>
);
