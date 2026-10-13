import { describe, expect, it } from 'vitest';
import { checkAddress } from '../src/address.js';
import { brokerageInterface } from '../src/abi.js';
import { calls, lienTermsFor, offerIsAcceptable } from '../src/brokerage.js';
import { parseParcelGeoJson } from '../src/geo.js';
import { parseListingDetails } from '../src/listingDetails.js';
import { showcaseCatalogue } from '../src/showcase.js';
import { describeLien } from '../src/lien.js';

const NOW = 1_800_000_000;

describe('showcase catalogue', () => {
  const cat = showcaseCatalogue(NOW);

  it('every sample is internally valid, so the site renders it like a real listing', () => {
    expect(cat.listings.length).toBeGreaterThanOrEqual(6);
    for (const l of cat.listings) {
      const d = parseListingDetails(l.detailsRaw, 'x');
      expect(d.malformed, l.detailsRaw).toBe(false);
      expect(d.summary).toMatch(/Sample listing/);
      const deed = cat.deeds.get(l.deedId)!;
      expect(parseParcelGeoJson(deed.record.geoJson).ok, deed.record.parcelId).toBe(true);
      expect(deed.record.parcelId.startsWith('SAMPLE-')).toBe(true);
      expect(cat.brokers.some((b) => b.address === l.broker)).toBe(true);
    }
  });

  it('uses synthetic Cyprus-1 addresses that are zeros plus a short tag', () => {
    const all = [...cat.listings.flatMap((l) => [l.seller, l.broker, l.buyer ?? l.seller]), ...cat.offers.map((o) => o.buyer)];
    for (const a of all) {
      expect(checkAddress(a).ok).toBe(true);
      expect(a.slice(2, 34)).toBe('0'.repeat(32));
    }
  });

  it('covers the states the UI must handle: open offers, a lien, a credit, a sale', () => {
    expect(cat.offers.some((o) => offerIsAcceptable(o, NOW))).toBe(true);
    expect(cat.listings.some((l) => l.status === 'sold')).toBe(true);
    const states = [...cat.deeds.values()].map((d) => describeLien(d.debt).state);
    expect(states).toEqual(expect.arrayContaining(['clear', 'lien', 'credit']));
  });
});

describe('calldata', () => {
  const d = { deed: '0x0000000000000000000000000000000000005d0d', brokerage: '0x0000000000000000000000000000000000005d0e' };

  it('buy accepts exactly the recorded lien, and no lien when there is a credit', () => {
    const lien = { token: '0x0000000000000000000000000000000000000000', amount: 42n, foreclosed: false };
    const tx = calls.buy(d, 3n, 1000n, lien);
    expect(tx.value).toBe(1000n);
    const args = brokerageInterface.decodeFunctionData('buy', tx.data);
    expect([args[0], args[2]]).toEqual([3n, 42n]);
    expect(lienTermsFor({ ...lien, amount: -5n })).toEqual({ debtToken: lien.token, maxDebt: 0n });
  });

  it('makeOffer carries the deposit as value and the expiry as uint64', () => {
    const tx = calls.makeOffer(d, 1n, 77n, NOW + 3600, { token: d.deed, amount: 0n, foreclosed: false });
    expect(tx.to).toBe(d.brokerage);
    expect(tx.value).toBe(77n);
    expect(brokerageInterface.decodeFunctionData('makeOffer', tx.data)[1]).toBe(BigInt(NOW + 3600));
  });

  it('expired or settled offers are not acceptable', () => {
    const o = { id: 1n, listingId: 1n, buyer: d.deed, expiresAt: NOW, status: 'open' as const, amount: 1n, debtToken: d.deed, maxDebt: 0n };
    expect(offerIsAcceptable(o, NOW)).toBe(true);
    expect(offerIsAcceptable(o, NOW + 1)).toBe(false);
    expect(offerIsAcceptable({ ...o, status: 'withdrawn' }, NOW)).toBe(false);
  });
});
