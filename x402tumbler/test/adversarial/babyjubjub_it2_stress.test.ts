/**
 * DarkCircle Milestone 1 Iteration 2 Challenger Stress Test Suite
 * Author: challenger_m1_it2_1
 *
 * Empirical Challenge & Stress Tests for src/crypto/babyjubjub.ts:
 * 1. Genuine Double-and-Add Execution & Order Validation (scalarMult(L, BASE8) == [0n, 1n])
 * 2. Group Law & Inverse: scalarMult(L - 1n, BASE8) == negatePoint(BASE8)
 * 3. Full Curve Order & Cofactor 8: scalarMult(8n * L, FULL_GENERATOR) == [0n, 1n]
 * 4. Anti-Circular Protection: scalarMult(L, FULL_GENERATOR) != [0n, 1n] and has exact order 8
 * 5. Robustness & Fuzzing of modInverse with Zero and Multiples of p
 * 6. Twisted Edwards Point Addition, Neutral Element, Doubling & Associativity
 * 7. Large Scalar & Super-Order Multiplications without Modulo Shortcut
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BABYJUBJUB_P,
  BABYJUBJUB_L,
  BABYJUBJUB_A,
  BABYJUBJUB_D,
  FULL_GENERATOR,
  BASE8,
  GENERATOR,
  SUBGROUP_GENERATOR,
  mod,
  modInverse,
  isOnCurve,
  addPoints,
  negatePoint,
  scalarMult
} from "../../src/crypto/babyjubjub.ts";

describe("Milestone 1 Iteration 2 Challenger: BabyJubjub Cryptographic Core Empirical Stress Tests", () => {
  // =========================================================================
  // Challenge 1: Canonical Constants & Subgroup Definitions
  // =========================================================================
  describe("1. Canonical Curve Parameters & Constants", () => {
    it("CH-CONST-1: BABYJUBJUB_L matches canonical Circomlib/EIP-2494 hex and decimal values", () => {
      const EXPECTED_DECIMAL = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
      const EXPECTED_HEX = "0x60c89ce5c263405370a08b6d0302b0bab3eedb83920ee0a677297dc392126f1";

      assert.equal(BABYJUBJUB_L, EXPECTED_DECIMAL, "BABYJUBJUB_L decimal value mismatch");
      assert.equal(
        "0x" + BABYJUBJUB_L.toString(16),
        EXPECTED_HEX,
        "BABYJUBJUB_L hex serialization mismatch"
      );

      // Verify that previously corrupted constant (lower digits 508609058223157241n) is strictly not used
      const CORRUPTED_L = 2736030358979909402780800718157159386076813972158567259200508609058223157241n;
      assert.notEqual(BABYJUBJUB_L, CORRUPTED_L, "Must NOT use corrupted BABYJUBJUB_L constant");
    });

    it("CH-CONST-2: Full generator and Base8 lie on curve and maintain Base8 = 8 * FULL_GENERATOR", () => {
      assert.equal(isOnCurve(FULL_GENERATOR), true, "FULL_GENERATOR must be on curve");
      assert.equal(isOnCurve(BASE8), true, "BASE8 must be on curve");
      assert.equal(isOnCurve(GENERATOR), true, "GENERATOR must be on curve");

      // Verify BASE8 is derived as exactly 8 * FULL_GENERATOR
      const derivedBase8 = scalarMult(8n, FULL_GENERATOR);
      assert.deepEqual(derivedBase8, BASE8, "BASE8 must equal 8 * FULL_GENERATOR");

      // Verify protocol aliases
      assert.deepEqual(GENERATOR, BASE8, "GENERATOR alias must be BASE8");
      assert.deepEqual(SUBGROUP_GENERATOR, BASE8, "SUBGROUP_GENERATOR alias must be BASE8");
    });
  });

  // =========================================================================
  // Challenge 2: Genuine Double-and-Add & Subgroup Order Verification
  // =========================================================================
  describe("2. Genuine Double-and-Add Execution & Order Properties", () => {
    it("CH-SCAL-1: scalarMult(BABYJUBJUB_L, BASE8) yields identity [0n, 1n]", () => {
      const identity = scalarMult(BABYJUBJUB_L, BASE8);
      assert.deepEqual(identity, [0n, 1n], "L * BASE8 must evaluate to identity point [0n, 1n]");
      assert.equal(isOnCurve(identity), true, "Identity must lie on curve");
    });

    it("CH-SCAL-2: scalarMult(BABYJUBJUB_L - 1n, BASE8) equals negatePoint(BASE8)", () => {
      const lMinus1Point = scalarMult(BABYJUBJUB_L - 1n, BASE8);
      const negBase8 = negatePoint(BASE8);

      assert.deepEqual(lMinus1Point, negBase8, "(L - 1) * BASE8 must equal -BASE8");
      assert.equal(isOnCurve(lMinus1Point), true, "(L - 1) * BASE8 must be on curve");

      // Adding BASE8 back must yield identity [0n, 1n]
      const reconstitutedIdentity = addPoints(lMinus1Point, BASE8);
      assert.deepEqual(
        reconstitutedIdentity,
        [0n, 1n],
        "(L - 1) * BASE8 + BASE8 must equal identity [0n, 1n]"
      );
    });

    it("CH-SCAL-3: scalarMult(8n * BABYJUBJUB_L, FULL_GENERATOR) yields identity [0n, 1n]", () => {
      const totalOrder = 8n * BABYJUBJUB_L;
      const identity = scalarMult(totalOrder, FULL_GENERATOR);

      assert.deepEqual(identity, [0n, 1n], "(8 * L) * FULL_GENERATOR must equal identity [0n, 1n]");
      assert.equal(isOnCurve(identity), true, "Identity must lie on curve");
    });

    it("CH-SCAL-4: Anti-circular check: scalarMult(BABYJUBJUB_L, FULL_GENERATOR) is NOT [0n, 1n] and has exact order 8", () => {
      // If scalarMult used a circular shortcut `k % BABYJUBJUB_L`, this would mistakenly yield [0n, 1n]
      const order8Point = scalarMult(BABYJUBJUB_L, FULL_GENERATOR);

      assert.notDeepEqual(
        order8Point,
        [0n, 1n],
        "Anti-circular violation: L * FULL_GENERATOR must NOT equal identity [0n, 1n]"
      );
      assert.equal(isOnCurve(order8Point), true, "L * FULL_GENERATOR must be on curve");

      // Verify that order8Point has exact order 8 in the cofactor group
      let current = order8Point;
      for (let i = 1; i < 8; i++) {
        assert.notDeepEqual(
          current,
          [0n, 1n],
          `L * FULL_GENERATOR multiplied by ${i} must NOT be identity (order is 8)`
        );
        current = addPoints(current, order8Point);
      }
      assert.deepEqual(current, [0n, 1n], "8 * (L * FULL_GENERATOR) must equal identity [0n, 1n]");
    });

    it("CH-SCAL-5: Super-order scalar execution verifies arithmetic beyond L without truncation", () => {
      // Test k = L + 1n -> should equal BASE8
      const lPlus1 = scalarMult(BABYJUBJUB_L + 1n, BASE8);
      assert.deepEqual(lPlus1, BASE8, "(L + 1) * BASE8 must equal BASE8");

      // Test k = 2n * L -> should equal identity
      const twoL = scalarMult(2n * BABYJUBJUB_L, BASE8);
      assert.deepEqual(twoL, [0n, 1n], "2L * BASE8 must equal identity [0n, 1n]");

      // Test k = 2n * L + 7n -> should equal 7 * BASE8
      const twoLPlus7 = scalarMult(2n * BABYJUBJUB_L + 7n, BASE8);
      const sevenBase8 = scalarMult(7n, BASE8);
      assert.deepEqual(twoLPlus7, sevenBase8, "(2L + 7) * BASE8 must equal 7 * BASE8");
    });

    it("CH-SCAL-6: Boundary scalars: k=0n returns identity, negative scalars throw RangeError", () => {
      const zeroPoint = scalarMult(0n, BASE8);
      assert.deepEqual(zeroPoint, [0n, 1n], "0 * BASE8 must equal identity [0n, 1n]");

      assert.throws(
        () => scalarMult(-1n, BASE8),
        /RangeError.*Scalar must be non-negative/,
        "Negative scalar -1n must throw RangeError"
      );

      assert.throws(
        () => scalarMult(-123456789n, BASE8),
        /RangeError.*Scalar must be non-negative/,
        "Negative scalar must throw RangeError"
      );
    });
  });

  // =========================================================================
  // Challenge 3: modInverse Stress & Division-by-Zero Testing
  // =========================================================================
  describe("3. modInverse Robustness, Zero Multiples & Coprimality Stress", () => {
    it("CH-INV-1: Rejects zero input with RangeError", () => {
      assert.throws(
        () => modInverse(0n),
        /RangeError.*Division by zero/,
        "modInverse(0n) must throw RangeError"
      );
    });

    it("CH-INV-2: Rejects positive and negative multiples of p with RangeError", () => {
      // p % p === 0n
      assert.throws(
        () => modInverse(BABYJUBJUB_P),
        /RangeError.*Division by zero/,
        "modInverse(p) must throw RangeError"
      );

      // -p % p === 0n
      assert.throws(
        () => modInverse(-BABYJUBJUB_P),
        /RangeError.*Division by zero/,
        "modInverse(-p) must throw RangeError"
      );

      // 2 * p
      assert.throws(
        () => modInverse(2n * BABYJUBJUB_P),
        /RangeError.*Division by zero/,
        "modInverse(2*p) must throw RangeError"
      );

      // -5 * p
      assert.throws(
        () => modInverse(-5n * BABYJUBJUB_P),
        /RangeError.*Division by zero/,
        "modInverse(-5*p) must throw RangeError"
      );

      // 1000 * p
      assert.throws(
        () => modInverse(1000n * BABYJUBJUB_P),
        /RangeError.*Division by zero/,
        "modInverse(1000*p) must throw RangeError"
      );
    });

    it("CH-INV-3: Rejects invalid modulus m <= 0n", () => {
      assert.throws(
        () => modInverse(5n, 0n),
        /RangeError.*Modulus must be positive/,
        "m = 0n must throw RangeError"
      );

      assert.throws(
        () => modInverse(5n, -17n),
        /RangeError.*Modulus must be positive/,
        "m < 0n must throw RangeError"
      );
    });

    it("CH-INV-4: Rejects non-coprime inputs when custom modulus is provided", () => {
      assert.throws(
        () => modInverse(6n, 9n),
        /RangeError.*inputs not coprime/,
        "gcd(6, 9) = 3 != 1 must throw RangeError"
      );

      assert.throws(
        () => modInverse(14n, 21n),
        /RangeError.*inputs not coprime/,
        "gcd(14, 21) = 7 != 1 must throw RangeError"
      );

      assert.throws(
        () => modInverse(100n, 1000n),
        /RangeError.*inputs not coprime/,
        "gcd(100, 1000) != 1 must throw RangeError"
      );
    });

    it("CH-INV-5: Verifies algebraic inverse correctness across random field elements", () => {
      const testValues = [
        1n,
        2n,
        3n,
        17n,
        BABYJUBJUB_P - 1n,
        BABYJUBJUB_P - 2n,
        123456789012345678901234567890n,
        0xdeadbeefcafebaben,
        0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefn % BABYJUBJUB_P
      ];

      for (const val of testValues) {
        const inv = modInverse(val);
        const prod = mod(val * inv);
        assert.equal(prod, 1n, `val * inv must equal 1n mod p for ${val}`);
        assert(inv > 0n && inv < BABYJUBJUB_P, `inv must be in field range for ${val}`);
      }

      // Self-inverse boundary: 1 and p-1
      assert.equal(modInverse(1n), 1n, "Inverse of 1n is 1n");
      assert.equal(
        modInverse(BABYJUBJUB_P - 1n),
        BABYJUBJUB_P - 1n,
        "Inverse of (p - 1n) is (p - 1n) since (-1)^2 = 1"
      );
    });
  });

  // =========================================================================
  // Challenge 4: Twisted Edwards Group Axioms & Arithmetic Edge Cases
  // =========================================================================
  describe("4. Twisted Edwards Group Axioms & Arithmetic", () => {
    it("CH-GRP-1: Identity element behavior: P + O == P and O + P == P", () => {
      const identity: [bigint, bigint] = [0n, 1n];
      assert.deepEqual(addPoints(BASE8, identity), BASE8);
      assert.deepEqual(addPoints(identity, BASE8), BASE8);
      assert.deepEqual(addPoints(FULL_GENERATOR, identity), FULL_GENERATOR);
      assert.deepEqual(addPoints(identity, identity), identity);
    });

    it("CH-GRP-2: Point negation: P + (-P) == O", () => {
      const negBase8 = negatePoint(BASE8);
      assert.equal(isOnCurve(negBase8), true);
      assert.deepEqual(addPoints(BASE8, negBase8), [0n, 1n]);

      const negFullG = negatePoint(FULL_GENERATOR);
      assert.equal(isOnCurve(negFullG), true);
      assert.deepEqual(addPoints(FULL_GENERATOR, negFullG), [0n, 1n]);
    });

    it("CH-GRP-3: Associativity: (P + Q) + R == P + (Q + R)", () => {
      const P = BASE8;
      const Q = scalarMult(3n, BASE8);
      const R = scalarMult(7n, BASE8);

      const lhs = addPoints(addPoints(P, Q), R);
      const rhs = addPoints(P, addPoints(Q, R));

      assert.deepEqual(lhs, rhs, "Group addition must be associative");
    });

    it("CH-GRP-4: Point doubling equals scalarMult(2n, P)", () => {
      const doubleAdd = addPoints(BASE8, BASE8);
      const doubleMult = scalarMult(2n, BASE8);

      assert.deepEqual(doubleAdd, doubleMult, "P + P must equal 2 * P");
      assert.equal(isOnCurve(doubleAdd), true);
    });

    it("CH-GRP-5: Off-curve points strictly rejected by isOnCurve", () => {
      assert.equal(isOnCurve([0n, 0n]), false, "(0, 0) is not on curve");
      assert.equal(isOnCurve([1n, 1n]), false, "(1, 1) is not on curve");
      assert.equal(isOnCurve([BASE8[0], BASE8[1] + 1n]), false, "Altered Y must not be on curve");
      assert.equal(isOnCurve([BASE8[0] + 1n, BASE8[1]]), false, "Altered X must not be on curve");
    });

    it("CH-GRP-6: 2-Torsion point [0n, p - 1n] lies on curve and has order 2", () => {
      // On Twisted Edwards a*x^2 + y^2 = 1 + d*x^2*y^2:
      // When x = 0, y^2 = 1 mod p, which has solutions y = 1 (identity) and y = -1 (p - 1).
      const torsion2: [bigint, bigint] = [0n, BABYJUBJUB_P - 1n];
      assert.equal(isOnCurve(torsion2), true, "2-torsion point [0n, p-1n] must lie on curve");

      // 2 * torsion2 == identity [0n, 1n]
      const doubledTorsion = addPoints(torsion2, torsion2);
      assert.deepEqual(doubledTorsion, [0n, 1n], "2 * [0n, p-1n] must equal identity [0n, 1n]");
    });
  });
});
