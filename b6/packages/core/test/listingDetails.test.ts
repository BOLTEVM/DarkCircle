import { describe, expect, it } from 'vitest';
import { buildListingDetails, locationLine, parseListingDetails } from '../src/listingDetails.js';

const good = {
  title: 'Obsidian Point Residence',
  type: 'residential',
  city: 'Port Vale',
  region: 'Harbour District',
  country: 'Portugal',
  summary: 'Cliff-top residence.',
  beds: '4',
  baths: 3,
  interiorSqm: '312',
};

describe('buildListingDetails', () => {
  it('produces compact JSON with numbers typed', () => {
    const res = buildListingDetails(good);
    expect(res.ok).toBe(true);
    expect(res.details).toMatchObject({ v: 1, beds: 4, baths: 3, interiorSqm: 312 });
    expect(JSON.parse(res.json!)).toEqual(res.details);
  });

  it('reports every problem', () => {
    const res = buildListingDetails({ title: 'ab', type: 'castle', city: '', country: '', beds: '-1', yearBuilt: '3000' });
    expect(res.ok).toBe(false);
    expect(res.errors).toHaveLength(6);
  });

  it('keeps within the on-chain limit', () => {
    const res = buildListingDetails({ ...good, summary: 'é'.repeat(600) });
    expect(res.ok).toBe(false);
    expect(res.errors.join()).toMatch(/bytes/);
  });

  it('strips control and bidi-override characters', () => {
    const res = buildListingDetails({ ...good, title: 'Villa‮000,1\u0007 sale' });
    expect(res.details!.title).toBe('Villa 000,1 sale');
  });
});

describe('parseListingDetails', () => {
  it('never throws on hostile or broken input', () => {
    for (const raw of ['', 'null', '[]', '{"title":{"x":1}}', '{"beds":"9999999"}', 'not json']) {
      const d = parseListingDetails(raw, 'Listing #9');
      expect(d.title).toBe('Listing #9');
      expect(d.beds).toBeUndefined();
    }
    expect(parseListingDetails('not json', 'x').malformed).toBe(true);
  });

  it('reads what buildListingDetails wrote', () => {
    const d = parseListingDetails(buildListingDetails(good).json!, 'x');
    expect(d.malformed).toBe(false);
    expect(d.title).toBe('Obsidian Point Residence');
    expect(locationLine(d)).toBe('Port Vale, Harbour District, Portugal');
  });
});
