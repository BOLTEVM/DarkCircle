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
 * (`/api-quainance`) makes it work; in production the direct read is tried (it works the day Quainance allows it) and
 * otherwise the snapshot generated at build time is used and labelled with its date. It never invents data: when neither
 * is available the caller gets null and the page says the launchpad markets could not be read.
 */
export async function loadQuainanceCatalog(): Promise<CatalogLoad | null> {
  const base = import.meta.env.DEV ? '/api-quainance' : 'https://www.quainance.com';
  try {
    const res = await fetch(base + LIVE_PATH, { signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const parsed = parseCatalog(await res.json());
      if (parsed.launches.length > 0) {
        return { launches: parsed.launches, skipped: parsed.skipped, source: 'live', asOf: Math.floor(Date.now() / 1000) };
      }
    }
  } catch {
    /* blocked by CORS, offline or timed out: fall through to the snapshot */
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
