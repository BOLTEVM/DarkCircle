/**
 * DarkCircle production relayer: configuration
 * File: src/relayer/config.ts
 *
 * Everything operator-settable comes from the environment (RELAYER_PLAN.md §3.1: the passphrase is
 * held outside the repository). No defaults for the secrets; the process refuses to start without
 * them. Numbers are plain decimal strings; amounts in wei/base units.
 */

import { resolveQuaiNetwork, DEFAULT_QUAI_NETWORK, type QuaiNetwork } from "../quai/networks.ts";
import type { RelayerConfig } from "./relayer.ts";

export interface RelayerEnvConfig {
  network: QuaiNetwork;
  keystorePath: string;
  /** From RELAYER_KEYSTORE_PASSPHRASE — never logged, never persisted. */
  keystorePassphrase: string;
  statePath: string;
  http: { port: number; authToken: string; rateLimitPerInterval: number; rateLimitIntervalMs: number };
  relay: RelayerConfig;
  pollIntervalMs: number;
}

function req(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`ERR_RELAYER_CONFIG: ${name} is required`);
  return v.trim();
}

function big(name: string, dflt: bigint): bigint {
  const v = process.env[name];
  if (!v || !v.trim()) return dflt;
  try {
    return BigInt(v.trim());
  } catch {
    throw new Error(`ERR_RELAYER_CONFIG: ${name} is not an integer`);
  }
}

function int(name: string, dflt: number): number {
  const v = process.env[name];
  if (!v || !v.trim()) return dflt;
  const n = Number(v.trim());
  if (!Number.isInteger(n) || n < 0) throw new Error(`ERR_RELAYER_CONFIG: ${name} is not a non-negative integer`);
  return n;
}

export function relayerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RelayerEnvConfig {
  const network = resolveQuaiNetwork(env.RELAYER_NETWORK) ?? DEFAULT_QUAI_NETWORK;
  const poolAddress = req("RELAYER_POOL_ADDRESS");
  const tokenAddress = req("RELAYER_TOKEN_ADDRESS");

  const relay: RelayerConfig = {
    poolAddress,
    tokenAddress,
    minFee: big("RELAYER_MIN_FEE", 5n * 10n ** 17n), // 0.5 token units, 18 decimals, like the simulated relayer
    unshieldGasEstimate: big("RELAYER_UNSHIELD_GAS_ESTIMATE", 400_000n),
    gasHeadroomPercent: int("RELAYER_GAS_HEADROOM_PERCENT", 150), // ×2.5
    quoteValidityBlocks: int("RELAYER_QUOTE_VALIDITY_BLOCKS", 12),
    minGasBalance: big("RELAYER_GAS_FLOOR", 10n ** 18n), // 1 QUAI
    confirmationsRequired: Math.max(2, int("RELAYER_CONFIRMATIONS", 2)),
    maxRelayAttempts: Math.max(1, int("RELAYER_MAX_ATTEMPTS", 3)),
    txTimeoutBlocks: int("RELAYER_TX_TIMEOUT_BLOCKS", 64)
  };

  return {
    network,
    keystorePath: req("RELAYER_KEYSTORE_PATH"),
    keystorePassphrase: req("RELAYER_KEYSTORE_PASSPHRASE"),
    statePath: env.RELAYER_STATE_PATH?.trim() || "relayer-state.json",
    http: {
      port: int("RELAYER_PORT", 4790),
      authToken: req("RELAYER_AUTH_TOKEN"),
      rateLimitPerInterval: int("RELAYER_RATE_LIMIT", 30),
      rateLimitIntervalMs: int("RELAYER_RATE_LIMIT_INTERVAL_MS", 60_000)
    },
    relay,
    pollIntervalMs: int("RELAYER_POLL_INTERVAL_MS", 12_000)
  };
}
