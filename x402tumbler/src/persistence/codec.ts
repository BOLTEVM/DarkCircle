/**
 * DarkCircle: tagged JSON codec
 * File: src/persistence/codec.ts
 *
 * The simulation's state is made of bigints, Maps, Sets and byte arrays, none of which survive
 * JSON.stringify. This codec writes them as tagged objects ({"$":"b","v":"123"}) and reads them back
 * exactly. It only accepts plain data: a class instance, function, symbol or non-finite number is an error
 * rather than something silently dropped, because a snapshot that quietly loses a field is worse than none.
 */

export type Encoded = null | boolean | number | string | Encoded[] | { [key: string]: Encoded };

const TAG = "$";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function encode(value: unknown, path = "$"): Encoded {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`ERR_CODEC_NON_FINITE_NUMBER at ${path}`);
      return value;
    case "bigint":
      return { [TAG]: "b", v: value.toString() };
    case "undefined":
      return { [TAG]: "u" };
    case "object":
      break;
    default:
      throw new Error(`ERR_CODEC_UNSUPPORTED_TYPE ${typeof value} at ${path}`);
  }
  if (Array.isArray(value)) return value.map((x, i) => encode(x, `${path}[${i}]`));
  if (value instanceof Map) {
    return { [TAG]: "m", v: [...value.entries()].map(([k, x], i) => [encode(k, `${path}<key ${i}>`), encode(x, `${path}<${String(k)}>`)]) };
  }
  if (value instanceof Set) return { [TAG]: "s", v: [...value.values()].map((x, i) => encode(x, `${path}{${i}}`)) };
  if (value instanceof Uint8Array) return { [TAG]: "x", v: Buffer.from(value).toString("hex") };
  if (!isPlainObject(value)) throw new Error(`ERR_CODEC_UNSUPPORTED_OBJECT at ${path} (${(value as object).constructor?.name ?? "unknown"})`);
  if (TAG in value) throw new Error(`ERR_CODEC_RESERVED_KEY at ${path}`);
  const out: { [key: string]: Encoded } = {};
  for (const [k, x] of Object.entries(value)) out[k] = encode(x, `${path}.${k}`);
  return out;
}

export function decode(value: Encoded): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  const tag = (value as { [key: string]: Encoded })[TAG];
  if (tag !== undefined) {
    const v = (value as { [key: string]: Encoded }).v;
    switch (tag) {
      case "b":
        if (typeof v !== "string" || !/^-?\d+$/.test(v)) throw new Error("ERR_CODEC_BAD_BIGINT");
        return BigInt(v);
      case "u":
        return undefined;
      case "m":
        if (!Array.isArray(v)) throw new Error("ERR_CODEC_BAD_MAP");
        return new Map((v as Encoded[][]).map(([k, x]) => [decode(k), decode(x)]));
      case "s":
        if (!Array.isArray(v)) throw new Error("ERR_CODEC_BAD_SET");
        return new Set((v as Encoded[]).map(decode));
      case "x":
        if (typeof v !== "string" || !/^([0-9a-f]{2})*$/.test(v)) throw new Error("ERR_CODEC_BAD_BYTES");
        return new Uint8Array(Buffer.from(v, "hex"));
      default:
        throw new Error(`ERR_CODEC_UNKNOWN_TAG ${String(tag)}`);
    }
  }
  const out: Record<string, unknown> = {};
  // defineProperty, not assignment: a key named "__proto__" must become an ordinary field, never the
  // prototype of the decoded object.
  for (const [k, x] of Object.entries(value)) Object.defineProperty(out, k, { value: decode(x), enumerable: true, writable: true, configurable: true });
  return out;
}

/** Deterministic JSON: object keys sorted, so the same state always hashes the same. */
export function canonicalJson(value: Encoded): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as { [key: string]: Encoded })[k])}`).join(",")}}`;
}
