/**
 * Challenger 2 Empirical Stress and Bypass Verification
 * File: test/adversarial/challenger2_empirical_verification.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { SparseMerkleTree } from "../../src/crypto/smt.ts";
import { poseidon2 } from "../../src/crypto/poseidon.ts";
import {
  BABYJUBJUB_L,
  BABYJUBJUB_P,
  BASE8,
  FULL_GENERATOR,
  GENERATOR,
  modInverse,
  scalarMult,
  isOnCurve
} from "../../src/crypto/babyjubjub.ts";
import { SanctionsRegistry } from "../../src/ppoi/sanctionsList.ts";
import { PPOIEngine } from "../../src/ppoi/ppoiEngine.ts";
import { PPOIValidator } from "../../src/ppoi/ppoiValidator.ts";
import type { PPOIProof, UnshieldValidationRequest } from "../../src/types/ppoi.ts";

describe("Challenger 2 Empirical Verification: PPOI Engine & Unshield Gate", () => {
  let registry: SanctionsRegistry;
  let ppoiEngine: PPOIEngine;
  let validator: PPOIValidator;

  const cleanOrigin = "0x0011111254eeb25477b68fb85ed929f73a960582";
  const cleanOriginB = "0x0022222254eeb25477b68fb85ed929f73a960582";
  const unlistedDustOrigin = "0x0033333354eeb25477b68fb85ed929f73a960582";
  const sanctionedTornado = "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b";
  const sanctionedLazarus = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
  const merchantAddress = "0x0044444454eeb25477b68fb85ed929f73a960582";

  beforeEach(() => {
    registry = new SanctionsRegistry(poseidon2, undefined, 16);
    registry.loadDefaultSanctions();
    ppoiEngine = new PPOIEngine(registry, 5000);
    validator = new PPOIValidator(ppoiEngine);
  });

  // =========================================================================
  // 1. Root Spoofing Resistance
  // =========================================================================
  describe("Root Spoofing Resistance & PPOI_ROOT_MISMATCH", () => {
    it("rejects when smtProof.root is from an empty tree", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);
      const emptyTree = new SparseMerkleTree(16, poseidon2);
      const emptyProof = emptyTree.createProof(registry.addressToKey(cleanOrigin));

      const spoofed: PPOIProof = {
        ...validProof,
        smtProof: {
          ...validProof.smtProof,
          root: "0x" + emptyProof.root.toString(16)
        }
      };

      const res = ppoiEngine.verifyProofOfInnocence(spoofed);
      assert.equal(res.isValid, false);
      assert.equal(res.reason, "PPOI_ROOT_MISMATCH");
    });

    it("rejects when smtProof.root is random while sanctionsRoot is authentic", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);
      const randomRoot = "0x" + crypto.randomBytes(32).toString("hex");

      const spoofed: PPOIProof = {
        ...validProof,
        smtProof: {
          ...validProof.smtProof,
          root: randomRoot
        }
      };

      const res = ppoiEngine.verifyProofOfInnocence(spoofed);
      assert.equal(res.isValid, false);
      assert.equal(res.reason, "PPOI_ROOT_MISMATCH");
    });

    it("handles hex formatting variations between sanctionsRoot and smtProof.root gracefully", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);
      // Strip leading 0x and pad with zeros to test BigInt value equivalence
      const rootBigInt = BigInt(validProof.sanctionsRoot);
      const equivalentHex = "0x000" + rootBigInt.toString(16);

      const modifiedProof: PPOIProof = {
        ...validProof,
        smtProof: {
          ...validProof.smtProof,
          root: equivalentHex
        }
      };

      // BigInt("0x000abc") === BigInt("0xabc") should evaluate true and verify
      const res = ppoiEngine.verifyProofOfInnocence(modifiedProof);
      assert.equal(res.isValid, true);
    });

    it("rejects malformed non-hex string in smtProof.root with PPOI_INVALID_ROOT", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);
      const spoofed: PPOIProof = {
        ...validProof,
        smtProof: {
          ...validProof.smtProof,
          root: "not-a-valid-hex"
        }
      };

      const res = ppoiEngine.verifyProofOfInnocence(spoofed);
      assert.equal(res.isValid, false);
      assert.equal(res.reason, "PPOI_INVALID_ROOT");
    });

    it("rejects when sanctionsRoot is unknown", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);
      const spoofed: PPOIProof = {
        ...validProof,
        sanctionsRoot: "0xdeadbeef1234567890",
        smtProof: {
          ...validProof.smtProof,
          root: "0xdeadbeef1234567890"
        }
      };

      const res = ppoiEngine.verifyProofOfInnocence(spoofed);
      assert.equal(res.isValid, false);
      assert.equal(res.reason, "PPOI_INVALID_ROOT");
      assert.equal(res.isRootKnown, false);
    });
  });

  // =========================================================================
  // 2. Key Spoofing Resistance
  // =========================================================================
  describe("Key Spoofing Resistance & PPOI_KEY_MISMATCH", () => {
    it("rejects when smtProof.key belongs to another clean address", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);
      const proofB = registry.getTree().createProof(registry.addressToKey(cleanOriginB));

      const spoofed: PPOIProof = {
        ...validProof,
        smtProof: {
          ...validProof.smtProof,
          key: "0x" + proofB.key.toString(16),
          siblings: proofB.siblings.map(s => "0x" + s.toString(16))
        }
      };

      const res = ppoiEngine.verifyProofOfInnocence(spoofed);
      assert.equal(res.isValid, false);
      assert.equal(res.reason, "PPOI_KEY_MISMATCH");
    });

    it("rejects when proof.key differs from expected address key", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);
      const spoofed: PPOIProof = {
        ...validProof,
        key: "0x" + registry.addressToKey(cleanOriginB).toString(16)
      };

      const res = ppoiEngine.verifyProofOfInnocence(spoofed);
      assert.equal(res.isValid, false);
      assert.equal(res.reason, "PPOI_KEY_MISMATCH");
    });

    it("accepts valid proof regardless of address case formatting (checksum vs lowercase)", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);
      const lowercaseProof: PPOIProof = {
        ...validProof,
        depositOrigin: cleanOrigin.toLowerCase()
      };

      const res = ppoiEngine.verifyProofOfInnocence(lowercaseProof);
      assert.equal(res.isValid, true);
    });

    it("rejects invalid hex address with PPOI_INVALID_ORIGIN_FORMAT", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);
      const corruptedOrigin: PPOIProof = {
        ...validProof,
        depositOrigin: "0xInvalidAddressNotHex"
      };

      const res = ppoiEngine.verifyProofOfInnocence(corruptedOrigin);
      assert.equal(res.isValid, false);
      assert.equal(res.reason, "PPOI_INVALID_ORIGIN_FORMAT");
    });
  });

  // =========================================================================
  // 3. Client-Side standbyWindowElapsed Manipulation
  // =========================================================================
  describe("Standby Window & Client-Side Bypass Resistance", () => {
    it("strictly blocks unshield to third-party when client mutates standbyWindowElapsed to true", () => {
      const depositTime = Date.now(); // 0ms elapsed
      const freshProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, depositTime);
      assert.equal(freshProof.standbyWindowElapsed, false);

      // Client flips the boolean
      freshProof.standbyWindowElapsed = true;

      const res = ppoiEngine.verifyProofOfInnocence(freshProof, merchantAddress);
      assert.equal(res.isValid, false);
      assert.equal(res.reason, "ERROR_STANDBY_WINDOW_ACTIVE");
    });

    it("allows refund unshield to original depositor even during standby window", () => {
      const depositTime = Date.now();
      const freshProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, depositTime);
      freshProof.standbyWindowElapsed = false;

      // Refund to self
      const res = ppoiEngine.verifyProofOfInnocence(freshProof, cleanOrigin);
      assert.equal(res.isValid, true);
    });

    it("allows external unshield after standby period has elapsed", () => {
      const maturedTime = Date.now() - 6000; // 6s ago, standby is 5s
      const matureProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, maturedTime);
      assert.equal(matureProof.standbyWindowElapsed, true);

      const res = ppoiEngine.verifyProofOfInnocence(matureProof, merchantAddress);
      assert.equal(res.isValid, true);
      assert.equal(res.isMature, true);
    });

    it("validator catches standby window violation using authoritative req.depositTimestamp", () => {
      const maturedTime = Date.now() - 10000;
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, maturedTime);

      // Client attempts to pass a fresh deposit timestamp to validator
      const now = Date.now();
      const req: UnshieldValidationRequest = {
        merkleRoot: validProof.sanctionsRoot,
        nullifier: "0xnullifier1",
        recipient: merchantAddress,
        token: "0xtoken",
        amount: 1000n,
        relayerFee: 10n,
        relayerAddress: "0xrelayer",
        depositOrigin: cleanOrigin,
        depositTimestamp: now, // Fresh! Active standby window
        ppoiProof: {
          ...validProof,
          depositTimestamp: now // Lineage timestamp matches req.depositTimestamp
        }
      };

      const valRes = validator.validateUnshield(req);
      assert.equal(valRes.success, false);
      assert.equal(valRes.errorCode, "ERROR_STANDBY_WINDOW_ACTIVE");
    });
  });

  // =========================================================================
  // 4. Lineage Decoupling & Sanctions Enforcement
  // =========================================================================
  describe("Lineage Decoupling & Sanctioned Deposit Unshielding Resistance", () => {
    it("blocks sanctioned deposit unshielding when attacker attaches innocent proof (QUAR-ATK-1)", () => {
      const innocentProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);

      const req: UnshieldValidationRequest = {
        merkleRoot: innocentProof.sanctionsRoot,
        nullifier: "0xnullifierBad",
        recipient: merchantAddress,
        token: "0xtoken",
        amount: 5_000_000_000_000_000_000n,
        relayerFee: 50000n,
        relayerAddress: "0xrelayer",
        depositOrigin: sanctionedTornado,
        depositTimestamp: Date.now() - 10000,
        ppoiProof: innocentProof
      };

      const valRes = validator.validateUnshield(req);
      assert.equal(valRes.success, false);
      assert.equal(valRes.errorCode, "PPOI_ORIGIN_MISMATCH");
    });

    it("blocks sanctioned origin directly when attacker matches depositOrigin and ppoiProof.depositOrigin", () => {
      // Craft a malicious proof claiming sanctioned origin
      const fakeProof: PPOIProof = {
        sanctionsRoot: registry.getRoot(),
        depositOrigin: sanctionedLazarus,
        key: "0x" + registry.addressToKey(sanctionedLazarus).toString(16),
        smtProof: {
          root: registry.getRoot(),
          key: "0x" + registry.addressToKey(sanctionedLazarus).toString(16),
          value: "0x0",
          siblings: [],
          isNonMembership: true
        },
        proofTimestamp: Date.now(),
        standbyWindowElapsed: true
      };

      const req: UnshieldValidationRequest = {
        merkleRoot: fakeProof.sanctionsRoot,
        nullifier: "0xnullifierLazarus",
        recipient: merchantAddress,
        token: "0xtoken",
        amount: 10_000_000_000_000_000_000n,
        relayerFee: 10000n,
        relayerAddress: "0xrelayer",
        depositOrigin: sanctionedLazarus,
        depositTimestamp: Date.now() - 10000,
        ppoiProof: fakeProof
      };

      const valRes = validator.validateUnshield(req);
      assert.equal(valRes.success, false);
      assert.equal(valRes.errorCode, "PPOI_SANCTIONED_INPUT");
    });

    it("blocks innocent user A from reusing innocent user B's proof (QUAR-ATK-2)", () => {
      const proofB = ppoiEngine.generateProofOfInnocence(cleanOriginB, Date.now() - 10000);

      const req: UnshieldValidationRequest = {
        merkleRoot: proofB.sanctionsRoot,
        nullifier: "0xnullifierA",
        recipient: merchantAddress,
        token: "0xtoken",
        amount: 1000n,
        relayerFee: 10n,
        relayerAddress: "0xrelayer",
        depositOrigin: cleanOrigin, // Origin A
        depositTimestamp: Date.now() - 10000,
        ppoiProof: proofB      // Proof B
      };

      const valRes = validator.validateUnshield(req);
      assert.equal(valRes.success, false);
      assert.equal(valRes.errorCode, "PPOI_ORIGIN_MISMATCH");
    });

    it("detects timestamp lineage mismatch between request and proof", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, 100000);

      const req: UnshieldValidationRequest = {
        merkleRoot: validProof.sanctionsRoot,
        nullifier: "0xnullifier1",
        recipient: merchantAddress,
        token: "0xtoken",
        amount: 1000n,
        relayerFee: 10n,
        relayerAddress: "0xrelayer",
        depositOrigin: cleanOrigin,
        depositTimestamp: 200000, // Does not match validProof.depositTimestamp (100000)
        ppoiProof: validProof
      };

      const valRes = validator.validateUnshield(req);
      assert.equal(valRes.success, false);
      assert.equal(valRes.errorCode, "PPOI_TIMESTAMP_MISMATCH");
    });
  });

  // =========================================================================
  // 5. Dust Quarantine Preservation
  // =========================================================================
  describe("Dust Quarantine Preservation", () => {
    it("quarantined unlisted deposit origin is blocked prior to lineage and proof checks", () => {
      // Unlisted address receives dust attack and is quarantined in ppoiEngine
      ppoiEngine.quarantinePoisonedDeposit(unlistedDustOrigin, "Unsolicited 1-wei dust drop");
      assert.equal(ppoiEngine.isQuarantined(unlistedDustOrigin), true);

      // Generating proof succeeds because it's not in OFAC SMT
      const proof = ppoiEngine.generateProofOfInnocence(unlistedDustOrigin, Date.now() - 10000);

      const req: UnshieldValidationRequest = {
        merkleRoot: proof.sanctionsRoot,
        nullifier: "0xnullifierDust",
        recipient: merchantAddress,
        token: "0xtoken",
        amount: 1n,
        relayerFee: 0n,
        relayerAddress: "0xrelayer",
        depositOrigin: unlistedDustOrigin,
        depositTimestamp: Date.now() - 10000,
        ppoiProof: proof
      };

      const valRes = validator.validateUnshield(req);
      assert.equal(valRes.success, false);
      assert.equal(valRes.errorCode, "POISONED_INPUT_QUARANTINED");
    });

    it("quarantined deposit origin is blocked even if innocent third-party proof is attached", () => {
      ppoiEngine.quarantinePoisonedDeposit(unlistedDustOrigin, "Dust quarantined");
      const cleanProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);

      const req: UnshieldValidationRequest = {
        merkleRoot: cleanProof.sanctionsRoot,
        nullifier: "0xnullifierDust2",
        recipient: merchantAddress,
        token: "0xtoken",
        amount: 1000n,
        relayerFee: 10n,
        relayerAddress: "0xrelayer",
        depositOrigin: unlistedDustOrigin,
        depositTimestamp: Date.now() - 10000,
        ppoiProof: cleanProof
      };

      const valRes = validator.validateUnshield(req);
      assert.equal(valRes.success, false);
      assert.equal(valRes.errorCode, "POISONED_INPUT_QUARANTINED");
    });

    it("dust quarantine is case-insensitive (checksummed vs lowercase)", () => {
      ppoiEngine.quarantinePoisonedDeposit(unlistedDustOrigin.toLowerCase());

      assert.equal(ppoiEngine.isQuarantined(unlistedDustOrigin.toUpperCase()), true);
      assert.equal(ppoiEngine.isQuarantined(unlistedDustOrigin), true);
    });
  });

  // =========================================================================
  // 6. Curve Arithmetic & Group Law Verification
  // =========================================================================
  describe("BabyJubjub Mathematical Soundness", () => {
    it("canonical BABYJUBJUB_L constant is mathematically exact", () => {
      const canonicalL = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
      assert.equal(BABYJUBJUB_L, canonicalL);
    });

    it("modInverse rejects 0n and negative moduli with RangeError", () => {
      assert.throws(() => modInverse(0n, BABYJUBJUB_P), RangeError);
      assert.throws(() => modInverse(10n, 0n), RangeError);
      assert.throws(() => modInverse(10n, -5n), RangeError);
    });

    it("scalarMult rejects negative scalar with RangeError", () => {
      assert.throws(() => scalarMult(-1n, GENERATOR), RangeError);
    });

    it("scalarMult does not perform circular modulo reduction on k", () => {
      // BASE8 has prime order L. Thus L * BASE8 = (0, 1).
      // FULL_GENERATOR has order 8*L. Thus L * FULL_GENERATOR !== (0, 1).
      // If scalarMult were doing `k % L`, then `scalarMult(L, FULL_GENERATOR)` would incorrectly return (0, 1)!
      const p1 = scalarMult(BABYJUBJUB_L, BASE8);
      assert.deepEqual(p1, [0n, 1n]);

      const p2 = scalarMult(BABYJUBJUB_L, FULL_GENERATOR);
      assert.notDeepEqual(p2, [0n, 1n], "Non-subgroup point must not map to identity at order L");

      const p3 = scalarMult(8n * BABYJUBJUB_L, FULL_GENERATOR);
      assert.deepEqual(p3, [0n, 1n], "FULL_GENERATOR must have order exactly 8*L");
    });
  });
});
