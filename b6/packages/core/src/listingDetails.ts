/**
 * Listing details: the seller's own description of the property, stored on the listing as compact
 * JSON (at most 1,024 bytes, enforced by the contract). The deed carries the legal facts; this
 * carries the marketing ones. It is written by whoever listed, so it is parsed defensively and
 * only ever rendered as text.
 */

export const PROPERTY_TYPES = ['residential', 'commercial', 'land', 'industrial', 'hospitality'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const MAX_DETAILS_BYTES = 1_024;

export interface ListingDetails {
  v: 1;
  title: string;
  type: PropertyType;
  city: string;
  region: string;
  country: string;
  summary: string;
  beds?: number;
  baths?: number;
  /** Interior floor area, square metres. */
  interiorSqm?: number;
  /** Lot area, square metres. */
  lotSqm?: number;
  yearBuilt?: number;
}

const LIMITS = { title: 80, city: 60, region: 60, country: 60, summary: 600 } as const;

export interface DetailsResult {
  ok: boolean;
  details?: ListingDetails;
  json?: string;
  bytes?: number;
  errors: string[];
}

const encoder = new TextEncoder();

function cleanText(v: unknown, max: number): string {
  // Control and bidi-override characters out, whitespace collapsed: this text ends up in other
  // people's browsers, and a reversed run could make "1,000" read as "000,1".
  return typeof v === 'string'
    ? v
        .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
}

function cleanInt(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
}

/** Validates what a seller typed and produces the exact string to put on chain. */
export function buildListingDetails(input: Partial<Record<keyof ListingDetails, unknown>>): DetailsResult {
  const errors: string[] = [];
  const type = PROPERTY_TYPES.includes(input.type as PropertyType) ? (input.type as PropertyType) : null;
  const details: ListingDetails = {
    v: 1,
    title: cleanText(input.title, LIMITS.title),
    type: type ?? 'residential',
    city: cleanText(input.city, LIMITS.city),
    region: cleanText(input.region, LIMITS.region),
    country: cleanText(input.country, LIMITS.country),
    summary: cleanText(input.summary, LIMITS.summary),
  };
  if (!type) errors.push('Choose a property type.');
  if (details.title.length < 4) errors.push('Give the listing a title of at least 4 characters.');
  if (!details.city) errors.push('City is required.');
  if (!details.country) errors.push('Country is required.');

  const numeric: [keyof ListingDetails, number, number, string][] = [
    ['beds', 0, 200, 'Bedrooms'],
    ['baths', 0, 200, 'Bathrooms'],
    ['interiorSqm', 1, 10_000_000, 'Interior area'],
    ['lotSqm', 1, 1_000_000_000, 'Lot area'],
    ['yearBuilt', 1000, 2100, 'Year built'],
  ];
  for (const [key, min, max, label] of numeric) {
    const raw = input[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = cleanInt(raw, min, max);
    if (n === undefined) errors.push(`${label} must be a whole number between ${min} and ${max.toLocaleString('en-US')}.`);
    else (details as unknown as Record<string, number>)[key] = n;
  }

  const json = JSON.stringify(details);
  const bytes = encoder.encode(json).length;
  if (bytes > MAX_DETAILS_BYTES) errors.push(`Details are ${bytes} bytes; shorten the summary (limit ${MAX_DETAILS_BYTES}).`);
  return errors.length ? { ok: false, errors, bytes } : { ok: true, details, json, bytes, errors };
}

/**
 * Reads details from chain. Never throws: anything malformed comes back as a minimal record that
 * says so, and every field is re-cleaned as if it had been typed in.
 */
export function parseListingDetails(raw: string, fallbackTitle: string): ListingDetails & { malformed: boolean } {
  let obj: Record<string, unknown> = {};
  let malformed = false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
    else malformed = true;
  } catch {
    malformed = true;
  }
  const type = PROPERTY_TYPES.includes(obj.type as PropertyType) ? (obj.type as PropertyType) : 'residential';
  const out: ListingDetails & { malformed: boolean } = {
    v: 1,
    title: cleanText(obj.title, LIMITS.title) || fallbackTitle,
    type,
    city: cleanText(obj.city, LIMITS.city),
    region: cleanText(obj.region, LIMITS.region),
    country: cleanText(obj.country, LIMITS.country),
    summary: cleanText(obj.summary, LIMITS.summary),
    malformed,
  };
  const beds = cleanInt(obj.beds, 0, 200);
  const baths = cleanInt(obj.baths, 0, 200);
  const interiorSqm = cleanInt(obj.interiorSqm, 1, 10_000_000);
  const lotSqm = cleanInt(obj.lotSqm, 1, 1_000_000_000);
  const yearBuilt = cleanInt(obj.yearBuilt, 1000, 2100);
  if (beds !== undefined) out.beds = beds;
  if (baths !== undefined) out.baths = baths;
  if (interiorSqm !== undefined) out.interiorSqm = interiorSqm;
  if (lotSqm !== undefined) out.lotSqm = lotSqm;
  if (yearBuilt !== undefined) out.yearBuilt = yearBuilt;
  return out;
}

export function propertyTypeLabel(type: PropertyType): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function locationLine(d: Pick<ListingDetails, 'city' | 'region' | 'country'>): string {
  return [d.city, d.region, d.country].filter(Boolean).join(', ');
}
