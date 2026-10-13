import { describe, expect, it } from 'vitest';
import { checkAddress, sameAddress, shortAddress } from '../src/address.js';

describe('checkAddress (Cyprus-1)', () => {
  it('accepts a Cyprus-1 Quai account and returns it checksummed', () => {
    const res = checkAddress('0x001598ce5966385c9290b1b87079f1be620cf2a2');
    expect(res.ok).toBe(true);
    expect(res.address).toBe('0x001598Ce5966385c9290B1b87079f1bE620CF2A2');
  });

  it('rejects another zone', () => {
    const res = checkAddress('0x1234567890123456789012345678901234567890');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/another Quai zone/);
  });

  it('rejects Qi UTXO addresses (second byte 0x80 and up)', () => {
    const res = checkAddress('0x0080000000000000000000000000000000000001');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Qi/);
  });

  it('rejects a corrupted mixed-case checksum', () => {
    expect(checkAddress('0x001598cE5966385c9290B1b87079f1bE620CF2A2').ok).toBe(false);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', '0x00', 'hello', 42, null, '0x00zz98ce5966385c9290b1b87079f1be620cf2a2']) {
      expect(checkAddress(bad).ok).toBe(false);
    }
  });

  it("lets the local dev chain's 'any' rule through any zone", () => {
    expect(checkAddress('0x1234567890123456789012345678901234567890', 'any').ok).toBe(true);
  });
});

describe('helpers', () => {
  it('compares addresses case-insensitively and never matches empties', () => {
    expect(sameAddress('0xAbC0000000000000000000000000000000000001', '0xabc0000000000000000000000000000000000001')).toBe(true);
    expect(sameAddress(null, null)).toBe(false);
  });

  it('shortens long addresses only', () => {
    expect(shortAddress('0x001598Ce5966385c9290B1b87079f1bE620CF2A2')).toBe('0x0015…F2A2');
    expect(shortAddress('0x1234')).toBe('0x1234');
  });
});
