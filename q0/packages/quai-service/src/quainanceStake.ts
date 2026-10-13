// How much BDELTA a wallet has staked on Quainance.
//
// Quainance has no single-token BDELTA staking: BDELTA reaches it as liquidity in the BDELTA/WQUAI pool, and that liquidity is
// staked in Quainance's gaugeV2 contract. So a wallet's BDELTA on Quainance is the BDELTA its liquidity tokens represent, the
// ones in the wallet plus the ones staked in the gauge (the same definition the airdrop snapshot uses). This is a read: it
// gates what the app shows, it does not and cannot gate what the farm contract accepts.

import { TOKEN_REGISTRY } from './registries/tokens';
import { keccak256Bytes } from './keccak';
import type { BatchCall, BatchFn } from './pairs';

/** Quainance's BDELTA/WQUAI pool (its QNCE-V2 liquidity token). */
export const QUAINANCE_BDELTA_PAIR = '0x006524c3e3d2197dd61a64fef54f099260387209';
/** Quainance's staking gauge (gaugeV2), which holds the pool's staked liquidity tokens. */
export const QUAINANCE_GAUGE_V2 = '0x004a1fe8b99aebf9077f68884de6edaa036c6df6';
/** BDELTA a wallet must have on Quainance to use the single-token pools and to take part in the airdrop. */
export const BDELTA_STAKE_THRESHOLD = 1_000n * 10n ** 18n;

const selector = (signature: string): string => keccak256Bytes(new TextEncoder().encode(signature)).slice(0, 10);
const SEL_GET_POOL_ID = selector('getPoolId(address)');
const SEL_GAUGE_BALANCE = selector('balanceOf(uint256,address)');
const word = (n: bigint | string): string => (typeof n === 'bigint' ? n.toString(16) : n.replace(/^0x/, '').toLowerCase()).padStart(64, '0');
const isWord = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
const call = (to: string, data: string): BatchCall => ({ method: 'quai_call', params: [{ to, data }, 'latest'] });

export interface QuainanceStake {
    /** BDELTA the wallet's liquidity tokens represent (wallet plus gauge), in base units. */
    bdelta: bigint;
    lpHeld: bigint;
    lpStaked: bigint;
    meetsThreshold: boolean;
}

/** BDELTA a number of the pool's liquidity tokens represent. Floors. */
export const bdeltaOfLiquidity = (lp: bigint, bdeltaReserve: bigint, totalSupply: bigint): bigint => (totalSupply === 0n ? 0n : (lp * bdeltaReserve) / totalSupply);

/** Read a wallet's BDELTA on Quainance. Throws when the node cannot answer: "no stake" is never a guess. */
export async function readQuainanceBdeltaStake(batch: BatchFn, wallet: string): Promise<QuainanceStake> {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Not a wallet address.');
    const pair = QUAINANCE_BDELTA_PAIR;
    const [t0, reserves, supply, held, poolId] = await batch([
        call(pair, '0x0dfe1681'),
        call(pair, '0x0902f1ac'),
        call(pair, '0x18160ddd'),
        call(pair, '0x70a08231' + word(wallet)),
        call(QUAINANCE_GAUGE_V2, SEL_GET_POOL_ID + word(pair))
    ]);
    if (!t0.ok || !isWord(t0.value)) throw new Error('Could not read the BDELTA pool on Quainance.');
    if (!reserves.ok || typeof reserves.value !== 'string' || reserves.value.length < 130) throw new Error('Could not read the BDELTA pool\'s reserves.');
    if (!supply.ok || !isWord(supply.value) || !held.ok || !isWord(held.value)) throw new Error('Could not read your liquidity balance on Quainance.');
    const bdeltaIsToken0 = ('0x' + t0.value.slice(-40)).toLowerCase() === TOKEN_REGISTRY.BDELTA.address.toLowerCase();
    const reserve = BigInt('0x' + (bdeltaIsToken0 ? reserves.value.slice(2, 66) : reserves.value.slice(66, 130)));
    const totalSupply = BigInt(supply.value);
    const lpHeld = BigInt(held.value);

    let lpStaked = 0n;
    if (poolId.ok && typeof poolId.value === 'string' && poolId.value.length >= 130 && BigInt('0x' + poolId.value.slice(66, 130)) !== 0n) {
        const pid = BigInt('0x' + poolId.value.slice(2, 66));
        const staked = (await batch([call(QUAINANCE_GAUGE_V2, SEL_GAUGE_BALANCE + word(pid) + word(wallet))]))[0];
        if (!staked.ok || !isWord(staked.value)) throw new Error('Could not read your stake in Quainance\'s gauge.');
        lpStaked = BigInt(staked.value);
    } else if (!poolId.ok) {
        throw new Error('Could not reach Quainance\'s gauge.');
    }

    const bdelta = bdeltaOfLiquidity(lpHeld + lpStaked, reserve, totalSupply);
    return { bdelta, lpHeld, lpStaked, meetsThreshold: bdelta >= BDELTA_STAKE_THRESHOLD };
}
