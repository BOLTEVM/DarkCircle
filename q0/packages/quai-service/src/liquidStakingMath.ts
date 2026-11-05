// BigInt mirror of QuaiLiquidStaking's share conversions. All values are base units.

export function previewLiquidStakingDeposit(assets: bigint, managedAssets: bigint, shareSupply: bigint): bigint {
    if (assets < 0n || managedAssets < 0n || shareSupply < 0n) throw new Error('Negative vault amount.');
    if (assets === 0n || managedAssets === 0n) return 0n;
    return (assets * (shareSupply + 1n)) / (managedAssets + 1n);
}

export function previewLiquidStakingRedeem(shares: bigint, managedAssets: bigint, shareSupply: bigint): bigint {
    if (shares < 0n || managedAssets < 0n || shareSupply < 0n) throw new Error('Negative vault amount.');
    if (shares === 0n || managedAssets === 0n || shareSupply === 0n) return 0n;
    return (shares * (managedAssets + 1n)) / (shareSupply + 1n);
}

/**
 * Simple annualised yield, in percent, of the stQUAI redemption rate moving from `fromE18` to `toE18` over `seconds`.
 * Realised, not promised: it says what the rate did, and is null when the window is too short to say anything.
 */
export function annualizedRateYield(fromE18: bigint, toE18: bigint, seconds: number): number | null {
    if (fromE18 <= 0n || toE18 < 0n || !Number.isFinite(seconds) || seconds < 3600) return null;
    // Parts per billion keeps the ratio exact well past 1e18-scale rates before converting to a float.
    const growthPpb = Number(((toE18 - fromE18) * 1_000_000_000n) / fromE18) / 1e9;
    return growthPpb * (365 * 86_400 / seconds) * 100;
}

/** QUAI that `shares` stQUAI redeem for at `rateE18` (the vault's previewRedeem of 1e18), rounded down. */
export function quaiForStQuai(shares: bigint, rateE18: bigint): bigint {
    if (shares < 0n || rateE18 <= 0n) throw new Error('Invalid stQUAI amount or rate.');
    return (shares * rateE18) / 10n ** 18n;
}

/** stQUAI worth `assets` QUAI at `rateE18`, rounded down: the inverse of quaiForStQuai. */
export function stQuaiForQuai(assets: bigint, rateE18: bigint): bigint {
    if (assets < 0n || rateE18 <= 0n) throw new Error('Invalid QUAI amount or rate.');
    return (assets * 10n ** 18n) / rateE18;
}

/** stQUAI/QUAI rate scaled by 1e18; null before a rate can be established. */
export function liquidStakingRateE18(managedAssets: bigint, shareSupply: bigint): bigint | null {
    if (managedAssets < 0n || shareSupply < 0n) throw new Error('Negative vault amount.');
    if (managedAssets === 0n || shareSupply === 0n) return null;
    return previewLiquidStakingRedeem(10n ** 18n, managedAssets, shareSupply);
}
