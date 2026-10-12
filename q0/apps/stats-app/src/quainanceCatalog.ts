import { parseCatalog, type QuainanceLaunch } from 'quai-service';

export interface CatalogLoad {
  launches: QuainanceLaunch[];
  /** Entries the parser refused (bad address, symbol, decimals). */
  skipped: number;
  /** 'live': read from Quainance just now. 'snapshot': bundled at build time, so older; see `asOf`. */
  source: 'live' | 'snapshot';
  /** Unix seconds the data is from. */
  asOf: number | null;
}

const LIVE_PATH = '/api/trade-zone/catalog';

/**
 * Quainance's launchpad catalog (Hartii including QAXE, POOP, Quainance curves).
 *
 * The endpoint sends no CORS header, so a browser on another origin cannot read it: in development a Vite proxy
 * (`/api-quainance`) makes it work; in production the snapshot generated at build time (the deploy workflow refreshes it
 * first) is used and labelled with its date. It never invents data: when neither is available the caller gets null and
 * the page says the launchpad markets could not be read.
 */
export async function loadQuainanceCatalog(): Promise<CatalogLoad | null> {
  // Only development can reach the live feed (through the Vite proxy). In production the endpoint is blocked by CORS, so
  // asking would fail on every load: the snapshot, refreshed at every deploy, is read straight away.
  if (import.meta.env.DEV) {
    try {
      const res = await fetch('/api-quainance' + LIVE_PATH, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const parsed = parseCatalog(await res.json());
        if (parsed.launches.length > 0) {
          return { launches: parsed.launches, skipped: parsed.skipped, source: 'live', asOf: Math.floor(Date.now() / 1000) };
        }
      }
    } catch {
      /* the proxy is down or the feed is: fall through to the snapshot */
    }
  }
  try {
    const snap: { fetchedAt?: number; catalog?: unknown } = (await import('./quainanceCatalog.snapshot.json')).default as any;
    const parsed = parseCatalog(snap.catalog);
    if (parsed.launches.length > 0) {
      return { launches: parsed.launches, skipped: parsed.skipped, source: 'snapshot', asOf: typeof snap.fetchedAt === 'number' ? snap.fetchedAt : null };
    }
  } catch {
    /* no snapshot bundled */
  }
  return null;
}
