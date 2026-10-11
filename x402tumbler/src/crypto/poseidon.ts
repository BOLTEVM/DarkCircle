import crypto from "node:crypto";
import {
  poseidon1 as _poseidon1,
  poseidon2 as _poseidon2,
  poseidon3 as _poseidon3,
  poseidon4 as _poseidon4,
  poseidon5 as _poseidon5,
  poseidon6 as _poseidon6
} from "poseidon-lite";
import { Fp } from "./field.ts";

/**
 * Normalizes an input to a BN254 field element.
 */
export function toFieldElement(v: bigint | string | number): bigint {
  if (typeof v === "bigint") return Fp.mod(v);
  if (typeof v === "number") return Fp.mod(BigInt(v));
  const s = String(v).trim();
  if (s.startsWith("0x") || s.startsWith("0X")) {
    return Fp.mod(BigInt(s));
  }
  if (/^-?\d+$/.test(s)) {
    return Fp.mod(BigInt(s));
  }
  const hash = crypto.createHash("sha256").update(s).digest("hex");
  return Fp.mod(BigInt("0x" + hash));
}

export function poseidon1(a: bigint | string | number | (bigint | string | number)[]): bigint {
  const inputs = Array.isArray(a) ? a.map(toFieldElement) : [toFieldElement(a)];
  return Fp.mod(BigInt(_poseidon1(inputs)));
}

export function poseidon2(
  a: bigint | string | number | (bigint | string | number)[],
  b?: bigint | string | number
): bigint {
  if (Array.isArray(a)) {
    if (a.length !== 2) throw new Error(`poseidon2 requires exactly 2 inputs, got ${a.length}`);
    return Fp.mod(BigInt(_poseidon2(a.map(toFieldElement))));
  }
  if (b === undefined) throw new Error("poseidon2 requires 2 inputs");
  return Fp.mod(BigInt(_poseidon2([toFieldElement(a), toFieldElement(b)])));
}

export function poseidon3(
  a: bigint | string | number | (bigint | string | number)[],
  b?: bigint | string | number,
  c?: bigint | string | number
): bigint {
  if (Array.isArray(a)) {
    if (a.length !== 3) throw new Error(`poseidon3 requires exactly 3 inputs, got ${a.length}`);
    return Fp.mod(BigInt(_poseidon3(a.map(toFieldElement))));
  }
  if (b === undefined || c === undefined) throw new Error("poseidon3 requires 3 inputs");
  return Fp.mod(BigInt(_poseidon3([toFieldElement(a), toFieldElement(b), toFieldElement(c)])));
}

export function poseidon4(
  a: bigint | string | number | (bigint | string | number)[],
  b?: bigint | string | number,
  c?: bigint | string | number,
  d?: bigint | string | number
): bigint {
  if (Array.isArray(a)) {
    if (a.length !== 4) throw new Error(`poseidon4 requires exactly 4 inputs, got ${a.length}`);
    return Fp.mod(BigInt(_poseidon4(a.map(toFieldElement))));
  }
  if (b === undefined || c === undefined || d === undefined) throw new Error("poseidon4 requires 4 inputs");
  return Fp.mod(BigInt(_poseidon4([toFieldElement(a), toFieldElement(b), toFieldElement(c), toFieldElement(d)])));
}

export function poseidon6(
  a: bigint | string | number | (bigint | string | number)[],
  b?: bigint | string | number,
  c?: bigint | string | number,
  d?: bigint | string | number,
  e?: bigint | string | number,
  f?: bigint | string | number
): bigint {
  if (Array.isArray(a)) {
    if (a.length !== 6) throw new Error(`poseidon6 requires exactly 6 inputs, got ${a.length}`);
    return Fp.mod(BigInt(_poseidon6(a.map(toFieldElement))));
  }
  if (b === undefined || c === undefined || d === undefined || e === undefined || f === undefined) {
    throw new Error("poseidon6 requires 6 inputs");
  }
  return Fp.mod(
    BigInt(
      _poseidon6([
        toFieldElement(a),
        toFieldElement(b),
        toFieldElement(c),
        toFieldElement(d),
        toFieldElement(e),
        toFieldElement(f)
      ])
    )
  );
}

export function poseidon(inputs: (bigint | string | number)[]): bigint {
  if (inputs.length === 0) throw new Error("Poseidon requires at least 1 input");
  const bigInputs = inputs.map(toFieldElement);
  switch (bigInputs.length) {
    case 1:
      return Fp.mod(BigInt(_poseidon1(bigInputs)));
    case 2:
      return Fp.mod(BigInt(_poseidon2(bigInputs)));
    case 3:
      return Fp.mod(BigInt(_poseidon3(bigInputs)));
    case 4:
      return Fp.mod(BigInt(_poseidon4(bigInputs)));
    case 5:
      return Fp.mod(BigInt(_poseidon5(bigInputs)));
    case 6:
      return Fp.mod(BigInt(_poseidon6(bigInputs)));
    default:
      throw new Error(`Unsupported Poseidon arity: ${inputs.length}`);
  }
}
