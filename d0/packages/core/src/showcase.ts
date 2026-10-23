import type { GuildRecord, GuildSummary, VotingProposalView } from './guilds.js';

/**
 * Showcase content for when the protocol is not deployed on the selected network (today that
 * means every network except Quai mainnet). Instead of inventing sample halls, the showcase
 * mirrors the two real Cyprus-1 halls of the DarkOrder — same handles, same contract
 * addresses, same charter text as on chain — so the site reads truthfully even where it
 * cannot talk to the chain. The UI labels everything from this file "Showcase" and switches
 * all transactions off.
 *
 * The records below are the live mainnet registry page() result (block 10672507 onward);
 * treasuries are a snapshot from 2026-10-22 and drift on chain.
 */

export const SHOWCASE_GUILDS: GuildRecord[] = [
  {
    name: 'obsidiantrust',
    guild: '0x00126b1D310025Cd94F844994669c0B6a8930743',
    token: '0x000C326ed9125ca1AE86e1Bb67f0797e61FD1733',
    module: '0x0069C5A4c3729FCcC312B864F29e1f84AA9f913c',
    mode: 'token',
  },
  {
    name: 'obsidianvault',
    guild: '0x0064AD45B58474d24F3e96d1d513E1c24fBFC912',
    token: null,
    module: '0x006AF6198c9eC311bC4Ade40A8316092dd5637e7',
    mode: 'council',
  },
];

/** The charters exactly as the halls carry them on chain (plain-text metadata). */
const LORE: Record<string, string> = {
  obsidiantrust:
    'OBSIDIAN TRUST — corporate steward of the darkcircle skyline. Every tower a share, every share a vote.',
  obsidianvault:
    'OBSIDIAN VAULT — 4-of-7 council treasury of the Obsidian Trust. Community-donated assets under corporate custody.',
};

/** Treasury snapshot (wei), 2026-10-22: the trust pays its gas from the founder, the vault holds donated QUAI. */
const TREASURY: Record<string, bigint> = {
  obsidiantrust: 0n,
  obsidianvault: 419_669_600_910_311_284_733n,
};

export function showcaseSummary(record: GuildRecord): GuildSummary {
  return {
    ...record,
    metadata: LORE[record.name] ?? 'A hall of the DarkOrder.',
    treasury: TREASURY[record.name] ?? 0n,
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
    metadata: id === 0 ? 'Fund the skyline beacon relay for three more cycles' : 'Admit the night-shift delegates to the outer hall',
  };
}
