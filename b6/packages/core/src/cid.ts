import { sha256 } from 'ethers';

/**
 * Content addressing for deed metadata.
 *
 * The b6 build "pinned" metadata by printing a made-up `bafy…` string: not a CID of anything,
 * and never uploaded. This module computes the real CIDv0 that `ipfs add --only-hash`
 * prints for the same bytes (verified against IPFS's own vectors in test/cid.test.ts), so the
 * metadata URI on a deed actually identifies the document. Uploading the document is a separate,
 * deliberate step for the registrar; nothing here claims it happened.
 *
 * Ported from Beam's contract-metadata helper.
 */

/** A file at most this big is a single chunk in IPFS's default chunker. */
export const IPFS_SINGLE_CHUNK_MAX_BYTES = 262_144;

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58[digits[i]!];
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
  return out;
}

/** CIDv0 of a single-chunk file: base58btc of the sha2-256 multihash of its dag-pb/UnixFS leaf. */
export function ipfsCidV0(data: Uint8Array): string {
  if (data.length > IPFS_SINGLE_CHUNK_MAX_BYTES) {
    throw new Error(`The document is ${data.length} bytes; the CIDv0 helper supports at most ${IPFS_SINGLE_CHUNK_MAX_BYTES}.`);
  }
  const unixfs: number[] = [0x08, 0x02]; // Data { Type: File }
  if (data.length > 0) unixfs.push(0x12, ...varint(data.length), ...data);
  unixfs.push(0x18, ...varint(data.length)); // filesize
  const node = new Uint8Array([0x0a, ...varint(unixfs.length), ...unixfs]); // PBNode { Data }
  const digest = hexToBytes(sha256(node));
  return base58(new Uint8Array([0x12, 0x20, ...digest]));
}

/** Stable JSON: keys sorted at every depth, so the same content is always the same bytes and CID. */
export function canonicalJson(value: unknown, indent = 2): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(o)
          .sort()
          .map((k) => [k, sort(o[k])])
      );
    }
    return v;
  };
  return JSON.stringify(sort(value), null, indent);
}
