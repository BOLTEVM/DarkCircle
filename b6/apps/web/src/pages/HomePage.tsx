import React, { useMemo, useState } from 'react';
import { ArrowRight, FileCheck2, Handshake, Landmark, Lock, Search } from 'lucide-react';
import { Button, ParcelPlan, Stat } from '@darkquestate/ui';
import { formatQuai } from '@darkquestate/core';
import { useMarket } from '../state/MarketContext.js';
import { href, navigate } from '../lib/router.js';
import { ListingCard } from '../components/ListingCard.js';

const STEPS = [
  {
    icon: FileCheck2,
    title: 'Title verified',
    body: "The registrar checks the recorded deed and the owning entity's agreement off chain, then mints an EIP-6065 deed token with the parcel boundary.",
  },
  {
    icon: Landmark,
    title: 'Listed with a broker',
    body: "The owner lists through a licensed broker. The desk holds the deed while it is listed, and the broker's commission is fixed at listing.",
  },
  {
    icon: Lock,
    title: 'Offers in escrow',
    body: 'Buyers pay at the asking price or make offers. An offer is a deposit the buyer can withdraw at any time until the seller accepts it.',
  },
  {
    icon: Handshake,
    title: 'Closing in one transaction',
    body: 'Acceptance moves the deed to the buyer and credits the price to seller and broker together. No lien larger than the buyer accepted can slip in.',
  },
];

export const HomePage: React.FC = () => {
  const market = useMarket();
  const [q, setQ] = useState('');
  const active = market.listings.filter((l) => l.listing.status === 'active');
  const featured = active.slice(0, 3);
  const hero = active[0] ?? market.listings[0];
  const stats = useMemo(() => {
    const sold = market.listings.filter((l) => l.listing.status === 'sold');
    return {
      active: active.length,
      underOffer: active.filter((l) => l.openOffers > 0).length,
      sold: sold.length,
      volume: sold.reduce((s, l) => s + l.listing.salePrice, 0n),
    };
  }, [market.listings, active]);

  return (
    <div>
      <section className="relative overflow-hidden border-b border-line">
        <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 py-16 lg:grid-cols-[1.15fr_1fr] lg:px-8 lg:py-24">
          <div className="space-y-7">
            <div className="text-xs uppercase tracking-[0.24em] text-gold">Real estate brokerage · Quai Network</div>
            <h1 className="font-display text-4xl leading-[1.08] text-bone sm:text-5xl lg:text-6xl">
              Property,
              <br />
              settled on Quai.
            </h1>
            <p className="max-w-xl text-base leading-relaxed text-bone-dim">
              Dark Questate lists title-verified properties as EIP-6065 deeds. Offers wait in escrow on Cyprus-1, and closing moves the deed and the money in one
              transaction.
            </p>
            <form
              className="flex max-w-xl gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                navigate({ name: 'listings', q: q.trim() });
              }}
              role="search"
            >
              <label className="relative flex-1">
                <span className="sr-only">Search properties</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-bone-mute" aria-hidden />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="City, title or parcel id"
                  className="h-12 w-full rounded-lg border border-line bg-ink-deep pl-10 pr-3 text-sm text-bone placeholder:text-bone-mute focus:border-gold/60 focus:outline-none"
                />
              </label>
              <Button size="lg" type="submit">
                Search
              </Button>
            </form>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <a href={href({ name: 'listings', q: '' })} className="inline-flex items-center gap-1.5 text-bone hover:text-gold">
                Browse every property <ArrowRight className="h-4 w-4" />
              </a>
              <a href={href({ name: 'sell' })} className="inline-flex items-center gap-1.5 text-bone-dim hover:text-gold">
                List a property <ArrowRight className="h-4 w-4" />
              </a>
            </div>
          </div>
          {hero?.deed && (
            <a href={href({ name: 'listing', id: hero.listing.id })} className="group block">
              <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lift transition-colors group-hover:border-gold/40">
                <ParcelPlan geoJson={hero.deed.record.geoJson} label={hero.deed.record.parcelId} />
                <div className="flex items-end justify-between gap-4 border-t border-line p-5">
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-gold">{hero.sample ? 'Sample listing' : 'Featured'}</div>
                    <div className="mt-1 truncate font-display text-xl text-bone">{hero.details.title}</div>
                    <div className="text-xs text-bone-mute">{hero.deed.record.physicalAddress}</div>
                  </div>
                  <div className="shrink-0 text-right font-display text-lg text-bone">
                    {formatQuai(hero.listing.askPrice, 0)} <span className="text-xs text-gold">QUAI</span>
                  </div>
                </div>
              </div>
            </a>
          )}
        </div>
      </section>

      <section className="border-b border-line bg-ink-deep/60">
        <div className="mx-auto grid max-w-7xl grid-cols-2 gap-6 px-4 py-8 md:grid-cols-4 lg:px-8">
          <Stat label="For sale" value={stats.active} hint={market.mode === 'showcase' ? 'sample data' : undefined} />
          <Stat label="Under offer" value={stats.underOffer} />
          <Stat label="Closed sales" value={stats.sold} />
          <Stat label="Closed volume" value={<>{formatQuai(stats.volume, 0)} <span className="text-sm text-gold">QUAI</span></>} />
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-16 lg:px-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-display text-3xl text-bone">On the desk now</h2>
            <p className="mt-1 text-sm text-bone-mute">The newest listings, read from {market.mode === 'showcase' ? 'the showcase catalogue' : 'the brokerage contract'}.</p>
          </div>
          <a href={href({ name: 'listings', q: '' })} className="hidden shrink-0 items-center gap-1.5 text-sm text-bone-dim hover:text-gold sm:inline-flex">
            All listings <ArrowRight className="h-4 w-4" />
          </a>
        </div>
        <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {featured.map((item) => (
            <ListingCard key={item.listing.id.toString()} item={item} />
          ))}
          {market.mode === 'loading' && <div className="col-span-full py-16 text-center text-sm text-bone-mute">Reading the desk…</div>}
          {market.mode === 'chain' && featured.length === 0 && (
            <div className="col-span-full rounded-xl border border-dashed border-line py-16 text-center text-sm text-bone-mute">
              Nothing is listed yet. <a href={href({ name: 'sell' })} className="text-gold hover:text-gold-light">List the first property.</a>
            </div>
          )}
        </div>
      </section>

      <section className="border-y border-line bg-panel/40">
        <div className="mx-auto max-w-7xl px-4 py-16 lg:px-8">
          <h2 className="font-display text-3xl text-bone">How a sale closes</h2>
          <ol className="mt-10 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="rounded-xl border border-line bg-panel p-5">
                <div className="flex items-center justify-between">
                  <s.icon className="h-5 w-5 text-gold" aria-hidden />
                  <span className="font-mono text-xs text-bone-mute">0{i + 1}</span>
                </div>
                <h3 className="mt-4 font-display text-lg text-bone">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-bone-dim">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto grid max-w-7xl gap-10 px-4 py-16 lg:grid-cols-2 lg:px-8">
        <div>
          <h2 className="font-display text-3xl text-bone">What the chain does, and what it does not</h2>
          <p className="mt-4 text-sm leading-relaxed text-bone-dim">
            The chain holds the deed record, the escrow and the closing. It cannot see a property. Title is verified by the registrar against recorded documents
            before a deed is minted, and only the registrar can record a lien or a foreclosure, so an owner can never clear their own debt.
          </p>
        </div>
        <ul className="space-y-3 text-sm">
          {[
            ['On chain', 'Deed record (EIP-6065), parcel boundary, lien or credit, listing, offer deposits, closing, broker commission.'],
            ['Off chain', 'Title search, identity checks, the operating agreement itself (only its hash is on chain), recording with the local registry.'],
            ['Never', 'Custody of your keys. Every transaction is signed in your own wallet, and the operator cannot touch deposits, proceeds or listed deeds.'],
          ].map(([k, v]) => (
            <li key={k} className="flex gap-4 rounded-lg border border-line bg-panel px-4 py-3">
              <span className="w-20 shrink-0 text-[11px] uppercase tracking-[0.16em] text-gold">{k}</span>
              <span className="text-bone-dim">{v}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};
