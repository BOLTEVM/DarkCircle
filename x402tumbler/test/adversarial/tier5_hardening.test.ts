import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { getAddress } from "ethers";

// Cryptographic core imports
import { Fp, BN254_SCALAR_FIELD } from "../../src/crypto/field.ts";
import {
  poseidon1,
  poseidon2,
  poseidon3,
  poseidon4,
  poseidon6,
  poseidon,
  toFieldElement
} from "../../src/crypto/poseidon.ts";
import { IncrementalMerkleTree } from "../../src/crypto/merkleTree.ts";
import { SparseMerkleTree } from "../../src/crypto/smt.ts";
import { Note } from "../../src/crypto/note.ts";
import {
  computePublicInputsHash,
  computePublicInputsHash6,
  verifyUnshieldProofOffline
} from "../../src/crypto/unshield.ts";
import {
  GENERATOR,
  BASE8,
  FULL_GENERATOR,
  BABYJUBJUB_L,
  isOnCurve,
  addPoints,
  scalarMult,
  negatePoint
} from "../../src/crypto/babyjubjub.ts";
import { deriveCorporateKeyHierarchy } from "../../src/audit/keys.ts";
import {
  encryptNotePayload,
  decryptNotePayload,
  TransactionDiscoveryScanner
} from "../../src/audit/decryptor.ts";
import { PPOIEngine } from "../../src/ppoi/ppoiEngine.ts";
import type { UnshieldProof } from "../../src/types/crypto.ts";
import type { DecryptedNotePayload } from "../../src/types/audit.ts";

describe("Tier 5 Adversarial Hardening: Cryptographic Core & Invariants", () => {
  // =========================================================================
  // SUITE 1: Poseidon Hash Invariants & Extremal Field Elements
  // =========================================================================
  describe("Suite 1: Poseidon Hash Invariants & Extremal Field Elements", () => {
    it("T5.1.1: Handles all-zero inputs across arities 1, 2, 3, 4, 6 without degeneracy", () => {
      const h1 = poseidon1(0n);
      const h2 = poseidon2(0n, 0n);
      const h3 = poseidon3(0n, 0n, 0n);
      const h4 = poseidon4(0n, 0n, 0n, 0n);
      const h6 = poseidon6(0n, 0n, 0n, 0n, 0n, 0n);

      for (const h of [h1, h2, h3, h4, h6]) {
        assert.ok(h >= 0n, "Hash must be non-negative");
        assert.ok(h < Fp.p, "Hash must be strictly less than scalar field prime p");
        // Poseidon permutation on all-zeros must not be zero (non-degenerate state)
        assert.notEqual(h, 0n, "Poseidon output on all zeros must not be zero");
      }

      // Circomlib canonical test vector 3 check: poseidon2(0, 0)
      const expectedZero2Hex = "0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864";
      const expectedZero2 = BigInt(expectedZero2Hex);
      assert.equal(h2, expectedZero2, "poseidon2(0, 0) must match canonical Circomlib zero hash");
    });

    it("T5.1.2: Handles maximum field elements (p - 1) across arities", () => {
      const maxElem = Fp.p - 1n;
      const h2Max = poseidon2(maxElem, maxElem);
      const h4Max = poseidon4(maxElem, maxElem, maxElem, maxElem);

      assert.ok(h2Max >= 0n && h2Max < Fp.p, "poseidon2(p-1, p-1) within field");
      assert.ok(h4Max >= 0n && h4Max < Fp.p, "poseidon4(p-1, ...) within field");
      assert.notEqual(h2Max, 0n, "h2Max must be non-zero");
      assert.notEqual(h4Max, 0n, "h4Max must be non-zero");
    });

    it("T5.1.3: Enforces field reduction for out-of-field inputs & overflow detection in fromHex", () => {
      // toFieldElement reduces modulo p
      const overflowElem = Fp.p + 42n;
      assert.equal(toFieldElement(overflowElem), 42n, "toFieldElement must reduce modulo p");

      // fromHex strictly rejects scalar overflow >= p
      const hexOverflow = "0x" + Fp.p.toString(16);
      assert.throws(
        () => Fp.fromHex(hexOverflow),
        /Field scalar overflow/,
        "fromHex must reject hex >= p"
      );

      // fromHex strictly rejects p + 1
      const hexPPlus1 = "0x" + (Fp.p + 1n).toString(16);
      assert.throws(
        () => Fp.fromHex(hexPPlus1),
        /Field scalar overflow/,
        "fromHex must reject hex > p"
      );
    });

    it("T5.1.4: Asymmetry & non-commutativity: Poseidon is order-sensitive", () => {
      const a = 123456789n;
      const b = 987654321n;
      const h_ab = poseidon2(a, b);
      const h_ba = poseidon2(b, a);
      assert.notEqual(h_ab, h_ba, "poseidon2(a, b) must not equal poseidon2(b, a)");

      const h_4a = poseidon4(1n, 2n, 3n, 4n);
      const h_4b = poseidon4(4n, 3n, 2n, 1n);
      assert.notEqual(h_4a, h_4b, "poseidon4 must be strictly order-dependent");
    });

    it("T5.1.5: Collision resistance under pseudorandom variations", () => {
      const seenHashes = new Set<bigint>();
      const iterations = 500;
      for (let i = 0; i < iterations; i++) {
        const x = Fp.mod(BigInt(i * 10007 + 31));
        const y = Fp.mod(BigInt(i * 99991 + 17));
        const h = poseidon2(x, y);
        assert.ok(!seenHashes.has(h), `Collision detected at iteration ${i}!`);
        seenHashes.add(h);
      }
      assert.equal(seenHashes.size, iterations);
    });

    it("T5.1.6: Strict arity validation: rejects wrong input counts", () => {
      assert.throws(() => poseidon([]), /Poseidon requires at least 1 input/);
      assert.throws(() => (poseidon2 as any)(1n), /poseidon2 requires 2 inputs/);
      assert.throws(() => poseidon2([1n, 2n, 3n] as any), /poseidon2 requires exactly 2 inputs/);
      assert.throws(() => (poseidon3 as any)(1n, 2n), /poseidon3 requires 3 inputs/);
      assert.throws(() => poseidon3([1n, 2n] as any), /poseidon3 requires exactly 3 inputs/);
      assert.throws(() => (poseidon4 as any)(1n, 2n, 3n), /poseidon4 requires 4 inputs/);
      assert.throws(() => poseidon4([1n, 2n, 3n] as any), /poseidon4 requires exactly 4 inputs/);
      assert.throws(() => (poseidon6 as any)(1n, 2n, 3n, 4n, 5n), /poseidon6 requires 6 inputs/);
      assert.throws(() => poseidon6([1n, 2n, 3n, 4n, 5n] as any), /poseidon6 requires exactly 6 inputs/);
    });
  });

  // =========================================================================
  // SUITE 2: Incremental Merkle Tree Boundary Conditions & Tamper Resistance
  // =========================================================================
  describe("Suite 2: Incremental Merkle Tree Boundary Conditions & Tamper Resistance", () => {
    it("T5.2.1: Rejects invalid tree depth bounds (depth < 1 or depth > 32)", () => {
      assert.throws(() => new IncrementalMerkleTree(0), /Invalid Merkle tree depth 0/);
      assert.throws(() => new IncrementalMerkleTree(-1), /Invalid Merkle tree depth -1/);
      assert.throws(() => new IncrementalMerkleTree(33), /Invalid Merkle tree depth 33/);
    });

    it("T5.2.2: Saturated capacity enforcement on micro-tree (depth 3, capacity 8)", () => {
      const tree = new IncrementalMerkleTree(3);
      assert.equal(tree.capacity, 8);

      // Insert exactly 8 leaves
      for (let i = 0; i < 8; i++) {
        const idx = tree.insert(BigInt(i + 100));
        assert.equal(idx, i);
      }
      assert.equal(tree.nextIndex, 8);

      // Attempting 9th insertion must throw MERKLE_TREE_FULL
      assert.throws(
        () => tree.insert(999n),
        /MERKLE_TREE_FULL: capacity of 8 leaves exceeded/
      );

      // All 8 leaves must have valid membership proofs
      for (let i = 0; i < 8; i++) {
        const proof = tree.generateProof(i);
        assert.equal(IncrementalMerkleTree.verifyProof(proof), true);
      }
    });

    it("T5.2.3: Out-of-bounds leaf index proof generation rejection", () => {
      const tree = new IncrementalMerkleTree(4);
      tree.insert(111n);
      tree.insert(222n);

      assert.throws(() => tree.generateProof(-1), /LEAF_INDEX_OUT_OF_BOUNDS/);
      assert.throws(() => tree.generateProof(2), /LEAF_INDEX_OUT_OF_BOUNDS/);
      assert.throws(() => tree.generateProof(10), /LEAF_INDEX_OUT_OF_BOUNDS/);
    });

    it("T5.2.4: Comprehensive proof tampering: bit-flips, sibling swaps, and path corruptions", () => {
      const tree = new IncrementalMerkleTree(4);
      for (let i = 0; i < 6; i++) {
        tree.insert(BigInt(1000 + i));
      }

      const validProof = tree.generateProof(3);
      assert.equal(IncrementalMerkleTree.verifyProof(validProof), true);

      // 1. Tamper leaf value
      const tamperedLeaf = { ...validProof, leaf: Fp.add(validProof.leaf, 1n) };
      assert.equal(IncrementalMerkleTree.verifyProof(tamperedLeaf), false, "Tampered leaf must fail");

      // 2. Tamper sibling at level 0
      const tamperedSib0 = {
        ...validProof,
        siblings: [Fp.add(validProof.siblings[0], 1n), ...validProof.siblings.slice(1)]
      };
      assert.equal(IncrementalMerkleTree.verifyProof(tamperedSib0), false, "Tampered sibling 0 must fail");

      // 3. Tamper sibling at root-adjacent level
      const tamperedSibTop = {
        ...validProof,
        siblings: [...validProof.siblings.slice(0, 3), Fp.add(validProof.siblings[3], 7n)]
      };
      assert.equal(IncrementalMerkleTree.verifyProof(tamperedSibTop), false, "Tampered top sibling must fail");

      // 4. Tamper pathIndices (flip bit 0 <-> 1)
      const tamperedPath = {
        ...validProof,
        pathIndices: [validProof.pathIndices[0] === 0 ? 1 : 0, ...validProof.pathIndices.slice(1)]
      };
      assert.equal(IncrementalMerkleTree.verifyProof(tamperedPath), false, "Flipped path index must fail");

      // 5. Tamper root
      const tamperedRoot = { ...validProof, root: Fp.add(validProof.root, 1n) };
      assert.equal(IncrementalMerkleTree.verifyProof(tamperedRoot), false, "Tampered root must fail");

      // 6. Truncated siblings array
      const truncatedSiblings = {
        ...validProof,
        siblings: validProof.siblings.slice(0, 2),
        pathIndices: validProof.pathIndices.slice(0, 2)
      };
      assert.equal(IncrementalMerkleTree.verifyProof(truncatedSiblings), false, "Truncated siblings must fail");
    });

    it("T5.2.5: Historical root ring buffer eviction under rapid inserts", () => {
      const maxHistory = 10;
      const tree = new IncrementalMerkleTree(6, maxHistory);
      const roots: bigint[] = [tree.root];

      for (let i = 0; i < 25; i++) {
        tree.insert(BigInt(100 + i));
        roots.push(tree.root);
      }

      // Earliest roots beyond the 10-item buffer must be expired
      for (let i = 0; i < roots.length - maxHistory - 1; i++) {
        assert.equal(
          tree.isValidRoot(roots[i]),
          false,
          `Root ${i} should be evicted from historical buffer`
        );
      }

      // The most recent `maxHistory` roots must remain valid
      for (let i = roots.length - maxHistory; i < roots.length; i++) {
        assert.equal(
          tree.isValidRoot(roots[i]),
          true,
          `Recent root ${i} must be valid in historical buffer`
        );
      }

      // Current root is always valid
      assert.equal(tree.isValidRoot(tree.root), true);
    });
  });

  // =========================================================================
  // SUITE 3: UTXO Nullifier Uniqueness & Double-Spend Invariants
  // =========================================================================
  describe("Suite 3: UTXO Nullifier Uniqueness & Double-Spend Invariants", () => {
    // A spending key is a scalar in [0, L) (the BabyJubjub subgroup order); nullifiers refuse anything else, since
    // key + L owns the same notes and would derive a second nullifier for each.
    const ssk = 0x112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00n % BABYJUBJUB_L;
    const token = "0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb";

    it("T5.3.1: Identical note contents at distinct leaf indices yield distinct nullifiers", () => {
      const npk = 123456789n;
      const value = 5_000_000_000_000_000_000n;
      const rho = 999999999n;

      const note0 = new Note({ npk, token, value, rho, leafIndex: 0 });
      const note1 = new Note({ npk, token, value, rho, leafIndex: 1 });

      // Note commitments must be identical (same content)
      assert.equal(note0.computeCommitment(), note1.computeCommitment());

      // Nullifiers MUST be strictly distinct because leaf indices differ
      const nullifier0 = note0.computeNullifier(ssk);
      const nullifier1 = note1.computeNullifier(ssk);
      assert.notEqual(nullifier0, nullifier1, "Distinct leaf indices must produce distinct nullifiers");
    });

    it("T5.3.2: Identical commitment & leafIndex under distinct spending keys yield distinct nullifiers", () => {
      const npk = 123456789n;
      const value = 1_000_000_000_000_000_000n;
      const rho = 88888888n;
      const note = new Note({ npk, token, value, rho, leafIndex: 5 });

      const ssk1 = 0xaaaa1111n;
      const ssk2 = 0xbbbb2222n;

      const k1 = note.computeNullifier(ssk1);
      const k2 = note.computeNullifier(ssk2);
      assert.notEqual(k1, k2, "Different spending keys must produce distinct nullifiers");
    });

    it("T5.3.3: Distinct commitments under identical ssk and leafIndex yield distinct nullifiers", () => {
      const noteA = new Note({ npk: 111n, token, value: 1_000_000_000_000_000_000n, rho: 1n, leafIndex: 3 });
      const noteB = new Note({ npk: 111n, token, value: 1000001n, rho: 1n, leafIndex: 3 }); // 1 wei difference

      assert.notEqual(noteA.computeCommitment(), noteB.computeCommitment());
      assert.notEqual(noteA.computeNullifier(ssk), noteB.computeNullifier(ssk));
    });

    it("T5.3.4: Rejects note creation with zero or negative value", () => {
      assert.throws(
        () => new Note({ npk: 1n, token, value: 0n, rho: 1n }),
        /Note value must be strictly positive/
      );
      assert.throws(
        () => new Note({ npk: 1n, token, value: -100n, rho: 1n }),
        /Note value must be strictly positive/
      );
    });

    it("T5.3.5: Rejects nullifier computation without leaf index", () => {
      const noteWithoutIndex = Note.create({ npk: 1n, token, value: 1000n });
      assert.throws(
        () => noteWithoutIndex.computeNullifier(ssk),
        /Cannot compute nullifier without assigned leafIndex/
      );
    });

    it("T5.3.6: Double-spend detection via spent nullifier registry", () => {
      const spentNullifiers = new Set<string>();
      const note = new Note({ npk: 123n, token, value: 1_000_000_000_000_000_000n, rho: 555n, leafIndex: 2 });
      const nullifier = Fp.toHex(note.computeNullifier(ssk));

      // First spend: registry does not have nullifier -> accepted
      assert.equal(spentNullifiers.has(nullifier), false);
      spentNullifiers.add(nullifier);

      // Second spend: registry has nullifier -> detected as double spend!
      assert.equal(spentNullifiers.has(nullifier), true);
    });
  });

  // =========================================================================
  // SUITE 4: Anti-Front-Running Transaction Binding (hTx) Stress
  // =========================================================================
  describe("Suite 4: Anti-Front-Running Transaction Binding (hTx) Stress", () => {
    const validParams = {
      recipient: "0x00197970c51812dc3a010c7d01b50e0d17dc79c8",
      token: "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB",
      amount: 1_000_000_000_000_000_000n,
      relayerAddress: "0x0044cdddb6a900fa2b585dd299e03d12fa4293bc",
      relayerFee: 50000n,
      merkleRoot: "0x2a7c7c9b6ce5880b9f6f228d72bf6a575a526f29c66ecceef8b753d38bba7323"
    };

    it("T5.4.1: Deterministic anti-front-running hash computation", () => {
      const hTx1 = computePublicInputsHash(validParams);
      const hTx2 = computePublicInputsHash(validParams);
      assert.equal(hTx1, hTx2);
      assert.ok(hTx1.startsWith("0x") && hTx1.length === 66);
    });

    it("T5.4.2: Address casing normalization: lowercase vs checksummed yields identical hTx", () => {
      const lowerParams = {
        ...validParams,
        recipient: validParams.recipient.toLowerCase(),
        token: validParams.token.toLowerCase(),
        relayerAddress: validParams.relayerAddress.toLowerCase()
      };
      const hTxOriginal = computePublicInputsHash(validParams);
      const hTxLower = computePublicInputsHash(lowerParams);
      assert.equal(hTxOriginal, hTxLower, "hTx must be invariant to hex casing");
    });

    it("T5.4.3: Front-runner mutation fuzzing: any parameter alteration invalidates binding", () => {
      const originalHTx = computePublicInputsHash(validParams);

      // 1. Attacker changes recipient to their own address
      const stolenRecipient = {
        ...validParams,
        recipient: "0x00779bf6eb2c4f870365e785982e1f101e93b906"
      };
      assert.notEqual(computePublicInputsHash(stolenRecipient), originalHTx);

      // 2. Rogue relayer changes relayerAddress
      const rogueRelayer = {
        ...validParams,
        relayerAddress: "0x00534aaf54267db7d7c367839aaf71a00a2c6a65"
      };
      assert.notEqual(computePublicInputsHash(rogueRelayer), originalHTx);

      // 3. Relayer inflates relayerFee
      const inflatedFee = {
        ...validParams,
        relayerFee: 100000n
      };
      assert.notEqual(computePublicInputsHash(inflatedFee), originalHTx);

      // 4. Attacker alters withdrawal amount
      const alteredAmount = {
        ...validParams,
        amount: 2_000_000_000_000_000_000n
      };
      assert.notEqual(computePublicInputsHash(alteredAmount), originalHTx);

      // 5. Attacker switches token
      const alteredToken = {
        ...validParams,
        token: "0xdAC17F958D2ee523a2206206994597C13D831ec7"
      };
      assert.notEqual(computePublicInputsHash(alteredToken), originalHTx);

      // 6. Attacker references stale / bogus Merkle root
      const bogusRoot = {
        ...validParams,
        merkleRoot: "0x1111111111111111111111111111111111111111111111111111111111111111"
      };
      assert.notEqual(computePublicInputsHash(bogusRoot), originalHTx);
    });

    it("T5.4.4: verifyUnshieldProofOffline state machine & tamper detection", () => {
      const tree = new IncrementalMerkleTree(16);
      tree.insert(99999n);
      const currentRoot = Fp.toHex(tree.root);
      const nullifiersRegistry = new Set<string>();

      const validProof: UnshieldProof = {
        nullifier: Fp.toHex(123456789n),
        recipient: validParams.recipient,
        token: validParams.token,
        amount: validParams.amount,
        relayerAddress: validParams.relayerAddress,
        relayerFee: validParams.relayerFee,
        merkleRoot: currentRoot,
        publicInputsHash: computePublicInputsHash({
          ...validParams,
          merkleRoot: currentRoot
        }),
        ppoiProof: {
          sanctionsRoot: "0x1234",
          depositOriginHash: "0x5678",
          smtSiblings: [],
          isNonSanctioned: true
        },
        zkProof: {
          membershipProof: {
            leafIndex: 0,
            pathIndices: [],
            siblings: []
          },
          balanceProof: {
            inputValue: "1050000",
            outputPayment: "1000000",
            relayerFee: "50000",
            changeValue: "0"
          },
          publicInputsHash: computePublicInputsHash({
            ...validParams,
            merkleRoot: currentRoot
          })
        }
      };

      // Valid proof passes
      const res1 = verifyUnshieldProofOffline(validProof, tree, nullifiersRegistry);
      assert.equal(res1.valid, true);

      // Tampered binding hash
      const tamperedBindingProof: UnshieldProof = {
        ...validProof,
        publicInputsHash: Fp.toHex(42n)
      };
      const res2 = verifyUnshieldProofOffline(tamperedBindingProof, tree, nullifiersRegistry);
      assert.equal(res2.valid, false);
      assert.equal(res2.error, "ANTI_FRONT_RUNNING_HASH_MISMATCH");

      // Double spend of nullifier
      nullifiersRegistry.add(validProof.nullifier.toLowerCase());
      const res3 = verifyUnshieldProofOffline(validProof, tree, nullifiersRegistry);
      assert.equal(res3.valid, false);
      assert.equal(res3.error, "ERROR_NULLIFIER_ALREADY_SPENT");

      // Invalid / unknown Merkle root
      const invalidRootProof: UnshieldProof = {
        ...validProof,
        merkleRoot: Fp.toHex(999n),
        publicInputsHash: computePublicInputsHash({
          ...validParams,
          merkleRoot: Fp.toHex(999n)
        })
      };
      const freshRegistry = new Set<string>();
      const res4 = verifyUnshieldProofOffline(invalidRootProof, tree, freshRegistry);
      assert.equal(res4.valid, false);
      assert.equal(res4.error, "EXPIRED_OR_INVALID_MERKLE_ROOT");
    });
  });

  // =========================================================================
  // SUITE 5: Sparse Merkle Tree (SMT) & PPOI Cryptographic Non-Membership
  // =========================================================================
  describe("Suite 5: SMT & PPOI Cryptographic Non-Membership Stress", () => {
    it("T5.5.1: SMT handles boundary keys (0 and p-1)", () => {
      const smt = new SparseMerkleTree(16);
      const key0 = 0n;
      const keyMax = Fp.p - 1n;

      smt.insert(key0, 100n);
      assert.equal(smt.get(key0), 100n);

      smt.insert(keyMax, 200n);
      assert.equal(smt.get(keyMax), 200n);

      const proof0 = smt.createProof(key0);
      assert.equal(smt.verifyProof(proof0), true);

      const proofMax = smt.createProof(keyMax);
      assert.equal(smt.verifyProof(proofMax), true);
    });

    it("T5.5.2: Forgery resistance: forged non-membership proof for sanctioned key is rejected", () => {
      const smt = new SparseMerkleTree(16);
      const sanctionedKey = 0xbad001n;
      smt.insert(sanctionedKey, 1n); // Sanctioned

      // Adversary attempts to generate a non-membership proof by claiming value 0
      const forgedProof = smt.createProof(sanctionedKey);
      // Legitimate proof has value = 1 and isNonMembership = false
      assert.equal(forgedProof.isNonMembership, false);
      assert.equal(forgedProof.value, 1n);

      // Adversary modifies proof to claim isNonMembership = true and value = 0n
      const tamperedProof = {
        ...forgedProof,
        value: 0n,
        isNonMembership: true
      };

      // Verification MUST reject the forged proof because root calculation will mismatch
      assert.equal(
        smt.verifyProof(tamperedProof),
        false,
        "Forged non-membership proof claiming value 0 for sanctioned key must be rejected"
      );
    });

    it("T5.5.3: SMT rejects keys outside BN254 field range", () => {
      const smt = new SparseMerkleTree(16);
      assert.throws(() => smt.insert(Fp.p, 1n), /outside BN254 field range/);
      assert.throws(() => smt.get(-1n), /outside BN254 field range/);
    });
  });

  // =========================================================================
  // SUITE 6: BabyJubjub Curve Invariants & Group Arithmetic
  // =========================================================================
  describe("Suite 6: BabyJubjub Curve Invariants & Group Arithmetic", () => {
    it("T5.6.1: Subgroup order: L * Base8 yields curve identity (0, 1) and (8*L) * G yields (0, 1)", () => {
      // 1. Verify canonical BABYJUBJUB_L constant
      const CANONICAL_L = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
      assert.equal(BABYJUBJUB_L, CANONICAL_L, "BABYJUBJUB_L must match canonical Circomlib / EIP-2494 order");

      // 2. Base8 in prime subgroup: L * Base8 yields identity (0, 1)
      const identityFromBase8 = scalarMult(BABYJUBJUB_L, BASE8);
      assert.equal(identityFromBase8[0], 0n, "Identity X must be 0");
      assert.equal(identityFromBase8[1], 1n, "Identity Y must be 1");
      assert.equal(isOnCurve(identityFromBase8), true, "Identity must lie on curve");

      // 3. Full curve generator G has order 8*L: (8*L) * G yields identity (0, 1)
      const identityFrom8LG = scalarMult(8n * BABYJUBJUB_L, FULL_GENERATOR);
      assert.equal(identityFrom8LG[0], 0n, "8*L*G X must be 0");
      assert.equal(identityFrom8LG[1], 1n, "8*L*G Y must be 1");
      assert.equal(isOnCurve(identityFrom8LG), true, "Identity must lie on curve");

      // 4. GENERATOR is BASE8, so L * GENERATOR yields identity
      const identityFromGen = scalarMult(BABYJUBJUB_L, GENERATOR);
      assert.equal(identityFromGen[0], 0n);
      assert.equal(identityFromGen[1], 1n);

      // 5. Anti-circular check: L * FULL_GENERATOR is NOT identity (proves no circular k % L === 0n)
      const nonIdentity = scalarMult(BABYJUBJUB_L, FULL_GENERATOR);
      assert.notEqual(nonIdentity[0], 0n, "L * FULL_GENERATOR must not circularly collapse to identity");
    });

    it("T5.6.2: Group identity and inverse operations", () => {
      const identity: [bigint, bigint] = [0n, 1n];
      const addedIdentity = addPoints(GENERATOR, identity);
      assert.equal(addedIdentity[0], GENERATOR[0]);
      assert.equal(addedIdentity[1], GENERATOR[1]);

      const negG = negatePoint(GENERATOR);
      const zeroPoint = addPoints(GENERATOR, negG);
      assert.equal(zeroPoint[0], 0n);
      assert.equal(zeroPoint[1], 1n);
    });

    it("T5.6.3: Off-curve point detection", () => {
      assert.equal(isOnCurve([1n, 1n]), false, "(1, 1) is not on BabyJubjub");
      assert.equal(isOnCurve([123n, 456n]), false, "(123, 456) is not on BabyJubjub");
    });

    it("T5.6.4: ECDH commutativity under large scalars", () => {
      const skA = 0x123456789abcdef0123456789abcdef0n;
      const skB = 0xfedcba9876543210fedcba9876543210n;

      const pkA = scalarMult(skA, GENERATOR);
      const pkB = scalarMult(skB, GENERATOR);

      const secretA = scalarMult(skA, pkB);
      const secretB = scalarMult(skB, pkA);

      assert.equal(secretA[0], secretB[0], "ECDH secret X must match");
      assert.equal(secretA[1], secretB[1], "ECDH secret Y must match");
    });
  });

  // =========================================================================
  // SUITE 7: Viewing-Key AEAD Ciphertext Tampering & Scanner Robustness
  // =========================================================================
  describe("Suite 7: Viewing-Key AEAD Ciphertext Tampering & Scanner Robustness", () => {
    it("T5.7.1: Note trial decryption strictly rejects modified ciphertext bytes", () => {
      const hierarchy = deriveCorporateKeyHierarchy("adversarial-audit-seed-402");
      const payload: DecryptedNotePayload = {
        version: 1,
        token: "0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb",
        value: "123456789",
        blinding: "0x1234567890abcdef",
        npk: "0xabcdef1234567890",
        direction: "INBOUND_SWEEP",
        counterparty: "0xCustomerClient402",
        invoiceId: "inv_adversarial_1",
        memo: "Adversarial audit trial note",
        timestamp: 1726580000
      };

      const encrypted = encryptNotePayload(hierarchy.viewingPublicKey, payload);

      // Tamper ciphertext byte
      const rawHex = encrypted.ciphertext;
      const firstByte = parseInt(rawHex.slice(0, 2), 16);
      const flippedByte = (firstByte ^ 0xff).toString(16).padStart(2, "0");
      const tamperedCiphertext = flippedByte + rawHex.slice(2);

      const tamperedNote = {
        ...encrypted,
        ciphertext: tamperedCiphertext
      };

      const result = decryptNotePayload(hierarchy.masterViewingKey, tamperedNote);
      assert.equal(result, null, "Decryption of tampered ciphertext must fail safely returning null");
    });

    it("T5.7.2: Note trial decryption strictly rejects tampered MAC tag", () => {
      const hierarchy = deriveCorporateKeyHierarchy("adversarial-audit-seed-402");
      const payload: DecryptedNotePayload = {
        version: 1,
        token: "0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb",
        value: "999999",
        blinding: "0x1111111111111111",
        npk: "0x2222222222222222",
        direction: "OUTBOUND_AUDIT",
        counterparty: "0xVendorDestination",
        invoiceId: "inv_tamper_mac",
        memo: "Tampered MAC note",
        timestamp: 1726580000
      };

      const encrypted = encryptNotePayload(hierarchy.viewingPublicKey, payload);

      // Tamper MAC tag
      const flippedTag = "00".repeat(16);
      const tamperedNote = {
        ...encrypted,
        authTag: flippedTag
      };

      const result = decryptNotePayload(hierarchy.masterViewingKey, tamperedNote);
      assert.equal(result, null, "Decryption with corrupt MAC tag must return null");
    });

    it("T5.7.3: TransactionDiscoveryScanner continues gracefully over poisoned notes", () => {
      const hierarchy = deriveCorporateKeyHierarchy("scanner-resilience-seed");
      const cleanPayload: DecryptedNotePayload = {
        version: 1,
        token: "0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb",
        value: "500000",
        blinding: "0x3333333333333333",
        npk: "0x4444444444444444",
        direction: "INBOUND_SWEEP",
        counterparty: "0xPayerClient",
        invoiceId: "inv_clean_1",
        memo: "Clean Note",
        timestamp: 1726580000
      };
      const encClean = encryptNotePayload(hierarchy.viewingPublicKey, cleanPayload);

      // Corrupted note with bad MAC
      const encCorrupt = {
        ...encClean,
        ciphertext: "deadbeef12345678",
        authTag: "00000000000000000000000000000000"
      };

      const scanner = new TransactionDiscoveryScanner(hierarchy.masterViewingKey);
      const discovered = scanner.scan([
        { commitment: "0xbad", txHash: "0x1", blockNumber: 100, encrypted: encCorrupt },
        { commitment: "0xgood", txHash: "0x2", blockNumber: 101, encrypted: encClean }
      ]);

      // Scanner must discard corrupt note without crashing and discover clean note
      assert.equal(discovered.length, 1);
      assert.equal(discovered[0].payload.value, "500000");
      assert.equal(discovered[0].payload.memo, "Clean Note");
    });
  });
});
