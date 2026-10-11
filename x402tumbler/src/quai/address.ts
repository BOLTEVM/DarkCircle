/**
 * DarkCircle: Quai address rules
 * File: src/quai/address.ts
 *
 * A Quai address is a 20-byte secp256k1/Keccak address with two extra constraints:
 *   - byte 0 selects the zone (0x00 = Cyprus-1 ... 0x22 = Hydra-3). A zone RPC rejects every other
 *     first byte with "Address belongs to other zone".
 *   - the top bit of byte 1 selects the ledger: 0 = Quai (account/EVM ledger), 1 = Qi (UTXO ledger).
 *     WQUAI, WQI and every ERC-20 balance live on the Quai ledger, so a payee address for a
 *     WQUAI/WQI x402 payment must have that bit clear.
 * Zone RPCs also require checksummed (EIP-55) addresses; an all-lowercase address is refused.
 */

import { getAddress } from "ethers";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { QUAI_ZONES, DEFAULT_QUAI_NETWORK, type QuaiNetwork, type QuaiZone } from "./networks.ts";

export type QuaiLedger = "quai" | "qi";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** True for any 0x-prefixed 20-byte hex string, regardless of zone or checksum. */
export function isHexAddress(value: unknown): value is string {
  return typeof value === "string" && HEX_ADDRESS.test(value);
}

/**
 * Returns the EIP-55 checksummed form. All-lowercase and all-uppercase input is accepted and
 * normalized; mixed-case input must carry a correct checksum.
 */
export function toQuaiChecksum(address: string): string {
  if (!isHexAddress(address)) {
    throw new Error(`ERR_QUAI_ADDRESS_INVALID: '${address}' is not a 20-byte hex address`);
  }
  try {
    return getAddress(address);
  } catch {
    throw new Error(`ERR_QUAI_ADDRESS_INVALID: '${address}' has an invalid checksum`);
  }
}

export function getAddressZone(address: string): QuaiZone | undefined {
  if (!isHexAddress(address)) return undefined;
  const first = parseInt(address.slice(2, 4), 16);
  return QUAI_ZONES.find((z) => z.prefix === first);
}

export function getAddressLedger(address: string): QuaiLedger {
  if (!isHexAddress(address)) {
    throw new Error(`ERR_QUAI_ADDRESS_INVALID: '${address}' is not a 20-byte hex address`);
  }
  return (parseInt(address.slice(4, 6), 16) & 0x80) === 0x80 ? "qi" : "quai";
}

export function isQiAddress(address: string): boolean {
  return getAddressLedger(address) === "qi";
}

export function isQuaiAddress(address: string): boolean {
  return getAddressLedger(address) === "quai";
}

export function isAddressInZone(address: string, zone: QuaiZone): boolean {
  return isHexAddress(address) && parseInt(address.slice(2, 4), 16) === zone.prefix;
}

/**
 * Validates an address that will receive or hold a Quai-ledger ERC-20 (WQUAI / WQI) on `network`
 * and returns it checksummed. Throws a coded error otherwise:
 *   ERR_QUAI_ADDRESS_INVALID | ERR_QUAI_ADDRESS_WRONG_ZONE | ERR_QUAI_ADDRESS_QI_LEDGER
 */
export function assertQuaiPaymentAddress(
  address: string,
  network: QuaiNetwork = DEFAULT_QUAI_NETWORK
): string {
  const checksummed = toQuaiChecksum(address);
  if (!isAddressInZone(checksummed, network.zone)) {
    const actual = getAddressZone(checksummed);
    throw new Error(
      `ERR_QUAI_ADDRESS_WRONG_ZONE: ${checksummed} ${
        actual ? `belongs to ${actual.name}` : "belongs to no known zone"
      }, not ${network.zone.name} (0x${network.zone.byte})`
    );
  }
  if (isQiAddress(checksummed)) {
    throw new Error(
      `ERR_QUAI_ADDRESS_QI_LEDGER: ${checksummed} is a Qi-ledger (UTXO) address and cannot hold ERC-20 balances`
    );
  }
  return checksummed;
}

export function isValidQuaiPaymentAddress(
  address: string,
  network: QuaiNetwork = DEFAULT_QUAI_NETWORK
): boolean {
  try {
    assertQuaiPaymentAddress(address, network);
    return true;
  } catch {
    return false;
  }
}

/** Address of a secp256k1 private key (same derivation as an EVM address; zone is NOT enforced). */
export function addressFromPrivateKey(privateKeyHex: string): string {
  const point = secp256k1.ProjectivePoint.BASE.multiply(BigInt(privateKeyHex));
  return addressFromPoint(point);
}

function addressFromPoint(point: InstanceType<typeof secp256k1.ProjectivePoint>): string {
  const uncompressed = point.toRawBytes(false); // 0x04 || X || Y
  const hash = keccak_256(uncompressed.subarray(1));
  return getAddress("0x" + Buffer.from(hash.subarray(12)).toString("hex"));
}

export interface GroundQuaiKey {
  privateKey: string;
  address: string;
  attempts: number;
}

export const MAX_ZONE_GRIND_ATTEMPTS = 1 << 18;

/**
 * Finds a private key whose address falls in `zone` on `ledger`, starting from `seed` and
 * stepping the key by +1 (adding the generator point each step, so one scalar multiplication
 * total). Deterministic for a given seed. A zone hit is 1 in 256 and a ledger hit 1 in 2, so the
 * expected cost is ~512 steps; failing MAX_ZONE_GRIND_ATTEMPTS steps has probability ~e^-512.
 */
export function grindQuaiKey(
  seed: bigint | string,
  zone: QuaiZone = DEFAULT_QUAI_NETWORK.zone,
  ledger: QuaiLedger = "quai"
): GroundQuaiKey {
  const n = secp256k1.CURVE.n;
  let k = (typeof seed === "bigint" ? seed : BigInt(seed)) % n;
  if (k === 0n) k = 1n;
  const G = secp256k1.ProjectivePoint.BASE;
  let point = G.multiply(k);
  const wantQi = ledger === "qi";

  for (let attempts = 1; attempts <= MAX_ZONE_GRIND_ATTEMPTS; attempts++) {
    const raw = point.toRawBytes(false);
    const hash = keccak_256(raw.subarray(1));
    const b0 = hash[12];
    const b1 = hash[13];
    if (b0 === zone.prefix && ((b1 & 0x80) === 0x80) === wantQi) {
      return {
        privateKey: "0x" + k.toString(16).padStart(64, "0"),
        address: getAddress("0x" + Buffer.from(hash.subarray(12)).toString("hex")),
        attempts
      };
    }
    k = k + 1n >= n ? 1n : k + 1n;
    point = point.add(G);
    if (k === 1n) point = G;
  }
  throw new Error(`ERR_QUAI_ZONE_GRIND_EXHAUSTED: no ${zone.name}/${ledger} key found`);
}
