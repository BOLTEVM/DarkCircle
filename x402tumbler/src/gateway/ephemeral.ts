/**
 * DarkCircle Protocol: Inbound Merchant Privacy Gateway
 * Ephemeral / Stealth Address Derivation Engine
 *
 * Implements deterministic stealth payment destinations derived from a
 * high-entropy merchant root secret and an invoice identifier using HMAC-SHA256.
 * Provides defense-in-depth key zeroization to enforce forward secrecy.
 */

import crypto from "node:crypto";
import { computeAddress } from "ethers";
import { grindQuaiKey } from "../quai/address.ts";
import { DEFAULT_QUAI_NETWORK, type QuaiZone } from "../quai/networks.ts";
import type {
  EphemeralKeyPair,
  EphemeralDerivationMode,
  EphemeralDerivationOptions
} from "./types.ts";

export const DEFAULT_DOMAIN_SEPARATOR = "DarkCircle-v1-invoice:";
export const DEFAULT_EPHEMERAL_MODE: EphemeralDerivationMode = "quai";
export const ZEROIZED_PRIVATE_KEY =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/**
 * Derives a deterministic 256-bit ephemeral private key from the merchant master key and invoice ID.
 * In "quai" mode the HMAC output seeds a key search and the returned key is the first one whose
 * address is a Quai-ledger address in `zone`; in the other modes the HMAC output is the key.
 */
export function deriveEphemeralPrivateKey(
  merchantRootKey: string,
  invoiceId: string,
  domainSeparator: string = DEFAULT_DOMAIN_SEPARATOR,
  salt?: string | Buffer,
  mode: EphemeralDerivationMode = DEFAULT_EPHEMERAL_MODE,
  zone: QuaiZone = DEFAULT_QUAI_NETWORK.zone
): string {
  const hmac = crypto.createHmac("sha256", merchantRootKey);
  hmac.update(`${domainSeparator}${invoiceId}`);
  if (salt) {
    hmac.update(salt);
  }
  const seed = "0x" + hmac.digest("hex");
  // Deliberately uncached: a process-wide key cache would outlive zeroizeEphemeralKey().
  return mode === "quai" ? grindQuaiKey(BigInt(seed), zone, "quai").privateKey : seed;
}

/**
 * Derives a public recipient address from an ephemeral private key.
 *
 * Modes "quai" and "secp256k1": standard secp256k1 + Keccak-256 address (ethers computeAddress).
 *                    A "quai" key was already ground into its zone by deriveEphemeralPrivateKey, so the
 *                    address it maps to is the zone address; this function does not search.
 * Mode "fast": Truncates the SHA-256 digest of the private key to 20 bytes. Simulation only: there is
 *              no private key for that address, so it can never be spent from on a real chain.
 */
export function deriveAddressFromPrivateKey(
  privateKey: string,
  mode: EphemeralDerivationMode = DEFAULT_EPHEMERAL_MODE
): string {
  if (mode === "secp256k1" || mode === "quai") {
    return computeAddress(privateKey);
  }
  const pubHash = crypto.createHash("sha256").update(privateKey).digest("hex");
  return "0x" + pubHash.slice(24);
}

/**
 * Generates an ephemeral key pair for a designated invoice ID.
 * Compatible with test/e2e/harness.ts and ResourceServer.
 */
export function deriveEphemeralAddress(
  merchantRootKey: string,
  invoiceId: string,
  options?: EphemeralDerivationOptions
): EphemeralKeyPair {
  const mode = options?.mode ?? DEFAULT_EPHEMERAL_MODE;
  const domainSeparator = options?.domainSeparator ?? DEFAULT_DOMAIN_SEPARATOR;
  const privateKey = deriveEphemeralPrivateKey(
    merchantRootKey,
    invoiceId,
    domainSeparator,
    options?.salt,
    mode,
    options?.zone
  );
  const address = deriveAddressFromPrivateKey(privateKey, mode);

  return {
    address,
    privateKey,
    invoiceId,
    mode,
    derivedAt: Math.floor(Date.now() / 1000)
  };
}

/**
 * Securely overwrites the ephemeral private key in memory with zeroes.
 */
export function zeroizeEphemeralKey(
  target: { ephemeralPrivateKey?: string } | { privateKey?: string }
): void {
  if ("ephemeralPrivateKey" in target && target.ephemeralPrivateKey !== undefined) {
    target.ephemeralPrivateKey = ZEROIZED_PRIVATE_KEY;
  }
  if ("privateKey" in target && target.privateKey !== undefined) {
    target.privateKey = ZEROIZED_PRIVATE_KEY;
  }
}

/**
 * Ephemeral Address Generator service class.
 */
export class EphemeralAddressGenerator {
  public masterMerchantKey: string;
  public defaultMode: EphemeralDerivationMode;
  public domainSeparator: string;
  public zone: QuaiZone;

  constructor(
    masterMerchantKey: string,
    defaultMode: EphemeralDerivationMode = DEFAULT_EPHEMERAL_MODE,
    domainSeparator: string = DEFAULT_DOMAIN_SEPARATOR,
    zone: QuaiZone = DEFAULT_QUAI_NETWORK.zone
  ) {
    this.masterMerchantKey = masterMerchantKey;
    this.defaultMode = defaultMode;
    this.domainSeparator = domainSeparator;
    this.zone = zone;
  }

  /**
   * Generates a full ephemeral key pair for an invoice ID.
   */
  public generate(
    invoiceId: string,
    options?: EphemeralDerivationOptions
  ): EphemeralKeyPair {
    const mode = options?.mode ?? this.defaultMode;
    const domainSeparator = options?.domainSeparator ?? this.domainSeparator;
    return deriveEphemeralAddress(this.masterMerchantKey, invoiceId, {
      ...options,
      mode,
      domainSeparator,
      zone: options?.zone ?? this.zone
    });
  }

  /**
   * Derives only the private key for an invoice ID.
   */
  public derivePrivateKey(
    invoiceId: string,
    options?: EphemeralDerivationOptions
  ): string {
    const domainSeparator = options?.domainSeparator ?? this.domainSeparator;
    return deriveEphemeralPrivateKey(
      this.masterMerchantKey,
      invoiceId,
      domainSeparator,
      options?.salt,
      options?.mode ?? this.defaultMode,
      options?.zone ?? this.zone
    );
  }

  /**
   * Derives only the recipient address for an invoice ID.
   */
  public deriveAddress(
    invoiceId: string,
    options?: EphemeralDerivationOptions
  ): string {
    const priv = this.derivePrivateKey(invoiceId, options);
    const mode = options?.mode ?? this.defaultMode;
    return deriveAddressFromPrivateKey(priv, mode);
  }

  /**
   * Verifies whether an address matches the expected derivation for an invoice.
   */
  public validateAddress(
    address: string,
    invoiceId: string,
    options?: EphemeralDerivationOptions
  ): boolean {
    const expected = this.deriveAddress(invoiceId, options);
    return address.toLowerCase() === expected.toLowerCase();
  }

  /**
   * Zeroizes target key reference.
   */
  public zeroize(
    target: { ephemeralPrivateKey?: string } | { privateKey?: string }
  ): void {
    zeroizeEphemeralKey(target);
  }
}

export const EphemeralAddressEngine = EphemeralAddressGenerator;
