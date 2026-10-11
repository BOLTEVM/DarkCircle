/**
 * DarkCircle Protocol: CLI Types and Interfaces
 * File: src/cli/types.ts
 */

import type { SimulatedBlockchain } from "../sim/blockchain.ts";
import type { RailgunSmartWallet, RailgunPool } from "../sim/railgunContract.ts";
import type { RelayerNetwork } from "../sim/relayerNetwork.ts";
import type { ERC20Token } from "../sim/erc20Token.ts";
import type { CorporateKeyHierarchy } from "../types/audit.ts";
import type { CorporateKeys, SpendingPolicy } from "../proxy/interceptor.ts";
import type { InboundMerchantGateway } from "../gateway/gateway.ts";
import type { ShieldedUTXO } from "../types/sim.ts";
import type { PPOIEngine } from "../ppoi/ppoiEngine.ts";
import type { SanctionsRegistry } from "../ppoi/sanctionsList.ts";
import type { AccountingJournalReconstructor } from "../audit/accounting.ts";
import type { SpendTracker } from "../proxy/spendTracker.ts";

/**
 * Standard CLI process exit codes.
 */
export const CliExitCode = {
  SUCCESS: 0,
  EXECUTION_ERROR: 1,
  USAGE_ERROR: 2
} as const;

export type CliExitCode = (typeof CliExitCode)[keyof typeof CliExitCode];

/**
 * Result returned by CLI runner and command execution functions.
 */
export interface CliResult {
  exitCode: CliExitCode;
  stdout: string;
  stderr: string;
  data?: any;
}

/**
 * Extended corporate keys combining viewing key hierarchy and proxy keys.
 */
export interface CliCorporateKeys extends CorporateKeyHierarchy {
  ssk: bigint;
  spk: bigint;
  vsk: bigint;
  vpk: bigint;
  npk: bigint;
  corporate0zkAddress: string;
}

/**
 * Dependency injection container for CLI commands.
 */
export interface CliContext {
  blockchain: SimulatedBlockchain;
  pool: RailgunSmartWallet | RailgunPool;
  relayer: RelayerNetwork;
  corporateKeys: CliCorporateKeys;
  spendingPolicy: SpendingPolicy;
  /** Rolling spend log shared by every coordinator that pays from this lane (see SpendTracker). */
  spendTracker?: SpendTracker;
  merchantGateway: InboundMerchantGateway;
  treasuryUTXOs: ShieldedUTXO[];
  ppoiEngine?: PPOIEngine;
  sanctionsRegistry?: SanctionsRegistry;
  journal?: AccountingJournalReconstructor;
  token?: ERC20Token;
  tokenAddress?: string;
  corporateOperatingAddress?: string;
  fetchFn?: typeof globalThis.fetch;
}

/**
 * Command option interfaces.
 */
export interface PayCommandOptions {
  url?: string;
  recipient?: string;
  amount?: string;
  token?: string;
  direct?: boolean;
  json?: boolean;
  output?: string;
  maxCap?: string;
  invoiceId?: string;
}

export interface InvoiceCommandOptions {
  amount: string;
  token?: string;
  symbol?: string;
  decimals?: number;
  resource?: string;
  ttl?: number;
  derivationMode?: "quai" | "fast" | "secp256k1";
  merchantKey?: string;
  json?: boolean;
  output?: string;
}

export interface SweepCommandOptions {
  invoice?: string;
  all?: boolean;
  threshold?: string;
  address?: string;
  privateKey?: string;
  token?: string;
  json?: boolean;
  output?: string;
}

export interface AuditCommandOptions {
  viewingKey?: string;
  format?: "json" | "csv";
  json?: boolean;
  csv?: boolean;
  output?: string;
  entity?: string;
  fromDate?: string;
  toDate?: string;
  token?: string;
  counterparty?: string;
  direction?: string;
  verify?: string | boolean;
  reconcile?: boolean;
}

export interface ShieldCommandOptions {
  amount?: string;
  token?: string;
  depositor?: string;
  wrap?: boolean;
  json?: boolean;
}

export interface ChecklistCommandOptions {
  kind?: string;
  address?: string;
  amount?: string;
  token?: string;
  invoice?: string;
  wrap?: boolean;
  json?: boolean;
}

export interface BalanceCommandOptions {
  address?: string;
  token?: string;
  viewingKey?: string;
  json?: boolean;
  output?: string;
}
