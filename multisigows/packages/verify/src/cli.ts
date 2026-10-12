#!/usr/bin/env node
import { QuaiRpcClient } from '@darksafe/core';
import { runVerify } from './run.js';

runVerify(process.argv.slice(2), {
  makeRpc: (url) => new QuaiRpcClient(url, { maxRetries: 2, timeoutMs: 20_000 }),
  write: (line) => process.stdout.write(line + '\n'),
}).then((code) => {
  process.exitCode = code;
});
