import { TOKEN_REGISTRY, fetchQuaiUsd, readExplorerFields } from 'quai-service';

const FRESH_MS = 5 * 60_000;
/** A price this old is still better than no USD figure at all, and the page is reading pool reserves either way. */
const STALE_OK_MS = 60 * 60_000;

let cached: { at: number; value: number } | null = null;
let inflight: Promise<number | null> | null = null;

/**
 * USD per QUAI, shared by every page: the pages that need it load together, and CoinGecko's free tier answers some of
 * those parallel calls with a 429. One cached lookup, with the explorer's own WQUAI price as the fallback source.
 */
export function resolveQuaiUsd(): Promise<number | null> {
  if (cached && Date.now() - cached.at < FRESH_MS) return Promise.resolve(cached.value);
  if (inflight) return inflight;
  inflight = (async () => {
    let value: number | null = await fetchQuaiUsd();
    if (value === null) {
      try {
        const fields = await readExplorerFields(TOKEN_REGISTRY.WQUAI.address);
        value = fields?.priceUsd ?? null;
      } catch {
        value = null;
      }
    }
    if (value !== null) cached = { at: Date.now(), value };
    else if (cached && Date.now() - cached.at < STALE_OK_MS) value = cached.value;
    return value;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
