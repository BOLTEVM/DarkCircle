/**
 * Removes the admin console from a source tree before a production release.
 *
 *   node scripts/redact-admin.ts --check            verify a tree has no admin code left (exit 1 if it has)
 *   node scripts/redact-admin.ts --dry-run          list what would be removed and edited
 *   node scripts/redact-admin.ts --yes              redact this tree IN PLACE (deletes files; not undoable)
 *   node scripts/redact-admin.ts --root <dir> ...   act on another copy of the tree
 *   --keep-tool                                     do not delete this script and its package.json entry
 *
 * What "admin code" is: the directories below, and every block fenced with @admin:begin / @admin:end in a
 * source file (the API server, the UI shell, the start-up script, the docs). After redaction the project must
 * still type-check and pass its tests; test/admin/redaction.test.ts does exactly that on a temporary copy.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const option = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

// Spelled with a concatenation so this file does not trip its own residue scan.
const BEGIN = "@admin" + ":begin";
const END = "@admin" + ":end";

/** Deleted outright. */
const REMOVE_PATHS = ["src/admin", "ui/admin", "test/admin", "docs/ADMIN_CONSOLE.md"];
/** Scanned for fenced blocks and, in --check, for residue. */
const SCAN_ROOTS = ["src", "ui", "scripts", "test", "docs", "README.md", "AUDIT.md", "package.json", "tsconfig.json"];
const TEXT_EXT = new Set([".ts", ".js", ".mjs", ".html", ".css", ".md", ".json"]);
/** Substrings that mean admin code is still present. Checked case-sensitively. */
const RESIDUE = ["@admin" + ":", "/api/admin", "x-darkcircle-admin", "../admin/", "/admin/admin.", "src/admin", "ui/admin", "DARKCIRCLE_ADMIN"];
/**
 * Phrases checked case-insensitively: prose, not code, so it can drift outside a fenced block without
 * tripping the exact-case scan above (this is exactly how AUDIT.md leaked "admin console" in an unfenced
 * sentence once: the fenced-block scan for @admin: markers doesn't see prose written beside them).
 */
const RESIDUE_CI = ["admin console"];
const SELF = "scripts/redact-admin.ts";

export interface RedactionPlan {
  removePaths: string[];
  editedFiles: Array<{ file: string; blocks: number; lines: number }>;
  packageJson: string[];
}

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  const st = fs.statSync(dir);
  if (st.isFile()) return [dir];
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "build" || name.startsWith(".darkcircle")) continue;
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (root: string, p: string) => path.relative(root, p).split(path.sep).join("/");

function stripBlocks(text: string, file: string): { text: string; blocks: number; lines: number } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  let inside = false;
  let blocks = 0;
  let lines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.includes(BEGIN)) {
      if (inside) throw new Error(`${file}: nested ${BEGIN}`);
      inside = true;
      blocks++;
      lines++;
      continue;
    }
    if (line.includes(END)) {
      if (!inside) throw new Error(`${file}: ${END} without ${BEGIN}`);
      inside = false;
      lines++;
      continue;
    }
    if (inside) {
      lines++;
      continue;
    }
    out.push(line);
  }
  if (inside) throw new Error(`${file}: ${BEGIN} is never closed`);
  return { text: out.join(eol), blocks, lines };
}

export function planRedaction(root: string): RedactionPlan {
  const removePaths = REMOVE_PATHS.filter((p) => fs.existsSync(path.join(root, p)));
  const editedFiles: RedactionPlan["editedFiles"] = [];
  for (const r of SCAN_ROOTS) {
    for (const file of walk(path.join(root, r))) {
      if (!TEXT_EXT.has(path.extname(file)) || removePaths.some((p) => rel(root, file).startsWith(p))) continue;
      if (rel(root, file) === SELF) continue;
      const text = fs.readFileSync(file, "utf8");
      if (!text.includes(BEGIN)) continue;
      const r2 = stripBlocks(text, rel(root, file));
      editedFiles.push({ file: rel(root, file), blocks: r2.blocks, lines: r2.lines });
    }
  }
  const packageJson: string[] = [];
  const pj = path.join(root, "package.json");
  if (fs.existsSync(pj)) {
    const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
    for (const [k, v] of Object.entries<string>(pkg.scripts ?? {})) if (/admin/i.test(k) && !/redact-admin/.test(v)) packageJson.push(`remove script "${k}"`);
    if (/test\/admin\//.test(pkg.scripts?.test ?? "")) packageJson.push('drop test/admin from the "test" script');
  }
  return { removePaths, editedFiles, packageJson };
}

export function applyRedaction(root: string, opts: { keepTool?: boolean } = {}): RedactionPlan {
  const plan = planRedaction(root);
  for (const f of plan.editedFiles) {
    const p = path.join(root, f.file);
    fs.writeFileSync(p, stripBlocks(fs.readFileSync(p, "utf8"), f.file).text);
  }
  for (const p of plan.removePaths) fs.rmSync(path.join(root, p), { recursive: true, force: true });

  const pj = path.join(root, "package.json");
  if (fs.existsSync(pj)) {
    const raw = fs.readFileSync(pj, "utf8");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    const pkg = JSON.parse(raw);
    for (const [k, v] of Object.entries<string>(pkg.scripts ?? {})) {
      const isTool = /redact-admin/.test(v);
      if (isTool ? !opts.keepTool : /admin/i.test(k)) delete pkg.scripts[k];
    }
    if (pkg.scripts?.test) pkg.scripts.test = pkg.scripts.test.replace(/\s*test\/admin\/\*\.test\.ts/g, "");
    fs.writeFileSync(pj, JSON.stringify(pkg, null, 2).replace(/\n/g, eol) + eol);
  }
  if (!opts.keepTool) fs.rmSync(path.join(root, SELF), { force: true });
  return plan;
}

/** Everything that still mentions the admin console. Empty means the tree is clean. */
export function findResidue(root: string): string[] {
  const found: string[] = [];
  for (const p of REMOVE_PATHS) if (fs.existsSync(path.join(root, p))) found.push(`${p} still exists`);
  for (const r of SCAN_ROOTS) {
    for (const file of walk(path.join(root, r))) {
      if (!TEXT_EXT.has(path.extname(file))) continue;
      const name = rel(root, file);
      if (name === SELF) continue;
      const text = fs.readFileSync(file, "utf8");
      for (const needle of RESIDUE) if (text.includes(needle)) found.push(`${name}: contains "${needle}"`);
      const lower = text.toLowerCase();
      for (const needle of RESIDUE_CI) if (lower.includes(needle)) found.push(`${name}: contains "${needle}" (case-insensitive)`);
    }
  }
  return found;
}

function main(): void {
  const root = path.resolve(option("--root") ?? path.join(HERE, ".."));
  if (flag("--check")) {
    const residue = findResidue(root);
    if (residue.length === 0) {
      console.log(`clean: no admin console code found under ${root}`);
      return;
    }
    console.error(`admin console code is still present under ${root}:\n  ${residue.join("\n  ")}`);
    process.exit(1);
  }
  const plan = planRedaction(root);
  const describe = () => {
    console.log(`root: ${root}`);
    for (const p of plan.removePaths) console.log(`  delete  ${p}`);
    for (const f of plan.editedFiles) console.log(`  strip   ${f.file}  (${f.blocks} block${f.blocks === 1 ? "" : "s"}, ${f.lines} lines)`);
    for (const p of plan.packageJson) console.log(`  package.json: ${p}`);
    if (!flag("--keep-tool")) console.log(`  delete  ${SELF}`);
  };
  if (flag("--dry-run") || !flag("--yes")) {
    describe();
    if (!flag("--dry-run")) {
      console.error("\nThis deletes files and rewrites sources in place and cannot be undone. Re-run with --yes to do it (or --root <copy> to try it on a copy first).");
      process.exit(1);
    }
    return;
  }
  applyRedaction(root, { keepTool: flag("--keep-tool") });
  describe();
  const residue = findResidue(root);
  if (residue.length) {
    console.error(`\nredaction finished but residue remains:\n  ${residue.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\ndone. Run `pnpm lint` and `pnpm test` on the result, then `node scripts/redact-admin.ts --check` (if you kept the tool).");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
