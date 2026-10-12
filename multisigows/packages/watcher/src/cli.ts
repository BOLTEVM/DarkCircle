#!/usr/bin/env node
import fs from 'node:fs';
import { QuaiRpcClient } from '@darksafe/core';
import { validateConfig, runWatcher, consoleSink, webhookSink, AlertSink } from './runner.js';

const USAGE = `Usage: darksafe-watch --config <watcher.json> [--once]

Polls DarkSafe v2 vaults at a confirmed depth and prints alerts as JSON lines (and POSTs them
to webhookUrl if configured). See packages/watcher/README.md for the config format.`;

async function main(argv: string[]): Promise<number> {
  const i = argv.indexOf('--config');
  if (argv.includes('--help') || i < 0 || !argv[i + 1]) {
    process.stdout.write(USAGE + '\n');
    return argv.includes('--help') ? 0 : 64;
  }
  const config = validateConfig(JSON.parse(fs.readFileSync(argv[i + 1]!, 'utf8')));
  const sinks: AlertSink[] = [consoleSink((l) => process.stdout.write(l + '\n'))];
  if (config.webhookUrl) sinks.push(webhookSink(config.webhookUrl));
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  await runWatcher({
    config,
    makeRpc: (url) => new QuaiRpcClient(url, { maxRetries: 2, timeoutMs: 30_000 }),
    sinks,
    log: (l) => process.stderr.write(l + '\n'),
    once: argv.includes('--once'),
    signal: controller.signal,
  });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
);
