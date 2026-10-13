import type { Interface, Result } from 'ethers';
import { brokerageInterface, deedInterface } from './abi.js';
import { requireAddress, sameAddress, ZERO_ADDRESS } from './address.js';
import type { NetworkConfig } from './config.js';
import type { RpcClient } from './rpc.js';

/** Where the two contracts live on one network. */
export interface Deployment {
  deed: string;
  brokerage: string;
  /** First block worth scanning for events (the deployment block). */
  fromBlock?: number;
}

export type ListingStatus = 'none' | 'active' | 'sold' | 'cancelled';
export type OfferStatus = 'none' | 'open' | 'withdrawn' | 'accepted';

const LISTING_STATUS: ListingStatus[] = ['none', 'active', 'sold', 'cancelled'];
const OFFER_STATUS: OfferStatus[] = ['none', 'open', 'withdrawn', 'accepted'];

export interface BrokerView {
  address: string;
  name: string;
  licenseId: string;
  commissionBps: number;
  active: boolean;
  registered: boolean;
}

export interface DeedRecordView {
  legalDescription: string;
  physicalAddress: string;
  geoJson: string;
  parcelId: string;
  legalOwner: string;
  operatingAgreementHash: string;
}

export interface DebtView {
  token: string;
  /** Positive: a lien. Negative: a credit owed to the holder. */
  amount: bigint;
  foreclosed: boolean;
}

export interface DeedView {
  id: bigint;
  holder: string;
  manager: string;
  tokenURI: string;
  record: DeedRecordView;
  debt: DebtView;
}

export interface ListingView {
  id: bigint;
  deedId: bigint;
  seller: string;
  createdAt: number;
  status: ListingStatus;
  broker: string;
  commissionBps: number;
  askPrice: bigint;
  buyer: string | null;
  salePrice: bigint;
  acceptedOfferId: bigint;
  detailsRaw: string;
}

export interface OfferView {
  id: bigint;
  listingId: bigint;
  buyer: string;
  expiresAt: number;
  status: OfferStatus;
  amount: bigint;
  debtToken: string;
  maxDebt: bigint;
}

export interface DeskStatus {
  operator: string;
  registrar: string;
  paused: boolean;
  listingCount: bigint;
  offerCount: bigint;
  totalOfferEscrow: bigint;
  totalProceedsOwed: bigint;
}

export interface TxRequest {
  to: string;
  data: string;
  value?: bigint;
}

const PAGE = 100n;
const PARALLEL = 6;

/** Runs `fn` over `items` with at most PARALLEL requests in flight (public RPCs rate-limit bursts). */
async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Reads the deed registry and brokerage over plain JSON-RPC calls. */
export class BrokerageReader {
  readonly deedAddress: string;
  readonly brokerageAddress: string;

  constructor(
    private readonly rpc: RpcClient,
    network: Pick<NetworkConfig, 'addressRule'>,
    deployment: Deployment
  ) {
    this.deedAddress = requireAddress(deployment.deed, network.addressRule, 'Deed registry');
    this.brokerageAddress = requireAddress(deployment.brokerage, network.addressRule, 'Brokerage');
  }

  private async read(iface: Interface, to: string, fn: string, args: unknown[] = []): Promise<Result> {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await this.rpc.call({ to, data });
    return iface.decodeFunctionResult(fn, raw);
  }

  private desk(fn: string, args: unknown[] = []) {
    return this.read(brokerageInterface, this.brokerageAddress, fn, args);
  }

  private deed(fn: string, args: unknown[] = []) {
    return this.read(deedInterface, this.deedAddress, fn, args);
  }

  /** True when both addresses hold code and the brokerage points at this registry. */
  async verifyDeployment(): Promise<{ ok: boolean; problem?: string }> {
    const [deedCode, deskCode] = await Promise.all([this.rpc.getCode(this.deedAddress), this.rpc.getCode(this.brokerageAddress)]);
    if (!deedCode || deedCode === '0x') return { ok: false, problem: `No contract at the deed registry address ${this.deedAddress}.` };
    if (!deskCode || deskCode === '0x') return { ok: false, problem: `No contract at the brokerage address ${this.brokerageAddress}.` };
    const [linked] = await this.desk('deed');
    if (!sameAddress(linked, this.deedAddress)) return { ok: false, problem: 'The brokerage is linked to a different deed registry.' };
    return { ok: true };
  }

  async status(): Promise<DeskStatus> {
    const [operator, registrar, paused, listingCount, offerCount, escrow, owed] = await Promise.all([
      this.desk('owner'),
      this.deed('owner'),
      this.desk('paused'),
      this.desk('listingCount'),
      this.desk('offerCount'),
      this.desk('totalOfferEscrow'),
      this.desk('totalProceedsOwed'),
    ]);
    return {
      operator: operator[0],
      registrar: registrar[0],
      paused: paused[0],
      listingCount: listingCount[0],
      offerCount: offerCount[0],
      totalOfferEscrow: escrow[0],
      totalProceedsOwed: owed[0],
    };
  }

  async listing(id: bigint): Promise<ListingView | null> {
    const [l] = await this.desk('getListing', [id]);
    const status = LISTING_STATUS[Number(l.status)] ?? 'none';
    if (status === 'none') return null;
    return {
      id,
      deedId: l.deedId,
      seller: l.seller,
      createdAt: Number(l.createdAt),
      status,
      broker: l.broker,
      commissionBps: Number(l.commissionBps),
      askPrice: l.askPrice,
      buyer: l.buyer === ZERO_ADDRESS ? null : l.buyer,
      salePrice: l.salePrice,
      acceptedOfferId: l.acceptedOfferId,
      detailsRaw: l.details,
    };
  }

  /** The newest `limit` listings, newest first. */
  async recentListings(limit = 60): Promise<ListingView[]> {
    const [count] = await this.desk('listingCount');
    const ids: bigint[] = [];
    for (let id = count as bigint; id >= 1n && ids.length < limit; id--) ids.push(id);
    const rows = await mapLimited(ids, (id) => this.listing(id));
    return rows.filter((r): r is ListingView => r !== null);
  }

  async offer(id: bigint): Promise<OfferView | null> {
    const [o] = await this.desk('getOffer', [id]);
    const status = OFFER_STATUS[Number(o.status)] ?? 'none';
    if (status === 'none') return null;
    return {
      id,
      listingId: o.listingId,
      buyer: o.buyer,
      expiresAt: Number(o.expiresAt),
      status,
      amount: o.amount,
      debtToken: o.debtToken,
      maxDebt: o.maxDebt,
    };
  }

  private async pagedIds(countFn: string, pageFn: string, key: unknown): Promise<bigint[]> {
    const [count] = await this.desk(countFn, [key]);
    const ids: bigint[] = [];
    for (let offset = 0n; offset < (count as bigint); offset += PAGE) {
      const [page] = await this.desk(pageFn, [key, offset, PAGE]);
      ids.push(...(page as bigint[]));
    }
    return ids;
  }

  async offersForListing(listingId: bigint): Promise<OfferView[]> {
    const ids = await this.pagedIds('offerCountForListing', 'offersForListing', listingId);
    return (await mapLimited(ids, (id) => this.offer(id))).filter((o): o is OfferView => o !== null);
  }

  async offersByBuyer(buyer: string): Promise<OfferView[]> {
    const ids = await this.pagedIds('offerCountForBuyer', 'offersByBuyer', buyer);
    return (await mapLimited(ids, (id) => this.offer(id))).filter((o): o is OfferView => o !== null);
  }

  async listingsBySeller(seller: string): Promise<ListingView[]> {
    const ids = await this.pagedIds('listingCountForSeller', 'listingsBySeller', seller);
    return (await mapLimited(ids, (id) => this.listing(id))).filter((l): l is ListingView => l !== null);
  }

  async broker(address: string): Promise<BrokerView> {
    const [b] = await this.desk('getBroker', [address]);
    return {
      address,
      name: b.name,
      licenseId: b.licenseId,
      commissionBps: Number(b.commissionBps),
      active: b.active,
      registered: b.registered,
    };
  }

  async brokers(): Promise<BrokerView[]> {
    const [count] = await this.desk('brokerCount');
    const addresses: string[] = [];
    for (let offset = 0n; offset < (count as bigint); offset += PAGE) {
      const [page] = await this.desk('brokersPage', [offset, PAGE]);
      addresses.push(...(page as string[]));
    }
    return mapLimited(addresses, (a) => this.broker(a));
  }

  async deedById(id: bigint): Promise<DeedView> {
    const [holder, record, debt, manager, uri] = await Promise.all([
      this.deed('ownerOf', [id]),
      this.deed('deedRecord', [id]),
      this.deed('debtOf', [id]),
      this.deed('managerOf', [id]),
      this.deed('tokenURI', [id]),
    ]);
    const r = record[0];
    return {
      id,
      holder: holder[0],
      manager: manager[0],
      tokenURI: uri[0],
      record: {
        legalDescription: r.legalDescription,
        physicalAddress: r.physicalAddress,
        geoJson: r.geoJson,
        parcelId: r.parcelId,
        legalOwner: r.legalOwner,
        operatingAgreementHash: r.operatingAgreementHash,
      },
      debt: { token: debt[0], amount: debt[1], foreclosed: debt[2] },
    };
  }

  /** Deeds sitting in `holder`'s wallet (listed deeds are held by the brokerage instead). */
  async deedsHeldBy(holder: string): Promise<DeedView[]> {
    const [balance] = await this.deed('balanceOf', [holder]);
    const indexes = Array.from({ length: Number(balance) }, (_, i) => BigInt(i));
    const ids = await mapLimited(indexes, async (i) => (await this.deed('tokenOfOwnerByIndex', [holder, i]))[0] as bigint);
    return mapLimited(ids, (id) => this.deedById(id));
  }

  /** Every deed ever minted (the registrar's view), newest first, up to `limit`. */
  async allDeeds(limit = 200): Promise<DeedView[]> {
    const [supply] = await this.deed('totalSupply');
    const n = Math.min(Number(supply), limit);
    const indexes = Array.from({ length: n }, (_, i) => BigInt(Number(supply) - 1 - i));
    const ids = await mapLimited(indexes, async (i) => (await this.deed('tokenByIndex', [i]))[0] as bigint);
    return mapLimited(ids, (id) => this.deedById(id));
  }

  async proceedsOf(payee: string): Promise<bigint> {
    return (await this.desk('proceeds', [payee]))[0];
  }

  async isDeskApproved(holder: string, deedId: bigint): Promise<boolean> {
    const [[approved], [all]] = await Promise.all([
      this.deed('getApproved', [deedId]),
      this.deed('isApprovedForAll', [holder, this.brokerageAddress]),
    ]);
    return all || sameAddress(approved, this.brokerageAddress);
  }
}

/* ------------------------------------------------------------------ calldata */

/** The lien terms a buyer accepts: exactly what is recorded now (a credit or nothing means "no lien"). */
export function lienTermsFor(debt: DebtView): { debtToken: string; maxDebt: bigint } {
  return debt.amount > 0n ? { debtToken: debt.token, maxDebt: debt.amount } : { debtToken: ZERO_ADDRESS, maxDebt: 0n };
}

export const calls = {
  approveDeed: (d: Deployment, deedId: bigint): TxRequest => ({
    to: d.deed,
    data: deedInterface.encodeFunctionData('approve', [d.brokerage, deedId]),
  }),
  createListing: (d: Deployment, deedId: bigint, askPrice: bigint, broker: string, detailsJson: string): TxRequest => ({
    to: d.brokerage,
    data: brokerageInterface.encodeFunctionData('createListing', [deedId, askPrice, broker, detailsJson]),
  }),
  updateListing: (d: Deployment, listingId: bigint, askPrice: bigint, detailsJson: string): TxRequest => ({
    to: d.brokerage,
    data: brokerageInterface.encodeFunctionData('updateListing', [listingId, askPrice, detailsJson]),
  }),
  cancelListing: (d: Deployment, listingId: bigint): TxRequest => ({
    to: d.brokerage,
    data: brokerageInterface.encodeFunctionData('cancelListing', [listingId]),
  }),
  acceptOffer: (d: Deployment, offerId: bigint): TxRequest => ({
    to: d.brokerage,
    data: brokerageInterface.encodeFunctionData('acceptOffer', [offerId]),
  }),
  buy: (d: Deployment, listingId: bigint, price: bigint, debt: DebtView): TxRequest => {
    const t = lienTermsFor(debt);
    return { to: d.brokerage, data: brokerageInterface.encodeFunctionData('buy', [listingId, t.debtToken, t.maxDebt]), value: price };
  },
  makeOffer: (d: Deployment, listingId: bigint, amount: bigint, expiresAt: number, debt: DebtView): TxRequest => {
    const t = lienTermsFor(debt);
    return {
      to: d.brokerage,
      data: brokerageInterface.encodeFunctionData('makeOffer', [listingId, BigInt(expiresAt), t.debtToken, t.maxDebt]),
      value: amount,
    };
  },
  withdrawOffer: (d: Deployment, offerId: bigint): TxRequest => ({
    to: d.brokerage,
    data: brokerageInterface.encodeFunctionData('withdrawOffer', [offerId]),
  }),
  withdrawProceeds: (d: Deployment): TxRequest => ({
    to: d.brokerage,
    data: brokerageInterface.encodeFunctionData('withdrawProceeds'),
  }),
  mintDeed: (d: Deployment, args: { recipient: string; legalDescription: string; physicalAddress: string; geoJson: string; parcelId: string; legalOwner: string; operatingAgreementHash: string; metadataUri: string }): TxRequest => ({
    to: d.deed,
    data: deedInterface.encodeFunctionData('mintDeed', [args]),
  }),
  setDebt: (d: Deployment, deedId: bigint, debtToken: string, amount: bigint): TxRequest => ({
    to: d.deed,
    data: deedInterface.encodeFunctionData('setDebt', [deedId, debtToken, amount]),
  }),
  foreclose: (d: Deployment, deedId: bigint): TxRequest => ({
    to: d.deed,
    data: deedInterface.encodeFunctionData('foreclose', [deedId]),
  }),
  registerBroker: (d: Deployment, broker: string, name: string, licenseId: string, commissionBps: number): TxRequest => ({
    to: d.brokerage,
    data: brokerageInterface.encodeFunctionData('registerBroker', [broker, name, licenseId, commissionBps]),
  }),
  setBrokerActive: (d: Deployment, broker: string, active: boolean): TxRequest => ({
    to: d.brokerage,
    data: brokerageInterface.encodeFunctionData('setBrokerActive', [broker, active]),
  }),
  setPaused: (d: Deployment, paused: boolean): TxRequest => ({
    to: d.brokerage,
    data: brokerageInterface.encodeFunctionData('setPaused', [paused]),
  }),
};

/** An offer is live for acceptance only while open and unexpired. */
export function offerIsAcceptable(offer: OfferView, nowSeconds: number): boolean {
  return offer.status === 'open' && nowSeconds <= offer.expiresAt;
}
