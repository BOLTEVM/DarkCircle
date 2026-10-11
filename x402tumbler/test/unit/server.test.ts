/**
 * Milestone 2 Unit Tests: Resource Server & x402 Protocol
 * DarkCircle Protocol
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { ResourceServer } from "../../src/server/resourceServer.ts";
import { SimulatedBlockchain } from "../../src/sim/blockchain.ts";
import { RailgunPool } from "../../src/sim/railgunContract.ts";
import { InboundMerchantGateway } from "../e2e/harness.ts";

describe("Milestone 2 Unit Tests: Resource Server", () => {
  let blockchain: SimulatedBlockchain;
  let pool: RailgunPool;
  let gateway: InboundMerchantGateway;
  let server: ResourceServer;

  const WQUAI = "0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb";
  const MERCHANT_KEY = "darkcircle_merchant_unit_test_key_master";
  const CORP_0ZK = "0zk1qcorporate0zkaddressforprivacygateway123456789";
  const CORP_NPK = 88888888888888888888n;

  beforeEach(() => {
    blockchain = new SimulatedBlockchain();
    pool = new RailgunPool(blockchain, { mode: "trusted-harness" });
    gateway = new InboundMerchantGateway(
      MERCHANT_KEY,
      CORP_0ZK,
      CORP_NPK,
      blockchain as any,
      pool as any
    );
    server = new ResourceServer(gateway);
  });

  // =========================================================================
  // 1. Free Public Health Endpoint
  // =========================================================================
  describe("Public Health Endpoint", () => {
    it("returns HTTP 200 OK without requiring payment credentials", async () => {
      const res = await server.handleRequest("GET", "/api/v1/public/health");
      assert.equal(res.status, 200);
      assert.equal(res.headers["Content-Type"], "application/json");
      assert.equal(res.body.status, "healthy");
      assert.equal(res.body.service, "DarkCircle Resource Server");
      assert.equal(res.body.version, "1.0.0");
      assert.ok(typeof res.body.uptimeSeconds === "number");
      assert.ok(res.body.timestamp);
    });

    it("supports HEAD request method on health endpoint", async () => {
      const res = await server.handleRequest("HEAD", "/api/v1/public/health");
      assert.equal(res.status, 200);
    });
  });

  // =========================================================================
  // 2. Protected Route 402 Challenge Generation
  // =========================================================================
  describe("Protected Endpoints 402 Challenges", () => {
    it("issues compliant 402 challenge on /api/v1/protected/analytics (5.00 WQUAI)", async () => {
      const res = await server.handleRequest("GET", "/api/v1/protected/analytics");

      assert.equal(res.status, 402);
      assert.equal(res.headers["Content-Type"], "application/problem+json");
      assert.equal(res.headers["X-Payment-Required"], "true");
      assert.equal(res.headers["X-Payment-Scheme"], "x402-v1");
      assert.equal(res.headers["X-Payment-Network"], "quai-cyprus1");
      assert.equal(res.headers["X-Payment-Amount"], "5000000000000000000");
      assert.equal(res.headers["X-Payment-Token"].toLowerCase(), WQUAI.toLowerCase());
      assert.ok(res.headers["X-Payment-Recipient"].startsWith("0x"));
      assert.ok(res.headers["X-Payment-Invoice-Id"].startsWith("inv_"));
      assert.ok(res.headers["WWW-Authenticate"].startsWith("x402 "));

      // RFC 7807 problem details body verification
      assert.equal(res.body.type, "https://darkcircle.network/errors/payment-required");
      assert.equal(res.body.title, "Payment Required");
      assert.equal(res.body.status, 402);
      assert.equal(res.body.instance, "/api/v1/protected/analytics");
      assert.equal(res.body.payment.protocol, "x402");
      assert.equal(res.body.payment.amount, "5000000000000000000");
      assert.equal(res.body.payment.ephemeral, true);
      assert.equal(res.body.payment.proofType, "tx_receipt");
    });

    it("issues compliant 402 challenge on /api/v1/protected/ai-inference (10.00 WQUAI)", async () => {
      const res = await server.handleRequest(
        "POST",
        "/api/v1/protected/ai-inference",
        {},
        { model: "llama-3-8b" }
      );

      assert.equal(res.status, 402);
      assert.equal(res.headers["X-Payment-Amount"], "10000000000000000000");
      assert.equal(res.body.payment.amount, "10000000000000000000");
    });

    it("issues 402 challenge when request includes irrelevant or malformed headers", async () => {
      const res = await server.handleRequest("GET", "/api/v1/protected/analytics", {
        "x-random-header": "irrelevant_value"
      });
      assert.equal(res.status, 402);
      assert.equal(res.headers["X-Payment-Required"], "true");
    });
  });

  // =========================================================================
  // 3. Payment Proof Verification & Access Grants
  // =========================================================================
  describe("Payment Verification & Access Grants", () => {
    it("grants access to /analytics with valid payment headers and triggers auto-sweep", async () => {
      // 1. Create challenge
      const ch = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18
      );
      // 2. Settle on-chain
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      // 3. Request with settlement proof
      const txHash = "0x" + crypto.randomBytes(32).toString("hex");
      const res = await server.handleRequest("GET", "/api/v1/protected/analytics", {
        "x-payment-invoice-id": ch.invoice.invoiceId,
        "x-payment-proof": txHash
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers["Content-Type"], "application/json");
      assert.equal(res.headers["X-Payment-Status"], "SETTLED");
      assert.ok(res.headers["X-Payment-Receipt-Id"].startsWith("rct_"));
      // The demo gateway cannot see who paid, so it must not claim decoupling.
      assert.equal(res.headers["X-Payment-Relayer-Decoupled"], undefined);

      // Payload verification
      assert.equal(res.body.status, "success");
      assert.equal(res.body.path, "/api/v1/protected/analytics");
      assert.ok(res.body.data.activeUsers);
      assert.ok(res.body.data.totalVolumeUsd);

      // Auto-sweep verification
      const invoice = gateway.invoiceRegistry.get(ch.invoice.invoiceId)!;
      assert.equal(invoice.status, "SWEPT");
      assert.equal(
        invoice.ephemeralPrivateKey,
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      );
    });

    it("grants access to /ai-inference with valid POST request payload", async () => {
      const ch = gateway.createPaymentChallenge(
        "/api/v1/protected/ai-inference",
        10_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18
      );
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 10_000_000_000_000_000_000n);

      const txHash = "0x" + crypto.randomBytes(32).toString("hex");
      const res = await server.handleRequest(
        "POST",
        "/api/v1/protected/ai-inference",
        {
          "x-payment-invoice-id": ch.invoice.invoiceId,
          "x-payment-proof": txHash
        },
        { model: "llama-3-70b", prompt: "Summarize corporate balance sheet" }
      );

      assert.equal(res.status, 200);
      assert.equal(res.body.data.model, "llama-3-70b");
      assert.ok(res.body.data.inference);
    });

    it("is idempotent when re-submitting valid proof for the same settled invoice", async () => {
      const ch = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18
      );
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      const txHash = "0x" + crypto.randomBytes(32).toString("hex");

      const res1 = await server.handleRequest("GET", "/api/v1/protected/analytics", {
        "x-payment-invoice-id": ch.invoice.invoiceId,
        "x-payment-proof": txHash
      });
      assert.equal(res1.status, 200);

      // Repeat request with same txHash
      const res2 = await server.handleRequest("GET", "/api/v1/protected/analytics", {
        "x-payment-invoice-id": ch.invoice.invoiceId,
        "x-payment-proof": txHash
      });
      assert.equal(res2.status, 200);
    });
  });

  // =========================================================================
  // 4. Header Parsing Variations & Case-Insensitivity
  // =========================================================================
  describe("Authentication Header Formats", () => {
    it("accepts uppercase and mixed-case payment headers", async () => {
      const ch = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18
      );
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0x" + crypto.randomBytes(32).toString("hex");
      const res = await server.handleRequest("GET", "/api/v1/protected/analytics", {
        "X-PAYMENT-INVOICE-ID": ch.invoice.invoiceId,
        "X-PAYMENT-PROOF": txHash
      });
      assert.equal(res.status, 200);
    });

    it('accepts Authorization: x402 invoice="...", proof="..." header', async () => {
      const ch = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18
      );
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0x" + crypto.randomBytes(32).toString("hex");
      const auth = `x402 scheme="erc20_transfer", invoice="${ch.invoice.invoiceId}", proof="${txHash}"`;

      const res = await server.handleRequest("GET", "/api/v1/protected/analytics", {
        Authorization: auth
      });
      assert.equal(res.status, 200);
    });

    it("accepts Authorization: Bearer JSON-encoded token", async () => {
      const ch = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18
      );
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0x" + crypto.randomBytes(32).toString("hex");
      const token = JSON.stringify({ invoiceId: ch.invoice.invoiceId, proof: txHash });

      const res = await server.handleRequest("GET", "/api/v1/protected/analytics", {
        Authorization: `Bearer ${token}`
      });
      assert.equal(res.status, 200);
    });

    it("accepts Authorization: Bearer invoiceId:proof shorthand", async () => {
      const ch = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18
      );
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0x" + crypto.randomBytes(32).toString("hex");
      const res = await server.handleRequest("GET", "/api/v1/protected/analytics", {
        Authorization: `Bearer ${ch.invoice.invoiceId}:${txHash}`
      });
      assert.equal(res.status, 200);
    });
  });

  // =========================================================================
  // 5. Error Handling & Boundary Defense
  // =========================================================================
  describe("Error Handling & Boundary Defenses", () => {
    it("returns HTTP 404 for undefined non-protected route", async () => {
      const res = await server.handleRequest("GET", "/api/v1/unknown");
      assert.equal(res.status, 404);
      assert.equal(res.body.error, "NOT_FOUND");
    });

    it("returns HTTP 404 when payment proof is submitted for non-existent invoice", async () => {
      const res = await server.handleRequest("GET", "/api/v1/protected/analytics", {
        "x-payment-invoice-id": "inv_completely_nonexistent_999",
        "x-payment-proof": "0x" + "ab".repeat(32)
      });
      assert.equal(res.status, 404);
      assert.equal(res.body.error, "ERR_INVOICE_NOT_FOUND");
    });

    it("returns HTTP 410 Gone when invoice has expired", async () => {
      // Create invoice with negative TTL (already expired)
      const ch = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18,
        -100
      );

      const res = await server.handleRequest("GET", "/api/v1/protected/analytics", {
        "x-payment-invoice-id": ch.invoice.invoiceId,
        "x-payment-proof": "0x" + "ab".repeat(32)
      });
      assert.equal(res.status, 410);
      assert.equal(res.body.error, "ERR_INVOICE_EXPIRED");
    });

    it("returns HTTP 409 Conflict when reusing a settlement txHash (Replay Attack)", async () => {
      // 1. Legitimate payment of invoice 1
      const ch1 = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18
      );
      blockchain.mintToken(WQUAI, ch1.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      const txHash = "0x" + crypto.randomBytes(32).toString("hex");

      const res1 = await server.handleRequest("GET", "/api/v1/protected/analytics", {
        "x-payment-invoice-id": ch1.invoice.invoiceId,
        "x-payment-proof": txHash
      });
      assert.equal(res1.status, 200);

      // 2. Attacker creates invoice 2 and attempts to settle with same txHash
      const ch2 = gateway.createPaymentChallenge(
        "/api/v1/protected/ai-inference",
        10_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18
      );
      blockchain.mintToken(WQUAI, ch2.invoice.ephemeralAddress, 10_000_000_000_000_000_000n);

      const res2 = await server.handleRequest("POST", "/api/v1/protected/ai-inference", {
        "x-payment-invoice-id": ch2.invoice.invoiceId,
        "x-payment-proof": txHash
      });
      assert.equal(res2.status, 409);
      assert.equal(res2.body.error, "ERR_REPLAY_DETECTED");
    });

    it("returns HTTP 402 when on-chain deposit is insufficient (Underpayment)", async () => {
      const ch = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18
      );
      // Mint only 3 WQUAI (required: 5 WQUAI)
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 3_000_000_000_000_000_000n);

      const txHash = "0x" + crypto.randomBytes(32).toString("hex");
      const res = await server.handleRequest("GET", "/api/v1/protected/analytics", {
        "x-payment-invoice-id": ch.invoice.invoiceId,
        "x-payment-proof": txHash
      });
      assert.equal(res.status, 402);
      assert.equal(res.body.error, "ERR_UNDERPAYMENT");
    });
  });

  // =========================================================================
  // 6. Custom Route Registration
  // =========================================================================
  describe("Custom Route Registration", () => {
    it("allows registering custom protected routes with custom pricing", async () => {
      server.registerRoute({
        path: "/api/v1/protected/premium-report",
        method: "GET",
        isProtected: true,
        requiredAmount: 25_000_000_000_000_000_000n, // 25 WQUAI
        handler: () => ({ report: "Q3 Corporate Privacy Analysis", confidentiality: "Strict" })
      });

      // 1. Unauthenticated challenge
      const chRes = await server.handleRequest("GET", "/api/v1/protected/premium-report");
      assert.equal(chRes.status, 402);
      assert.equal(chRes.headers["X-Payment-Amount"], "25000000000000000000");

      // 2. Pay and authenticate
      const invId = chRes.headers["X-Payment-Invoice-Id"];
      const recipient = chRes.headers["X-Payment-Recipient"];
      blockchain.mintToken(WQUAI, recipient, 25_000_000_000_000_000_000n);

      const grantRes = await server.handleRequest("GET", "/api/v1/protected/premium-report", {
        "x-payment-invoice-id": invId,
        "x-payment-proof": "0x" + "ab".repeat(32)
      });
      assert.equal(grantRes.status, 200);
      assert.equal(grantRes.body.data.report, "Q3 Corporate Privacy Analysis");
    });
  });

  // =========================================================================
  // 7. Web Fetch API Compatibility
  // =========================================================================
  describe("Web Fetch API Interface", () => {
    it("handles fetch() for public health endpoint returning Response object", async () => {
      const response = await server.fetch("http://localhost/api/v1/public/health");
      assert.equal(response.status, 200);
      const json = (await response.json()) as any;
      assert.equal(json.status, "healthy");
    });

    it("handles fetch() for unauthenticated protected endpoint returning 402 Response", async () => {
      const response = await server.fetch("http://localhost/api/v1/protected/analytics");
      assert.equal(response.status, 402);
      assert.equal(response.headers.get("x-payment-required"), "true");
      const json = (await response.json()) as any;
      assert.equal(json.title, "Payment Required");
    });

    it("handles fetch() with payment proof returning 200 OK Response", async () => {
      const ch = gateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        WQUAI,
        "WQUAI",
        18
      );
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const txHash = "0x" + crypto.randomBytes(32).toString("hex");
      const response = await server.fetch("http://localhost/api/v1/protected/analytics", {
        headers: {
          "x-payment-invoice-id": ch.invoice.invoiceId,
          "x-payment-proof": txHash
        }
      });

      assert.equal(response.status, 200);
      const json = (await response.json()) as any;
      assert.equal(json.status, "success");
      assert.ok(json.data.activeUsers);
    });
  });
});
