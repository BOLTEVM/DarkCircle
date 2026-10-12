// The polling scheduler: no overlap, no blanking, pause while hidden, back off on failure, ignore late replies.
// Run: node --test q0/apps/stats-app/test/pollScheduler.test.ts  (Node 22.18+/24 strips the types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, createPoller, deriveStatus, describeAge, withJitter, type PollContext, type PollEnv, type PollState } from '../src/pollScheduler.ts';

// ---------------------------------------------------------------------------------------------- fake world

/** Fake time and timers; `advance` runs due timers in order and lets promise callbacks settle between them. */
function world(start = 1_000_000) {
  let now = start;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const flags = { hidden: false, online: true, random: 0.5 };
  const env: PollEnv = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout: h => {
      timers.delete(h as number);
    },
    random: () => flags.random,
    isHidden: () => flags.hidden,
    isOnline: () => flags.online
  };
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    await settle();
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
      await settle();
    }
    now = target;
    await settle();
  };
  return { env, flags, advance, settle, timers, time: () => now };
}

/** A fetch whose replies the test releases by hand. */
function controlledFetch<T>() {
  const calls: { ctx: PollContext<T>; resolve: (v: T) => void; reject: (e: Error) => void }[] = [];
  const fetch = (ctx: PollContext<T>) =>
    new Promise<T>((resolve, reject) => {
      calls.push({ ctx, resolve, reject });
    });
  return { calls, fetch };
}

const mk = <T>(w: ReturnType<typeof world>, fetch: (ctx: PollContext<T>) => Promise<T>, over: Partial<Parameters<typeof createPoller<T>>[0]> = {}) => {
  const states: PollState<T>[] = [];
  const poller = createPoller<T>({ fetch, intervalMs: 30_000, env: w.env, onState: s => states.push(s), ...over });
  return { poller, states };
};

// ------------------------------------------------------------------------------------------------ pure helpers

test('backoff doubles from the base and is capped', () => {
  assert.equal(backoffDelay(1, 10_000, 300_000), 10_000);
  assert.equal(backoffDelay(2, 10_000, 300_000), 20_000);
  assert.equal(backoffDelay(3, 10_000, 300_000), 40_000);
  assert.equal(backoffDelay(6, 10_000, 300_000), 300_000);
  assert.equal(backoffDelay(60, 10_000, 300_000), 300_000);
  assert.equal(backoffDelay(0, 10_000, 300_000), 10_000);
});

test('jitter stays inside the stated band and never goes negative', () => {
  assert.equal(withJitter(1000, 0, 0.9), 1000);
  assert.equal(withJitter(1000, 0.1, 0.5), 1000);
  assert.equal(withJitter(1000, 0.1, 0), 900);
  assert.equal(withJitter(1000, 0.1, 1), 1100);
  assert.equal(withJitter(1000, 5, 0), 0); // jitter is clamped to 1, so at most the whole delay
});

test('status: loading until there is something, error when there is nothing and it failed, stale when old or failed', () => {
  const base = { updatedAt: 1000, now: 2000, staleAfterMs: 5000, lastFailed: false };
  assert.equal(deriveStatus({ ...base, hasData: false, updatedAt: null }), 'loading');
  assert.equal(deriveStatus({ ...base, hasData: false, updatedAt: null, lastFailed: true }), 'error');
  assert.equal(deriveStatus({ ...base, hasData: true }), 'live');
  assert.equal(deriveStatus({ ...base, hasData: true, now: 6000 }), 'live'); // exactly at the limit is still live
  assert.equal(deriveStatus({ ...base, hasData: true, now: 6001 }), 'stale');
  assert.equal(deriveStatus({ ...base, hasData: true, lastFailed: true }), 'stale');
});

test('ages read as a person would say them', () => {
  assert.equal(describeAge(null), 'not yet');
  assert.equal(describeAge(Number.NaN), 'not yet');
  assert.equal(describeAge(0), 'just now');
  assert.equal(describeAge(4_999), 'just now');
  assert.equal(describeAge(12_000), '12 s ago');
  assert.equal(describeAge(59_999), '59 s ago');
  assert.equal(describeAge(60_000), '1 min ago');
  assert.equal(describeAge(185_000), '3 min ago');
  assert.equal(describeAge(2 * 3_600_000), '2 h ago');
  assert.equal(describeAge(72 * 3_600_000), '3 days ago');
  assert.equal(describeAge(-5000), 'just now'); // a clock that stepped back is not a negative age
});

// --------------------------------------------------------------------------------------------- scheduling

test('runs at once, then every interval, never earlier', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch);
  poller.start();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].ctx.reason, 'initial');
  assert.equal(poller.getState().status, 'loading');
  f.calls[0].resolve(1);
  await w.settle();
  const s = poller.getState();
  assert.equal(s.status, 'live');
  assert.equal(s.data, 1);
  assert.equal(s.updatedAt, w.time());
  assert.equal(s.nextRunAt, w.time() + 30_000);

  await w.advance(29_999);
  assert.equal(f.calls.length, 1);
  await w.advance(1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].ctx.reason, 'schedule');
  assert.equal(f.calls[1].ctx.previous, 1);
  poller.stop();
});

test('never overlaps: a manual refresh, a visibility event and the timer all join the request in flight', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch);
  poller.start();
  assert.equal(f.calls.length, 1);

  const a = poller.refresh();
  const b = poller.refresh();
  poller.visibilityChanged();
  poller.networkChanged(true);
  await w.advance(120_000); // far past the interval while the first request is still pending
  assert.equal(f.calls.length, 1, 'one request in flight, ever');
  assert.equal(poller.getState().inFlight, true);

  f.calls[0].resolve(7);
  await Promise.all([a, b]);
  assert.equal(poller.getState().data, 7);
  assert.equal(f.calls.length, 1);
  poller.stop();
});

test('a failure keeps the last good value, marks it stale, and backs off 10 s, 20 s, 40 s...; success resets it', async () => {
  const w = world();
  const f = controlledFetch<string>();
  const { poller } = mk(w, f.fetch);
  poller.start();
  f.calls[0].resolve('good');
  await w.settle();
  assert.equal(poller.getState().status, 'live');

  await w.advance(30_000);
  assert.equal(f.calls.length, 2);
  f.calls[1].reject(new Error('node unreachable'));
  await w.settle();
  let s = poller.getState();
  assert.equal(s.data, 'good', 'the last good value is kept');
  assert.equal(s.status, 'stale');
  assert.equal(s.error, 'node unreachable');
  assert.equal(s.failures, 1);
  assert.equal(s.nextRunAt, w.time() + 10_000);

  await w.advance(10_000);
  assert.equal(f.calls.length, 3);
  f.calls[2].reject(new Error('still down'));
  await w.settle();
  s = poller.getState();
  assert.equal(s.failures, 2);
  assert.equal(s.nextRunAt, w.time() + 20_000);
  assert.equal(s.data, 'good');

  await w.advance(20_000);
  f.calls[3].resolve('better');
  await w.settle();
  s = poller.getState();
  assert.equal(s.status, 'live');
  assert.equal(s.data, 'better');
  assert.equal(s.error, null);
  assert.equal(s.failures, 0);
  assert.equal(s.nextRunAt, w.time() + 30_000, 'back to the normal interval');
  poller.stop();
});

test('with nothing to show, a failure is an error; the next success is live', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch);
  poller.start();
  f.calls[0].reject(new Error('boom'));
  await w.settle();
  assert.equal(poller.getState().status, 'error');
  assert.equal(poller.getState().data, null);
  await w.advance(10_000);
  f.calls[1].resolve(3);
  await w.settle();
  assert.equal(poller.getState().status, 'live');
  poller.stop();
});

test('the backoff is capped', async () => {
  const w = world();
  let n = 0;
  const { poller } = mk(w, async () => {
    n++;
    throw new Error('down');
  });
  poller.start();
  await w.settle();
  let last = 0;
  for (let i = 0; i < 12; i++) {
    const s = poller.getState();
    last = s.nextRunAt! - w.time();
    await w.advance(last);
  }
  assert.equal(last, 300_000);
  assert.ok(n >= 12);
  poller.stop();
});

// ------------------------------------------------------------------------------------- visibility and network

test('a hidden tab does not fetch; becoming visible fetches at once when one is due', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch);
  poller.start();
  f.calls[0].resolve(1);
  await w.settle();

  w.flags.hidden = true;
  await w.advance(30_000); // the timer fires, sees the tab hidden, goes idle
  assert.equal(f.calls.length, 1);
  assert.equal(poller.getState().nextRunAt, null);
  await w.advance(10 * 60_000);
  assert.equal(f.calls.length, 1, 'no requests while hidden');
  assert.equal(poller.getState().status, 'stale', 'the value aged out and says so');
  assert.equal(poller.getState().data, 1, 'but is still shown');

  w.flags.hidden = false;
  poller.visibilityChanged();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].ctx.reason, 'visible');
  f.calls[1].resolve(2);
  await w.settle();
  assert.equal(poller.getState().status, 'live');
  poller.stop();
});

test('becoming visible when nothing is due yet does not fetch, and the timer carries on', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch);
  poller.start();
  f.calls[0].resolve(1);
  await w.settle();
  await w.advance(10_000);
  w.flags.hidden = true;
  w.flags.hidden = false;
  poller.visibilityChanged();
  assert.equal(f.calls.length, 1);
  await w.advance(20_000);
  assert.equal(f.calls.length, 2);
  poller.stop();
});

test('a manual refresh works while hidden and during a backoff', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch);
  poller.start();
  f.calls[0].reject(new Error('x'));
  await w.settle();
  w.flags.hidden = true;
  const p = poller.refresh();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].ctx.reason, 'manual');
  f.calls[1].resolve(9);
  await p;
  assert.equal(poller.getState().data, 9);
  poller.stop();
});

test('offline: scheduled runs are skipped; coming back online fetches immediately and resets the backoff', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch);
  poller.start();
  f.calls[0].resolve(1);
  await w.settle();
  await w.advance(30_000);
  f.calls[1].reject(new Error('network'));
  await w.settle();
  w.flags.online = false;
  await w.advance(60_000);
  assert.equal(f.calls.length, 2, 'nothing sent while offline');

  w.flags.online = true;
  poller.networkChanged(true);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].ctx.reason, 'online');
  f.calls[2].resolve(5);
  await w.settle();
  assert.equal(poller.getState().failures, 0);
  assert.equal(poller.getState().status, 'live');
  poller.stop();
});

// ---------------------------------------------------------------------------------- lifecycle, late replies

test('stop aborts the request in flight, drops its late reply, and leaves no timers', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller, states } = mk(w, f.fetch);
  poller.start();
  const signal = f.calls[0].ctx.signal;
  assert.equal(signal.aborted, false);
  poller.stop();
  assert.equal(signal.aborted, true);

  const before = states.length;
  f.calls[0].resolve(99); // the network answers after unmount
  await w.settle();
  assert.equal(poller.getState().data, null, 'a late reply writes nothing');
  assert.equal(states.length, before, 'and notifies nobody');
  assert.equal(w.timers.size, 0, 'no timers left behind');
  await w.advance(10 * 60_000);
  assert.equal(f.calls.length, 1);
});

test('a reply from before a stop/start cycle cannot overwrite the new run', async () => {
  const w = world();
  const f = controlledFetch<string>();
  const { poller } = mk(w, f.fetch);
  poller.start();
  poller.stop();
  poller.start(); // React strict mode: mount, cleanup, mount
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve('new');
  await w.settle();
  f.calls[0].resolve('old'); // the abandoned request answers last
  await w.settle();
  assert.equal(poller.getState().data, 'new');
  poller.stop();
});

test('a value seeded from a cache is shown at once and not re-fetched until it is due', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch, { initial: { data: 42, updatedAt: w.time() - 10_000 } });
  poller.start();
  assert.equal(f.calls.length, 0, 'fresh enough: no request yet');
  assert.equal(poller.getState().data, 42);
  assert.equal(poller.getState().status, 'live');
  await w.advance(19_999);
  assert.equal(f.calls.length, 0);
  await w.advance(1);
  assert.equal(f.calls.length, 1);
  poller.stop();
});

test('an old seeded value is shown as stale while the first request runs', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch, { initial: { data: 42, updatedAt: w.time() - 10 * 60_000 } });
  poller.start();
  assert.equal(f.calls.length, 1);
  const s = poller.getState();
  assert.equal(s.data, 42);
  assert.equal(s.status, 'stale');
  assert.equal(s.inFlight, true);
  f.calls[0].resolve(43);
  await w.settle();
  assert.equal(poller.getState().status, 'live');
  poller.stop();
});

test('live turns stale by itself when the value ages out (no fetch needed to say so)', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller, states } = mk(w, f.fetch, { intervalMs: 30_000, staleAfterMs: 70_000 });
  poller.start();
  f.calls[0].resolve(1);
  await w.settle();
  w.flags.hidden = true;
  await w.advance(60_000);
  assert.equal(poller.getState().status, 'live');
  await w.advance(11_000);
  assert.equal(poller.getState().status, 'stale');
  assert.equal(states[states.length - 1].status, 'stale', 'subscribers are told');
  poller.stop();
});

test('setActive(false) stops the timer but keeps the value; true resumes and fetches when due', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch);
  poller.start();
  f.calls[0].resolve(1);
  await w.settle();
  poller.setActive(false);
  assert.equal(poller.getState().nextRunAt, null);
  await w.advance(5 * 60_000);
  assert.equal(f.calls.length, 1);
  assert.equal(poller.getState().data, 1);

  poller.setActive(true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].ctx.reason, 'resume');
  f.calls[1].resolve(2);
  await w.settle();
  // re-activating soon after a fetch just waits out the interval
  poller.setActive(false);
  await w.advance(5_000);
  poller.setActive(true);
  assert.equal(f.calls.length, 2);
  assert.equal(poller.getState().nextRunAt, w.time() + 25_000);
  poller.stop();
});

test('inactive from the start: one fetch so a value is ready, then no timer until it is activated', async () => {
  const w = world();
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch);
  poller.setActive(false);
  poller.start();
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve(4);
  await w.settle();
  assert.equal(poller.getState().data, 4);
  assert.equal(poller.getState().nextRunAt, null);
  assert.equal(w.timers.size <= 1, true, 'at most the staleness timer');
  await w.advance(10 * 60_000);
  assert.equal(f.calls.length, 1);
  poller.setActive(true);
  assert.equal(f.calls.length, 2, 'due, so it fetches on activation');
  poller.stop();
});

test('opened in a hidden tab: the first value is fetched, then nothing until the tab is visible', async () => {
  const w = world();
  w.flags.hidden = true;
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch);
  poller.start();
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve(8);
  await w.settle();
  assert.equal(poller.getState().data, 8);
  await w.advance(5 * 60_000);
  assert.equal(f.calls.length, 1);
  w.flags.hidden = false;
  poller.visibilityChanged();
  assert.equal(f.calls.length, 2);
  poller.stop();
});

test('offline at the start: nothing is sent, and coming online fetches', async () => {
  const w = world();
  w.flags.online = false;
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch);
  poller.start();
  assert.equal(f.calls.length, 0);
  assert.equal(poller.getState().status, 'loading');
  w.flags.online = true;
  poller.networkChanged(true);
  assert.equal(f.calls.length, 1);
  poller.stop();
});

test('a fetch that throws synchronously is a failure, not a crash', async () => {
  const w = world();
  const { poller } = mk<number>(w, () => {
    throw new Error('bad config');
  });
  poller.start();
  await w.settle();
  const s = poller.getState();
  assert.equal(s.status, 'error');
  assert.equal(s.error, 'bad config');
  assert.equal(s.inFlight, false);
  poller.stop();
});

test('jitter spreads the delay but keeps it inside the band', async () => {
  const w = world();
  w.flags.random = 1;
  const f = controlledFetch<number>();
  const { poller } = mk(w, f.fetch, { jitter: 0.1 });
  poller.start();
  f.calls[0].resolve(1);
  await w.settle();
  assert.equal(poller.getState().nextRunAt, w.time() + 33_000);
  poller.stop();
});
