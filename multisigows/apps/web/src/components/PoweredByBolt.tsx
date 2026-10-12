import React from 'react';

/**
 * Page credit shown in the footer of every DarkSafe screen.
 *
 * Boltfont.png is black glyphs with white outlines, drawn for dark grounds. At 18 px the outline is
 * under a pixel, so the dashboard (always dark) shows it reversed.
 */
export const BOLT_URL = 'https://boltevm.com';

export const PoweredByBolt: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div
    className={`flex items-center justify-end text-[10px] uppercase tracking-widest text-slate-500 ${className}`}
    data-testid="powered-by-bolt"
  >
    {/* noreferrer: the dashboard sits next to wallet and vault state, so no URL or opener leaks out */}
    <a
      href={BOLT_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 hover:text-slate-300 transition-colors group"
    >
      <span>Powered by</span>
      <img
        src={`${import.meta.env.BASE_URL}Boltfont.png`}
        alt="BOLT"
        width={63}
        height={18}
        className="h-[18px] w-auto invert opacity-80 group-hover:opacity-100 transition-opacity"
      />
    </a>
  </div>
);
