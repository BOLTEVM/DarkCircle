import { parseUnits } from 'ethers';
import type { BrokerView, DeedView, ListingView, OfferView } from './brokerage.js';
import { ZERO_ADDRESS } from './address.js';

/**
 * The showcase catalogue: what the site displays on a network where the contracts are not
 * deployed. Every property, firm and address here is invented. The UI labels each record as a
 * sample and disables every transaction on it; nothing in this file is ever sent to a chain.
 *
 * Addresses are synthetic (0x00 followed by zeros and a short tag) so none of them can be
 * mistaken for, or collide with, a real Cyprus-1 account or contract.
 */

const tag = (n: number) => '0x' + n.toString(16).padStart(40, '0');

export const SHOWCASE_DESK = tag(0x5d0e5c);
export const SHOWCASE_DEED_REGISTRY = tag(0x5d0eed);

const BROKERS: BrokerView[] = [
  { address: tag(0x5b01), name: 'Obsidian Row Realty (sample)', licenseId: 'SAMPLE-BRK-001', commissionBps: 300, active: true, registered: true },
  { address: tag(0x5b02), name: 'Meridian Ledger Estates (sample)', licenseId: 'SAMPLE-BRK-002', commissionBps: 250, active: true, registered: true },
];

const SELLERS = [tag(0x5e01), tag(0x5e02), tag(0x5e03), tag(0x5e04), tag(0x5e05), tag(0x5e06)];
const BUYERS = [tag(0x5c01), tag(0x5c02), tag(0x5c03)];

type Ring = [number, number][];

function feature(ring: Ring, apn: string): string {
  return JSON.stringify({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { apn } });
}

/** Offsets in metres from an origin, turned into a closed lng/lat ring. */
function ringFrom(originLng: number, originLat: number, metres: [number, number][]): Ring {
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos((originLat * Math.PI) / 180);
  const pts = metres.map(([e, n]) => [+(originLng + e / mPerLng).toFixed(7), +(originLat + n / mPerLat).toFixed(7)] as [number, number]);
  return [...pts, pts[0]!];
}

interface Seed {
  title: string;
  type: 'residential' | 'commercial' | 'land' | 'industrial' | 'hospitality';
  city: string;
  region: string;
  country: string;
  summary: string;
  beds?: number;
  baths?: number;
  interiorSqm?: number;
  yearBuilt?: number;
  apn: string;
  street: string;
  owner: string;
  origin: [number, number];
  shape: [number, number][];
  priceQuai: string;
  broker: 0 | 1;
  debtQuai?: string; // positive lien, negative credit
  daysListed: number;
}

const SEEDS: Seed[] = [
  {
    title: 'Obsidian Point Residence',
    type: 'residential',
    city: 'Port Vale',
    region: 'Harbour District',
    country: 'Portugal',
    summary: 'Cliff-top residence with a glass pavilion facing the harbour, a lap pool and a separate guest studio. Sample listing.',
    beds: 4,
    baths: 3,
    interiorSqm: 312,
    yearBuilt: 2019,
    apn: 'SAMPLE-PV-0007',
    street: '7 Obsidian Point, Port Vale',
    owner: 'Obsidian Point Holdings LLC (sample)',
    origin: [-9.4215, 38.6917],
    shape: [[0, 0], [46, 0], [46, 22], [30, 38], [0, 38]],
    priceQuai: '18500000',
    broker: 0,
    daysListed: 3,
  },
  {
    title: 'Kestrel Ridge Vineyard Lot',
    type: 'land',
    city: 'Kestrel Ridge',
    region: 'Upper Valley',
    country: 'Canada',
    summary: 'South-facing slope zoned agricultural-residential, with road frontage, a surveyed well site and power at the boundary. Sample listing.',
    apn: 'SAMPLE-KR-2210',
    street: 'Lot 22, Kestrel Ridge Road',
    owner: 'Kestrel Ridge Land Trust (sample)',
    origin: [-119.4961, 49.8879],
    shape: [[0, 0], [140, 12], [168, 96], [64, 130], [-8, 70]],
    priceQuai: '6200000',
    broker: 1,
    daysListed: 11,
  },
  {
    title: 'Calder Flats Warehouse',
    type: 'industrial',
    city: 'Calder Flats',
    region: 'Riverside',
    country: 'United Kingdom',
    summary: 'Clear-span warehouse with four dock doors, an 8 m eaves height and a fenced yard. Municipal lien disclosed on the deed. Sample listing.',
    interiorSqm: 2650,
    yearBuilt: 1998,
    apn: 'SAMPLE-CF-0419',
    street: '19 Wharf Lane, Calder Flats',
    owner: 'Calder Logistics Property Ltd (sample)',
    origin: [-1.5491, 53.8008],
    shape: [[0, 0], [72, 0], [72, 54], [0, 54]],
    priceQuai: '9750000',
    broker: 0,
    debtQuai: '42000',
    daysListed: 19,
  },
  {
    title: 'Meridian Bay Corner Retail',
    type: 'commercial',
    city: 'Meridian Bay',
    region: 'Old Town',
    country: 'Australia',
    summary: 'Corner retail unit with two street frontages, tenanted on a five-year lease; prepaid rates are held as a credit on the deed. Sample listing.',
    interiorSqm: 410,
    yearBuilt: 1931,
    apn: 'SAMPLE-MB-0101',
    street: '1 Harbour Street, Meridian Bay',
    owner: 'Meridian Corner Pty Ltd (sample)',
    origin: [151.2093, -33.8688],
    shape: [[0, 0], [24, 0], [24, 10], [16, 18], [0, 18]],
    priceQuai: '12100000',
    broker: 1,
    debtQuai: '-15000',
    daysListed: 7,
  },
  {
    title: 'Ashford Hollow Inn',
    type: 'hospitality',
    city: 'Ashford Hollow',
    region: 'Lake Country',
    country: 'United States',
    summary: 'Twelve-room lakeside inn with a restaurant licence, boathouse and owner’s cottage. Sample listing.',
    beds: 13,
    baths: 14,
    interiorSqm: 1240,
    yearBuilt: 1907,
    apn: 'SAMPLE-AH-1907',
    street: '3 Shore Road, Ashford Hollow',
    owner: 'Ashford Hollow Hospitality LLC (sample)',
    origin: [-73.7562, 42.6526],
    shape: [[0, 0], [58, -6], [74, 40], [20, 62], [-10, 30]],
    priceQuai: '21400000',
    broker: 0,
    daysListed: 26,
  },
  {
    title: 'Lowmarsh Terrace House',
    type: 'residential',
    city: 'Lowmarsh',
    region: 'Canal Quarter',
    country: 'Netherlands',
    summary: 'Restored canal-side terrace house over four floors with a courtyard garden. Sold through the desk. Sample listing.',
    beds: 3,
    baths: 2,
    interiorSqm: 168,
    yearBuilt: 1890,
    apn: 'SAMPLE-LM-0042',
    street: '42 Canal Terrace, Lowmarsh',
    owner: 'Lowmarsh Terrace BV (sample)',
    origin: [4.8952, 52.3702],
    shape: [[0, 0], [7, 0], [7, 28], [0, 28]],
    priceQuai: '7300000',
    broker: 1,
    daysListed: 40,
  },
];

export interface ShowcaseCatalogue {
  brokers: BrokerView[];
  listings: ListingView[];
  deeds: Map<bigint, DeedView>;
  offers: OfferView[];
}

/** Builds the catalogue with times relative to `nowSeconds`, so sample offers never show as long expired. */
export function showcaseCatalogue(nowSeconds: number): ShowcaseCatalogue {
  const day = 86_400;
  const listings: ListingView[] = [];
  const deeds = new Map<bigint, DeedView>();
  SEEDS.forEach((s, i) => {
    const id = BigInt(i + 1);
    const sold = s.title.startsWith('Lowmarsh');
    const askPrice = parseUnits(s.priceQuai, 18);
    const broker = BROKERS[s.broker]!;
    const details = {
      v: 1,
      title: s.title,
      type: s.type,
      city: s.city,
      region: s.region,
      country: s.country,
      summary: s.summary,
      ...(s.beds !== undefined ? { beds: s.beds } : {}),
      ...(s.baths !== undefined ? { baths: s.baths } : {}),
      ...(s.interiorSqm !== undefined ? { interiorSqm: s.interiorSqm } : {}),
      ...(s.yearBuilt !== undefined ? { yearBuilt: s.yearBuilt } : {}),
    };
    listings.push({
      id,
      deedId: id,
      seller: SELLERS[i]!,
      createdAt: nowSeconds - s.daysListed * day,
      status: sold ? 'sold' : 'active',
      broker: broker.address,
      commissionBps: broker.commissionBps,
      askPrice,
      buyer: sold ? BUYERS[2]! : null,
      salePrice: sold ? parseUnits('7150000', 18) : 0n,
      acceptedOfferId: sold ? 3n : 0n,
      detailsRaw: JSON.stringify(details),
    });
    const debt = s.debtQuai ? parseUnits(s.debtQuai.replace('-', ''), 18) * (s.debtQuai.startsWith('-') ? -1n : 1n) : 0n;
    deeds.set(id, {
      id,
      holder: sold ? BUYERS[2]! : SHOWCASE_DESK,
      manager: sold ? BUYERS[2]! : SHOWCASE_DESK,
      tokenURI: '',
      record: {
        legalDescription: `Parcel ${s.apn} as recorded in the ${s.region} register (sample record, not a real title).`,
        physicalAddress: s.street,
        geoJson: feature(ringFrom(s.origin[0], s.origin[1], s.shape), s.apn),
        parcelId: s.apn,
        legalOwner: s.owner,
        operatingAgreementHash: '0x' + (i + 1).toString(16).padStart(64, '5'),
      },
      debt: { token: ZERO_ADDRESS, amount: debt, foreclosed: false },
    });
  });

  const offers: OfferView[] = [
    { id: 1n, listingId: 1n, buyer: BUYERS[0]!, expiresAt: nowSeconds + 5 * day, status: 'open', amount: parseUnits('17800000', 18), debtToken: ZERO_ADDRESS, maxDebt: 0n },
    { id: 2n, listingId: 1n, buyer: BUYERS[1]!, expiresAt: nowSeconds + 2 * day, status: 'open', amount: parseUnits('18100000', 18), debtToken: ZERO_ADDRESS, maxDebt: 0n },
    { id: 3n, listingId: 6n, buyer: BUYERS[2]!, expiresAt: nowSeconds - 20 * day, status: 'accepted', amount: parseUnits('7150000', 18), debtToken: ZERO_ADDRESS, maxDebt: 0n },
    { id: 4n, listingId: 3n, buyer: BUYERS[1]!, expiresAt: nowSeconds + 9 * day, status: 'open', amount: parseUnits('9400000', 18), debtToken: ZERO_ADDRESS, maxDebt: parseUnits('42000', 18) },
  ];

  return { brokers: BROKERS, listings, deeds, offers };
}
