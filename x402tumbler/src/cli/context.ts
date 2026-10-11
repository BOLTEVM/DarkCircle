/**
 * DarkCircle Protocol: CLI Context & Default Simulation Environment
 * File: src/cli/context.ts
 *
 * Builds an in-memory Quai Cyprus-1 environment (chain id 9) holding both settlement assets, WQUAI and
 * WQI. The shielded treasury is seeded in ONE asset per context (default WQUAI); pass `asset: "WQI"`
 * to settle in Wrapped Qi instead.
 */

import crypto from "node:crypto";
import { SimulatedBlockchain } from "../sim/blockchain.ts";
import { ERC20Token } from "../sim/erc20Token.ts";
import {
  SIM_POOL_ADDRESS,
  SIM_POOL_WQI_ADDRESS,
  SIM_RELAYER_ADDRESS,
  SIM_OPERATING_ADDRESS,
  SIM_DEPOSITOR_ADDRESS
} from "../sim/defaults.ts";
import { defaultQuaiTokenRegistry } from "../quai/tokens.ts";
import { DEFAULT_QUAI_NETWORK } from "../quai/networks.ts";
import { RailgunPool } from "../sim/railgunContract.ts";
import { RelayerNetwork } from "../sim/relayerNetwork.ts";
import { deriveCorporateKeyHierarchy } from "../audit/keys.ts";
import { AccountingJournalReconstructor } from "../audit/accounting.ts";
import { InboundMerchantGateway } from "../gateway/gateway.ts";
import { PPOIEngine } from "../ppoi/ppoiEngine.ts";
import { PPOIValidator } from "../ppoi/ppoiValidator.ts";
import { SanctionsRegistry } from "../ppoi/sanctionsList.ts";
import { poseidon2 } from "../crypto/poseidon.ts";
import { Fp } from "../crypto/field.ts";
import type { ShieldedUTXO } from "../types/sim.ts";
import type { CliContext, CliCorporateKeys } from "./types.ts";
import type { QuaiToken } from "../quai/tokens.ts";
import type { SpendingPolicy } from "../proxy/interceptor.ts";
import { SpendTracker } from "../proxy/spendTracker.ts";

export const DEFAULT_CORPORATE_SEED = "DarkCircle-Enterprise-Treasury-Seed-2026";
export const DEFAULT_MERCHANT_KEY = "DarkCircle-Merchant-Master-Key-2026";
export const DEFAULT_OPERATING_ADDRESS = SIM_OPERATING_ADDRESS;
export const DEFAULT_DEPOSITOR_ADDRESS = SIM_DEPOSITOR_ADDRESS;
export const DEFAULT_RELAYER_ADDRESS = SIM_RELAYER_ADDRESS;

const ONE_TOKEN = 10n ** 18n;

/**
 * Resolves a --token argument that may be a registry symbol ("wqi") or a contract address.
 * Symbols only ever map to the registered Quai contract, never to an arbitrary token that claims the
 * same name; anything else is passed through so the spending policy can refuse it.
 */
export function resolveTokenArg(value: string, context?: { blockchain?: { network?: typeof DEFAULT_QUAI_NETWORK } }): string {
  const network = context?.blockchain?.network ?? DEFAULT_QUAI_NETWORK;
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return value;
  const known = defaultQuaiTokenRegistry.resolve(value, network);
  if (!known) {
    throw new Error(
      `ERR_QUAI_TOKEN_UNKNOWN: '${value}' is not a registered asset on ${network.id} (supported: ${defaultQuaiTokenRegistry
        .list(network)
        .map((t) => t.symbol)
        .join(", ")})`
    );
  }
  return known.address.toLowerCase();
}

export interface EnvironmentOptions {
  seed?: string;
  merchantKey?: string;
  chainId?: number;
  initialShieldedAmount?: bigint; // Default: 100 tokens (100e18) per pool
  initialOperatingAmount?: bigint; // Default: 50 tokens (50e18) per asset
  fetchFn?: typeof globalThis.fetch;
}

/**
 * State every asset shares: one ledger (so one block height, one relayer gas balance and one operating
 * wallet), both tokens deployed on it, one compliance stack, and one set of corporate keys.
 */
export interface SharedEnvironment {
  options: EnvironmentOptions;
  chainId: number;
  blockchain: SimulatedBlockchain;
  tokens: Map<string, ERC20Token>;
  sanctionsRegistry: SanctionsRegistry;
  ppoiEngine: PPOIEngine;
  corporateKeys: CliCorporateKeys;
  merchantKey: string;
  operatingAddress: string;
}

const POOL_ADDRESS_BY_SYMBOL: Record<string, string> = {
  WQUAI: SIM_POOL_ADDRESS,
  WQI: SIM_POOL_WQI_ADDRESS
};

export function createSharedEnvironment(options?: EnvironmentOptions): SharedEnvironment {
  const chainId = options?.chainId ?? DEFAULT_QUAI_NETWORK.chainId;
  const seed = options?.seed ?? DEFAULT_CORPORATE_SEED;
  const merchantKey = options?.merchantKey ?? DEFAULT_MERCHANT_KEY;

  // Simulated Quai zone ledger with both settlement assets deployed
  const blockchain = new SimulatedBlockchain(chainId);
  const tokens = new Map<string, ERC20Token>([
    ["WQUAI", ERC20Token.createWQUAI(blockchain)],
    ["WQI", ERC20Token.createWQI(blockchain)]
  ]);

  // Compliance: sanctions registry and PPOI engine (attached to every pool so each enforces them itself)
  const sanctionsRegistry = new SanctionsRegistry();
  sanctionsRegistry.loadDefaultSanctions();
  const ppoiEngine = new PPOIEngine(sanctionsRegistry, 0);

  // Corporate key hierarchy: the spending key and the viewing key are isolated from each other
  const hierarchy = deriveCorporateKeyHierarchy(seed);
  const spk = hierarchy.spendingPublicKey[0];
  const vpk = hierarchy.viewingPublicKey[0];
  const corporateKeys: CliCorporateKeys = {
    ...hierarchy,
    ssk: hierarchy.masterSpendingKey,
    spk,
    vsk: hierarchy.masterViewingKey,
    vpk,
    npk: poseidon2(spk, vpk),
    corporate0zkAddress: hierarchy.corporate0zkAddress
  };

  // Operating wallet: holds QUAI for gas
  blockchain.getOrCreateAccount(DEFAULT_OPERATING_ADDRESS).nativeBalance = 100n * ONE_TOKEN;

  return { options: options ?? {}, chainId, blockchain, tokens, sanctionsRegistry, ppoiEngine, corporateKeys, merchantKey, operatingAddress: DEFAULT_OPERATING_ADDRESS };
}

/**
 * Builds one asset's complete stack on the shared ledger: its own shielded pool (own address, own tree,
 * own custody, own anonymity set), relayer, merchant gateway, treasury notes and journal. With
 * `isolate` the pool and the spending policy accept only that asset, so a WQUAI note can never be spent
 * from the WQI pool or the other way round.
 */
export function createLane(env: SharedEnvironment, symbol: string, opts?: { isolate?: boolean }): CliContext {
  const { blockchain, corporateKeys } = env;
  const asset: QuaiToken = defaultQuaiTokenRegistry.require(symbol, blockchain.network);
  const token = env.tokens.get(asset.symbol)!;
  const initialShieldedAmount = env.options.initialShieldedAmount ?? 100n * ONE_TOKEN;
  const initialOperatingAmount = env.options.initialOperatingAmount ?? 50n * ONE_TOKEN;
  const allowedTokens = opts?.isolate
    ? [asset.address]
    : defaultQuaiTokenRegistry.list(blockchain.network).map((t) => t.address);

  // Railgun shielded pool (verified mode) and relayer network
  const pool = new RailgunPool(blockchain, {
    contractAddress: POOL_ADDRESS_BY_SYMBOL[asset.symbol] ?? SIM_POOL_ADDRESS,
    mode: "verified",
    allowedTokens,
    ppoiValidator: new PPOIValidator(env.ppoiEngine),
    sanctionsRegistry: env.sanctionsRegistry
  });
  const relayer = new RelayerNetwork(pool, DEFAULT_RELAYER_ADDRESS, 5n * 10n ** 17n); // 0.5 token fee floor

  // Operating wallet holds some of this asset
  token.mint(env.operatingAddress, initialOperatingAmount);

  // Initial shielded treasury note. The depositor funds the pool by allowance; the verified pool pulls
  // the tokens in shield().
  token.mint(DEFAULT_DEPOSITOR_ADDRESS, initialShieldedAmount);
  token.approve(pool.contractAddress, initialShieldedAmount, DEFAULT_DEPOSITOR_ADDRESS);

  const initialBlinding = Fp.mod(123456789n);
  const shieldMemo = "Treasury Initial Funding";
  const shieldRes = pool.shield(token.address, initialShieldedAmount, corporateKeys.npk, initialBlinding, shieldMemo, DEFAULT_DEPOSITOR_ADDRESS);

  const treasuryUTXOs: ShieldedUTXO[] = [
    {
      commitment: shieldRes.commitment,
      leafIndex: shieldRes.leafIndex,
      token: token.address.toLowerCase(),
      value: initialShieldedAmount,
      blinding: initialBlinding,
      rho: initialBlinding,
      npk: corporateKeys.npk,
      memo: shieldMemo,
      depositorAddress: DEFAULT_DEPOSITOR_ADDRESS,
      depositTimestamp: shieldRes.depositTimestamp
    }
  ];

  // Double-entry accounting journal: one per asset
  const journal = new AccountingJournalReconstructor(corporateKeys.corporate0zkAddress);
  journal.recordInbound(
    "0x" + crypto.randomBytes(32).toString("hex"),
    blockchain.currentBlockNumber,
    "0x" + shieldRes.commitment.toString(16),
    {
      version: 1,
      token: token.address.toLowerCase(),
      value: initialShieldedAmount.toString(),
      blinding: Fp.toHex(initialBlinding),
      npk: Fp.toHex(corporateKeys.npk),
      direction: "INBOUND_SHIELD",
      counterparty: DEFAULT_DEPOSITOR_ADDRESS,
      memo: shieldMemo,
      timestamp: Math.floor(Date.now() / 1000)
    }
  );

  const spendingPolicy: SpendingPolicy = {
    maxPaymentCap: 50n * ONE_TOKEN, // 50 tokens max per transaction
    allowedTokens: allowedTokens.map((a) => a.toLowerCase()),
    allowedChainIds: [env.chainId],
    screenRecipients: true,
    quaiNetwork: blockchain.network,
    dailyBudgetCap: 500n * ONE_TOKEN, // per token, rolling 24h
    minInvoiceTtlSeconds: 30,
    allowDirectUnshield: process.env.DARKCIRCLE_ALLOW_DIRECT === "1"
  };

  // Inbound merchant gateway. A token with permit (WQI) is swept gaslessly: the payee key signs an
  // EIP-2612 permit and the relayer submits it. A token without one (WQUAI) needs the relayer to fund gas.
  const merchantGateway = new InboundMerchantGateway({
    masterMerchantKey: env.merchantKey,
    corporate0zkAddress: corporateKeys.corporate0zkAddress,
    corporateNpk: corporateKeys.npk,
    corporateVpk: corporateKeys.viewingPublicKey,
    blockchain,
    pool,
    relayer,
    journal,
    treasuryLedger: treasuryUTXOs,
    autoSweep: true,
    network: blockchain.network,
    defaultTokenSymbol: asset.symbol,
    defaultTokenDecimals: asset.decimals,
    gasSponsorshipMode: asset.permit ? "PERMIT_SPONSORED" : "RELAYER_BROADCAST"
  });

  return {
    blockchain,
    pool,
    relayer,
    corporateKeys,
    spendingPolicy,
    spendTracker: new SpendTracker(),
    merchantGateway,
    treasuryUTXOs,
    ppoiEngine: env.ppoiEngine,
    sanctionsRegistry: env.sanctionsRegistry,
    journal,
    token,
    tokenAddress: token.address.toLowerCase(),
    corporateOperatingAddress: env.operatingAddress,
    fetchFn: env.options.fetchFn
  };
}

/**
 * Creates a fully-wired, deterministic single-asset execution context (WQUAI by default). Both tokens
 * are deployed on its ledger, but only the chosen asset has a pool and a treasury.
 */
export function createDefaultCliContext(options?: EnvironmentOptions & {
  /** Settlement asset the treasury is seeded in: "WQUAI" (default) or "WQI". */
  asset?: string;
}): CliContext {
  return createLane(createSharedEnvironment(options), options?.asset ?? "WQUAI");
}

export interface MultiAssetEnvironment {
  shared: SharedEnvironment;
  /** One isolated lane per asset, all on the same ledger. */
  lanes: Record<string, CliContext>;
  assets: string[];
}

/**
 * Both settlement assets live at once: a WQUAI pool and a WQI pool on one ledger, each with its own
 * relayer, gateway, treasury and journal. This is what the UI runs.
 */
export function createMultiAssetEnvironment(options?: EnvironmentOptions & { assets?: string[] }): MultiAssetEnvironment {
  const shared = createSharedEnvironment(options);
  const assets = options?.assets ?? defaultQuaiTokenRegistry.list(shared.blockchain.network).map((t) => t.symbol);
  const lanes: Record<string, CliContext> = {};
  for (const a of assets) lanes[a] = createLane(shared, a, { isolate: true });
  return { shared, lanes, assets };
}
