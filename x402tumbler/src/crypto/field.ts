import { getRandomValues } from "node:crypto";

/**
 * BN254 / alt_bn128 Scalar Field Arithmetic (Fp)
 * Prime p = 21888242871839275222246405745257275088548364400416034343698204186575808495617
 */
export class Fp {
  public static readonly p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

  public static mod(a: bigint): bigint {
    const res = a % Fp.p;
    return res >= 0n ? res : res + Fp.p;
  }

  public static add(a: bigint, b: bigint): bigint {
    return (Fp.mod(a) + Fp.mod(b)) % Fp.p;
  }

  public static sub(a: bigint, b: bigint): bigint {
    const diff = Fp.mod(a) - Fp.mod(b);
    return diff >= 0n ? diff : diff + Fp.p;
  }

  public static mul(a: bigint, b: bigint): bigint {
    return (Fp.mod(a) * Fp.mod(b)) % Fp.p;
  }

  public static pow(base: bigint, exp: bigint): bigint {
    let res = 1n;
    let b = Fp.mod(base);
    let e = exp;
    if (e < 0n) {
      b = Fp.inv(b);
      e = -e;
    }
    while (e > 0n) {
      if (e & 1n) res = (res * b) % Fp.p;
      b = (b * b) % Fp.p;
      e >>= 1n;
    }
    return res;
  }

  public static inv(a: bigint): bigint {
    const m = Fp.mod(a);
    if (m === 0n) throw new Error("Division by zero in Fp");
    return Fp.pow(m, Fp.p - 2n);
  }

  public static neg(a: bigint): bigint {
    const m = Fp.mod(a);
    return m === 0n ? 0n : Fp.p - m;
  }

  public static eq(a: bigint, b: bigint): boolean {
    return Fp.mod(a) === Fp.mod(b);
  }

  /**
   * Uniform random field element by rejection sampling. Reducing 256 random bits mod p is biased
   * (2^256 / p is about 5.3, so some residues occur one more time than others); sampling 254 bits and
   * retrying values >= p removes the bias for blinding factors and note randomness.
   */
  public static random(): bigint {
    const buf = new Uint8Array(32);
    for (;;) {
      getRandomValues(buf);
      buf[0] &= 0x3f; // keep 254 bits; p is just under 2^254
      let hex = "0x";
      for (let i = 0; i < 32; i++) {
        hex += buf[i].toString(16).padStart(2, "0");
      }
      const candidate = BigInt(hex);
      if (candidate < Fp.p) return candidate;
    }
  }

  /**
   * Parses a public input as a canonical field element: a bigint, decimal string or 0x-hex string
   * in [0, p). Values >= p are rejected, not reduced: reducing would let one nullifier or root be
   * spelled as n and n + p, defeating equality checks and the spent-nullifier set.
   */
  public static canonical(value: bigint | string | number, label: string = "value"): bigint {
    let n: bigint;
    try {
      if (typeof value === "bigint") n = value;
      else if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) throw new Error("unsafe integer");
        n = BigInt(value);
      } else {
        const t = value.trim();
        if (!/^(0x[0-9a-fA-F]+|[0-9]+)$/.test(t)) throw new Error("not a number");
        n = BigInt(t);
      }
    } catch {
      throw new Error(`ERR_FIELD_ELEMENT_MALFORMED: ${label} is not a number`);
    }
    if (n < 0n || n >= Fp.p) {
      throw new Error(`ERR_FIELD_ELEMENT_OUT_OF_RANGE: ${label} must be in [0, p)`);
    }
    return n;
  }

  public static toHex(val: bigint): string {
    return "0x" + Fp.mod(val).toString(16).padStart(64, "0");
  }

  public static fromHex(hex: string): bigint {
    const clean = hex.startsWith("0x") ? hex : "0x" + hex;
    const n = BigInt(clean);
    if (n >= Fp.p) throw new Error(`Field scalar overflow: ${hex} >= p`);
    return n;
  }
}

export const BN254_SCALAR_FIELD = Fp.p;
