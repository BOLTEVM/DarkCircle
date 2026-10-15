import { NETWORKS, type Deployment, type NetworkConfig } from '@darkorder/core';

/** Asset prefix for files in public/ (the build uses a relative base). */
export const ASSET_BASE: string = import.meta.env.BASE_URL;

/**
 * The local Hardhat network and its dev wallet exist only in a dev server started with
 * VITE_DARKORDER_LOCAL=1. `import.meta.env.DEV` is a build-time constant, so a production
 * bundle drops every branch behind this flag.
 */
export const LOCAL_ENABLED: boolean = import.meta.env.DEV && import.meta.env.VITE_DARKORDER_LOCAL === '1';

/** The local network, at the RPC the local-chain script wrote. */
export function localNetwork(): NetworkConfig {
  const rpc = import.meta.env.VITE_LOCAL_RPC as string | undefined;
  return LOCAL_ENABLED && rpc ? { ...NETWORKS.local, rpcUrl: rpc } : NETWORKS.local;
}

export function localDeployment(): Deployment | null {
  if (!LOCAL_ENABLED) return null;
  const factory = import.meta.env.VITE_LOCAL_FACTORY as string | undefined;
  const registry = import.meta.env.VITE_LOCAL_REGISTRY as string | undefined;
  return factory && registry ? { factory, registry } : null;
}

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage: the preference just is not remembered */
  }
}

export const SAVED_DEPLOYMENT_PREFIX = 'darkorder.deployment.';

/**
 * Networks where a deployment saved in this browser may stand in for one recorded in
 * deployments.ts. Never mainnet: localStorage is writable by any script on this origin (every
 * project site on a shared host such as <user>.github.io shares one), so trusting it there would
 * let another page point visitors' real money at contracts it deployed.
 */
export const BROWSER_DEPLOYMENT_NETWORKS: readonly string[] = ['orchard'];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** A testnet deployment made from this browser's deploy modal, kept until it is recorded in deployments.ts. */
export function savedDeployment(network: string): Deployment | null {
  if (!BROWSER_DEPLOYMENT_NETWORKS.includes(network)) return null;
  const raw = readStored(SAVED_DEPLOYMENT_PREFIX + network);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { factory?: unknown; registry?: unknown; fromBlock?: unknown };
    if (typeof v?.factory !== 'string' || typeof v?.registry !== 'string') return null;
    if (!ADDRESS_RE.test(v.factory) || !ADDRESS_RE.test(v.registry)) return null;
    const fromBlock = Number.isSafeInteger(v.fromBlock) && (v.fromBlock as number) >= 0 ? (v.fromBlock as number) : undefined;
    return { factory: v.factory, registry: v.registry, fromBlock };
  } catch {
    return null;
  }
}
