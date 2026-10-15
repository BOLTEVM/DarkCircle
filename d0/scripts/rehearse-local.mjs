#!/usr/bin/env node
/**
 * Rehearses the Grand Guild Halls against a local Hardhat chain, end to end:
 *   1. starts `hardhat node` on 127.0.0.1:<port> (default 8646, so other local chains are left alone)
 *   2. deploys GuildNameRegistry + TokenStackDeployer + GuildFactory, wired
 *   3. founds two halls with structured charters (crest, description, links)
 *   4. walks the steward paths the desk offers: a proposal grants a steward metadata power,
 *      then that steward rewrites the charter directly; a tribute lands in the treasury
 *   5. reads everything back through @darkorder/core and asserts what the frontpage will show
 *   6. writes apps/web/.env.localchain.local so `vite --mode localchain` sees this chain
 *
 *   node scripts/rehearse-local.mjs [--port 8646] [--smoke]
 *   pnpm dev:local   # then open the Local Hardhat network in the network picker
 *
 * Needs `pnpm build` first (contract artifacts and core's dist). Ctrl-C stops the chain;
 * --smoke stops it for you after the assertions. The accounts are Hardhat's published dev
 * keys: never fund them on a real network.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Contract } from 'ethers';
import { artifact, deployProtocol, startHardhatNode } from '../packages/contracts/scripts/lib/localChain.mjs';
import {
  GUILD_ROLES,
  NETWORKS,
  RpcClient,
  buildGuildProfile,
  encodeGrant,
  listGuildSummaries,
  newInvoiceId,
  parseGuildProfile,
  readGuildRoles,
} from '../packages/core/dist/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 8646);
const smoke = args.includes('--smoke');

/* -------------------------------------------------- a crest, encoded by hand (no deps) */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** 32x32 RGB PNG: an ember sigil (gold diamond on near-black) so the crest is visibly a crest. */
function emberCrest(gold, ember) {
  const S = 32;
  const raw = Buffer.alloc(S * (S * 3 + 1));
  for (let y = 0; y < S; y++) {
    const row = y * (S * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < S; x++) {
      const d = Math.abs(x - 16) + Math.abs(y - 16);
      const on = d <= 10 || (d <= 13 && (x === 16 || y === 16));
      const [r, g, b] = on ? gold : d <= 14 ? ember : [11, 10, 14];
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0);
  ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/* ------------------------------------------------------------- the rehearsal itself */
const node = await startHardhatNode({ port });
console.log(`hardhat node on ${node.url}`);

try {
  await rehearse(node.url);
} catch (e) {
  await node.stop();
  throw e;
}

async function rehearse(nodeUrl) {
  const { provider, accounts, registry, factory } = await deployProtocol(nodeUrl);
console.log(`registry  ${registry}`);
console.log(`factory   ${factory}`);

const signer = (i) => provider.getSigner(accounts[i]);
const factoryArt = artifact('GuildFactory');
const guildArt = artifact('Guild');
const tokenArt = artifact('GovernanceToken');
const votingArt = artifact('MajorityVoting');
const wait = async (txp) => (await txp).wait();

// A token hall, founded with a structured charter (crest + description + link).
const founder = await signer(0);
const vigilCharter = buildGuildProfile({
  description: 'Keepers of the crimson flame on the local chain. Treasury by token vote; the charter was set at founding and rewritten by its steward.',
  avatar: emberCrest([217, 164, 65], [64, 42, 20]),
  links: [{ label: 'The Vigil Charter', url: 'https://boltevm.com/darkorder' }],
});
const f = new Contract(factory, factoryArt.abi, founder);
await wait(
  f.foundGuild({
    name: 'crimsonvigil',
    metadata: vigilCharter,
    mode: 0,
    tokenName: 'Vigil Ember',
    tokenSymbol: 'VEMB',
    initialSupply: 1_000n * 10n ** 18n,
    supportThreshold: 5_000n,
    minParticipation: 1_000n,
    minDuration: 3_600n,
    members: [],
    minApprovals: 0n,
  })
);

// A council hall, founded with a plain-text charter (backward compatibility on display).
await wait(
  f.foundGuild({
    name: 'ashencouncil',
    metadata: 'Three keys, two to turn. A rehearsal council with a plain-text charter.',
    mode: 1,
    tokenName: '',
    tokenSymbol: '',
    initialSupply: 0n,
    supportThreshold: 0n,
    minParticipation: 0n,
    minDuration: 0n,
    members: [accounts[1], accounts[2], accounts[3]],
    minApprovals: 2n,
  })
);

const rpc = new RpcClient({ ...NETWORKS.local, rpcUrl: node.url });
const summaries = await listGuildSummaries(rpc, registry);
const vigil = summaries.find((g) => g.name === 'crimsonvigil');
const council = summaries.find((g) => g.name === 'ashencouncil');
if (!vigil || !council) throw new Error('the registry did not list both halls');
console.log(`crimsonvigil  guild ${vigil.guild}`);
console.log(`ashencouncil  guild ${council.guild}`);

// Steward path 1 — the proposal path: the hall votes to hand account 1 metadata power.
// The founder holds all voting power but must delegate before it counts.
const token = new Contract(vigil.token, tokenArt.abi, founder);
await wait(token.delegate(accounts[0]));
const module = new Contract(vigil.module, votingArt.abi, founder);
const grantData = encodeGrant(GUILD_ROLES.SET_METADATA, accounts[1]);
await wait(module.createProposal('Seat a steward for the charter', [{ to: vigil.guild, value: 0n, data: grantData }], 0n, 0n));
await wait(module.vote(0n, 2, true)); // yes, with early execution attempted
let proposal = await module.getProposal(0n);
if (!proposal.executed) await wait(module.execute(0n));
proposal = await module.getProposal(0n);
if (!proposal.executed) throw new Error('the steward proposal did not execute');

const stewardRoles = await readGuildRoles(rpc, vigil.guild, accounts[1]);
if (!stewardRoles.setMetadata) throw new Error('the steward did not receive metadata power');
console.log(`steward     ${accounts[1]} holds metadata power (via proposal 0)`);

// Steward path 2 — the direct path: the steward rewrites the charter with their own key.
const steward = new Contract(vigil.guild, guildArt.abi, await signer(1));
const rewritten = buildGuildProfile({
  description: 'The Vigil, restoked. This charter was rewritten by the steward the hall voted in — the direct path of the steward’s desk.',
  avatar: emberCrest([240, 196, 92], [80, 30, 24]),
  links: [
    { label: 'The Vigil Charter', url: 'https://boltevm.com/darkorder' },
    { label: 'Quai Network', url: 'https://qu.ai' },
  ],
});
await wait(steward.setMetadata(rewritten));

// Tribute: 5 QUAI from account 2, with an x402 invoice id.
const payer = new Contract(vigil.guild, guildArt.abi, await signer(2));
await wait(payer.payTribute(newInvoiceId(), { value: 5n * 10n ** 18n }));

/* --------------------------------------------------------------- readback assertions */
const after = await listGuildSummaries(rpc, registry);
const vig = after.find((g) => g.name === 'crimsonvigil');
const ash = after.find((g) => g.name === 'ashencouncil');
const vp = parseGuildProfile(vig.metadata);
const ap = parseGuildProfile(ash.metadata);

const assert = (cond, msg) => {
  if (!cond) throw new Error(`rehearsal assertion failed: ${msg}`);
  console.log(`  ok  ${msg}`);
};
assert(vp.avatar?.startsWith('data:image/png;base64,'), 'crimsonvigil charter carries a PNG crest');
assert(vp.description.startsWith('The Vigil, restoked'), 'the steward’s rewritten charter is what the chain returns');
assert(vp.links.length === 2 && vp.links[1].url === 'https://qu.ai', 'both links survived the rewrite');
assert(ap.avatar === null && ap.description.startsWith('Three keys'), 'plain-text charters still parse as descriptions');
assert(vig.treasury === 5n * 10n ** 18n, 'tribute of 5 QUAI sits in the treasury');
assert(ash.treasury === 0n, 'the council treasury starts empty');

const envFile = path.join(ROOT, 'apps/web/.env.localchain.local');
writeFileSync(
  envFile,
  [
    '# Written by scripts/rehearse-local.mjs: points `vite --mode localchain` at the local Hardhat chain.',
    'VITE_DARKORDER_LOCAL=1',
    `VITE_LOCAL_RPC=${node.url}`,
    `VITE_LOCAL_FACTORY=${factory}`,
    `VITE_LOCAL_REGISTRY=${registry}`,
    '',
  ].join('\n')
);
console.log(`wrote ${path.relative(ROOT, envFile)}`);
}

if (smoke) {
  await node.stop();
  console.log('REHEARSAL OK (smoke)');
  process.exit(0);
}
console.log('ready: run `pnpm dev:local`, pick the Local Hardhat network (accounts: 0 founder, 1 steward, 2-3 council)');
const stop = async () => {
  await node.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
