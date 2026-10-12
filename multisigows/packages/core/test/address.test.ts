import { describe, it, expect } from 'vitest';
import {
  CYPRUS_1_PREFIX,
  CYPRUS_1_PREFIX_HEX,
  validateCyprus1Address,
  computeEip55Checksum,
  toCyprus1ChecksumAddress,
  formatCyprus1Address,
  isCyprus1Address,
  isQuaiEvmAddress,
  isQiUtxoAddress
} from '../src/address.js';

describe('@darksafe/core: address module', () => {
  const validEvmAddress = '0x00eDf2d16AfbC028FB1e879559b07997Af79539f';
  const validUtxoAddress = '0x0093F3c023941CB49cb19e76C465168e19d2C428';

  it('exports correct constants', () => {
    expect(CYPRUS_1_PREFIX).toBe(0x00);
    expect(CYPRUS_1_PREFIX_HEX).toBe('00');
  });

  it('validates a valid checksummed Cyprus-1 address', () => {
    const res = validateCyprus1Address(validEvmAddress);
    expect(res.isValid).toBe(true);
    expect(res.valid).toBe(true);
    expect(res.checksumAddress).toBe(validEvmAddress);
    expect(res.error).toBeUndefined();
    expect(isCyprus1Address(validEvmAddress)).toBe(true);
  });

  it('validates and checksums an all-lowercase Cyprus-1 address', () => {
    const rawLower = validEvmAddress.toLowerCase();
    const res = validateCyprus1Address(rawLower);
    expect(res.isValid).toBe(true);
    expect(res.checksumAddress).toBe(validEvmAddress);
    expect(isCyprus1Address(rawLower)).toBe(true);
  });

  it('computes canonical EIP-55 checksum', () => {
    const computed = computeEip55Checksum(validEvmAddress.toLowerCase());
    expect(computed).toBe(validEvmAddress);

    const converted = toCyprus1ChecksumAddress(validEvmAddress.toLowerCase());
    expect(converted).toBe(validEvmAddress);
    expect(formatCyprus1Address(validEvmAddress.toLowerCase())).toBe(validEvmAddress);
  });

  it('rejects invalid inputs: non-string, missing prefix, wrong length, non-hex', () => {
    expect(validateCyprus1Address(null).isValid).toBe(false);
    expect(validateCyprus1Address(undefined).isValid).toBe(false);
    expect(validateCyprus1Address(12345).isValid).toBe(false);
    expect(validateCyprus1Address('not an address').isValid).toBe(false);

    // Missing 0x prefix
    expect(validateCyprus1Address('00edf2d16afbc028fb1e879559b07997af79539f').isValid).toBe(false);

    // Wrong length
    expect(validateCyprus1Address('0x00edf2d16afbc028fb1e879559b07997af7953').isValid).toBe(false);
    expect(validateCyprus1Address('0x00edf2d16afbc028fb1e879559b07997af79539f12').isValid).toBe(false);

    // Non-hex character
    expect(validateCyprus1Address('0x00edf2d16afbc028fb1e879559b07997af79539z').isValid).toBe(false);
  });

  it('rejects addresses not belonging to Cyprus-1 zone (prefix != 0x00)', () => {
    // Prefix 0x01 (Cyprus-2)
    const cyprus2 = '0x01eDf2d16AfbC028FB1e879559b07997Af79539f';
    const res = validateCyprus1Address(cyprus2);
    expect(res.isValid).toBe(false);
    expect(res.error).toContain('Cyprus-1 addresses must strictly begin with "0x00"');
    expect(isCyprus1Address(cyprus2)).toBe(false);

    // Ethereum address (e.g. 0x90...)
    const ethAddress = '0x9060b298D41C48d203975a5e305e5331fA7B58f0';
    expect(validateCyprus1Address(ethAddress).isValid).toBe(false);
    expect(isCyprus1Address(ethAddress)).toBe(false);
  });

  it('rejects corrupted mixed-case checksum', () => {
    // Invert first letter casing: 'e' -> 'E' instead of 'e'
    const corrupted = '0x00EdF2d16AfbC028FB1e879559b07997Af79539f';
    const res = validateCyprus1Address(corrupted);
    expect(res.isValid).toBe(false);
    expect(res.error).toContain('Address has invalid EIP-55 checksum');
  });

  it('enforces strictChecksum option when requested', () => {
    const rawLower = validEvmAddress.toLowerCase();
    const resStrict = validateCyprus1Address(rawLower, { strictChecksum: true });
    expect(resStrict.isValid).toBe(false);
    expect(resStrict.error).toContain('Address is not formatted with EIP-55 checksum');

    const resNonStrict = validateCyprus1Address(rawLower, { strictChecksum: false });
    expect(resNonStrict.isValid).toBe(true);
  });

  it('accurately distinguishes Quai EVM addresses from Qi UTXO addresses', () => {
    // EVM: second byte (chars index 4,5) < 0x80
    // 0x00eD... second byte is 0xed >= 0x80 -> UTXO!
    // 0x0049... second byte is 0x49 < 0x80 -> EVM!
    const evmAccount = '0x0049CdA3305ccB9cB23E7Ce2528ceF555E9a5B32';
    expect(isQuaiEvmAddress(evmAccount)).toBe(true);
    expect(isQiUtxoAddress(evmAccount)).toBe(false);

    // UTXO: second byte >= 0x80
    // 0x0093... second byte is 0x93 >= 0x80 -> UTXO!
    expect(isQiUtxoAddress(validUtxoAddress)).toBe(true);
    expect(isQuaiEvmAddress(validUtxoAddress)).toBe(false);

    // Invalid addresses return false for both
    expect(isQuaiEvmAddress('invalid')).toBe(false);
    expect(isQiUtxoAddress('invalid')).toBe(false);
  });
});
