import type { SourceReport, VaultDeployment } from '@darksafe/core';

export type SignerMode = 'eip1193';

export interface ConnectedSigner {
  address: string;
  label: string;
  mode: SignerMode;
  providerName: string; // 'Pelagus' | 'Blip' | 'Quai Wallet' | 'BoltWallet'
  isOwner: boolean;
}

/**
 * How much the app trusts the vault state it shows:
 *  agreed        read and verified from two or more independent sources that match
 *  single-source verified from one source only (the second was unavailable or lagging)
 *  disagreement  sources report different state; every write is blocked
 *  error         could not verify at all; the figures are the last good read, writes blocked
 */
export type VerificationStatus = 'none' | 'verifying' | 'agreed' | 'single-source' | 'disagreement' | 'error';

export interface SafeState {
  address: string;
  name: string;
  chainId: number;
  owners: string[];
  threshold: number;
  /** Minimum timelock for external calls, in seconds. */
  minExecutionDelay: number;
  /** Number of transactions ever proposed. */
  txNonce: number;
  /** Native balance in wei, when read. */
  balance: bigint | null;
  isLoading: boolean;
  isDeployed: boolean;
  /** Set when the last verification failed; the values above are then the last good read, not live. */
  error: string | null;
  verification: VerificationStatus;
  sourceReports: SourceReport[];
  /** Why assurance is reduced (a source down, lagging or disagreeing). */
  problems: string[];
  /** Block the state was read at. */
  block: bigint | null;
  lastVerifiedAt: number | null;
}

export interface AssetHolding {
  symbol: string;
  name: string;
  address?: string;
  decimals: number;
  rawBalance: bigint;
  formattedBalance: string;
  unitPriceUsd: number;
  totalUsd: number;
  allocationPercent: number;
  /** 24h price change percent, or null when no live historical-price source is wired up. */
  change24h: number | null;
  logoUrl?: string;
}

export interface MarketDataState {
  totalUsd: number;
  formattedTotalUsd: string;
  holdings: AssetHolding[];
  lastUpdated: number;
  isLoading: boolean;
  isLive: boolean;
  error: string | null;
}

/** A vault the user has added. Stored locally; re-verified on chain every time it is shown. */
export interface KnownVault {
  address: string;
  chainId: number;
  name?: string;
  addedAt: number;
  /** Factory that created it, as verified when it was added. */
  factory: string;
}

export interface AddressBookEntry {
  address: string;
  label: string;
  addedAt: number;
}

export type { VaultDeployment };
