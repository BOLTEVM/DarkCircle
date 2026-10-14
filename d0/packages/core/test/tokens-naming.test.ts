import { describe, expect, it } from 'vitest';
import { formatTokenAmount, parseTokenAmount, tokenByAddress, tokenBySymbol, WQUAI } from '../src/tokens.js';
import { normalizeQnsName, qnsClaimKind, qnsProfileUrl, qnsSearchUrl, resolveQnsName } from '../src/naming.js';
import { checkAddress, shortAddress } from '../src/address.js';

describe('tokens', () => {
  it('parses and formats amounts without floats', () => {
    expect(parseTokenAmount('5', 18)).toBe(5_000_000_000_000_000_000n);
    expect(parseTokenAmount('0.5', 18)).toBe(500_000_000_000_000_000n);
    expect(formatTokenAmount(5_000_000_000_000_000_000n, 18)).toBe('5');
    expect(formatTokenAmount(500_000_000_000_000_000n, 18)).toBe('0.5');
    expect(formatTokenAmount(1_234_567_890_000_000_000n, 18)).toBe('1.23456789');
    expect(() => parseTokenAmount('1.2.3', 18)).toThrow();
    expect(() => parseTokenAmount('-5', 18)).toThrow();
  });

  it('looks tokens up by address regardless of case', () => {
    expect(tokenByAddress('mainnet', WQUAI.address)?.symbol).toBe('WQUAI');
    expect(tokenByAddress('mainnet', WQUAI.address.toLowerCase())?.symbol).toBe('WQUAI');
    expect(tokenByAddress('orchard', WQUAI.address)).toBeNull(); // WQUAI is mainnet-only
    expect(tokenBySymbol('orchard', 'wqi')?.symbol).toBe('WQI');
  });
});

describe('QNS naming', () => {
  it('normalizes .quai names', () => {
    expect(normalizeQnsName('Emberhold')).toEqual({ name: 'emberhold', fqdn: 'emberhold.quai' });
    expect(normalizeQnsName('iron-council.quai')).toEqual({ name: 'iron-council', fqdn: 'iron-council.quai' });
    expect(normalizeQnsName('not a name')).toBeNull();
    expect(normalizeQnsName('')).toBeNull();
  });

  it('classifies claim kinds by length', () => {
    expect(qnsClaimKind('emberhold.quai')).toBe('instant');
    expect(qnsClaimKind('iron.quai')).toBe('auction');
    expect(qnsClaimKind('veil.quai')).toBe('auction');
    expect(qnsClaimKind('ash.quai')).toBe('premium');
  });

  it('builds quaidomains.com deep links', () => {
    expect(qnsSearchUrl('emberhold')).toBe('https://www.quaidomains.com/?q=emberhold');
    expect(qnsProfileUrl('emberhold.quai')).toBe('https://www.quaidomains.com/name/emberhold.quai');
  });

  it('reports resolution as unconfigured until a QNNS registry is pinned', async () => {
    expect(await resolveQnsName(null, 'emberhold')).toEqual({ ok: false, reason: 'unconfigured' });
    expect(await resolveQnsName(undefined, 'not a name')).toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('Cyprus-1 addresses', () => {
  it('accepts Cyprus-1 Quai account addresses', () => {
    const r = checkAddress('0x00112233445566778899aabbccddeeff00112233', 'cyprus1');
    expect(r.ok).toBe(true);
  });

  it('rejects other zones and Qi UTXO addresses', () => {
    expect(checkAddress('0x10112233445566778899aabbccddeeff00112233', 'cyprus1').ok).toBe(false);
    expect(checkAddress('0x00812233445566778899aabbccddeeff00112233', 'cyprus1').ok).toBe(false);
    expect(checkAddress('0x00112233445566778899aabbccddeeff0011223', 'cyprus1').ok).toBe(false);
  });

  it('shortens addresses for display', () => {
    expect(shortAddress('0x00112233445566778899aabbccddeeff00112233')).toBe('0x0011…2233');
  });
});
