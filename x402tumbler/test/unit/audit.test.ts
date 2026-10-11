import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { deriveCorporateKeyHierarchy } from "../../src/audit/keys.ts";
import {
  encryptNotePayload,
  decryptNotePayload,
  TransactionDiscoveryScanner
} from "../../src/audit/decryptor.ts";
import { AccountingJournalReconstructor } from "../../src/audit/accounting.ts";
import {
  exportJsonAuditReport,
  exportCsvAuditSheet,
  formatDecimals
} from "../../src/audit/exporter.ts";
import { isOnCurve, BABYJUBJUB_L } from "../../src/crypto/babyjubjub.ts";
import type { DecryptedNotePayload } from "../../src/types/audit.ts";

describe("Milestone 1 Unit Tests: Corporate Viewing-Key Audit Engine", () => {
  describe("Key Separation & Derivation", () => {
    it("derives one-way isolated spending and viewing keys from seed", () => {
      const seed = crypto.randomBytes(32);
      const keys = deriveCorporateKeyHierarchy(seed);

      assert.notEqual(keys.masterSpendingKey, keys.masterViewingKey);
      assert(keys.masterSpendingKey > 0n && keys.masterSpendingKey < BABYJUBJUB_L);
      assert(keys.masterViewingKey > 0n && keys.masterViewingKey < BABYJUBJUB_L);

      assert.equal(isOnCurve(keys.spendingPublicKey), true);
      assert.equal(isOnCurve(keys.viewingPublicKey), true);

      assert(keys.corporate0zkAddress.startsWith("0zk1q_"));

      // Viewing key token contains only vsk, never ssk
      const tokenJson = JSON.parse(
        Buffer.from(keys.viewingKeyToken, "base64url").toString("utf8")
      );
      assert.equal(tokenJson.spendingKeyIncluded, false);
      assert.equal(tokenJson.permission, "READ_ONLY_AUDIT");
      assert.equal(tokenJson.vsk, "0x" + keys.masterViewingKey.toString(16).padStart(64, "0"));
      assert.equal(tokenJson.ssk, undefined);
    });
  });

  describe("Note Encryption & Decryption Roundtrip", () => {
    it("encrypts with viewing public key and decrypts with viewing private key", () => {
      const seed = crypto.randomBytes(32);
      const keys = deriveCorporateKeyHierarchy(seed);

      const payload: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "25000000000000000000", // 25 WQUAI
        blinding: "0x1234567890abcdef",
        npk: "0xabcdef1234567890",
        direction: "INBOUND_SWEEP",
        counterparty: "0xCustomerClient402",
        invoiceId: "inv_metered_ai_123",
        memo: "AI Inference Invoice Payment",
        timestamp: 1726580000
      };

      const encrypted = encryptNotePayload(keys.viewingPublicKey, payload);
      assert(encrypted.ciphertext.length > 0);
      assert.equal(encrypted.authTag.length, 32); // 16 bytes = 32 hex chars
      assert.equal(encrypted.nonce.length, 24); // 12 bytes = 24 hex chars

      const decrypted = decryptNotePayload(keys.masterViewingKey, encrypted);
      assert.notEqual(decrypted, null);
      assert.deepEqual(decrypted, payload);
    });

    it("returns null when decrypting with foreign viewing key", () => {
      const keysAlice = deriveCorporateKeyHierarchy(crypto.randomBytes(32));
      const keysBob = deriveCorporateKeyHierarchy(crypto.randomBytes(32));

      const payload: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "10000000000000000000",
        blinding: "0x9876543210",
        npk: "0x1122334455",
        direction: "INBOUND_SHIELD",
        counterparty: "0xAlice",
        timestamp: 1726580000
      };

      const encryptedForAlice = encryptNotePayload(keysAlice.viewingPublicKey, payload);
      // Bob attempts to decrypt Alice's note
      const bobDecrypted = decryptNotePayload(keysBob.masterViewingKey, encryptedForAlice);
      assert.equal(bobDecrypted, null);
    });

    it("returns null on ciphertext or MAC tampering", () => {
      const keys = deriveCorporateKeyHierarchy(crypto.randomBytes(32));
      const payload: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "5000000000000000000",
        blinding: "0xabc",
        npk: "0xdef",
        direction: "INBOUND_SHIELD",
        counterparty: "0xPayer",
        timestamp: 1726580000
      };

      const encrypted = encryptNotePayload(keys.viewingPublicKey, payload);

      // Tamper ciphertext
      const tamperedCipher =
        encrypted.ciphertext.slice(0, 2) === "00"
          ? "ff" + encrypted.ciphertext.slice(2)
          : "00" + encrypted.ciphertext.slice(2);
      const tamperedEnc = { ...encrypted, ciphertext: tamperedCipher };
      assert.equal(decryptNotePayload(keys.masterViewingKey, tamperedEnc), null);

      // Tamper auth tag
      const tamperedTag =
        encrypted.authTag.slice(0, 2) === "00"
          ? "ff" + encrypted.authTag.slice(2)
          : "00" + encrypted.authTag.slice(2);
      const tamperedTagEnc = { ...encrypted, authTag: tamperedTag };
      assert.equal(decryptNotePayload(keys.masterViewingKey, tamperedTagEnc), null);
    });

    it("scans and discovers only notes intended for viewing key", () => {
      const keysCorp = deriveCorporateKeyHierarchy(crypto.randomBytes(32));
      const keysOther = deriveCorporateKeyHierarchy(crypto.randomBytes(32));

      const payload1: DecryptedNotePayload = {
        version: 1,
        token: "0xUSDC",
        value: "100",
        blinding: "0x1",
        npk: "0x1",
        direction: "INBOUND_SHIELD",
        counterparty: "0xP1",
        timestamp: 100
      };
      const payload2: DecryptedNotePayload = {
        version: 1,
        token: "0xUSDC",
        value: "200",
        blinding: "0x2",
        npk: "0x2",
        direction: "INBOUND_SWEEP",
        counterparty: "0xP2",
        timestamp: 200
      };

      const encCorp = encryptNotePayload(keysCorp.viewingPublicKey, payload1);
      const encOther = encryptNotePayload(keysOther.viewingPublicKey, payload2);

      const scanner = new TransactionDiscoveryScanner(keysCorp.masterViewingKey);
      const discovered = scanner.scan([
        { commitment: "0xcomm1", txHash: "0xtx1", blockNumber: 1, encrypted: encCorp },
        { commitment: "0xcomm2", txHash: "0xtx2", blockNumber: 2, encrypted: encOther }
      ]);

      assert.equal(discovered.length, 1);
      assert.equal(discovered[0].commitment, "0xcomm1");
      assert.equal(discovered[0].payload.value, "100");
    });
  });

  describe("Double-Entry Accounting Journal & Reconciliation", () => {
    it("executes full treasury lifecycle and verifies mathematical reconciliation", () => {
      const reconstructor = new AccountingJournalReconstructor("0zk1q_corporate_treasury");

      // 1. Inbound Treasury Shield Deposit: 100.0 WQUAI (100,000,000 atomic)
      const note1: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "100000000000000000000",
        blinding: "0xrho1",
        npk: "0xnpk1",
        direction: "INBOUND_SHIELD",
        counterparty: "0xCorpMainWallet",
        memo: "Treasury Seeding",
        timestamp: 1726580000
      };
      const entry1 = reconstructor.recordInbound("0xtx1", 100, "0xcomm1", note1);
      assert.equal(entry1.debitAmount, entry1.creditAmount);
      assert.equal(reconstructor.runningBalance, 100_000_000_000_000_000_000n);
      assert.equal(reconstructor.verifyReconciliation(), true);

      // 2. Inbound Sweep Revenue: 25.0 WQUAI (25,000,000 atomic)
      const note2: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "25000000000000000000",
        blinding: "0xrho2",
        npk: "0xnpk1",
        direction: "INBOUND_SWEEP",
        counterparty: "0xClientPayee",
        invoiceId: "inv_ai_query_999",
        memo: "Client Metered Inference",
        timestamp: 1726580600
      };
      const entry2 = reconstructor.recordInbound("0xtx2", 101, "0xcomm2", note2);
      assert.equal(entry2.debitAmount, entry2.creditAmount);
      assert.equal(reconstructor.runningBalance, 125_000_000_000_000_000_000n);
      assert.equal(reconstructor.verifyReconciliation(), true);

      // 3. Outbound Unshield: Spend note1 (100 WQUAI) to pay vendor 10.0 WQUAI (10,000,000)
      //    + 0.5 WQUAI (500,000) relayer fee, generating change note of 89.5 WQUAI (89,500,000)
      const changeNote: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "89500000000000000000",
        blinding: "0xrhoChange",
        npk: "0xnpk1",
        direction: "OUTBOUND_CHANGE",
        counterparty: "0zk1q_corporate_treasury",
        memo: "Unshield Change",
        timestamp: 1726581200
      };
      const entry3 = reconstructor.recordOutboundUnshield(
        "0xtx3",
        102,
        1726581200,
        "0xnullifier1",
        "0xcomm1",
        "0xMerchantVendor402",
        10_000_000_000_000_000_000n,
        500_000_000_000_000_000n,
        "0xRelayerBroadcaster",
        "0xcomm3_change",
        changeNote,
        "inv_vendor_gpu_hours",
        "GPU Cluster Invoice Payment"
      );
      assert.equal(entry3.debitAmount, entry3.creditAmount);
      assert.equal(reconstructor.runningBalance, 114_500_000_000_000_000_000n);

      // Verify reconciliation
      assert.equal(reconstructor.verifyReconciliation(), true);
      assert.equal(reconstructor.getActiveUtxoBalance(), 114_500_000_000_000_000_000n);

      // Check spent status
      assert.equal(reconstructor.utxoMap.get("0xcomm1")?.status, "SPENT");
      assert.equal(reconstructor.utxoMap.get("0xcomm2")?.status, "UNSPENT");
      assert.equal(reconstructor.utxoMap.get("0xcomm3_change")?.status, "UNSPENT");
    });
  });

  describe("JSON & CSV Exporters", () => {
    it("exports valid JSON audit report conforming to schema with SHA-256 checksum", () => {
      const reconstructor = new AccountingJournalReconstructor("0zk1q_corporate_treasury");
      const note: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "50000000000000000000",
        blinding: "0x123",
        npk: "0x456",
        direction: "INBOUND_SHIELD",
        counterparty: "0xTreasury",
        timestamp: 1726580000
      };
      reconstructor.recordInbound("0xtx1", 100, "0xcomm1", note);

      const jsonStr = exportJsonAuditReport(reconstructor);
      const parsed = JSON.parse(jsonStr);

      assert.equal(parsed.$schema, "https://darkcircle.network/schemas/audit-report-v1.json");
      assert.equal(parsed.auditedEntity.corporate0zkAddress, "0zk1q_corporate_treasury");
      assert.equal(parsed.auditedEntity.spendingKeyPresent, false);
      assert.equal(parsed.financialSummary.endingShieldedBalance.formatted, "50.000000000000000000");
      assert.equal(parsed.cryptographicChecksum.algorithm, "SHA-256");
      assert(parsed.cryptographicChecksum.sha256Hash.length === 64);
    });

    it("exports RFC 4180 compliant CSV audit sheet with proper escaping", () => {
      const reconstructor = new AccountingJournalReconstructor("0zk1q_corporate_treasury");
      const note: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "10000000000000000000",
        blinding: "0x123",
        npk: "0x456",
        direction: "INBOUND_SWEEP",
        counterparty: "0xClient",
        invoiceId: "inv_special_1",
        memo: 'Payment, with comma and "quotes"',
        timestamp: 1726580000
      };
      reconstructor.recordInbound("0xtx1", 100, "0xcomm1", note);

      const csv = exportCsvAuditSheet(reconstructor);
      const lines = csv.split("\n");

      assert(lines[0].startsWith("journal_id,timestamp_iso"));
      assert(lines[1].includes('"Payment, with comma and ""quotes"""'));
      assert(lines[1].includes("10.000000000000000000"));
    });

    it("formats decimal strings accurately without floating point rounding errors", () => {
      assert.equal(formatDecimals(10000000n, 6), "10.000000");
      assert.equal(formatDecimals(500000n, 6), "0.500000");
      assert.equal(formatDecimals(1n, 6), "0.000001");
      assert.equal(formatDecimals(0n, 6), "0.000000");
      assert.equal(formatDecimals(-500000n, 6), "-0.500000");
    });
  });
});
