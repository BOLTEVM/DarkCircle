/**
 * DarkCircle production relayer: process bootstrap
 * File: src/relayer/index.ts
 *
 * Wire-up only: config from the environment, keystore signer (policy-guarded), durable store,
 * Quai RPC, reconcile-on-start, then the loopback API and a confirmation poll loop. See
 * docs/RELAYER.md for the operator runbook and docs/RELAYER_PLAN.md for the design record.
 */

import { QuaiRpcClient } from "../quai/rpc.ts";
import { DarkCircleRelayer } from "./relayer.ts";
import { RelayStore } from "./store.ts";
import { PermittedCallSigner, WalletQuaiSigner } from "./signer.ts";
import { createRelayerHttp, type RunningRelayerHttp } from "./http.ts";
import { relayerConfigFromEnv, type RelayerEnvConfig } from "./config.ts";

export interface RunningRelayer {
  relayer: DarkCircleRelayer;
  http: RunningRelayerHttp;
  config: RelayerEnvConfig;
  stop: () => Promise<void>;
}

export async function startRelayer(overrides?: Partial<RelayerEnvConfig>): Promise<RunningRelayer> {
  const env = relayerConfigFromEnv();
  const config = { ...env, ...overrides };

  const signer = new PermittedCallSigner(
    await WalletQuaiSigner.fromKeystoreFile(config.keystorePath, config.keystorePassphrase),
    config.relay.poolAddress
  );
  const rpc = new QuaiRpcClient({ network: config.network });
  const store = new RelayStore(config.statePath);

  const relayer = new DarkCircleRelayer({
    rpc,
    signer,
    store,
    config: config.relay,
    log: (m) => console.log(`[relayer] ${m}`)
  });

  // Reconcile on start: read the chain for every in-flight nullifier before accepting new work.
  await relayer.reconcile();

  const http = await createRelayerHttp({
    relayer,
    port: config.http.port,
    authToken: config.http.authToken,
    rateLimitPerInterval: config.http.rateLimitPerInterval,
    rateLimitIntervalMs: config.http.rateLimitIntervalMs,
    log: (m) => console.log(`[http] ${m}`)
  });

  const poll = setInterval(() => {
    relayer.sync().catch((err) => console.log(`[relayer] sync failed: ${(err as Error).message}`));
  }, config.pollIntervalMs);
  poll.unref();

  console.log(`[relayer] ${signer.address} serving pool ${config.relay.poolAddress} on ${config.network.zone.name}; API at ${http.url}`);

  return {
    relayer,
    http,
    config,
    stop: async () => {
      clearInterval(poll);
      store.flush();
      await http.close();
    }
  };
}
