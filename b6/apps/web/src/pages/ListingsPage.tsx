import React, { useMemo, useState } from 'react';
import { Search, SlidersHorizontal } from 'lucide-react';
import { PROPERTY_TYPES, locationLine, parseQuai, propertyTypeLabel, type PropertyType } from '@darkquestate/core';
import { cx } from '@darkquestate/ui';
import { useMarket, type MarketListing } from '../state/MarketContext.js';
import { ListingCard } from '../components/ListingCard.js';

type StatusFilter = 'active' | 'sold' | 'all';
type Sort = 'newest' | 'price-asc' | 'price-desc';

export function filterListings(
  items: MarketListing[],
  f: { q: string; types: PropertyType[]; status: StatusFilter; min: bigint | null; max: bigint | null; beds: number }
): MarketListing[] {
  const q = f.q.trim().toLowerCase();
  return items.filter((m) => {
    if (f.status === 'active' && m.listing.status !== 'active') return false;
    if (f.status === 'sold' && m.listing.status !== 'sold') return false;
    if (f.status === 'all' && m.listing.status === 'cancelled') return false;
    if (f.types.length && !f.types.includes(m.details.type)) return false;
    const price = m.listing.status === 'sold' ? m.listing.salePrice : m.listing.askPrice;
    if (f.min !== null && price < f.min) return false;
    if (f.max !== null && price > f.max) return false;
    if (f.beds > 0 && (m.details.beds ?? 0) < f.beds) return false;
    if (!q) return true;
    const hay = [m.details.title, locationLine(m.details), m.details.summary, m.deed?.record.parcelId, m.deed?.record.physicalAddress].join(' ').toLowerCase();
    return q.split(/\s+/).every((word) => hay.includes(word));
  });
}

export const ListingsPage: React.FC<{ initialQuery: string }> = ({ initialQuery }) => {
  const market = useMarket();
  const [q, setQ] = useState(initialQuery);
  const [types, setTypes] = useState<PropertyType[]>([]);
  const [status, setStatus] = useState<StatusFilter>('active');
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
  const [beds, setBeds] = useState(0);
  const [sort, setSort] = useState<Sort>('newest');

  const min = minText ? parseQuai(minText) : null;
  const max = maxText ? parseQuai(maxText) : null;
  const shown = useMemo(() => {
    const rows = filterListings(market.listings, { q, types, status, min, max, beds });
    const price = (m: MarketListing) => (m.listing.status === 'sold' ? m.listing.salePrice : m.listing.askPrice);
    return [...rows].sort((a, b) =>
      sort === 'newest' ? b.listing.createdAt - a.listing.createdAt : sort === 'price-asc' ? (price(a) < price(b) ? -1 : 1) : price(a) < price(b) ? 1 : -1
    );
  }, [market.listings, q, types, status, min, max, beds, sort]);

  const toggleType = (t: PropertyType) => setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const chip = (on: boolean) =>
    cx('rounded-full border px-3 py-1.5 text-xs transition-colors', on ? 'border-gold/60 bg-gold/10 text-gold-pale' : 'border-line text-bone-dim hover:border-line-strong hover:text-bone');

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 lg:px-8">
      <h1 className="font-display text-4xl text-bone">Properties</h1>
      <p className="mt-2 text-sm text-bone-mute">Every listing is backed by a registrar-verified deed held in the desk's escrow.</p>

      <div className="mt-8 space-y-4 rounded-xl border border-line bg-panel p-4">
        <div className="flex flex-col gap-3 lg:flex-row">
          <label className="relative flex-1">
            <span className="sr-only">Search</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bone-mute" aria-hidden />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="City, title, street or parcel id"
              className="h-10 w-full rounded-lg border border-line bg-ink-deep pl-10 pr-3 text-sm text-bone placeholder:text-bone-mute focus:border-gold/60 focus:outline-none"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <SlidersHorizontal className="h-4 w-4 text-bone-mute" aria-hidden />
            <input
              value={minText}
              onChange={(e) => setMinText(e.target.value)}
              placeholder="Min QUAI"
              inputMode="decimal"
              aria-label="Minimum price in QUAI"
              aria-invalid={minText !== '' && min === null}
              className={cx('h-10 w-32 rounded-lg border bg-ink-deep px-3 text-sm text-bone focus:outline-none', minText && min === null ? 'border-rose-400/60' : 'border-line focus:border-gold/60')}
            />
            <input
              value={maxText}
              onChange={(e) => setMaxText(e.target.value)}
              placeholder="Max QUAI"
              inputMode="decimal"
              aria-label="Maximum price in QUAI"
              aria-invalid={maxText !== '' && max === null}
              className={cx('h-10 w-32 rounded-lg border bg-ink-deep px-3 text-sm text-bone focus:outline-none', maxText && max === null ? 'border-rose-400/60' : 'border-line focus:border-gold/60')}
            />
            <select value={beds} onChange={(e) => setBeds(Number(e.target.value))} aria-label="Minimum bedrooms" className="h-10 rounded-lg border border-line bg-ink-deep px-3 text-sm text-bone-dim focus:outline-none">
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'Any beds' : `${n}+ beds`}
                </option>
              ))}
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort" className="h-10 rounded-lg border border-line bg-ink-deep px-3 text-sm text-bone-dim focus:outline-none">
              <option value="newest">Newest</option>
              <option value="price-asc">Price, low to high</option>
              <option value="price-desc">Price, high to low</option>
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {(['active', 'sold', 'all'] as StatusFilter[]).map((s) => (
            <button key={s} type="button" className={chip(status === s)} onClick={() => setStatus(s)} aria-pressed={status === s}>
              {s === 'active' ? 'For sale' : s === 'sold' ? 'Sold' : 'All'}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-line" aria-hidden />
          {PROPERTY_TYPES.map((t) => (
            <button key={t} type="button" className={chip(types.includes(t))} onClick={() => toggleType(t)} aria-pressed={types.includes(t)}>
              {propertyTypeLabel(t)}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 text-sm text-bone-mute" aria-live="polite">
        {market.mode === 'loading' ? 'Reading the desk…' : `${shown.length} ${shown.length === 1 ? 'property' : 'properties'}`}
      </div>
      <div className="mt-4 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((item) => (
          <ListingCard key={item.listing.id.toString()} item={item} />
        ))}
      </div>
      {market.mode !== 'loading' && shown.length === 0 && (
        <div className="mt-4 rounded-xl border border-dashed border-line py-16 text-center text-sm text-bone-mute">No property matches these filters.</div>
      )}
    </div>
  );
};
