/**
 * DarkCircle voice: local speech-to-text
 * File: src/voice/transcriber.ts
 *
 * Runs Whisper (faster-whisper, scripts/whisper_worker.py) in a long-lived Python child process on THIS
 * machine, so a recorded command never leaves it. The worker loads its model with local_files_only, so it
 * never downloads anything by itself; when the model is missing the status says so and how to install it
 * (`pnpm voice:setup`). Audio goes to the worker through a private temporary file that is deleted as soon as
 * the clip is transcribed.
 *
 * Commands are short: a clip is limited in size here and to 30 seconds in the worker.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..", "..");
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
const START_TIMEOUT_MS = 120_000;
const CLIP_TIMEOUT_MS = 90_000;
const IDLE_MS = 10 * 60_000;
/** After a failed start (e.g. no model yet), try again on the next request once this has passed. */
const RETRY_AFTER_MS = 5_000;

export const AUDIO_TYPES: Record<string, string> = {
  "audio/webm": ".webm",
  "audio/ogg": ".ogg",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/mp4": ".m4a",
  "audio/mpeg": ".mp3"
};

export type TranscriberState = "idle" | "starting" | "ready" | "unavailable";

export interface TranscriberStatus {
  state: TranscriberState;
  model: string;
  modelDir: string;
  /** Whether the model's files are on disk (checked without loading it). */
  installed: boolean;
  /** Why it is unavailable, and what to do about it. */
  reason?: string;
  setup?: string;
}

export interface Transcript {
  text: string;
  durationSec: number;
  ms: number;
}

export interface TranscriberOptions {
  python?: string;
  model?: string;
  modelDir?: string;
  computeType?: string;
  threads?: number;
  workerScript?: string;
  /** Replaces the Python worker (tests). Must speak the same line protocol. */
  spawnWorker?: () => ChildProcess;
}

interface Waiter {
  resolve: (t: Transcript) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class LocalTranscriber {
  public readonly model: string;
  public readonly modelDir: string;
  private readonly opts: TranscriberOptions;
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private state: TranscriberState = "idle";
  private reason?: string;
  private failedAt = 0;
  private waiting = new Map<string, Waiter>();
  private idleTimer: NodeJS.Timeout | null = null;
  private buffer = "";

  constructor(opts: TranscriberOptions = {}) {
    this.opts = opts;
    this.model = opts.model ?? process.env.DARKCIRCLE_VOICE_MODEL ?? "base.en";
    this.modelDir = path.resolve(opts.modelDir ?? process.env.DARKCIRCLE_VOICE_MODEL_DIR ?? path.join(PROJECT_ROOT, ".darkcircle-voice", "models"));
  }

  /** The Hugging Face cache layout faster-whisper's download_model writes into `modelDir`. */
  public installed(): boolean {
    if (this.opts.spawnWorker) return true;
    const snapshots = path.join(this.modelDir, `models--Systran--faster-whisper-${this.model}`, "snapshots");
    try {
      return fs.readdirSync(snapshots).some((rev) => fs.existsSync(path.join(snapshots, rev, "model.bin")));
    } catch {
      return false;
    }
  }

  public status(): TranscriberStatus {
    const installed = this.installed();
    const s: TranscriberStatus = { state: installed || this.state === "ready" ? this.state : "unavailable", model: this.model, modelDir: this.modelDir, installed };
    if (!installed && this.state !== "ready") s.reason = s.reason ?? `the speech model '${this.model}' is not installed yet`;
    if (s.state === "unavailable") {
      s.reason = this.reason ?? s.reason;
      s.setup = "pnpm voice:setup -- --yes";
    }
    return s;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.state = "starting";
    this.buffer = "";
    this.ready = new Promise<void>((resolve, reject) => {
      const child = this.opts.spawnWorker
        ? this.opts.spawnWorker()
        : spawn(
            this.opts.python ?? process.env.DARKCIRCLE_PYTHON ?? "python",
            [this.opts.workerScript ?? path.join(PROJECT_ROOT, "scripts", "whisper_worker.py"), "--model", this.model, "--model-dir", this.modelDir, "--compute-type", this.opts.computeType ?? "int8", "--threads", String(this.opts.threads ?? 0)],
            { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
          );
      this.child = child;
      let settled = false;
      const fail = (message: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
        this.markUnavailable(message);
      };
      const timer = setTimeout(() => fail("the speech model did not load within 2 minutes"), START_TIMEOUT_MS);
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => {
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue; // library noise on stdout
          }
          if (msg.type === "ready") {
            clearTimeout(timer);
            settled = true;
            this.state = "ready";
            this.reason = undefined;
            resolve();
          } else if (msg.type === "fatal") {
            clearTimeout(timer);
            fail(msg.code === "MODEL_MISSING" ? `the speech model '${this.model}' is not installed yet` : String(msg.message));
          } else if (msg.type === "result" || msg.type === "error") {
            const w = this.waiting.get(String(msg.id));
            if (!w) continue;
            clearTimeout(w.timer);
            this.waiting.delete(String(msg.id));
            if (msg.type === "result") w.resolve({ text: String(msg.text ?? ""), durationSec: Number(msg.duration ?? 0), ms: Number(msg.ms ?? 0) });
            else w.reject(new Error(`ERR_TRANSCRIBE: ${msg.message}`));
          }
        }
      });
      child.stderr?.on("data", () => {
        /* model-loading chatter; failures arrive as protocol messages or an exit */
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        fail(`could not start Python (${err.message}); set DARKCIRCLE_PYTHON to a Python with faster-whisper installed`);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        for (const [id, w] of this.waiting) {
          clearTimeout(w.timer);
          w.reject(new Error("ERR_TRANSCRIBE: the speech worker stopped"));
          this.waiting.delete(id);
        }
        this.child = null;
        this.ready = null;
        if (this.state !== "unavailable") this.state = "idle";
        if (!settled) fail(`the speech worker exited (code ${code}) before it was ready`);
      });
    });
    return this.ready;
  }

  private markUnavailable(reason: string): void {
    this.state = "unavailable";
    this.reason = reason;
    this.failedAt = Date.now();
    this.ready = null;
    if (this.child && this.child.exitCode === null) this.child.kill();
  }

  /** Transcribes one recorded command. `hints` (contact and service names) steer recognition toward them. */
  public async transcribe(audio: Buffer, o: { mime: string; hints?: string[] }): Promise<Transcript> {
    const ext = AUDIO_TYPES[String(o.mime).split(";")[0].trim().toLowerCase()];
    if (!ext) throw new Error(`ERR_AUDIO_TYPE: ${o.mime} is not a supported recording format`);
    if (audio.length === 0) throw new Error("ERR_AUDIO_EMPTY: nothing was recorded");
    if (audio.length > MAX_AUDIO_BYTES) throw new Error("ERR_AUDIO_TOO_LARGE: keep a command under 30 seconds");
    if (this.state === "unavailable" && Date.now() - this.failedAt < RETRY_AFTER_MS) {
      throw new Error(`ERR_VOICE_UNAVAILABLE: ${this.reason}`);
    }
    try {
      await this.start();
    } catch (err) {
      throw new Error(`ERR_VOICE_UNAVAILABLE: ${(err as Error).message}`);
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-voice-"));
    const file = path.join(dir, `clip${ext}`);
    fs.writeFileSync(file, audio, { mode: 0o600 });
    const id = crypto.randomBytes(6).toString("hex");
    const hints = (o.hints ?? []).filter((h) => /^[\p{L}\p{N} .&'-]{1,40}$/u.test(h)).slice(0, 40);
    const prompt = `Voice commands for a Quai wallet: what's my balance, send 5 WQUAI to Acme, pay Acme 2 WQI, wrap 3 QUAI, unwrap 1 WQUAI, buy the report, confirm 4 1 7, cancel.${hints.length ? ` Names: ${hints.join(", ")}.` : ""}`;
    try {
      return await new Promise<Transcript>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting.delete(id);
          reject(new Error("ERR_TRANSCRIBE: no transcript within 90 s"));
        }, CLIP_TIMEOUT_MS);
        this.waiting.set(id, { resolve, reject, timer });
        this.child!.stdin!.write(JSON.stringify({ id, path: file, prompt, hotwords: ["QUAI", "WQUAI", "WQI", ...hints].join(" ") }) + "\n");
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      this.touch();
    }
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  public close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.child && this.child.exitCode === null) this.child.kill();
    this.child = null;
    this.ready = null;
    if (this.state === "ready" || this.state === "starting") this.state = "idle";
  }
}
