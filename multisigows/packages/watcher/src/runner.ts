import fs from 'node:fs';
import path from 'node:path';
import { getAddress, parseUnits } from 'ethers';
import {
  RpcLike,
  ReadSource,
  getNetworkConfig,
  resolveDeployment,
  isCyprus1QuaiAddress,
  readBlockNumber,
} from '@safebuddy/core';
import { Alert, WatcherState, emptyState, pollOnce } from './poll.js';

export interface WatcherConfig {
  network: 'mainnet' | 'testnet';
  rpc?: string[];
  factory?: string;
  vaults: string[];
  confirmations?: number;
  pollSeconds?: number;
  stateFile: string;
  webhookUrl?: string;
  heartbeatMinutes?: number;
  largeValueQuai?: string;
}

/** Validates a parsed config file; throws with every problem at once. */
export function validateConfig(raw: any): WatcherConfig {
  const problems: string[] = [];
  if (!raw || typeof raw !== 'object') throw new Error('The config must be a JSON object.');
  if (raw.network !== 'mainnet' && raw.network !== 'testnet') problems.push('network must be "mainnet" or "testnet"');
  if (!Array.isArray(raw.vaults) || raw.vaults.length === 0) problems.push('vaults must list at least one vault address');
  else raw.vaults.forEach((v: unknown, i: number) => typeof v === 'string' && isCyprus1QuaiAddress(v) ? null : problems.push(`vaults[${i}] is not a Cyprus-1 Quai address`));
  if (raw.rpc !== undefined && (!Array.isArray(raw.rpc) || raw.rpc.some((u: unknown) => typeof u !== 'string' || !/^https?:\/\//.test(u)))) {
    problems.push('rpc must be a list of http(s) URLs');
  }
  if (raw.factory !== undefined && (typeof raw.factory !== 'string' || !isCyprus1QuaiAddress(raw.factory))) problems.push('factory is not a Cyprus-1 Quai address');
  if (raw.confirmations !== undefined && (!Number.isInteger(raw.confirmations) || raw.confirmations < 1 || raw.confirmations > 100)) {
    problems.push('confirmations must be 1-100');
  }
  if (raw.pollSeconds !== undefined && (!Number.isFinite(raw.pollSeconds) || raw.pollSeconds < 5)) problems.push('pollSeconds must be at least 5');
  if (typeof raw.stateFile !== 'string' || !raw.stateFile) problems.push('stateFile is required');
  if (raw.webhookUrl !== undefined) {
    let ok = false;
    try {
      const u = new URL(raw.webhookUrl);
      ok = u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
    } catch {
      ok = false;
    }
    if (!ok) problems.push('webhookUrl must be https (http only for localhost)');
  }
  if (raw.heartbeatMinutes !== undefined && (!Number.isFinite(raw.heartbeatMinutes) || raw.heartbeatMinutes < 1)) problems.push('heartbeatMinutes must be at least 1');
  if (raw.largeValueQuai !== undefined) {
    try {
      parseUnits(String(raw.largeValueQuai), 18);
    } catch {
      problems.push('largeValueQuai must be a decimal amount of QUAI');
    }
  }
  if (problems.length) throw new Error(`Invalid watcher config:\n  - ${problems.join('\n  - ')}`);
  return { ...raw, vaults: raw.vaults.map((v: string) => getAddress(v)) } as WatcherConfig;
}

export function loadState(file: string, chainId: number): WatcherState {
  if (!fs.existsSync(file)) return emptyState(chainId);
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as WatcherState;
  if (state.version !== 1 || state.chainId !== chainId) {
    throw new Error(`${file} belongs to chain ${state.chainId} (version ${state.version}); refusing to reuse it for chain ${chainId}.`);
  }
  return state;
}

/** Written to a temporary file and renamed, so a crash never leaves a half-written cursor. */
export function saveState(file: string, state: WatcherState): void {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export type AlertSink = (alerts: Alert[]) => Promise<void>;

export function consoleSink(write: (line: string) => void): AlertSink {
  return async (alerts) => alerts.forEach((a) => write(JSON.stringify({ at: new Date().toISOString(), ...a })));
}

/** POSTs alerts as JSON, retrying three times with backoff. Messages are bounded in size. */
export function webhookSink(url: string, fetchFn: typeof fetch = fetch): AlertSink {
  return async (alerts) => {
    if (alerts.length === 0) return;
    const body = JSON.stringify({
      source: 'safebuddy-watcher',
      alerts: alerts.slice(0, 50).map((a) => ({ ...a, message: a.message.slice(0, 500) })),
    });
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10_000) });
        if (res.ok) return;
        lastError = new Error(`webhook answered ${res.status}`);
      } catch (err) {
        lastError = err;
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    throw lastError;
  };
}

export interface RunOptions {
  config: WatcherConfig;
  makeRpc: (url: string) => RpcLike;
  sinks: AlertSink[];
  log: (line: string) => void;
  once?: boolean;
  signal?: AbortSignal;
}

/**
 * Polls until stopped. Emits a heartbeat so silence can be told apart from a dead watcher,
 * and raises an alert (once) when the RPC has failed three polls in a row.
 */
export async function runWatcher(opts: RunOptions): Promise<void> {
  const { config } = opts;
  const network = getNetworkConfig(config.network);
  const urls = config.rpc?.length ? config.rpc : [network.rpcUrl];
  const sources: ReadSource[] = urls.map((url, i) => ({ name: urls.length > 1 ? `rpc${i + 1}` : 'rpc', rpc: opts.makeRpc(url) }));
  const reportedChain = parseInt(String(await sources[0]!.rpc.rawRequest('quai_chainId', [])), 16);
  if (reportedChain !== network.chainId) throw new Error(`The RPC is on chain ${reportedChain}, not ${network.chainId}.`);
  const deployment = await resolveDeployment(sources[0]!.rpc, network.chainId, config.factory ?? null);
  opts.log(`factory ${deployment.factory} verified; watching ${config.vaults.length} vault(s)`);

  const emit = async (alerts: Alert[]) => {
    for (const sink of opts.sinks) {
      try {
        await sink(alerts);
      } catch (err: any) {
        opts.log(`alert delivery failed: ${err?.message ?? err}`);
      }
    }
  };
  let state = loadState(config.stateFile, network.chainId);
  let failures = 0;
  let lastHeartbeat = 0;
  const heartbeatMs = (config.heartbeatMinutes ?? 60) * 60_000;

  for (;;) {
    try {
      const result = await pollOnce(state, {
        sources,
        deployment,
        vaults: config.vaults,
        confirmations: config.confirmations ?? (config.network === 'mainnet' ? 3 : 6),
        largeValueWei: config.largeValueQuai !== undefined ? parseUnits(String(config.largeValueQuai), 18) : undefined,
      });
      state = result.state;
      saveState(config.stateFile, state);
      await emit(result.alerts);
      failures = 0;
      if (Date.now() - lastHeartbeat >= heartbeatMs) {
        lastHeartbeat = Date.now();
        const head = await readBlockNumber(sources[0]!.rpc).catch(() => null);
        await emit([{ level: 'info', kind: 'heartbeat', vault: null, block: state.block, message: `Watcher alive; confirmed block ${state.block}, head ${head ?? 'unknown'}.` }]);
      }
    } catch (err: any) {
      failures += 1;
      opts.log(`poll failed (${failures} in a row): ${err?.message ?? err}`);
      if (failures === 3) {
        await emit([{ level: 'high', kind: 'rpc-unavailable', vault: null, block: state.block, message: `Three polls in a row failed: ${err?.message ?? err}` }]);
      }
    }
    if (opts.once || opts.signal?.aborted) return;
    await new Promise((r) => setTimeout(r, (config.pollSeconds ?? 60) * 1000));
    if (opts.signal?.aborted) return;
  }
}
