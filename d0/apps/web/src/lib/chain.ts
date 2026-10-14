import { COUNCIL, TOKEN, VOTING, type GuildRecord, type RpcClient } from '@darkorder/core';

/** Small typed readers over the exported interfaces, for views the core doesn't wrap. */

async function call(rpc: RpcClient, to: string, iface: typeof VOTING | typeof COUNCIL | typeof TOKEN, fn: string, args: unknown[] = []): Promise<any> {
  const raw = await rpc.call({ to, data: iface.encodeFunctionData(fn, args) });
  return iface.decodeFunctionResult(fn, raw);
}

export async function proposalCount(rpc: RpcClient, record: GuildRecord): Promise<number> {
  const iface = record.mode === 'token' ? VOTING : COUNCIL;
  const n = await call(rpc, record.module, iface, 'proposalCount');
  return Number(n);
}

export async function canExecuteProposal(rpc: RpcClient, record: GuildRecord, id: number): Promise<boolean> {
  const iface = record.mode === 'token' ? VOTING : COUNCIL;
  return Boolean(await call(rpc, record.module, iface, 'canExecute', [id]));
}

export interface TokenMeta {
  name: string;
  symbol: string;
  totalSupply: bigint;
}

export async function readTokenMeta(rpc: RpcClient, token: string): Promise<TokenMeta> {
  const [name, symbol, totalSupply] = await Promise.all([
    call(rpc, token, TOKEN, 'name'),
    call(rpc, token, TOKEN, 'symbol'),
    call(rpc, token, TOKEN, 'totalSupply'),
  ]);
  return { name: String(name), symbol: String(symbol), totalSupply: BigInt(totalSupply) };
}

export interface VotingPower {
  balance: bigint;
  votes: bigint;
  delegatee: string;
}

export async function readVotingPower(rpc: RpcClient, token: string, who: string): Promise<VotingPower> {
  const [balance, votes, delegatee] = await Promise.all([
    call(rpc, token, TOKEN, 'balanceOf', [who]),
    call(rpc, token, TOKEN, 'getVotes', [who]),
    call(rpc, token, TOKEN, 'delegates', [who]),
  ]);
  return { balance: BigInt(balance), votes: BigInt(votes), delegatee: String(delegatee) };
}

export async function readMinApprovals(rpc: RpcClient, module: string): Promise<bigint> {
  return BigInt(await call(rpc, module, COUNCIL, 'minApprovals'));
}
