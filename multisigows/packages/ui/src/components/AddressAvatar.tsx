import React, { useMemo } from 'react';
import { cn } from '../theme/tokens';

export type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export interface AddressAvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  address: string;
  size?: AvatarSize | number;
  showBadge?: boolean;
}

const sizeMap: Record<AvatarSize, number> = {
  xs: 20,
  sm: 28,
  md: 36,
  lg: 48,
  xl: 64,
};

/**
 * Deterministic PRNG seeded by address string to produce consistent visual avatar patterns.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function generatePalette(address: string): { bg: string; fg: string; accent: string } {
  const clean = address.toLowerCase().replace(/^0x/, '');
  const h1 = (hashString(clean.slice(0, 10)) % 360);
  const h2 = (h1 + 140) % 360;

  return {
    bg: `hsl(${h1}, 35%, 15%)`,
    fg: `hsl(${h1}, 75%, 65%)`,
    accent: `hsl(${h2}, 85%, 60%)`,
  };
}

export const AddressAvatar: React.FC<AddressAvatarProps> = ({
  address,
  size = 'md',
  showBadge = true,
  className,
  ...props
}) => {
  const pixelSize = typeof size === 'number' ? size : sizeMap[size];
  const isCyprus1 = address ? address.toLowerCase().startsWith('0x00') : false;

  // Generate 5x5 symmetric grid of blocks based on address characters
  const { grid, palette } = useMemo<{
    grid: boolean[][];
    palette: { bg: string; fg: string; accent: string };
  }>(() => {
    if (!address) {
      const emptyRow = [false, false, false, false, false];
      return {
        grid: [emptyRow, emptyRow, emptyRow, emptyRow, emptyRow],
        palette: { bg: '#1e293b', fg: '#64748b', accent: '#94a3b8' },
      };
    }

    const clean = address.toLowerCase().replace(/[^0-9a-f]/g, '');
    const palette = generatePalette(clean);
    const rows: boolean[][] = [];

    for (let y = 0; y < 5; y++) {
      const row: boolean[] = [];
      for (let x = 0; x < 3; x++) {
        const charCode = clean.charCodeAt((y * 3 + x) % clean.length) || 0;
        row.push((charCode % 2) === 1);
      }
      // Mirror columns 0 and 1 into columns 4 and 3 for horizontal symmetry
      rows.push([Boolean(row[0]), Boolean(row[1]), Boolean(row[2]), Boolean(row[1]), Boolean(row[0])]);
    }

    return { grid: rows, palette };
  }, [address]);

  return (
    <div
      className={cn('relative inline-flex shrink-0 select-none items-center justify-center', className)}
      style={{ width: pixelSize, height: pixelSize }}
      title={address || 'Unknown Address'}
      {...props}
    >
      <svg
        width={pixelSize}
        height={pixelSize}
        viewBox="0 0 100 100"
        className="rounded-full overflow-hidden border border-slate-700/80 shadow-sm"
        xmlns="http://www.w3.org/2000/svg"
        aria-label={`Identicon for ${address}`}
      >
        <rect width="100" height="100" fill={palette.bg} />
        {grid.map((row: boolean[], y: number) =>
          row.map((active: boolean, x: number) => {
            if (!active) return null;
            return (
              <rect
                key={`${x}-${y}`}
                x={x * 20}
                y={y * 20}
                width="20"
                height="20"
                fill={(x + y) % 2 === 0 ? palette.fg : palette.accent}
              />
            );
          })
        )}
      </svg>

      {/* Shard Indicator Dot Badge (Emerald ring for Cyprus-1 shard) */}
      {showBadge && isCyprus1 && (
        <span
          className="absolute -bottom-0.5 -right-0.5 rounded-full bg-emerald-500 ring-2 ring-slate-950 flex items-center justify-center"
          style={{
            width: Math.max(8, Math.round(pixelSize * 0.28)),
            height: Math.max(8, Math.round(pixelSize * 0.28)),
          }}
          title="Quai Network Cyprus-1 (0x00)"
          aria-hidden="true"
        />
      )}
    </div>
  );
};
