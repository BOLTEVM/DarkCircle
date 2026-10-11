/**
 * DarkCircle: encrypted snapshot store
 * File: src/persistence/store.ts
 *
 * Durable, encrypted storage for the state that must survive a restart: notes and their blinding factors,
 * single-use payee private keys, the journal. Losing the invoice registry strands funds on ephemeral
 * addresses, and leaking it hands them to whoever reads the disk, so the store is both.
 *
 *  - AES-256-GCM. The key comes from the operator's passphrase through scrypt; the passphrase is never
 *    written. A random per-store salt lives in store.json together with a small "check" ciphertext that
 *    lets a wrong passphrase be told apart from a corrupt file.
 *  - Every snapshot is its own file (snapshot-000007.dcs) with a fresh random IV. AAD binds the store id,
 *    format version, sequence number and timestamp, so a file cannot be swapped into another store or
 *    re-labelled as a newer one.
 *  - Writes are atomic: temp file in the same directory, fsync, rename. A snapshot file is never
 *    overwritten, so a crash mid-write leaves the previous snapshots intact; the last `keep` are retained.
 *  - A snapshot can be PINNED (a snapshot-000007.pin marker next to it): retention never deletes it. The
 *    API pins the state it is about to discard (a reset), so that history cannot age out a few saves later.
 *  - Recovery walks newest to oldest and takes the first snapshot that authenticates, reporting the
 *    corrupt ones it skipped.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const STORE_FORMAT = "darkcircle-store";
export const SNAPSHOT_FORMAT = "darkcircle-snapshot";
export const STORE_VERSION = 1;
export const MIN_PASSPHRASE_LENGTH = 12;

export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP's minimum for scrypt. Tests pass a cheaper value; production should keep this. */
export const DEFAULT_KDF: KdfParams = { N: 1 << 17, r: 8, p: 1 };

export interface StoreOptions {
  dir: string;
  passphrase: string;
  /** Snapshots kept after a successful save. */
  keep?: number;
  kdf?: KdfParams;
}

export interface SnapshotInfo {
  seq: number;
  file: string;
  createdAt: string;
  /** Encrypted size on disk. */
  bytes: number;
  /** Kept regardless of the retention count (see pin()). */
  pinned?: boolean;
  pinReason?: string;
}

export interface ScanEntry extends SnapshotInfo {
  status: "ok" | "corrupt";
  reason?: string;
}

export interface ScanReport {
  dir: string;
  storeId: string;
  entries: ScanEntry[];
  /** The snapshot recovery would use: the newest one that authenticates. */
  usable: SnapshotInfo | null;
  corrupt: number;
}

interface StoreMeta {
  format: typeof STORE_FORMAT;
  v: number;
  storeId: string;
  kdf: { name: "scrypt"; N: number; r: number; p: number; salt: string };
  check: { iv: string; tag: string; ct: string };
}

interface SnapshotFile {
  format: typeof SNAPSHOT_FORMAT;
  v: number;
  seq: number;
  createdAt: string;
  iv: string;
  tag: string;
  ct: string;
}

const CHECK_PLAINTEXT = "darkcircle-store-check";
const SNAP_RE = /^snapshot-(\d{6,})\.dcs$/;
const b64 = (b: Buffer) => b.toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64");

function assertPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`ERR_STORE_WEAK_PASSPHRASE: use at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
}

function deriveKey(passphrase: string, salt: Buffer, kdf: KdfParams): Buffer {
  return crypto.scryptSync(passphrase.normalize("NFKC"), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

const storeAad = (storeId: string) => Buffer.from(`${STORE_FORMAT}|v${STORE_VERSION}|${storeId}|check`);
const snapAad = (storeId: string, seq: number, createdAt: string) => Buffer.from(`${SNAPSHOT_FORMAT}|v${STORE_VERSION}|${storeId}|${seq}|${createdAt}`);

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): { iv: Buffer; tag: Buffer; ct: Buffer } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ct };
}

function unseal(key: Buffer, iv: Buffer, tag: Buffer, ct: Buffer, aad: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function writeAtomic(file: string, data: Buffer): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export class EncryptedStore {
  public readonly dir: string;
  public readonly storeId: string;
  private readonly key: Buffer;
  private readonly keep: number;

  private constructor(dir: string, storeId: string, key: Buffer, keep: number) {
    this.dir = dir;
    this.storeId = storeId;
    this.key = key;
    this.keep = keep;
  }

  /** Opens the store in `dir`, creating it on first use. A wrong passphrase throws ERR_STORE_WRONG_PASSPHRASE. */
  public static open(opts: StoreOptions): EncryptedStore {
    assertPassphrase(opts.passphrase);
    const dir = path.resolve(opts.dir);
    const keep = Math.max(1, opts.keep ?? 5);
    fs.mkdirSync(dir, { recursive: true });
    const metaFile = path.join(dir, "store.json");

    if (!fs.existsSync(metaFile)) {
      const populated = fs.readdirSync(dir).some((f) => SNAP_RE.test(f));
      if (populated) throw new Error("ERR_STORE_META_MISSING: snapshots exist but store.json is gone; they cannot be decrypted without its salt");
      const kdf = opts.kdf ?? DEFAULT_KDF;
      const salt = crypto.randomBytes(16);
      const storeId = crypto.randomBytes(8).toString("hex");
      const key = deriveKey(opts.passphrase, salt, kdf);
      const sealed = seal(key, Buffer.from(CHECK_PLAINTEXT), storeAad(storeId));
      const meta: StoreMeta = {
        format: STORE_FORMAT,
        v: STORE_VERSION,
        storeId,
        kdf: { name: "scrypt", N: kdf.N, r: kdf.r, p: kdf.p, salt: b64(salt) },
        check: { iv: b64(sealed.iv), tag: b64(sealed.tag), ct: b64(sealed.ct) }
      };
      writeAtomic(metaFile, Buffer.from(JSON.stringify(meta, null, 2)));
      return new EncryptedStore(dir, storeId, key, keep);
    }

    let meta: StoreMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    } catch {
      throw new Error("ERR_STORE_META_CORRUPT: store.json is not valid JSON");
    }
    if (meta.format !== STORE_FORMAT || meta.v !== STORE_VERSION || meta.kdf?.name !== "scrypt") {
      throw new Error("ERR_STORE_UNSUPPORTED: unknown store format or version");
    }
    const key = deriveKey(opts.passphrase, unb64(meta.kdf.salt), { N: meta.kdf.N, r: meta.kdf.r, p: meta.kdf.p });
    try {
      const check = unseal(key, unb64(meta.check.iv), unb64(meta.check.tag), unb64(meta.check.ct), storeAad(meta.storeId));
      if (check.toString() !== CHECK_PLAINTEXT) throw new Error("mismatch");
    } catch {
      throw new Error("ERR_STORE_WRONG_PASSPHRASE: the passphrase does not open this store (or store.json was altered)");
    }
    return new EncryptedStore(dir, meta.storeId, key, keep);
  }

  /** Whether `dir` already holds a store. */
  public static exists(dir: string): boolean {
    return fs.existsSync(path.join(path.resolve(dir), "store.json"));
  }

  private snapshotFiles(): Array<{ seq: number; file: string }> {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      // A vanished directory is a state to report (status, scan), not one to crash on; save() will fail loudly.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return names
      .map((f) => ({ f, m: SNAP_RE.exec(f) }))
      .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
      .map((x) => ({ seq: Number(x.m[1]), file: x.f }))
      .sort((a, b) => a.seq - b.seq);
  }

  private pinFile(seq: number): string {
    return path.join(this.dir, `snapshot-${String(seq).padStart(6, "0")}.pin`);
  }

  private describe(seq: number, file: string): SnapshotInfo {
    const full = path.join(this.dir, file);
    let createdAt = "";
    try {
      createdAt = (JSON.parse(fs.readFileSync(full, "utf8")) as SnapshotFile).createdAt ?? "";
    } catch {
      /* reported as corrupt by scan() */
    }
    const info: SnapshotInfo = { seq, file, createdAt, bytes: fs.statSync(full).size };
    if (fs.existsSync(this.pinFile(seq))) {
      info.pinned = true;
      try {
        info.pinReason = String(JSON.parse(fs.readFileSync(this.pinFile(seq), "utf8")).reason ?? "");
      } catch {
        info.pinReason = "";
      }
    }
    return info;
  }

  /** Marks snapshot `seq` as exempt from retention. The marker holds no secret (a reason and a time). */
  public pin(seq: number, reason: string): SnapshotInfo {
    const entry = this.snapshotFiles().find((s) => s.seq === seq);
    if (!entry) throw new Error(`ERR_SNAPSHOT_NOT_FOUND: no snapshot #${seq} to pin`);
    writeAtomic(this.pinFile(seq), Buffer.from(JSON.stringify({ seq, reason: String(reason).slice(0, 200), pinnedAt: new Date().toISOString() })));
    return this.describe(entry.seq, entry.file);
  }

  /** Headers only; nothing is decrypted. Oldest first. */
  public list(): SnapshotInfo[] {
    return this.snapshotFiles().map((s) => this.describe(s.seq, s.file));
  }

  /** Encrypts and durably writes a new snapshot, then prunes to `keep`. Returns its description. */
  public save(plaintext: string): SnapshotInfo {
    const files = this.snapshotFiles();
    const seq = (files.length ? files[files.length - 1].seq : 0) + 1;
    const createdAt = new Date().toISOString();
    const sealed = seal(this.key, zlib.gzipSync(Buffer.from(plaintext, "utf8")), snapAad(this.storeId, seq, createdAt));
    const body: SnapshotFile = { format: SNAPSHOT_FORMAT, v: STORE_VERSION, seq, createdAt, iv: b64(sealed.iv), tag: b64(sealed.tag), ct: b64(sealed.ct) };
    const file = `snapshot-${String(seq).padStart(6, "0")}.dcs`;
    writeAtomic(path.join(this.dir, file), Buffer.from(JSON.stringify(body)));
    // Retention counts only unpinned snapshots; a pinned one is never deleted here.
    const unpinned = this.snapshotFiles().filter((s) => !fs.existsSync(this.pinFile(s.seq)));
    for (const old of unpinned.slice(0, -this.keep)) fs.rmSync(path.join(this.dir, old.file), { force: true });
    return this.describe(seq, file);
  }

  private readSnapshot(seq: number, file: string): string {
    let body: SnapshotFile;
    try {
      body = JSON.parse(fs.readFileSync(path.join(this.dir, file), "utf8"));
    } catch {
      throw new Error("not valid JSON (truncated or damaged)");
    }
    if (body.format !== SNAPSHOT_FORMAT || body.v !== STORE_VERSION || body.seq !== seq) throw new Error("header does not match its file name");
    try {
      const plain = unseal(this.key, unb64(body.iv), unb64(body.tag), unb64(body.ct), snapAad(this.storeId, body.seq, body.createdAt));
      return zlib.gunzipSync(plain).toString("utf8");
    } catch {
      throw new Error("authentication failed (altered, damaged, or from another store)");
    }
  }

  /** Authenticates every snapshot and says which would be used for recovery. */
  public scan(): ScanReport {
    const entries: ScanEntry[] = [];
    for (const s of this.snapshotFiles()) {
      const info = this.describe(s.seq, s.file);
      try {
        this.readSnapshot(s.seq, s.file);
        entries.push({ ...info, status: "ok" });
      } catch (err) {
        entries.push({ ...info, status: "corrupt", reason: (err as Error).message });
      }
    }
    const good = entries.filter((e) => e.status === "ok");
    const usable = good.length ? good[good.length - 1] : null;
    return {
      dir: this.dir,
      storeId: this.storeId,
      entries,
      usable: usable ? { seq: usable.seq, file: usable.file, createdAt: usable.createdAt, bytes: usable.bytes } : null,
      corrupt: entries.length - good.length
    };
  }

  /**
   * Plaintext of snapshot `seq`, or of the newest one that authenticates. `skipped` lists newer snapshots
   * that could not be read, so recovery is never silent about falling back.
   */
  public load(seq?: number): { info: SnapshotInfo; plaintext: string; skipped: ScanEntry[] } | null {
    const candidates = this.snapshotFiles().reverse().filter((s) => seq === undefined || s.seq === seq);
    const skipped: ScanEntry[] = [];
    for (const s of candidates) {
      try {
        const plaintext = this.readSnapshot(s.seq, s.file);
        return { info: this.describe(s.seq, s.file), plaintext, skipped };
      } catch (err) {
        skipped.push({ ...this.describe(s.seq, s.file), status: "corrupt", reason: (err as Error).message });
      }
    }
    return null;
  }

  /** Deletes every snapshot and the store metadata. The key held by this object becomes useless. */
  public destroy(): void {
    for (const s of this.snapshotFiles()) {
      fs.rmSync(path.join(this.dir, s.file), { force: true });
      fs.rmSync(this.pinFile(s.seq), { force: true });
    }
    fs.rmSync(path.join(this.dir, "store.json"), { force: true });
    this.key.fill(0);
  }
}
