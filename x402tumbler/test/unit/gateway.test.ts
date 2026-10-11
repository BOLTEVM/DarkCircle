/**
 * DarkCircle Protocol: Milestone 4 Unit Test Suite
 * Inbound Merchant Privacy Gateway
 *
 * Tests:
 * 1. Ephemeral & Stealth Address Derivation (determinism, collision freedom, zeroization)
 * 2. Payment Challenge Generation (RFC 7235 WWW-Authenticate, X-Payment-* headers, RFC 7807)
 * 3. Invoice Registry & Settlement Verification (state transitions, 404, 410, 402, 409 replay defense)
 * 4. Automated Balance Sweeper & Railgun Shielding (token transfer, 0zk note commitment, key zeroization, batch sweeping)
 * 5. Credential Extraction & HTTP Middleware Integration
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
import { AccountingJournalReconstructor } from "../../src/audit/accounting.ts";
import { deriveCorporateKeyHierarchy } from "../../src/audit/keys.ts";
import { decryptNotePayload } from "../../src/audit/decryptor.ts";
import { BN254_SCALAR_FIELD, Fp } from "../../src/crypto/field.ts";
import { poseidon4 } from "../../src/crypto/poseidon.ts";

describe("Milestone 4 Unit Tests: Inbound Merchant Privacy Gateway", () => {
  const MASTER_MERCHANT_KEY = "darkcircle_master_merchant_key_enterprise_secure_seed";
  const CORPORATE_0ZK = "0zk1qcorporate0zktreasuryprivacygatewayaddress123456789";
  const CORPORATE_NPK = 99999999999999999999n;
  const WQUAI_ADDRESS = "0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb";

  let blockchain: SimulatedBlockchain;
  let pool: RailgunPool;
  let gateway: InboundMerchantGateway;

  beforeEach(() => {
    blockchain = new SimulatedBlockchain();
    pool = new RailgunPool(blockchain, { mode: "trusted-harness" });
    gateway = new InboundMerchantGateway(
      MASTER_MERCHANT_KEY,
      CORPORATE_0ZK,
      CORPORATE_NPK,
      blockchain,
      pool,
      { trustMode: "trusted-harness" }
    );
  });

  // =========================================================================
  // 1. Ephemeral & Stealth Address Derivation
  // =========================================================================
  describe("1. Ephemeral & Stealth Address Derivation", () => {
    it("derives deterministic ephemeral private key and address using HMAC-SHA256", () => {
      const invoiceId = "inv_test_deterministic_001";
      const keyPair1 = deriveEphemeralAddress(MASTER_MERCHANT_KEY, invoiceId);
      const keyPair2 = deriveEphemeralAddress(MASTER_MERCHANT_KEY, invoiceId);

      assert.equal(keyPair1.address, keyPair2.address);
      assert.equal(keyPair1.privateKey, keyPair2.privateKey);
      assert.ok(keyPair1.address.startsWith("0x"));
      assert.equal(keyPair1.address.length, 42); // 0x + 40 hex chars
      assert.ok(keyPair1.privateKey.startsWith("0x"));
      assert.equal(keyPair1.privateKey.length, 66); // 0x + 64 hex chars
    });

    it("enforces domain separation prefix in derivation", () => {
      const invoiceId = "inv_domain_sep_test";
      const defaultDerived = deriveEphemeralPrivateKey(MASTER_MERCHANT_KEY, invoiceId);
      const customDerived = deriveEphemeralPrivateKey(
        MASTER_MERCHANT_KEY,
        invoiceId,
        "CustomDomain-v2-invoice:"
      );

      assert.notEqual(defaultDerived, customDerived);
    });

    it("generates 1,000 distinct, collision-free ephemeral addresses across unique invoices", () => {
      const addressSet = new Set<string>();
      const keySet = new Set<string>();
      const count = 1000;

      for (let i = 0; i < count; i++) {
        const invoiceId = `inv_batch_bench_${i.toString().padStart(6, "0")}`;
        const { address, privateKey } = deriveEphemeralAddress(MASTER_MERCHANT_KEY, invoiceId);
        addressSet.add(address);
        keySet.add(privateKey);
      }

      assert.equal(addressSet.size, count, "All 1,000 ephemeral addresses must be unique");
      assert.equal(keySet.size, count, "All 1,000 ephemeral private keys must be unique");
    });

    it("supports fast mode SHA-256 slice derivation matching expected format", () => {
      const privKey = "0x" + crypto.randomBytes(32).toString("hex");
      const fastAddr = deriveAddressFromPrivateKey(privKey, "fast");
      const expectedAddr = "0x" + crypto.createHash("sha256").update(privKey).digest("hex").slice(24);

      assert.equal(fastAddr, expectedAddr);
      assert.equal(fastAddr.length, 42);
    });

    it("supports secp256k1 mode derivation matching standard EVM computeAddress", () => {
      const privKey = "0x" + crypto.randomBytes(32).toString("hex");
      const secpAddr = deriveAddressFromPrivateKey(privKey, "secp256k1");
      const expectedAddr = computeAddress(privKey);

      assert.equal(secpAddr.toLowerCase(), expectedAddr.toLowerCase());
    });

    it("validates address authenticity against invoice ID using EphemeralAddressGenerator", () => {
      const generator = new EphemeralAddressGenerator(MASTER_MERCHANT_KEY);
      const invoiceId = "inv_validate_test_777";
      const keyPair = generator.generate(invoiceId);

      assert.equal(generator.validateAddress(keyPair.address, invoiceId), true);
      assert.equal(generator.validateAddress("0x0011111111111111111111111111111111111111", invoiceId), false);
      assert.equal(generator.validateAddress(keyPair.address, "inv_different_id"), false);
    });

    it("securely zeroizes ephemeral private key to 64 zeroes in memory", () => {
      const invoice: Partial<InvoiceRecord> = {
        invoiceId: "inv_zeroize_test",
        ephemeralPrivateKey: "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
      };

      zeroizeEphemeralKey(invoice as any);
      assert.equal(invoice.ephemeralPrivateKey, ZEROIZED_PRIVATE_KEY);
      assert.equal(invoice.ephemeralPrivateKey, "0x0000000000000000000000000000000000000000000000000000000000000000");
    });
  });

  // =========================================================================
  // 2. Payment Challenge Generation
  // =========================================================================
  describe("2. Payment Challenge Generation", () => {
    it("creates invoice with status PENDING and correct expiration timestamp", () => {
      const resourceUri = "/api/v1/protected/analytics";
      const amount = 5_000_000_000_000_000_000n; // 5 WQUAI
      const ttl = 600;

      const before = Math.floor(Date.now() / 1000);
      const challenge = gateway.createPaymentChallenge(
        resourceUri,
        amount,
        WQUAI_ADDRESS,
        "WQUAI",
        18,
        ttl
      );
      const after = Math.floor(Date.now() / 1000);

      const invoice = challenge.invoice;
      assert.ok(invoice.invoiceId.startsWith("inv_"));
      assert.equal(invoice.resourceUri, resourceUri);
      assert.equal(invoice.tokenAddress, WQUAI_ADDRESS.toLowerCase());
      assert.equal(invoice.tokenSymbol, "WQUAI");
      assert.equal(invoice.tokenDecimals, 18);
      assert.equal(invoice.requiredAmount, amount);
      assert.equal(invoice.status, "PENDING");
      assert.ok(invoice.createdAt >= before && invoice.createdAt <= after);
      assert.equal(invoice.expiresAt, invoice.createdAt + ttl);
    });

    it("formats RFC 7235 WWW-Authenticate header containing x402 parameters", () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/ai-inference",
        10_000_000_000_000_000_000n,
        WQUAI_ADDRESS
      );

      const wwwAuth = challenge.challengeHeaders["WWW-Authenticate"];
      assert.ok(wwwAuth, "WWW-Authenticate header must be present");
      assert.ok(wwwAuth.startsWith("x402 scheme=\"erc20_transfer\""));
      assert.ok(wwwAuth.includes(`network="quai-cyprus1"`));
      assert.ok(wwwAuth.includes(`chainId="9"`));
      assert.ok(wwwAuth.includes(`token="${WQUAI_ADDRESS}"`));
      assert.ok(wwwAuth.includes(`recipient="${challenge.invoice.ephemeralAddress}"`));
      assert.ok(wwwAuth.includes(`amount="10000000000000000000"`));
      assert.ok(wwwAuth.includes(`invoiceId="${challenge.invoice.invoiceId}"`));
      assert.ok(wwwAuth.includes(`proofType="tx_receipt"`));
    });

    it("formats complete set of X-Payment-* headers", () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/premium",
        25_000_000_000_000_000_000n,
        WQUAI_ADDRESS
      );

      const headers = challenge.challengeHeaders;
      assert.equal(headers["X-Payment-Required"], "true");
      assert.equal(headers["X-Payment-Scheme"], "x402-v1");
      assert.equal(headers["X-Payment-Network"], "quai-cyprus1");
      assert.equal(headers["X-Payment-Token"], WQUAI_ADDRESS);
      assert.equal(headers["X-Payment-Token-Symbol"], "WQUAI");
      assert.equal(headers["X-Payment-Token-Decimals"], "18");
      assert.equal(headers["X-Payment-Recipient"], challenge.invoice.ephemeralAddress);
      assert.equal(headers["X-Payment-Amount"], "25000000000000000000");
      assert.equal(headers["X-Payment-Invoice-Id"], challenge.invoice.invoiceId);
      assert.equal(headers["X-Payment-Expires-At"], challenge.invoice.expiresAt.toString());
      assert.equal(headers["X-Payment-Resource"], "/api/v1/protected/premium");
    });

    it("formats RFC 7807 compliant problem details JSON body with status 402", () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI_ADDRESS
      );

      const body = challenge.challengeBody;
      assert.equal(body.type, "https://darkcircle.network/errors/payment-required");
      assert.equal(body.title, "Payment Required");
      assert.equal(body.status, 402);
      assert.equal(body.instance, "/api/v1/protected/analytics");
      assert.equal(body.payment.protocol, "x402");
      assert.equal(body.payment.version, "1.0.0");
      assert.equal(body.payment.invoiceId, challenge.invoice.invoiceId);
      assert.equal(body.payment.recipient, challenge.invoice.ephemeralAddress);
      assert.equal(body.payment.amount, "5000000000000000000");
      assert.equal(body.payment.ephemeral, true);
    });
  });

  // =========================================================================
  // 3. Invoice Registry & Settlement Verification
  // =========================================================================
  describe("3. Invoice Registry & Settlement Verification", () => {
    it("returns 404 ERR_INVOICE_NOT_FOUND when invoice does not exist", () => {
      const result = gateway.verifyPayment("inv_nonexistent_9999", "0xdeadbeef");
      assert.equal(result.success, false);
      assert.equal(result.statusCode, 404);
      assert.equal(result.error, "ERR_INVOICE_NOT_FOUND");
    });

    it("returns 410 ERR_INVOICE_EXPIRED when invoice has expired", () => {
      const registry = new InvoiceRegistry(MASTER_MERCHANT_KEY, blockchain);
      const invoice = registry.createInvoice(
        "/api/v1/test",
        5_000_000_000_000_000_000n,
        WQUAI_ADDRESS,
        "WQUAI",
        18,
        -10 // negative TTL -> expired in past
      );

      const result = registry.verifySettlement(invoice.invoiceId, "0x123456");
      assert.equal(result.success, false);
      assert.equal(result.statusCode, 410);
      assert.equal(result.error, "ERR_INVOICE_EXPIRED");
      assert.equal(invoice.status, "EXPIRED");
    });

    it("returns 402 ERR_UNDERPAYMENT when on-chain token balance is less than required amount", () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/test",
        10_000_000_000_000_000_000n, // 10 WQUAI required
        WQUAI_ADDRESS
      );

      // Deposit only 5 WQUAI
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const result = gateway.verifyPayment(challenge.invoice.invoiceId, "0xtx_underpaid_1");
      assert.equal(result.success, false);
      assert.equal(result.statusCode, 402);
      assert.equal(result.error, "ERR_UNDERPAYMENT");
    });

    it("returns 402 ERR_TRANSACTION_REVERTED when on-chain transaction failed", () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/test",
        5_000_000_000_000_000_000n,
        WQUAI_ADDRESS
      );
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0xtx_reverted_hash_12345";
      blockchain.transactions.set(txHash.toLowerCase(), {
        hash: txHash.toLowerCase(),
        status: "reverted",
        recipient: challenge.invoice.ephemeralAddress,
        token: WQUAI_ADDRESS
      } as any);

      const result = gateway.verifyPayment(challenge.invoice.invoiceId, txHash);
      assert.equal(result.success, false);
      assert.equal(result.statusCode, 402);
      assert.equal(result.error, "ERR_TRANSACTION_REVERTED");
    });

    it("returns 402 ERR_RECIPIENT_MISMATCH when on-chain transaction destination is different", () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/test",
        5_000_000_000_000_000_000n,
        WQUAI_ADDRESS
      );
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0xtx_wrong_recipient_555";
      blockchain.transactions.set(txHash.toLowerCase(), {
        hash: txHash.toLowerCase(),
        status: "confirmed",
        recipient: "0xWrongRecipientAddress111111111111111111111",
        token: WQUAI_ADDRESS
      } as any);

      const result = gateway.verifyPayment(challenge.invoice.invoiceId, txHash);
      assert.equal(result.success, false);
      assert.equal(result.statusCode, 402);
      assert.equal(result.error, "ERR_RECIPIENT_MISMATCH");
    });

    it("returns 402 ERR_TOKEN_MISMATCH when on-chain transaction token is different", () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/test",
        5_000_000_000_000_000_000n,
        WQUAI_ADDRESS
      );
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0xtx_wrong_token_777";
      blockchain.transactions.set(txHash.toLowerCase(), {
        hash: txHash.toLowerCase(),
        status: "confirmed",
        recipient: challenge.invoice.ephemeralAddress,
        token: "0xdac17f958d2ee523a2206206994597c13d831ec7" // USDT instead of WQUAI
      } as any);

      const result = gateway.verifyPayment(challenge.invoice.invoiceId, txHash);
      assert.equal(result.success, false);
      assert.equal(result.statusCode, 402);
      assert.equal(result.error, "ERR_TOKEN_MISMATCH");
    });

    it("transitions status to SETTLED and returns 200 with receipt on valid payment", () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/test",
        5_000_000_000_000_000_000n,
        WQUAI_ADDRESS
      );
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0xValidSettlementTxHash999";
      const result = gateway.verifyPayment(challenge.invoice.invoiceId, txHash);

      assert.equal(result.success, true);
      assert.equal(result.statusCode, 200);
      assert.ok(result.receiptId?.startsWith("rct_"));
      assert.equal(challenge.invoice.status, "SETTLED");
      assert.equal(challenge.invoice.settlementTxHash, txHash.toLowerCase());
      assert.ok(challenge.invoice.settledAt);
      assert.ok(gateway.usedReceiptRegistry.has(txHash.toLowerCase()));
    });

    it("is idempotent when re-submitting valid proof for the same settled invoice", () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/test",
        5_000_000_000_000_000_000n,
        WQUAI_ADDRESS
      );
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0xRepeatProofTxHash123";
      const result1 = gateway.verifyPayment(challenge.invoice.invoiceId, txHash);
      assert.equal(result1.success, true);

      // Repeat submission with same txHash
      const result2 = gateway.verifyPayment(challenge.invoice.invoiceId, txHash);
      assert.equal(result2.success, true);
      assert.equal(result2.statusCode, 200);
      assert.equal(result2.receiptId, `rct_${challenge.invoice.invoiceId}`);
    });

    it("returns 409 ERR_REPLAY_DETECTED when reusing a settlement txHash across different invoices", () => {
      const challenge1 = gateway.createPaymentChallenge("/api/v1/test1", 5_000_000_000_000_000_000n, WQUAI_ADDRESS);
      const challenge2 = gateway.createPaymentChallenge("/api/v1/test2", 5_000_000_000_000_000_000n, WQUAI_ADDRESS);

      blockchain.mintToken(WQUAI_ADDRESS, challenge1.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      blockchain.mintToken(WQUAI_ADDRESS, challenge2.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const sharedTxHash = "0xSharedTxHashReplayAttackTarget";

      // Settle invoice 1
      const res1 = gateway.verifyPayment(challenge1.invoice.invoiceId, sharedTxHash);
      assert.equal(res1.success, true);

      // Attempt to settle invoice 2 using the same txHash
      const res2 = gateway.verifyPayment(challenge2.invoice.invoiceId, sharedTxHash);
      assert.equal(res2.success, false);
      assert.equal(res2.statusCode, 409);
      assert.equal(res2.error, "ERR_REPLAY_DETECTED");
    });

    it("correctly filters invoices by status and prunes expired records", () => {
      const registry = new InvoiceRegistry(MASTER_MERCHANT_KEY, blockchain);
      const invPending = registry.createInvoice("/res1", 1_000_000_000_000_000_000n, WQUAI_ADDRESS, "WQUAI", 18, 900);
      const invExpired = registry.createInvoice("/res2", 1_000_000_000_000_000_000n, WQUAI_ADDRESS, "WQUAI", 18, -100);

      assert.equal(registry.getPendingInvoices().length, 1);
      assert.equal(registry.getPendingInvoices()[0].invoiceId, invPending.invoiceId);
      assert.equal(registry.getExpiredInvoices().length, 1);
      assert.equal(registry.getExpiredInvoices()[0].invoiceId, invExpired.invoiceId);

      const pruned = registry.pruneExpired(0);
      assert.equal(pruned, 1);
      assert.equal(registry.has(invExpired.invoiceId), false);
      assert.equal(registry.has(invPending.invoiceId), true);
    });
  });

  // =========================================================================
  // 4. Automated Balance Sweeper & Railgun Shielding Pipeline
  // =========================================================================
  describe("4. Automated Balance Sweeper & Railgun Shielding Pipeline", () => {
    it("transfers token balance from ephemeral address to Railgun contract and shields into corporate pool", async () => {
      const challenge = gateway.createPaymentChallenge("/api/v1/test", 5_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      // Verify and settle invoice
      gateway.verifyPayment(challenge.invoice.invoiceId, "0xSettledTxHashForSweep");
      assert.equal(challenge.invoice.status, "SETTLED");

      const poolInitialBalance = blockchain.getTokenBalance(WQUAI_ADDRESS, pool.contractAddress);
      const initialLeaves = pool.merkleTree.nextIndex;

      // Execute sweep
      const sweepReceipt = await gateway.sweepAndShield(challenge.invoice.invoiceId);

      assert.ok(sweepReceipt.sweepTxHash.startsWith("0x"));
      assert.equal(sweepReceipt.sweptAmount, 5_000_000_000_000_000_000n);
      assert.ok(sweepReceipt.shieldedCommitment > 0n);

      // Verify on-chain balance moved from ephemeral address to pool
      assert.equal(blockchain.getTokenBalance(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress), 0n);
      assert.equal(
        blockchain.getTokenBalance(WQUAI_ADDRESS, pool.contractAddress),
        poolInitialBalance + 5_000_000_000_000_000_000n
      );

      // Verify Merkle tree leaf inserted
      assert.equal(pool.merkleTree.nextIndex, initialLeaves + 1);

      // Verify invoice state updated to SWEPT
      assert.equal(challenge.invoice.status, "SWEPT");
      assert.equal(challenge.invoice.sweepTxHash, sweepReceipt.sweepTxHash);
      assert.ok(challenge.invoice.sweptAt);

      // Verify ephemeral private key zeroization in memory
      assert.equal(challenge.invoice.ephemeralPrivateKey, ZEROIZED_PRIVATE_KEY);
    });

    it("throws NO_FUNDS_TO_SWEEP when ephemeral balance is zero", async () => {
      const challenge = gateway.createPaymentChallenge("/api/v1/test", 5_000_000_000_000_000_000n, WQUAI_ADDRESS);
      // Zero balance
      await assert.rejects(
        () => gateway.sweepAndShield(challenge.invoice.invoiceId),
        /NO_FUNDS_TO_SWEEP/
      );
    });

    it("throws ALREADY_SWEPT when attempting to sweep an already swept invoice", async () => {
      const challenge = gateway.createPaymentChallenge("/api/v1/test", 5_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      await gateway.sweepAndShield(challenge.invoice.invoiceId);
      assert.equal(challenge.invoice.status, "SWEPT");

      await assert.rejects(
        () => gateway.sweepAndShield(challenge.invoice.invoiceId),
        /ALREADY_SWEPT/
      );
    });

    it("throws EPHEMERAL_KEY_ZEROIZED when ephemeral private key has been zeroized", async () => {
      const challenge = gateway.createPaymentChallenge("/api/v1/test", 5_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      zeroizeEphemeralKey(challenge.invoice);

      await assert.rejects(
        () => gateway.sweepAndShield(challenge.invoice.invoiceId),
        /EPHEMERAL_KEY_ZEROIZED/
      );
    });

    it("supports custom deterministic blinding for reproducible note commitments", async () => {
      const challenge = gateway.createPaymentChallenge("/api/v1/test", 3_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 3_000_000_000_000_000_000n);

      const customBlinding = 12345678901234567890n;
      const expectedCommitment = poseidon4(
        CORPORATE_NPK,
        Fp.fromHex(WQUAI_ADDRESS),
        3_000_000_000_000_000_000n,
        customBlinding
      );

      const receipt = await gateway.sweepAndShield(challenge.invoice.invoiceId, customBlinding);
      assert.equal(receipt.shieldedCommitment, expectedCommitment);
    });

    it("records note in corporate treasury shielded UTXO ledger", async () => {
      const challenge = gateway.createPaymentChallenge("/api/v1/test", 4_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 4_000_000_000_000_000_000n);

      const receipt = await gateway.sweepAndShield(challenge.invoice.invoiceId);
      assert.equal(gateway.sweeper.treasuryLedger.length, 1);
      const utxo = gateway.sweeper.treasuryLedger[0];
      assert.equal(utxo.commitment, receipt.shieldedCommitment);
      assert.equal(utxo.value, 4_000_000_000_000_000_000n);
      assert.equal(utxo.token, WQUAI_ADDRESS.toLowerCase());
      assert.equal(utxo.npk, CORPORATE_NPK);
    });

    it("records double-entry journal entry when AccountingJournalReconstructor is attached", async () => {
      const journal = new AccountingJournalReconstructor(CORPORATE_0ZK);
      const customGateway = new InboundMerchantGateway({ trustMode: "trusted-harness",
        masterMerchantKey: MASTER_MERCHANT_KEY,
        corporate0zkAddress: CORPORATE_0ZK,
        corporateNpk: CORPORATE_NPK,
        blockchain,
        pool,
        journal
      });

      const challenge = customGateway.createPaymentChallenge("/api/v1/test", 8_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 8_000_000_000_000_000_000n);

      const receipt = await customGateway.sweepAndShield(challenge.invoice.invoiceId);
      assert.equal(journal.entries.length, 1);
      const entry = journal.entries[0];
      assert.equal(entry.transactionType, "INBOUND_SWEEP");
      assert.equal(entry.grossAmount, 8_000_000_000_000_000_000n);
      assert.equal(entry.netAmount, 8_000_000_000_000_000_000n);
      assert.equal(entry.txHash, receipt.sweepTxHash);
    });

    it("encrypts note payload with corporate viewing public key when provided", async () => {
      const corporateKeys = deriveCorporateKeyHierarchy("777888999");
      const customGateway = new InboundMerchantGateway({ trustMode: "trusted-harness",
        masterMerchantKey: MASTER_MERCHANT_KEY,
        corporate0zkAddress: CORPORATE_0ZK,
        corporateNpk: CORPORATE_NPK,
        corporateVpk: corporateKeys.viewingPublicKey,
        blockchain,
        pool
      });

      const challenge = customGateway.createPaymentChallenge("/api/v1/test", 2_500_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 2_500_000_000_000_000_000n);

      const receipt = await customGateway.sweepAndShield(challenge.invoice.invoiceId);
      assert.ok(receipt.encryptedNote);
      assert.ok(receipt.encryptedNote.ciphertext);

      // Decrypt with viewing private key
      const decrypted = decryptNotePayload(corporateKeys.masterViewingKey, receipt.encryptedNote);
      assert.ok(decrypted);
      assert.equal(decrypted.direction, "INBOUND_SWEEP");
      assert.equal(decrypted.value, "2500000000000000000");
      assert.equal(decrypted.counterparty, challenge.invoice.ephemeralAddress);
      assert.equal(decrypted.invoiceId, challenge.invoice.invoiceId);
    });

    it("rejects sweep when ephemeral address is registered in sanctions list", async () => {
      const sanctionsRegistry = {
        isSanctioned: (addr: string) => addr.toLowerCase().endsWith("99")
      };

      const customGateway = new InboundMerchantGateway({ trustMode: "trusted-harness",
        masterMerchantKey: MASTER_MERCHANT_KEY,
        corporate0zkAddress: CORPORATE_0ZK,
        corporateNpk: CORPORATE_NPK,
        blockchain,
        pool
      });
      customGateway.sweeper.sanctionsRegistry = {
        isSanctioned: () => true // Always consider target sanctioned for test
      };

      const challenge = customGateway.createPaymentChallenge("/api/v1/test", 5_000_000_000_000_000_000n, WQUAI_ADDRESS);
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      await assert.rejects(
        () => customGateway.sweepAndShield(challenge.invoice.invoiceId),
        /SANCTIONED_DEPOSIT_DETECTED/
      );
    });

    it("executes batch sweeping across multiple settled invoices", async () => {
      const invoices: InvoiceRecord[] = [];
      const count = 5;

      for (let i = 0; i < count; i++) {
        const challenge = gateway.createPaymentChallenge(`/api/v1/batch/${i}`, 1_000_000_000_000_000_000n, WQUAI_ADDRESS);
        blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 1_000_000_000_000_000_000n);
        challenge.invoice.status = "SETTLED";
        invoices.push(challenge.invoice);
      }

      assert.equal(gateway.sweeper.getEligibleInvoices().length, count);

      const batchSummary = await gateway.sweeper.sweepBatch(10);
      assert.equal(batchSummary.successfulSweeps, count);
      assert.equal(batchSummary.failedSweeps, 0);
      assert.equal(batchSummary.totalSweptAmount, 5_000_000_000_000_000_000n);
      assert.equal(batchSummary.receipts.length, count);

      for (const inv of invoices) {
        assert.equal(inv.status, "SWEPT");
        assert.equal(inv.ephemeralPrivateKey, ZEROIZED_PRIVATE_KEY);
      }
    });

    it("starts and stops batch daemon cleanly", () => {
      gateway.sweeper.startBatchDaemon(100);
      gateway.sweeper.stopBatchDaemon();
      assert.equal((gateway.sweeper as any).batchTimer, null);
    });
  });

  // =========================================================================
  // 5. Credential Extraction & HTTP Middleware Integration
  // =========================================================================
  describe("5. Credential Extraction & HTTP Middleware Integration", () => {
    it("extracts credentials from x-payment-proof and x-payment-invoice-id headers", () => {
      const creds = gateway.extractCredentials({
        "x-payment-proof": "0xproof123",
        "x-payment-invoice-id": "inv_test_header_1"
      });
      assert.equal(creds.invoiceId, "inv_test_header_1");
      assert.equal(creds.proof, "0xproof123");
    });

    it("extracts credentials from Authorization: x402 invoice=..., proof=... header", () => {
      const creds = gateway.extractCredentials({
        authorization: 'x402 invoice="inv_auth_header_2", proof="0xproof456"'
      });
      assert.equal(creds.invoiceId, "inv_auth_header_2");
      assert.equal(creds.proof, "0xproof456");
    });

    it("extracts credentials from Authorization: Bearer JSON string", () => {
      const token = JSON.stringify({ invoiceId: "inv_bearer_json_3", proof: "0xproof789" });
      const creds = gateway.extractCredentials({
        authorization: `Bearer ${token}`
      });
      assert.equal(creds.invoiceId, "inv_bearer_json_3");
      assert.equal(creds.proof, "0xproof789");
    });

    it("extracts credentials from Authorization: Bearer Base64-encoded JSON", () => {
      const token = Buffer.from(
        JSON.stringify({ invoiceId: "inv_bearer_b64_4", proof: "0xproofabc" })
      ).toString("base64");
      const creds = gateway.extractCredentials({
        authorization: `Bearer ${token}`
      });
      assert.equal(creds.invoiceId, "inv_bearer_b64_4");
      assert.equal(creds.proof, "0xproofabc");
    });

    it("extracts credentials from Authorization: Bearer shorthand invoiceId:proof", () => {
      const creds = gateway.extractCredentials({
        authorization: "Bearer inv_bearer_short_5:0xproofdef"
      });
      assert.equal(creds.invoiceId, "inv_bearer_short_5");
      assert.equal(creds.proof, "0xproofdef");
    });

    it("middleware passes unprotected routes through to next handler", async () => {
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"]
      });

      let nextCalled = false;
      const req = { url: "/api/v1/public/health", headers: {} };
      const res: any = {};

      await middleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
    });

    it("middleware intercepts protected route without payment and responds 402 with challenge", async () => {
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"]
      });

      let nextCalled = false;
      const req = { url: "/api/v1/protected/analytics", headers: {} };
      let statusCode = 0;
      let responseBody: any = null;
      const responseHeaders: Record<string, string> = {};

      const res: any = {
        setHeader: (k: string, v: string) => {
          responseHeaders[k] = v;
        },
        json: (b: any) => {
          responseBody = b;
        }
      };

      Object.defineProperty(res, "statusCode", {
        set: (code: number) => {
          statusCode = code;
        },
        get: () => statusCode
      });

      await middleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(statusCode, 402);
      assert.ok(responseHeaders["WWW-Authenticate"]);
      assert.ok(responseBody);
      assert.equal(responseBody.status, 402);
      assert.equal(responseBody.payment.protocol, "x402");
    });

    it("middleware verifies valid payment credentials, auto-sweeps, and invokes next handler", async () => {
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"],
        autoSweep: true
      });

      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI_ADDRESS
      );
      blockchain.mintToken(WQUAI_ADDRESS, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0xValidMiddlewareProof123";
      const req: any = {
        url: "/api/v1/protected/analytics",
        headers: {
          "x-payment-invoice-id": challenge.invoice.invoiceId,
          "x-payment-proof": txHash
        }
      };

      let nextCalled = false;
      const resHeaders: Record<string, string> = {};
      const res: any = {
        setHeader: (k: string, v: string) => {
          resHeaders[k] = v;
        }
      };

      await middleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, true);
      assert.ok(req.paymentReceipt);
      assert.equal(challenge.invoice.status, "SWEPT");
      assert.equal(resHeaders["X-Payment-Status"], "SETTLED");
      assert.equal(resHeaders["X-Payment-Invoice-Id"], challenge.invoice.invoiceId);
    });

    it("middleware returns error status when payment credentials fail verification", async () => {
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"]
      });

      const req: any = {
        url: "/api/v1/protected/analytics",
        headers: {
          "x-payment-invoice-id": "inv_invalid_nonexistent",
          "x-payment-proof": "0xsomeproof"
        }
      };

      let nextCalled = false;
      let statusCode = 0;
      let responseBody: any = null;

      const res: any = {
        setHeader: () => {},
        json: (b: any) => {
          responseBody = b;
        }
      };
      Object.defineProperty(res, "statusCode", {
        set: (code: number) => {
          statusCode = code;
        },
        get: () => statusCode
      });

      await middleware(req, res, () => {
        nextCalled = true;
      });

      assert.equal(nextCalled, false);
      assert.equal(statusCode, 404);
      assert.equal(responseBody.error, "ERR_INVOICE_NOT_FOUND");
    });
  });
});
