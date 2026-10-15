import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Contract } from 'ethers';
// @ts-expect-error plain .mjs helper shared with the rehearsal script
import { artifact, deployProtocol, startHardhatNode } from '../../contracts/scripts/lib/localChain.mjs';
import { NETWORKS } from '../src/config.js';
import { RpcClient } from '../src/rpc.js';
import {
  buildGuildProfile,
  listGuildSummaries,
  listGuilds,
  parseGuildProfile,
  readCouncilMembers,
  readGuildRoles,
  type GuildSummary,
} from '../src/index.js';

/**
 * The readers over real JSON-RPC. The decode layer once wrapped single returns in an extra
 * Result, so every tuple/array reader (listGuilds, recordOf, members, proposals) returned
 * undefined fields and the directory rendered empty — caught only when the app first ran
 * against a live chain. This suite keeps that class of bug locked out.
 */

const PORT = 18_546;
let node: { url: string; stop: () => Promise<void> };
let rpc: RpcClient;
let registry: string;
let accounts: string[];

beforeAll(async () => {
  node = await startHardhatNode({ port: PORT });
  const deployed = await deployProtocol(node.url);
  accounts = deployed.accounts;
  registry = deployed.registry;
  rpc = new RpcClient({ ...NETWORKS.local, rpcUrl: node.url });

  const founder = await deployed.provider.getSigner(accounts[0]!);
  const factory = new Contract(deployed.factory, artifact('GuildFactory').abi, founder) as any;
  const charter = buildGuildProfile({
    description: 'A hall read back over JSON-RPC.',
    avatar: null,
    links: [{ label: 'Spec', url: 'https://boltevm.com/darkorder' }],
  });
  const wait = async (txp: Promise<any>) => (await txp).wait();
  await wait(
    factory.foundGuild({
      name: 'readback',
      metadata: charter,
      mode: 0,
      tokenName: 'Readback Token',
      tokenSymbol: 'RBT',
      initialSupply: 100n * 10n ** 18n,
      supportThreshold: 5000n,
      minParticipation: 1000n,
      minDuration: 3600n,
      members: [],
      minApprovals: 0n,
    })
  );
  await wait(
    factory.foundGuild({
      name: 'readcouncil',
      metadata: 'A plain-text council charter.',
      mode: 1,
      tokenName: '',
      tokenSymbol: '',
      initialSupply: 0n,
      supportThreshold: 0n,
      minParticipation: 0n,
      minDuration: 0n,
      members: [accounts[1]!, accounts[2]!, accounts[3]!],
      minApprovals: 2n,
    })
  );
}, 120_000);

afterAll(async () => {
  await node?.stop();
});

describe('readers over a live chain', () => {
  it('lists both halls with every field populated', async () => {
    const guilds = await listGuilds(rpc, registry);
    expect(guilds).toHaveLength(2);
    const token = guilds.find((g) => g.name === 'readback');
    const council = guilds.find((g) => g.name === 'readcouncil');
    expect(token?.mode).toBe('token');
    expect(token?.token).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(token?.module).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(council?.mode).toBe('council');
    expect(council?.token).toBeNull();
  });

  it('reads metadata and treasuries, and the profile round-trips', async () => {
    const summaries: GuildSummary[] = await listGuildSummaries(rpc, registry);
    const token = summaries.find((g) => g.name === 'readback');
    const council = summaries.find((g) => g.name === 'readcouncil');
    expect(token).toBeDefined();
    const profile = parseGuildProfile(token!.metadata);
    expect(profile.description).toBe('A hall read back over JSON-RPC.');
    expect(profile.links).toEqual([{ label: 'Spec', url: 'https://boltevm.com/darkorder' }]);
    expect(token!.treasury).toBe(0n);
    expect(parseGuildProfile(council!.metadata).description).toBe('A plain-text council charter.');
  });

  it('shows post-founding sovereignty: the module holds execute power, the founder nothing', async () => {
    const [token] = await listGuilds(rpc, registry);
    const guild = token!.guild;
    const moduleRoles = await readGuildRoles(rpc, guild, token!.module);
    expect(moduleRoles).toEqual({ root: false, execute: true, setMetadata: false });
    const founderRoles = await readGuildRoles(rpc, guild, accounts[0]!);
    expect(founderRoles).toEqual({ root: false, execute: false, setMetadata: false });
  });

  it('reads council membership as a list of addresses', async () => {
    const [, council] = await listGuilds(rpc, registry);
    const members = await readCouncilMembers(rpc, council!.module);
    expect(members).toHaveLength(3);
    for (const m of members) expect(m).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
