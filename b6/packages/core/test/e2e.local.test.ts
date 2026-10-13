import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper shared with the local-market dev script
import { deployMarket, startHardhatNode } from '../../contracts/scripts/lib/localChain.mjs';
import { LOCAL, type NetworkConfig } from '../src/config.js';
import { RpcClient } from '../src/rpc.js';
import { BrokerageReader, calls, type Deployment, type TxRequest } from '../src/brokerage.js';
import { packageDeedIntake } from '../src/intake.js';
import { buildListingDetails, parseListingDetails } from '../src/listingDetails.js';
import { settlementFor } from '../src/money.js';
import { SimulationError, prepareTransaction, receiptSucceeded, sendPrepared, waitForConfirmations } from '../src/tx.js';

/**
 * End to end over real JSON-RPC: a Hardhat node runs the compiled contracts, and every write goes
 * through the same path the site uses (calldata from `calls`, prepareTransaction, the wallet's
 * *_sendTransaction, waitForConfirmations). Every read goes through BrokerageReader.
 */

const PORT = 18_545;
const network: NetworkConfig = { ...LOCAL, rpcUrl: `http://127.0.0.1:${PORT}` };
const Q = 10n ** 18n;

let node: { url: string; stop: () => Promise<void> };
let rpc: RpcClient;
let deployment: Deployment;
let reader: BrokerageReader;
let accounts: string[];

/** The node's unlocked dev accounts stand in for an injected wallet. */
const wallet = { request: (a: { method: string; params?: unknown[] }) => rpc.request(a.method, a.params ?? []) };

async function send(from: string, tx: TxRequest) {
  const prepared = await prepareTransaction(rpc, network, { from, ...tx });
  const hash = await sendPrepared(wallet, prepared, 'eth');
  const receipt = await waitForConfirmations(rpc, hash, { confirmations: 1, timeoutMs: 20_000, pollMs: 50 });
  expect(receiptSucceeded(receipt)).toBe(true);
  return receipt;
}

beforeAll(async () => {
  node = await startHardhatNode({ port: PORT });
  const m = await deployMarket(node.url);
  accounts = m.accounts;
  deployment = { deed: m.deed, brokerage: m.brokerage, fromBlock: m.fromBlock };
  rpc = new RpcClient(network);
  reader = new BrokerageReader(rpc, network, deployment);
}, 120_000);

afterAll(async () => {
  await node?.stop();
});

describe('brokerage end to end on a local chain', () => {
  const [OP, BROKER, SELLER, BUYER, RIVAL] = [0, 1, 2, 3, 4];
  const price = 1_000n * Q;
  let listingId: bigint;

  it('verifies the deployment it reads from', async () => {
    expect(await reader.verifyDeployment()).toEqual({ ok: true });
    const s = await reader.status();
    expect(s.operator.toLowerCase()).toBe(accounts[OP]!.toLowerCase());
    expect(s.registrar.toLowerCase()).toBe(accounts[OP]!.toLowerCase());
    expect(s.paused).toBe(false);
  });

  it('operator registers a broker; registrar mints a deed from an intake package', async () => {
    await send(accounts[OP]!, calls.registerBroker(deployment, accounts[BROKER]!, 'Obsidian Row Realty', 'LIC-7', 300));
    const brokers = await reader.brokers();
    expect(brokers.map((b) => [b.name, b.commissionBps, b.active])).toEqual([['Obsidian Row Realty', 300, true]]);

    const intake = packageDeedIntake(
      {
        recipient: accounts[SELLER]!,
        parcelId: 'apn-e2e-1',
        physicalAddress: '1 Test Street, Port Vale',
        legalOwner: 'Test Street Holdings LLC',
        legalDescription: 'Lot 1, Block 1, Port Vale register.',
        geoJson: JSON.stringify({ type: 'Polygon', coordinates: [[[0, 0], [0.001, 0], [0.001, 0.001], [0, 0.001], [0, 0]]] }),
        operatingAgreementText: 'Operating agreement of Test Street Holdings LLC, all members.',
      },
      network
    );
    expect(intake.ok).toBe(true);
    await send(accounts[OP]!, calls.mintDeed(deployment, intake.pkg!.mintArgs));

    const held = await reader.deedsHeldBy(accounts[SELLER]!);
    expect(held).toHaveLength(1);
    expect(held[0]!.record.parcelId).toBe('APN-E2E-1');
    expect(held[0]!.tokenURI).toBe(`ipfs://${intake.pkg!.metadataCid}`);
    expect(held[0]!.debt).toEqual({ token: '0x0000000000000000000000000000000000000000', amount: 0n, foreclosed: false });
  });

  it('seller approves and lists; the listing reads back with its details', async () => {
    const deedId = (await reader.deedsHeldBy(accounts[SELLER]!))[0]!.id;
    expect(await reader.isDeskApproved(accounts[SELLER]!, deedId)).toBe(false);
    await send(accounts[SELLER]!, calls.approveDeed(deployment, deedId));
    expect(await reader.isDeskApproved(accounts[SELLER]!, deedId)).toBe(true);

    const details = buildListingDetails({ title: 'Test Street House', type: 'residential', city: 'Port Vale', country: 'Portugal', summary: 'e2e', beds: 3 });
    await send(accounts[SELLER]!, calls.createListing(deployment, deedId, price, accounts[BROKER]!, details.json!));

    const [listing] = await reader.recentListings();
    expect(listing!.status).toBe('active');
    expect(listing!.askPrice).toBe(price);
    expect(listing!.commissionBps).toBe(300);
    expect(parseListingDetails(listing!.detailsRaw, 'x')).toMatchObject({ title: 'Test Street House', beds: 3, malformed: false });
    expect((await reader.deedById(deedId)).holder.toLowerCase()).toBe(deployment.brokerage.toLowerCase());
    listingId = listing!.id;
  });

  it('two buyers offer; the seller accepts one; the other withdraws', async () => {
    const debt = (await reader.deedById((await reader.listing(listingId))!.deedId)).debt;
    const head = await rpc.request<{ timestamp: string }>('eth_getBlockByNumber', ['latest', false]);
    const expiry = Number(BigInt(head.timestamp)) + 3 * 86_400;
    await send(accounts[BUYER]!, calls.makeOffer(deployment, listingId, 950n * Q, expiry, debt));
    await send(accounts[RIVAL]!, calls.makeOffer(deployment, listingId, 900n * Q, expiry, debt));

    const offers = await reader.offersForListing(listingId);
    expect(offers.map((o) => [o.status, o.amount])).toEqual([
      ['open', 950n * Q],
      ['open', 900n * Q],
    ]);
    expect((await reader.status()).totalOfferEscrow).toBe(1_850n * Q);

    await send(accounts[SELLER]!, calls.acceptOffer(deployment, offers[0]!.id));
    const sold = (await reader.listing(listingId))!;
    expect(sold.status).toBe('sold');
    expect(sold.salePrice).toBe(950n * Q);
    expect(sold.buyer!.toLowerCase()).toBe(accounts[BUYER]!.toLowerCase());
    expect((await reader.deedsHeldBy(accounts[BUYER]!))[0]!.record.parcelId).toBe('APN-E2E-1');

    const split = settlementFor(950n * Q, 300);
    expect(await reader.proceedsOf(accounts[SELLER]!)).toBe(split.sellerNet);
    expect(await reader.proceedsOf(accounts[BROKER]!)).toBe(split.commission);

    await send(accounts[RIVAL]!, calls.withdrawOffer(deployment, offers[1]!.id));
    expect((await reader.offersByBuyer(accounts[RIVAL]!))[0]!.status).toBe('withdrawn');
    expect((await reader.status()).totalOfferEscrow).toBe(0n);
  });

  it('refuses, in words and before sending, a purchase of a sold listing', async () => {
    const debt = { token: '0x0000000000000000000000000000000000000000', amount: 0n, foreclosed: false };
    const err = await prepareTransaction(rpc, network, { from: accounts[RIVAL]!, ...calls.buy(deployment, listingId, price, debt) }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(SimulationError);
    expect(err.message).toMatch(/no longer active/);
  });

  it('seller and broker withdraw exactly their credited proceeds', async () => {
    await send(accounts[SELLER]!, calls.withdrawProceeds(deployment));
    await send(accounts[BROKER]!, calls.withdrawProceeds(deployment));
    expect(await reader.proceedsOf(accounts[SELLER]!)).toBe(0n);
    expect((await reader.status()).totalProceedsOwed).toBe(0n);
    expect(await rpc.getBalance(deployment.brokerage)).toBe(0n);
  });
});
