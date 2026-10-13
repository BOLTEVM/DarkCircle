import React from 'react';
import { BedDouble, Bath, MapPin, Ruler } from 'lucide-react';
import { formatArea, locationLine, parcelAreaSqm, parseParcelGeoJson, propertyTypeLabel } from '@darkquestate/core';
import { Badge, ParcelPlan, cx } from '@darkquestate/ui';
import type { MarketListing } from '../state/MarketContext.js';
import { href } from '../lib/router.js';
import { Quai } from './Money.js';

export function listingStatusBadge(m: MarketListing) {
  if (m.listing.status === 'sold') return <Badge tone="slate">Sold</Badge>;
  if (m.listing.status === 'cancelled') return <Badge tone="slate">Withdrawn</Badge>;
  if (m.deed?.debt.foreclosed) return <Badge tone="rose">Foreclosed</Badge>;
  if (m.openOffers > 0) return <Badge tone="amber">Under offer · {m.openOffers}</Badge>;
  return <Badge tone="emerald">For sale</Badge>;
}

export function lotArea(m: MarketListing): number | null {
  if (!m.deed) return null;
  const g = parseParcelGeoJson(m.deed.record.geoJson);
  return g.ok && g.polygon ? parcelAreaSqm(g.polygon) : null;
}

export const ListingCard: React.FC<{ item: MarketListing; className?: string }> = ({ item, className }) => {
  const { listing, details, deed, sample } = item;
  const lot = lotArea(item);
  const sold = listing.status === 'sold';
  return (
    <a
      href={href({ name: 'listing', id: listing.id })}
      className={cx(
        'group flex flex-col overflow-hidden rounded-xl border border-line bg-panel transition-colors hover:border-gold/40 hover:bg-panel-raised',
        className
      )}
    >
      <div className="relative">
        {deed ? (
          <ParcelPlan geoJson={deed.record.geoJson} compact tone={sold ? 'muted' : deed.debt.foreclosed ? 'rose' : 'gold'} className="border-b border-line" />
        ) : (
          <div className="blueprint aspect-[400/260] border-b border-line" />
        )}
        <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
          {listingStatusBadge(item)}
          {sample && (
            <Badge tone="gold" title="Showcase record: invented, not on chain">
              Sample
            </Badge>
          )}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.16em] text-gold">{propertyTypeLabel(details.type)}</div>
          <h3 className="mt-1 font-display text-lg leading-snug text-bone group-hover:text-gold-pale">{details.title}</h3>
          {locationLine(details) && (
            <div className="mt-1 flex items-center gap-1 text-xs text-bone-mute">
              <MapPin className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{locationLine(details)}</span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-bone-dim">
          {details.beds !== undefined && (
            <span className="inline-flex items-center gap-1">
              <BedDouble className="h-3.5 w-3.5 text-bone-mute" aria-hidden /> {details.beds} bd
            </span>
          )}
          {details.baths !== undefined && (
            <span className="inline-flex items-center gap-1">
              <Bath className="h-3.5 w-3.5 text-bone-mute" aria-hidden /> {details.baths} ba
            </span>
          )}
          {details.interiorSqm !== undefined && <span>{details.interiorSqm.toLocaleString('en-US')} m² interior</span>}
          {lot !== null && (
            <span className="inline-flex items-center gap-1">
              <Ruler className="h-3.5 w-3.5 text-bone-mute" aria-hidden /> {formatArea(lot)} lot
            </span>
          )}
        </div>
        <div className="mt-auto flex items-end justify-between border-t border-line pt-3">
          <Quai wei={sold ? listing.salePrice : listing.askPrice} size="md" />
          <span className="text-[11px] text-bone-mute">{sold ? 'Sold price' : 'Asking'}</span>
        </div>
      </div>
    </a>
  );
};
