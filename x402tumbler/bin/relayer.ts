#!/usr/bin/env node
/**
 * DarkCircle production relayer: process entry
 * File: bin/relayer.ts
 */

import { startRelayer } from "../src/relayer/index.ts";

const running = await startRelayer();
console.log(`[relayer] ready at ${running.http.url}; pool ${running.config.relay.poolAddress}`);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`[relayer] ${signal}: stopping`);
  await running.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
