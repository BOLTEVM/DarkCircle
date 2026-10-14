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

/** A deployment recorded in this browser (e.g. after running deploy-quai locally), until deployments.ts catches up. */
export function savedDeployment(network: string): Deployment | null {
  const raw = readStored(SAVED_DEPLOYMENT_PREFIX + network);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { factory?: unknown; registry?: unknown; fromBlock?: unknown };
    return typeof v?.factory === 'string' && typeof v?.registry === 'string'
      ? { factory: v.factory, registry: v.registry, fromBlock: typeof v.fromBlock === 'number' ? v.fromBlock : undefined }
      : null;
  } catch {
    return null;
  }
}
