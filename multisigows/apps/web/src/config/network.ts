import { MAINNET_CONFIG, TESTNET_CONFIG, QuaiNetworkConfig } from '@darksafe/core';

/**
 * Resolves which Quai network profile the dashboard talks to, via Vite build-time env:
 *   VITE_QUAI_NETWORK=mainnet|testnet     (default: testnet / Orchard)
 *   VITE_QUAI_RPC_URL=<override>          (default: the profile's canonical rpcUrl;
 *                                          add its origin to the CSP connect-src too)
 *   VITE_ALLOW_MAINNET_VAULTS=true        (default: off; see isVaultCreationAllowed)
 *   VITE_TX_CONFIRMATIONS=<n>             (default: 3 mainnet, 6 testnet)
 */
// Read each variable as a literal `import.meta.env.X` so Vite can substitute it at build time.
export function resolveWebNetworkConfig(): QuaiNetworkConfig {
  const networkName = String(import.meta.env.VITE_QUAI_NETWORK || 'testnet').trim().toLowerCase();
  const base = networkName === 'mainnet' ? MAINNET_CONFIG : TESTNET_CONFIG;
  const rpcOverride = String(import.meta.env.VITE_QUAI_RPC_URL || '').trim();

  return rpcOverride ? { ...base, rpcUrl: rpcOverride } : base;
}

/**
 * The current vault contract has not had an independent security audit. Creating or
 * adding mainnet vaults stays off unless the deployer opts in explicitly, so a default
 * build can never be used to put real funds into it.
 */
export function isVaultCreationAllowed(config: QuaiNetworkConfig = resolveWebNetworkConfig()): boolean {
  if (config.name !== 'mainnet') return true;
  return String(import.meta.env.VITE_ALLOW_MAINNET_VAULTS || '').trim().toLowerCase() === 'true';
}

export function requiredConfirmations(config: QuaiNetworkConfig = resolveWebNetworkConfig()): number {
  const raw = Number(import.meta.env.VITE_TX_CONFIRMATIONS);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 100) return raw;
  return config.name === 'mainnet' ? 3 : 6;
}

/** How long to wait for a transaction to reach its confirmation depth before giving up. */
export const RECEIPT_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * Optional: a DarkSafe v2 factory to use instead of the recorded deployment
 * (packages/contracts/deployments), e.g. a factory you deployed to Orchard yourself. It is
 * verified on chain against the pinned build before the app trusts it.
 *   VITE_V2_FACTORY_ADDRESS=0x00...
 */
export function factoryOverride(): string | null {
  const raw = String(import.meta.env.VITE_V2_FACTORY_ADDRESS || '').trim();
  return raw || null;
}

/**
 * Optional: a second, independent RPC endpoint. Owners, threshold, delay and transaction
 * contents are compared across sources before any write; add its origin to connect-src.
 *   VITE_QUAI_SECONDARY_RPC_URL=https://...
 */
export function secondaryRpcUrl(): string | null {
  const raw = String(import.meta.env.VITE_QUAI_SECONDARY_RPC_URL || '').trim();
  return raw || null;
}
