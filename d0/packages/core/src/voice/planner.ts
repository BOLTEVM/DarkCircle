/**
 * DarkOrder voice agent: from an intent to transactions the user's wallet signs.
 * Modeled on DarkCircle's planner (src/agent/planner.ts), retuned for governance.
 *
 * Reads the live chain (registry, proposal state, voting power, gas price) and builds the exact transaction an
 * intent needs, simulated first through tx.ts's prepareTransaction (quai_call, quai_estimateGas, then
 * quai_createAccessList), so nothing that would revert is ever offered for signing: on Quai a reverted
 * transaction burns its whole gas limit. It never signs or sends.
 *
 * Every check here runs again where it matters: the user confirms the plan by its spoken code, the wallet shows
 * its own approval screen, and the web app verifies the outcome from the receipt.
 */

import type { NetworkConfig } from '../config.js';
import type { RpcClient } from '../rpc.js';
import { prepareTransaction, revertReason, type PreparedTx } from '../tx.js';
import {
  encodeCouncilApprove,
  encodeCouncilExecute,
  encodeTribute,
  encodeVote,
  encodeVotingExecute,
  listGuilds,
  readCouncilProposal,
  readVotingProposal,
  resolveGuild,
  type GuildRecord,
} from '../guilds.js';
import { formatTokenAmount, parseTokenAmount } from '../tokens.js';
import type { Intent } from './grammar.js';

/** A plan is offered for this long; after that the chain state is re-read by planning again. */
export const PLAN_TTL_MS = 180_000;

export interface Plan {
  id: string;
  code: string;
  createdAt: number;
  expiresAt: number;
  kind: 'vote' | 'approve' | 'execute' | 'tribute';
  said: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  from: string;
  tx: PreparedTx;
  guild: string;
  warnings: string[];
}

export class Refusal extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** A 3-digit code for spoken confirmation, digits 1-9 only (no "oh"/"zero" ambiguity). */
function confirmationCode(rand: () => number): string {
  return Array.from({ length: 3 }, () => String(1 + Math.floor(rand() * 9))).join('');
}

function planId(rand: () => number): string {
  return Array.from({ length: 12 }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
}

/** Deterministic word overlap so "iron council" finds the "ironcouncil" hall. */
export function matchGuild(spoken: string, guilds: GuildRecord[]): { guild?: GuildRecord; nearby: string[] } {
  const squashed = spoken.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!squashed) return { nearby: [] };
  const exact = guilds.find((g) => g.name.toLowerCase().replace(/[^a-z0-9]/g, '') === squashed);
  if (exact) return { guild: exact, nearby: [] };
  const nearby = guilds
    .filter((g) => {
      const gn = g.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return gn.includes(squashed) || squashed.includes(gn) || gn.startsWith(squashed.slice(0, 4));
    })
    .map((g) => g.name)
    .slice(0, 3);
  return { nearby };
}

export class GuildPlanner {
  private readonly rpc: RpcClient;
  private readonly network: NetworkConfig;
  private readonly registry: string;
  private readonly now: () => number;
  private readonly rand: () => number;

  constructor(o: { rpc: RpcClient; network: NetworkConfig; registry: string; now?: () => number; rand?: () => number }) {
    this.rpc = o.rpc;
    this.network = o.network;
    this.registry = o.registry;
    this.now = o.now ?? Date.now;
    this.rand = o.rand ?? Math.random;
  }

  private async guildBySpokenName(spoken: string): Promise<GuildRecord> {
    const guilds = await listGuilds(this.rpc, this.registry).catch(() => [] as GuildRecord[]);
    const { guild, nearby } = matchGuild(spoken, guilds);
    if (guild) return guild;
    // Fall back to a direct registry resolve with the squashed handle.
    const handle = spoken.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (handle) {
      const addr = await resolveGuild(this.rpc, this.registry, handle).catch(() => null);
      if (addr) {
        const found = guilds.find((g) => g.guild.toLowerCase() === addr.toLowerCase());
        if (found) return found;
        return { name: handle, guild: addr, token: null, module: addr, mode: 'council' };
      }
    }
    throw new Refusal(
      'GUILD_UNKNOWN',
      nearby.length
        ? `No hall called "${spoken}". Did you mean ${nearby.map((n) => `"${n}"`).join(' or ')}?`
        : `No hall called "${spoken}". Say "show the halls" to hear what exists.`
    );
  }

  private proposalId(spoken: string): number {
    if (!/^\d+$/.test(spoken.trim())) throw new Refusal('PROPOSAL_ID', `Proposal ids are numbers; "${spoken}" is not one.`);
    return Number(spoken.trim());
  }

  private async prepare(from: string, to: string, data: string, value: bigint): Promise<PreparedTx> {
    try {
      return await prepareTransaction(this.rpc, this.network, { from, to, data, value });
    } catch (err) {
      throw new Refusal('SIMULATION_FAILED', err instanceof Error ? err.message : String(err));
    }
  }

  private plan(o: Omit<Plan, 'id' | 'code' | 'createdAt' | 'expiresAt'>): Plan {
    const createdAt = this.now();
    return { ...o, id: planId(this.rand), code: confirmationCode(this.rand), createdAt, expiresAt: createdAt + PLAN_TTL_MS };
  }

  private requireCurrentGuild(currentGuild: GuildRecord | null | undefined): GuildRecord {
    if (!currentGuild) {
      throw new Refusal('NEED_GUILD', 'Open a hall first ("open emberhold"), so I know which guild you mean.');
    }
    return currentGuild;
  }

  /** Builds the plan for a planned intent. Query intents (halls/proposals/power) never reach here. */
  public async build(intent: Intent, said: string, from: string, currentGuild?: GuildRecord | null): Promise<Plan> {
    switch (intent.kind) {
      case 'vote': {
        const guild = this.requireCurrentGuild(currentGuild);
        if (guild.mode !== 'token') throw new Refusal('NOT_A_TOKEN_GUILD', `"${guild.name}" is a council guild; say "approve proposal ${intent.proposal}".`);
        const id = this.proposalId(intent.proposal);
        const p = await readVotingProposal(this.rpc, guild.module, id).catch(() => null);
        if (!p) throw new Refusal('PROPOSAL_UNKNOWN', `"${guild.name}" has no proposal ${id}.`);
        const nowS = Math.floor(this.now() / 1000);
        if (p.executed) throw new Refusal('ALREADY_EXECUTED', `Proposal ${id} is already executed.`);
        if (nowS < p.startDate) throw new Refusal('NOT_STARTED', `Proposal ${id} has not opened yet.`);
        if (nowS >= p.endDate) throw new Refusal('ENDED', `Voting on proposal ${id} has ended.`);
        const data = encodeVote(id, intent.choice, true);
        const tx = await this.prepare(from, guild.module, data, 0n);
        return this.plan({
          kind: 'vote',
          said,
          summary: `Vote ${intent.choice.toUpperCase()} on proposal ${id} in "${guild.name}".`,
          details: [
            { label: 'Hall', value: guild.name },
            { label: 'Proposal', value: `#${id} · ${p.metadata || '(no title)'}` },
            { label: 'Your vote', value: intent.choice.toUpperCase() },
          ],
          from,
          tx,
          guild: guild.name,
          warnings: [],
        });
      }
      case 'approve': {
        const guild = this.requireCurrentGuild(currentGuild);
        if (guild.mode !== 'council') throw new Refusal('NOT_A_COUNCIL_GUILD', `"${guild.name}" votes by token; say "vote yes on proposal ${intent.proposal}".`);
        const id = this.proposalId(intent.proposal);
        const p = await readCouncilProposal(this.rpc, guild.module, id).catch(() => null);
        if (!p) throw new Refusal('PROPOSAL_UNKNOWN', `"${guild.name}" has no proposal ${id}.`);
        if (p.executed) throw new Refusal('ALREADY_EXECUTED', `Proposal ${id} is already executed.`);
        const data = encodeCouncilApprove(id, true);
        const tx = await this.prepare(from, guild.module, data, 0n);
        return this.plan({
          kind: 'approve',
          said,
          summary: `Approve proposal ${id} in the "${guild.name}" council.`,
          details: [
            { label: 'Hall', value: guild.name },
            { label: 'Proposal', value: `#${id} · ${p.metadata || '(no title)'}` },
            { label: 'Approvals so far', value: p.approvals.toString() },
          ],
          from,
          tx,
          guild: guild.name,
          warnings: [],
        });
      }
      case 'execute': {
        const guild = this.requireCurrentGuild(currentGuild);
        const id = this.proposalId(intent.proposal);
        const data = guild.mode === 'token' ? encodeVotingExecute(id) : encodeCouncilExecute(id);
        const tx = await this.prepare(from, guild.module, data, 0n).catch((err) => {
          throw new Refusal('CANNOT_EXECUTE', `Proposal ${id} in "${guild.name}" cannot be executed: ${revertReason(err)}`);
        });
        return this.plan({
          kind: 'execute',
          said,
          summary: `Execute proposal ${id} in "${guild.name}".`,
          details: [
            { label: 'Hall', value: guild.name },
            { label: 'Proposal', value: `#${id}` },
            { label: 'Effect', value: 'The proposal’s actions run as the guild.' },
          ],
          from,
          tx,
          guild: guild.name,
          warnings: [],
        });
      }
      case 'tribute': {
        const guild = await this.guildBySpokenName(intent.guild);
        let value: bigint;
        try {
          value = parseTokenAmount(intent.amount, 18);
        } catch {
          throw new Refusal('AMOUNT_INVALID', `"${intent.amount}" is not an amount I can pay.`);
        }
        if (value <= 0n) throw new Refusal('AMOUNT_ZERO', 'The amount must be more than zero.');
        const held = await this.rpc.getBalance(from).catch(() => 0n);
        if (held < value) {
          throw new Refusal('INSUFFICIENT_QUAI', `You have ${formatTokenAmount(held)} QUAI; tribute of ${formatTokenAmount(value)} QUAI would not cover the network fee too.`);
        }
        const data = encodeTribute(newTributeInvoiceId());
        const tx = await this.prepare(from, guild.guild, data, value);
        return this.plan({
          kind: 'tribute',
          said,
          summary: `Pay ${formatTokenAmount(value)} QUAI tribute to the "${guild.name}" treasury.`,
          details: [
            { label: 'Hall', value: guild.name },
            { label: 'Treasury', value: guild.guild },
            { label: 'Amount', value: `${formatTokenAmount(value)} QUAI` },
            { label: 'Receipt', value: 'A TributeReceived event carries your x402 invoice id' },
          ],
          from,
          tx,
          guild: guild.name,
          warnings: [],
        });
      }
      default:
        throw new Refusal('NOT_PLANNED', `"${intent.kind}" is answered directly; there is nothing to sign.`);
    }
  }
}

/** Invoice ids for voice tribute are plan-local; the x402 module owns the canonical form. */
function newTributeInvoiceId(): string {
  const bytes = new Uint8Array(32);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
