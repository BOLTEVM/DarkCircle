import crypto from "node:crypto";
import {
  BABYJUBJUB_L,
  GENERATOR,
  mod,
  scalarMult
} from "../crypto/babyjubjub.ts";
import type { Point } from "../types/crypto.ts";
import type { CorporateKeyHierarchy } from "../types/audit.ts";

export type { CorporateKeyHierarchy };

/** Seeds that ship in this repository. They are public, so they must never guard real value. */
export const PUBLIC_DEMO_SEEDS: readonly string[] = [
  "DarkCircle-Enterprise-Treasury-Seed-2026",
  "DarkCircle-Merchant-Master-Key-2026"
];

/** Fresh 256-bit seed as 0x-hex, from the OS CSPRNG. */
export function generateSeed(): string {
  return "0x" + crypto.randomBytes(32).toString("hex");
}

/**
 * Entry-point check for seeds a user supplies. Accepts 0x-hex of at least 32 bytes, a Buffer of at
 * least 32 bytes, or a passphrase of at least 32 characters; refuses the public demo seeds. The KDF
 * itself stays permissive so tests and tooling can derive from small fixtures.
 */
export function assertStrongSeed(seed: Uint8Array | Buffer | string): void {
  if (typeof seed === "string") {
    if (PUBLIC_DEMO_SEEDS.includes(seed)) {
      throw new Error("ERR_SEED_PUBLIC_DEMO: this seed is published in the repository and must not be used for real value");
    }
    if (seed.startsWith("0x")) {
      if (!/^0x[0-9a-fA-F]{64,}$/.test(seed)) {
        throw new Error("ERR_SEED_WEAK: hex seeds must be at least 32 bytes (64 hex digits)");
      }
      return;
    }
    if (seed.length < 32) {
      throw new Error("ERR_SEED_WEAK: passphrase seeds must be at least 32 characters; use generateSeed()");
    }
    return;
  }
  if (seed.length < 32) {
    throw new Error("ERR_SEED_WEAK: byte seeds must be at least 32 bytes");
  }
}

/**
 * Derives the corporate key hierarchy using one-way domain-separated HKDF.
 * Spending key (ssk) and viewing key (vsk) are cryptographically isolated.
 */
export function deriveCorporateKeyHierarchy(
  seed: Uint8Array | Buffer | string
): CorporateKeyHierarchy {
  let seedBuffer: Buffer;
  if (typeof seed === "string") {
    seedBuffer = seed.startsWith("0x")
      ? Buffer.from(seed.slice(2), "hex")
      : Buffer.from(seed, "utf8");
  } else if (Buffer.isBuffer(seed)) {
    seedBuffer = seed;
  } else {
    seedBuffer = Buffer.from(seed);
  }

  // 1. One-way domain-separated HKDF derivation
  const sskBytes = crypto.hkdfSync(
    "sha256",
    seedBuffer,
    Buffer.from("DarkCircle-v1-Domain"),
    Buffer.from("SpendingKey"),
    32
  );
  const vskBytes = crypto.hkdfSync(
    "sha256",
    seedBuffer,
    Buffer.from("DarkCircle-v1-Domain"),
    Buffer.from("ViewingKey"),
    32
  );

  const masterSpendingKey = mod(
    BigInt("0x" + Buffer.from(sskBytes).toString("hex")),
    BABYJUBJUB_L
  );
  const masterViewingKey = mod(
    BigInt("0x" + Buffer.from(vskBytes).toString("hex")),
    BABYJUBJUB_L
  );

  // 2. Derive BabyJubjub curve public points
  const spendingPublicKey = scalarMult(masterSpendingKey, GENERATOR);
  const viewingPublicKey = scalarMult(masterViewingKey, GENERATOR);

  // 3. Construct 0zk Address
  const spkHex =
    spendingPublicKey[0].toString(16).padStart(64, "0") +
    spendingPublicKey[1].toString(16).padStart(64, "0");
  const vpkHex =
    viewingPublicKey[0].toString(16).padStart(64, "0") +
    viewingPublicKey[1].toString(16).padStart(64, "0");
  const corporate0zkAddress = `0zk1q_${spkHex.slice(0, 12)}_${vpkHex.slice(0, 12)}`;

  // 4. Exportable Viewing Key Token (read-only audit credential)
  const viewingKeyToken = Buffer.from(
    JSON.stringify({
      version: "1.0.0",
      vsk: "0x" + masterViewingKey.toString(16).padStart(64, "0"),
      vpk: {
        x: "0x" + viewingPublicKey[0].toString(16).padStart(64, "0"),
        y: "0x" + viewingPublicKey[1].toString(16).padStart(64, "0")
      },
      address: corporate0zkAddress,
      spendingKeyIncluded: false,
      permission: "READ_ONLY_AUDIT"
    })
  ).toString("base64url");

  return {
    masterSpendingKey,
    masterViewingKey,
    spendingPublicKey,
    viewingPublicKey,
    corporate0zkAddress,
    viewingKeyToken
  };
}
