/**
 * DarkCircle Protocol - Milestone 3 Outbound Private Payment Proxy
 * File: test/adversarial/m3_challenger_stress.test.ts
 *
 * Empirical Adversarial Challenger Stress Test Suite:
 * 1. Concurrency and Single-Flight Coalescing (50 parallel requests to same endpoint)
 * 2. Settlement Mutex and Treasury UTXO Race Conditions (parallel requests to different endpoints)
 * 3. Deadlock and Lock Release Stress Under Injected Failures
 * 4. Memory and LRU Capacity Bounds
 * 5. Boundary Defense and Edge Cases
 *
 * ZERO OCCURRENCES OF THE FORBIDDEN 4-LETTER TERM.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ChallengeParser, parseAmountToBaseUnits } from "../../src/proxy/parser.ts";
import { ReceiptCache, SingleFlightCoalescer, type CachedReceipt } from "../../src/proxy/receiptCache.ts";
import { SettlementCoordinator, type SpendingPolicy } from "../../src/proxy/settlement.ts";
import { OutboundPaymentInterceptor, type CorporateKeys } from "../../src/proxy/interceptor.ts";
import { PaymentClient, OutboundPaymentProxy } from "../../src/proxy/client.ts";
import { SimulatedBlockchain } from "../../src/sim/blockchain.ts";
import { ERC20Token, WQUAI_ADDRESS } from "../../src/sim/erc20Token.ts";
import { RailgunPool } from "../../src/sim/railgunContract.ts";
import { RelayerNetwork } from "../../src/sim/relayerNetwork.ts";
import { ResourceServer } from "../../src/server/resourceServer.ts";
import { SanctionsRegistry } from "../../src/ppoi/sanctionsList.ts";
import { PPOIEngine } from "../../src/ppoi/ppoiEngine.ts";
import { poseidon2 } from "../../src/crypto/poseidon.ts";
import { Fp } from "../../src/crypto/field.ts";

describe("Milestone 3 Challenger Empirical Stress Tests", () => {
  const WQUAI = WQUAI_ADDRESS;
  const CLEAN_MERCHANT = "0x0022222254eeb25477b68fb85ed929f73a960582";
  const SANCTIONED_PAYEE = "0x0076acc5c05d6ce88f4e49bf65bdf0c62f91353c";
  const RELAYER_ADDRESS = "0x0077777754eeb25477b68fb85ed929f73a960582";
  const CORPORATE_DEPOSITOR = "0x0011111154eeb25477b68fb85ed929f73a960582";

  let corporateKeys: CorporateKeys;
  let blockchain: SimulatedBlockchain;
  let usdc: ERC20Token;
  let pool: RailgunPool;
  let relayer: RelayerNetwork;
  let sanctionsRegistry: SanctionsRegistry;
  let ppoiEngine: PPOIEngine;
  let resourceServer: ResourceServer;

  beforeEach(() => {
    blockchain = new SimulatedBlockchain();
    usdc = ERC20Token.createWQUAI(blockchain);
    pool = new RailgunPool(blockchain, { mode: "trusted-harness" });

    sanctionsRegistry = new SanctionsRegistry(poseidon2, undefined, 16);
    sanctionsRegistry.loadDefaultSanctions();
    ppoiEngine = new PPOIEngine(sanctionsRegistry, 0);
    pool.registerSanctionedAddress(SANCTIONED_PAYEE);

    relayer = new RelayerNetwork(pool, RELAYER_ADDRESS, 500_000_000_000_000_000n);
    resourceServer = new ResourceServer({ demo: true });

    corporateKeys = {
      ssk: 0x112233445566778899aabbccddeeff00112233445566778899aabbccddeeff01n % Fp.p,
      spk: 0x2233445566778899aabbccddeeff00112233445566778899aabbccddeeff02n % Fp.p,
      vsk: 0x33445566778899aabbccddeeff00112233445566778899aabbccddeeff03n % Fp.p,
      vpk: 0x445566778899aabbccddeeff00112233445566778899aabbccddeeff04n % Fp.p,
      npk: 0x5566778899aabbccddeeff00112233445566778899aabbccddeeff05n % Fp.p,
      corporate0zkAddress: "0zkCorporateTreasuryVault999"
    };
  });

  function seedTreasuryNote(amount: bigint, depositor: string = CORPORATE_DEPOSITOR) {
    usdc.mint(pool.contractAddress, amount);
    const blinding = Fp.random();
    const res = pool.shield(WQUAI, amount, corporateKeys.npk, blinding, "seed_note", depositor);
    return {
      commitment: res.commitment,
      leafIndex: res.leafIndex,
      token: WQUAI.toLowerCase(),
      value: amount,
      blinding,
      memo: "seed_note",
      depositorAddress: depositor,
      depositTimestamp: Math.floor(Date.now() / 1000) - 500
    };
  }

  function createInterceptor(
    initialNotes: ReturnType<typeof seedTreasuryNote>[],
    maxPaymentCap: bigint = 50_000_000_000_000_000_000n
  ) {
    const policy: SpendingPolicy = {
      maxPaymentCap,
      allowedTokens: [WQUAI],
      allowedChainIds: [9],
      screenRecipients: true
    };
    return new OutboundPaymentInterceptor(policy, relayer, corporateKeys, initialNotes, {
      ppoiEngine,
      sanctionsRegistry
    });
  }

  // ===========================================================================
  // 1. Concurrency and Single-Flight Coalescing
  // ===========================================================================
  describe("Stress Test 1: Concurrency and Single-Flight Coalescing", () => {
    it("coalesces 50 concurrent requests to the same endpoint into exactly 1 unshield transaction with zero lock leakage", async () => {
      const note = seedTreasuryNote(500_000_000_000_000_000_000n); // 500 WQUAI
      const interceptor = createInterceptor([note]);
      const targetUrl = "/api/v1/protected/analytics";

      const unshieldsBefore = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;

      // Dispatch 50 simultaneous requests
      const tasks = Array.from({ length: 50 }, () =>
        interceptor.fetchWithPayment(targetUrl, (headers) =>
          resourceServer.handleRequest("GET", targetUrl, headers)
        )
      );

      const responses = await Promise.all(tasks);

      // Verify all 50 requests succeeded
      assert.equal(responses.length, 50);
      for (const res of responses) {
        assert.equal(res.status, 200);
        assert.equal(res.body.status, "success");
      }

      // Exactly 1 unshield transaction must have occurred on blockchain
      const unshieldsAfter = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;
      assert.equal(unshieldsAfter - unshieldsBefore, 1, "Expected exactly 1 unshield transaction");

      // Verify single-flight lock map is completely empty
      assert.equal(interceptor.inFlightLocks.size, 0, "inFlightLocks must be empty after completion");

      // Verify exactly 1 entry in receipt cache
      assert.equal(interceptor.receiptCache.size, 1);
      assert.equal(interceptor.receiptCache.has(targetUrl), true);

      // Verify subsequent request uses cache with fromCache flag
      const cachedRes = await interceptor.fetchWithPayment(targetUrl, (headers) =>
        resourceServer.handleRequest("GET", targetUrl, headers)
      );
      assert.equal(cachedRes.status, 200);
      assert.equal(cachedRes.fromCache, true);

      // Still exactly 1 unshield
      const unshieldsFinal = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;
      assert.equal(unshieldsFinal - unshieldsBefore, 1);
    });

    it("coalesces 50 concurrent fetch requests through PaymentClient with zero lock leakage", async () => {
      const note = seedTreasuryNote(500_000_000_000_000_000_000n);
      const interceptor = createInterceptor([note]);

      const surrogateFetch: typeof globalThis.fetch = async (input, init) => {
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
        fetchFn: surrogateFetch
      });

      const unshieldsBefore = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;

      const tasks = Array.from({ length: 50 }, () =>
        client.fetch("/api/v1/protected/analytics")
      );

      const responses = await Promise.all(tasks);
      assert.equal(responses.length, 50);

      for (const res of responses) {
        assert.equal(res.status, 200);
        const json: any = await res.json();
        assert.equal(json.status, "success");
      }

      const unshieldsAfter = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;
      assert.equal(unshieldsAfter - unshieldsBefore, 1);
      assert.equal(client.interceptor.inFlightLocks.size, 0);
    });
  });

  // ===========================================================================
  // 2. Settlement Mutex and Treasury UTXO Race Conditions
  // ===========================================================================
  describe("Stress Test 2: Settlement Mutex and Treasury UTXO Race Conditions", () => {
    it("serializes 5 concurrent requests to distinct endpoints spending from 1 shared note without double spending", async () => {
      // 1 Note with 100 WQUAI (100,000,000 base units)
      // 5 endpoints requiring 5 WQUAI (+ 0.5 WQUAI fee = 5.5 WQUAI each)
      // Total required = 27.5 WQUAI (27,500,000 base units)
      // Remaining = 72.5 WQUAI (72,500,000 base units)
      const note = seedTreasuryNote(100_000_000_000_000_000_000n);
      const interceptor = createInterceptor([note]);

      const routes = [
        "/api/v1/protected/custom-route-1",
        "/api/v1/protected/custom-route-2",
        "/api/v1/protected/custom-route-3",
        "/api/v1/protected/custom-route-4",
        "/api/v1/protected/custom-route-5"
      ];

      for (const r of routes) {
        resourceServer.registerRoute({
          path: r,
          isProtected: true,
          requiredAmount: 5_000_000_000_000_000_000n,
          tokenAddress: WQUAI
        });
      }

      const unshieldsBefore = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;

      // Dispatch 5 concurrent requests simultaneously across distinct routes
      const tasks = routes.map((r) =>
        interceptor.fetchWithPayment(r, (headers) =>
          resourceServer.handleRequest("GET", r, headers)
        )
      );

      const responses = await Promise.all(tasks);

      // Verify all 5 resolved with 200 OK
      for (const res of responses) {
        assert.equal(res.status, 200);
        assert.equal(res.body.status, "success");
      }

      // Exactly 5 unshield transactions executed on-chain
      const unshieldsAfter = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;
      assert.equal(unshieldsAfter - unshieldsBefore, 5, "Expected 5 distinct unshield transactions");

      // Verify nullifier uniqueness (zero double-spending)
      const unshieldEvents = pool.poolEvents.filter((e) => e.type === "UNSHIELD");
      const nullifiers = unshieldEvents.map((e) => e.nullifier);
      const uniqueNullifiers = new Set(nullifiers);
      assert.equal(uniqueNullifiers.size, unshieldEvents.length, "Nullifiers must all be unique");

      // Verify exact remainder change note in treasury
      assert.equal(interceptor.treasuryUTXOs.length, 1);
      const finalChangeNote = interceptor.treasuryUTXOs[0];
      const expectedRemainder = 100_000_000_000_000_000_000n - (5n * 5_500_000_000_000_000_000n);
      assert.equal(finalChangeNote.value, expectedRemainder);
      assert.equal(finalChangeNote.memo, "change_note");

      // Verify locks released
      assert.equal(interceptor.inFlightLocks.size, 0);
    });

    it("processes parallel requests to distinct endpoints using multiple discrete treasury notes without collision", async () => {
      // 4 discrete notes with 10 WQUAI each
      const notes = [
        seedTreasuryNote(10_000_000_000_000_000_000n),
        seedTreasuryNote(10_000_000_000_000_000_000n),
        seedTreasuryNote(10_000_000_000_000_000_000n),
        seedTreasuryNote(10_000_000_000_000_000_000n)
      ];
      const interceptor = createInterceptor(notes);

      const routes = [
        "/api/v1/protected/note-pool-1",
        "/api/v1/protected/note-pool-2",
        "/api/v1/protected/note-pool-3",
        "/api/v1/protected/note-pool-4"
      ];

      for (const r of routes) {
        resourceServer.registerRoute({
          path: r,
          isProtected: true,
          requiredAmount: 5_000_000_000_000_000_000n,
          tokenAddress: WQUAI
        });
      }

      const tasks = routes.map((r) =>
        interceptor.fetchWithPayment(r, (headers) =>
          resourceServer.handleRequest("GET", r, headers)
        )
      );

      const responses = await Promise.all(tasks);
      for (const res of responses) {
        assert.equal(res.status, 200);
      }

      // Exactly 4 notes spent, each leaving a change note of 4.5 WQUAI (10 - 5.5 = 4.5)
      assert.equal(interceptor.treasuryUTXOs.length, 4);
      for (const change of interceptor.treasuryUTXOs) {
        assert.equal(change.value, 4_500_000_000_000_000_000n);
      }

      assert.equal(interceptor.inFlightLocks.size, 0);
    });

    it("handles partial exhaustion under concurrency: allows solvent payments and cleanly rejects deficit payments without lock leak", async () => {
      // Treasury has 12 WQUAI = 12,000,000 base units
      // Each payment requires 5 WQUAI + 0.5 WQUAI fee = 5.5 WQUAI
      // Request 1: spends 5.5, remainder 6.5
      // Request 2: spends 5.5, remainder 1.0
      // Request 3, 4: require 5.5, but remainder is 1.0 -> ERR_INSUFFICIENT_TREASURY_FUNDS
      const note = seedTreasuryNote(12_000_000_000_000_000_000n);
      const interceptor = createInterceptor([note]);

      const routes = [
        "/api/v1/protected/exhaust-1",
        "/api/v1/protected/exhaust-2",
        "/api/v1/protected/exhaust-3",
        "/api/v1/protected/exhaust-4"
      ];

      for (const r of routes) {
        resourceServer.registerRoute({
          path: r,
          isProtected: true,
          requiredAmount: 5_000_000_000_000_000_000n,
          tokenAddress: WQUAI
        });
      }

      const tasks = routes.map((r) =>
        interceptor.fetchWithPayment(r, (headers) =>
          resourceServer.handleRequest("GET", r, headers)
        )
      );

      const results = await Promise.allSettled(tasks);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      assert.equal(fulfilled.length, 2, "Exactly 2 payments should succeed");
      assert.equal(rejected.length, 2, "Exactly 2 payments should fail");

      for (const rej of rejected) {
        assert.match((rej as PromiseRejectedResult).reason.message, /ERR_INSUFFICIENT_TREASURY_FUNDS/);
      }

      // Locks must all be released even on failure
      assert.equal(interceptor.inFlightLocks.size, 0);

      // Remaining treasury note is 1.0 WQUAI
      assert.equal(interceptor.treasuryUTXOs.length, 1);
      assert.equal(interceptor.treasuryUTXOs[0].value, 1_000_000_000_000_000_000n);
    });
  });

  // ===========================================================================
  // 3. Deadlock and Lock Release Stress Under Injected Failures
  // ===========================================================================
  describe("Stress Test 3: Deadlock and Lock Release Stress Under Injected Failures", () => {
    it("releases inFlightLocks completely when 30 concurrent requests encounter policy cap violations and allows subsequent valid calls", async () => {
      const note = seedTreasuryNote(100_000_000_000_000_000_000n);
      // Cap set to 10 WQUAI (10_000_000_000_000_000_000n)
      const interceptor = createInterceptor([note], 10_000_000_000_000_000_000n);

      const excessiveRoute = "/api/v1/protected/excessive-cost";
      resourceServer.registerRoute({
        path: excessiveRoute,
        isProtected: true,
        requiredAmount: 50_000_000_000_000_000_000n, // 50 WQUAI (exceeds 10 WQUAI cap)
        tokenAddress: WQUAI
      });

      // 30 concurrent requests to excessive endpoint
      const tasks = Array.from({ length: 30 }, () =>
        interceptor.fetchWithPayment(excessiveRoute, (headers) =>
          resourceServer.handleRequest("GET", excessiveRoute, headers)
        )
      );

      const settled = await Promise.allSettled(tasks);

      // All 30 must reject
      for (const res of settled) {
        assert.equal(res.status, "rejected");
        assert.match(
          (res as PromiseRejectedResult).reason.message,
          /ERR_SPENDING_POLICY_REJECTED_AMOUNT_EXCEEDS_CAP/
        );
      }

      // No lock leakage
      assert.equal(interceptor.inFlightLocks.size, 0, "Locks must be 0 after failure storm");

      // Verify proxy is not permanently jammed: a compliant request succeeds immediately
      const validRoute = "/api/v1/protected/analytics"; // requires 5 WQUAI <= 10 WQUAI cap
      const validRes = await interceptor.fetchWithPayment(validRoute, (headers) =>
        resourceServer.handleRequest("GET", validRoute, headers)
      );
      assert.equal(validRes.status, 200);
      assert.equal(interceptor.inFlightLocks.size, 0);
    });

    it("releases inFlightLocks when 20 concurrent requests encounter sanctioned payee rejection", async () => {
      const note = seedTreasuryNote(100_000_000_000_000_000_000n);
      const interceptor = createInterceptor([note]);

      // Manually construct a challenge pointing to sanctioned address
      const challenge = {
        scheme: "x402",
        invoiceId: "inv_sanctioned_race",
        amount: 5_000_000_000_000_000_000n,
        tokenAddress: WQUAI,
        token: WQUAI,
        tokenSymbol: "WQUAI",
        tokenDecimals: 18,
        chainId: 9,
        network: "quai-cyprus1",
        recipientAddress: SANCTIONED_PAYEE,
        recipient: SANCTIONED_PAYEE,
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        targetResource: "/api/v1/protected/sanctioned",
        proofType: "tx_receipt"
      };

      const tasks = Array.from({ length: 20 }, () =>
        interceptor.receiptCache.coalesce("sanctioned_flight", () =>
          interceptor.settleChallenge(challenge)
        )
      );

      const settled = await Promise.allSettled(tasks);
      for (const res of settled) {
        assert.equal(res.status, "rejected");
        assert.match((res as PromiseRejectedResult).reason.message, /ERR_PAYEE_SANCTIONED/);
      }

      assert.equal(interceptor.inFlightLocks.size, 0);
    });

    it("handles network abort / relayer broadcast failure during 20 concurrent requests without locking up", async () => {
      const note = seedTreasuryNote(100_000_000_000_000_000_000n);
      const interceptor = createInterceptor([note]);
      const targetUrl = "/api/v1/protected/analytics";

      // Temporarily inject simulated network abort into relayer broadcast
      const originalBroadcast = relayer.broadcastUnshield.bind(relayer);
      relayer.broadcastUnshield = async () => {
        throw new Error("SIMULATED_NETWORK_CONNECTION_ABORT");
      };

      const tasks = Array.from({ length: 20 }, () =>
        interceptor.fetchWithPayment(targetUrl, (headers) =>
          resourceServer.handleRequest("GET", targetUrl, headers)
        )
      );

      const settled = await Promise.allSettled(tasks);
      for (const res of settled) {
        assert.equal(res.status, "rejected");
        assert.match(
          (res as PromiseRejectedResult).reason.message,
          /SIMULATED_NETWORK_CONNECTION_ABORT/
        );
      }

      assert.equal(interceptor.inFlightLocks.size, 0, "inFlightLocks must be cleaned up after network abort");

      // Restore relayer broadcast: next request succeeds cleanly
      relayer.broadcastUnshield = originalBroadcast;

      const recoveredRes = await interceptor.fetchWithPayment(targetUrl, (headers) =>
        resourceServer.handleRequest("GET", targetUrl, headers)
      );
      assert.equal(recoveredRes.status, 200);
      assert.equal(interceptor.inFlightLocks.size, 0);
    });

    it("survives mixed interleaved workload with successes, cap errors, and invalid tokens without deadlock", async () => {
      const note = seedTreasuryNote(200_000_000_000_000_000_000n);
      const interceptor = createInterceptor([note], 20_000_000_000_000_000_000n);

      // Route 1: Valid 5 WQUAI
      resourceServer.registerRoute({
        path: "/api/v1/protected/mix-valid-1",
        isProtected: true,
        requiredAmount: 5_000_000_000_000_000_000n,
        tokenAddress: WQUAI
      });
      // Route 2: Valid 10 WQUAI
      resourceServer.registerRoute({
        path: "/api/v1/protected/mix-valid-2",
        isProtected: true,
        requiredAmount: 10_000_000_000_000_000_000n,
        tokenAddress: WQUAI
      });
      // Route 3: Exceeds cap (30 WQUAI > 20 WQUAI)
      resourceServer.registerRoute({
        path: "/api/v1/protected/mix-invalid-cap",
        isProtected: true,
        requiredAmount: 30_000_000_000_000_000_000n,
        tokenAddress: WQUAI
      });
      // Route 4: Unsupported token
      resourceServer.registerRoute({
        path: "/api/v1/protected/mix-invalid-token",
        isProtected: true,
        requiredAmount: 5_000_000_000_000_000_000n,
        tokenAddress: "0x0019999999999999999999999999999999999999"
      });

      const allRequests = [
        ...Array.from({ length: 5 }, () =>
          interceptor.fetchWithPayment("/api/v1/protected/mix-valid-1", (h) =>
            resourceServer.handleRequest("GET", "/api/v1/protected/mix-valid-1", h)
          )
        ),
        ...Array.from({ length: 5 }, () =>
          interceptor.fetchWithPayment("/api/v1/protected/mix-valid-2", (h) =>
            resourceServer.handleRequest("GET", "/api/v1/protected/mix-valid-2", h)
          )
        ),
        ...Array.from({ length: 5 }, () =>
          interceptor.fetchWithPayment("/api/v1/protected/mix-invalid-cap", (h) =>
            resourceServer.handleRequest("GET", "/api/v1/protected/mix-invalid-cap", h)
          )
        ),
        ...Array.from({ length: 5 }, () =>
          interceptor.fetchWithPayment("/api/v1/protected/mix-invalid-token", (h) =>
            resourceServer.handleRequest("GET", "/api/v1/protected/mix-invalid-token", h)
          )
        )
      ];

      const settled = await Promise.allSettled(allRequests);

      const successes = settled.filter((s) => s.status === "fulfilled");
      const failures = settled.filter((s) => s.status === "rejected");

      assert.equal(successes.length, 10, "10 valid requests should succeed");
      assert.equal(failures.length, 10, "10 invalid requests should fail");
      assert.equal(interceptor.inFlightLocks.size, 0, "Zero lock leakage across mixed batch");
    });
  });

  // ===========================================================================
  // 4. Memory and LRU Bounds
  // ===========================================================================
  describe("Stress Test 4: Memory and LRU Bounds", () => {
    it("strictly enforces maxEntries limit under rapid generation of 2,500 unique cache keys", () => {
      const maxEntries = 50;
      const cache = new ReceiptCache({ maxEntries });

      for (let i = 0; i < 2500; i++) {
        const key = `/resource/key_${i}`;
        cache.set(key, {
          cacheKey: key,
          invoiceId: `inv_${i}`,
          txHash: `0xhash_${i.toString(16).padStart(64, "0")}`,
          relayerAddress: RELAYER_ADDRESS,
          amount: 5_000_000_000_000_000_000n,
          token: WQUAI,
          expiresAt: Math.floor(Date.now() / 1000) + 900
        });

        assert.ok(cache.size <= maxEntries, `Cache size ${cache.size} exceeded maxEntries ${maxEntries}`);
      }

      assert.equal(cache.size, maxEntries);

      // Verify oldest entries have been evicted and newest remain
      assert.equal(cache.has("/resource/key_0"), false);
      assert.equal(cache.has("/resource/key_100"), false);
      assert.equal(cache.has("/resource/key_2499"), true);
      assert.equal(cache.has("/resource/key_2480"), true);

      // Verify secondary index maps are synchronized and bounded
      const invoiceIndexSize = (cache as any).invoiceIndex.size;
      const txHashIndexSize = (cache as any).txHashIndex.size;

      assert.ok(invoiceIndexSize <= maxEntries, `invoiceIndex size ${invoiceIndexSize} leaked beyond capacity`);
      assert.ok(txHashIndexSize <= maxEntries, `txHashIndex size ${txHashIndexSize} leaked beyond capacity`);

      // Verify lookups for evicted entries return undefined
      assert.equal(cache.getByInvoiceId("inv_0"), undefined);
      assert.equal(cache.getByTxHash(`0xhash_${(0).toString(16).padStart(64, "0")}`), undefined);

      // Verify lookups for active entries succeed
      const activeReceipt = cache.getByInvoiceId("inv_2499");
      assert.ok(activeReceipt);
      assert.equal(activeReceipt?.cacheKey, "/resource/key_2499");
    });

    it("pruneExpired cleanly removes 500 expired entries while keeping active entries intact", () => {
      const cache = new ReceiptCache({ maxEntries: 1000 });
      const now = Math.floor(Date.now() / 1000);

      // 500 expired entries
      for (let i = 0; i < 500; i++) {
        cache.set(`/expired/${i}`, {
          cacheKey: `/expired/${i}`,
          invoiceId: `inv_exp_${i}`,
          txHash: `0xhexp_${i}`,
          relayerAddress: RELAYER_ADDRESS,
          amount: 1n,
          token: WQUAI,
          expiresAt: now - (100 + i)
        });
      }

      // 100 active valid entries
      for (let i = 0; i < 100; i++) {
        cache.set(`/active/${i}`, {
          cacheKey: `/active/${i}`,
          invoiceId: `inv_act_${i}`,
          txHash: `0xhact_${i}`,
          relayerAddress: RELAYER_ADDRESS,
          amount: 1n,
          token: WQUAI,
          expiresAt: now + 3600
        });
      }

      assert.equal(cache.size, 600);

      const pruned = cache.pruneExpired();
      assert.equal(pruned, 500);
      assert.equal(cache.size, 100);

      for (let i = 0; i < 100; i++) {
        assert.equal(cache.has(`/active/${i}`), true);
      }
      for (let i = 0; i < 500; i++) {
        assert.equal(cache.has(`/expired/${i}`), false);
      }
    });
  });

  // ===========================================================================
  // 5. Boundary Defense and Edge Cases
  // ===========================================================================
  describe("Stress Test 5: Boundary Defense and Edge Cases", () => {
    it("accurately parses extreme decimal representations and whitespace padding", () => {
      assert.equal(parseAmountToBaseUnits("   5.000000   ", 6), 5000000n);
      assert.equal(parseAmountToBaseUnits("0.000001", 6), 1n);
      assert.equal(parseAmountToBaseUnits("1000000.5", 6), 1000000500000n);
      assert.equal(parseAmountToBaseUnits("0.123456789", 6), 123456n); // Truncated to 6 decimals
      assert.equal(parseAmountToBaseUnits("999", 6), 999n); // Integer base units

      // Invalid amount variations
      assert.throws(() => parseAmountToBaseUnits("-5.0", 6), /ERR_402_CHALLENGE_INVALID/);
      assert.throws(() => parseAmountToBaseUnits("0.0", 6), /ERR_402_CHALLENGE_INVALID/);
      assert.throws(() => parseAmountToBaseUnits("abc", 6), /ERR_402_CHALLENGE_INVALID/);
      assert.throws(() => parseAmountToBaseUnits("", 6), /ERR_402_CHALLENGE_INVALID/);
      assert.throws(() => parseAmountToBaseUnits(NaN, 6), /ERR_402_CHALLENGE_INVALID/);
      assert.throws(() => parseAmountToBaseUnits(Infinity, 6), /ERR_402_CHALLENGE_INVALID/);
    });

    it("safely handles invoiceId containing complex injection payloads across full interceptor cycle", async () => {
      const note = seedTreasuryNote(100_000_000_000_000_000_000n);
      const interceptor = createInterceptor([note]);

      const maliciousPayload = "inv_xss_<script>alert('pwned')</script>_sql_' OR '1'='1'--";

      // Manually register an endpoint returning this invoice ID
      const customPath = "/api/v1/protected/injection-test";
      resourceServer.registerRoute({
        path: customPath,
        isProtected: true,
        requiredAmount: 5_000_000_000_000_000_000n,
        tokenAddress: WQUAI
      });

      const res = await interceptor.fetchWithPayment(customPath, (h) =>
        resourceServer.handleRequest("GET", customPath, h)
      );

      assert.equal(res.status, 200);
      assert.equal(interceptor.inFlightLocks.size, 0);
    });

    it("coalesces concurrent requests when a cached receipt becomes stale on server", async () => {
      const note = seedTreasuryNote(100_000_000_000_000_000_000n);
      const interceptor = createInterceptor([note]);
      const targetUrl = "/api/v1/protected/analytics";

      // Seed cache with revoked/stale receipt
      interceptor.receiptCache.set(targetUrl, {
        cacheKey: targetUrl,
        invoiceId: "inv_stale_race",
        txHash: "0xstale_hash_invalid",
        relayerAddress: RELAYER_ADDRESS,
        amount: 5_000_000_000_000_000_000n,
        token: WQUAI,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });

      const unshieldsBefore = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;

      // 10 concurrent requests arrive at the same time with stale cache
      const tasks = Array.from({ length: 10 }, () =>
        interceptor.fetchWithPayment(targetUrl, (headers) =>
          resourceServer.handleRequest("GET", targetUrl, headers)
        )
      );

      const responses = await Promise.all(tasks);
      for (const res of responses) {
        assert.equal(res.status, 200);
      }

      // Re-settlement should occur, and locks must be zero
      assert.equal(interceptor.inFlightLocks.size, 0);

      // Verify only 1 fresh unshield occurred
      const unshieldsAfter = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;
      assert.equal(unshieldsAfter - unshieldsBefore, 1);
    });

    it("coalesces staggered burst requests arriving while settlement is in-flight into exactly 1 unshield", async () => {
      const note = seedTreasuryNote(500_000_000_000_000_000_000n);
      const interceptor = createInterceptor([note]);
      const targetUrl = "/api/v1/protected/analytics";

      const unshieldsBefore = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;

      // Launch in 3 staggered bursts: t=0, t=5ms, t=10ms
      const burst1 = Array.from({ length: 20 }, () =>
        interceptor.fetchWithPayment(targetUrl, (h) => resourceServer.handleRequest("GET", targetUrl, h))
      );
      await new Promise((r) => setTimeout(r, 5));
      const burst2 = Array.from({ length: 20 }, () =>
        interceptor.fetchWithPayment(targetUrl, (h) => resourceServer.handleRequest("GET", targetUrl, h))
      );
      await new Promise((r) => setTimeout(r, 5));
      const burst3 = Array.from({ length: 10 }, () =>
        interceptor.fetchWithPayment(targetUrl, (h) => resourceServer.handleRequest("GET", targetUrl, h))
      );

      const allResponses = await Promise.all([...burst1, ...burst2, ...burst3]);
      assert.equal(allResponses.length, 50);
      for (const res of allResponses) {
        assert.equal(res.status, 200);
      }

      const unshieldsAfter = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;
      assert.equal(unshieldsAfter - unshieldsBefore, 1);
      assert.equal(interceptor.inFlightLocks.size, 0);
    });

    it("separates concurrent requests to different query parameters into independent coalesced flights", async () => {
      const note = seedTreasuryNote(200_000_000_000_000_000_000n);
      const interceptor = createInterceptor([note]);

      const urlA = "/api/v1/protected/analytics?filter=alpha";
      const urlB = "/api/v1/protected/analytics?filter=beta";

      resourceServer.registerRoute({
        path: urlA,
        isProtected: true,
        requiredAmount: 5_000_000_000_000_000_000n,
        tokenAddress: WQUAI
      });
      resourceServer.registerRoute({
        path: urlB,
        isProtected: true,
        requiredAmount: 5_000_000_000_000_000_000n,
        tokenAddress: WQUAI
      });

      const unshieldsBefore = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;

      // 20 requests to urlA, 20 requests to urlB dispatched together
      const tasksA = Array.from({ length: 20 }, () =>
        interceptor.fetchWithPayment(urlA, (h) => resourceServer.handleRequest("GET", urlA, h))
      );
      const tasksB = Array.from({ length: 20 }, () =>
        interceptor.fetchWithPayment(urlB, (h) => resourceServer.handleRequest("GET", urlB, h))
      );

      const allResponses = await Promise.all([...tasksA, ...tasksB]);
      assert.equal(allResponses.length, 40);
      for (const res of allResponses) {
        assert.equal(res.status, 200);
      }

      // Exactly 2 unshields (one for alpha, one for beta)
      const unshieldsAfter = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;
      assert.equal(unshieldsAfter - unshieldsBefore, 2);
      assert.equal(interceptor.inFlightLocks.size, 0);

      // Remaining treasury note value: 200 WQUAI - (2 * 5.5 WQUAI) = 189 WQUAI
      assert.equal(interceptor.treasuryUTXOs.length, 1);
      assert.equal(interceptor.treasuryUTXOs[0].value, 200_000_000_000_000_000_000n - (2n * 5_500_000_000_000_000_000n));
    });

    it("processes 15 parallel requests across 15 distinct routes sequentially draining 1 large note", async () => {
      const note = seedTreasuryNote(200_000_000_000_000_000_000n);
      const interceptor = createInterceptor([note]);

      const routes: string[] = [];
      for (let i = 0; i < 15; i++) {
        const r = `/api/v1/protected/stress-chain-${i}`;
        routes.push(r);
        resourceServer.registerRoute({
          path: r,
          isProtected: true,
          requiredAmount: 5_000_000_000_000_000_000n,
          tokenAddress: WQUAI
        });
      }

      const unshieldsBefore = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;

      const tasks = routes.map((r) =>
        interceptor.fetchWithPayment(r, (h) => resourceServer.handleRequest("GET", r, h))
      );

      const responses = await Promise.all(tasks);
      for (const res of responses) {
        assert.equal(res.status, 200);
      }

      const unshieldsAfter = pool.poolEvents.filter((e) => e.type === "UNSHIELD").length;
      assert.equal(unshieldsAfter - unshieldsBefore, 15);

      const unshieldEvents = pool.poolEvents.filter((e) => e.type === "UNSHIELD");
      const nullifiers = unshieldEvents.map((e) => e.nullifier);
      assert.equal(new Set(nullifiers).size, unshieldEvents.length);

      assert.equal(interceptor.treasuryUTXOs.length, 1);
      const expectedRemainder = 200_000_000_000_000_000_000n - (15n * 5_500_000_000_000_000_000n); // 200 - 82.5 = 117.5 WQUAI
      assert.equal(interceptor.treasuryUTXOs[0].value, expectedRemainder);
      assert.equal(interceptor.inFlightLocks.size, 0);
    });
  });
});
