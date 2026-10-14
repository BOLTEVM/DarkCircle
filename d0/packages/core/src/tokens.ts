import type { NetworkName } from './config.js';

/**
 * The tokens DarkOrder speaks for x402 tribute and challenges. Addresses are identity:
 * Quai has unrelated contracts sharing symbols, so a symbol is only a lookup key into this
 * registry, and any address outside it is unknown.
 *
 * Verified against the DarkCircle suite registry (read back from the Cyprus-1 RPC):
 *   WQUAI 0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB  "Wrapped Quai" 18 decimals (mainnet only)
 *   WQI   0x002b2596EcF05C93a31ff916E8b456DF6C77c750  "Wrapped Qi"   18 decimals (mainnet + Orchard)
 */

export interface KnownToken {
  symbol: string;
  /** EIP-55 checksummed contract address. */
  address: string;
  decimals: number;
  networks: Array<Exclude<NetworkName, 'local'>>;
}

export const WQUAI: KnownToken = {
  symbol: 'WQUAI',
  address: '0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB',
  decimals: 18,
  networks: ['mainnet'],
};

export const WQI: KnownToken = {
  symbol: 'WQI',
  address: '0x002b2596EcF05C93a31ff916E8b456DF6C77c750',
  decimals: 18,
  networks: ['mainnet', 'orchard'],
};

export const KNOWN_TOKENS: KnownToken[] = [WQUAI, WQI];

export function tokensOn(network: NetworkName): KnownToken[] {
  if (network === 'local') return [];
  return KNOWN_TOKENS.filter((t) => t.networks.includes(network));
}

export function tokenByAddress(network: NetworkName, address: string): KnownToken | null {
  const lower = address.toLowerCase();
  return tokensOn(network).find((t) => t.address.toLowerCase() === lower) ?? null;
}

export function tokenBySymbol(network: NetworkName, symbol: string): KnownToken | null {
  const want = symbol.trim().toUpperCase();
  return tokensOn(network).find((t) => t.symbol === want) ?? null;
}

/** Decimal string -> base units, no floats, padding or truncating to the token's decimals. */
export function parseTokenAmount(decimal: string, decimals = 18): bigint {
  const trimmed = decimal.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`"${decimal}" is not a valid amount.`);
  const [intPart, fracRaw = ''] = trimmed.split('.');
  const frac = fracRaw.length > decimals ? fracRaw.slice(0, decimals) : fracRaw.padEnd(decimals, '0');
  const value = BigInt((intPart === '' ? '0' : intPart) + frac || '0');
  return value;
}

/** Base units -> trimmed decimal string. */
export function formatTokenAmount(value: bigint, decimals = 18): string {
  const negative = value < 0n;
  const v = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const int = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${int.toString()}${frac ? `.${frac}` : ''}`;
}
