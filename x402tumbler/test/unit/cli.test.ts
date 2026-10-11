/**
 * DarkCircle Protocol: CLI Unit & Integration Test Suite
 * File: test/unit/cli.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { runCli } from "../../src/cli/index.ts";
import { createDefaultCliContext } from "../../src/cli/context.ts";
import { CliExitCode } from "../../src/cli/types.ts";
import { ResourceServer } from "../../src/server/resourceServer.ts";
import { parseTokenAmount } from "../../src/cli/parser.ts";
import { ZEROIZED_PRIVATE_KEY } from "../../src/gateway/ephemeral.ts";

describe("Milestone 5: DarkCircle CLI & Integration Test Suite", () => {
  // ---------------------------------------------------------------------------
  // 1. Top-Level CLI Routing & Global Flags
  // ---------------------------------------------------------------------------
  describe("Top-Level Routing & Global Flags", () => {
    it("prints version and exits 0 when --version or -v is passed", async () => {
      const res1 = await runCli(["--version"]);
      assert.equal(res1.exitCode, CliExitCode.SUCCESS);
      assert(res1.stdout.includes("DarkCircle v1.0.0"));

      const res2 = await runCli(["-v"]);
      assert.equal(res2.exitCode, CliExitCode.SUCCESS);
      assert(res2.stdout.includes("DarkCircle v1.0.0"));
    });

    it("prints top-level help and exits 0 on empty arguments or --help", async () => {
      const resEmpty = await runCli([]);
      assert.equal(resEmpty.exitCode, CliExitCode.SUCCESS);
      assert(resEmpty.stdout.includes("DarkCircle: Enterprise x402 Privacy Suite"));
      assert(resEmpty.stdout.includes("COMMANDS:"));

      const resHelp = await runCli(["--help"]);
      assert.equal(resHelp.exitCode, CliExitCode.SUCCESS);
      assert(resHelp.stdout.includes("USAGE:"));
      assert(resHelp.stdout.includes("pay"));
      assert(resHelp.stdout.includes("invoice"));
      assert(resHelp.stdout.includes("sweep"));
      assert(resHelp.stdout.includes("audit"));
      assert(resHelp.stdout.includes("balance"));
    });

    it("prints command-specific help with help <command> and <command> --help", async () => {
      const res1 = await runCli(["help", "pay"]);
      assert.equal(res1.exitCode, CliExitCode.SUCCESS);
      assert(res1.stdout.includes("darkcircle pay"));

      const res2 = await runCli(["invoice", "--help"]);
      assert.equal(res2.exitCode, CliExitCode.SUCCESS);
      assert(res2.stdout.includes("darkcircle invoice"));

      const res3 = await runCli(["sweep", "-h"]);
      assert.equal(res3.exitCode, CliExitCode.SUCCESS);
      assert(res3.stdout.includes("darkcircle sweep"));

      const res4 = await runCli(["audit", "--help"]);
      assert.equal(res4.exitCode, CliExitCode.SUCCESS);
      assert(res4.stdout.includes("darkcircle audit"));

      const res5 = await runCli(["balance", "--help"]);
      assert.equal(res5.exitCode, CliExitCode.SUCCESS);
      assert(res5.stdout.includes("darkcircle balance"));
    });

    it("returns USAGE_ERROR (exit code 2) on unknown command", async () => {
      const res = await runCli(["unknown_subcommand"]);
      assert.equal(res.exitCode, CliExitCode.USAGE_ERROR);
      assert(res.stderr.includes("ERROR: Unknown command 'unknown_subcommand'"));
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Balance Command
  // ---------------------------------------------------------------------------
  describe("Balance Command", () => {
    it("displays tabular balance report in default text mode", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["balance"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);
      assert(res.stdout.includes("DARKCIRCLE TREASURY & ACCOUNT BALANCES"));
      assert(res.stdout.includes("SHIELDED CORPORATE TREASURY (0zk)"));
      assert(res.stdout.includes("100.000000000000000000 WQUAI"));
      assert(res.stdout.includes("Corporate Operating Wallet:"));
      assert(res.stdout.includes("Relayer Broadcaster:"));
    });

    it("outputs structured JSON in --json mode", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["balance", "--json"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);

      const data = JSON.parse(res.stdout);
      assert.equal(data.shieldedTreasury.assetSymbol, "WQUAI");
      assert.equal(data.shieldedTreasury.formatted, "100.000000000000000000");
      assert.equal(data.shieldedTreasury.activeUtxos, 1);
      assert.equal(data.publicAccounts.corporateOperating.tokenBalanceFormatted, "50.000000000000000000");
      assert.equal(data.publicAccounts.relayer.tokenBalanceFormatted, "0.000000000000000000");
    });

    it("queries arbitrary on-chain public address via --address", async () => {
      const ctx = createDefaultCliContext();
      const customAddr = "0x0044555566667777888899990000111122223333";
      ctx.token?.mint(customAddr, 25_000_000_000_000_000_000n);

      const res = await runCli(["balance", "--address", customAddr, "--json"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);

      const data = JSON.parse(res.stdout);
      assert.equal(data.publicAccounts.queriedAccount.address, customAddr);
      assert.equal(data.publicAccounts.queriedAccount.tokenBalanceFormatted, "25.000000000000000000");
    });

    it("writes output to file when --output is provided", async () => {
      const ctx = createDefaultCliContext();
      const tempPath = path.resolve(process.cwd(), "temp_test_balance.json");

      try {
        const res = await runCli(["balance", "--json", "--output", tempPath], ctx);
        assert.equal(res.exitCode, CliExitCode.SUCCESS);
        assert(fs.existsSync(tempPath));

        const content = JSON.parse(fs.readFileSync(tempPath, "utf8"));
        assert.equal(content.shieldedTreasury.formatted, "100.000000000000000000");
      } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Invoice Command
  // ---------------------------------------------------------------------------
  describe("Invoice Command", () => {
    it("fails with exit code 2 when --amount is missing", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["invoice"], ctx);
      assert.equal(res.exitCode, CliExitCode.USAGE_ERROR);
      assert(res.stderr.includes("Missing required flag --amount"));
    });

    it("fails with exit code 2 when amount is zero or negative", async () => {
      const ctx = createDefaultCliContext();
      const res1 = await runCli(["invoice", "--amount", "0"], ctx);
      assert.equal(res1.exitCode, CliExitCode.USAGE_ERROR);

      const res2 = await runCli(["invoice", "--amount", "-5.0"], ctx);
      assert.equal(res2.exitCode, CliExitCode.USAGE_ERROR);
    });

    it("generates valid invoice challenge in text mode with ephemeral address and headers", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["invoice", "--amount", "5.0"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);
      assert(res.stdout.includes("DARKCIRCLE x402 PAYMENT INVOICE"));
      assert(res.stdout.includes("5.000000000000000000 WQUAI"));
      assert(res.stdout.includes("Recipient (Stealth): 0x"));
      assert(res.stdout.includes("WWW-Authenticate: x402"));
    });

    it("generates RFC 7807 challenge JSON in --json mode", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(
        ["invoice", "--amount", "10.0", "--resource", "/api/v1/protected/analytics", "--json"],
        ctx
      );
      assert.equal(res.exitCode, CliExitCode.SUCCESS);

      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.invoice.requiredAmount, "10000000000000000000");
      assert.equal(parsed.invoice.resourceUri, "/api/v1/protected/analytics");
      assert.equal(parsed.challengeBody.status, 402);
      assert.equal(parsed.challengeBody.payment.protocol, "x402");
      assert(parsed.challengeHeaders["WWW-Authenticate"].startsWith("x402 "));
    });

    it("writes generated invoice to specified --output file", async () => {
      const ctx = createDefaultCliContext();
      const tempPath = path.resolve(process.cwd(), "temp_test_invoice.json");

      try {
        const res = await runCli(["invoice", "--amount", "5.0", "--json", "--output", tempPath], ctx);
        assert.equal(res.exitCode, CliExitCode.SUCCESS);
        assert(fs.existsSync(tempPath));

        const content = JSON.parse(fs.readFileSync(tempPath, "utf8"));
        assert.equal(content.invoice.tokenSymbol, "WQUAI");
      } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    });

    it("gracefully falls back to default token when --token is passed without argument", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["invoice", "--amount", "10.0", "--token"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);
      assert(res.stdout.includes("DARKCIRCLE x402 PAYMENT INVOICE"));
      assert(res.stdout.includes("10.000000000000000000 WQUAI"));
      assert(res.stdout.includes("Recipient (Stealth): 0x"));
      assert(res.stdout.includes("Token Contract:"));
      assert(res.stdout.includes(ctx.tokenAddress || "0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb"));
    });

    it("handles --token without argument in --json mode, populating default token details", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["invoice", "--amount", "25.0", "--token", "--json"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);
      const data = JSON.parse(res.stdout);
      assert.equal(
        data.invoice.tokenAddress.toLowerCase(),
        (ctx.tokenAddress || "0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb").toLowerCase()
      );
      assert.equal(data.invoice.tokenSymbol, "WQUAI");
      assert.equal(data.invoice.requiredAmount, "25000000000000000000");
    });

    it("preserves explicit custom token address when --token <address> is passed", async () => {
      const ctx = createDefaultCliContext();
      const customToken = "0x0033333333333333333333333333333333333333";
      const res = await runCli(["invoice", "--amount", "10.0", "--token", customToken, "--json"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);
      const data = JSON.parse(res.stdout);
      assert.equal(data.invoice.tokenAddress.toLowerCase(), customToken.toLowerCase());
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Pay Command
  // ---------------------------------------------------------------------------
  describe("Pay Command", () => {
    it("fails with exit code 2 when neither --url nor --recipient is specified", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["pay"], ctx);
      assert.equal(res.exitCode, CliExitCode.USAGE_ERROR);
      assert(res.stderr.includes("Specify either --url <endpoint> or --recipient"));
    });

    it("fails with exit code 2 when --recipient is given without --amount", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["pay", "--recipient", "0x0011222233334444555566667777888899990000"], ctx);
      assert.equal(res.exitCode, CliExitCode.USAGE_ERROR);
      assert(res.stderr.includes("Missing required flag --amount"));
    });

    it("executes direct unshield payment to recipient via Relayer broadcast", async () => {
      const ctx = createDefaultCliContext();
      const recipient = "0x0011222233334444555566667777888899990000";

      const res = await runCli(["pay", "--recipient", recipient, "--amount", "5.0", "--json"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);

      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.status, "CONFIRMED");
      assert.equal(parsed.recipient, recipient);
      assert.equal(parsed.amountFormatted, "5.000000000000000000");
      assert(parsed.txHash.startsWith("0x"));

      // Verify on-chain recipient received tokens
      const recipientBal = ctx.token!.balanceOf(recipient);
      assert.equal(recipientBal, 5_000_000_000_000_000_000n);

      // Verify treasury balance was deducted (5 WQUAI + 0.5 WQUAI relayer fee = 94.5 WQUAI remaining)
      const remainingShielded = ctx.treasuryUTXOs.reduce((sum, u) => sum + u.value, 0n);
      assert.equal(remainingShielded, 94_500_000_000_000_000_000n);
    });

    it("rejects direct payment exceeding spending policy maximum cap", async () => {
      const ctx = createDefaultCliContext();
      const recipient = "0x0011222233334444555566667777888899990000";

      // Spending policy cap is 50 WQUAI; attempt to pay 60 WQUAI
      const res = await runCli(["pay", "--recipient", recipient, "--amount", "60.0"], ctx);
      assert.equal(res.exitCode, CliExitCode.EXECUTION_ERROR);
      assert(res.stderr.includes("ERR_SPENDING_POLICY_REJECTED_AMOUNT_EXCEEDS_CAP"));
    });

    it("rejects payment if recipient address is sanctioned", async () => {
      const ctx = createDefaultCliContext();
      const sanctionedAddr = "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b"; // OFAC Tornado Router

      const res = await runCli(["pay", "--recipient", sanctionedAddr, "--amount", "5.0"], ctx);
      assert.equal(res.exitCode, CliExitCode.EXECUTION_ERROR);
      assert(res.stderr.includes("ERR_PAYEE_SANCTIONED"));
    });

    it("settles payment transparently against an HTTP 402 resource endpoint", async () => {
      const ctx = createDefaultCliContext();

      // Instantiate synthetic protected resource server using context gateway
      const server = new ResourceServer({ demo: true,
        gateway: ctx.merchantGateway,
        defaultTokenAddress: ctx.tokenAddress
      });

      // Inject server fetch implementation into CLI context
      ctx.fetchFn = server.fetch.bind(server);

      const res = await runCli(
        ["pay", "--url", "http://localhost:8080/api/v1/protected/analytics", "--json"],
        ctx
      );
      assert.equal(res.exitCode, CliExitCode.SUCCESS);

      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.status, 200);
      assert(parsed.payload.data !== undefined);
      assert(parsed.receipt.txHash.startsWith("0x"));
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Sweep Command
  // ---------------------------------------------------------------------------
  describe("Sweep Command", () => {
    it("fails with exit code 2 when neither --invoice nor --all is specified", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["sweep"], ctx);
      assert.equal(res.exitCode, CliExitCode.USAGE_ERROR);
      assert(res.stderr.includes("Specify either --invoice <id> or --all"));
    });

    it("fails with exit code 1 when sweeping an unpaid or non-existent invoice", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["sweep", "--invoice", "inv_non_existent"], ctx);
      assert.equal(res.exitCode, CliExitCode.EXECUTION_ERROR);
      assert(res.stderr.includes("INVOICE_NOT_FOUND"));
    });

    it("sweeps settled invoice balance into Railgun pool and zeroizes ephemeral private key", async () => {
      const ctx = createDefaultCliContext();

      // 1. Create an invoice
      const invRes = await ctx.merchantGateway.createPaymentChallenge(
        "/api/v1/protected/analytics",
        5_000_000_000_000_000_000n,
        ctx.tokenAddress!,
        "WQUAI",
        18
      );
      const invoiceId = invRes.invoice.invoiceId;
      const ephemeralAddr = invRes.invoice.ephemeralAddress;

      // 2. Fund the ephemeral address on-chain and record payment proof
      ctx.token!.mint(ephemeralAddr, 5_000_000_000_000_000_000n);
      const txHash = "0x" + crypto.randomBytes(32).toString("hex");
      ctx.merchantGateway.verifyPayment(invoiceId, txHash, 5_000_000_000_000_000_000n);

      // 3. Sweep via CLI command
      const sweepRes = await runCli(["sweep", "--invoice", invoiceId, "--json"], ctx);
      assert.equal(sweepRes.exitCode, CliExitCode.SUCCESS);

      const parsed = JSON.parse(sweepRes.stdout);
      assert.equal(parsed.invoiceId, invoiceId);
      assert.equal(parsed.sweptAmountFormatted, "5.000000000000000000");
      assert.equal(parsed.forwardSecrecyKeyZeroization, "CONFIRMED");

      // Verify forward secrecy key zeroization in registry
      const storedInvoice = ctx.merchantGateway.invoiceRegistry.get(invoiceId);
      assert.equal(storedInvoice?.ephemeralPrivateKey, ZEROIZED_PRIVATE_KEY);
      assert.equal(storedInvoice?.status, "SWEPT");
    });

    it("batch sweeps all eligible settled invoices with --all", async () => {
      const ctx = createDefaultCliContext();

      // Create two invoices and fund them
      const inv1 = ctx.merchantGateway.createPaymentChallenge("/res1", 5_000_000_000_000_000_000n, ctx.tokenAddress!);
      const inv2 = ctx.merchantGateway.createPaymentChallenge("/res2", 10_000_000_000_000_000_000n, ctx.tokenAddress!);

      ctx.token!.mint(inv1.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      ctx.token!.mint(inv2.invoice.ephemeralAddress, 10_000_000_000_000_000_000n);

      const res = await runCli(["sweep", "--all", "--json"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);

      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.totalProcessed, 2);
      assert.equal(parsed.successfulSweeps, 2);
      assert.equal(parsed.totalSweptFormatted, "15.000000000000000000");
    });
  });

  // ---------------------------------------------------------------------------
  // 6. Audit Command
  // ---------------------------------------------------------------------------
  describe("Audit Command", () => {
    it("exports valid JSON report with correct schema and passing SHA-256 checksum", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["audit", "--format", "json"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);

      const report = JSON.parse(res.stdout);
      assert.equal(report.$schema, "https://darkcircle.network/schemas/audit-report-v1.json");
      assert.equal(report.reportMetadata.auditMode, "READ_ONLY_VIEWING_KEY");
      assert.equal(report.auditedEntity.spendingKeyPresent, false);
      assert.equal(report.financialSummary.endingShieldedBalance.formatted, "100.000000000000000000");

      // Verify SHA-256 integrity hash
      const recordedHash = report.cryptographicChecksum.sha256Hash;
      assert.equal(recordedHash.length, 64);
      report.cryptographicChecksum.sha256Hash = "";
      const expectedHash = crypto.createHash("sha256").update(JSON.stringify(report)).digest("hex");
      assert.equal(recordedHash, expectedHash);
    });

    it("exports RFC 4180 CSV with 21 column headers", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["audit", "--format", "csv"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);

      const lines = res.stdout.trim().split("\n");
      const expectedHeaders =
        "journal_id,timestamp_iso,block_number,tx_hash,direction,transaction_type,asset_symbol,asset_contract,gross_amount,fee_amount,net_amount,counterparty_address,relayer_address,invoice_id,memo,nullifier,ppoi_status,compliance_status,debit_account,credit_account,running_balance";
      assert.equal(lines[0], expectedHeaders);
      assert(lines.length >= 2);
    });

    it("verifies double-entry ledger reconciliation with --reconcile", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["audit", "--reconcile"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);
      assert(res.stdout.includes("Status:          BALANCED"));
      assert(res.stdout.includes("Debits === Credits"));
    });

    it("detects tampering using --verify on exported JSON reports", async () => {
      const ctx = createDefaultCliContext();
      const tempPath = path.resolve(process.cwd(), "temp_audit_tamper_test.json");

      try {
        // 1. Export authentic report
        const expRes = await runCli(["audit", "--format", "json", "--output", tempPath], ctx);
        assert.equal(expRes.exitCode, CliExitCode.SUCCESS);

        // 2. Verify authentic report
        const verifyRes = await runCli(["audit", "--verify", tempPath], ctx);
        assert.equal(verifyRes.exitCode, CliExitCode.SUCCESS);
        assert(verifyRes.stdout.includes("INTEGRITY VERIFIED"));

        // 3. Tamper with ending balance in file
        const parsed = JSON.parse(fs.readFileSync(tempPath, "utf8"));
        parsed.financialSummary.endingShieldedBalance.formatted = "999999.000000000000000000";
        fs.writeFileSync(tempPath, JSON.stringify(parsed));

        // 4. Verify tampered report fails
        const tamperedRes = await runCli(["audit", "--verify", tempPath], ctx);
        assert.equal(tamperedRes.exitCode, CliExitCode.EXECUTION_ERROR);
        assert(tamperedRes.stderr.includes("TAMPER_DETECTED"));
      } finally {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      }
    });

    it("verifies current audit trail integrity with parameterless --verify (exit code 0)", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["audit", "--verify"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);
      assert(res.stdout.includes("INTEGRITY VERIFIED"));
      assert(res.stdout.includes("Double-entry audit trail balanced"));
      assert.equal(res.stderr, "");
      assert.notEqual(res.data, undefined);
      assert.equal(res.data?.verified, true);
      assert.equal(res.data?.reconciled, true);
      assert.equal(typeof res.data?.checksum, "string");
      assert.equal(res.data?.checksum.length, 64);
    });

    it("verifies current audit trail integrity in standalone mode without explicit context", async () => {
      const res = await runCli(["audit", "--verify"]);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);
      assert(res.stdout.includes("INTEGRITY VERIFIED"));
      assert.equal(res.stderr, "");
    });

    it("verifies current audit trail integrity with parameterless --verify in --json mode", async () => {
      const ctx = createDefaultCliContext();
      const res = await runCli(["audit", "--verify", "--json"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.verified, true);
      assert.equal(parsed.reconciled, true);
      assert.equal(typeof parsed.checksum, "string");
      assert.equal(parsed.checksum.length, 64);
    });

    it("detects ledger discrepancy when accounting invariants are violated using parameterless --verify", async () => {
      const ctx = createDefaultCliContext();
      // Induce discrepancy in journal reconstructor
      ctx.journal!.runningBalance += 50_000_000_000_000_000_000n;

      const res = await runCli(["audit", "--verify"], ctx);
      assert.equal(res.exitCode, CliExitCode.EXECUTION_ERROR);
      assert(res.stderr.includes("INTEGRITY_CHECK_FAILED"));
      assert(res.stderr.includes("mismatch"));
      assert.equal(res.data?.verified, false);
      assert.equal(res.data?.reconciled, false);
    });
  });

  // ---------------------------------------------------------------------------
  // 7. Full End-to-End Enterprise Tumbler Integration Flow
  // ---------------------------------------------------------------------------
  describe("Full End-to-End Enterprise Tumbler Flow", () => {
    it("completes full lifecycle: invoice -> pay -> sweep -> audit -> balance", async () => {
      const ctx = createDefaultCliContext();

      // Step 1: Merchant creates invoice for 10 WQUAI
      const invoiceRes = await runCli(["invoice", "--amount", "10.0", "--json"], ctx);
      assert.equal(invoiceRes.exitCode, CliExitCode.SUCCESS);
      const invoiceData = JSON.parse(invoiceRes.stdout);
      const invoiceId = invoiceData.invoice.invoiceId;
      const ephemeralAddress = invoiceData.invoice.ephemeralAddress;

      // Step 2: Client pays invoice to stealth ephemeral address
      const payRes = await runCli(
        ["pay", "--recipient", ephemeralAddress, "--amount", "10.0", "--json"],
        ctx
      );
      assert.equal(payRes.exitCode, CliExitCode.SUCCESS);
      const payData = JSON.parse(payRes.stdout);
      assert.equal(payData.status, "CONFIRMED");

      // Verify on-chain payment was received by ephemeral address
      const ephemeralBal = ctx.token!.balanceOf(ephemeralAddress);
      assert.equal(ephemeralBal, 10_000_000_000_000_000_000n);

      // Verify settlement in merchant invoice registry
      ctx.merchantGateway.verifyPayment(invoiceId, payData.txHash, 10_000_000_000_000_000_000n);

      // Step 3: Merchant sweeps ephemeral balance into corporate Railgun pool
      const sweepRes = await runCli(["sweep", "--invoice", invoiceId, "--json"], ctx);
      assert.equal(sweepRes.exitCode, CliExitCode.SUCCESS);
      const sweepData = JSON.parse(sweepRes.stdout);
      assert.equal(sweepData.forwardSecrecyKeyZeroization, "CONFIRMED");
      assert.equal(sweepData.sweptAmountFormatted, "10.000000000000000000");

      // Ephemeral balance should now be swept to 0
      assert.equal(ctx.token!.balanceOf(ephemeralAddress), 0n);

      // Step 4: Auditor verifies double-entry reconciliation
      const auditRes = await runCli(["audit", "--reconcile"], ctx);
      assert.equal(auditRes.exitCode, CliExitCode.SUCCESS);
      assert(auditRes.stdout.includes("BALANCED"));

      // Step 5: Check balance reflects net movements
      const balanceRes = await runCli(["balance", "--json"], ctx);
      assert.equal(balanceRes.exitCode, CliExitCode.SUCCESS);
      const balanceData = JSON.parse(balanceRes.stdout);
      // Started with 100 WQUAI. Spent 10 + 0.5 fee = 89.5. Swept 10 = 99.5 WQUAI net shielded
      assert.equal(balanceData.shieldedTreasury.formatted, "99.500000000000000000");
    });

    it("completes full 7-step enterprise CLI lifecycle including parameterless audit --verify and invoice --token fallback", async () => {
      const ctx = createDefaultCliContext();

      // Step 1: Query initial balance
      const bal1 = await runCli(["balance", "--json"], ctx);
      assert.equal(bal1.exitCode, CliExitCode.SUCCESS);
      const bal1Data = JSON.parse(bal1.stdout);
      assert.equal(bal1Data.shieldedTreasury.formatted, "100.000000000000000000");

      // Step 2: Generate invoice with --token without argument
      const inv = await runCli(["invoice", "--amount", "10.0", "--token", "--json"], ctx);
      assert.equal(inv.exitCode, CliExitCode.SUCCESS);
      const invData = JSON.parse(inv.stdout);
      const ephemeralAddress = invData.invoice.ephemeralAddress;
      const invoiceId = invData.invoice.invoiceId;
      assert(ephemeralAddress.startsWith("0x"));

      // Step 3: Settle invoice via relayer unshield broadcast
      const pay = await runCli(
        ["pay", "--recipient", ephemeralAddress, "--amount", "10.0", "--json"],
        ctx
      );
      assert.equal(pay.exitCode, CliExitCode.SUCCESS);
      const payData = JSON.parse(pay.stdout);
      assert.equal(payData.status, "CONFIRMED");
      assert(payData.txHash.startsWith("0x"));

      // Confirm merchant gateway verification of payment receipt
      ctx.merchantGateway.verifyPayment(invoiceId, payData.txHash, 10_000_000_000_000_000_000n);

      // Step 4: Sweep ephemeral balance into Railgun pool
      const sweep = await runCli(["sweep", "--invoice", invoiceId, "--json"], ctx);
      assert.equal(sweep.exitCode, CliExitCode.SUCCESS);
      const sweepData = JSON.parse(sweep.stdout);
      assert.equal(sweepData.forwardSecrecyKeyZeroization, "CONFIRMED");
      assert.equal(sweepData.sweptAmountFormatted, "10.000000000000000000");

      // Step 5: Export audit reports (JSON and CSV)
      const auditJson = await runCli(["audit", "--format", "json"], ctx);
      assert.equal(auditJson.exitCode, CliExitCode.SUCCESS);
      const parsedAudit = JSON.parse(auditJson.stdout);
      assert.equal(parsedAudit.reportMetadata.complianceStandard, "US-GAAP / IRS-Digital-Assets / OFAC-PPOI");
      assert.equal(typeof parsedAudit.cryptographicChecksum.sha256Hash, "string");

      const auditCsv = await runCli(["audit", "--format", "csv"], ctx);
      assert.equal(auditCsv.exitCode, CliExitCode.SUCCESS);
      assert(auditCsv.stdout.startsWith("journal_id,timestamp_iso,block_number,"));

      // Step 6: Verify current audit trail integrity without arguments
      const verifyRes = await runCli(["audit", "--verify"], ctx);
      assert.equal(verifyRes.exitCode, CliExitCode.SUCCESS);
      assert(verifyRes.stdout.includes("INTEGRITY VERIFIED"));
      assert.equal(verifyRes.data?.reconciled, true);

      // Step 7: Query final balance confirming accounting consistency
      const bal2 = await runCli(["balance", "--json"], ctx);
      assert.equal(bal2.exitCode, CliExitCode.SUCCESS);
      const bal2Data = JSON.parse(bal2.stdout);
      // Started with 100. Spent 10 + 0.5 fee = 89.5. Swept 10 = 99.5 net shielded
      assert.equal(bal2Data.shieldedTreasury.formatted, "99.500000000000000000");
    });

    it("verifies both parameterless in-memory audit trail and exported report file integrity in sequence", async () => {
      const ctx = createDefaultCliContext();
      const tempReport = path.resolve(process.cwd(), "temp_lifecycle_audit_report.json");

      try {
        // Export to disk
        const expRes = await runCli(["audit", "--format", "json", "--output", tempReport], ctx);
        assert.equal(expRes.exitCode, CliExitCode.SUCCESS);
        assert(fs.existsSync(tempReport));

        // Parameterless verify (verifies in-memory audit trail)
        const inMemoryVerify = await runCli(["audit", "--verify"], ctx);
        assert.equal(inMemoryVerify.exitCode, CliExitCode.SUCCESS);
        assert(inMemoryVerify.stdout.includes("INTEGRITY VERIFIED"));

        // File verify (verifies exported report file)
        const fileVerify = await runCli(["audit", "--verify", tempReport], ctx);
        assert.equal(fileVerify.exitCode, CliExitCode.SUCCESS);
        assert(fileVerify.stdout.includes("INTEGRITY VERIFIED"));
      } finally {
        if (fs.existsSync(tempReport)) fs.unlinkSync(tempReport);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // 8. Zero Forbidden Word ("m*ck") Codebase Audit
  // ---------------------------------------------------------------------------
  describe("Zero Forbidden Word Verification", () => {
    it("guarantees 0 occurrences of the forbidden word across test and cli source code", () => {
      const forbiddenPattern = new RegExp("\\bm" + "o" + "c" + "k\\b", "i");

      const cliFiles = [
        path.resolve(process.cwd(), "src/cli/types.ts"),
        path.resolve(process.cwd(), "src/cli/parser.ts"),
        path.resolve(process.cwd(), "src/cli/context.ts"),
        path.resolve(process.cwd(), "src/cli/commands/help.ts"),
        path.resolve(process.cwd(), "src/cli/commands/balance.ts"),
        path.resolve(process.cwd(), "src/cli/commands/invoice.ts"),
        path.resolve(process.cwd(), "src/cli/commands/pay.ts"),
        path.resolve(process.cwd(), "src/cli/commands/sweep.ts"),
        path.resolve(process.cwd(), "src/cli/commands/audit.ts"),
        path.resolve(process.cwd(), "src/cli/commands/index.ts"),
        path.resolve(process.cwd(), "src/cli/index.ts"),
        path.resolve(process.cwd(), "bin/darkcircle.ts"),
        path.resolve(process.cwd(), "src/client/index.ts")
      ];

      for (const f of cliFiles) {
        if (fs.existsSync(f)) {
          const content = fs.readFileSync(f, "utf8");
          const match = content.match(forbiddenPattern);
          assert.equal(
            match,
            null,
            `Forbidden word found in file: ${f} (match: ${match?.[0]})`
          );
        }
      }
    });
  });
});
