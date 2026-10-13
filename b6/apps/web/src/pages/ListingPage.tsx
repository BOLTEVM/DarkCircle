import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Box, FileText, Map as MapIcon, ShieldCheck } from 'lucide-react';
import {
  calls,
  describeLien,
  formatBps,
  formatQuai,
  locationLine,
  offerIsAcceptable,
  parseQuai,
  propertyTypeLabel,
  sameAddress,
  settlementFor,
  SHOWCASE_DESK,
  type OfferView,
} from '@darkquestate/core';
import { Badge, Button, Card, LienDisclosure, Modal, Notice, ParcelMassing, ParcelPlan, SelectField, TextField, cx } from '@darkquestate/ui';
import { useMarket, type MarketListing } from '../state/MarketContext.js';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { useTx } from '../state/TxContext.js';
import { href } from '../lib/router.js';
import { estimateStoreys, formatDate, relativeTime } from '../lib/format.js';
import { AddressTag, Quai } from '../components/Money.js';
import { listingStatusBadge, lotArea } from '../components/ListingCard.js';

const OFFER_DAYS = [1, 3, 7, 14, 30, 90];

export const ListingPage: React.FC<{ id: bigint }> = ({ id }) => {
  const market = useMarket();
  const item = market.listings.find((l) => l.listing.id === id);
  const [offers, setOffers] = useState<OfferView[]>([]);
  const [view, setView] = useState<'plan' | '3d'>('plan');

  useEffect(() => {
    let alive = true;
    if (!item) return;
    market.offersFor(id).then(
      (o) => alive && setOffers(o),
      () => alive && setOffers([])
    );
    return () => {
      alive = false;
    };
  }, [id, item, market.offersFor, market.updatedAt]);

  if (!item) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 text-center">
        <h1 className="font-display text-3xl text-bone">{market.mode === 'loading' ? 'Reading the desk…' : `Listing #${id.toString()} is not on the desk`}</h1>
        {market.mode !== 'loading' && (
          <p className="mt-3 text-sm text-bone-mute">
            It may be older than the newest 60 listings or on another network. <a href={href({ name: 'listings', q: '' })} className="text-gold">Browse listings</a>
          </p>
        )}
      </div>
    );
  }

  const { listing, details, deed, broker, sample } = item;
  const lot = lotArea(item);
  const sale = settlementFor(listing.status === 'sold' ? listing.salePrice : listing.askPrice, listing.commissionBps);
  const deskAddress = market.reader?.brokerageAddress ?? (sample ? SHOWCASE_DESK : undefined);
  const facts = (
    [
      ['Type', propertyTypeLabel(details.type)],
      ['Bedrooms', details.beds],
      ['Bathrooms', details.baths],
      ['Interior', details.interiorSqm !== undefined ? `${details.interiorSqm.toLocaleString('en-US')} m²` : undefined],
      ['Lot (from deed)', lot !== null ? `${Math.round(lot).toLocaleString('en-US')} m²` : undefined],
      ['Year built', details.yearBuilt],
    ] as [string, React.ReactNode][]
  ).filter(([, v]) => v !== undefined && v !== null);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-8">
      <a href={href({ name: 'listings', q: '' })} className="inline-flex items-center gap-1.5 text-sm text-bone-mute hover:text-bone">
        <ArrowLeft className="h-4 w-4" /> All properties
      </a>

      <div className="mt-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.18em] text-gold">{propertyTypeLabel(details.type)}</span>
            {listingStatusBadge(item)}
            {sample && <Badge tone="gold">Sample · not on chain</Badge>}
            {details.malformed && <Badge tone="rose">Details unreadable</Badge>}
          </div>
          <h1 className="mt-2 font-display text-4xl leading-tight text-bone">{details.title}</h1>
          <div className="mt-1 text-sm text-bone-mute">{[deed?.record.physicalAddress, locationLine(details)].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="text-sm text-bone-mute">
          Listing #{listing.id.toString()} · listed {formatDate(listing.createdAt)}
        </div>
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-8">
          <div className="overflow-hidden rounded-xl border border-line">
            {deed ? (
              view === 'plan' ? (
                <ParcelPlan geoJson={deed.record.geoJson} label={deed.record.parcelId} />
              ) : (
                <ParcelMassing geoJson={deed.record.geoJson} storeys={estimateStoreys(details.type, details.interiorSqm, lot)} />
              )
            ) : (
              <div className="blueprint aspect-[400/260]" />
            )}
            <div className="flex items-center gap-1 border-t border-line bg-panel px-3 py-2">
              {(
                [
                  ['plan', MapIcon, 'Site plan'],
                  ['3d', Box, '3D massing'],
                ] as const
              ).map(([v, Icon, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  aria-pressed={view === v}
                  className={cx('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs', view === v ? 'bg-panel-raised text-gold' : 'text-bone-mute hover:text-bone')}
                >
                  <Icon className="h-3.5 w-3.5" /> {label}
                </button>
              ))}
            </div>
          </div>

          <section>
            <h2 className="font-display text-2xl text-bone">About this property</h2>
            {details.summary && <p className="mt-3 max-w-3xl text-sm leading-relaxed text-bone-dim">{details.summary}</p>}
            <dl className="mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
              {facts.map(([k, v]) => (
                <div key={k} className="bg-panel px-4 py-3">
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-bone-mute">{k}</dt>
                  <dd className="mt-1 text-sm text-bone">{v}</dd>
                </div>
              ))}
              {/* fill the last row so the hairline grid never shows an empty grey cell */}
              {Array.from({ length: (3 - (facts.length % 3)) % 3 }, (_, i) => (
                <div key={`pad-${i}`} className="hidden bg-panel sm:block" aria-hidden />
              ))}
              {facts.length % 2 === 1 && <div className="bg-panel sm:hidden" aria-hidden />}
            </dl>
            <p className="mt-2 text-xs text-bone-mute">Description and room counts are the seller's. The lot area is computed from the boundary on the deed.</p>
          </section>

          {deed && (
            <section>
              <h2 className="flex items-center gap-2 font-display text-2xl text-bone">
                <FileText className="h-5 w-5 text-gold" aria-hidden /> Deed record
              </h2>
              <p className="mt-1 text-xs text-bone-mute">EIP-6065 fields as minted by the registrar{sample ? ' (sample record)' : ''}. They cannot be edited after minting.</p>
              <div className="mt-4 space-y-4">
                <LienDisclosure debt={deed.debt} />
                <dl className="divide-y divide-line rounded-lg border border-line bg-panel text-sm">
                  {(
                    [
                      ['Deed', `#${deed.id.toString()}`],
                      ['Parcel id', <span className="font-mono">{deed.record.parcelId}</span>],
                      ['Street address', deed.record.physicalAddress],
                      ['Legal owner on title', deed.record.legalOwner],
                      ['Legal description', deed.record.legalDescription],
                      ['Operating agreement (keccak256)', <span className="break-all font-mono text-xs">{deed.record.operatingAgreementHash}</span>],
                      ['Metadata', deed.tokenURI ? <span className="break-all font-mono text-xs">{deed.tokenURI}</span> : '—'],
                      ['Held by', <AddressTag address={deed.holder} sample={sample} label={sameAddress(deed.holder, deskAddress) ? 'Desk escrow' : undefined} />],
                    ] as [string, React.ReactNode][]
                  ).map(([k, v]) => (
                    <div key={k} className="grid gap-1 px-4 py-3 sm:grid-cols-[200px_1fr]">
                      <dt className="text-bone-mute">{k}</dt>
                      <dd className="min-w-0 text-bone">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </section>
          )}

          <OffersSection item={item} offers={offers} />
        </div>

        <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <Card className="space-y-5">
            <div>
              <div className="text-[11px] uppercase tracking-[0.16em] text-bone-mute">{listing.status === 'sold' ? 'Sold for' : 'Asking price'}</div>
              <Quai wei={listing.status === 'sold' ? listing.salePrice : listing.askPrice} size="xl" className="mt-1" />
            </div>
            <dl className="space-y-2 border-t border-line pt-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-bone-mute">Broker commission ({formatBps(listing.commissionBps)})</dt>
                <dd className="tabular-nums text-bone-dim">{formatQuai(sale.commission)} QUAI</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-bone-mute">Seller receives</dt>
                <dd className="tabular-nums text-bone-dim">{formatQuai(sale.sellerNet)} QUAI</dd>
              </div>
            </dl>
            <ActionPanel item={item} />
          </Card>
          {broker && (
            <Card className="space-y-2">
              <div className="text-[11px] uppercase tracking-[0.16em] text-bone-mute">Listing broker</div>
              <div className="flex items-center gap-2 font-display text-lg text-bone">
                <ShieldCheck className="h-4 w-4 text-gold" aria-hidden /> {broker.name}
              </div>
              <div className="text-xs text-bone-mute">
                Licence {broker.licenseId} · {formatBps(broker.commissionBps)} standard commission {broker.active ? '' : '· no longer taking listings'}
              </div>
              <AddressTag address={broker.address} sample={sample} />
            </Card>
          )}
          <Card className="space-y-2 text-xs text-bone-mute">
            <div>
              Seller <AddressTag address={listing.seller} sample={sample} />
            </div>
            {listing.buyer && (
              <div>
                Buyer <AddressTag address={listing.buyer} sample={sample} />
              </div>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ actions */

const ActionPanel: React.FC<{ item: MarketListing }> = ({ item }) => {
  const { listing, deed, sample } = item;
  const market = useMarket();
  const { deployment } = useNetwork();
  const { address, connect, wallet, onExpectedChain } = useWallet();
  const { run } = useTx();
  const [modal, setModal] = useState<'buy' | 'offer' | 'reprice' | 'cancel' | null>(null);

  if (sample) {
    return (
      <div className="space-y-2">
        <Button className="w-full" disabled>
          Buy now
        </Button>
        <Button variant="secondary" className="w-full" disabled>
          Make an offer
        </Button>
        <p className="text-xs text-bone-mute">Sample listing: transactions are switched off until the contracts are deployed on this network.</p>
      </div>
    );
  }
  if (listing.status === 'sold') return <Notice tone="info">Sold {listing.acceptedOfferId > 0n ? `to offer #${listing.acceptedOfferId.toString()}` : 'at the asking price'}.</Notice>;
  if (listing.status !== 'active') return <Notice tone="info">This listing was withdrawn by its seller.</Notice>;
  if (!address) {
    return (
      <div className="space-y-2">
        <Button className="w-full" onClick={connect}>
          {wallet ? `Connect ${wallet.name} to buy or offer` : 'Connect a Quai wallet'}
        </Button>
        {!wallet && <p className="text-xs text-bone-mute">Dark Questate works with Pelagus (desktop) and Blip (mobile).</p>}
      </div>
    );
  }

  const isSeller = sameAddress(address, listing.seller);
  const paused = market.status?.paused ?? false;
  const foreclosed = deed?.debt.foreclosed ?? false;
  const blocked = paused || foreclosed || !onExpectedChain;

  const sendCancel = async () => {
    setModal(null);
    await run('Cancel listing', [{ label: 'Withdraw the listing and return the deed to you', build: () => calls.cancelListing(deployment!, listing.id) }]);
  };

  return (
    <div className="space-y-2">
      {isSeller ? (
        <>
          <Button variant="secondary" className="w-full" onClick={() => setModal('reprice')} disabled={!onExpectedChain}>
            Change asking price
          </Button>
          <Button variant="danger" className="w-full" onClick={() => setModal('cancel')} disabled={!onExpectedChain}>
            Cancel listing
          </Button>
          <p className="text-xs text-bone-mute">You are the seller. Accept an offer from the offers list.</p>
        </>
      ) : (
        <>
          <Button className="w-full" onClick={() => setModal('buy')} disabled={blocked}>
            Buy now
          </Button>
          <Button variant="secondary" className="w-full" onClick={() => setModal('offer')} disabled={blocked}>
            Make an offer
          </Button>
          {foreclosed && <p className="text-xs text-rose-300">Foreclosed: this deed cannot close through the desk.</p>}
          {paused && <p className="text-xs text-amber-300">The desk is paused.</p>}
        </>
      )}
      {deed && <BuyModal open={modal === 'buy'} onClose={() => setModal(null)} item={item} />}
      {deed && <OfferModal open={modal === 'offer'} onClose={() => setModal(null)} item={item} />}
      <RepriceModal open={modal === 'reprice'} onClose={() => setModal(null)} item={item} />
      <Modal open={modal === 'cancel'} onClose={() => setModal(null)} title="Cancel this listing?" width="sm">
        <p className="text-sm text-bone-dim">The deed returns to your wallet. Buyers with open offers can withdraw their deposits at any time.</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setModal(null)}>
            Keep listing
          </Button>
          <Button variant="danger" onClick={sendCancel}>
            Cancel listing
          </Button>
        </div>
      </Modal>
    </div>
  );
};

const LienAck: React.FC<{ item: MarketListing; checked: boolean; onChange: (v: boolean) => void }> = ({ item, checked, onChange }) => {
  if (!item.deed || item.deed.debt.amount <= 0n) return null;
  return (
    <label className="flex items-start gap-2.5 rounded-lg border border-amber-400/30 bg-amber-400/[0.06] p-3 text-xs text-amber-100">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-[#c9a45c]" />
      <span>
        I accept the recorded {describeLien(item.deed.debt).headline.toLowerCase()}. If a larger lien is recorded before closing, the closing fails and my coin stays mine.
      </span>
    </label>
  );
};

const BuyModal: React.FC<{ open: boolean; onClose: () => void; item: MarketListing }> = ({ open, onClose, item }) => {
  const { deployment } = useNetwork();
  const { run } = useTx();
  const [ack, setAck] = useState(false);
  const needsAck = (item.deed?.debt.amount ?? 0n) > 0n;
  const send = async () => {
    onClose();
    await run('Buy now', [
      { label: `Pay ${formatQuai(item.listing.askPrice)} QUAI and receive the deed`, build: () => calls.buy(deployment!, item.listing.id, item.listing.askPrice, item.deed!.debt) },
    ]);
  };
  return (
    <Modal open={open} onClose={onClose} title="Buy at the asking price" subtitle={item.details.title}>
      <div className="space-y-4">
        <div className="rounded-lg border border-line bg-ink-deep p-4">
          <Quai wei={item.listing.askPrice} size="lg" />
        </div>
        <p className="text-sm leading-relaxed text-bone-dim">
          One transaction: your payment goes into the desk, the deed comes to your wallet, and the seller and broker are credited. If the price changes before your
          transaction lands, it fails without moving anything.
        </p>
        {item.deed && <LienDisclosure debt={item.deed.debt} compact />}
        <LienAck item={item} checked={ack} onChange={setAck} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Not now
          </Button>
          <Button onClick={send} disabled={needsAck && !ack}>
            Buy now
          </Button>
        </div>
      </div>
    </Modal>
  );
};

const OfferModal: React.FC<{ open: boolean; onClose: () => void; item: MarketListing }> = ({ open, onClose, item }) => {
  const { deployment, rpc } = useNetwork();
  const { run } = useTx();
  const [amountText, setAmountText] = useState('');
  const [days, setDays] = useState('7');
  const [ack, setAck] = useState(false);
  const amount = parseQuai(amountText);
  const needsAck = (item.deed?.debt.amount ?? 0n) > 0n;
  const error = amountText && (amount === null || amount === 0n) ? 'Enter an amount above zero, like 1,250,000.' : null;

  const send = async () => {
    if (!amount) return;
    onClose();
    await run('Make an offer', [
      {
        label: `Escrow ${formatQuai(amount)} QUAI as your offer`,
        build: async () => {
          // Expiry is counted from the chain's clock, not this computer's.
          const head = await rpc.request<{ timestamp?: string; woHeader?: { timestamp?: string } } | null>('quai_getBlockByNumber', ['latest', false]);
          const ts = Number(BigInt(head?.woHeader?.timestamp ?? head?.timestamp ?? Math.floor(Date.now() / 1000)));
          return calls.makeOffer(deployment!, item.listing.id, amount, ts + Number(days) * 86_400, item.deed!.debt);
        },
      },
    ]);
  };

  return (
    <Modal open={open} onClose={onClose} title="Make an offer" subtitle={item.details.title}>
      <div className="space-y-4">
        <TextField
          label="Your offer"
          suffix="QUAI"
          inputMode="decimal"
          placeholder={formatQuai(item.listing.askPrice, 0)}
          value={amountText}
          onChange={(e) => setAmountText(e.target.value)}
          error={error}
          help="The full amount is escrowed now and is the price if the seller accepts."
        />
        <SelectField
          label="Offer stands for"
          value={days}
          onChange={(e) => setDays(e.target.value)}
          options={OFFER_DAYS.map((d) => ({ value: String(d), label: `${d} day${d === 1 ? '' : 's'}` }))}
          help="You can withdraw it at any time before the seller accepts, and after it expires."
        />
        <LienAck item={item} checked={ack} onChange={setAck} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Not now
          </Button>
          <Button onClick={send} disabled={!amount || amount === 0n || (needsAck && !ack)}>
            Escrow offer
          </Button>
        </div>
      </div>
    </Modal>
  );
};

const RepriceModal: React.FC<{ open: boolean; onClose: () => void; item: MarketListing }> = ({ open, onClose, item }) => {
  const { deployment } = useNetwork();
  const { run } = useTx();
  const [text, setText] = useState('');
  const price = parseQuai(text);
  const send = async () => {
    if (!price) return;
    onClose();
    await run('Change asking price', [
      { label: `Set the asking price to ${formatQuai(price)} QUAI`, build: () => calls.updateListing(deployment!, item.listing.id, price, item.listing.detailsRaw) },
    ]);
  };
  return (
    <Modal open={open} onClose={onClose} title="Change asking price" width="sm">
      <div className="space-y-4">
        <TextField label="New asking price" suffix="QUAI" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} placeholder={formatQuai(item.listing.askPrice, 0)} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={send} disabled={!price}>
            Update price
          </Button>
        </div>
      </div>
    </Modal>
  );
};

/* ------------------------------------------------------------------ offers */

const OffersSection: React.FC<{ item: MarketListing; offers: OfferView[] }> = ({ item, offers }) => {
  const { deployment } = useNetwork();
  const { address, onExpectedChain } = useWallet();
  const market = useMarket();
  const { run } = useTx();
  const now = Math.floor(Date.now() / 1000);
  const isSeller = !item.sample && sameAddress(address, item.listing.seller);
  const sorted = useMemo(() => [...offers].sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1)), [offers]);
  const paused = market.status?.paused ?? false;

  const statusBadge = (o: OfferView) => {
    if (o.status === 'accepted') return <Badge tone="emerald">Accepted</Badge>;
    if (o.status === 'withdrawn') return <Badge tone="slate">Withdrawn</Badge>;
    if (o.expiresAt < now) return <Badge tone="slate">Expired</Badge>;
    return <Badge tone="amber">Open</Badge>;
  };

  return (
    <section>
      <h2 className="font-display text-2xl text-bone">Offers</h2>
      <p className="mt-1 text-xs text-bone-mute">Every open offer is a deposit held by the desk. Amounts are public on chain.</p>
      {sorted.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-line px-4 py-8 text-center text-sm text-bone-mute">No offers yet.</div>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[520px] text-sm">
            <thead className="bg-panel text-left text-[11px] uppercase tracking-[0.12em] text-bone-mute">
              <tr>
                <th className="px-4 py-2.5 font-medium">Offer</th>
                <th className="px-4 py-2.5 font-medium">Buyer</th>
                <th className="px-4 py-2.5 font-medium">Expires</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {sorted.map((o) => {
                const mine = !item.sample && sameAddress(address, o.buyer);
                return (
                  <tr key={o.id.toString()} className={cx(mine && 'bg-gold/[0.04]')}>
                    <td className="px-4 py-3 tabular-nums text-bone">{formatQuai(o.amount)} QUAI</td>
                    <td className="px-4 py-3">
                      <AddressTag address={o.buyer} sample={item.sample} label={mine ? 'You' : undefined} />
                    </td>
                    <td className="px-4 py-3 text-bone-dim">{o.status === 'open' ? relativeTime(o.expiresAt, now) : '—'}</td>
                    <td className="px-4 py-3">{statusBadge(o)}</td>
                    <td className="px-4 py-3 text-right">
                      {isSeller && item.listing.status === 'active' && offerIsAcceptable(o, now) && (
                        <Button
                          size="sm"
                          disabled={paused || !onExpectedChain}
                          onClick={() =>
                            run('Accept offer', [
                              {
                                label: `Sell for ${formatQuai(o.amount)} QUAI: the deed goes to the buyer and your proceeds are credited`,
                                build: () => calls.acceptOffer(deployment!, o.id),
                              },
                            ])
                          }
                        >
                          Accept
                        </Button>
                      )}
                      {mine && o.status === 'open' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={!onExpectedChain}
                          onClick={() => run('Withdraw offer', [{ label: `Return your ${formatQuai(o.amount)} QUAI deposit`, build: () => calls.withdrawOffer(deployment!, o.id) }])}
                        >
                          Withdraw
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
