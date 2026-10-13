import React, { useEffect, useState } from 'react';
import { calls, formatQuai, parseListingDetails, type DeedView, type ListingView, type OfferView } from '@darkquestate/core';
import { Badge, Button, Card, Notice, ParcelPlan, Stat } from '@darkquestate/ui';
import { useMarket } from '../state/MarketContext.js';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { useTx } from '../state/TxContext.js';
import { href } from '../lib/router.js';
import { relativeTime } from '../lib/format.js';
import { Quai } from '../components/Money.js';

interface Holdings {
  deeds: DeedView[];
  listings: ListingView[];
  offers: OfferView[];
  proceeds: bigint;
}

export const PortfolioPage: React.FC = () => {
  const market = useMarket();
  const { deployment } = useNetwork();
  const { address, connect, wallet, onExpectedChain } = useWallet();
  const { run } = useTx();
  const [h, setH] = useState<Holdings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setH(null);
    setError(null);
    const r = market.reader;
    if (!r || !address) return;
    Promise.all([r.deedsHeldBy(address), r.listingsBySeller(address), r.offersByBuyer(address), r.proceedsOf(address)])
      .then(([deeds, listings, offers, proceeds]) => alive && setH({ deeds, listings: listings.reverse(), offers: offers.reverse(), proceeds }))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [market.reader, address, market.updatedAt]);

  const header = (
    <>
      <h1 className="font-display text-4xl text-bone">Portfolio</h1>
      <p className="mt-2 text-sm text-bone-mute">Your deeds, listings, offers and proceeds on {market.mode === 'chain' ? 'this network' : 'the desk'}.</p>
    </>
  );

  if (market.mode === 'showcase') {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10 lg:px-8">
        {header}
        <Notice tone="gold" className="mt-8" title="Nothing to hold yet">
          The contracts are not deployed on this network, so no wallet holds deeds, listings or offers here.
        </Notice>
      </div>
    );
  }
  if (!address) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10 lg:px-8">
        {header}
        <Card className="mt-8 flex flex-col items-start gap-3">
          <p className="text-sm text-bone-dim">Connect your wallet to see what it holds.</p>
          <Button onClick={connect}>{wallet ? `Connect ${wallet.name}` : 'Connect a Quai wallet'}</Button>
        </Card>
      </div>
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const openOffers = h?.offers.filter((o) => o.status === 'open') ?? [];
  const activeListings = h?.listings.filter((l) => l.status === 'active') ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-10 px-4 py-10 lg:px-8">
      <div>{header}</div>
      {error && <Notice tone="danger">{error}</Notice>}
      {!h && !error && <p className="text-sm text-bone-mute">Reading your holdings…</p>}
      {h && (
        <>
          <Card className="grid gap-6 sm:grid-cols-4">
            <Stat label="Deeds in wallet" value={h.deeds.length} />
            <Stat label="Active listings" value={activeListings.length} />
            <Stat label="Open offers" value={openOffers.length} hint={openOffers.length ? `${formatQuai(openOffers.reduce((s, o) => s + o.amount, 0n))} QUAI escrowed` : undefined} />
            <div>
              <div className="text-[11px] uppercase tracking-[0.14em] text-bone-mute">Proceeds to withdraw</div>
              <Quai wei={h.proceeds} size="lg" className="mt-1" />
              <Button
                size="sm"
                className="mt-2"
                disabled={h.proceeds === 0n || !onExpectedChain}
                onClick={() => run('Withdraw proceeds', [{ label: `Send ${formatQuai(h.proceeds)} QUAI to your wallet`, build: () => calls.withdrawProceeds(deployment!) }])}
              >
                Withdraw
              </Button>
            </div>
          </Card>

          <section>
            <h2 className="font-display text-2xl text-bone">Deeds in your wallet</h2>
            {h.deeds.length === 0 ? (
              <p className="mt-3 text-sm text-bone-mute">None. Deeds you have listed are held by the desk and appear under your listings.</p>
            ) : (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {h.deeds.map((d) => (
                  <Card key={d.id.toString()} padded={false} className="overflow-hidden">
                    <ParcelPlan geoJson={d.record.geoJson} compact label={d.record.parcelId} />
                    <div className="flex items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <div className="truncate text-sm text-bone">{d.record.physicalAddress}</div>
                        <div className="text-xs text-bone-mute">Deed #{d.id.toString()}</div>
                      </div>
                      {d.debt.foreclosed ? (
                        <Badge tone="rose">Foreclosed</Badge>
                      ) : (
                        <a href={href({ name: 'sell' })} className="shrink-0 text-sm text-gold hover:text-gold-light">
                          List it →
                        </a>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="font-display text-2xl text-bone">Your listings</h2>
            {h.listings.length === 0 ? (
              <p className="mt-3 text-sm text-bone-mute">You have not listed anything.</p>
            ) : (
              <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-panel">
                {h.listings.map((l) => (
                  <li key={l.id.toString()} className="flex items-center justify-between gap-4 px-4 py-3">
                    <a href={href({ name: 'listing', id: l.id })} className="min-w-0 hover:text-gold">
                      <div className="truncate text-sm text-bone">{parseListingDetails(l.detailsRaw, `Listing #${l.id}`).title}</div>
                      <div className="text-xs text-bone-mute">Listing #{l.id.toString()}</div>
                    </a>
                    <div className="flex shrink-0 items-center gap-3">
                      <span className="text-sm tabular-nums text-bone-dim">{formatQuai(l.status === 'sold' ? l.salePrice : l.askPrice)} QUAI</span>
                      <Badge tone={l.status === 'active' ? 'emerald' : 'slate'}>{l.status === 'cancelled' ? 'withdrawn' : l.status}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2 className="font-display text-2xl text-bone">Your offers</h2>
            {h.offers.length === 0 ? (
              <p className="mt-3 text-sm text-bone-mute">You have not made any offers.</p>
            ) : (
              <ul className="mt-4 divide-y divide-line rounded-lg border border-line bg-panel">
                {h.offers.map((o) => (
                  <li key={o.id.toString()} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <a href={href({ name: 'listing', id: o.listingId })} className="min-w-0 hover:text-gold">
                      <div className="text-sm tabular-nums text-bone">{formatQuai(o.amount)} QUAI</div>
                      <div className="text-xs text-bone-mute">
                        Offer #{o.id.toString()} on listing #{o.listingId.toString()}
                        {o.status === 'open' && ` · ${o.expiresAt >= now ? 'expires' : 'expired'} ${relativeTime(o.expiresAt, now)}`}
                      </div>
                    </a>
                    <div className="flex items-center gap-3">
                      <Badge tone={o.status === 'accepted' ? 'emerald' : o.status === 'open' ? 'amber' : 'slate'}>{o.status}</Badge>
                      {o.status === 'open' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!onExpectedChain}
                          onClick={() => run('Withdraw offer', [{ label: `Return your ${formatQuai(o.amount)} QUAI deposit`, build: () => calls.withdrawOffer(deployment!, o.id) }])}
                        >
                          Withdraw
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
};
