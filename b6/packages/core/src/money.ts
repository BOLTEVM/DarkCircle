import { formatUnits, parseUnits } from 'ethers';

/** Mirrors QuestateBrokerage: commission = price * bps / 10_000 (rounded down), seller gets the rest. */
export const BPS_DENOMINATOR = 10_000n;
export const MAX_COMMISSION_BPS = 1_000;

export interface Settlement {
  price: bigint;
  commission: bigint;
  sellerNet: bigint;
}

export function settlementFor(price: bigint, commissionBps: number): Settlement {
  if (price < 0n) throw new Error('Price cannot be negative.');
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > MAX_COMMISSION_BPS) {
    throw new Error(`Commission must be a whole number of basis points between 0 and ${MAX_COMMISSION_BPS}.`);
  }
  const commission = (price * BigInt(commissionBps)) / BPS_DENOMINATOR;
  return { price, commission, sellerNet: price - commission };
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/**
 * QUAI amount for display: thousands separators, at most `maxDecimals` decimals, trailing zeros
 * dropped. Never rounds a non-zero amount down to "0".
 */
export function formatQuai(wei: bigint, maxDecimals = 4): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const [whole = '0', frac = ''] = formatUnits(abs, 18).split('.');
  const shown = frac.slice(0, maxDecimals).replace(/0+$/, '');
  if (abs > 0n && whole === '0' && shown === '') {
    return `${negative ? '-' : ''}<0.${'0'.repeat(Math.max(maxDecimals - 1, 0))}1`;
  }
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${shown ? '.' + shown : ''}`;
}

/** Parses what a person typed ("1,250.5") into wei. Returns null for anything that is not a plain positive amount. */
export function parseQuai(input: string): bigint | null {
  const cleaned = input.replace(/[,\s_]/g, '');
  if (!/^\d+(\.\d{1,18})?$/.test(cleaned)) return null;
  try {
    return parseUnits(cleaned, 18);
  } catch {
    return null;
  }
}

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  });
}

/** USD value of a wei amount at `usdPerQuai`, or null when no price is known. */
export function quaiToUsd(wei: bigint, usdPerQuai: number | null): number | null {
  if (usdPerQuai === null || !Number.isFinite(usdPerQuai) || usdPerQuai <= 0) return null;
  return Number(formatUnits(wei, 18)) * usdPerQuai;
}
