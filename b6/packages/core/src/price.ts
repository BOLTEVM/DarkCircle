import type { FetchLike } from './rpc.js';

/**
 * QUAI/USD for display only. Nothing is ever priced, signed or settled from it: listings are in
 * QUAI and the contracts never see a dollar figure. When the price cannot be fetched the site
 * shows QUAI alone rather than a stale or invented number.
 *
 * Source: CoinGecko's public simple-price endpoint (id `quai-network`), which serves CORS.
 */
export const QUAI_USD_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=quai-network&vs_currencies=usd';

export interface UsdQuote {
  usdPerQuai: number;
  fetchedAt: number;
  source: 'CoinGecko';
}

export async function fetchQuaiUsd(fetchFn: FetchLike = (u, i) => globalThis.fetch(u, i), timeoutMs = 8_000): Promise<UsdQuote | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(QUAI_USD_URL, {
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { ['quai-network']?: { usd?: unknown } };
    const usd = body?.['quai-network']?.usd;
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return null;
    return { usdPerQuai: usd, fetchedAt: Date.now(), source: 'CoinGecko' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
