/**
 * DarkCircle admin console: build manifest
 * File: src/admin/deploy/manifest.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION.
 *
 * The record of what the pipeline produced: for every stage that has run, when, with what result, and the
 * SHA-256 of each input and output. Inputs are what makes staleness detectable: if circuits/unshield.circom
 * changes after the keys were made, the keys no longer belong to it, and every stage downstream of the
 * compile reports "stale" instead of quietly vouching for a mismatch.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface FileRef {
  /** Relative to the base (project root for sources, build directory for artifacts). */
  path: string;
  base: "project" | "build";
  sha256: string;
  bytes: number;
}

export interface StageRecord {
  id: string;
  status: "ok" | "failed";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  summary: string;
  details?: unknown;
  inputs: FileRef[];
  artifacts: FileRef[];
  warnings: string[];
}

export interface Manifest {
  version: 1;
  updatedAt: string;
  stages: Record<string, StageRecord>;
}

export const emptyManifest = (): Manifest => ({ version: 1, updatedAt: new Date(0).toISOString(), stages: {} });

export function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function refFor(base: FileRef["base"], baseDir: string, rel: string): FileRef {
  const full = path.join(baseDir, rel);
  return { path: rel.split(path.sep).join("/"), base, sha256: sha256File(full), bytes: fs.statSync(full).size };
}

export function readManifest(buildDir: string): Manifest {
  const file = path.join(buildDir, "manifest.json");
  if (!fs.existsSync(file)) return emptyManifest();
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
    return m.version === 1 && m.stages ? m : emptyManifest();
  } catch {
    return emptyManifest();
  }
}

export function writeManifest(buildDir: string, m: Manifest): void {
  fs.mkdirSync(buildDir, { recursive: true });
  const file = path.join(buildDir, "manifest.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...m, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, file);
}

/** Inputs whose current content no longer matches what the stage saw (or that have vanished). */
export function changedInputs(record: StageRecord, projectRoot: string, buildDir: string): string[] {
  const changed: string[] = [];
  for (const ref of [...record.inputs, ...record.artifacts]) {
    const full = path.join(ref.base === "project" ? projectRoot : buildDir, ref.path);
    if (!fs.existsSync(full) || sha256File(full) !== ref.sha256) changed.push(ref.path);
  }
  return changed;
}
