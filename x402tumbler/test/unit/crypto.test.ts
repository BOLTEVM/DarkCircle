import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Fp, BN254_SCALAR_FIELD } from "../../src/crypto/field.ts";
import {
  poseidon,
  poseidon1,
  poseidon2,
  poseidon3,
  poseidon4,
  poseidon6
} from "../../src/crypto/poseidon.ts";
import { IncrementalMerkleTree } from "../../src/crypto/merkleTree.ts";
import {
  BABYJUBJUB_P,
  BABYJUBJUB_L,
  GENERATOR,
  BASE8,
  FULL_GENERATOR,
  isOnCurve,
  addPoints,
  negatePoint,
  scalarMult,
  modInverse
} from "../../src/crypto/babyjubjub.ts";
import { Note } from "../../src/crypto/note.ts";
import {
  computePublicInputsHash,
  computePublicInputsHash6,
  verifyUnshieldProofOffline
} from "../../src/crypto/unshield.ts";

describe("Milestone 1 Unit Tests: Cryptographic Core", () => {
  describe("BN254 Scalar Field (Fp)", () => {
    it("performs modular addition and subtraction correctly", () => {
      const a = 12345678901234567890n;
      const b = 98765432109876543210n;
      const sum = Fp.add(a, b);
      assert.equal(Fp.sub(sum, b), a);
      assert.equal(Fp.sub(sum, a), b);
    });

    it("performs modular multiplication and inversion correctly", () => {
      const a = 123456789n;
      const invA = Fp.inv(a);
      assert.equal(Fp.mul(a, invA), 1n);
    });

    it("throws on division by zero in Fp", () => {
      assert.throws(() => Fp.inv(0n), /Division by zero in Fp/);
    });

    it("generates random elements within field bounds", () => {
      for (let i = 0; i < 10; i++) {
        const r = Fp.random();
        assert(r >= 0n && r < Fp.p);
      }
    });

    it("serializes and deserializes hex strings correctly", () => {
      const val = 0xdeadbeef12345678n;
      const hex = Fp.toHex(val);
      assert(hex.startsWith("0x"));
      assert.equal(Fp.fromHex(hex), val);
    });

    it("rejects scalar overflow >= p in fromHex", () => {
      const overflowHex = "0x" + Fp.p.toString(16);
      assert.throws(() => Fp.fromHex(overflowHex), /Field scalar overflow/);
    });
  });

  describe("Poseidon Hash Engine & Canonical Circomlib Test Vectors", () => {
    it("matches Vector 1: Poseidon Arity 2 with inputs [1n, 2n]", () => {
      const expectedHex = "0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a";
      const expectedBig = BigInt(expectedHex);

      const res = poseidon2(1n, 2n);
      assert.equal(res, expectedBig);
      assert.equal(Fp.toHex(res), expectedHex);
    });

    it("matches Vector 2: Poseidon Arity 4 with inputs [1n, 2n, 3n, 4n]", () => {
      const expectedHex = "0x299c867db6c1fdd79dcefa40e4510b9837e60ebb1ce0663dbaa525df65250465";
      const expectedBig = BigInt(expectedHex);

      const res = poseidon4(1n, 2n, 3n, 4n);
      assert.equal(res, expectedBig);
      assert.equal(Fp.toHex(res), expectedHex);
    });

    it("matches Vector 3: Base Zero Hash poseidon2(0n, 0n)", () => {
      const expectedHex = "0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864";
      const expectedBig = BigInt(expectedHex);

      const res = poseidon2(0n, 0n);
      assert.equal(res, expectedBig);
      assert.equal(Fp.toHex(res), expectedHex);
    });

    it("matches Vector 4: Incremental Merkle Tree Depth 16 Empty Root", () => {
      const expectedHex = "0x2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323";
      const expectedBig = BigInt(expectedHex);

      const tree = new IncrementalMerkleTree(16);
      assert.equal(tree.root, expectedBig);
      assert.equal(Fp.toHex(tree.root), expectedHex);
    });

    it("matches Vector 5: Note Commitment", () => {
      const npk = 0x111122223333444455556666777788889999aaaabbbbccccddddeeeeffff0000n;
      const token = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
      const value = 10000000n;
      const rho = 0x9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedcban;
      const expectedHex = "0x2a93bec3207d14c833ffcc2545775cfbaa3b06ffc228749c83583dd277f0a11e";

      const note = Note.create({ npk, token, value, rho });
      const commitment = note.computeCommitment();
      assert.equal(Fp.toHex(commitment), expectedHex);
    });

    it("matches Vector 6: Nullifier Derivation", () => {
      const ssk = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefn;
      const C = 0x2a93bec3207d14c833ffcc2545775cfbaa3b06ffc228749c83583dd277f0a11en;
      const leafIndex = 0;
      const expectedHex = "0x07504b700e6102a27c19d2546f560f56e7b117947ef03d2a84705b3fae2028d8";

      const k = poseidon3(ssk, C, BigInt(leafIndex));
      assert.equal(Fp.toHex(k), expectedHex);
    });

    it("computes Poseidon arities 1, 3, 4, 6 consistently", () => {
      const p1 = poseidon1(42n);
      assert(p1 > 0n);

      const p3 = poseidon3(1n, 2n, 3n);
      assert(p3 > 0n);

      const p6 = poseidon6(1n, 2n, 3n, 4n, 5n, 6n);
      assert(p6 > 0n);

      const pGeneric = poseidon([1n, 2n, 3n, 4n, 5n, 6n]);
      assert.equal(pGeneric, p6);
    });
  });

  describe("Incremental Merkle Tree (IMT)", () => {
    it("inserts leaves and produces valid membership proofs", () => {
      const tree = new IncrementalMerkleTree(16);
      const leaf1 = 0x12345678n;
      const leaf2 = 0x87654321n;

      const idx0 = tree.insert(leaf1);
      assert.equal(idx0, 0);
      const idx1 = tree.insert(leaf2);
      assert.equal(idx1, 1);

      const proof0 = tree.generateProof(0);
      assert.equal(proof0.leaf, leaf1);
      assert.equal(IncrementalMerkleTree.verifyProof(proof0), true);

      const proof1 = tree.generateProof(1);
      assert.equal(proof1.leaf, leaf2);
      assert.equal(IncrementalMerkleTree.verifyProof(proof1), true);
    });

    it("rejects tampered membership proofs", () => {
      const tree = new IncrementalMerkleTree(16);
      tree.insert(0xa1b2c3d4n);
      const proof = tree.generateProof(0);

      const tamperedProof = { ...proof, leaf: proof.leaf + 1n };
      assert.equal(IncrementalMerkleTree.verifyProof(tamperedProof), false);
    });

    it("maintains historical root ring buffer of 64 roots", () => {
      const tree = new IncrementalMerkleTree(16, 64);
      const initialRoot = tree.root;
      assert(tree.isValidRoot(initialRoot));

      for (let i = 0; i < 70; i++) {
        tree.insert(BigInt(i + 100));
      }

      assert.equal(tree.historicalRoots.length, 64);
      // The initial root should have been evicted after 64 insertions
      assert.equal(tree.historicalRoots.includes(initialRoot), false);
      // Recent root is recognized
      assert.equal(tree.isValidRoot(tree.root), true);
    });

    it("throws when tree capacity is exceeded", () => {
      const smallTree = new IncrementalMerkleTree(2); // capacity 4
      smallTree.insert(1n);
      smallTree.insert(2n);
      smallTree.insert(3n);
      smallTree.insert(4n);
      assert.throws(() => smallTree.insert(5n), /MERKLE_TREE_FULL/);
    });
  });

  describe("BabyJubjub Curve Arithmetic", () => {
    it("verifies standard Generator point lies on the curve", () => {
      assert.equal(isOnCurve(GENERATOR), true);
    });

    it("satisfies group law identity element and negation", () => {
      const identity: [bigint, bigint] = [0n, 1n];
      assert.deepEqual(addPoints(GENERATOR, identity), GENERATOR);

      const negG = negatePoint(GENERATOR);
      assert.deepEqual(addPoints(GENERATOR, negG), identity);
    });

    it("satisfies ECDH commutativity (a * B == b * A)", () => {
      const privA = 123456789012345n;
      const privB = 987654321098765n;

      const pubA = scalarMult(privA, GENERATOR);
      const pubB = scalarMult(privB, GENERATOR);

      const sharedAB = scalarMult(privA, pubB);
      const sharedBA = scalarMult(privB, pubA);

      assert.deepEqual(sharedAB, sharedBA);
      assert.equal(isOnCurve(sharedAB), true);
    });

    it("rejects division by zero in modInverse", () => {
      assert.throws(() => modInverse(0n), /Division by zero/);
      assert.throws(() => modInverse(BABYJUBJUB_P), /Division by zero/);
      assert.throws(() => modInverse(-BABYJUBJUB_P), /Division by zero/);
    });

    it("verifies canonical BabyJubjub subgroup order constant BABYJUBJUB_L", () => {
      const CANONICAL_L = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
      assert.equal(BABYJUBJUB_L, CANONICAL_L);
      assert.equal("0x" + BABYJUBJUB_L.toString(16), "0x60c89ce5c263405370a08b6d0302b0bab3eedb83920ee0a677297dc392126f1");
    });

    it("verifies genuine subgroup order: L * G yields identity and (L-1)*G yields -G without modulo reduction", () => {
      const identity = scalarMult(BABYJUBJUB_L, GENERATOR);
      assert.deepEqual(identity, [0n, 1n]);

      const lMinus1 = scalarMult(BABYJUBJUB_L - 1n, GENERATOR);
      const negG = negatePoint(GENERATOR);
      assert.deepEqual(lMinus1, negG);

      const plusOne = addPoints(lMinus1, GENERATOR);
      assert.deepEqual(plusOne, [0n, 1n]);
    });

    it("verifies Full Generator of order 8*L", () => {
      assert.equal(isOnCurve(FULL_GENERATOR), true);
      assert.deepEqual(scalarMult(8n, FULL_GENERATOR), BASE8);
      assert.deepEqual(scalarMult(8n * BABYJUBJUB_L, FULL_GENERATOR), [0n, 1n]);
    });
  });

  describe("UTXO Note Lifecycle & Anti-Front-Running", () => {
    it("creates, serializes, and deserializes Note with strict positive value", () => {
      const npk = 0xabcdef123456n;
      const token = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      const value = 50000000n; // 50 USDC
      const memo = "Invoice_Test_123";

      const note = Note.create({ npk, token, value, memo, leafIndex: 5 });
      assert.equal(note.value, value);
      assert.equal(note.leafIndex, 5);

      const serialized = note.serialize();
      assert.equal(serialized.token.toLowerCase(), token.toLowerCase());

      const deserialized = Note.deserialize(serialized);
      assert.equal(deserialized.npk, note.npk);
      assert.equal(deserialized.value, note.value);
      assert.equal(deserialized.computeCommitment(), note.computeCommitment());
    });

    it("rejects non-positive note value", () => {
      assert.throws(
        () => Note.create({ npk: 1n, token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", value: 0n }),
        /Note value must be strictly positive/
      );
    });

    it("computes deterministic anti-front-running transaction binding", () => {
      const params = {
        recipient: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
        amount: 10000000n,
        relayerAddress: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
        relayerFee: 500000n,
        merkleRoot: "0x2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323"
      };

      const hTx = computePublicInputsHash(params);
      assert(hTx.startsWith("0x"));

      // Altering relayer changes binding
      const altered = computePublicInputsHash({ ...params, relayerAddress: "0x90F79bf6EB2c4f870365E785982E1f101E93b906" });
      assert.notEqual(hTx, altered);
    });
  });
});
