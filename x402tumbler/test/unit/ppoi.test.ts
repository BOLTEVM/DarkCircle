import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { SparseMerkleTree } from "../../src/crypto/smt.ts";
import { poseidon2 } from "../../src/crypto/poseidon.ts";
import {
  SanctionsRegistry,
  OFAC_SANCTIONED_ADDRESSES,
  TESTNET_SANCTIONED_ADDRESSES
} from "../../src/ppoi/sanctionsList.ts";
import { PPOIEngine } from "../../src/ppoi/ppoiEngine.ts";
import { PPOIValidator } from "../../src/ppoi/ppoiValidator.ts";
import type { UnshieldValidationRequest, PPOIProof } from "../../src/types/ppoi.ts";

describe("Milestone 1 Unit Tests: PPOI Engine & Sanctions SMT", () => {
  describe("Sparse Merkle Tree (SMT)", () => {
    it("computes precomputed default zero hashes for empty tree", () => {
      const smt = new SparseMerkleTree(16, poseidon2);
      assert.equal(smt.zeros[0], 0n);
      assert.equal(smt.getRoot(), smt.zeros[16]);
    });

    it("generates and verifies non-membership proof on empty tree", () => {
      const smt = new SparseMerkleTree(16, poseidon2);
      const cleanKey = 0x1111111254eeb25477b68fb85ed929f73a960582n;

      const proof = smt.createProof(cleanKey);
      assert.equal(proof.isNonMembership, true);
      assert.equal(proof.value, 0n);
      assert.equal(smt.verifyProof(proof), true);
    });

    it("inserts sanctioned key, verifies membership, and verifies non-membership fails", () => {
      const smt = new SparseMerkleTree(16, poseidon2);
      const badKey = 0x999999cf1046e68e36e1aa2e0e07105eddd1f08en;

      smt.insert(badKey, 1n);
      assert.equal(smt.get(badKey), 1n);

      const memProof = smt.createProof(badKey);
      assert.equal(memProof.value, 1n);
      assert.equal(memProof.isNonMembership, false);
      assert.equal(smt.verifyProof(memProof), true);

      // A forged proof asserting value=0n with authentic siblings must mathematically fail
      const forgedNonMemProof = { ...memProof, value: 0n, isNonMembership: true };
      assert.equal(smt.verifyProof(forgedNonMemProof), false);
    });

    it("prunes nodes on deletion and returns memory footprint to zero", () => {
      const smt = new SparseMerkleTree(16, poseidon2);
      const key = 0x12345678n;

      smt.insert(key, 1n);
      assert(smt.nodes.size > 0);

      smt.delete(key);
      assert.equal(smt.getRoot(), smt.zeros[16]);
      assert.equal(smt.nodes.size, 0); // Complete node pruning
    });
  });

  describe("Sanctions Registry & Datasets", () => {
    let registry: SanctionsRegistry;

    beforeEach(() => {
      // Use depth 16 for ultra-fast unit testing
      registry = new SanctionsRegistry(poseidon2, undefined, 16);
    });

    it("loads OFAC and testnet sanctions lists into SMT", () => {
      registry.loadDefaultSanctions();

      for (const item of OFAC_SANCTIONED_ADDRESSES) {
        assert.equal(
          registry.isSanctioned(item.address),
          true,
          `Expected ${item.address} (${item.desc}) to be sanctioned`
        );
      }

      for (const item of TESTNET_SANCTIONED_ADDRESSES) {
        assert.equal(
          registry.isSanctioned(item.address),
          true,
          `Expected ${item.address} (${item.desc}) to be sanctioned`
        );
      }

      // Unlisted corporate address should NOT be sanctioned
      const corporateAddress = "0x0011111254eeb25477b68fb85ed929f73a960582";
      assert.equal(registry.isSanctioned(corporateAddress), false);
    });

    it("handles case-insensitive address normalization and whitespace", () => {
      const addr = "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b";
      assert.equal(registry.normalizeAddress(addr), addr.toLowerCase());
      assert.equal(registry.normalizeAddress("  " + addr.toUpperCase() + "  "), addr.toLowerCase());
    });

    it("records historical roots on updates", () => {
      const root0 = registry.getRoot();
      assert(registry.isKnownRoot(root0));

      const root1 = registry.addSanctionedAddress(
        "0x777777a45632E934eD52f41659728B5E86E2097e",
        "RANSOMWARE",
        "Test Ransomware"
      );
      assert(registry.isKnownRoot(root1));
      assert(registry.isKnownRoot(root0));
      assert.notEqual(root0, root1);
    });
  });

  describe("PPOI Engine & Verification Pipeline", () => {
    let registry: SanctionsRegistry;
    let ppoiEngine: PPOIEngine;
    const cleanOrigin = "0x0011111254eeb25477b68fb85ed929f73a960582";
    const sanctionedOrigin = "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b";

    beforeEach(() => {
      registry = new SanctionsRegistry(poseidon2, undefined, 16);
      registry.loadDefaultSanctions();
      ppoiEngine = new PPOIEngine(registry, 5000); // 5s standby window
    });

    it("generates valid non-membership proof for clean deposit origin", () => {
      const depositTimestamp = Date.now() - 10000; // 10s ago (mature)
      const proof = ppoiEngine.generateProofOfInnocence(cleanOrigin, depositTimestamp);

      assert.equal(proof.depositOrigin, cleanOrigin.toLowerCase());
      assert.equal(proof.standbyWindowElapsed, true);
      assert(proof.sanctionsRoot.startsWith("0x"));

      const result = ppoiEngine.verifyProofOfInnocence(proof);
      assert.equal(result.isValid, true);
      assert.equal(result.isSanctioned, false);
      assert.equal(result.isRootKnown, true);
    });

    it("strictly refuses to generate proof of innocence for sanctioned origin", () => {
      const depositTimestamp = Date.now() - 10000;
      assert.throws(
        () => ppoiEngine.generateProofOfInnocence(sanctionedOrigin, depositTimestamp),
        /PPOI_SANCTIONED_INPUT/
      );
    });

    it("rejects proof with unknown sanctions root", () => {
      const depositTimestamp = Date.now() - 10000;
      const proof = ppoiEngine.generateProofOfInnocence(cleanOrigin, depositTimestamp);
      const fakeRootProof = { ...proof, sanctionsRoot: "0x1234567890abcdef" };

      const result = ppoiEngine.verifyProofOfInnocence(fakeRootProof);
      assert.equal(result.isValid, false);
      assert.equal(result.reason, "PPOI_INVALID_ROOT");
    });

    it("enforces standby window: rejects withdrawal to merchant during standby window", () => {
      const recentDepositTime = Date.now(); // 0s ago (active window)
      const proof = ppoiEngine.generateProofOfInnocence(cleanOrigin, recentDepositTime);
      assert.equal(proof.standbyWindowElapsed, false);

      const merchantAddress = "0x0022222254eeb25477b68fb85ed929f73a960582";
      const merchantResult = ppoiEngine.verifyProofOfInnocence(proof, merchantAddress);
      assert.equal(merchantResult.isValid, false);
      assert.equal(merchantResult.reason, "ERROR_STANDBY_WINDOW_ACTIVE");

      // Withdrawing back to original depositor is permitted during standby window
      const depositorResult = ppoiEngine.verifyProofOfInnocence(proof, cleanOrigin);
      assert.equal(depositorResult.isValid, true);
    });

    it("tracks and quarantines poisoned dust deposits", () => {
      const poisonedCommitment = "0xpoisoned_dust_commitment_12345";
      assert.equal(ppoiEngine.isQuarantined(poisonedCommitment), false);

      ppoiEngine.quarantinePoisonedDeposit(poisonedCommitment, "Sanctioned dust attack");
      assert.equal(ppoiEngine.isQuarantined(poisonedCommitment), true);

      const validator = new PPOIValidator(ppoiEngine);
      const dummyProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);
      const req: UnshieldValidationRequest = {
        merkleRoot: "0xroot",
        nullifier: "0xnullifier",
        recipient: "0xmerchant",
        token: "0xtoken",
        amount: 1000n,
        relayerFee: 10n,
        relayerAddress: "0xrelayer",
        depositOrigin: poisonedCommitment,
        depositTimestamp: Date.now() - 10000,
        ppoiProof: dummyProof
      };

      const valResult = validator.validateUnshield(req);
      assert.equal(valResult.success, false);
      assert.equal(valResult.errorCode, "POISONED_INPUT_QUARANTINED");
    });

    it("rejects proof with root mismatch between sanctionsRoot and smtProof.root", () => {
      const depositTimestamp = Date.now() - 10000;
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, depositTimestamp);

      const rootMismatchedProof: PPOIProof = {
        ...validProof,
        smtProof: {
          ...validProof.smtProof,
          root: "0x" + (BigInt(validProof.sanctionsRoot) + 1n).toString(16)
        }
      };

      const result = ppoiEngine.verifyProofOfInnocence(rootMismatchedProof);
      assert.equal(result.isValid, false);
      assert.equal(result.reason, "PPOI_ROOT_MISMATCH");
    });

    it("rejects proof with key mismatch between depositOrigin and smtProof.key", () => {
      const depositTimestamp = Date.now() - 10000;
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, depositTimestamp);

      const keyMismatchedProof: PPOIProof = {
        ...validProof,
        smtProof: {
          ...validProof.smtProof,
          key: "0x123456789"
        }
      };

      const result = ppoiEngine.verifyProofOfInnocence(keyMismatchedProof);
      assert.equal(result.isValid, false);
      assert.equal(result.reason, "PPOI_KEY_MISMATCH");
    });

    it("rejects unshield validation when depositOrigin does not match ppoiProof.depositOrigin", () => {
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, Date.now() - 10000);
      const validator = new PPOIValidator(ppoiEngine);

      const req: UnshieldValidationRequest = {
        merkleRoot: validProof.sanctionsRoot,
        nullifier: "0xnullifierValid",
        recipient: "0xmerchant",
        token: "0xtoken",
        amount: 1000n,
        relayerFee: 10n,
        relayerAddress: "0xrelayer",
        depositOrigin: "0x0033333354eeb25477b68fb85ed929f73a960582",
        depositTimestamp: Date.now() - 10000,
        ppoiProof: validProof
      };

      const valResult = validator.validateUnshield(req);
      assert.equal(valResult.success, false);
      assert.equal(valResult.errorCode, "PPOI_ORIGIN_MISMATCH");
    });

    it("validates successful unshield when all compliance and lineage checks pass", () => {
      const depositTimestamp = Date.now() - 10000;
      const validProof = ppoiEngine.generateProofOfInnocence(cleanOrigin, depositTimestamp);
      const validator = new PPOIValidator(ppoiEngine);

      const req: UnshieldValidationRequest = {
        merkleRoot: validProof.sanctionsRoot,
        nullifier: "0xnullifierSuccess",
        recipient: "0xmerchant",
        token: "0xtoken",
        amount: 1000n,
        relayerFee: 10n,
        relayerAddress: "0xrelayer",
        depositOrigin: cleanOrigin,
        depositTimestamp,
        ppoiProof: validProof
      };

      const valResult = validator.validateUnshield(req);
      assert.equal(valResult.success, true);
      assert.equal(valResult.errorCode, undefined);
    });
  });
});
