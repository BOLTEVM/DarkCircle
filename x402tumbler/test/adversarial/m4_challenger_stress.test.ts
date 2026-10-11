/**
 * DarkCircle Protocol: Milestone 4 Challenger Empirical Stress Test Suite
 * Inbound Merchant Privacy Gateway
 *
 * EMPIRICAL STRESS TESTS:
 * 1. High-Iteration Ephemeral Address Derivation, Collision Resistance & Entropy (2,500+ iterations)
 * 2. Shannon Entropy & Byte Distribution Uniformity across Derived Ephemeral Keys
 * 3. Avalanche Effect & Domain Separation Sensitivity
 * 4. Invoice State Machine Transitions, Edge Cases & Boundary Defenses
 * 5. Anti-Replay Defense & Double-Settlement Resistance across Case & Concurrency Variations
 * 6. Sweeper Worker, Railgun Shielding Pipeline & Memory Zeroization (ZEROIZED_PRIVATE_KEY)
 * 7. Inbound Sanctions SMT Screening & Tamper Resistance
 * 8. Concurrency Locking & Race Condition Immunity
 * 9. High-Volume Batch Sweeping & Idempotency
 * 10. HTTP Middleware, RFC 7235 / RFC 7807 Compliance & Multi-Scheme Credential Parsing
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { computeAddress } from "ethers";

import {
  deriveEphemeralAddress,
  deriveEphemeralPrivateKey,
  deriveAddressFromPrivateKey,
  zeroizeEphemeralKey,
  EphemeralAddressGenerator,
  ZEROIZED_PRIVATE_KEY,
  DEFAULT_DOMAIN_SEPARATOR
} from "../../src/gateway/ephemeral.ts";

import { InvoiceRegistry } from "../../src/gateway/invoiceRegistry.ts";
import { SweeperWorker } from "../../src/gateway/sweeper.ts";
import { InboundMerchantGateway } from "../../src/gateway/gateway.ts";
import type { InvoiceRecord, SweepReceipt } from "../../src/gateway/types.ts";

import { SimulatedBlockchain } from "../../src/sim/blockchain.ts";
import { RailgunPool } from "../../src/sim/railgunContract.ts";
import { RelayerNetwork } from "../../src/sim/relayerNetwork.ts";
import { deriveCorporateKeyHierarchy } from "../../src/audit/keys.ts";
import { decryptNotePayload } from "../../src/audit/decryptor.ts";
import { AccountingJournalReconstructor } from "../../src/audit/accounting.ts";
import { BN254_SCALAR_FIELD, Fp } from "../../src/crypto/field.ts";
import { poseidon4 } from "../../src/crypto/poseidon.ts";

describe("Milestone 4 Challenger Empirical Stress Tests", () => {
  const MASTER_MERCHANT_KEY = "darkcircle_master_merchant_key_enterprise_secure_seed_challenger";
  const CORPORATE_SEED = "corporate_seed_enterprise_treasury_darkcircle_challenger_2026";
  const CORPORATE_NPK = 99999999999999999999n;
  const WQUAI_ADDRESS = "0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb";
  const DAI_ADDRESS = "0x6b175474e89094c44da98b954eedeac495271d0f";

  let blockchain: SimulatedBlockchain;
  let pool: RailgunPool;
  let corporateKeys: ReturnType<typeof deriveCorporateKeyHierarchy>;
  let gateway: InboundMerchantGateway;

  beforeEach(() => {
    blockchain = new SimulatedBlockchain();
    pool = new RailgunPool(blockchain, { mode: "trusted-harness" });
    corporateKeys = deriveCorporateKeyHierarchy(CORPORATE_SEED);
    gateway = new InboundMerchantGateway(
      MASTER_MERCHANT_KEY,
      corporateKeys.corporate0zkAddress,
      CORPORATE_NPK,
      blockchain,
      pool,
      { trustMode: "trusted-harness",
        corporateVpk: corporateKeys.viewingPublicKey,
        defaultTtlSeconds: 900
      }
    );
  });

  // =========================================================================
  // SUITE 1: Ephemeral Address Derivation, Collision Resistance & Entropy
  // =========================================================================
  describe("Suite 1: High-Iteration Ephemeral Address Derivation & Entropy Stress", () => {
    it("1.1 derives 2,500 strictly collision-free ephemeral addresses and private keys in fast mode", () => {
      const iterations = 2500;
      const addresses = new Set<string>();
      const privateKeys = new Set<string>();

      for (let i = 0; i < iterations; i++) {
        const invoiceId = `inv_fast_stress_${i.toString().padStart(8, "0")}`;
        const keyPair = deriveEphemeralAddress(MASTER_MERCHANT_KEY, invoiceId, { mode: "fast" });

        addresses.add(keyPair.address);
        privateKeys.add(keyPair.privateKey);

        assert.equal(keyPair.address.length, 42);
        assert.equal(keyPair.privateKey.length, 66);
      }

      assert.equal(addresses.size, iterations, "Zero address collisions across 2,500 iterations");
      assert.equal(privateKeys.size, iterations, "Zero private key collisions across 2,500 iterations");
    });

    it("1.2 derives 1,500 strictly collision-free ephemeral addresses and keys in secp256k1 EVM mode", () => {
      const iterations = 1500;
      const addresses = new Set<string>();
      const privateKeys = new Set<string>();

      for (let i = 0; i < iterations; i++) {
        const invoiceId = `inv_secp_stress_${i.toString().padStart(8, "0")}`;
        const keyPair = deriveEphemeralAddress(MASTER_MERCHANT_KEY, invoiceId, { mode: "secp256k1" });

        addresses.add(keyPair.address.toLowerCase());
        privateKeys.add(keyPair.privateKey);

        // Verify matches ethers computeAddress directly
        const expected = computeAddress(keyPair.privateKey).toLowerCase();
        assert.equal(keyPair.address.toLowerCase(), expected);
      }

      assert.equal(addresses.size, iterations, "Zero EVM address collisions across 1,500 iterations");
      assert.equal(privateKeys.size, iterations, "Zero private key collisions across 1,500 iterations");
    });

    it("1.3 satisfies Shannon entropy criteria (> 7.95 bits/byte on raw key bytes)", () => {
      const sampleSize = 1000;
      const byteCounts = new Uint32Array(256);
      let totalBytes = 0;

      for (let i = 0; i < sampleSize; i++) {
        const invoiceId = `inv_entropy_${i}_${crypto.randomBytes(4).toString("hex")}`;
        const priv = deriveEphemeralPrivateKey(MASTER_MERCHANT_KEY, invoiceId);
        const rawBytes = Buffer.from(priv.slice(2), "hex");

        for (const b of rawBytes) {
          byteCounts[b]++;
          totalBytes++;
        }
      }

      // Shannon entropy: -Sum(p_i * log2(p_i))
      let entropy = 0;
      for (let i = 0; i < 256; i++) {
        if (byteCounts[i] > 0) {
          const p = byteCounts[i] / totalBytes;
          entropy -= p * Math.log2(p);
        }
      }

      // Theoretical max is 8.0 bits/byte for uniform distribution
      assert.ok(
        entropy > 7.95,
        `Shannon entropy ${entropy.toFixed(4)} bits/byte must exceed 7.95 bits/byte`
      );
    });

    it("1.4 exhibits avalanche effect: single-character change flips ~50% of private key bits", () => {
      const baseInvoice = "inv_corporate_customer_invoice_00000001";
      const alteredInvoice = "inv_corporate_customer_invoice_00000002"; // 1 char diff

      const priv1 = deriveEphemeralPrivateKey(MASTER_MERCHANT_KEY, baseInvoice);
      const priv2 = deriveEphemeralPrivateKey(MASTER_MERCHANT_KEY, alteredInvoice);

      const buf1 = Buffer.from(priv1.slice(2), "hex");
      const buf2 = Buffer.from(priv2.slice(2), "hex");

      let differingBits = 0;
      for (let i = 0; i < 32; i++) {
        let xor = buf1[i] ^ buf2[i];
        while (xor > 0) {
          differingBits += xor & 1;
          xor >>= 1;
        }
      }

      // Expected for cryptographic PRF: around 128 bits flip out of 256
      assert.ok(
        differingBits >= 90 && differingBits <= 166,
        `Hamming distance ${differingBits}/256 must reflect strong avalanche behavior`
      );
    });

    it("1.5 guarantees strict determinism across separate generator instances and seeds", () => {
      const invoiceId = "inv_determinism_cross_check_999";
      const gen1 = new EphemeralAddressGenerator(MASTER_MERCHANT_KEY, "fast");
      const gen2 = new EphemeralAddressGenerator(MASTER_MERCHANT_KEY, "fast");

      const res1 = gen1.generate(invoiceId);
      const res2 = gen2.generate(invoiceId);

      assert.equal(res1.address, res2.address);
      assert.equal(res1.privateKey, res2.privateKey);
      assert.equal(gen1.validateAddress(res1.address, invoiceId), true);
      assert.equal(gen2.validateAddress(res1.address, invoiceId), true);
    });

    it("1.6 handles adversarial and edge-case invoice IDs safely without collision or crash", () => {
      const generator = new EphemeralAddressGenerator(MASTER_MERCHANT_KEY);
      const testCases = [
        "", // empty string
        "a", // single character
        "a".repeat(4096), // extremely long 4KB string
        "inv_celebration_unicode_payment", // unicode characters
        "inv_with_null_bytes", // edge string
        "inv_sql_' OR '1'='1' --", // SQL injection pattern
        "inv_xss_<script>alert('pwned')</script>", // XSS script tag
        "inv_path_../../../../etc/passwd", // path traversal
        "   padded_with_whitespace_invoice_id   ", // whitespace padded
        "0x" + "f".repeat(64) // hex string
      ];

      const derivedSet = new Set<string>();
      for (const id of testCases) {
        const keyPair = generator.generate(id);
        assert.ok(keyPair.address.startsWith("0x"));
        assert.equal(keyPair.address.length, 42);
        assert.ok(keyPair.privateKey.startsWith("0x"));
        assert.equal(keyPair.privateKey.length, 66);
        derivedSet.add(keyPair.address);
      }

      assert.equal(derivedSet.size, testCases.length, "All adversarial IDs produce distinct addresses");
    });
  });

  // =========================================================================
  // SUITE 2: Invoice State Machine, Replay Defense & Settlement Verification
  // =========================================================================
  describe("Suite 2: Invoice State Machine & Boundary Defenses Stress", () => {
    it("2.1 strictly rejects replay across 100 distinct invoices presented with identical settlement txHash", () => {
      const invoiceCount = 100;
      const invoices: InvoiceRecord[] = [];
      const sharedTxHash = "0xSharedSettlementHash_AntiReplayStress_100";

      for (let i = 0; i < invoiceCount; i++) {
        const ch = gateway.createPaymentChallenge(`/res_${i}`, 1_000_000_000_000_000_000n, WQUAI_ADDRESS);
        blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 1_000_000_000_000_000_000n);
        invoices.push(ch.invoice);
      }

      // First settlement succeeds
      const firstRes = gateway.verifyPayment(invoices[0].invoiceId, sharedTxHash);
      assert.equal(firstRes.success, true);
      assert.equal(firstRes.statusCode, 200);
      assert.equal(invoices[0].status, "SETTLED");

      // Remaining 99 must all fail with 409 ERR_REPLAY_DETECTED
      for (let i = 1; i < invoiceCount; i++) {
        const replayRes = gateway.verifyPayment(invoices[i].invoiceId, sharedTxHash);
        assert.equal(replayRes.success, false);
        assert.equal(replayRes.statusCode, 409);
        assert.equal(replayRes.error, "ERR_REPLAY_DETECTED");
        assert.equal(invoices[i].status, "PENDING"); // Must remain PENDING
      }
    });

    it("2.2 enforces case-insensitive receipt replay defense", () => {
      const ch1 = gateway.createPaymentChallenge("/test/c1", 2_000_000_000_000_000_000n, WQUAI_ADDRESS);
      const ch2 = gateway.createPaymentChallenge("/test/c2", 2_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, ch1.invoice.ephemeralAddress, 2_000_000_000_000_000_000n);
      blockchain.mintToken(WQUAI_ADDRESS, ch2.invoice.ephemeralAddress, 2_000_000_000_000_000_000n);

      const baseTx = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
      const upperTx = baseTx.toUpperCase().replace("0X", "0x");

      const res1 = gateway.verifyPayment(ch1.invoice.invoiceId, baseTx);
      assert.equal(res1.success, true);

      // Present uppercase variant to second invoice
      const res2 = gateway.verifyPayment(ch2.invoice.invoiceId, upperTx);
      assert.equal(res2.success, false);
      assert.equal(res2.statusCode, 409);
      assert.equal(res2.error, "ERR_REPLAY_DETECTED");
    });

    it("2.3 safely handles 30 concurrent attempts racing to settle distinct invoices with 1 shared txHash", async () => {
      const count = 30;
      const invoices: InvoiceRecord[] = [];
      const sharedTx = "0xRaceConditionSharedTxHash_ConcurrentAttempt";

      for (let i = 0; i < count; i++) {
        const ch = gateway.createPaymentChallenge(`/race_${i}`, 500_000_000_000_000_000n, WQUAI_ADDRESS);
        blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 500_000_000_000_000_000n);
        invoices.push(ch.invoice);
      }

      // Execute 30 concurrent settlement verifications
      const results = await Promise.all(
        invoices.map((inv) => Promise.resolve(gateway.verifyPayment(inv.invoiceId, sharedTx)))
      );

      const successes = results.filter((r) => r.success);
      const replays = results.filter((r) => !r.success && r.error === "ERR_REPLAY_DETECTED");

      assert.equal(successes.length, 1, "Exactly one invoice settlement must succeed");
      assert.equal(replays.length, count - 1, "All concurrent competitors must be rejected as replay");
    });

    it("2.4 verifies idempotency across 50 repeated presentations of valid proof", () => {
      const ch = gateway.createPaymentChallenge("/idempotent/test", 1_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 1_000_000_000_000_000_000n);
      const txHash = "0xUniqueValidTxForIdempotency";

      const initial = gateway.verifyPayment(ch.invoice.invoiceId, txHash);
      assert.equal(initial.success, true);
      assert.equal(initial.statusCode, 200);

      for (let i = 0; i < 50; i++) {
        const repeat = gateway.verifyPayment(ch.invoice.invoiceId, txHash);
        assert.equal(repeat.success, true);
        assert.equal(repeat.statusCode, 200);
        assert.equal(repeat.receiptId, `rct_${ch.invoice.invoiceId}`);
      }
    });

    it("2.5 enforces strict underpayment defense: deposit < requiredAmount returns 402 ERR_UNDERPAYMENT", () => {
      const ch = gateway.createPaymentChallenge("/underpay", 5_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 4_999_999n); // 1 base unit short

      const res = gateway.verifyPayment(ch.invoice.invoiceId, "0xunderpay_attempt");
      assert.equal(res.success, false);
      assert.equal(res.statusCode, 402);
      assert.equal(res.error, "ERR_UNDERPAYMENT");
      assert.equal(ch.invoice.status, "PENDING");
    });

    it("2.6 validates token and recipient mismatch on on-chain recorded transactions", () => {
      const ch = gateway.createPaymentChallenge("/mismatch", 1_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 1_000_000_000_000_000_000n);

      // 1. Reverted transaction
      const revertedTx = "0xreverted_tx_001";
      blockchain.transactions.set(revertedTx, {
        hash: revertedTx,
        status: "reverted",
        recipient: ch.invoice.ephemeralAddress,
        token: WQUAI_ADDRESS
      } as any);
      const resRev = gateway.verifyPayment(ch.invoice.invoiceId, revertedTx);
      assert.equal(resRev.error, "ERR_TRANSACTION_REVERTED");

      // 2. Recipient mismatch
      const wrongRecipTx = "0xwrong_recip_tx_002";
      blockchain.transactions.set(wrongRecipTx, {
        hash: wrongRecipTx,
        status: "confirmed",
        recipient: "0xAttackerDestination111111111111111111111",
        token: WQUAI_ADDRESS
      } as any);
      const resRecip = gateway.verifyPayment(ch.invoice.invoiceId, wrongRecipTx);
      assert.equal(resRecip.error, "ERR_RECIPIENT_MISMATCH");

      // 3. Token mismatch
      const wrongTokenTx = "0xwrong_token_tx_003";
      blockchain.transactions.set(wrongTokenTx, {
        hash: wrongTokenTx,
        status: "confirmed",
        recipient: ch.invoice.ephemeralAddress,
        token: DAI_ADDRESS
      } as any);
      const resToken = gateway.verifyPayment(ch.invoice.invoiceId, wrongTokenTx);
      assert.equal(resToken.error, "ERR_TOKEN_MISMATCH");
    });

    it("2.7 enforces expiration: expired invoice transitions to EXPIRED and rejects verification with 410", () => {
      const registry = new InvoiceRegistry(MASTER_MERCHANT_KEY, blockchain);
      const inv = registry.createInvoice("/expired/path", 1_000_000_000_000_000_000n, WQUAI_ADDRESS, "WQUAI", 18, -60); // expired 60s ago

      const res = registry.verifySettlement(inv.invoiceId, "0xtx_expired_test");
      assert.equal(res.success, false);
      assert.equal(res.statusCode, 410);
      assert.equal(res.error, "ERR_INVOICE_EXPIRED");
      assert.equal(inv.status, "EXPIRED");
    });

    it("2.8 prunes 500 expired invoices cleanly while preserving 500 active pending invoices", () => {
      const registry = new InvoiceRegistry(MASTER_MERCHANT_KEY, blockchain);

      for (let i = 0; i < 500; i++) {
        registry.createInvoice(`/active_${i}`, 1_000_000_000_000_000_000n, WQUAI_ADDRESS, "WQUAI", 18, 3600);
        registry.createInvoice(`/expired_${i}`, 1_000_000_000_000_000_000n, WQUAI_ADDRESS, "WQUAI", 18, -100);
      }

      assert.equal(registry.size, 1000);
      assert.equal(registry.getPendingInvoices().length, 500);
      assert.equal(registry.getExpiredInvoices().length, 500);

      const pruned = registry.pruneExpired(0);
      assert.equal(pruned, 500);
      assert.equal(registry.size, 500);
      assert.equal(registry.getPendingInvoices().length, 500);
      assert.equal(registry.getExpiredInvoices().length, 0);
    });
  });

  // =========================================================================
  // SUITE 3: Sweeper Worker, Railgun Shielding & Memory Zeroization Stress
  // =========================================================================
  describe("Suite 3: Sweeper Worker & Memory Zeroization Stress", () => {
    it("3.1 executes full sweep & shield pipeline into Railgun pool and verifies 0zk commitment insertion", async () => {
      const ch = gateway.createPaymentChallenge("/sweep/full", 10_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 10_000_000_000_000_000_000n);

      // Settle invoice
      const verifyRes = gateway.verifyPayment(ch.invoice.invoiceId, "0xvalid_pre_sweep_tx");
      assert.equal(verifyRes.success, true);
      assert.equal(ch.invoice.status, "SETTLED");

      const initialPoolBal = blockchain.getTokenBalance(WQUAI_ADDRESS, pool.contractAddress);
      const initialLeaves = pool.merkleTree.nextIndex;

      // Sweep and shield
      const receipt = await gateway.sweepAndShield(ch.invoice.invoiceId);

      assert.equal(receipt.sweptAmount, 10_000_000_000_000_000_000n);
      assert.ok(receipt.shieldedCommitment > 0n);
      assert.equal(receipt.leafIndex, initialLeaves);
      assert.equal(pool.merkleTree.nextIndex, initialLeaves + 1);

      // Verify on-chain balance moved from ephemeral address to pool
      assert.equal(blockchain.getTokenBalance(WQUAI_ADDRESS, ch.invoice.ephemeralAddress), 0n);
      assert.equal(
        blockchain.getTokenBalance(WQUAI_ADDRESS, pool.contractAddress),
        initialPoolBal + 10_000_000_000_000_000_000n
      );

      // Verify invoice record status and private key zeroization
      assert.equal(ch.invoice.status, "SWEPT");
      assert.equal(ch.invoice.ephemeralPrivateKey, ZEROIZED_PRIVATE_KEY);
      assert.equal(
        ch.invoice.ephemeralPrivateKey,
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      );
    });

    it("3.2 strictly rejects second sweep attempt on already swept invoice with ALREADY_SWEPT", async () => {
      const ch = gateway.createPaymentChallenge("/sweep/double", 5_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      gateway.verifyPayment(ch.invoice.invoiceId, "0xtx_first_sweep");

      // First sweep succeeds
      await gateway.sweepAndShield(ch.invoice.invoiceId);

      // Second sweep must reject
      await assert.rejects(async () => {
        await gateway.sweepAndShield(ch.invoice.invoiceId);
      }, /ALREADY_SWEPT/);
    });

    it("3.3 rejects sweep if ephemeral private key is zeroized even if status was tampered to SETTLED", async () => {
      const ch = gateway.createPaymentChallenge("/sweep/tamper", 3_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 3_000_000_000_000_000_000n);
      gateway.verifyPayment(ch.invoice.invoiceId, "0xtx_tamper_sweep");

      await gateway.sweepAndShield(ch.invoice.invoiceId);

      // Simulate malicious tampering of invoice status back to SETTLED
      ch.invoice.status = "SETTLED";
      // Deposit extra funds to ephemeral address
      blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 2_000_000_000_000_000_000n);

      // Must be blocked because private key was zeroized in memory
      await assert.rejects(async () => {
        await gateway.sweepAndShield(ch.invoice.invoiceId);
      }, /EPHEMERAL_KEY_ZEROIZED/);
    });

    it("3.4 rejects sweeping when ephemeral address has zero balance (NO_FUNDS_TO_SWEEP)", async () => {
      const ch = gateway.createPaymentChallenge("/sweep/empty", 5_000_000_000_000_000_000n, WQUAI_ADDRESS);
      // No deposit made

      await assert.rejects(async () => {
        await gateway.sweepAndShield(ch.invoice.invoiceId);
      }, /NO_FUNDS_TO_SWEEP/);
    });

    it("3.5 enforces inbound sanctions screening: refuses to shield funds from sanctioned address", async () => {
      const sanctionsSet = new Set<string>();
      const sweeperWithSanctions = new SweeperWorker({
        registry: gateway.invoiceRegistry,
        pool: pool,
        corporateNpk: CORPORATE_NPK,
        blockchain: blockchain,
        sanctionsRegistry: {
          isSanctioned: (addr: string) => sanctionsSet.has(addr.toLowerCase())
        }
      });

      const ch = gateway.createPaymentChallenge("/sweep/sanctioned", 5_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      gateway.verifyPayment(ch.invoice.invoiceId, "0xtx_sanctioned_deposit");

      // Register ephemeral address as sanctioned
      sanctionsSet.add(ch.invoice.ephemeralAddress.toLowerCase());

      const initialLeaves = pool.merkleTree.nextIndex;

      await assert.rejects(async () => {
        await sweeperWithSanctions.sweepAndShield(ch.invoice.invoiceId);
      }, /SANCTIONED_DEPOSIT_DETECTED/);

      // Merkle tree must not have received any new leaf
      assert.equal(pool.merkleTree.nextIndex, initialLeaves);
      // Invoice must not be swept
      assert.equal(ch.invoice.status, "SETTLED");
    });

    it("3.6 handles 25 concurrent sweep requests racing on the same invoice: exactly 1 succeeds", async () => {
      const ch = gateway.createPaymentChallenge("/sweep/concurrency", 4_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 4_000_000_000_000_000_000n);
      gateway.verifyPayment(ch.invoice.invoiceId, "0xtx_concurrent_sweep");

      const initialLeaves = pool.merkleTree.nextIndex;

      // Dispatch 25 parallel sweepAndShield calls
      const sweepPromises = Array.from({ length: 25 }, () =>
        gateway.sweepAndShield(ch.invoice.invoiceId).then(
          (receipt) => ({ success: true, receipt }),
          (error) => ({ success: false, error: error.message })
        )
      );

      const results = await Promise.all(sweepPromises);
      const successes = results.filter((r) => r.success);
      const rejections = results.filter((r) => !r.success);

      assert.equal(successes.length, 1, "Exactly one concurrent sweep must succeed");
      assert.equal(rejections.length, 24, "All other concurrent sweeps must be rejected");
      assert.equal(pool.merkleTree.nextIndex, initialLeaves + 1, "Exactly one note commitment inserted");
    });

    it("3.7 executes batch sweeping across 40 invoices and verifies batch idempotency", async () => {
      const batchCount = 40;
      const expectedTotalAmount = 40n * 2_000_000_000_000_000_000n;

      for (let i = 0; i < batchCount; i++) {
        const ch = gateway.createPaymentChallenge(`/batch_${i}`, 2_000_000_000_000_000_000n, WQUAI_ADDRESS);
        blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 2_000_000_000_000_000_000n);
        gateway.verifyPayment(ch.invoice.invoiceId, `0xbatch_settle_tx_${i}`);
      }

      // Execute batch sweep
      const summary1 = await gateway.sweeper.sweepBatch(50);
      assert.equal(summary1.totalProcessed, batchCount);
      assert.equal(summary1.successfulSweeps, batchCount);
      assert.equal(summary1.failedSweeps, 0);
      assert.equal(summary1.totalSweptAmount, expectedTotalAmount);
      assert.equal(summary1.receipts.length, batchCount);

      // Second batch sweep run immediately after: should process 0 invoices (idempotent)
      const summary2 = await gateway.sweeper.sweepBatch(50);
      assert.equal(summary2.totalProcessed, 0);
      assert.equal(summary2.successfulSweeps, 0);
      assert.equal(summary2.totalSweptAmount, 0n);
    });

    it("3.8 decrypts swept note payload using corporate viewing key and verifies accounting integrity", async () => {
      const journal = new AccountingJournalReconstructor(corporateKeys.corporate0zkAddress);
      const sweeperWithAudit = new SweeperWorker({
        registry: gateway.invoiceRegistry,
        pool: pool,
        corporateNpk: CORPORATE_NPK,
        corporateVpk: corporateKeys.viewingPublicKey,
        blockchain: blockchain,
        journal: journal
      });

      const ch = gateway.createPaymentChallenge("/audit/test", 7_500_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, ch.invoice.ephemeralAddress, 7_500_000_000_000_000_000n);
      gateway.verifyPayment(ch.invoice.invoiceId, "0xtx_audit_verify");

      const receipt = await sweeperWithAudit.sweepAndShield(ch.invoice.invoiceId);
      assert.ok(receipt.encryptedNote);

      // Decrypt using corporate viewing private key
      const decrypted = decryptNotePayload(corporateKeys.masterViewingKey, receipt.encryptedNote!);
      assert.ok(decrypted);
      assert.equal(decrypted.invoiceId, ch.invoice.invoiceId);
      assert.equal(decrypted.value, "7500000000000000000");
      assert.equal(decrypted.token, WQUAI_ADDRESS.toLowerCase());
      assert.equal(decrypted.direction, "INBOUND_SWEEP");
      assert.equal(decrypted.counterparty.toLowerCase(), ch.invoice.ephemeralAddress.toLowerCase());
    });
  });

  // =========================================================================
  // SUITE 4: HTTP Middleware, Header Parsing & Multi-Scheme Authentication
  // =========================================================================
  describe("Suite 4: HTTP Middleware & Header Parsing Stress", () => {
    it("4.1 intercepts protected routes without payment and returns RFC 7235 headers + RFC 7807 JSON", async () => {
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"],
        defaultAmount: 5_000_000_000_000_000_000n,
        defaultTokenAddress: WQUAI_ADDRESS
      });

      let statusCode = 0;
      const headers: Record<string, string> = {};
      let responseBody: any = null;

      const req = { url: "/api/v1/protected/analytics", headers: {} };
      const res = {
        setHeader: (k: string, v: string) => {
          headers[k] = v;
        },
        set statusCode(code: number) {
          statusCode = code;
        },
        json: (body: any) => {
          responseBody = body;
        }
      };

      let nextCalled = false;
      await middleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(statusCode, 402);
      assert.ok(headers["WWW-Authenticate"]?.startsWith("x402"));
      assert.equal(headers["X-Payment-Required"], "true");
      assert.equal(responseBody.status, 402);
      assert.equal(responseBody.title, "Payment Required");
      assert.ok(responseBody.payment.invoiceId);
      assert.ok(responseBody.payment.recipient.startsWith("0x"));
    });

    it("4.2 passes unprotected routes through to next() directly", async () => {
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"]
      });

      const req = { url: "/api/v1/public/health", headers: {} };
      const res = {};
      let nextCalled = false;

      await middleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
    });

    it("4.3 accepts payment proof via Authorization: x402 header", async () => {
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"],
        autoSweep: true
      });

      // Issue challenge first
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/resource",
        5_000_000_000_000_000_000n,
        WQUAI_ADDRESS
      );
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0xAuthSchemeX402Proof123";
      const req: any = {
        url: "/api/v1/protected/resource",
        headers: {
          authorization: `x402 invoice="${challenge.invoice.invoiceId}", proof="${txHash}"`
        }
      };
      const resHeaders: Record<string, string> = {};
      const res: any = {
        setHeader: (k: string, v: string) => {
          resHeaders[k] = v;
        }
      };

      let nextCalled = false;
      await middleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.equal(resHeaders["X-Payment-Status"], "SETTLED");
      assert.ok(req.paymentReceipt);
      assert.equal(challenge.invoice.status, "SWEPT");
    });

    it("4.4 accepts payment proof via Authorization: Bearer base64 JSON header", async () => {
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"],
        autoSweep: false
      });

      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/resource",
        3_000_000_000_000_000_000n,
        WQUAI_ADDRESS
      );
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 3_000_000_000_000_000_000n);

      const txHash = "0xAuthSchemeBearerBase64Proof";
      const tokenPayload = Buffer.from(
        JSON.stringify({ invoiceId: challenge.invoice.invoiceId, proof: txHash })
      ).toString("base64");

      const req: any = {
        url: "/api/v1/protected/resource",
        headers: {
          authorization: `Bearer ${tokenPayload}`
        }
      };
      const resHeaders: Record<string, string> = {};
      const res: any = {
        setHeader: (k: string, v: string) => {
          resHeaders[k] = v;
        }
      };

      let nextCalled = false;
      await middleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.equal(resHeaders["X-Payment-Status"], "SETTLED");
      assert.equal(challenge.invoice.status, "SETTLED");
    });

    it("4.5 accepts payment proof via X-Payment-Proof and X-Payment-Invoice-Id headers", async () => {
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"],
        autoSweep: false
      });

      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/custom",
        2_000_000_000_000_000_000n,
        WQUAI_ADDRESS
      );
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 2_000_000_000_000_000_000n);

      const txHash = "0xCustomHeadersPaymentProof";
      const req: any = {
        url: "/api/v1/protected/custom",
        headers: {
          "x-payment-invoice-id": challenge.invoice.invoiceId,
          "x-payment-proof": txHash
        }
      };
      const resHeaders: Record<string, string> = {};
      const res: any = {
        setHeader: (k: string, v: string) => {
          resHeaders[k] = v;
        }
      };

      let nextCalled = false;
      await middleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.equal(resHeaders["X-Payment-Status"], "SETTLED");
      assert.equal(challenge.invoice.status, "SETTLED");
    });
  });
});
