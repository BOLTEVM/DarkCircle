import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { showcaseCatalogue } from '@darkquestate/core';
import { App } from '../src/App.js';
import { parseHash, href } from '../src/lib/router.js';
import { detectInjectedWallet } from '../src/lib/injectedWallet.js';
import { filterListings } from '../src/pages/ListingsPage.js';
import type { MarketListing } from '../src/state/MarketContext.js';
import { parseListingDetails } from '@darkquestate/core';

/** Every network request the page makes, answered offline: a block number for the RPC, nothing for the price feed. */
function stubNetwork() {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).includes('coingecko')) return new Response('{}', { status: 503 });
      const { id } = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0xa1b2c3' }));
    })
  );
  return calls;
}

beforeEach(() => {
  window.location.hash = '#/';
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('router', () => {
  it('parses every route and rejects junk', () => {
    expect(parseHash('')).toEqual({ name: 'home' });
    expect(parseHash('#/listings?q=port%20vale')).toEqual({ name: 'listings', q: 'port vale' });
    expect(parseHash('#/listing/42')).toEqual({ name: 'listing', id: 42n });
    expect(parseHash('#/listing/abc').name).toBe('notfound');
    expect(parseHash('#/listing/1/2').name).toBe('notfound');
    expect(parseHash('#/registrar')).toEqual({ name: 'registrar' });
    expect(parseHash('#/nope').name).toBe('notfound');
  });

  it('round-trips through href', () => {
    for (const r of [{ name: 'home' }, { name: 'listings', q: 'a b' }, { name: 'listing', id: 7n }, { name: 'sell' }] as const) {
      expect(parseHash(href(r))).toEqual(r);
    }
  });
});

describe('wallet detection', () => {
  it('accepts Pelagus and Blip, never a plain Ethereum wallet', () => {
    const request = async () => null;
    expect(detectInjectedWallet({ pelagus: { request } })).toMatchObject({ name: 'Pelagus', namespace: 'quai' });
    expect(detectInjectedWallet({ quai: { request, isBlip: true } })).toMatchObject({ name: 'Blip' });
    expect(detectInjectedWallet({ ethereum: { request } })).toBeNull();
    expect(detectInjectedWallet({ ethereum: { request, isPelagus: true } })).toMatchObject({ name: 'Pelagus' });
  });

  it('survives a wallet whose properties throw', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('denied'); } });
    expect(detectInjectedWallet(hostile)).toBeNull();
  });
});

describe('listing filters', () => {
  const cat = showcaseCatalogue(1_800_000_000);
  const items: MarketListing[] = cat.listings.map((l) => ({
    listing: l,
    deed: cat.deeds.get(l.deedId) ?? null,
    details: parseListingDetails(l.detailsRaw, 'x'),
    broker: null,
    openOffers: 0,
    sample: true,
  }));
  const base = { q: '', types: [], status: 'all' as const, min: null, max: null, beds: 0 };

  it('searches title, place and parcel id, word by word', () => {
    expect(filterListings(items, { ...base, q: 'port vale' }).map((m) => m.details.title)).toEqual(['Obsidian Point Residence']);
    expect(filterListings(items, { ...base, q: 'SAMPLE-CF' })).toHaveLength(1);
  });

  it('filters by status, type, price and bedrooms', () => {
    expect(filterListings(items, { ...base, status: 'sold' })).toHaveLength(1);
    expect(filterListings(items, { ...base, types: ['land'] })).toHaveLength(1);
    expect(filterListings(items, { ...base, max: 7_000_000n * 10n ** 18n }).every((m) => m.listing.askPrice <= 7_000_000n * 10n ** 18n)).toBe(true);
    expect(filterListings(items, { ...base, beds: 4 }).map((m) => m.details.title).sort()).toEqual(['Ashford Hollow Inn', 'Obsidian Point Residence']);
  });
});

describe('showcase mode (no deployment on the network)', () => {
  it('says so on every page and labels the samples', async () => {
    stubNetwork();
    render(<App />);
    expect(await screen.findByText(/listings below are invented samples/)).toBeInTheDocument();
    expect(screen.getAllByText('Sample').length).toBeGreaterThan(0);
  });

  it('switches off every transaction on a sample listing', async () => {
    stubNetwork();
    window.location.hash = '#/listing/1';
    render(<App />);
    const buy = await screen.findByRole('button', { name: 'Buy now' });
    expect(buy).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Make an offer' })).toBeDisabled();
    expect(screen.getByText(/transactions are switched off/)).toBeInTheDocument();
  });

  it('never sends anything but read-only RPC calls', async () => {
    const calls = stubNetwork();
    window.location.hash = '#/listing/3';
    render(<App />);
    await screen.findByText('Calder Flats Warehouse');
    const lien = screen.getByText(/Lien of 42,000 QUAI/);
    expect(within(lien.parentElement!.parentElement!).getByText(/stays with the property/)).toBeInTheDocument();
    for (const url of calls) expect(url).toMatch(/rpc\.quai\.network|coingecko/);
  });

  it('shows the registrar console read-only', async () => {
    stubNetwork();
    window.location.hash = '#/registrar';
    render(<App />);
    expect(await screen.findByText('No contracts on this network yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mint deed' })).toBeDisabled();
  });
});
