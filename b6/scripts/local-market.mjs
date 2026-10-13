#!/usr/bin/env node
/**
 * Runs Dark Questate against a local Hardhat chain, end to end:
 *   1. starts `hardhat node` on 127.0.0.1:<port> (default 8645, so other local chains on 8545 are left alone)
 *   2. deploys QuestateDeed + QuestateBrokerage
 *   3. seeds a small market from the showcase catalogue: brokers, deeds, listings, offers, one sale, one lien
 *   4. writes apps/web/.env.localchain.local so `vite --mode localchain` reads that chain with a dev wallet
 *
 *   node scripts/local-market.mjs [--port 8645] [--no-seed]
 *   pnpm --filter @darkquestate/web exec vite --mode localchain
 *
 * Needs `pnpm build` first (contract artifacts and core's dist). Ctrl-C stops the chain.
 * The accounts are Hardhat's published dev keys: never fund them on a real network.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract } from '../packages/contracts/node_modules/ethers/lib.esm/index.js';
import { artifact, deployMarket, fundAccounts, startHardhatNode } from '../packages/contracts/scripts/lib/localChain.mjs';
import { packageDeedIntake, parseParcelGeoJson, showcaseCatalogue } from '../packages/core/dist/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 8645);
const seed = !args.includes('--no-seed');

const node = await startHardhatNode({ port });
console.log(`hardhat node on ${node.url}`);
const market = await deployMarket(node.url);
console.log(`QuestateDeed       ${market.deed}`);
console.log(`QuestateBrokerage  ${market.brokerage}`);

const { provider, accounts } = market;
await fundAccounts(provider, accounts, 10n ** 27n); // 1e9 QUAI each
const signer = (i) => provider.getSigner(accounts[i]);
const deedArt = artifact('QuestateDeed');
const deskArt = artifact('QuestateBrokerage');
const asDeed = async (i) => new Contract(market.deed, deedArt.abi, await signer(i));
const asDesk = async (i) => new Contract(market.brokerage, deskArt.abi, await signer(i));
const wait = async (txp) => (await txp).wait();

if (seed) {
  // accounts: 0 operator+registrar, 1-2 brokers, 3-8 sellers, 9-11 buyers
  const cat = showcaseCatalogue(Math.floor(Date.now() / 1000));
  const op = await asDesk(0);
  await wait(op.registerBroker(accounts[1], 'Obsidian Row Realty', 'LOCAL-BRK-001', 300));
  await wait(op.registerBroker(accounts[2], 'Meridian Ledger Estates', 'LOCAL-BRK-002', 250));
  const brokerFor = (b) => (b === cat.brokers[0].address ? accounts[1] : accounts[2]);

  const registrar = await asDeed(0);
  let listed = 0;
  for (const [i, l] of cat.listings.entries()) {
    const d = cat.deeds.get(l.deedId);
    const seller = 3 + i;
    const polygon = parseParcelGeoJson(d.record.geoJson).polygon;
    const pkg = packageDeedIntake(
      {
        recipient: accounts[seller],
        parcelId: d.record.parcelId.replace('SAMPLE-', 'LOCAL-'),
        physicalAddress: d.record.physicalAddress,
        legalOwner: d.record.legalOwner.replace(' (sample)', ''),
        legalDescription: d.record.legalDescription.replace(' (sample record, not a real title)', ''),
        geoJson: JSON.stringify(polygon),
        operatingAgreementText: `Operating agreement of ${d.record.legalOwner} (local dev chain).`,
      },
      { addressRule: 'any' }
    );
    if (!pkg.ok) throw new Error(pkg.errors.join('; '));
    await wait(registrar.mintDeed(pkg.pkg.mintArgs));
    const deedId = await registrar.tokenOfOwnerByIndex(accounts[seller], 0);
    if (d.debt.amount !== 0n) await wait(registrar.setDebt(deedId, '0x0000000000000000000000000000000000000000', d.debt.amount));

    const sellerDeed = await asDeed(seller);
    await wait(sellerDeed.approve(market.brokerage, deedId));
    const sellerDesk = await asDesk(seller);
    await wait(sellerDesk.createListing(deedId, l.askPrice, brokerFor(l.broker), l.detailsRaw.replace(' Sample listing.', '')));
    listed++;
    const listingId = await sellerDesk.listingCount();

    const block = await provider.getBlock('latest');
    for (const o of cat.offers.filter((x) => x.listingId === l.id)) {
      const buyer = 9 + cat.offers.indexOf(o) % 3;
      const desk = await asDesk(buyer);
      await wait(desk.makeOffer(listingId, block.timestamp + 5 * 86_400, '0x0000000000000000000000000000000000000000', d.debt.amount > 0n ? d.debt.amount : 0n, { value: o.amount }));
      if (o.status === 'accepted') {
        const offerId = await desk.offerCount();
        await wait(sellerDesk.acceptOffer(offerId));
      }
    }
  }
  console.log(`seeded ${listed} listings (one sold, one with a lien, open offers on two)`);
}

const envFile = path.join(ROOT, 'apps/web/.env.localchain.local');
writeFileSync(
  envFile,
  [
    '# Written by scripts/local-market.mjs: points `vite --mode localchain` at the local Hardhat chain.',
    'VITE_QUESTATE_LOCAL=1',
    `VITE_LOCAL_RPC=${node.url}`,
    `VITE_LOCAL_DEED=${market.deed}`,
    `VITE_LOCAL_BROKERAGE=${market.brokerage}`,
    '',
  ].join('\n')
);
console.log(`wrote ${path.relative(ROOT, envFile)}`);
console.log('ready: run `pnpm --filter @darkquestate/web exec vite --mode localchain` (Ctrl-C here stops the chain)');

const stop = async () => {
  await node.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
