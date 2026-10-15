import { buildGuildProfile } from './profile.js';
import type { GuildRecord, GuildSummary, VotingProposalView } from './guilds.js';

/**
 * Showcase content for when the protocol is not deployed on the selected network. Every
 * address below is in-zone in form only (0x00 prefix, second byte below 0x80) but reserved
 * and unspendable-looking, so a sample guild can never be mistaken for, or collide with, a
 * real Cyprus-1 guild. The UI labels everything from this file "Showcase" and switches all
 * transactions off.
 */

const sample = (n: number) => `0x00${n.toString(16).padStart(38, '0')}`;

export const SHOWCASE_GUILDS: GuildRecord[] = [
  { name: 'emberhold', guild: sample(0xe1be2), token: sample(0xe1be3), module: sample(0xe1be4), mode: 'token' },
  { name: 'ironcouncil', guild: sample(0xc0ec1), token: null, module: sample(0xc0ec2), mode: 'council' },
  { name: 'veilkeepers', guild: sample(0x3e11), token: sample(0x3e12), module: sample(0x3e13), mode: 'token' },
];

const LORE: Record<string, string> = {
  emberhold: buildGuildProfile({
    description: 'Keepers of the crimson flame. Treasury decisions by token vote, 50% support, 20% turnout.',
    avatar: null,
    links: [{ label: 'The Ember Charter', url: 'https://boltevm.com/darkorder' }],
  }),
  ironcouncil: buildGuildProfile({
    description: 'Five keys, three to turn. A council guild guarding the suite multisig bridge.',
    avatar: null,
    links: [{ label: 'DarkSafe', url: 'https://boltevm.com/darksafe' }],
  }),
  veilkeepers: 'A quiet order. Proposals appear at dusk; abstentions are counted and respected.',
};

export function showcaseSummary(record: GuildRecord): GuildSummary {
  return {
    ...record,
    metadata: LORE[record.name] ?? 'A hall of the DarkOrder.',
    treasury: record.name === 'ironcouncil' ? 12_500n * 10n ** 18n : 3_200n * 10n ** 18n,
  };
}

export function showcaseProposal(guild: string, id: number): VotingProposalView {
  const now = Math.floor(Date.now() / 1000);
  void guild;
  return {
    id,
    startDate: now - 86_400,
    endDate: now + 172_800,
    snapshotBlock: 1_920_000n,
    supportThreshold: 5000n,
    minParticipation: 2000n,
    yes: 41_250n * 10n ** 18n,
    no: 9_800n * 10n ** 18n,
    abstain: 1_100n * 10n ** 18n,
    executed: false,
    metadata: id === 0 ? 'Fund the beacon relay for three more cycles' : 'Admit the Ashen Delegates to the outer hall',
  };
}
