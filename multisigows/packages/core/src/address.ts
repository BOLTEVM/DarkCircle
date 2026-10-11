import { keccak256, toUtf8Bytes } from 'ethers';

/**
 * Cyprus-1 Shard constant identifiers.
 * In Quai Network, Region 0 (Cyprus) and Zone 0 (Cyprus-1) map strictly to prefix byte 0x00:
 * prefix_byte = (region_index << 4) | zone_index = (0 << 4) | 0 = 0x00.
 */
export const CYPRUS_1_PREFIX = 0x00;
export const CYPRUS_1_PREFIX_HEX = '00';

export interface Cyprus1AddressValidationResult {
  isValid: boolean;
  valid: boolean;
  checksumAddress?: string;
  checksummed?: string;
  error?: string;
}

export interface AddressValidationOptions {
  strictChecksum?: boolean;
}

/**
 * Computes canonical EIP-55 checksum for a 20-byte address.
 * Keccak-256 hash of lowercase hex string without 0x prefix.
 * Uppercases letter i if the i-th nibble of hash >= 8.
 */
export function computeEip55Checksum(address: string): string {
  const clean = address.startsWith('0x') || address.startsWith('0X') ? address.slice(2) : address;
  const lower = clean.toLowerCase();
  const hash = keccak256(toUtf8Bytes(lower)).slice(2);

  let checksummed = '0x';
  for (let i = 0; i < lower.length; i++) {
    const char = lower[i]!;
    if (/[0-9]/.test(char)) {
      checksummed += char;
    } else {
      const hashNibble = parseInt(hash[i]!, 16);
      checksummed += hashNibble >= 8 ? char.toUpperCase() : char.toLowerCase();
    }
  }
  return checksummed;
}

/**
 * Converts a raw Cyprus-1 address into its canonical EIP-55 checksum format.
 * Throws if the address does not belong to Cyprus-1 or is malformed.
 */
export function toCyprus1ChecksumAddress(raw: string): string {
  const result = validateCyprus1Address(raw);
  if (!result.isValid || !result.checksumAddress) {
    throw new Error(`Cannot checksum invalid Cyprus-1 address "${raw}": ${result.error}`);
  }
  return result.checksumAddress;
}

/**
 * Alias for toCyprus1ChecksumAddress.
 */
export const formatCyprus1Address = toCyprus1ChecksumAddress;

/**
 * Validates whether an address string is a valid Quai Cyprus-1 address.
 * Checks:
 * 1. String type and existence
 * 2. Starts with '0x' or '0X' prefix
 * 3. Exactly 42 characters long (0x + 40 hex digits)
 * 4. Hexadecimal characters only
 * 5. First byte after 0x is strictly '00' (Cyprus-1 execution zone)
 * 6. EIP-55 checksum validity (rejects corrupted mixed-case checksums)
 */
export function validateCyprus1Address(
  address: unknown,
  options?: AddressValidationOptions
): Cyprus1AddressValidationResult {
  if (typeof address !== 'string') {
    return { isValid: false, valid: false, error: 'Address must be a string' };
  }

  const trimmed = address.trim();

  if (!trimmed.startsWith('0x') && !trimmed.startsWith('0X')) {
    return { isValid: false, valid: false, error: "Address must start with '0x' prefix." };
  }

  if (trimmed.length !== 42) {
    return {
      isValid: false,
      valid: false,
      error: `Address must be exactly 42 characters long (including '0x' prefix). Received ${trimmed.length} characters.`
    };
  }

  const hexBody = trimmed.slice(2);
  if (!/^[0-9a-fA-F]{40}$/.test(hexBody)) {
    return {
      isValid: false,
      valid: false,
      error: 'Address contains invalid non-hexadecimal characters.'
    };
  }

  const prefixByte = hexBody.slice(0, 2).toLowerCase();
  if (prefixByte !== CYPRUS_1_PREFIX_HEX) {
    return {
      isValid: false,
      valid: false,
      error: `Address prefix "0x${prefixByte}" does not belong to Cyprus-1 zone. Cyprus-1 addresses must strictly begin with "0x00".`
    };
  }

  const checksummed = computeEip55Checksum(trimmed);
  const hasUpper = /[A-F]/.test(hexBody);
  const hasLower = /[a-f]/.test(hexBody);
  const isMixedCase = hasUpper && hasLower;

  if (isMixedCase && trimmed !== checksummed) {
    return {
      isValid: false,
      valid: false,
      error: `Address has invalid EIP-55 checksum. Expected "${checksummed}", got "${trimmed}".`
    };
  }

  if (options?.strictChecksum && trimmed !== checksummed) {
    return {
      isValid: false,
      valid: false,
      error: `Address is not formatted with EIP-55 checksum. Expected "${checksummed}".`
    };
  }

  return {
    isValid: true,
    valid: true,
    checksumAddress: checksummed,
    checksummed
  };
}

/**
 * Returns true if the address is a valid Cyprus-1 address.
 */
export function isCyprus1Address(address: string, strictChecksum: boolean = false): boolean {
  return validateCyprus1Address(address, { strictChecksum }).isValid;
}

/**
 * Returns true if the address is a Quai (EVM / account-based) address.
 * In Quai Network, the second byte's MSB determines address type:
 *   MSB = 0 (< 0x80) -> Quai account-based EVM address
 *   MSB = 1 (>= 0x80) -> Qi UTXO address
 */
export function isQuaiEvmAddress(address: string): boolean {
  const val = validateCyprus1Address(address);
  if (!val.isValid) return false;
  const secondByte = parseInt(address.slice(4, 6), 16);
  return !isNaN(secondByte) && secondByte < 0x80;
}

/**
 * Returns true if the address is a Qi (UTXO) address.
 * Second byte MSB = 1 (>= 0x80).
 */
export function isQiUtxoAddress(address: string): boolean {
  const val = validateCyprus1Address(address);
  if (!val.isValid) return false;
  const secondByte = parseInt(address.slice(4, 6), 16);
  return !isNaN(secondByte) && secondByte >= 0x80;
}
