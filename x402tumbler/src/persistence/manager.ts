/**
 * DarkCircle: persistence manager
 * File: src/persistence/manager.ts
 *
 * Joins the snapshot codec to the encrypted store and adds the operational behaviour: debounced autosave
 * after state-changing actions, saves that are serialized and can never throw into the request that
 * triggered them, recovery that verifies before it adopts, and a status view for the operator.
 *
 * The passphrase is used once to open the store and is not retained; only the derived key is.
 */

import { EncryptedStore, type KdfParams, type ScanReport, type SnapshotInfo, type ScanEntry } from "./store.ts";
import { captureEnvironment, describeSnapshot, restoreEnvironment, verifyEnvironment, type SnapshotSummary, type VerifyReport } from "./snapshot.ts";
import type { MultiAssetEnvironment } from "../cli/context.ts";

export interface PersistenceOptions {
  dir: string;
  passphrase: string;
  keep?: number;
  kdf?: KdfParams;
  /** Wait this long after the last change before writing. 0 disables autosave. Default 750 ms. */
  autosaveDebounceMs?: number;
}

export interface PersistenceStatus {
  enabled: true;
  dir: string;
  storeId: string;
  autosave: boolean;
  snapshots: SnapshotInfo[];
  lastSavedAt: string | null;
  lastSavedSeq: number | null;
  lastError: string | null;
  saving: boolean;
  dirty: boolean;
}

export interface RecoveryResult {
  env: MultiAssetEnvironment;
  info: SnapshotInfo;
  summary: SnapshotSummary;
  verification: VerifyReport;
  /** Newer snapshots that could not be read and were skipped to reach this one. */
  skipped: ScanEntry[];
}

export class PersistenceManager {
  public readonly store: EncryptedStore;
  private readonly debounceMs: number;
  private timer: NodeJS.Timeout | null = null;
  private getEnv: (() => MultiAssetEnvironment) | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private lastSaved: SnapshotInfo | null = null;
  private lastError: string | null = null;
  private saving = false;
  private dirty = false;
  private closed = false;
  /** Called after an autosave finishes (tests and the API use it). */
  public onSaved?: (info: SnapshotInfo | null, error: Error | null) => void;

  private constructor(store: EncryptedStore, debounceMs: number) {
    this.store = store;
    this.debounceMs = debounceMs;
  }

  public static open(opts: PersistenceOptions): PersistenceManager {
    const store = EncryptedStore.open({ dir: opts.dir, passphrase: opts.passphrase, keep: opts.keep, kdf: opts.kdf });
    const m = new PersistenceManager(store, opts.autosaveDebounceMs ?? 750);
    const existing = store.list();
    m.lastSaved = existing.length ? existing[existing.length - 1] : null;
    return m;
  }

  public status(): PersistenceStatus {
    const snapshots = this.store.list();
    return {
      enabled: true,
      dir: this.store.dir,
      storeId: this.store.storeId,
      autosave: this.debounceMs > 0,
      snapshots,
      lastSavedAt: this.lastSaved?.createdAt ?? null,
      lastSavedSeq: this.lastSaved?.seq ?? null,
      lastError: this.lastError,
      saving: this.saving,
      dirty: this.dirty
    };
  }

  /** Serializes `fn` after every earlier save, so two writes never race for the same sequence number. */
  private enqueue<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Writes a snapshot now. Errors are thrown to the caller (and remembered in status). */
  public save(env: MultiAssetEnvironment): Promise<SnapshotInfo> {
    if (this.closed) return Promise.reject(new Error("ERR_PERSISTENCE_CLOSED"));
    // Capture synchronously so the snapshot is one consistent instant even if a request lands after this call.
    let plaintext: string;
    try {
      plaintext = captureEnvironment(env);
    } catch (err) {
      this.lastError = (err as Error).message;
      return Promise.reject(err);
    }
    return this.enqueue(() => {
      this.saving = true;
      try {
        const info = this.store.save(plaintext);
        this.lastSaved = info;
        this.lastError = null;
        this.dirty = false;
        return info;
      } catch (err) {
        this.lastError = (err as Error).message;
        throw err;
      } finally {
        this.saving = false;
      }
    });
  }

  /**
   * Saves `env` now and pins that snapshot, so retention can never delete it. Used before the running state
   * is discarded (a reset): the discarded state holds notes and the payee keys of open invoices, and would
   * otherwise age out of the retention window a few saves later.
   */
  public async preserve(env: MultiAssetEnvironment, reason: string): Promise<SnapshotInfo> {
    const info = await this.save(env);
    return this.enqueue(() => this.store.pin(info.seq, reason));
  }

  /** Registers where autosave reads the environment from (it changes when the API resets or restores). */
  public attach(getEnv: () => MultiAssetEnvironment): void {
    this.getEnv = getEnv;
  }

  /** Tells the manager that state changed. A save follows once things have been quiet for the debounce window. */
  public notifyChange(): void {
    if (this.closed || this.debounceMs <= 0 || !this.getEnv) return;
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Saves immediately if there are unsaved changes; never throws. */
  public async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.closed || !this.getEnv || !this.dirty) return;
    try {
      const info = await this.save(this.getEnv());
      this.onSaved?.(info, null);
    } catch (err) {
      this.onSaved?.(null, err as Error);
    }
  }

  public scan(): ScanReport {
    return this.store.scan();
  }

  /** Describes what a snapshot holds without building an environment (cheap). */
  public inspect(seq?: number): { info: SnapshotInfo; summary: SnapshotSummary } | null {
    const loaded = this.store.load(seq);
    return loaded ? { info: loaded.info, summary: describeSnapshot(loaded.plaintext) } : null;
  }

  /**
   * Restores the newest snapshot that both authenticates and verifies, falling back to older ones. Returns
   * null when the store holds none. The environment comes from `factory`, so nothing running is touched.
   */
  public recover(factory: () => MultiAssetEnvironment, seq?: number): RecoveryResult | null {
    const skipped: ScanEntry[] = [];
    const all = this.store.list().reverse().filter((s) => seq === undefined || s.seq === seq);
    for (const candidate of all) {
      const loaded = this.store.load(candidate.seq);
      if (!loaded) {
        skipped.push({ ...candidate, status: "corrupt", reason: "authentication failed (altered, damaged, or from another store)" });
        continue;
      }
      try {
        const { env, summary, verification } = restoreEnvironment(loaded.plaintext, factory);
        return { env, info: loaded.info, summary, verification, skipped };
      } catch (err) {
        const message = (err as Error).message;
        // An identity, network, schema or version mismatch is a configuration problem, not damage: older
        // snapshots would fail the same way, so stop instead of silently walking back in time.
        if (/^ERR_RESTORE_(IDENTITY|NETWORK|ASSETS|SCHEMA|VERSION)/.test(message)) throw err;
        skipped.push({ ...loaded.info, status: "corrupt", reason: message });
      }
    }
    if (all.length > 0 && skipped.length > 0) {
      throw new Error(`ERR_RECOVERY_FAILED: no snapshot could be restored (${skipped.map((s) => `#${s.seq}: ${s.reason}`).join("; ")})`);
    }
    return null;
  }

  /** Runs the coherence checks against a live environment (no snapshot involved). */
  public verify(env: MultiAssetEnvironment): VerifyReport {
    return verifyEnvironment(env);
  }

  /** Stops autosave, waits for any write in flight, and optionally flushes unsaved changes. */
  public async close(opts: { flush?: boolean } = {}): Promise<void> {
    if (opts.flush) await this.flush();
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.chain;
  }

  /** Deletes the store from disk (the caller must have confirmed). Closes the manager. */
  public async destroy(): Promise<void> {
    await this.close();
    this.store.destroy();
  }
}
