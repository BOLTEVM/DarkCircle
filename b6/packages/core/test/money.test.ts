import { describe, expect, it } from 'vitest';
import { formatBps, formatQuai, formatUsd, parseQuai, quaiToUsd, settlementFor } from '../src/money.js';

const Q = 10n ** 18n;

describe('settlementFor (mirrors QuestateBrokerage._settle)', () => {
  it('splits a price into commission and seller net, rounding the commission down', () => {
    expect(settlementFor(1000n * Q, 300)).toEqual({ price: 1000n * Q, commission: 30n * Q, sellerNet: 970n * Q });
    // 333 wei at 3%: 9.99 -> 9, the seller keeps the remainder
    expect(settlementFor(333n, 300)).toEqual({ price: 333n, commission: 9n, sellerNet: 324n });
  });

  it('always sums back to the price', () => {
    for (const bps of [0, 1, 250, 999, 1000]) {
      for (const price of [0n, 1n, 9_999n, 123_456_789_012_345_678_901n]) {
        const s = settlementFor(price, bps);
        expect(s.commission + s.sellerNet).toBe(price);
      }
    }
  });

  it('refuses commissions the contract would refuse', () => {
    expect(() => settlementFor(1n, 1001)).toThrow(/between 0 and 1000/);
    expect(() => settlementFor(1n, -1)).toThrow();
    expect(() => settlementFor(1n, 2.5)).toThrow();
  });
});

describe('formatting', () => {
  it('formats QUAI with grouping and trimmed decimals', () => {
    expect(formatQuai(18_500_000n * Q)).toBe('18,500,000');
    expect(formatQuai(15n * Q + Q / 2n)).toBe('15.5');
    expect(formatQuai(0n)).toBe('0');
    expect(formatQuai(-42_000n * Q)).toBe('-42,000');
  });

  it('never shows a non-zero amount as zero', () => {
    expect(formatQuai(1n)).toBe('<0.0001');
  });

  it('parses typed amounts strictly', () => {
    expect(parseQuai('1,250.5')).toBe(1250n * Q + Q / 2n);
    expect(parseQuai(' 7 ')).toBe(7n * Q);
    for (const bad of ['', '-1', '1e3', 'abc', '1.0000000000000000001', '0x10']) expect(parseQuai(bad)).toBeNull();
  });

  it('formats basis points and dollars', () => {
    expect(formatBps(300)).toBe('3%');
    expect(formatBps(250)).toBe('2.50%');
    expect(formatUsd(1234567.8)).toBe('$1,234,568');
    expect(formatUsd(12.345)).toBe('$12.35');
  });

  it('converts to USD only with a usable price', () => {
    expect(quaiToUsd(2n * Q, 0.5)).toBe(1);
    expect(quaiToUsd(2n * Q, null)).toBeNull();
    expect(quaiToUsd(2n * Q, 0)).toBeNull();
    expect(quaiToUsd(2n * Q, Number.NaN)).toBeNull();
  });
});
