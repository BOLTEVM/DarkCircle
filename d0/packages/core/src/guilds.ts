import { Interface, randomBytes, hexlify } from 'ethers';
import { ZERO_ADDRESS, requireAddress, sameAddress } from './address.js';
import type { NetworkConfig } from './config.js';
import type { RpcClient } from './rpc.js';

/**
 * DarkOrder contract surface: human-readable ABIs for the six contracts, typed readers over
 * raw quai_call, and calldata encoders for everything the wallet will sign. Nothing here
 * sends a transaction; that is tx.ts's job, after simulation.
 */

export const REGISTRY = new Interface([
  'function count() view returns (uint256)',
  'function resolve(string name) view returns (address)',
  'function recordOf(address guild) view returns (tuple(string name, address guild, address token, address module, uint8 mode))',
  'function page(uint256 offset, uint256 limit) view returns (tuple(string name, address guild, address token, address module, uint8 mode)[])',
]);

export const FACTORY = new Interface([
  'function foundGuild(tuple(string name, string metadata, uint8 mode, string tokenName, string tokenSymbol, uint256 initialSupply, uint256 supportThreshold, uint256 minParticipation, uint64 minDuration, address[] members, uint256 minApprovals) p) returns (address guild, address token, address module)',
]);

export const GUILD = new Interface([
  'function metadata() view returns (string)',
  'function hasPermission(bytes32 role, address who) view returns (bool)',
  'function execute(tuple(address to, uint256 value, bytes data)[] actions) payable returns (bytes[])',
  'function payTribute(bytes32 invoiceId) payable',
  'function ROOT_ROLE() view returns (bytes32)',
  'function EXECUTE_ROLE() view returns (bytes32)',
  'event TributeReceived(address indexed from, uint256 amount, bytes32 indexed invoiceId)',
]);

export const VOTING = new Interface([
  'function proposalCount() view returns (uint256)',
  'function supportThreshold() view returns (uint256)',
  'function minParticipation() view returns (uint256)',
  'function minDuration() view returns (uint64)',
  'function token() view returns (address)',
  'function getProposal(uint256 id) view returns (tuple(uint64 startDate, uint64 endDate, uint256 snapshotBlock, uint256 supportThreshold, uint256 minParticipation, uint256 yes, uint256 no, uint256 abstain, bool executed, string metadata))',
  'function getActions(uint256 id) view returns (tuple(address to, uint256 value, bytes data)[])',
  'function voteOf(uint256 id, address voter) view returns (uint8)',
  'function canExecute(uint256 id) view returns (bool)',
  'function createProposal(string metadata, tuple(address to, uint256 value, bytes data)[] actions, uint64 startDate, uint64 endDate) returns (uint256)',
  'function vote(uint256 id, uint8 option, bool tryEarlyExecution)',
  'function execute(uint256 id)',
]);

export const COUNCIL = new Interface([
  'function proposalCount() view returns (uint256)',
  'function members() view returns (address[])',
  'function memberCount() view returns (uint256)',
  'function minApprovals() view returns (uint256)',
  'function isMember(address) view returns (bool)',
  'function getProposal(uint256 id) view returns (tuple(string metadata, uint64 createdAt, bool executed, uint256 approvals))',
  'function getActions(uint256 id) view returns (tuple(address to, uint256 value, bytes data)[])',
  'function hasApproved(uint256 id, address member) view returns (bool)',
  'function canExecute(uint256 id) view returns (bool)',
  'function createProposal(string metadata, tuple(address to, uint256 value, bytes data)[] actions) returns (uint256)',
  'function approve(uint256 id, bool tryExecution)',
  'function execute(uint256 id)',
]);

export const TOKEN = new Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function getVotes(address) view returns (uint256)',
  'function getPastVotes(address, uint256) view returns (uint256)',
  'function getPastTotalSupply(uint256) view returns (uint256)',
  'function delegates(address) view returns (address)',
  'function delegate(address delegatee)',
]);

export type GuildMode = 'token' | 'council';

export interface GuildRecord {
  name: string;
  guild: string;
  /** null for council guilds. */
  token: string | null;
  module: string;
  mode: GuildMode;
}

export interface GuildAction {
  to: string;
  value: bigint;
  data: string;
}

export interface GuildSummary extends GuildRecord {
  metadata: string;
  treasury: bigint;
}

/** Vote options as the contract enum numbers them: None=0, Abstain=1, Yes=2, No=3. */
export const VOTE = { abstain: 1, yes: 2, no: 3 } as const;
export type VoteChoice = keyof typeof VOTE;

export interface VotingProposalView {
  id: number;
  startDate: number;
  endDate: number;
  snapshotBlock: bigint;
  supportThreshold: bigint;
  minParticipation: bigint;
  yes: bigint;
  no: bigint;
  abstain: bigint;
  executed: boolean;
  metadata: string;
}

export interface CouncilProposalView {
  id: number;
  metadata: string;
  createdAt: number;
  executed: boolean;
  approvals: bigint;
}

export type ProposalStatus = 'pending' | 'active' | 'passed' | 'defeated' | 'executed';

function decodeRecord(r: any): GuildRecord {
  const token = String(r.token);
  return {
    name: String(r.name),
    guild: String(r.guild),
    token: sameAddress(token, ZERO_ADDRESS) ? null : token,
    module: String(r.module),
    mode: Number(r.mode) === 0 ? 'token' : 'council',
  };
}

async function call<T = any>(rpc: RpcClient, to: string, iface: Interface, fn: string, args: unknown[] = []): Promise<T> {
  const raw = await rpc.call({ to, data: iface.encodeFunctionData(fn, args) });
  return iface.decodeFunctionResult(fn, raw) as T;
}

const PAGE = 50;

/** The whole directory, paged. The registry is append-only, so the order is stable. */
export async function listGuilds(rpc: RpcClient, registry: string): Promise<GuildRecord[]> {
  const out: GuildRecord[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await call<any[]>(rpc, registry, REGISTRY, 'page', [offset, PAGE]);
    for (const r of rows) out.push(decodeRecord(r));
    if (rows.length < PAGE) return out;
  }
}

export async function resolveGuild(rpc: RpcClient, registry: string, name: string): Promise<string | null> {
  const addr = String(await call(rpc, registry, REGISTRY, 'resolve', [name]));
  return sameAddress(addr, ZERO_ADDRESS) ? null : addr;
}

export async function readRecord(rpc: RpcClient, registry: string, guild: string): Promise<GuildRecord | null> {
  const r = await call<any>(rpc, registry, REGISTRY, 'recordOf', [guild]);
  if (!r || sameAddress(String(r.guild), ZERO_ADDRESS)) return null;
  return decodeRecord(r);
}

export async function readGuildSummary(rpc: RpcClient, record: GuildRecord): Promise<GuildSummary> {
  const [metadata, treasury] = await Promise.all([
    call<string>(rpc, record.guild, GUILD, 'metadata').catch(() => ''),
    rpc.getBalance(record.guild).catch(() => 0n),
  ]);
  return { ...record, metadata: String(metadata), treasury };
}

export async function readVotingProposal(rpc: RpcClient, module: string, id: number): Promise<VotingProposalView> {
  const p = await call<any>(rpc, module, VOTING, 'getProposal', [id]);
  return {
    id,
    startDate: Number(p.startDate),
    endDate: Number(p.endDate),
    snapshotBlock: BigInt(p.snapshotBlock),
    supportThreshold: BigInt(p.supportThreshold),
    minParticipation: BigInt(p.minParticipation),
    yes: BigInt(p.yes),
    no: BigInt(p.no),
    abstain: BigInt(p.abstain),
    executed: Boolean(p.executed),
    metadata: String(p.metadata),
  };
}

export async function readVotingActions(rpc: RpcClient, module: string, id: number): Promise<GuildAction[]> {
  const rows = await call<any[]>(rpc, module, VOTING, 'getActions', [id]);
  return rows.map((a) => ({ to: String(a.to), value: BigInt(a.value), data: String(a.data) }));
}

export async function readCouncilProposal(rpc: RpcClient, module: string, id: number): Promise<CouncilProposalView> {
  const p = await call<any>(rpc, module, COUNCIL, 'getProposal', [id]);
  return { id, metadata: String(p.metadata), createdAt: Number(p.createdAt), executed: Boolean(p.executed), approvals: BigInt(p.approvals) };
}

export async function readCouncilActions(rpc: RpcClient, module: string, id: number): Promise<GuildAction[]> {
  const rows = await call<any[]>(rpc, module, COUNCIL, 'getActions', [id]);
  return rows.map((a) => ({ to: String(a.to), value: BigInt(a.value), data: String(a.data) }));
}

export async function readCouncilMembers(rpc: RpcClient, module: string): Promise<string[]> {
  const rows = await call<any[]>(rpc, module, COUNCIL, 'members');
  return rows.map(String);
}

export function votingProposalStatus(p: VotingProposalView, canExec: boolean, now = Math.floor(Date.now() / 1000)): ProposalStatus {
  if (p.executed) return 'executed';
  if (now < p.startDate) return 'pending';
  if (canExec) return 'passed';
  if (now >= p.endDate) return 'defeated';
  return 'active';
}

export function councilProposalStatus(p: CouncilProposalView, canExec: boolean): ProposalStatus {
  if (p.executed) return 'executed';
  return canExec ? 'passed' : 'active';
}

// ---- calldata encoders (nothing below this line talks to the chain)

export interface FoundParamsInput {
  name: string;
  metadata: string;
  mode: GuildMode;
  tokenName: string;
  tokenSymbol: string;
  initialSupply: bigint;
  supportThreshold: bigint;
  minParticipation: bigint;
  minDuration: bigint;
  members: string[];
  minApprovals: bigint;
}

export function encodeFoundGuild(p: FoundParamsInput): string {
  return FACTORY.encodeFunctionData('foundGuild', [
    {
      name: p.name,
      metadata: p.metadata,
      mode: p.mode === 'token' ? 0 : 1,
      tokenName: p.tokenName,
      tokenSymbol: p.tokenSymbol,
      initialSupply: p.initialSupply,
      supportThreshold: p.supportThreshold,
      minParticipation: p.minParticipation,
      minDuration: p.minDuration,
      members: p.members,
      minApprovals: p.minApprovals,
    },
  ]);
}

export function encodeCreateVotingProposal(metadata: string, actions: GuildAction[], startDate = 0, endDate = 0): string {
  return VOTING.encodeFunctionData('createProposal', [metadata, actions.map((a) => ({ to: a.to, value: a.value, data: a.data })), startDate, endDate]);
}

export function encodeVote(id: number, choice: VoteChoice, tryEarlyExecution = true): string {
  return VOTING.encodeFunctionData('vote', [id, VOTE[choice], tryEarlyExecution]);
}

export function encodeVotingExecute(id: number): string {
  return VOTING.encodeFunctionData('execute', [id]);
}

export function encodeCreateCouncilProposal(metadata: string, actions: GuildAction[]): string {
  return COUNCIL.encodeFunctionData('createProposal', [metadata, actions.map((a) => ({ to: a.to, value: a.value, data: a.data }))]);
}

export function encodeCouncilApprove(id: number, tryExecution = true): string {
  return COUNCIL.encodeFunctionData('approve', [id, tryExecution]);
}

export function encodeCouncilExecute(id: number): string {
  return COUNCIL.encodeFunctionData('execute', [id]);
}

export function encodeDelegate(delegatee: string): string {
  return TOKEN.encodeFunctionData('delegate', [delegatee]);
}

export function encodeTribute(invoiceId: string): string {
  return GUILD.encodeFunctionData('payTribute', [invoiceId]);
}

/** A fresh x402 invoice id: 32 random bytes, hex. */
export function newInvoiceId(): string {
  return hexlify(randomBytes(32));
}

export function checkedModule(record: GuildRecord, rule: NetworkConfig['addressRule']): string {
  return requireAddress(record.module, rule, 'Governance module');
}
