import type { Point } from "../types/crypto.ts";

/**
 * DarkCircle Cryptographic Core: Pure TypeScript BabyJubjub Curve Arithmetic
 * Implements Twisted Edwards curve: a*x^2 + y^2 = 1 + d*x^2*y^2 (mod p)
 */

export const BABYJUBJUB_P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Canonical BabyJubjub prime subgroup order l (EIP-2494, Circomlib, Iden3, MACI)
// Total curve order n = 8 * l = 21888242871839275222246405745257275088614511777268538073601725287587578984328n
// Hex: 0x60c89ce5c263405370a08b6d0302b0bab3eedb83920ee0a677297dc392126f1
export const BABYJUBJUB_L = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

export const BABYJUBJUB_A = 168700n;
export const BABYJUBJUB_D = 168696n;

// EIP-2494 Full Curve Generator Point G (order 8*l)
export const FULL_GENERATOR: Point = [
  995203441582195749578291179787384436505546430278305826713579947235728471134n,
  5472060717959818805561601436314318772137091100104008585924551046643952123905n
];

// Prime subgroup generator point Base8 (order l = BABYJUBJUB_L)
// Base8 = 8 * FULL_GENERATOR
// Circomlib / EdDSA / MACI / Railgun canonical generator for key derivation
export const BASE8: Point = [
  5299619240641551281634865583518297030282874472190772894086521144482721001553n,
  16950150798460657717958625567821834550301663161624707787222815936182638968203n
];

// Default protocol generator point for key derivation and circuit compatibility
export const GENERATOR: Point = BASE8;
export const SUBGROUP_GENERATOR: Point = BASE8;

export type { Point };

export function mod(n: bigint, m: bigint = BABYJUBJUB_P): bigint {
  return ((n % m) + m) % m;
}

/**
 * Modular inversion using Extended Euclidean Algorithm.
 * Throws RangeError if a % m === 0n (division by zero) or if numbers are not coprime.
 */
export function modInverse(a: bigint, m: bigint = BABYJUBJUB_P): bigint {
  if (m <= 0n) {
    throw new RangeError("Modulus must be positive");
  }
  const aMod = ((a % m) + m) % m;
  if (aMod === 0n) {
    throw new RangeError("Division by zero: modular inverse does not exist for 0");
  }
  if (m === 1n) return 0n;

  let [oldR, r] = [aMod, m];
  let [oldS, s] = [1n, 0n];

  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }

  if (oldR !== 1n) {
    throw new RangeError("Modular inverse does not exist: inputs not coprime");
  }

  return ((oldS % m) + m) % m;
}

export function isOnCurve(point: Point): boolean {
  const [x, y] = point;
  const x2 = mod(x * x);
  const y2 = mod(y * y);
  const lhs = mod(BABYJUBJUB_A * x2 + y2);
  const rhs = mod(1n + mod(BABYJUBJUB_D * x2) * y2);
  return lhs === rhs;
}

export function addPoints(p1: Point, p2: Point): Point {
  const [x1, y1] = p1;
  const [x2, y2] = p2;
  if (x1 === 0n && y1 === 1n) return p2;
  if (x2 === 0n && y2 === 1n) return p1;

  const numX = mod(x1 * y2 + y1 * x2);
  const denX = mod(1n + mod(BABYJUBJUB_D * mod(x1 * x2)) * mod(y1 * y2));
  const x3 = mod(numX * modInverse(denX));

  const numY = mod(y1 * y2 - BABYJUBJUB_A * mod(x1 * x2));
  const denY = mod(1n - mod(BABYJUBJUB_D * mod(x1 * x2)) * mod(y1 * y2));
  const y3 = mod(numY * modInverse(denY));

  return [x3, y3];
}

export function negatePoint(p: Point): Point {
  return [mod(BABYJUBJUB_P - p[0]), p[1]];
}

/**
 * Raw elliptic curve scalar multiplication via Double-and-Add.
 * Operates genuinely on the scalar k without circular modulo reduction.
 */
export function scalarMult(k: bigint, point: Point): Point {
  if (k < 0n) {
    throw new RangeError("Scalar must be non-negative");
  }
  let res: Point = [0n, 1n];
  let base: Point = point;
  let scalar = k;
  while (scalar > 0n) {
    if (scalar & 1n) {
      res = addPoints(res, base);
    }
    base = addPoints(base, base);
    scalar >>= 1n;
  }
  return res;
}

export const IDENTITY: Point = [0n, 1n];

export function isIdentity(point: Point): boolean {
  return point[0] === 0n && point[1] === 1n;
}

/**
 * True when `point` is on the curve, is not the identity, and lies in the prime-order subgroup
 * (l * P == identity). The full curve has cofactor 8, so a point can be on the curve yet of small
 * order; using such a point as an ECDH public key leaks the secret scalar modulo 8 to whoever chose it.
 */
export function isInPrimeSubgroup(point: Point): boolean {
  const [x, y] = point;
  if (x < 0n || y < 0n || x >= BABYJUBJUB_P || y >= BABYJUBJUB_P) return false;
  if (!isOnCurve(point) || isIdentity(point)) return false;
  return isIdentity(scalarMult(BABYJUBJUB_L, point));
}
