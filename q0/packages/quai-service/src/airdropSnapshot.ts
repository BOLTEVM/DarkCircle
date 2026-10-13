// Who has BDELTA staked on Quainance, read from the chain.
//
// Quainance has no single-token BDELTA staking: BDELTA reaches it as liquidity in the BDELTA/WQUAI pool, so "BDELTA staked
// on Quainance" is the BDELTA a liquidity token represents (the holder's share of the pool times the pool's BDELTA). A
// BURNER is an account that sent liquidity tokens to the zero or dead address: that liquidity stays in the pool for good, so
// it still counts, and the account earns the burner multiplier.
//
// The balances that count come from `balanceOf` at the snapshot block (authoritative), and the burners come from the pair's
// Transfer logs, so a log history that is incomplete can only miss a burner (reported), never invent a balance.
//
// Nothing here sends anything: it reads, and returns data for planAirdrop.

import { checksumAddress } from './keccak';
import type { StakePosition } from './airdrop';
import { createBatch, type BatchCall, type BatchFn } from './pairs';

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** The node refuses a log query wider than this many blocks. */
const WINDOW = 10_000;

export interface LpTransfer {
    from: string;
    to: string;
    value: bigint;
    block: number;
    logIndex: number;
}

const word = (a: string) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const addr = (topic: string) => ('0x' + topic.slice(-40)).toLowerCase();
const isWord = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const call = (to: string, data: string, block: string = 'latest'): BatchCall => ({ method: 'quai_call', params: [{ to, data }, block] });

/** One Transfer log as a transfer, or null when it is not a well-formed ERC-20 Transfer. */
export function parseTransferLog(log: any): LpTransfer | null {
    const topics: unknown = log?.topics;
    if (!Array.isArray(topics) || topics.length !== 3 || String(topics[0]).toLowerCase() !== TRANSFER_TOPIC) return null;
    if (typeof log.data !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(log.data)) return null;
    try {
        return {
            from: addr(String(topics[1])),
            to: addr(String(topics[2])),
            value: BigInt(log.data),
            block: Number(BigInt(log.blockNumber)),
            logIndex: Number(BigInt(log.logIndex ?? '0x0'))
        };
    } catch {
        return null;
    }
}

export interface ScanResult {
    transfers: LpTransfer[];
    /** The pair's first mint was reached: the history is complete. */
    complete: boolean;
    fromBlock: number;
    windows: number;
}

/**
 * Every Transfer of a token, newest windows first, until the first mint (Transfer from the zero address) is found or
 * `maxWindows` windows have been read. The node serves log queries slowly, so windows go `perCall` at a time.
 */
export async function scanTransfers(
    batch: BatchFn,
    token: string,
    headBlock: number,
    opts: { maxWindows?: number; perCall?: number; onProgress?: (done: number, found: number) => void } = {}
): Promise<ScanResult> {
    const maxWindows = opts.maxWindows ?? 1500;
    const perCall = opts.perCall ?? 8;
    const all: LpTransfer[] = [];
    let windows = 0;
    let complete = false;
    let to = headBlock;
    let fromBlock = headBlock;
    while (windows < maxWindows && to > 0 && !complete) {
        const calls: BatchCall[] = [];
        const ranges: { from: number; to: number }[] = [];
        for (let k = 0; k < perCall && to > 0 && windows + k < maxWindows; k++) {
            const from = Math.max(0, to - WINDOW + 1);
            ranges.push({ from, to });
            calls.push({ method: 'quai_getLogs', params: [{ address: token, fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [TRANSFER_TOPIC] }] });
            to = from - 1;
        }
        const res = await batch(calls);
        res.forEach((r, i) => {
            if (!r.ok || !Array.isArray(r.value)) throw new Error(`The node could not read blocks ${ranges[i].from}-${ranges[i].to}: ${r.ok ? 'unexpected reply' : r.error}`);
            for (const log of r.value) {
                const t = parseTransferLog(log);
                if (t) all.push(t);
            }
        });
        windows += ranges.length;
        fromBlock = ranges[ranges.length - 1].from;
        // the pair mints its permanent minimum liquidity to the zero address from the zero address, once, first
        if (all.some(t => t.from === ZERO)) complete = true;
        opts.onProgress?.(windows, all.length);
        if (fromBlock === 0) complete = true;
    }
    all.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    return { transfers: all, complete, fromBlock, windows };
}

/** Liquidity tokens each account sent to the zero or dead address (not a pair burning on removal: that comes from the pair). */
export function burnedBy(transfers: readonly LpTransfer[], pair: string): Map<string, bigint> {
    const p = pair.toLowerCase();
    const out = new Map<string, bigint>();
    for (const t of transfers) {
        if ((t.to === ZERO || t.to === DEAD) && t.from !== ZERO && t.from !== DEAD && t.from !== p) {
            out.set(t.from, (out.get(t.from) ?? 0n) + t.value);
        }
    }
    return out;
}

/** What `lp` liquidity tokens represent of one side of the pool. Floors. */
export const shareOfReserve = (lp: bigint, reserve: bigint, totalSupply: bigint): bigint => (totalSupply === 0n ? 0n : (lp * reserve) / totalSupply);

export interface PoolSnapshotInput {
    pair: string;
    /** Which side of the pair the staked token is. */
    tokenIsToken0: boolean;
    reserve0: bigint;
    reserve1: bigint;
    totalSupply: bigint;
    /** balanceOf at the snapshot block for every account that ever held liquidity tokens. */
    balances: ReadonlyMap<string, bigint>;
    burned: ReadonlyMap<string, bigint>;
}

/** Pure: turn balances, burns and reserves into BDELTA-equivalent positions. */
export function positionsFromPool(i: PoolSnapshotInput): StakePosition[] {
    const reserve = i.tokenIsToken0 ? i.reserve0 : i.reserve1;
    const pair = i.pair.toLowerCase();
    const accounts = new Set<string>([...i.balances.keys(), ...i.burned.keys()]);
    const out: StakePosition[] = [];
    for (const account of accounts) {
        if (account === ZERO || account === DEAD || account === pair) continue;
        out.push({
            account,
            held: shareOfReserve(i.balances.get(account) ?? 0n, reserve, i.totalSupply),
            burned: shareOfReserve(i.burned.get(account) ?? 0n, reserve, i.totalSupply)
        });
    }
    return out;
}

export interface PoolSnapshot {
    pair: string;
    block: number;
    token0: string;
    token1: string;
    reserve0: bigint;
    reserve1: bigint;
    totalSupply: bigint;
    /** Liquidity tokens at the zero and dead addresses: burned, by someone or by the pair's own minimum. */
    burnedTotal: bigint;
    positions: StakePosition[];
    /** The log history reached the pair's first mint. False means a burner may be missing. */
    complete: boolean;
    /** Accounts that hold liquidity tokens and are contracts: whoever is behind them is NOT counted. */
    contractHolders: string[];
}

/**
 * Snapshot one pool at the current head. `stakedToken` is the token whose amount counts (BDELTA). Throws if the node
 * cannot answer a read: a half snapshot is worse than none.
 */
export async function snapshotPool(
    stakedToken: string,
    pair: string,
    opts: { batch?: BatchFn; maxWindows?: number; onProgress?: (done: number, found: number) => void } = {}
): Promise<PoolSnapshot> {
    const batch = opts.batch ?? createBatch();
    const headRes = (await batch([{ method: 'quai_blockNumber', params: [] }]))[0];
    if (!headRes.ok) throw new Error(`Could not read the chain head: ${headRes.error}`);
    const head = Number(BigInt(headRes.value));
    const tag = '0x' + head.toString(16);

    const [t0, t1, res, supply] = await batch([
        call(pair, '0x0dfe1681', tag),
        call(pair, '0xd21220a7', tag),
        call(pair, '0x0902f1ac', tag),
        call(pair, '0x18160ddd', tag)
    ]);
    if (!t0.ok || !t1.ok || !res.ok || !supply.ok || !isWord(t0.value) || !isWord(t1.value) || typeof res.value !== 'string' || res.value.length < 130 || !isWord(supply.value)) {
        throw new Error('Could not read the pool (tokens, reserves or supply).');
    }
    const token0 = addr(t0.value);
    const token1 = addr(t1.value);
    const staked = stakedToken.toLowerCase();
    if (token0 !== staked && token1 !== staked) throw new Error('That pool does not contain the staked token.');
    const reserve0 = BigInt('0x' + res.value.slice(2, 66));
    const reserve1 = BigInt('0x' + res.value.slice(66, 130));
    const totalSupply = BigInt(supply.value);

    const scan = await scanTransfers(batch, pair, head, { maxWindows: opts.maxWindows, onProgress: opts.onProgress });
    const holders = new Set<string>();
    for (const t of scan.transfers) {
        holders.add(t.from);
        holders.add(t.to);
    }
    holders.delete(ZERO);
    holders.delete(DEAD);
    const list = [...holders];
    const balCalls: BatchCall[] = list.map(h => call(pair, '0x70a08231' + word(h), tag));
    balCalls.push(call(pair, '0x70a08231' + word(ZERO), tag), call(pair, '0x70a08231' + word(DEAD), tag));
    const bal = await batch(balCalls);
    const balances = new Map<string, bigint>();
    list.forEach((h, i) => {
        const r = bal[i];
        if (!r.ok || !isWord(r.value)) throw new Error(`Could not read the liquidity balance of ${h}.`);
        const v = BigInt(r.value);
        if (v > 0n) balances.set(h, v);
    });
    const zeroBal = bal[list.length];
    const deadBal = bal[list.length + 1];
    const burnedTotal = (zeroBal.ok && isWord(zeroBal.value) ? BigInt(zeroBal.value) : 0n) + (deadBal.ok && isWord(deadBal.value) ? BigInt(deadBal.value) : 0n);

    // which holders are contracts: their depositors are not visible from here
    const holderList = [...balances.keys()];
    const codeRes = holderList.length ? await batch(holderList.map(h => ({ method: 'quai_getCode', params: [checksumAddress(h), tag] }))) : [];
    const contractHolders = holderList.filter((_, i) => {
        const r = codeRes[i];
        return r?.ok && typeof r.value === 'string' && r.value !== '0x' && r.value.length > 2;
    });

    const positions = positionsFromPool({
        pair,
        tokenIsToken0: token0 === staked,
        reserve0,
        reserve1,
        totalSupply,
        balances,
        burned: burnedBy(scan.transfers, pair)
    });
    return { pair: pair.toLowerCase(), block: head, token0, token1, reserve0, reserve1, totalSupply, burnedTotal, positions, complete: scan.complete, contractHolders };
}
