import { useCallback, useEffect, useRef, useState } from 'react';
import { createPoller, deriveStatus, type PollContext, type PollState, type PollStatus, type Poller } from './pollScheduler';

export type { PollContext, PollStatus } from './pollScheduler';

export interface PolledResource<T> {
  /** The last good value. Never blanked by a failure; null only until the first success (or a seeded value). */
  data: T | null;
  /** loading: nothing yet. live: fresh. stale: old, or the last try failed (the value is the last good one). error: nothing yet and it failed. */
  status: PollStatus;
  /** When `data` was last fetched successfully, ms since epoch. */
  updatedAt: number | null;
  /** The last failure's message, until the next success. */
  error: string | null;
  /** A request is in flight right now. */
  refreshing: boolean;
  /** Fetch now (a person asked); joins a request already in flight. */
  refresh: () => Promise<void>;
}

export interface UsePolledResourceOptions<T> {
  /** Time between fetches while the tab is visible. */
  intervalMs: number;
  /** A value older than this is "stale". Default: 2 intervals + 5 s. */
  staleAfterMs?: number;
  /** false: do not poll on a timer (the first value is still fetched, and a due one is fetched when this turns true). Default true. */
  active?: boolean;
  /** A value already known (cached): shown at once and not re-fetched until it is due. Read once, on mount. */
  initial?: () => { data: T; updatedAt: number } | null;
  /** Each delay varies by up to this fraction, so several tabs do not poll in step. Default 0.1. */
  jitter?: number;
}

/**
 * Keep a value fresh without blocking anything: it runs immediately, then every `intervalMs`, one request at a time,
 * paused while the tab is hidden or offline, resumed (and refreshed if due) the moment the tab is visible or online
 * again, backing off while the source fails and never discarding the last good value. All the scheduling is in
 * pollScheduler.ts, which has its own tests; this is only the React binding.
 */
export function usePolledResource<T>(fetcher: (ctx: PollContext<T>) => Promise<T>, options: UsePolledResourceOptions<T>): PolledResource<T> {
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const pollerRef = useRef<Poller<T> | null>(null);
  const { intervalMs, staleAfterMs, jitter = 0.1 } = options;
  const active = options.active !== false;
  const activeRef = useRef(active);
  activeRef.current = active;
  const initialRef = useRef(options.initial);

  const [state, setState] = useState<PollState<T>>(() => {
    const seed = options.initial?.() ?? null;
    return {
      data: seed ? seed.data : null,
      status: deriveStatus({
        hasData: seed !== null,
        updatedAt: seed ? seed.updatedAt : null,
        now: Date.now(),
        staleAfterMs: staleAfterMs ?? intervalMs * 2 + 5_000,
        lastFailed: false
      }),
      updatedAt: seed ? seed.updatedAt : null,
      error: null,
      failures: 0,
      inFlight: false,
      nextRunAt: null
    };
  });

  useEffect(() => {
    const poller = createPoller<T>({
      fetch: ctx => fetcherRef.current(ctx),
      intervalMs,
      staleAfterMs,
      jitter,
      initial: initialRef.current?.() ?? null,
      onState: setState
    });
    pollerRef.current = poller;
    poller.setActive(activeRef.current);
    poller.start();

    const onVisible = () => poller.visibilityChanged();
    const onOnline = () => poller.networkChanged(true);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('focus', onVisible);
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [intervalMs, staleAfterMs, jitter]);

  useEffect(() => {
    pollerRef.current?.setActive(active);
  }, [active]);

  const refresh = useCallback(() => pollerRef.current?.refresh() ?? Promise.resolve(), []);

  return {
    data: state.data,
    status: state.status,
    updatedAt: state.updatedAt,
    error: state.error,
    refreshing: state.inFlight,
    refresh
  };
}
