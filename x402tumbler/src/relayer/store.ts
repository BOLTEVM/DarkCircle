/**
 * DarkCircle production relayer: durable relay store
 * File: src/relayer/store.ts
 *
 * Two jobs, both durable across a restart (RELAYER_PLAN.md phases 2 and 3):
 *  1. Idempotency per nullifier: a record keyed by nullifier remembers the transaction that was
 *     sent, so a retried request returns the original transaction instead of sending a second.
 *  2. The nonce hint: the next nonce the relayer may use. Persisted before a transaction is
 *     broadcast, so a crash or restart never reuses or skips a nonce.
 *
 * The file is written atomically (tmp + rename) on every mutation. It contains only public fields:
 * nullifiers, transaction hashes, fees, addresses. No notes, no keys, no witness data — the same
 * redaction rule as the logs (RELAYER_PLAN.md §5).
 */

import fs from "node:fs";
import path from "node:path";
import type { RelayRecord, RelayRecordStatus } from "./types.ts";

interface StoreFileV1 {
  version: 1;
  nonceHint: number;
  records: Record<string, RelayRecord>;
}

export class RelayStore {
  public readonly filePath: string;
  private state: StoreFileV1 = { version: 1, nonceHint: 0, records: {} };
  private dirty = false;

  constructor(filePath?: string) {
    // An in-memory store when no path is given (tests); durable when a path is configured.
    this.filePath = filePath ?? ":memory:";
    if (filePath && fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as StoreFileV1;
      if (raw.version !== 1 || typeof raw.nonceHint !== "number" || typeof raw.records !== "object") {
        throw new Error(`ERR_RELAYER_STORE: ${filePath} is not a v1 relay store`);
      }
      this.state = raw;
    }
  }

  public get nonceHint(): number {
    return this.state.nonceHint;
  }

  /** Records `next` as the next usable nonce and persists immediately. */
  public setNonceHint(next: number): void {
    if (next < 0) throw new Error("ERR_RELAYER_STORE: nonce hint cannot be negative");
    this.state.nonceHint = next;
    this.persist();
  }

  public get(nullifier: string): RelayRecord | undefined {
    return this.state.records[norm(nullifier)];
  }

  /** Inserts a record for a nullifier that has none. Throws NULLIFIER_RECORD_CONFLICT otherwise. */
  public insert(record: RelayRecord): RelayRecord {
    const key = norm(record.nullifier);
    if (this.state.records[key]) {
      throw new Error(`NULLIFIER_RECORD_CONFLICT: ${record.nullifier}`);
    }
    this.state.records[key] = { ...record };
    this.persist();
    return this.state.records[key];
  }

  /** Mutates an existing record and persists. */
  public update(nullifier: string, patch: Partial<RelayRecord>): RelayRecord {
    const key = norm(nullifier);
    const cur = this.state.records[key];
    if (!cur) throw new Error(`ERR_RELAYER_STORE: no record for nullifier ${nullifier}`);
    this.state.records[key] = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    this.persist();
    return this.state.records[key];
  }

  public all(): RelayRecord[] {
    return Object.values(this.state.records);
  }

  public byTxHash(txHash: string): RelayRecord | undefined {
    const h = txHash.toLowerCase();
    return this.all().find((r) => r.txHash?.toLowerCase() === h);
  }

  public inFlight(): RelayRecord[] {
    return this.all().filter((r) => IN_FLIGHT.has(r.status));
  }

  public flush(): void {
    if (this.dirty) this.persist();
  }

  private persist(): void {
    this.dirty = false;
    if (this.filePath === ":memory:") return;
    const tmp = this.filePath + `.tmp-${process.pid}`;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

const IN_FLIGHT: ReadonlySet<RelayRecordStatus> = new Set(["pending", "reorged"]);

function norm(nullifier: string): string {
  return nullifier.trim().toLowerCase();
}
