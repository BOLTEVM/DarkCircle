import React from 'react';
import { ShieldCheck } from 'lucide-react';
import { formatBps, sameAddress } from '@darkquestate/core';
import { Badge, Card } from '@darkquestate/ui';
import { useMarket } from '../state/MarketContext.js';
import { AddressTag } from '../components/Money.js';

export const BrokersPage: React.FC = () => {
  const market = useMarket();
  const sample = market.mode === 'showcase';
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 lg:px-8">
      <h1 className="font-display text-4xl text-bone">Brokers</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-bone-dim">
        Every listing goes through a broker the operator has registered, with a licence id and a commission of at most 10%. The commission is fixed when a property is
        listed and paid from the sale price only when it sells.
      </p>
      <div className="mt-8 grid gap-4 sm:grid-cols-2">
        {market.brokers.map((b) => {
          const listed = market.listings.filter((l) => l.listing.status === 'active' && sameAddress(l.listing.broker, b.address)).length;
          return (
            <Card key={b.address} className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 font-display text-lg text-bone">
                  <ShieldCheck className="h-4 w-4 text-gold" aria-hidden /> {b.name}
                </div>
                {b.active ? <Badge tone="emerald">Taking listings</Badge> : <Badge tone="slate">Inactive</Badge>}
              </div>
              <dl className="grid grid-cols-3 gap-3 text-sm">
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-bone-mute">Licence</dt>
                  <dd className="mt-1 font-mono text-xs text-bone">{b.licenseId}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-bone-mute">Commission</dt>
                  <dd className="mt-1 text-bone">{formatBps(b.commissionBps)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-[0.14em] text-bone-mute">For sale</dt>
                  <dd className="mt-1 text-bone">{listed}</dd>
                </div>
              </dl>
              <AddressTag address={b.address} sample={sample} />
            </Card>
          );
        })}
      </div>
      {market.mode !== 'loading' && market.brokers.length === 0 && (
        <div className="mt-8 rounded-xl border border-dashed border-line py-16 text-center text-sm text-bone-mute">No brokers are registered yet.</div>
      )}
    </div>
  );
};
