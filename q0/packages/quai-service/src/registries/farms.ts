// Canonical Farm & Staking Registry for Circleswap Dual-Reward Protocol

import { TOKEN_REGISTRY } from './tokens';
import { DEPLOYED } from './deployed';

export interface FarmPool {
    pid: number;
    name: string;
    stakeToken: {
        symbol: string;
        address: string;
        isLP: boolean;
    };
    /**
     * What the pool pays. The contract has two global reward rates (token A and token B) and every pool, LP or single
     * token, earns BOTH in proportion to its weight; a pool cannot be set to pay only one of them.
     */
    rewardTokens: {
        tokenA: { symbol: string; name: string; address: string };
        tokenB?: { symbol: string; name: string; address: string };
    };
    allocPoint: number;
    depositFeePct: number;
    isSingleStake?: boolean;
}

/**
 * Address of the deployed CircleswapMasterChef on Cyprus-1, or null until it is deployed (generated into
 * deployed.ts by the deploy script, read off the deployment receipt).
 * While null the app treats every farm as read-only: no stake/harvest transactions are offered and
 * no staked or earned amounts are shown, because there is nothing on-chain to read them from.
 * APR and TVL are not stored here either: they are derived from live reserves once emissions exist.
 */
export const MASTERCHEF_ADDRESS: string | null = DEPLOYED.MASTERCHEF;

const REWARD_A = { symbol: 'BDELTA', name: 'BoltDelta', address: TOKEN_REGISTRY.BDELTA.address };
const REWARD_B = { symbol: 'Q0', name: 'QBOLT', address: TOKEN_REGISTRY.Q0.address };

/**
 * The pools the deploy flow PLANS to add to a new farm (stake tokens, intended weights). It is a template, not a
 * description of any deployed farm: the deployed farm's own pool list is the only truth, and its pool ids are the order
 * its owner added them in. Nothing in the app may use `pid` from here to address a live farm; read the farm
 * (quai-service/farm.ts `readFarmState`) instead.
 */
export const FARM_REGISTRY: FarmPool[] = [
    {
        pid: 0,
        name: 'Q0 / WQUAI LP Farm',
        stakeToken: {
            symbol: 'Q0-WQUAI LP',
            address: '0x003B4b96bF0793EB1D53B79f8c38746A298eEef8',
            isLP: true
        },
        rewardTokens: { tokenA: REWARD_A, tokenB: REWARD_B },
        allocPoint: 400,
        depositFeePct: 0
    },
    {
        pid: 1,
        name: 'Q0 / BOSS LP Farm',
        stakeToken: {
            symbol: 'Q0-BOSS LP',
            address: '0x0036c1A5e62597438cC204F8613c15211D4b7787',
            isLP: true
        },
        rewardTokens: { tokenA: REWARD_A, tokenB: REWARD_B },
        allocPoint: 250,
        depositFeePct: 0
    },
    {
        pid: 2,
        name: 'LAPTOP / WQUAI LP Farm',
        stakeToken: {
            symbol: 'LAPTOP-WQUAI LP',
            address: '0x005935A658E99391786A3Dc6dAA9E8DC7eDDc6c9',
            isLP: true
        },
        rewardTokens: { tokenA: REWARD_A, tokenB: REWARD_B },
        allocPoint: 200,
        depositFeePct: 0
    },
    {
        pid: 3,
        name: 'LAPTOP / QGIRL LP Farm',
        stakeToken: {
            symbol: 'LAPTOP-QGIRL LP',
            address: '0x0024cA5876d565097C2f6c48739B0D530BEcbec3',
            isLP: true
        },
        rewardTokens: { tokenA: REWARD_A, tokenB: REWARD_B },
        allocPoint: 150,
        depositFeePct: 0
    },
    {
        pid: 4,
        name: 'BoltDelta Sovereign Staking Pool',
        stakeToken: {
            symbol: 'BDELTA',
            address: TOKEN_REGISTRY.BDELTA.address,
            isLP: false
        },
        // Staking BDELTA earns the farm's two rewards like any pool: BDELTA and Q0.
        rewardTokens: { tokenA: REWARD_A, tokenB: REWARD_B },
        allocPoint: 100,
        depositFeePct: 0,
        isSingleStake: true
    },
    {
        pid: 5,
        name: 'Q0 Singularity Staking Pool',
        stakeToken: {
            symbol: 'Q0',
            address: TOKEN_REGISTRY.Q0.address,
            isLP: false
        },
        // Staking Q0 earns the farm's two rewards like any pool: BDELTA and Q0.
        rewardTokens: { tokenA: REWARD_A, tokenB: REWARD_B },
        allocPoint: 100,
        depositFeePct: 0,
        isSingleStake: true
    }
];

export function getFarmPool(pid: number): FarmPool | undefined {
    return FARM_REGISTRY.find(p => p.pid === pid);
}

/** A single-token pool the project means to run: stake the token itself (Q0 or BDELTA), earn the farm's rewards. */
export interface SingleStakePlan {
    /** Lower-case address of the token that is deposited. */
    stakeToken: string;
    symbol: string;
    name: string;
    /** The weight the deploy flow plans for it. */
    allocPoint: bigint;
}

/**
 * The single-token pools in the plan (Q0 and BDELTA). The Farms page shows them as rows whether or not the deployed
 * farm has added them yet; whether one is live is read from the farm, never from this list.
 */
export const SINGLE_STAKE_POOLS: SingleStakePlan[] = FARM_REGISTRY.filter(p => p.isSingleStake).map(p => ({
    stakeToken: p.stakeToken.address.toLowerCase(),
    symbol: p.stakeToken.symbol,
    name: p.name,
    allocPoint: BigInt(p.allocPoint)
}));
