/**
 * DarkCircle admin console: tamper-evident action log
 * File: src/admin/auditLog.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION.
 *
 * Every admin action, allowed or refused, is appended here. Each entry carries the hash of the one before
 * it, so editing or deleting a line in the middle breaks every hash after it and verify() names the first
 * broken entry. The log is plain text on purpose (an auditor should be able to read it without the store's
 * passphrase), so it must never hold a secret: details are short strings written by this module's callers,
 * and anything shaped like a private key is scrubbed before it is written.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type AuditOutcome = "ok" | "denied" | "error";

export interface AuditEntry {
  seq: number;
  at: string;
  action: string;
  outcome: AuditOutcome;
  detail: string;
  prevHash: string;
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  entries: number;
  /** Sequence number of the first entry whose hash does not check out. */
  brokenAt?: number;
}

const GENESIS = "0".repeat(64);
const MAX_DETAIL = 400;

/** Scrubs anything that looks like a 32-byte secret (private key, seed) or a bearer token. */
export function scrub(text: string): string {
  return text
    .replace(/0x[0-9a-fA-F]{64}\b/g, "0x[redacted]")
    .replace(/\b[0-9a-fA-F]{64}\b/g, "[redacted]")
    .replace(/(passphrase|password|token|secret|seed)(["']?\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, MAX_DETAIL);
}

function hashOf(e: Omit<AuditEntry, "hash">): string {
  return crypto.createHash("sha256").update(`${e.seq}|${e.at}|${e.action}|${e.outcome}|${e.detail}|${e.prevHash}`).digest("hex");
}

export class AdminAuditLog {
  private readonly log: AuditEntry[] = [];
  private readonly file?: string;
  /** True when a log file existed and its chain did not verify at load. */
  public loadedTampered = false;

  constructor(file?: string) {
    this.file = file;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            this.log.push(JSON.parse(line) as AuditEntry);
          } catch {
            this.loadedTampered = true;
          }
        }
        if (!this.verify().ok) this.loadedTampered = true;
      }
    }
  }

  public append(action: string, outcome: AuditOutcome, detail = ""): AuditEntry {
    const prev = this.log[this.log.length - 1];
    const base: Omit<AuditEntry, "hash"> = {
      seq: (prev?.seq ?? 0) + 1,
      at: new Date().toISOString(),
      action,
      outcome,
      detail: scrub(detail),
      prevHash: prev?.hash ?? GENESIS
    };
    const entry: AuditEntry = { ...base, hash: hashOf(base) };
    this.log.push(entry);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    return entry;
  }

  /** Newest first. */
  public entries(limit = 100): AuditEntry[] {
    return this.log.slice(-limit).reverse();
  }

  public get size(): number {
    return this.log.length;
  }

  public verify(): AuditVerification {
    let prev = GENESIS;
    let expectedSeq = this.log.length > 0 ? this.log[0].seq : 1;
    for (const e of this.log) {
      const { hash, ...rest } = e;
      if (e.prevHash !== prev || e.seq !== expectedSeq || hashOf(rest) !== hash) return { ok: false, entries: this.log.length, brokenAt: e.seq };
      prev = hash;
      expectedSeq++;
    }
    return { ok: true, entries: this.log.length };
  }
}
