import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  BrokerageReader,
  parseListingDetails,
  sameAddress,
  showcaseCatalogue,
  type BrokerView,
  type DeedView,
  type DeskStatus,
  type ListingDetails,
  type ListingView,
  type OfferView,
} from '@darkquestate/core';
import { useNetwork } from './NetworkContext.js';

export interface MarketListing {
  listing: ListingView;
  deed: DeedView | null;
  details: ListingDetails & { malformed: boolean };
  broker: BrokerView | null;
  openOffers: number;
  /** Showcase record: invented, never on chain, every action disabled. */
  sample: boolean;
}

export type MarketMode = 'loading' | 'chain' | 'showcase' | 'error';

interface MarketState {
  mode: MarketMode;
  error: string | null;
  reader: BrokerageReader | null;
  status: DeskStatus | null;
  listings: MarketListing[];
  brokers: BrokerView[];
  offersFor: (listingId: bigint) => Promise<OfferView[]>;
  refresh: () => void;
  updatedAt: number | null;
}

const Ctx = createContext<MarketState | null>(null);
const MAX_LISTINGS = 60;

function enrich(listing: ListingView, deed: DeedView | null, brokers: BrokerView[], offers: OfferView[], sample: boolean, now: number): MarketListing {
  return {
    listing,
    deed,
    details: parseListingDetails(listing.detailsRaw, `Listing #${listing.id.toString()}`),
    broker: brokers.find((b) => sameAddress(b.address, listing.broker)) ?? null,
    openOffers: offers.filter((o) => o.listingId === listing.id && o.status === 'open' && o.expiresAt >= now).length,
    sample,
  };
}

export const MarketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { network, rpc, deployment } = useNetwork();
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<Omit<MarketState, 'offersFor' | 'refresh' | 'reader'>>({
    mode: 'loading',
    error: null,
    status: null,
    listings: [],
    brokers: [],
    updatedAt: null,
  });

  const reader = useMemo(() => {
    if (!deployment) return null;
    try {
      return new BrokerageReader(rpc, network, deployment);
    } catch {
      return null;
    }
  }, [rpc, network, deployment]);

  // Showcase data is built once per mount, with times relative to now.
  const catalogue = useMemo(() => showcaseCatalogue(Math.floor(Date.now() / 1000)), []);

  useEffect(() => {
    let alive = true;
    const now = Math.floor(Date.now() / 1000);
    if (!deployment) {
      setState({
        mode: 'showcase',
        error: null,
        status: null,
        brokers: catalogue.brokers,
        listings: catalogue.listings.map((l) => enrich(l, catalogue.deeds.get(l.deedId) ?? null, catalogue.brokers, catalogue.offers, true, now)),
        updatedAt: Date.now(),
      });
      return;
    }
    if (!reader) {
      setState((s) => ({ ...s, mode: 'error', error: 'The configured contract addresses are not valid Cyprus-1 addresses.' }));
      return;
    }
    setState((s) => ({ ...s, mode: s.mode === 'chain' ? 'chain' : 'loading', error: null }));
    (async () => {
      const check = await reader.verifyDeployment();
      if (!check.ok) throw new Error(check.problem);
      const [status, brokers, listings] = await Promise.all([reader.status(), reader.brokers(), reader.recentListings(MAX_LISTINGS)]);
      const rows = await Promise.all(
        listings.map(async (l) => {
          const [deed, offers] = await Promise.all([
            reader.deedById(l.deedId).catch(() => null),
            l.status === 'active' ? reader.offersForListing(l.id).catch(() => [] as OfferView[]) : Promise.resolve([] as OfferView[]),
          ]);
          return enrich(l, deed, brokers, offers, false, now);
        })
      );
      if (alive) setState({ mode: 'chain', error: null, status, brokers, listings: rows, updatedAt: Date.now() });
    })().catch((e: Error) => {
      if (alive) setState((s) => ({ ...s, mode: 'error', error: e.message }));
    });
    return () => {
      alive = false;
    };
  }, [deployment, reader, catalogue, tick]);

  const offersFor = useCallback(
    async (listingId: bigint): Promise<OfferView[]> => {
      if (!deployment) return catalogue.offers.filter((o) => o.listingId === listingId);
      if (!reader) return [];
      return reader.offersForListing(listingId);
    },
    [deployment, reader, catalogue]
  );

  const value = useMemo<MarketState>(() => ({ ...state, reader, offersFor, refresh: () => setTick((t) => t + 1) }), [state, reader, offersFor]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useMarket(): MarketState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMarket must be used inside MarketProvider');
  return v;
}
