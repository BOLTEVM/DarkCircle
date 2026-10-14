// The arithmetic behind the "1,000 BDELTA on Quainance" gate, kept free of imports so it loads in plain Node for tests.
// The reads that feed it live in quainanceStake.ts.

/** BDELTA a wallet must have on Quainance to use the single-token pools and to take part in the airdrop. */
export const BDELTA_STAKE_THRESHOLD = 1_000n * 10n ** 18n;

export interface QuainanceStake {
    /** BDELTA the wallet's liquidity tokens represent (wallet + gauge + this app's farm), in base units. */
    bdelta: bigint;
    /** Liquidity tokens of Quainance's BDELTA/WQUAI pool in the wallet. */
    lpHeld: bigint;
    /** The same tokens staked in Quainance's gauge. */
    lpStaked: bigint;
    /**
     * The same tokens deposited in this app's own farm (a farm pool whose staked token is Quainance's BDELTA/WQUAI pool).
     * They left the wallet when they were deposited, so without this a wallet that put its liquidity to work here would
     * look like it had none. 0 until the farm has been read.
     */
    lpFarm: bigint;
    /** BDELTA in the pool's reserves, and the pool's liquidity-token supply: what turns liquidity tokens into BDELTA. */
    bdeltaReserve: bigint;
    lpTotalSupply: bigint;
    meetsThreshold: boolean;
}

/** BDELTA a number of the pool's liquidity tokens represent. Floors. */
export const bdeltaOfLiquidity = (lp: bigint, bdeltaReserve: bigint, totalSupply: bigint): bigint =>
    totalSupply === 0n ? 0n : (lp * bdeltaReserve) / totalSupply;

/** The same stake with `lpFarm` liquidity tokens (deposited in this app's farm) counted too. */
export function withFarmLiquidity(stake: QuainanceStake, lpFarm: bigint): QuainanceStake {
    const bdelta = bdeltaOfLiquidity(stake.lpHeld + stake.lpStaked + lpFarm, stake.bdeltaReserve, stake.lpTotalSupply);
    return { ...stake, lpFarm, bdelta, meetsThreshold: bdelta >= BDELTA_STAKE_THRESHOLD };
}
