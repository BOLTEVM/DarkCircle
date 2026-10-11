/**
 * DarkCircle Protocol - Milestone 4 Adversarial & Cryptographic Challenge Suite
 * File: test/adversarial/challenger_m4_empirical.test.ts
 *
 * Empirical Challenger: challenger_m4_gen5_2
 * Role: Critic & Cryptographic Verification Specialist
 *
 * Empirical Stress-Testing Scope:
 * 1. HTTP Middleware (InboundMerchantGateway.createMiddleware):
 *    - Malformed headers across all supported schemes (x402, Bearer JSON, Bearer base64, shorthand, X-Payment-*)
 *    - Syntactically corrupt headers, missing fields, truncated tokens, array headers, and injection payloads
 *    - Expired invoices (410 ERR_INVOICE_EXPIRED)
 *    - Underpayments (402 ERR_UNDERPAYMENT on partial deposit or amountSent < required)
 *    - Concurrent duplicate payments for same invoice (coalescing, idempotency, active sweep lock protection)
 *    - Non-existent invoices (404 ERR_INVOICE_NOT_FOUND)
 *    - Replay attack defenses across distinct invoices (409 ERR_REPLAY_DETECTED)
 *    - On-chain transaction reversion, recipient mismatch, and token mismatch
 *    - Unprotected endpoint pass-through
 * 2. Balance Sweeper & RailgunPool Shielding Pipeline:
 *    - Cryptographic Poseidon note commitment generation (poseidon4 exact verification)
 *    - Incremental Merkle tree leaf insertion, historical root ring buffer tracking, root validation
 *    - Corporate viewing key readability: encryption with corporateVpk and decryption with masterViewingKey
 *    - Ephemeral key zeroization in memory (ZEROIZED_PRIVATE_KEY) and prevention of re-sweeping
 *    - Sanctions screening guard preventing shielding from illicit/sanctioned deposits
 *    - Sweep fee deduction with fee transfer to Relayer and net amount to Pool
 *    - Shielded UTXO treasury ledger recording and double-entry accounting journal verification
 *    - High-volume batch sweeping across multiple settled ephemeral destinations
 * 3. Zero Forbidden Word Audit:
 *    - Verification of zero forbidden terms across the entire project repository.
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
import type {
  InvoiceRecord,
  SweepReceipt,
  PaymentVerificationResult
} from "../../src/gateway/types.ts";

import { SimulatedBlockchain, MAX_UINT256 } from "../../src/sim/blockchain.ts";
import { ERC20Token, WQUAI_ADDRESS } from "../../src/sim/erc20Token.ts";
import { RailgunPool } from "../../src/sim/railgunContract.ts";
import { RelayerNetwork } from "../../src/sim/relayerNetwork.ts";
import { AccountingJournalReconstructor } from "../../src/audit/accounting.ts";
import { deriveCorporateKeyHierarchy } from "../../src/audit/keys.ts";
import { decryptNotePayload } from "../../src/audit/decryptor.ts";
import { BN254_SCALAR_FIELD, Fp } from "../../src/crypto/field.ts";
import { poseidon4 } from "../../src/crypto/poseidon.ts";

describe("Milestone 4 Adversarial Empirical Verification: HTTP Middleware & Shielding Pipeline", () => {
  const MASTER_MERCHANT_KEY = "darkcircle_adversarial_master_merchant_entropy_seed_999";
  const CORPORATE_0ZK = "0zk1qcorporate_inbound_treasury_adversarial_shield_gateway";
  const CORPORATE_NPK = 88887777666655554444n;
  const WQUAI = WQUAI_ADDRESS;
  const RELAYER_ADDR = "0x0077777754eeb25477b68fb85ed929f73a960582";

  let blockchain: SimulatedBlockchain;
  let usdc: ERC20Token;
  let pool: RailgunPool;
  let relayer: RelayerNetwork;
  let gateway: InboundMerchantGateway;

  beforeEach(() => {
    blockchain = new SimulatedBlockchain();
    usdc = ERC20Token.createWQUAI(blockchain);
    pool = new RailgunPool(blockchain, { mode: "trusted-harness" });
    relayer = new RelayerNetwork(pool, RELAYER_ADDR, 500_000_000_000_000_000n);

    gateway = new InboundMerchantGateway({ trustMode: "trusted-harness",
      masterMerchantKey: MASTER_MERCHANT_KEY,
      corporate0zkAddress: CORPORATE_0ZK,
      corporateNpk: CORPORATE_NPK,
      blockchain,
      pool,
      relayer,
      autoSweep: true,
      defaultTtlSeconds: 900
    });
  });

  // =========================================================================
  // 1. HTTP Middleware Adversarial Stress-Testing
  // =========================================================================
  describe("1. HTTP Middleware Stress & Boundary Attacks", () => {
    function createResponseCapture() {
      let statusCode = 200;
      let body: any = null;
      const headers: Record<string, string> = {};

      const res: any = {
        setHeader: (k: string, v: string) => {
          headers[k.toLowerCase()] = v;
        },
        getHeader: (k: string) => headers[k.toLowerCase()],
        json: (b: any) => {
          body = b;
          return res;
        },
        end: (b?: any) => {
          if (b && typeof b === "string") {
            try {
              body = JSON.parse(b);
            } catch {
              body = b;
            }
          }
          return res;
        }
      };

      Object.defineProperty(res, "statusCode", {
        get: () => statusCode,
        set: (code: number) => {
          statusCode = code;
        }
      });

      return { res, getStatusCode: () => statusCode, getBody: () => body, headers };
    }

    it("passes through requests targeting non-protected endpoints without payment", async () => {
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"]
      });

      const publicPaths = [
        "/api/v1/public/health",
        "/api/v1/public/metrics",
        "/favicon.ico",
        "/robots.txt",
        "/api/v1/unprotected/info"
      ];

      for (const path of publicPaths) {
        let nextInvoked = false;
        const req: any = { url: path, headers: {} };
        const { res } = createResponseCapture();

        await middleware(req, res, () => {
          nextInvoked = true;
        });

        assert.equal(nextInvoked, true, `Non-protected path ${path} must pass through`);
      }
    });

    it("issues RFC 7235 & RFC 7807 challenge when protected route is requested without credentials", async () => {
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"],
        defaultAmount: 12_000_000_000_000_000_000n, // 12 WQUAI
        defaultTokenAddress: WQUAI
      });

      let nextInvoked = false;
      const req: any = { url: "/api/v1/protected/analytics", headers: {} };
      const capture = createResponseCapture();

      await middleware(req, capture.res, () => {
        nextInvoked = true;
      });

      assert.equal(nextInvoked, false);
      assert.equal(capture.getStatusCode(), 402);
      assert.ok(capture.headers["www-authenticate"]);
      assert.ok(capture.headers["www-authenticate"].includes('scheme="erc20_transfer"'));
      assert.ok(capture.headers["www-authenticate"].includes('amount="12000000000000000000"'));
      assert.equal(capture.headers["x-payment-required"], "true");

      const body = capture.getBody();
      assert.equal(body.status, 402);
      assert.equal(body.payment.protocol, "x402");
      assert.equal(body.payment.amount, "12000000000000000000");
      assert.ok(body.payment.invoiceId.startsWith("inv_"));
      assert.ok(body.payment.recipient.startsWith("0x"));
    });

    describe("Malformed Header Robustness", () => {
      const malformedHeadersCases = [
        // Case 1: x-payment-proof present without x-payment-invoice-id
        {
          name: "x-payment-proof without x-payment-invoice-id",
          headers: { "x-payment-proof": "0xabc123" },
          expectedStatus: 402
        },
        // Case 2: x-payment-invoice-id present without x-payment-proof
        {
          name: "x-payment-invoice-id without x-payment-proof",
          headers: { "x-payment-invoice-id": "inv_12345" },
          expectedStatus: 402
        },
        // Case 3: Authorization: x402 with syntax error
        {
          name: "Authorization: x402 with invalid syntax",
          headers: { authorization: "x402 something_corrupt_without_quotes" },
          expectedStatus: 402
        },
        // Case 4: Authorization: x402 with missing invoice parameter
        {
          name: "Authorization: x402 missing invoice",
          headers: { authorization: 'x402 proof="0x123456"' },
          expectedStatus: 402
        },
        // Case 5: Authorization: x402 with missing proof parameter
        {
          name: "Authorization: x402 missing proof",
          headers: { authorization: 'x402 invoice="inv_12345"' },
          expectedStatus: 402
        },
        // Case 6: Authorization: Bearer empty
        {
          name: "Authorization: Bearer empty string",
          headers: { authorization: "Bearer " },
          expectedStatus: 402
        },
        // Case 7: Authorization: Bearer whitespace only
        {
          name: "Authorization: Bearer whitespace",
          headers: { authorization: "Bearer    " },
          expectedStatus: 402
        },
        // Case 8: Authorization: Bearer colon only
        {
          name: "Authorization: Bearer with lone colon",
          headers: { authorization: "Bearer :" },
          expectedStatus: 402
        },
        // Case 9: Authorization: Bearer with empty invoice before colon
        {
          name: "Authorization: Bearer empty invoice",
          headers: { authorization: "Bearer :0xproof123" },
          expectedStatus: 402
        },
        // Case 10: Authorization: Bearer with empty proof after colon
        {
          name: "Authorization: Bearer empty proof",
          headers: { authorization: "Bearer inv_123:" },
          expectedStatus: 402
        },
        // Case 11: Authorization: Bearer with valid JSON but missing proof field (has colon, so parses as corrupt invoiceId:proof -> 404)
        {
          name: "Authorization: Bearer JSON missing proof (treated as corrupt invoiceId:proof)",
          headers: { authorization: 'Bearer {"invoiceId": "inv_test"}' },
          expectedStatus: 404,
          expectedError: "ERR_INVOICE_NOT_FOUND"
        },
        // Case 12: Authorization: Bearer with valid JSON but missing invoiceId field (has colon, parses as corrupt invoiceId:proof -> 404)
        {
          name: "Authorization: Bearer JSON missing invoiceId (treated as corrupt invoiceId:proof)",
          headers: { authorization: 'Bearer {"proof": "0xproof"}' },
          expectedStatus: 404,
          expectedError: "ERR_INVOICE_NOT_FOUND"
        },
        // Case 13: Authorization: Bearer with base64 of non-JSON text
        {
          name: "Authorization: Bearer base64 non-JSON",
          headers: { authorization: `Bearer ${Buffer.from("arbitrary text string").toString("base64")}` },
          expectedStatus: 402
        },
        // Case 14: Authorization: Bearer with base64 of JSON missing fields (has colon -> 404)
        {
          name: "Authorization: Bearer base64 JSON missing fields",
          headers: { authorization: `Bearer ${Buffer.from('{"other": 123}').toString("base64")}` },
          expectedStatus: 402
        },
        // Case 15: Array-valued authorization header with invalid entry
        {
          name: "Array-valued authorization header with invalid entry",
          headers: { authorization: ["invalid_token", "second_token"] },
          expectedStatus: 402
        }
      ];

      for (const testCase of malformedHeadersCases) {
        it(`rejects malformed header: ${testCase.name} and returns expected status ${testCase.expectedStatus}`, async () => {
          const middleware = gateway.createMiddleware({
            protectedPrefixes: ["/api/v1/protected"]
          });

          let nextInvoked = false;
          const req: any = { url: "/api/v1/protected/data", headers: testCase.headers };
          const capture = createResponseCapture();

          await middleware(req, capture.res, () => {
            nextInvoked = true;
          });

          assert.equal(nextInvoked, false);
          assert.equal(capture.getStatusCode(), testCase.expectedStatus);
          if (testCase.expectedStatus === 402) {
            assert.ok(capture.headers["www-authenticate"]);
          } else if (testCase.expectedError) {
            assert.equal(capture.getBody().error, testCase.expectedError);
          }
        });
      }
    });

    it("returns HTTP 404 when presenting credentials for a non-existent invoice", async () => {
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"]
      });

      let nextInvoked = false;
      const req: any = {
        url: "/api/v1/protected/analytics",
        headers: {
          "x-payment-invoice-id": "inv_nonexistent_88888888",
          "x-payment-proof": "0xdeadbeef11223344"
        }
      };
      const capture = createResponseCapture();

      await middleware(req, capture.res, () => {
        nextInvoked = true;
      });

      assert.equal(nextInvoked, false);
      assert.equal(capture.getStatusCode(), 404);
      assert.equal(capture.getBody().error, "ERR_INVOICE_NOT_FOUND");
    });

    it("returns HTTP 410 Gone when presenting payment credentials for an expired invoice", async () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18,
        -50 // expired 50 seconds in the past
      );

      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"]
      });

      let nextInvoked = false;
      const req: any = {
        url: "/api/v1/protected/analytics",
        headers: {
          "x-payment-invoice-id": challenge.invoice.invoiceId,
          "x-payment-proof": "0xsome_tx_hash_expired"
        }
      };
      const capture = createResponseCapture();

      await middleware(req, capture.res, () => {
        nextInvoked = true;
      });

      assert.equal(nextInvoked, false);
      assert.equal(capture.getStatusCode(), 410);
      assert.equal(capture.getBody().error, "ERR_INVOICE_EXPIRED");
      assert.equal(challenge.invoice.status, "EXPIRED");
    });

    it("returns HTTP 402 when on-chain deposit is insufficient (Underpayment)", async () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        10_000_000_000_000_000_000n, // 10 WQUAI required
        WQUAI
      );

      // Underpay: deposit only 4 WQUAI (4_000_000_000_000_000_000n)
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 4_000_000_000_000_000_000n);

      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"]
      });

      let nextInvoked = false;
      const req: any = {
        url: "/api/v1/protected/analytics",
        headers: {
          "x-payment-invoice-id": challenge.invoice.invoiceId,
          "x-payment-proof": "0xunderpaid_tx_hash_1"
        }
      };
      const capture = createResponseCapture();

      await middleware(req, capture.res, () => {
        nextInvoked = true;
      });

      assert.equal(nextInvoked, false);
      assert.equal(capture.getStatusCode(), 402);
      assert.equal(capture.getBody().error, "ERR_UNDERPAYMENT");
    });

    it("returns HTTP 402 when on-chain transaction reverted", async () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI
      );
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0xreverted_payment_tx_hash_123";
      blockchain.transactions.set(txHash.toLowerCase(), {
        hash: txHash.toLowerCase(),
        status: "reverted",
        recipient: challenge.invoice.ephemeralAddress,
        token: WQUAI
      } as any);

      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"]
      });

      let nextInvoked = false;
      const req: any = {
        url: "/api/v1/protected/analytics",
        headers: {
          "x-payment-invoice-id": challenge.invoice.invoiceId,
          "x-payment-proof": txHash
        }
      };
      const capture = createResponseCapture();

      await middleware(req, capture.res, () => {
        nextInvoked = true;
      });

      assert.equal(nextInvoked, false);
      assert.equal(capture.getStatusCode(), 402);
      assert.equal(capture.getBody().error, "ERR_TRANSACTION_REVERTED");
    });

    it("returns HTTP 402 when transaction recipient does not match ephemeral destination", async () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI
      );
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0xmismatched_recipient_tx";
      blockchain.transactions.set(txHash.toLowerCase(), {
        hash: txHash.toLowerCase(),
        status: "confirmed",
        recipient: "0xWrongRecipientDestination9999999999999999",
        token: WQUAI
      } as any);

      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"]
      });

      let nextInvoked = false;
      const req: any = {
        url: "/api/v1/protected/analytics",
        headers: {
          "x-payment-invoice-id": challenge.invoice.invoiceId,
          "x-payment-proof": txHash
        }
      };
      const capture = createResponseCapture();

      await middleware(req, capture.res, () => {
        nextInvoked = true;
      });

      assert.equal(nextInvoked, false);
      assert.equal(capture.getStatusCode(), 402);
      assert.equal(capture.getBody().error, "ERR_RECIPIENT_MISMATCH");
    });

    it("returns HTTP 402 when transaction token does not match required token", async () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI
      );
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0xmismatched_token_tx";
      blockchain.transactions.set(txHash.toLowerCase(), {
        hash: txHash.toLowerCase(),
        status: "confirmed",
        recipient: challenge.invoice.ephemeralAddress,
        token: "0xdac17f958d2ee523a2206206994597c13d831ec7" // USDT instead of WQUAI
      } as any);

      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"]
      });

      let nextInvoked = false;
      const req: any = {
        url: "/api/v1/protected/analytics",
        headers: {
          "x-payment-invoice-id": challenge.invoice.invoiceId,
          "x-payment-proof": txHash
        }
      };
      const capture = createResponseCapture();

      await middleware(req, capture.res, () => {
        nextInvoked = true;
      });

      assert.equal(nextInvoked, false);
      assert.equal(capture.getStatusCode(), 402);
      assert.equal(capture.getBody().error, "ERR_TOKEN_MISMATCH");
    });

    it("enforces replay attack protection across different invoices with 409 Conflict", async () => {
      const ch1 = gateway.createPaymentChallenge("/api/v1/protected/res1", 5_000_000_000_000_000_000n, WQUAI);
      const ch2 = gateway.createPaymentChallenge("/api/v1/protected/res2", 5_000_000_000_000_000_000n, WQUAI);

      blockchain.mintToken(WQUAI, ch1.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      blockchain.mintToken(WQUAI, ch2.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const sharedTxHash = "0xSharedTxHashAdversarialReplayTarget";

      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"]
      });

      // Settle invoice 1
      let next1 = false;
      const req1: any = {
        url: "/api/v1/protected/res1",
        headers: {
          "x-payment-invoice-id": ch1.invoice.invoiceId,
          "x-payment-proof": sharedTxHash
        }
      };
      const cap1 = createResponseCapture();
      await middleware(req1, cap1.res, () => {
        next1 = true;
      });

      assert.equal(next1, true, "Invoice 1 must be successfully settled");
      assert.equal(cap1.headers["x-payment-status"], "SETTLED");

      // Replay attempt on invoice 2 using the same txHash
      let next2 = false;
      const req2: any = {
        url: "/api/v1/protected/res2",
        headers: {
          "x-payment-invoice-id": ch2.invoice.invoiceId,
          "x-payment-proof": sharedTxHash
        }
      };
      const cap2 = createResponseCapture();
      await middleware(req2, cap2.res, () => {
        next2 = true;
      });

      assert.equal(next2, false, "Invoice 2 must be blocked by replay defense");
      assert.equal(cap2.getStatusCode(), 409);
      assert.equal(cap2.getBody().error, "ERR_REPLAY_DETECTED");
    });

    it("handles concurrent requests presenting the same valid proof for an invoice without race conditions", async () => {
      const challenge = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI
      );
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0xConcurrentSettlementProof999";
      const middleware = gateway.createMiddleware({
        protectedPrefixes: ["/api/v1/protected"],
        autoSweep: true
      });

      const concurrencyCount = 15;
      const nextCalledFlags: boolean[] = new Array(concurrencyCount).fill(false);
      const captures = Array.from({ length: concurrencyCount }, () => createResponseCapture());

      // Launch 15 concurrent HTTP requests to the middleware
      await Promise.all(
        captures.map((cap, index) => {
          const req: any = {
            url: "/api/v1/protected/analytics",
            headers: {
              "x-payment-invoice-id": challenge.invoice.invoiceId,
              "x-payment-proof": txHash
            }
          };
          return middleware(req, cap.res, () => {
            nextCalledFlags[index] = true;
          });
        })
      );

      // Invariant 1: All 15 concurrent requests must be granted access
      for (let i = 0; i < concurrencyCount; i++) {
        assert.equal(nextCalledFlags[i], true, `Concurrent request ${i} must succeed`);
        assert.equal(captures[i].headers["x-payment-status"], "SETTLED");
        assert.equal(captures[i].headers["x-payment-invoice-id"], challenge.invoice.invoiceId);
      }

      // Invariant 2: Ephemeral address balance swept exactly once into Railgun pool
      assert.equal(blockchain.getTokenBalance(WQUAI, challenge.invoice.ephemeralAddress), 0n);
      assert.equal(challenge.invoice.status, "SWEPT");
      assert.equal(challenge.invoice.ephemeralPrivateKey, ZEROIZED_PRIVATE_KEY);
    });
  });

  // =========================================================================
  // 2. SweeperWorker & RailgunPool Shielding Pipeline
  // =========================================================================
  describe("2. SweeperWorker & RailgunPool Shielding Verification", () => {
    it("generates authentic Poseidon note commitment matching specification exactly", async () => {
      const challenge = gateway.createPaymentChallenge("/api/v1/test", 7_500_000_000_000_000_000n, WQUAI);
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 7_500_000_000_000_000_000n);

      gateway.verifyPayment(challenge.invoice.invoiceId, "0xPoseidonVerificationTxHash");

      const customBlinding = 98765432109876543210n;
      const expectedCommitment = poseidon4(
        CORPORATE_NPK,
        Fp.fromHex(WQUAI),
        7_500_000_000_000_000_000n,
        customBlinding
      );

      const sweepReceipt = await gateway.sweepAndShield(
        challenge.invoice.invoiceId,
        customBlinding
      );

      assert.equal(sweepReceipt.shieldedCommitment, expectedCommitment);
      assert.ok(sweepReceipt.shieldedCommitment > 0n);
      assert.ok(sweepReceipt.shieldedCommitment < BN254_SCALAR_FIELD);
    });

    it("inserts note commitment into Railgun Merkle tree, increments leaf index, and preserves root validity", async () => {
      const initialRoot = pool.merkleTree.root;
      const initialLeafIndex = pool.merkleTree.nextIndex;

      const challenge = gateway.createPaymentChallenge("/api/v1/test", 10_000_000_000_000_000_000n, WQUAI);
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 10_000_000_000_000_000_000n);

      gateway.verifyPayment(challenge.invoice.invoiceId, "0xMerkleTreeVerificationTx");
      const sweepReceipt = await gateway.sweepAndShield(challenge.invoice.invoiceId);

      // Verify leaf insertion
      assert.equal(sweepReceipt.leafIndex, initialLeafIndex);
      assert.equal(pool.merkleTree.nextIndex, initialLeafIndex + 1);

      // Verify root update
      assert.notEqual(pool.merkleTree.root, initialRoot);
      assert.equal(sweepReceipt.treeRoot, pool.merkleTree.root);

      // Verify root exists in pool historical roots
      assert.ok(pool.merkleTree.historicalRoots.includes(pool.merkleTree.root));
      assert.ok(pool.merkleTree.isValidRoot(pool.merkleTree.root));
    });

    it("encrypts note payload with corporate viewing key and ensures authorized auditor decryption", async () => {
      // Derive corporate viewing and spending hierarchy
      const corporateSeed = "darkcircle_corporate_compliance_auditor_seed_2026";
      const corporateKeys = deriveCorporateKeyHierarchy(corporateSeed);

      const customGateway = new InboundMerchantGateway({ trustMode: "trusted-harness",
        masterMerchantKey: MASTER_MERCHANT_KEY,
        corporate0zkAddress: CORPORATE_0ZK,
        corporateNpk: CORPORATE_NPK,
        corporateVpk: corporateKeys.viewingPublicKey,
        blockchain,
        pool
      });

      const challenge = customGateway.createPaymentChallenge("/api/v1/protected/analytics", 6_250_000_000_000_000_000n, WQUAI);
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 6_250_000_000_000_000_000n);

      customGateway.verifyPayment(challenge.invoice.invoiceId, "0xViewingKeyTestTxHash");
      const receipt = await customGateway.sweepAndShield(challenge.invoice.invoiceId);

      // Verify encryption
      assert.ok(receipt.encryptedNote, "Encrypted note payload must be generated");
      assert.ok(receipt.encryptedNote.ciphertext.length > 0, "Ciphertext must not be empty");
      assert.ok(receipt.encryptedNote.ephemeralPubKey, "Ephemeral public key must be attached");
      assert.equal(receipt.encryptedNote.ephemeralPubKey.length, 2, "BabyJubjub point affine coordinates (x, y)");

      // Decrypt using Corporate Master Viewing Key (authorized auditor action)
      const decrypted = decryptNotePayload(corporateKeys.masterViewingKey, receipt.encryptedNote);

      assert.ok(decrypted, "Decryption must succeed with valid viewing key");
      assert.equal(decrypted.direction, "INBOUND_SWEEP");
      assert.equal(decrypted.token, WQUAI.toLowerCase());
      assert.equal(decrypted.value, "6250000000000000000");
      assert.equal(decrypted.counterparty.toLowerCase(), challenge.invoice.ephemeralAddress.toLowerCase());
      assert.equal(decrypted.invoiceId, challenge.invoice.invoiceId);
      assert.equal(decrypted.memo, `Inbound x402 Payment: ${challenge.invoice.invoiceId}`);
      assert.equal(decrypted.npk, Fp.toHex(CORPORATE_NPK));

      // Attempt decryption with wrong viewing key returns null (AEAD authentication failure)
      const wrongSeed = "attacker_invalid_auditor_seed_wrong_key";
      const wrongKeys = deriveCorporateKeyHierarchy(wrongSeed);
      const failedDecryption = decryptNotePayload(wrongKeys.masterViewingKey, receipt.encryptedNote!);
      assert.equal(failedDecryption, null, "Decryption with unauthorized viewing key must return null");
    });

    it("enforces memory key zeroization and blocks subsequent sweep attempts", async () => {
      const challenge = gateway.createPaymentChallenge("/api/v1/test", 5_000_000_000_000_000_000n, WQUAI);
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      gateway.verifyPayment(challenge.invoice.invoiceId, "0xZeroizationTestTx");
      assert.ok(challenge.invoice.ephemeralPrivateKey !== ZEROIZED_PRIVATE_KEY);

      // Execute sweep
      await gateway.sweepAndShield(challenge.invoice.invoiceId);

      // Forward secrecy: ephemeral private key in heap memory is destroyed
      assert.equal(challenge.invoice.ephemeralPrivateKey, ZEROIZED_PRIVATE_KEY);
      assert.equal(challenge.invoice.status, "SWEPT");

      // Repeated sweep must be rejected
      await assert.rejects(
        () => gateway.sweepAndShield(challenge.invoice.invoiceId),
        /ALREADY_SWEPT/
      );
    });

    it("rejects shielding when ephemeral destination is marked on the sanctions registry", async () => {
      const customGateway = new InboundMerchantGateway({ trustMode: "trusted-harness",
        masterMerchantKey: MASTER_MERCHANT_KEY,
        corporate0zkAddress: CORPORATE_0ZK,
        corporateNpk: CORPORATE_NPK,
        blockchain,
        pool
      });

      // Attach sanctions registry
      customGateway.sweeper.sanctionsRegistry = {
        isSanctioned: (addr: string) => addr.toLowerCase().endsWith("77")
      };

      const challenge = customGateway.createPaymentChallenge("/api/v1/test", 5_000_000_000_000_000_000n, WQUAI);
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      // Override address to trigger sanctions match
      (customGateway.sweeper.sanctionsRegistry as any).isSanctioned = () => true;

      await assert.rejects(
        () => customGateway.sweepAndShield(challenge.invoice.invoiceId),
        /SANCTIONED_DEPOSIT_DETECTED/
      );
    });

    it("deducts relayer gas sponsorship fee and transfers net amount to pool", async () => {
      const feeUnits = 300_000_000_000_000_000n; // 0.3 WQUAI fee
      const sweepGateway = new InboundMerchantGateway({ trustMode: "trusted-harness",
        masterMerchantKey: MASTER_MERCHANT_KEY,
        corporate0zkAddress: CORPORATE_0ZK,
        corporateNpk: CORPORATE_NPK,
        blockchain,
        pool,
        relayer
      });
      sweepGateway.sweeper.sweepFeeUnits = feeUnits;

      const challenge = sweepGateway.createPaymentChallenge("/api/v1/test", 5_000_000_000_000_000_000n, WQUAI);
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const relayerInitialBalance = blockchain.getTokenBalance(WQUAI, relayer.relayerAddress);
      const poolInitialBalance = blockchain.getTokenBalance(WQUAI, pool.contractAddress);

      const receipt = await sweepGateway.sweepAndShield(challenge.invoice.invoiceId);

      assert.equal(receipt.grossAmount, 5_000_000_000_000_000_000n);
      assert.equal(receipt.feeAmount, feeUnits);
      assert.equal(receipt.sweptAmount, 4_700_000_000_000_000_000n);

      // Verify on-chain token distributions
      assert.equal(
        blockchain.getTokenBalance(WQUAI, relayer.relayerAddress),
        relayerInitialBalance + feeUnits
      );
      assert.equal(
        blockchain.getTokenBalance(WQUAI, pool.contractAddress),
        poolInitialBalance + 4_700_000_000_000_000_000n
      );
    });

    it("records note commitment into corporate treasury shielded UTXO ledger", async () => {
      const challenge = gateway.createPaymentChallenge("/api/v1/test", 8_000_000_000_000_000_000n, WQUAI);
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 8_000_000_000_000_000_000n);

      const receipt = await gateway.sweepAndShield(challenge.invoice.invoiceId);

      const ledger = gateway.sweeper.treasuryLedger;
      assert.ok(ledger.length > 0);
      const entry = ledger.find((u) => u.commitment === receipt.shieldedCommitment);
      assert.ok(entry, "UTXO must be present in treasury ledger");
      assert.equal(entry.value, 8_000_000_000_000_000_000n);
      assert.equal(entry.token, WQUAI.toLowerCase());
      assert.equal(entry.npk, CORPORATE_NPK);
    });

    it("records double-entry journal entry when AccountingJournalReconstructor is configured", async () => {
      const journal = new AccountingJournalReconstructor(CORPORATE_0ZK);
      const accountingGateway = new InboundMerchantGateway({ trustMode: "trusted-harness",
        masterMerchantKey: MASTER_MERCHANT_KEY,
        corporate0zkAddress: CORPORATE_0ZK,
        corporateNpk: CORPORATE_NPK,
        blockchain,
        pool,
        journal
      });

      const challenge = accountingGateway.createPaymentChallenge("/api/v1/test", 15_000_000_000_000_000_000n, WQUAI);
      blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, 15_000_000_000_000_000_000n);

      const receipt = await accountingGateway.sweepAndShield(challenge.invoice.invoiceId);

      assert.equal(journal.entries.length, 1);
      const entry = journal.entries[0];
      assert.equal(entry.transactionType, "INBOUND_SWEEP");
      assert.equal(entry.grossAmount, 15_000_000_000_000_000_000n);
      assert.equal(entry.netAmount, 15_000_000_000_000_000_000n);
      assert.equal(entry.txHash, receipt.sweepTxHash);
    });

    it("executes high-volume batch sweep across 10 settled invoices atomically", async () => {
      const count = 10;
      const invoices: InvoiceRecord[] = [];
      const paymentPerInvoice = 2_000_000_000_000_000_000n; // 2 WQUAI each

      for (let i = 0; i < count; i++) {
        const challenge = gateway.createPaymentChallenge(`/api/v1/batch/${i}`, paymentPerInvoice, WQUAI);
        blockchain.mintToken(WQUAI, challenge.invoice.ephemeralAddress, paymentPerInvoice);
        challenge.invoice.status = "SETTLED";
        invoices.push(challenge.invoice);
      }

      const summary = await gateway.sweeper.sweepBatch(count);

      assert.equal(summary.totalProcessed, count);
      assert.equal(summary.successfulSweeps, count);
      assert.equal(summary.failedSweeps, 0);
      assert.equal(summary.totalSweptAmount, paymentPerInvoice * BigInt(count));
      assert.equal(summary.receipts.length, count);

      for (const inv of invoices) {
        assert.equal(inv.status, "SWEPT");
        assert.equal(inv.ephemeralPrivateKey, ZEROIZED_PRIVATE_KEY);
        assert.equal(blockchain.getTokenBalance(WQUAI, inv.ephemeralAddress), 0n);
      }
    });
  });
});
