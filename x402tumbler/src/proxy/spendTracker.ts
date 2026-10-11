/**
 * DarkCircle: rolling spend tracker
 * File: src/proxy/spendTracker.ts
 *
 * Backs the spending policy's `dailyBudgetCap`. It is a separate object, owned by the lane rather than by
 * a SettlementCoordinator, because the CLI and the API build a fresh coordinator for every command: a
 * tracker that lived inside the coordinator started from zero on every payment, so the daily cap never
 * accumulated across calls. One tracker per lane (per asset pool) is shared by every coordinator that
 * spends from that lane, and it is part of the persisted state so a restart does not reset the budget.
 */

export interface SpendEntry {
  /** Milliseconds since the epoch. */
  at: number;
  /** Lowercase token address. */
  token: string;
  amount: bigint;
}

export const SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export class SpendTracker {
  private log: SpendEntry[] = [];
  private readonly windowMs: number;

  constructor(windowMs: number = SPEND_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  private prune(now: number): void {
    const since = now - this.windowMs;
    if (this.log.length > 0 && this.log[0].at < since) this.log = this.log.filter((e) => e.at >= since);
  }

  /** Total recorded for `token` inside the rolling window. */
  public spent(token: string, now: number = Date.now()): bigint {
    this.prune(now);
    const key = token.toLowerCase();
    return this.log.filter((e) => e.token === key).reduce((s, e) => s + e.amount, 0n);
  }

  /** Throws ERR_SPENDING_POLICY_DAILY_BUDGET_EXCEEDED when `amount` would take the window past `cap`. */
  public assertWithin(cap: bigint | undefined, token: string, amount: bigint, now: number = Date.now()): void {
    if (cap === undefined) return;
    const spent = this.spent(token, now);
    if (spent + amount > cap) {
      throw new Error(`ERR_SPENDING_POLICY_DAILY_BUDGET_EXCEEDED: ${spent} already spent in the last 24h, cap is ${cap}`);
    }
  }

  public record(token: string, amount: bigint, now: number = Date.now()): void {
    this.log.push({ at: now, token: token.toLowerCase(), amount });
  }

  /** A copy of the current window, for persistence and status displays. */
  public entries(now: number = Date.now()): SpendEntry[] {
    this.prune(now);
    return this.log.map((e) => ({ ...e }));
  }

  /** Replaces the log (used when restoring a snapshot). Entries outside the window are dropped. */
  public load(entries: SpendEntry[], now: number = Date.now()): void {
    this.log = entries.map((e) => ({ at: e.at, token: e.token.toLowerCase(), amount: e.amount }));
    this.prune(now);
  }
}
