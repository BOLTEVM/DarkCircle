import { formatUnits } from 'ethers';

/** 0x followed by the address in groups of four, so every character is easy to compare. */
export function groupAddress(address: string): string {
  const body = address.replace(/^0x/, '');
  return '0x ' + (body.match(/.{1,4}/g) ?? []).join(' ');
}

/**
 * Never shorter than 10 leading + 8 trailing characters. Every Cyprus-1 address starts
 * 0x00, so a 6+4 abbreviation leaves an attacker only ~7 hex characters to match.
 */
export function shortAddress(address: string): string {
  return address.length <= 20 ? address : `${address.slice(0, 10)}…${address.slice(-8)}`;
}

export function formatQuai(wei: bigint): string {
  return `${formatUnits(wei, 18)} QUAI`;
}

/** "3d 4h", "45m", "0s": exact to the minute for anything under a day. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0s';
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function formatUtc(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}
