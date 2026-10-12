import React from 'react';

/**
 * Page credit shown in the footer of every DarkSafe screen.
 *
 * Boltfont.png is black glyphs with white outlines, drawn for dark grounds. At 18 px the outline is
 * under a pixel, so the dashboard (always dark) shows it reversed.
 */
export const PoweredByBolt: React.FC<{ className?: string }> = ({ className = '' }) => (
  <div
    className={`flex items-center justify-end gap-2 text-[10px] uppercase tracking-widest text-slate-500 ${className}`}
    data-testid="powered-by-bolt"
  >
    <span>Powered by</span>
    <img
      src={`${import.meta.env.BASE_URL}Boltfont.png`}
      alt="BOLT"
      width={63}
      height={18}
      className="h-[18px] w-auto invert opacity-80 hover:opacity-100 transition-opacity"
    />
  </div>
);
