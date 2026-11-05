// Reads and calldata for the non-upgradeable QUAI liquid-staking vault.

import { keccak256Bytes } from './keccak';
import type { BatchCall, BatchFn, BatchResult } from './pairs';

const selector = (signature: string): string => keccak256Bytes(new TextEncoder().encode(signature)).slice(0, 10);
const word = (value: bigint | string): string => (typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '')).padStart(64, '0');
const addressWord = (address: string): string => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Not a 20-byte address.');
    return word(address.toLowerCase());
};
const call = (to: string, data: string): BatchCall => ({ method: 'quai_call', params: [{ to, data }, 'latest'] });
const isWord = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);

/**
 * Block each known vault was created in (packages/contracts/deployments/mainnet.dante-staking.json). The deployment
 * seed is minted 1:1, so the redemption rate starts at exactly 1 QUAI there: the baseline for realised yield.
 */
export const LIQUID_STAKING_DEPLOY_BLOCK: Record<string, number> = {
    '0x004ef4600f538eaef5ba834e05c497a8f30c1941': 10973905
};

const SEL = {
    stQUAI: selector('stQUAI()'),
    strategy: selector('strategy()'),
    wquai: selector('WQUAI()'),
    withdrawalDelay: selector('withdrawalDelay()'),
    totalManagedAssets: selector('totalManagedAssets()'),
    claimLiabilities: selector('claimLiabilities()'),
    processedLiabilities: selector('processedLiabilities()'),
    requestCount: selector('withdrawalRequestCount()'),
    request: selector('withdrawalRequests(uint256)'),
    totalSupply: selector('totalSupply()'),
    balanceOf: selector('balanceOf(address)'),
    allowance: selector('allowance(address,address)'),
    paused: selector('paused()'),
    strategyAssets: selector('totalAssets()'),
    facilitator: selector('facilitator()'),
    previewRedeem: selector('previewRedeem(uint256)')
};

function uint(result: BatchResult | undefined, label: string): bigint {
    if (!result?.ok || !isWord(result.value)) throw new Error(`Could not read ${label}.`);
    return BigInt(result.value);
}

function quantity(result: BatchResult | undefined, label: string): bigint {
    if (!result?.ok || typeof result.value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(result.value)) {
        throw new Error(`Could not read ${label}.`);
    }
    return BigInt(result.value);
}

function flag(result: BatchResult | undefined, label: string): boolean {
    return uint(result, label) !== 0n;
}

/** Reads a contract's address field, or null when the strategy does not expose it. */
function optionalAddress(result: BatchResult | undefined): string | null {
    return result?.ok && isWord(result.value) ? '0x' + BigInt(result.value).toString(16).padStart(40, '0') : null;
}

function address(result: BatchResult | undefined, label: string): string {
    const value = uint(result, label);
    const out = '0x' + value.toString(16).padStart(40, '0');
    if (!/^0x[0-9a-fA-F]{40}$/.test(out)) throw new Error(`Malformed ${label}.`);
    return out;
}

export function encodeDepositNative(minShares: bigint, deadline: bigint): string {
    return selector('depositNative(uint256,uint256)') + word(minShares) + word(deadline);
}

export function encodeDepositWquai(assets: bigint, minShares: bigint, deadline: bigint): string {
    return selector('depositWquai(uint256,uint256,uint256)') + word(assets) + word(minShares) + word(deadline);
}

export function encodeRequestWithdrawal(shares: bigint, minAssets: bigint, receiver: string): string {
    return selector('requestWithdrawal(uint256,uint256,address)') + word(shares) + word(minAssets) + addressWord(receiver);
}

export function encodeProcessWithdrawals(maxRequests: bigint): string {
    return selector('processWithdrawals(uint256)') + word(maxRequests);
}

export function encodeClaimWithdrawal(requestId: bigint): string {
    return selector('claimWithdrawal(uint256)') + word(requestId);
}

export interface LiquidStakingSnapshot {
    blockNumber: number;
    vault: string;
    stQUAI: string;
    strategy: string;
    wquai: string;
    withdrawalDelaySeconds: bigint;
    managedAssets: bigint;
    shareSupply: bigint;
    claimLiabilities: bigint;
    processedLiabilities: bigint;
    requestCount: bigint;
    /** WQUAI held by the vault itself: the buffer that pays claims without touching the strategy. */
    idleAssets: bigint;
    /** WQUAI the strategy reports holding for the vault, revenue included. */
    strategyAssets: bigint;
    vaultPaused: boolean;
    strategyPaused: boolean;
    /** Who may fund revenue into the strategy (the Dante strategy's facilitator); null if not exposed. */
    facilitator: string | null;
    wallet: null | {
        address: string;
        nativeBalance: bigint;
        wquaiBalance: bigint;
        shareBalance: bigint;
        wquaiVaultAllowance: bigint;
    };
}

export async function readLiquidStakingSnapshot(batch: BatchFn, vault: string, wallet?: string): Promise<LiquidStakingSnapshot> {
    addressWord(vault);
    if (wallet) addressWord(wallet);
    const vaultCalls = [
        call(vault, SEL.stQUAI),
        call(vault, SEL.strategy),
        call(vault, SEL.wquai),
        call(vault, SEL.withdrawalDelay),
        call(vault, SEL.totalManagedAssets),
        call(vault, SEL.claimLiabilities),
        call(vault, SEL.processedLiabilities),
        call(vault, SEL.requestCount)
    ];
    const initial = await batch([{ method: 'quai_blockNumber', params: [] }, ...vaultCalls]);
    const stQUAI = address(initial[1], 'stQUAI address');
    const wquai = address(initial[3], 'WQUAI address');
    const strategy = address(initial[2], 'strategy address');
    const tokenCalls = [
        call(stQUAI, SEL.totalSupply),
        call(wquai, SEL.balanceOf + addressWord(vault)),
        call(strategy, SEL.strategyAssets),
        call(vault, SEL.paused),
        call(strategy, SEL.paused),
        call(strategy, SEL.facilitator)
    ];
    if (wallet) {
        tokenCalls.push(
            call(stQUAI, SEL.balanceOf + addressWord(wallet)),
            call(wquai, SEL.balanceOf + addressWord(wallet)),
            call(wquai, SEL.allowance + addressWord(wallet) + addressWord(vault))
        );
    }
    const [tokenResults, nativeResults] = await Promise.all([
        batch(tokenCalls),
        wallet ? batch([{ method: 'quai_getBalance', params: [wallet, 'latest'] }]) : Promise.resolve([])
    ]);
    const block = quantity(initial[0], 'block number');
    if (block > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Block number is too large.');
    return {
        blockNumber: Number(block),
        vault,
        stQUAI,
        strategy,
        wquai,
        withdrawalDelaySeconds: uint(initial[4], 'withdrawal delay'),
        managedAssets: uint(initial[5], 'managed assets'),
        shareSupply: uint(tokenResults[0], 'stQUAI supply'),
        claimLiabilities: uint(initial[6], 'claim liabilities'),
        processedLiabilities: uint(initial[7], 'processed liabilities'),
        requestCount: uint(initial[8], 'withdrawal request count'),
        idleAssets: uint(tokenResults[1], 'vault WQUAI buffer'),
        strategyAssets: uint(tokenResults[2], 'strategy assets'),
        vaultPaused: flag(tokenResults[3], 'vault pause state'),
        strategyPaused: tokenResults[4]?.ok && isWord(tokenResults[4].value) ? BigInt(tokenResults[4].value) !== 0n : false,
        facilitator: optionalAddress(tokenResults[5]),
        wallet: wallet ? {
            address: wallet,
            nativeBalance: quantity(nativeResults[0], 'native QUAI balance'),
            shareBalance: uint(tokenResults[6], 'wallet stQUAI balance'),
            wquaiBalance: uint(tokenResults[7], 'wallet WQUAI balance'),
            wquaiVaultAllowance: uint(tokenResults[8], 'WQUAI vault allowance')
        } : null
    };
}

export interface LiquidStakingRatePoint {
    blockNumber: number;
    /** Block timestamp, seconds. */
    timestamp: number;
    /** QUAI value of 1 stQUAI (1e18 base units) at that block. */
    rateE18: bigint;
}

function blockTimestamp(result: BatchResult | undefined, label: string): number {
    const header = result?.ok ? (result.value?.woHeader ?? result.value?.header ?? result.value) : null;
    const ts = header?.timestamp;
    if (typeof ts !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(ts)) throw new Error(`Could not read ${label}.`);
    return Number(BigInt(ts));
}

/** The vault's own redemption rate at a past block (the RPC serves historical state), with that block's time. */
export async function readLiquidStakingRateAt(batch: BatchFn, vault: string, blockNumber: number): Promise<LiquidStakingRatePoint> {
    addressWord(vault);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error('Invalid block number.');
    const tag = '0x' + blockNumber.toString(16);
    const [rate, block] = await batch([
        { method: 'quai_call', params: [{ to: vault, data: SEL.previewRedeem + word(10n ** 18n) }, tag] },
        { method: 'quai_getBlockByNumber', params: [tag, false] }
    ]);
    return { blockNumber, timestamp: blockTimestamp(block, `block ${blockNumber}`), rateE18: uint(rate, `rate at block ${blockNumber}`) };
}

/** The vault's current redemption rate: QUAI value of 1 stQUAI (1e18 base units), from its own previewRedeem. */
export async function readLiquidStakingRate(batch: BatchFn, vault: string): Promise<bigint> {
    addressWord(vault);
    const [rate] = await batch([call(vault, SEL.previewRedeem + word(10n ** 18n))]);
    return uint(rate, 'stQUAI redemption rate');
}

export interface LiquidWithdrawalRequest {
    id: bigint;
    receiver: string;
    assets: bigint;
    claimableAt: bigint;
    processed: boolean;
    claimed: boolean;
}

function decodeRequest(id: bigint, result: BatchResult | undefined): LiquidWithdrawalRequest {
    if (!result?.ok || typeof result.value !== 'string' || !/^0x[0-9a-fA-F]{320}$/.test(result.value)) {
        throw new Error(`Could not read withdrawal request ${id}.`);
    }
    const words = result.value.slice(2).match(/.{64}/g)!;
    return {
        id,
        receiver: '0x' + words[0].slice(24),
        assets: BigInt('0x' + words[1]),
        claimableAt: BigInt('0x' + words[2]),
        processed: BigInt('0x' + words[3]) !== 0n,
        claimed: BigInt('0x' + words[4]) !== 0n
    };
}

export async function readLiquidWithdrawalRequest(batch: BatchFn, vault: string, id: bigint): Promise<LiquidWithdrawalRequest> {
    if (id < 0n) throw new Error('Negative withdrawal request id.');
    const [result] = await batch([call(vault, SEL.request + word(id))]);
    return decodeRequest(id, result);
}

/** Reads a bounded inclusive-start/exclusive-end range; callers choose pagination instead of unbounded RPC batches. */
export async function readLiquidWithdrawalRequests(batch: BatchFn, vault: string, start: bigint, end: bigint): Promise<LiquidWithdrawalRequest[]> {
    if (start < 0n || end < start || end - start > 200n) throw new Error('Withdrawal request range must contain 0–200 items.');
    if (start === end) return [];
    const ids = Array.from({ length: Number(end - start) }, (_, i) => start + BigInt(i));
    const results = await batch(ids.map(id => call(vault, SEL.request + word(id))));
    return ids.map((id, i) => decodeRequest(id, results[i]));
}
