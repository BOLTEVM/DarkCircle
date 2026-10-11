/**
 * DarkCircle: Outbound Private Payment Proxy Unit Tests (Milestone 3)
 * File: test/unit/proxy.test.ts
 *
 * Comprehensive test suite verifying:
 * 1. ChallengeParser: RFC 7807, RFC 7235 WWW-Authenticate, X-Payment-* headers, decimal parsing, injection safety.
 * 2. ReceiptCache & SingleFlightCoalescer: Map compatibility, TTL eviction, query isolation, concurrency coalescing, deadlock-free error cleanup.
 * 3. SettlementCoordinator: Spending policy gates, payee screening, UTXO note selection, change derivation, PPOI non-membership, anti-frontrunning, on-chain relayer graph decoupling.
 * 4. OutboundPaymentInterceptor & PaymentClient: End-to-end 402 interception, automated retry, cache hit re-use, stale cache eviction, multi-request concurrency.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ChallengeParser,
  parseAmountToBaseUnits
} from "../../src/proxy/parser.ts";
import {
  ReceiptCache,
  SingleFlightCoalescer,
  type CachedReceipt
} from "../../src/proxy/receiptCache.ts";
import {
  SettlementCoordinator,
  type SpendingPolicy
} from "../../src/proxy/settlement.ts";
import {
  OutboundPaymentInterceptor,
  type CorporateKeys
} from "../../src/proxy/interceptor.ts";
import {
  PaymentClient,
  OutboundPaymentProxy
} from "../../src/proxy/client.ts";
import { SimulatedBlockchain } from "../../src/sim/blockchain.ts";
import { ERC20Token, WQUAI_ADDRESS } from "../../src/sim/erc20Token.ts";
import { RailgunPool } from "../../src/sim/railgunContract.ts";
import { RelayerNetwork } from "../../src/sim/relayerNetwork.ts";
import { ResourceServer } from "../../src/server/resourceServer.ts";
import { SanctionsRegistry } from "../../src/ppoi/sanctionsList.ts";
import { PPOIEngine } from "../../src/ppoi/ppoiEngine.ts";
import { poseidon2 } from "../../src/crypto/poseidon.ts";
import { Fp } from "../../src/crypto/field.ts";

describe("Milestone 3 Unit Tests: Outbound Private Payment Proxy", () => {
  const WQUAI = WQUAI_ADDRESS;
  const CLEAN_MERCHANT = "0x0022222254eeb25477b68fb85ed929f73a960582";
  const SANCTIONED_ADDRESS = "0x0076acc5c05d6ce88f4e49bf65bdf0c62f91353c";
  const RELAYER_ADDRESS = "0x0077777754eeb25477b68fb85ed929f73a960582";

  let corporateKeys: CorporateKeys;

  beforeEach(() => {
    corporateKeys = {
      ssk: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1n % Fp.p,
      spk: 0x2234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef2n % Fp.p,
      vsk: 0x3234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef3n % Fp.p,
      vpk: 0x4234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef4n % Fp.p,
      npk: 0x5234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef5n % Fp.p,
      corporate0zkAddress: "0zkCorporateTreasuryAddress123"
    };
  });

  // ===========================================================================
  // 1. ChallengeParser Test Suite
  // ===========================================================================
  describe("ChallengeParser", () => {
    it("parses canonical RFC 7807 JSON problem details body with nested payment object", () => {
      const problemDetails = {
        type: "https://darkcircle.network/errors/payment-required",
        title: "Payment Required",
        status: 402,
        detail: "Access to analytics requires payment of 5 WQUAI",
        instance: "/api/v1/protected/analytics",
        payment: {
          protocol: "x402",
          version: "1.0.0",
          invoiceId: "inv_analytics_001",
          network: "quai-cyprus1",
          chainId: 9,
          token: {
            address: WQUAI,
            symbol: "WQUAI",
            decimals: 18
          },
          amount: "5000000000000000000",
          recipient: CLEAN_MERCHANT,
          createdAt: 1773750000,
          expiresAt: 1773753600,
          proofType: "tx_receipt"
        }
      };

      const parsed = ChallengeParser.parse(undefined, problemDetails);

      assert.equal(parsed.scheme, "x402");
      assert.equal(parsed.invoiceId, "inv_analytics_001");
      assert.equal(parsed.chainId, 9);
      assert.equal(parsed.network, "quai-cyprus1");
      assert.equal(parsed.tokenAddress.toLowerCase(), WQUAI.toLowerCase());
      assert.equal(parsed.tokenSymbol, "WQUAI");
      assert.equal(parsed.tokenDecimals, 18);
      assert.equal(parsed.amount, 5_000_000_000_000_000_000n);
      assert.equal(parsed.recipientAddress.toLowerCase(), CLEAN_MERCHANT.toLowerCase());
      assert.equal(parsed.expiresAt, 1773753600);
      assert.equal(parsed.targetResource, "/api/v1/protected/analytics");
      assert.equal(parsed.proofType, "tx_receipt");
    });

    it("parses flat RFC 7807 problem details body", () => {
      const flatBody = {
        type: "https://example.com/payment-required",
        title: "Payment Required",
        status: 402,
        recipient: CLEAN_MERCHANT,
        amount: "10000000000000000000",
        token: WQUAI,
        network: "quai-cyprus1",
        chainId: 9,
        invoiceId: "inv_flat_002",
        expiresAt: 1773753600,
        tokenDecimals: 18,
        instance: "/api/v1/resource"
      };

      const parsed = ChallengeParser.parse(undefined, flatBody);
      assert.equal(parsed.amount, 10_000_000_000_000_000_000n);
      assert.equal(parsed.invoiceId, "inv_flat_002");
      assert.equal(parsed.recipientAddress.toLowerCase(), CLEAN_MERCHANT.toLowerCase());
    });

    it("falls back to RFC 7235 WWW-Authenticate header when JSON body is missing", () => {
      const authHeader = `x402 scheme="erc20_transfer", network="quai-cyprus1", chainId="9", token="${WQUAI}", recipient="${CLEAN_MERCHANT}", amount="5000000000000000000", invoiceId="inv_header_003", expiresAt="1773753600", proofType="tx_receipt"`;
      const headers = { "WWW-Authenticate": authHeader };

      const parsed = ChallengeParser.parse(headers, undefined);

      assert.equal(parsed.scheme, "erc20_transfer");
      assert.equal(parsed.invoiceId, "inv_header_003");
      assert.equal(parsed.chainId, 9);
      assert.equal(parsed.tokenAddress.toLowerCase(), WQUAI.toLowerCase());
      assert.equal(parsed.recipientAddress.toLowerCase(), CLEAN_MERCHANT.toLowerCase());
      assert.equal(parsed.amount, 5_000_000_000_000_000_000n);
    });

    it("handles case-insensitive WWW-Authenticate header variations", () => {
      const authHeader = `x402 token="${WQUAI}", recipient="${CLEAN_MERCHANT}", amount="2500000000000000000", invoiceId="inv_case_004"`;

      const parsedLower = ChallengeParser.parse({ "www-authenticate": authHeader });
      assert.equal(parsedLower.invoiceId, "inv_case_004");
      assert.equal(parsedLower.amount, 2_500_000_000_000_000_000n);

      const parsedMixed = ChallengeParser.parse({ "Www-Authenticate": authHeader });
      assert.equal(parsedMixed.invoiceId, "inv_case_004");
    });

    it("falls back to custom X-Payment-* headers when body and WWW-Authenticate are absent", () => {
      const headers = {
        "x-payment-recipient": CLEAN_MERCHANT,
        "x-payment-amount": "7500000000000000000",
        "x-payment-invoice-id": "inv_xpay_005",
        "x-payment-token": WQUAI,
        "x-payment-token-symbol": "WQUAI",
        "x-payment-token-decimals": "18",
        "x-payment-network": "9",
        "x-payment-expires-at": "1773759999",
        "x-payment-resource": "/api/v1/protected/analytics",
        "x-payment-scheme": "x402-v1"
      };

      const parsed = ChallengeParser.parse(headers, undefined);

      assert.equal(parsed.amount, 7_500_000_000_000_000_000n);
      assert.equal(parsed.invoiceId, "inv_xpay_005");
      assert.equal(parsed.recipientAddress.toLowerCase(), CLEAN_MERCHANT.toLowerCase());
      assert.equal(parsed.targetResource, "/api/v1/protected/analytics");
      assert.equal(parsed.scheme, "x402-v1");
    });

    it("normalizes decimal amounts to integer base units without floating-point precision loss", () => {
      // Direct string decimal: "5.123456" with 6 decimals -> 5123456n (parser is decimals-generic; WQUAI itself uses 18)
      assert.equal(parseAmountToBaseUnits("5.123456", 6), 5123456n);
      assert.equal(parseAmountToBaseUnits("5.0", 6), 5000000n);
      assert.equal(parseAmountToBaseUnits("0.5", 6), 500000n);
      assert.equal(parseAmountToBaseUnits("5", 6), 5n);
      assert.equal(parseAmountToBaseUnits(5000000n, 6), 5000000n);
      assert.equal(parseAmountToBaseUnits(5000000, 6), 5000000n);

      // Decimal challenge body parsing
      const bodyWithDecimal = {
        payment: {
          recipient: CLEAN_MERCHANT,
          invoiceId: "inv_decimal_006",
          amount: "5.123456",
          token: { address: WQUAI, decimals: 18 }
        }
      };
      const parsed = ChallengeParser.parse(undefined, bodyWithDecimal);
      assert.equal(parsed.amount, 5_123_456_000_000_000_000n);
      assert.equal(parsed.tokenDecimals, 18);
    });

    it("throws strict ERR_402_CHALLENGE_INVALID when required challenge parameters are missing", () => {
      // Empty inputs
      assert.throws(() => {
        ChallengeParser.parse({}, {});
      }, /ERR_402_CHALLENGE_INVALID/);

      // Missing recipient
      assert.throws(() => {
        ChallengeParser.parse(undefined, {
          payment: { invoiceId: "inv_no_recipient", amount: "5000000000000000000" }
        });
      }, /ERR_402_CHALLENGE_INVALID/);

      // Missing invoiceId
      assert.throws(() => {
        ChallengeParser.parse(undefined, {
          payment: { recipient: CLEAN_MERCHANT, amount: "5000000000000000000" }
        });
      }, /ERR_402_CHALLENGE_INVALID/);

      // Zero amount
      assert.throws(() => {
        ChallengeParser.parse(undefined, {
          payment: { recipient: CLEAN_MERCHANT, invoiceId: "inv_zero", amount: "0" }
        });
      }, /ERR_402_CHALLENGE_INVALID/);
    });

    it("preserves special characters and injection strings in invoiceId safely", () => {
      const injectionInvoiceId = 'inv_test<script>alert(1)</script>"OR"1"="1';
      const body = {
        payment: {
          recipient: CLEAN_MERCHANT,
          invoiceId: injectionInvoiceId,
          amount: "5000000000000000000",
          token: { address: WQUAI }
        }
      };

      const parsed = ChallengeParser.parse(undefined, body);
      assert.equal(parsed.invoiceId, injectionInvoiceId);
    });

    it("formats authorization and proof headers accurately", () => {
      const authHeader = ChallengeParser.formatAuthorizationHeader(
        "inv_100",
        "0xtxhash123",
        "0xrelayer456"
      );
      assert.equal(
        authHeader,
        'x402 invoice="inv_100", proof="0xtxhash123", relayer="0xrelayer456"'
      );

      const headers = ChallengeParser.formatPaymentProofHeaders(
        "inv_100",
        "0xtxhash123",
        "0xrelayer456"
      );
      assert.equal(headers["X-Payment-Invoice-Id"], "inv_100");
      assert.equal(headers["X-Payment-Proof"], "0xtxhash123");
      assert.equal(headers["X-Payment-Relayer"], "0xrelayer456");
      assert.equal(headers["Authorization"], authHeader);
    });

    it("detects payment required status and headers accurately", () => {
      assert.equal(ChallengeParser.isPaymentRequired(402), true);
      assert.equal(ChallengeParser.isPaymentRequired(200), false);
      assert.equal(
        ChallengeParser.isPaymentRequired(200, { "x-payment-required": "true" }),
        true
      );
      assert.equal(
        ChallengeParser.isPaymentRequired(200, { "www-authenticate": 'x402 amount="100"' }),
        true
      );
    });
  });

  // ===========================================================================
  // 2. ReceiptCache & SingleFlightCoalescer Test Suite
  // ===========================================================================
  describe("ReceiptCache & SingleFlightCoalescer", () => {
    let cache: ReceiptCache;

    beforeEach(() => {
      cache = new ReceiptCache({ defaultTtlSeconds: 900, maxEntries: 10 });
    });

    it("supports standard Map interface operations and size tracking", () => {
      const receipt: CachedReceipt = {
        cacheKey: "/analytics",
        invoiceId: "inv_map_001",
        txHash: "0xhash001",
        relayerAddress: "0xrelayer001",
        amount: 5_000_000_000_000_000_000n,
        token: WQUAI,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      };

      cache.set(receipt.cacheKey, receipt);
      assert.equal(cache.has("/analytics"), true);
      assert.equal(cache.size, 1);
      assert.equal(cache.get("/analytics")?.invoiceId, "inv_map_001");

      const entries = Array.from(cache.entries());
      assert.equal(entries.length, 1);
      assert.equal(entries[0][0], "/analytics");

      const keys = Array.from(cache.keys());
      assert.deepEqual(keys, ["/analytics"]);

      const values = Array.from(cache.values());
      assert.equal(values[0].invoiceId, "inv_map_001");

      assert.equal(cache.delete("/analytics"), true);
      assert.equal(cache.size, 0);
      assert.equal(cache.has("/analytics"), false);
    });

    it("enforces TTL expiration and evicts stale entries on retrieval", () => {
      const expiredReceipt: CachedReceipt = {
        cacheKey: "/stale-endpoint",
        invoiceId: "inv_stale_002",
        txHash: "0xhash_stale",
        relayerAddress: "0xrelayer001",
        amount: 5_000_000_000_000_000_000n,
        token: WQUAI,
        expiresAt: Math.floor(Date.now() / 1000) - 100
      };

      cache.set(expiredReceipt.cacheKey, expiredReceipt);

      assert.equal(cache.get("/stale-endpoint"), undefined);
      assert.equal(cache.has("/stale-endpoint"), false);
    });

    it("isolates different query parameters as distinct cache entries", () => {
      const key1 = "/analytics?range=1d";
      const key2 = "/analytics?range=7d";

      cache.set(key1, {
        cacheKey: key1,
        invoiceId: "inv_1d",
        txHash: "0xhash_1d",
        relayerAddress: "0xrelayer001",
        amount: 5_000_000_000_000_000_000n,
        token: WQUAI,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });

      assert.equal(cache.has(key1), true);
      assert.equal(cache.has(key2), false);
    });

    it("supports secondary index lookups by invoiceId and txHash", () => {
      const receipt: CachedReceipt = {
        cacheKey: "/ai-inference",
        invoiceId: "inv_ai_003",
        txHash: "0xhash_ai_003",
        relayerAddress: "0xrelayer001",
        amount: 10_000_000_000_000_000_000n,
        token: WQUAI,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      };

      cache.set(receipt.cacheKey, receipt);

      const byInvoice = cache.getByInvoiceId("inv_ai_003");
      assert.ok(byInvoice);
      assert.equal(byInvoice?.cacheKey, "/ai-inference");

      const byTx = cache.getByTxHash("0xhash_ai_003");
      assert.ok(byTx);
      assert.equal(byTx?.invoiceId, "inv_ai_003");

      cache.evictByInvoice("inv_ai_003");
      assert.equal(cache.has("/ai-inference"), false);
    });

    it("enforces maxEntries capacity with LRU eviction", () => {
      const smallCache = new ReceiptCache({ maxEntries: 2 });
      smallCache.set("k1", {
        cacheKey: "k1",
        invoiceId: "inv1",
        txHash: "0xh1",
        relayerAddress: "0xr",
        amount: 1n,
        token: WQUAI,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });
      smallCache.set("k2", {
        cacheKey: "k2",
        invoiceId: "inv2",
        txHash: "0xh2",
        relayerAddress: "0xr",
        amount: 1n,
        token: WQUAI,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });
      smallCache.set("k3", {
        cacheKey: "k3",
        invoiceId: "inv3",
        txHash: "0xh3",
        relayerAddress: "0xr",
        amount: 1n,
        token: WQUAI,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });

      assert.equal(smallCache.has("k1"), false);
      assert.equal(smallCache.has("k2"), true);
      assert.equal(smallCache.has("k3"), true);
    });

    it("SingleFlightCoalescer coalesces multiple concurrent requests to single Promise", async () => {
      const coalescer = new SingleFlightCoalescer<string>();
      let executionCount = 0;

      const task = () =>
        new Promise<string>((resolve) => {
          executionCount++;
          setTimeout(() => resolve("settled_value"), 30);
        });

      const promises = [
        coalescer.execute("endpoint1", task),
        coalescer.execute("endpoint1", task),
        coalescer.execute("endpoint1", task)
      ];

      const results = await Promise.all(promises);
      assert.equal(executionCount, 1);
      assert.equal(results[0].result, "settled_value");
      assert.equal(results[0].shared, false);
      assert.equal(results[1].shared, true);
      assert.equal(results[2].shared, true);
      assert.equal(coalescer.size, 0);
    });

    it("SingleFlightCoalescer releases lock cleanly in finally block when settlement throws error", async () => {
      const coalescer = new SingleFlightCoalescer<string>();

      const failingTask = () =>
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error("ERR_SETTLEMENT_REJECTED")), 20);
        });

      await assert.rejects(async () => {
        await coalescer.execute("fail_key", failingTask);
      }, /ERR_SETTLEMENT_REJECTED/);

      assert.equal(coalescer.size, 0);
      assert.equal(coalescer.inFlightLocks.has("fail_key"), false);
    });
  });

  // ===========================================================================
  // 3. SettlementCoordinator Test Suite
  // ===========================================================================
  describe("SettlementCoordinator & On-Chain Privacy Decoupling", () => {
    let blockchain: SimulatedBlockchain;
    let usdc: ERC20Token;
    let pool: RailgunPool;
    let relayer: RelayerNetwork;
    let sanctionsRegistry: SanctionsRegistry;
    let ppoiEngine: PPOIEngine;
    let coordinator: SettlementCoordinator;
    let defaultPolicy: SpendingPolicy;

    beforeEach(async () => {
      blockchain = new SimulatedBlockchain();
      usdc = ERC20Token.createWQUAI(blockchain);
      pool = new RailgunPool(blockchain, { mode: "trusted-harness" });

      sanctionsRegistry = new SanctionsRegistry(poseidon2, undefined, 16);
      sanctionsRegistry.loadDefaultSanctions();
      ppoiEngine = new PPOIEngine(sanctionsRegistry, 0);

      pool.registerSanctionedAddress(SANCTIONED_ADDRESS);

      relayer = new RelayerNetwork(
        pool,
        RELAYER_ADDRESS,
        500_000_000_000_000_000n
      );

      defaultPolicy = {
        maxPaymentCap: 50_000_000_000_000_000_000n,
        allowedTokens: [WQUAI],
        allowedChainIds: [9],
        screenRecipients: true
      };

      coordinator = new SettlementCoordinator({
        spendingPolicy: defaultPolicy,
        relayer,
        corporateKeys,
        ppoiEngine,
        sanctionsRegistry
      });

      // Fund corporate treasury in shielded pool
      const treasuryDepositAmount = 100_000_000_000_000_000_000n;
      usdc.mint(pool.contractAddress, treasuryDepositAmount);

      const depositorAddress = "0x0011111154eeb25477b68fb85ed929f73a960582";
      const shieldRes = pool.shield(
        WQUAI,
        treasuryDepositAmount,
        corporateKeys.npk,
        123456n,
        "corporate_treasury_seed",
        depositorAddress
      );

      coordinator.addTreasuryUTXO({
        commitment: shieldRes.commitment,
        leafIndex: shieldRes.leafIndex,
        token: WQUAI.toLowerCase(),
        value: treasuryDepositAmount,
        blinding: 123456n,
        memo: "corporate_treasury_seed",
        depositorAddress,
        depositTimestamp: Math.floor(Date.now() / 1000) - 1000
      });
    });

    it("rejects challenge exceeding corporate maximum payment cap", () => {
      assert.throws(() => {
        coordinator.validatePolicy({
          amount: 60_000_000_000_000_000_000n,
          tokenAddress: WQUAI,
          chainId: 9,
          recipientAddress: CLEAN_MERCHANT
        });
      }, /ERR_SPENDING_POLICY_REJECTED_AMOUNT_EXCEEDS_CAP/);
    });

    it("rejects challenge with unsupported token or chainId", () => {
      assert.throws(() => {
        coordinator.validatePolicy({
          amount: 5_000_000_000_000_000_000n,
          tokenAddress: "0xUnsupportedTokenAddress",
          chainId: 9,
          recipientAddress: CLEAN_MERCHANT
        });
      }, /ERR_UNSUPPORTED_CHAIN_OR_TOKEN/);

      assert.throws(() => {
        coordinator.validatePolicy({
          amount: 5_000_000_000_000_000_000n,
          tokenAddress: WQUAI,
          chainId: 1,
          recipientAddress: CLEAN_MERCHANT
        });
      }, /ERR_UNSUPPORTED_CHAIN_OR_TOKEN/);
    });

    it("rejects challenge if payee recipient is sanctioned", () => {
      assert.throws(() => {
        coordinator.validatePolicy({
          amount: 5_000_000_000_000_000_000n,
          tokenAddress: WQUAI,
          chainId: 9,
          recipientAddress: SANCTIONED_ADDRESS
        });
      }, /ERR_PAYEE_SANCTIONED/);
    });

    it("throws ERR_INSUFFICIENT_TREASURY_FUNDS when no UTXO note covers required amount and fee", async () => {
      coordinator.treasuryUTXOs = [];

      await assert.rejects(async () => {
        await coordinator.settleChallenge({
          invoiceId: "inv_no_funds",
          amount: 5_000_000_000_000_000_000n,
          tokenAddress: WQUAI,
          chainId: 9,
          recipientAddress: CLEAN_MERCHANT,
          expiresAt: Math.floor(Date.now() / 1000) + 900
        });
      }, /ERR_INSUFFICIENT_TREASURY_FUNDS/);
    });

    it("executes valid ZK unshield settlement via RelayerNetwork ensuring complete on-chain graph decoupling", async () => {
      const invoiceAmount = 5_000_000_000_000_000_000n;
      const relayerFee = relayer.minimumFee;

      const { receipt, headers } = await coordinator.settleChallenge({
        invoiceId: "inv_settle_001",
        amount: invoiceAmount,
        tokenAddress: WQUAI,
        chainId: 9,
        recipientAddress: CLEAN_MERCHANT,
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        targetResource: "/api/v1/protected/analytics"
      });

      assert.ok(receipt.txHash);
      assert.equal(receipt.amount, invoiceAmount);
      assert.equal(receipt.relayerAddress.toLowerCase(), relayer.relayerAddress.toLowerCase());
      assert.ok(headers.Authorization.includes(receipt.txHash));

      // On-Chain Graph Decoupling Verification:
      // Broadcaster must be Relayer, corporate address must be absent from blockchain transaction log
      const blocks = blockchain.blocks;
      const latestBlock = blocks[blocks.length - 1];
      const unshieldTx = latestBlock.transactions.find((tx) => tx.hash === receipt.txHash);

      assert.ok(unshieldTx, "Unshield transaction must be recorded in blockchain ledger");
      assert.equal(unshieldTx.from.toLowerCase(), relayer.relayerAddress.toLowerCase());
      assert.notEqual(
        unshieldTx.from.toLowerCase(),
        corporateKeys.corporate0zkAddress.toLowerCase()
      );

      // Verify vendor received payment
      assert.equal(usdc.balanceOf(CLEAN_MERCHANT), invoiceAmount);

      // Verify relayer received fee
      assert.equal(usdc.balanceOf(relayer.relayerAddress), relayerFee);

      // Verify change note was registered in coordinator treasury
      assert.equal(coordinator.treasuryUTXOs.length, 1);
      const changeNote = coordinator.treasuryUTXOs[0];
      assert.equal(changeNote.value, 100_000_000_000_000_000_000n - (invoiceAmount + relayerFee));
    });

    it("quarantines note and rejects unshield when depositor is in sanctions SMT (PPOI)", async () => {
      const poisonedAmount = 20_000_000_000_000_000_000n;
      usdc.mint(pool.contractAddress, poisonedAmount);
      const shieldRes = pool.shield(
        WQUAI,
        poisonedAmount,
        corporateKeys.npk,
        999n,
        "poisoned_deposit",
        SANCTIONED_ADDRESS
      );

      coordinator.treasuryUTXOs = [
        {
          commitment: shieldRes.commitment,
          leafIndex: shieldRes.leafIndex,
          token: WQUAI.toLowerCase(),
          value: poisonedAmount,
          blinding: 999n,
          memo: "poisoned_deposit",
          depositorAddress: SANCTIONED_ADDRESS,
          depositTimestamp: Math.floor(Date.now() / 1000) - 100
        }
      ];

      await assert.rejects(async () => {
        await coordinator.settleChallenge({
          invoiceId: "inv_poisoned",
          amount: 5_000_000_000_000_000_000n,
          tokenAddress: WQUAI,
          chainId: 9,
          recipientAddress: CLEAN_MERCHANT,
          expiresAt: Math.floor(Date.now() / 1000) + 900
        });
      }, /PPOI_SANCTIONED_INPUT/);
    });
  });

  // ===========================================================================
  // 4. OutboundPaymentInterceptor & PaymentClient Test Suite
  // ===========================================================================
  describe("OutboundPaymentInterceptor & PaymentClient", () => {
    let blockchain: SimulatedBlockchain;
    let usdc: ERC20Token;
    let pool: RailgunPool;
    let relayer: RelayerNetwork;
    let resourceServer: ResourceServer;
    let interceptor: OutboundPaymentInterceptor;

    beforeEach(async () => {
      blockchain = new SimulatedBlockchain();
      usdc = ERC20Token.createWQUAI(blockchain);
      pool = new RailgunPool(blockchain, { mode: "trusted-harness" });

      relayer = new RelayerNetwork(
        pool,
        RELAYER_ADDRESS,
        500_000_000_000_000_000n
      );

      resourceServer = new ResourceServer({ demo: true });

      const policy: SpendingPolicy = {
        maxPaymentCap: 50_000_000_000_000_000_000n,
        allowedTokens: [WQUAI],
        allowedChainIds: [9]
      };

      interceptor = new OutboundPaymentInterceptor(policy, relayer, corporateKeys);

      // Seed treasury notes
      const seedAmount = 100_000_000_000_000_000_000n;
      usdc.mint(pool.contractAddress, seedAmount);
      const depositorAddress = "0x0033333354eeb25477b68fb85ed929f73a960582";
      const shieldRes = pool.shield(
        WQUAI,
        seedAmount,
        corporateKeys.npk,
        12345n,
        "seed",
        depositorAddress
      );

      interceptor.addTreasuryUTXO({
        commitment: shieldRes.commitment,
        leafIndex: shieldRes.leafIndex,
        token: WQUAI.toLowerCase(),
        value: seedAmount,
        blinding: 12345n,
        memo: "seed",
        depositorAddress,
        depositTimestamp: Math.floor(Date.now() / 1000) - 500
      });
    });

    it("intercepts 402 challenge, executes unshield settlement, and retries request returning 200 OK", async () => {
      const targetUrl = "/api/v1/protected/analytics";

      const res = await interceptor.fetchWithPayment(targetUrl, (headers) =>
        resourceServer.handleRequest("GET", targetUrl, headers)
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.status, "success");
      assert.equal(res.fromCache, undefined);

      assert.equal(interceptor.receiptCache.has(targetUrl), true);
    });

    it("serves subsequent request directly from receipt cache without re-unshielding", async () => {
      const targetUrl = "/api/v1/protected/analytics";

      const res1 = await interceptor.fetchWithPayment(targetUrl, (h) =>
        resourceServer.handleRequest("GET", targetUrl, h)
      );
      assert.equal(res1.status, 200);

      const unshieldEventsBefore = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;

      const res2 = await interceptor.fetchWithPayment(targetUrl, (h) =>
        resourceServer.handleRequest("GET", targetUrl, h)
      );
      assert.equal(res2.status, 200);
      assert.equal(res2.fromCache, true);

      const unshieldEventsAfter = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;
      assert.equal(unshieldEventsBefore, unshieldEventsAfter);
    });

    it("evicts stale cached receipt when server responds 402 and completes fresh settlement", async () => {
      const targetUrl = "/api/v1/protected/analytics";

      interceptor.receiptCache.set(targetUrl, {
        cacheKey: targetUrl,
        invoiceId: "inv_revoked_test",
        txHash: "0xrevoked_hash",
        relayerAddress: relayer.relayerAddress,
        amount: 5_000_000_000_000_000_000n,
        token: WQUAI,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });

      const res = await interceptor.fetchWithPayment(targetUrl, (h) =>
        resourceServer.handleRequest("GET", targetUrl, h)
      );

      assert.equal(res.status, 200);
      const activeReceipt = interceptor.receiptCache.get(targetUrl);
      assert.ok(activeReceipt);
      assert.notEqual(activeReceipt?.invoiceId, "inv_revoked_test");
    });

    it("coalesces 20 concurrent requests to same endpoint into exactly 1 unshield transaction", async () => {
      const targetUrl = "/api/v1/protected/analytics";
      const unshieldsBefore = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;

      const requests = Array.from({ length: 20 }).map(() =>
        interceptor.fetchWithPayment(targetUrl, (h) =>
          resourceServer.handleRequest("GET", targetUrl, h)
        )
      );

      const responses = await Promise.all(requests);
      for (const res of responses) {
        assert.equal(res.status, 200);
      }

      const unshieldsAfter = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;
      assert.equal(unshieldsAfter - unshieldsBefore, 1);
    });

    it("PaymentClient wraps native fetch and handles 402 interception transparently", async () => {
      const simulatedFetch: typeof globalThis.fetch = async (input, init) => {
        const urlStr = typeof input === "string" ? input : (input as any).toString();
        const headers: Record<string, string> = {};
        if (init?.headers) {
          if (typeof (init.headers as any).forEach === "function") {
            (init.headers as any).forEach((v: string, k: string) => {
              headers[k] = v;
            });
          } else {
            Object.assign(headers, init.headers);
          }
        }
        const res = await resourceServer.handleRequest("GET", urlStr, headers);
        return new Response(JSON.stringify(res.body), {
          status: res.status,
          headers: res.headers
        });
      };

      const client = new PaymentClient({
        spendingPolicy: {
          maxPaymentCap: 50_000_000_000_000_000_000n,
          allowedTokens: [WQUAI],
          allowedChainIds: [9]
        },
        relayer,
        corporateKeys,
        treasuryUTXOs: interceptor.treasuryUTXOs,
        fetchFn: simulatedFetch
      });

      const response = await client.fetch("/api/v1/protected/analytics");
      assert.equal(response.status, 200);
      const json: any = await response.json();
      assert.equal(json.status, "success");
    });

    it("OutboundPaymentProxy class provides 100% contract compatibility", async () => {
      const proxy = new OutboundPaymentProxy(
        interceptor.spendingPolicy,
        relayer,
        corporateKeys,
        interceptor.treasuryUTXOs
      );

      assert.ok(proxy.receiptCache instanceof ReceiptCache);
      assert.ok(proxy.inFlightLocks instanceof Map);

      const res = await proxy.fetchWithPayment("/api/v1/protected/analytics", (h) =>
        resourceServer.handleRequest("GET", "/api/v1/protected/analytics", h)
      );
      assert.equal(res.status, 200);
    });
  });
});
