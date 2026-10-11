/**
 * DarkCircle admin console: authentication
 * File: src/admin/auth.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION (scripts/redact-admin.ts removes this whole directory).
 *
 * The console is opt-in and sits behind a credential that is separate from the per-process UI session
 * token: reaching the page is not enough to use it.
 *
 *  - The admin token comes from DARKCIRCLE_ADMIN_TOKEN (24+ characters) or is generated at start-up and
 *    printed once on the server's own terminal. It is never put in a page, header or response.
 *  - Logging in exchanges the token for a random session id that lives in server memory only and in the
 *    browser's JavaScript memory only (no cookie, no localStorage), so it dies with the tab.
 *  - Sessions expire after 30 minutes idle and 8 hours absolute; at most 8 exist at once.
 *  - Failed logins are throttled globally (the API is loopback, so every caller looks like 127.0.0.1): five
 *    failures lock logins out, with the lockout doubling each time, and a correct token during a lockout is
 *    refused too so the lockout cannot be probed for the answer.
 */

import crypto from "node:crypto";

export const MIN_ADMIN_TOKEN_LENGTH = 24;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 8;

export interface AdminAuthOptions {
  token?: string;
  maxFailures?: number;
  lockoutMs?: number;
  maxLockoutMs?: number;
  idleMs?: number;
  absoluteMs?: number;
  now?: () => number;
}

export interface AdminSession {
  id: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
}

export type LoginResult =
  | { ok: true; session: string; expiresAt: number; idleMs: number }
  | { ok: false; reason: "BAD_TOKEN" | "LOCKED"; retryAfterMs?: number };

const digest = (s: string) => crypto.createHash("sha256").update(s).digest();

export class AdminAuth {
  /** Only the server's own start-up code may read this, to print it once. */
  public readonly token: string;
  public readonly generated: boolean;
  private readonly sessions = new Map<string, AdminSession>();
  private readonly maxFailures: number;
  private readonly lockoutMs: number;
  private readonly maxLockoutMs: number;
  private readonly idleMs: number;
  private readonly absoluteMs: number;
  private readonly now: () => number;
  private failures = 0;
  private lockouts = 0;
  private lockedUntil = 0;

  constructor(opts: AdminAuthOptions = {}) {
    const supplied = opts.token ?? process.env.DARKCIRCLE_ADMIN_TOKEN;
    if (supplied !== undefined && supplied !== "") {
      if (supplied.length < MIN_ADMIN_TOKEN_LENGTH) {
        throw new Error(`ERR_ADMIN_TOKEN_WEAK: the admin token must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`);
      }
      this.token = supplied;
      this.generated = false;
    } else {
      this.token = crypto.randomBytes(24).toString("hex");
      this.generated = true;
    }
    this.maxFailures = opts.maxFailures ?? 5;
    this.lockoutMs = opts.lockoutMs ?? 60_000;
    this.maxLockoutMs = opts.maxLockoutMs ?? 15 * 60_000;
    this.idleMs = opts.idleMs ?? SESSION_IDLE_MS;
    this.absoluteMs = opts.absoluteMs ?? SESSION_ABSOLUTE_MS;
    this.now = opts.now ?? Date.now;
  }

  private prune(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (s.expiresAt <= t) this.sessions.delete(id);
  }

  public login(candidate: unknown): LoginResult {
    const t = this.now();
    if (t < this.lockedUntil) return { ok: false, reason: "LOCKED", retryAfterMs: this.lockedUntil - t };
    const supplied = typeof candidate === "string" ? candidate : "";
    const ok = crypto.timingSafeEqual(digest(supplied), digest(this.token));
    if (!ok) {
      this.failures++;
      if (this.failures >= this.maxFailures) {
        this.lockouts++;
        const wait = Math.min(this.lockoutMs * 2 ** (this.lockouts - 1), this.maxLockoutMs);
        this.lockedUntil = t + wait;
        this.failures = 0;
        return { ok: false, reason: "LOCKED", retryAfterMs: wait };
      }
      return { ok: false, reason: "BAD_TOKEN" };
    }
    this.failures = 0;
    this.lockouts = 0;
    this.prune();
    if (this.sessions.size >= MAX_SESSIONS) {
      // drop the least recently used one rather than refusing the operator
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0];
      this.sessions.delete(oldest.id);
    }
    const id = crypto.randomBytes(32).toString("hex");
    const session: AdminSession = { id, createdAt: t, lastSeen: t, expiresAt: Math.min(t + this.idleMs, t + this.absoluteMs) };
    this.sessions.set(id, session);
    return { ok: true, session: id, expiresAt: session.expiresAt, idleMs: this.idleMs };
  }

  /** Returns the live session for `id` (sliding the idle window), or null. */
  public verify(id: unknown): AdminSession | null {
    if (typeof id !== "string" || id.length !== 64) return null;
    this.prune();
    const s = this.sessions.get(id);
    if (!s) return null;
    const t = this.now();
    s.lastSeen = t;
    s.expiresAt = Math.min(t + this.idleMs, s.createdAt + this.absoluteMs);
    return s;
  }

  public logout(id: unknown): boolean {
    return typeof id === "string" && this.sessions.delete(id);
  }

  public get activeSessions(): number {
    this.prune();
    return this.sessions.size;
  }
}
