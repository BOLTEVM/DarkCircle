/**
 * DarkCircle Milestone 1 Adversarial Challenge & Stress Test Suite
 * Author: Challenger 2 (Milestone 1)
 *
 * Rigorously challenges:
 * 1. SMT Non-Membership Proof Forgery & SMT Mutation
 * 2. PPOI Engine Root/Key Decoupling & Standby Window Bypass
 * 3. Quarantined Note Spending & Lineage Decoupling
 * 4. Viewing-Key Cryptographic Isolation & Nullifier Non-Equivalence
 * 5. Trial Decryption Tamper Resistance (Bit flips, Corrupted MAC, Off-curve points)
 * 6. Double-Entry Accounting Ledger Invariant Violations (Unbalanced Debits/Credits, Inflation)
 * 7. JSON/CSV Audit Export Integrity & Checksum Tamper Resistance
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

// Cryptographic Core
import { SparseMerkleTree, BN254_PRIME } from "../../src/crypto/smt.ts";
import { poseidon2, poseidon3, poseidon4 } from "../../src/crypto/poseidon.ts";
import { Fp, BN254_SCALAR_FIELD } from "../../src/crypto/field.ts";
import {
  BABYJUBJUB_L,
  BABYJUBJUB_P,
  GENERATOR,
  isOnCurve,
  mod,
  scalarMult,
  addPoints,
  negatePoint
} from "../../src/crypto/babyjubjub.ts";
import { Note } from "../../src/crypto/note.ts";

// PPOI Engine
import {
  SanctionsRegistry,
  OFAC_SANCTIONED_ADDRESSES,
  TESTNET_SANCTIONED_ADDRESSES
} from "../../src/ppoi/sanctionsList.ts";
import { PPOIEngine } from "../../src/ppoi/ppoiEngine.ts";
import { PPOIValidator } from "../../src/ppoi/ppoiValidator.ts";
import type { PPOIProof, UnshieldValidationRequest } from "../../src/types/ppoi.ts";

// Viewing-Key Audit Engine
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
import type { DecryptedNotePayload, EncryptedNotePayload } from "../../src/types/audit.ts";

describe("Milestone 1 Adversarial Challenge Suite (Challenger 2)", () => {
  // =========================================================================
  // Challenge 1: SMT Non-Membership Forgery & Mutation Attacks
  // =========================================================================
  describe("1. SMT Non-Membership Forgery & Mutation Attacks", () => {
    let smt: SparseMerkleTree;
    const sanctionedKey = 0xd90e2f925da726b50c4ed8d0fb90ad053324f31bn;
    const cleanKey = 0x1111111254eeb25477b68fb85ed929f73a960582n;

    beforeEach(() => {
      smt = new SparseMerkleTree(16, poseidon2);
      smt.insert(sanctionedKey, 1n);
    });

    it("SMT-ATK-1: Sanctioned leaf cannot forge non-membership proof by asserting value=0", () => {
      const legitMemProof = smt.createProof(sanctionedKey);
      assert.equal(legitMemProof.value, 1n);
      assert.equal(legitMemProof.isNonMembership, false);

      // Adversary attempts to forge non-membership proof by keeping authentic siblings but flipping value to 0n
      const forgedNonMemProof = {
        ...legitMemProof,
        value: 0n,
        isNonMembership: true
      };

      const verified = smt.verifyProof(forgedNonMemProof);
      assert.equal(verified, false, "SMT verification must reject mutated leaf value");
    });

    it("SMT-ATK-2: Mutating any sibling along the path invalidates the non-membership proof", () => {
      const cleanProof = smt.createProof(cleanKey);
      assert.equal(cleanProof.isNonMembership, true);
      assert.equal(smt.verifyProof(cleanProof), true);

      // Mutate each sibling one by one
      for (let i = 0; i < cleanProof.siblings.length; i++) {
        const tamperedSiblings = [...cleanProof.siblings];
        tamperedSiblings[i] = (tamperedSiblings[i] + 1n) % BN254_PRIME;
        const tamperedProof = { ...cleanProof, siblings: tamperedSiblings };
        assert.equal(
          smt.verifyProof(tamperedProof),
          false,
          `Tampered sibling at index ${i} must fail verification`
        );
      }
    });

    it("SMT-ATK-3: Mutating proof key across occupied branch boundaries causes verification failure", () => {
      const cleanProof = smt.createProof(cleanKey);

      // 1. Substituting the sanctioned key directly fails
      const forgedBadProof = {
        ...cleanProof,
        key: sanctionedKey,
        value: 0n,
        isNonMembership: true
      };
      assert.equal(
        smt.verifyProof(forgedBadProof),
        false,
        "Clean proof siblings cannot be substituted for a sanctioned key"
      );

      // 2. Mutating key bit at level where sibling is non-zero causes verification failure
      const nonZeroLevel = cleanProof.siblings.findIndex((s, idx) => s !== smt.zeros[idx]);
      assert.notEqual(nonZeroLevel, -1, "At least one sibling must be non-zero in non-empty tree");
      const mutatedKey = cleanKey ^ (1n << BigInt(nonZeroLevel));
      const mutatedProof = { ...cleanProof, key: mutatedKey };
      assert.equal(
        smt.verifyProof(mutatedProof),
        false,
        "Mutating key across occupied branch boundary must fail verification"
      );

      // 3. SMT Zero-Symmetry Property: within an all-zero subtree, H(0,0) == H(0,0) so flipping
      // bits within the completely empty subtree yields identical parent zero hashes
      const emptyLevel = cleanProof.siblings.findIndex((s, idx) => s === smt.zeros[idx]);
      if (emptyLevel !== -1) {
        const emptyMutatedKey = cleanKey ^ (1n << BigInt(emptyLevel));
        const emptyMutatedProof = { ...cleanProof, key: emptyMutatedKey };
        assert.equal(
          smt.verifyProof(emptyMutatedProof),
          true,
          "Bit flip within all-zero subtree verifies since both children are empty zeros"
        );
      }
    });


    it("SMT-ATK-4: Truncated or extended siblings array fails verification", () => {
      const cleanProof = smt.createProof(cleanKey);
      const truncatedProof = { ...cleanProof, siblings: cleanProof.siblings.slice(0, 15) };
      assert.equal(smt.verifyProof(truncatedProof), false, "Truncated siblings must fail");

      const extendedProof = { ...cleanProof, siblings: [...cleanProof.siblings, 0n] };
      assert.equal(smt.verifyProof(extendedProof), false, "Extended siblings must fail");
    });

    it("SMT-ATK-5: Sanctions deletion restores non-membership, but historical root rejects new proof", () => {
      const rootBefore = smt.getRoot();
      smt.delete(sanctionedKey);
      const rootAfter = smt.getRoot();
      assert.notEqual(rootBefore, rootAfter);

      // A proof generated after deletion succeeds against rootAfter
      const newProof = smt.createProof(sanctionedKey);
      assert.equal(newProof.isNonMembership, true);
      assert.equal(smt.verifyProof(newProof), true);

      // BUT if an adversary attempts to use the new proof against rootBefore, it fails
      const proofWithOldRoot = { ...newProof, root: rootBefore };
      assert.equal(smt.verifyProof(proofWithOldRoot), false);
    });
  });

  // =========================================================================
  // Challenge 2: PPOI Engine Binding & Root/Key Decoupling Analysis
  // =========================================================================
  describe("2. PPOI Engine Cryptographic Binding & Decoupling Analysis", () => {
    let registry: SanctionsRegistry;
    let ppoiEngine: PPOIEngine;
    const cleanOrigin = "0x0011111254eeb25477b68fb85ed929f73a960582";
    const sanctionedOrigin = "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b";

    beforeEach(() => {
      registry = new SanctionsRegistry(poseidon2, undefined, 16);
      registry.loadDefaultSanctions();
      ppoiEngine = new PPOIEngine(registry, 5000);
    });

    it("PPOI-ATK-1: Engine strictly forbids generating PPOI proof for sanctioned address", () => {
      assert.throws(
        () => ppoiEngine.generateProofOfInnocence(sanctionedOrigin, Date.now() - 10000),
        /PPOI_SANCTIONED_INPUT/
      );
    });

    it("PPOI-ATK-2: Disconnected Root Tamper Test (smtProof.root !== sanctionsRoot)", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);

      // Adversary takes an empty SMT, creates a valid non-membership proof in the empty SMT
      const emptyTree = new SparseMerkleTree(16, poseidon2);
      const fakeProofInEmptyTree = emptyTree.createProof(registry.addressToKey(cleanOrigin));

      // Adversary wraps fakeProof inside a PPOIProof pointing to the authentic sanctionsRoot
      const spoofedProof: PPOIProof = {
        sanctionsRoot: validProof.sanctionsRoot, // Passes check 1: isKnownRoot
        depositOrigin: cleanOrigin,              // Passes check 2: isSanctioned = false
        key: validProof.key,
        smtProof: {
          root: "0x" + fakeProofInEmptyTree.root.toString(16), // Empty tree root!
          key: "0x" + fakeProofInEmptyTree.key.toString(16),
          value: "0x0",
          siblings: fakeProofInEmptyTree.siblings.map(s => "0x" + s.toString(16)),
          isNonMembership: true
        },
        proofTimestamp: Date.now(),
        standbyWindowElapsed: true
      };

      // VULNERABILITY CHECK: If smtProof.root is NOT bound to sanctionsRoot,
      // verifyProofOfInnocence might accept it if smt.verifyProof only checks smtProof.root!
      const result = ppoiEngine.verifyProofOfInnocence(spoofedProof);

      // In a hardened system, spoofedProof MUST be rejected.
      assert.equal(result.isValid, false, "Hardened engine must reject spoofed SMT root");
      assert.equal(result.reason, "PPOI_ROOT_MISMATCH", "Expected PPOI_ROOT_MISMATCH error code");
    });

    it("PPOI-ATK-3: Disconnected Key Tamper Test (smtProof.key !== addressToKey(depositOrigin))", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);

      // Adversary claims depositOrigin is cleanOrigin, but puts a different clean key inside smtProof
      const differentCleanKey = 0x2222222254eeb25477b68fb85ed929f73a960582n;
      const proofForDifferentKey = registry.getTree().createProof(differentCleanKey);

      const mismatchedKeyProof: PPOIProof = {
        ...validProof,
        smtProof: {
          root: "0x" + proofForDifferentKey.root.toString(16),
          key: "0x" + differentCleanKey.toString(16),
          value: "0x0",
          siblings: proofForDifferentKey.siblings.map(s => "0x" + s.toString(16)),
          isNonMembership: true
        }
      };

      const result = ppoiEngine.verifyProofOfInnocence(mismatchedKeyProof);
      assert.equal(result.isValid, false, "Hardened engine must reject mismatched SMT leaf key");
      assert.equal(result.reason, "PPOI_KEY_MISMATCH", "Expected PPOI_KEY_MISMATCH error code");
    });
  });

  // =========================================================================
  // Challenge 3: Standby Window Enforcement & Client-Side Bypass
  // =========================================================================
  describe("3. Standby Window Enforcement & Client-Side Bypass Attacks", () => {
    let registry: SanctionsRegistry;
    let ppoiEngine: PPOIEngine;
    const cleanOrigin = "0x0011111254eeb25477b68fb85ed929f73a960582";
    const merchantAddress = "0x0044444454eeb25477b68fb85ed929f73a960582";

    beforeEach(() => {
      registry = new SanctionsRegistry(poseidon2, undefined, 16);
      registry.loadDefaultSanctions();
      ppoiEngine = new PPOIEngine(registry, 10000); // 10s standby window
    });

    it("SW-1: Unshield to merchant correctly rejected when standby window is active", () => {
      // Just deposited (active standby window)
      const freshDepositTime = Date.now();
      const freshProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, freshDepositTime);
      assert.equal(freshProof.standbyWindowElapsed, false);

      // Attempt withdrawal to external merchant
      const result = ppoiEngine.verifyProofOfInnocence(freshProof, merchantAddress);
      assert.equal(result.isValid, false);
      assert.equal(result.reason, "ERROR_STANDBY_WINDOW_ACTIVE");
    });

    it("SW-2: Withdrawal back to original depositor allowed even when standby window is active", () => {
      const freshDepositTime = Date.now();
      const freshProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, freshDepositTime);
      assert.equal(freshProof.standbyWindowElapsed, false);

      // Refund / return to depositor
      const result = ppoiEngine.verifyProofOfInnocence(freshProof, cleanOrigin);
      assert.equal(result.isValid, true);
    });

    it("SW-ATK-1: Client-Side Mutation Bypass: Setting standbyWindowElapsed=true bypasses time lock", () => {
      // Fresh deposit (0ms elapsed)
      const freshDepositTime = Date.now();
      const freshProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, freshDepositTime);
      assert.equal(freshProof.standbyWindowElapsed, false);

      // Adversary mutates the untrusted boolean in the proof payload
      const bypassedProof: PPOIProof = {
        ...freshProof,
        standbyWindowElapsed: true
      };

      // Adversary immediately attempts unshield withdrawal to merchant
      const result = ppoiEngine.verifyProofOfInnocence(bypassedProof, merchantAddress);
      assert.equal(result.isValid, false, "Hardened engine must reject client mutation of standbyWindowElapsed");
      assert.equal(result.reason, "ERROR_STANDBY_WINDOW_ACTIVE", "Expected ERROR_STANDBY_WINDOW_ACTIVE error code");
    });
  });

  // =========================================================================
  // Challenge 4: Quarantined Note Spending & Validator Lineage Decoupling
  // =========================================================================
  describe("4. Quarantined Note Spending & Lineage Decoupling Attacks", () => {
    let registry: SanctionsRegistry;
    let ppoiEngine: PPOIEngine;
    let validator: PPOIValidator;
    const cleanOrigin = "0x0011111254eeb25477b68fb85ed929f73a960582";
    const poisonedOrigin = "0x999999cf1046e68e36e1aA2E0E07105eDDD1f08E";

    beforeEach(() => {
      registry = new SanctionsRegistry(poseidon2, undefined, 16);
      registry.loadDefaultSanctions();
      ppoiEngine = new PPOIEngine(registry, 5000);
      validator = new PPOIValidator(ppoiEngine);
    });

    it("QUAR-1: Quarantined deposit origin is blocked from unshield validation", () => {
      ppoiEngine.quarantinePoisonedDeposit(poisonedOrigin, "Tainted dust deposit");
      assert.equal(ppoiEngine.isQuarantined(poisonedOrigin), true);

      const cleanProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);
      const req: UnshieldValidationRequest = {
        merkleRoot: cleanProof.sanctionsRoot,
        nullifier: "0xnullifier1",
        recipient: "0xmerchant",
        token: "0xtoken",
        amount: 1000n,
        relayerFee: 10n,
        relayerAddress: "0xrelayer",
        depositOrigin: poisonedOrigin,
        depositTimestamp: Date.now() - 10000,
        ppoiProof: cleanProof
      };

      const res = validator.validateUnshield(req);
      assert.equal(res.success, false);
      assert.equal(res.errorCode, "POISONED_INPUT_QUARANTINED");
    });

    it("QUAR-ATK-1: Lineage Decoupling: Sanctioned depositor attaches clean PPOI proof", () => {
      // The attacker's note originated from Tornado Cash Router
      const tornadoOrigin = "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b";

      // The attacker generates/acquires a clean PPOI proof for cleanOrigin
      const cleanProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);

      // Attacker constructs unshield request with depositOrigin = tornadoOrigin
      // but ppoiProof.depositOrigin = cleanOrigin
      const maliciousReq: UnshieldValidationRequest = {
        merkleRoot: cleanProof.sanctionsRoot,
        nullifier: "0xnullifierBad",
        recipient: "0xmerchant",
        token: "0xtoken",
        amount: 5_000_000_000_000_000_000n,
        relayerFee: 50000n,
        relayerAddress: "0xrelayer",
        depositOrigin: tornadoOrigin, // Sanctioned address!
        depositTimestamp: Date.now() - 10000,
        ppoiProof: cleanProof // Clean proof!
      };

      // VULNERABILITY CHECK:
      // In PPOIValidator.validateUnshield:
      // 1. Checks isQuarantined(req.depositOrigin) -> false (Tornado Cash is in SMT, not in dust quarantine set)
      // 2. Checks verifyProofOfInnocence(req.ppoiProof, req.recipient) -> evaluates cleanProof, which is valid!
      // It NEVER verifies req.depositOrigin === req.ppoiProof.depositOrigin or isSanctioned(req.depositOrigin)!
      const valResult = validator.validateUnshield(maliciousReq);
      assert.equal(valResult.success, false, "Validator must reject unshield when deposit origin does not match PPOI proof");
      assert.ok(
        valResult.errorCode === "PPOI_ORIGIN_MISMATCH" || valResult.errorCode === "PPOI_SANCTIONED_INPUT",
        `Expected PPOI_ORIGIN_MISMATCH or PPOI_SANCTIONED_INPUT, got ${valResult.errorCode}`
      );
    });

    it("QUAR-ATK-2: Innocent depositor A cannot reuse innocent depositor B's proof", () => {
      const cleanA = "0x0011111254eeb25477b68fb85ed929f73a960582";
      const cleanB = "0x0022222254eeb25477b68fb85ed929f73a960582";
      const proofB = ppoiEngine.generateProofOfInnocence(cleanB, Date.now() - 10000);

      const mismatchedReq: UnshieldValidationRequest = {
        merkleRoot: proofB.sanctionsRoot,
        nullifier: "0xnullifierMismatch",
        recipient: "0xmerchant",
        token: "0xtoken",
        amount: 1000n,
        relayerFee: 10n,
        relayerAddress: "0xrelayer",
        depositOrigin: cleanA, // Origin A
        depositTimestamp: Date.now() - 10000,
        ppoiProof: proofB      // Proof for Origin B
      };

      const res = validator.validateUnshield(mismatchedReq);
      assert.equal(res.success, false);
      assert.equal(res.errorCode, "PPOI_ORIGIN_MISMATCH");
    });
  });

  // =========================================================================
  // Challenge 5: Viewing-Key Isolation & Inability to Spend
  // =========================================================================
  describe("5. Viewing-Key Cryptographic Isolation & Spending Inability", () => {
    it("KEY-1: Viewing key (vsk) cannot derive spending key (ssk) due to one-way HKDF", () => {
      const seed = crypto.randomBytes(32);
      const keys = deriveCorporateKeyHierarchy(seed);

      assert.notEqual(keys.masterSpendingKey, keys.masterViewingKey);

      // Verify domain separation tags
      const sskDirect = crypto.hkdfSync("sha256", seed, Buffer.from("DarkCircle-v1-Domain"), Buffer.from("SpendingKey"), 32);
      const vskDirect = crypto.hkdfSync("sha256", seed, Buffer.from("DarkCircle-v1-Domain"), Buffer.from("ViewingKey"), 32);

      assert.equal(Buffer.from(sskDirect).equals(Buffer.from(vskDirect)), false);
    });

    it("KEY-2: Viewing key (vsk) produces invalid spending nullifier", () => {
      const seed = crypto.randomBytes(32);
      const keys = deriveCorporateKeyHierarchy(seed);

      const note = Note.create({
        npk: keys.spendingPublicKey[0],
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: 1_000_000_000_000_000_000n,
        leafIndex: 42
      });

      // Authentic spending nullifier
      const authenticNullifier = note.computeNullifier(keys.masterSpendingKey);

      // Attacker attempts to compute nullifier using viewing key (vsk)
      const fakeNullifier = note.computeNullifier(keys.masterViewingKey);

      assert.notEqual(
        authenticNullifier,
        fakeNullifier,
        "Nullifier derived from vsk must NOT equal authentic spending nullifier"
      );

      // Nullifiers must be distinct across random seeds
      for (let i = 0; i < 5; i++) {
        const randKeys = deriveCorporateKeyHierarchy(crypto.randomBytes(32));
        const randNote = Note.create({
          npk: randKeys.spendingPublicKey[0],
          token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
          value: BigInt((i + 1) * 1000),
          leafIndex: i
        });
        assert.notEqual(
          randNote.computeNullifier(randKeys.masterSpendingKey),
          randNote.computeNullifier(randKeys.masterViewingKey)
        );
      }
    });

    it("KEY-3: Viewing key token payload explicitly omits spending key", () => {
      const keys = deriveCorporateKeyHierarchy(crypto.randomBytes(32));
      const parsedToken = JSON.parse(Buffer.from(keys.viewingKeyToken, "base64url").toString("utf8"));

      assert.equal(parsedToken.spendingKeyIncluded, false);
      assert.equal(parsedToken.permission, "READ_ONLY_AUDIT");
      assert.equal(parsedToken.ssk, undefined);
      assert.equal(parsedToken.masterSpendingKey, undefined);
      assert(parsedToken.vsk.startsWith("0x"));
    });
  });

  // =========================================================================
  // Challenge 6: Note Trial Decryption Tamper Resistance
  // =========================================================================
  describe("6. Note Trial Decryption Tamper Resistance & AEAD Authenticity", () => {
    let keysAlice: ReturnType<typeof deriveCorporateKeyHierarchy>;
    let keysBob: ReturnType<typeof deriveCorporateKeyHierarchy>;
    let samplePayload: DecryptedNotePayload;

    beforeEach(() => {
      keysAlice = deriveCorporateKeyHierarchy(crypto.randomBytes(32));
      keysBob = deriveCorporateKeyHierarchy(crypto.randomBytes(32));
      samplePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "50000000000000000000",
        blinding: "0x1234567890abcdef",
        npk: "0x9876543210fedcba",
        direction: "INBOUND_SHIELD",
        counterparty: "0xCustomer",
        invoiceId: "inv_adversarial_1",
        memo: "Adversarial Test Note",
        timestamp: 1726580000
      };
    });

    it("DEC-ATK-1: Bit-flip in ciphertext fails Poly1305 MAC and returns null", () => {
      const encrypted = encryptNotePayload(keysAlice.viewingPublicKey, samplePayload);

      // Flip each byte position in ciphertext
      const rawCipher = Buffer.from(encrypted.ciphertext, "hex");
      for (let offset = 0; offset < Math.min(rawCipher.length, 10); offset++) {
        const tamperedCipher = Buffer.from(rawCipher);
        tamperedCipher[offset] ^= 0x01; // flip 1 bit

        const tamperedPayload: EncryptedNotePayload = {
          ...encrypted,
          ciphertext: tamperedCipher.toString("hex")
        };

        const res = decryptNotePayload(keysAlice.masterViewingKey, tamperedPayload);
        assert.equal(res, null, `Bit flip at offset ${offset} must fail decryption`);
      }
    });

    it("DEC-ATK-2: Bit-flip in Poly1305 MAC tag fails authentication and returns null", () => {
      const encrypted = encryptNotePayload(keysAlice.viewingPublicKey, samplePayload);
      const rawTag = Buffer.from(encrypted.authTag, "hex");

      for (let offset = 0; offset < rawTag.length; offset++) {
        const tamperedTag = Buffer.from(rawTag);
        tamperedTag[offset] ^= 0x55;

        const tamperedPayload: EncryptedNotePayload = {
          ...encrypted,
          authTag: tamperedTag.toString("hex")
        };

        const res = decryptNotePayload(keysAlice.masterViewingKey, tamperedPayload);
        assert.equal(res, null, `MAC flip at byte ${offset} must fail decryption`);
      }
    });

    it("DEC-ATK-3: Off-curve ephemeral public key is rejected", () => {
      const encrypted = encryptNotePayload(keysAlice.viewingPublicKey, samplePayload);

      // Provide an invalid point not on BabyJubjub curve
      const offCurvePoint: [string, string] = ["12345", "67890"];
      const tamperedPayload: EncryptedNotePayload = {
        ...encrypted,
        ephemeralPubKey: offCurvePoint
      };

      const res = decryptNotePayload(keysAlice.masterViewingKey, tamperedPayload);
      assert.equal(res, null, "Off-curve ephemeral key must return null");
    });

    it("DEC-ATK-4: Unauthorized viewing key (Bob) cannot decrypt Alice's note", () => {
      const encrypted = encryptNotePayload(keysAlice.viewingPublicKey, samplePayload);
      const bobAttempt = decryptNotePayload(keysBob.masterViewingKey, encrypted);
      assert.equal(bobAttempt, null, "Bob must not decrypt Alice's note");
    });

    it("DEC-ATK-5: Scanner continues processing stream despite encountering corrupted notes", () => {
      const encValid1 = encryptNotePayload(keysAlice.viewingPublicKey, { ...samplePayload, value: "100" });
      const encCorrupted = { ...encValid1, ciphertext: "badc0ffee0" + encValid1.ciphertext.slice(10) };
      const encValid2 = encryptNotePayload(keysAlice.viewingPublicKey, { ...samplePayload, value: "200" });

      const scanner = new TransactionDiscoveryScanner(keysAlice.masterViewingKey);
      const discovered = scanner.scan([
        { commitment: "0x1", txHash: "0xtx1", blockNumber: 1, encrypted: encValid1 },
        { commitment: "0x2", txHash: "0xtx2", blockNumber: 2, encrypted: encCorrupted },
        { commitment: "0x3", txHash: "0xtx3", blockNumber: 3, encrypted: encValid2 }
      ]);

      assert.equal(discovered.length, 2);
      assert.equal(discovered[0].payload.value, "100");
      assert.equal(discovered[1].payload.value, "200");
    });
  });

  // =========================================================================
  // Challenge 7: Double-Entry Accounting Ledger Invariant Violations
  // =========================================================================
  describe("7. Double-Entry Accounting Ledger Invariant Violations", () => {
    let reconstructor: AccountingJournalReconstructor;

    beforeEach(() => {
      reconstructor = new AccountingJournalReconstructor("0zk1q_corporate_treasury");
    });

    it("ACC-1: Preserves Debits === Credits across all normal transactions", () => {
      const note: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "50000000000000000000",
        blinding: "0x1",
        npk: "0x1",
        direction: "INBOUND_SHIELD",
        counterparty: "0xCorp",
        timestamp: 1726580000
      };
      const entry = reconstructor.recordInbound("0xtx1", 1, "0xcomm1", note);
      assert.equal(entry.debitAmount, entry.creditAmount);
      assert.equal(reconstructor.verifyReconciliation(), true);
    });

    it("ACC-ATK-1: Unrecorded input note spend triggers reconciliation failure", () => {
      // Reconstructor has 0 initial notes
      const changeNote: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "40000000000000000000",
        blinding: "0x2",
        npk: "0x1",
        direction: "OUTBOUND_CHANGE",
        counterparty: "0zk1q_corporate_treasury",
        timestamp: 1726581000
      };

      // Attacker records outbound unshield spending an input commitment "0xghost_input" that never existed
      reconstructor.recordOutboundUnshield(
        "0xtxGhost",
        2,
        1726581000,
        "0xnullifierGhost",
        "0xghost_input",
        "0xmerchant",
        10_000_000_000_000_000_000n,
        500_000_000_000_000_000n,
        "0xrelayer",
        "0xcomm_change",
        changeNote,
        "inv_ghost",
        "Ghost spending"
      );

      // Running balance: 0 - 10.5 WQUAI = -10.5 WQUAI
      // Active UTXO balance: +40 WQUAI (from changeNote)
      // Reconciliation MUST fail!
      assert.equal(
        reconstructor.verifyReconciliation(),
        false,
        "Spending unrecorded input note must break reconciliation"
      );
    });

    it("ACC-ATK-2: Corrupted change note value (inflation attack) triggers reconciliation failure", () => {
      // 1. Initial Deposit: 100 WQUAI
      const seedNote: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "100000000000000000000", // 100 WQUAI
        blinding: "0x1",
        npk: "0x1",
        direction: "INBOUND_SHIELD",
        counterparty: "0xCorp",
        timestamp: 1726580000
      };
      reconstructor.recordInbound("0xtxSeed", 1, "0xcommSeed", seedNote);
      assert.equal(reconstructor.verifyReconciliation(), true);

      // 2. Spend 10 WQUAI + 1 WQUAI fee. Authentic change should be 89 WQUAI.
      // But attacker inflates change note to 95 WQUAI (generating 6 WQUAI out of thin air)!
      const inflatedChangeNote: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "95000000000000000000", // Inflated!
        blinding: "0xchange",
        npk: "0x1",
        direction: "OUTBOUND_CHANGE",
        counterparty: "0zk1q_corporate_treasury",
        timestamp: 1726581000
      };

      reconstructor.recordOutboundUnshield(
        "0xtxSpend",
        2,
        1726581000,
        "0xnullifierSeed",
        "0xcommSeed",
        "0xmerchant",
        10_000_000_000_000_000_000n, // 10 WQUAI
        1_000_000_000_000_000_000n,  // 1 WQUAI fee
        "0xrelayer",
        "0xcommInflatedChange",
        inflatedChangeNote,
        "inv_spend",
        "Inflated change test"
      );

      // Running balance: 100 - 11 = 89 WQUAI
      // Active UTXO balance: 95 WQUAI
      assert.notEqual(reconstructor.runningBalance, reconstructor.getActiveUtxoBalance());
      assert.equal(
        reconstructor.verifyReconciliation(),
        false,
        "Reconciliation must detect change note inflation"
      );
    });
  });

  // =========================================================================
  // Challenge 8: JSON/CSV Export Integrity & Checksum Validation
  // =========================================================================
  describe("8. JSON/CSV Export Integrity & Checksum Validation", () => {
    let reconstructor: AccountingJournalReconstructor;

    beforeEach(() => {
      reconstructor = new AccountingJournalReconstructor("0zk1q_corporate_treasury");
      const note: DecryptedNotePayload = {
        version: 1,
        token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
        value: "25000000000000000000",
        blinding: "0x1",
        npk: "0x1",
        direction: "INBOUND_SWEEP",
        counterparty: "0xClient402",
        invoiceId: "inv_export_test",
        memo: 'Test invoice, with comma & "quotes"',
        timestamp: 1726580000
      };
      reconstructor.recordInbound("0xtxExport", 100, "0xcommExport", note);
    });

    it("EXP-1: Exported JSON audit report includes valid SHA-256 checksum", () => {
      const jsonStr = exportJsonAuditReport(reconstructor);
      const parsed = JSON.parse(jsonStr);

      const recordedChecksum = parsed.cryptographicChecksum.sha256Hash;
      assert(typeof recordedChecksum === "string" && recordedChecksum.length === 64);

      // Independently verify checksum by clearing hash and hashing canonical JSON
      parsed.cryptographicChecksum.sha256Hash = "";
      const canonical = JSON.stringify(parsed);
      const expectedChecksum = crypto.createHash("sha256").update(canonical).digest("hex");

      assert.equal(
        recordedChecksum,
        expectedChecksum,
        "Cryptographic checksum must match canonical JSON hash"
      );
    });

    it("EXP-ATK-1: Modifying any field in JSON report breaks checksum verification", () => {
      const jsonStr = exportJsonAuditReport(reconstructor);
      const parsed = JSON.parse(jsonStr);
      const originalChecksum = parsed.cryptographicChecksum.sha256Hash;

      // Attacker tampers with grossInflow amount
      parsed.financialSummary.grossInflow.formatted = "999999.000000000000000000";

      // Recompute checksum under standard verification
      parsed.cryptographicChecksum.sha256Hash = "";
      const tamperedCanonical = JSON.stringify(parsed);
      const tamperedChecksum = crypto.createHash("sha256").update(tamperedCanonical).digest("hex");

      assert.notEqual(
        tamperedChecksum,
        originalChecksum,
        "Tampered JSON must result in checksum mismatch"
      );
    });

    it("EXP-2: CSV export strictly escapes special characters and preserves exact decimals", () => {
      const csv = exportCsvAuditSheet(reconstructor);
      const lines = csv.split("\n");

      // Verify header
      assert.equal(
        lines[0],
        "journal_id,timestamp_iso,block_number,tx_hash,direction,transaction_type,asset_symbol,asset_contract,gross_amount,fee_amount,net_amount,counterparty_address,relayer_address,invoice_id,memo,nullifier,ppoi_status,compliance_status,debit_account,credit_account,running_balance"
      );

      // Verify row escaping: memo with comma and quotes
      const row = lines[1];
      assert(row.includes('"Test invoice, with comma & ""quotes"""'));
      assert(row.includes("25.000000000000000000")); // Exactly 25 WQUAI
    });

    it("EXP-3: Decimal precision format handles zero, dust, and large amounts without float errors", () => {
      assert.equal(formatDecimals(0n, 6), "0.000000");
      assert.equal(formatDecimals(1n, 6), "0.000001");
      assert.equal(formatDecimals(1000000n, 6), "1.000000");
      assert.equal(formatDecimals(1000000000000n, 6), "1000000.000000");
      assert.equal(formatDecimals(1000000000000000000n, 18), "1.000000000000000000");
    });
  });
});
