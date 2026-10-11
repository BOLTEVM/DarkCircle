#!/usr/bin/env node
/**
 * DarkCircle CLI Executable Binary
 * File: bin/darkcircle.ts
 */

import { runCli } from "../src/cli/index.ts";

const result = await runCli(process.argv.slice(2));

if (result.stdout) {
  process.stdout.write(result.stdout + (result.stdout.endsWith("\n") ? "" : "\n"));
}
if (result.stderr) {
  process.stderr.write(result.stderr + (result.stderr.endsWith("\n") ? "" : "\n"));
}

process.exit(result.exitCode);
