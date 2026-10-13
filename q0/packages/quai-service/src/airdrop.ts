// Airdrop: who gets how much, and the Merkle tree the claim contract checks.
//
// The rule (set by the project, not discovered here): everyone who has at least 1,000 BDELTA staked on Quainance shares
// a fixed pot of 2,100,000 Q0 and 210,000 QAXE in proportion to the BDELTA they have staked, and an LP burner (someone who
// sent liquidity tokens to the dead address, locking that liquidity for good) counts 1.5x. This file is the arithmetic and
// the tree and nothing else: no network, no clock. The snapshot of who has staked what comes from airdropSnapshot.ts, or
// from a file the administrator loads, and the same plan always gives the same root.
//
// All amounts are integers in token base units (18 decimals). Nothing is rounded up: each share is floored, so the sum
// handed out can never exceed the pot, and the few wei that remain are reported as dust, never silently moved.

import { keccak256Hex } from './keccak';

export const AIRDROP_DEFAULTS = {
    /** BDELTA staked (1,000 whole tokens) at which an account becomes eligible. */
    thresholdWei: 1_000n * 10n ** 18n,
    /** A burner's weight, in basis points of a non-burner's: 15,000 = 1.5x. */
    burnerMultiplierBps: 15_000n,
    /** Q0 in the pot (2.1 million). */
    totalA: 2_100_000n * 10n ** 18n,
    /** QAXE in the pot (210 thousand). */
    totalB: 210_000n * 10n ** 18n
} as const;

const BPS = 10_000n;
const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';

export interface AirdropParams {
    thresholdWei: bigint;
    burnerMultiplierBps: bigint;
    /** The first token of the pot (Q0) and the second (QAXE). */
    totalA: bigint;
    totalB: bigint;
    /** Accounts that never take part (the pair itself, a router, a vault...), lower case. Zero and dead are always out. */
    exclude?: readonly string[];
}

/** What one account has staked, in BDELTA base units (a pool share already converted to the BDELTA it represents). */
export interface StakePosition {
    account: string;
    /** BDELTA-equivalent still held as liquidity or staked. */
    held: bigint;
    /** BDELTA-equivalent this account burned (sent to the dead address): still in the pool for good, and it counts. */
    burned: bigint;
}

export interface AirdropEntry {
    /** Position in the tree (accounts sorted by address). */
    index: number;
    account: string;
    held: bigint;
    burned: bigint;
    /** held + burned. */
    stake: bigint;
    burner: boolean;
    weight: bigint;
    amountA: bigint;
    amountB: bigint;
}

export interface AirdropPlan {
    params: Required<Omit<AirdropParams, 'exclude'>>;
    entries: AirdropEntry[];
    /** Accounts seen, merged by address (before the threshold). */
    accounts: number;
    /** Accounts below the threshold, and how much BDELTA they hold between them. */
    belowThreshold: number;
    burners: number;
    totalWeight: bigint;
    /** Sum of the shares handed out, and what is left because every share is floored. */
    distributedA: bigint;
    distributedB: bigint;
    dustA: bigint;
    dustB: bigint;
}

const isAddress = (a: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(a);

/** Merge, filter and weigh the positions, and split the pot. Throws on a malformed address or a negative amount. */
export function planAirdrop(positions: readonly StakePosition[], overrides: Partial<AirdropParams> = {}): AirdropPlan {
    const params = {
        thresholdWei: overrides.thresholdWei ?? AIRDROP_DEFAULTS.thresholdWei,
        burnerMultiplierBps: overrides.burnerMultiplierBps ?? AIRDROP_DEFAULTS.burnerMultiplierBps,
        totalA: overrides.totalA ?? AIRDROP_DEFAULTS.totalA,
        totalB: overrides.totalB ?? AIRDROP_DEFAULTS.totalB
    };
    if (params.thresholdWei < 0n || params.totalA < 0n || params.totalB < 0n) throw new Error('Thresholds and totals cannot be negative.');
    if (params.burnerMultiplierBps < BPS) throw new Error('A burner multiplier below 1x would punish burning.');
    const out = new Set<string>([ZERO, DEAD, ...(overrides.exclude ?? []).map(a => a.toLowerCase())]);

    const merged = new Map<string, { held: bigint; burned: bigint }>();
    for (const p of positions) {
        if (!isAddress(p.account)) throw new Error(`Not an address: ${String(p.account).slice(0, 46)}`);
        if (p.held < 0n || p.burned < 0n) throw new Error(`Negative stake for ${p.account}.`);
        const key = p.account.toLowerCase();
        if (out.has(key)) continue;
        const cur = merged.get(key) ?? { held: 0n, burned: 0n };
        merged.set(key, { held: cur.held + p.held, burned: cur.burned + p.burned });
    }

    const eligible = [...merged.entries()]
        .map(([account, v]) => ({ account, held: v.held, burned: v.burned, stake: v.held + v.burned }))
        .filter(v => v.stake > 0n && v.stake >= params.thresholdWei)
        .sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));

    let totalWeight = 0n;
    const weighted = eligible.map(v => {
        const burner = v.burned > 0n;
        const weight = v.stake * (burner ? params.burnerMultiplierBps : BPS);
        totalWeight += weight;
        return { ...v, burner, weight };
    });

    let distributedA = 0n;
    let distributedB = 0n;
    const entries: AirdropEntry[] = weighted.map((v, index) => {
        const amountA = totalWeight === 0n ? 0n : (params.totalA * v.weight) / totalWeight;
        const amountB = totalWeight === 0n ? 0n : (params.totalB * v.weight) / totalWeight;
        distributedA += amountA;
        distributedB += amountB;
        return { index, account: v.account, held: v.held, burned: v.burned, stake: v.stake, burner: v.burner, weight: v.weight, amountA, amountB };
    });

    return {
        params,
        entries,
        accounts: merged.size,
        belowThreshold: merged.size - eligible.length,
        burners: entries.filter(e => e.burner).length,
        totalWeight,
        distributedA,
        distributedB,
        dustA: params.totalA - distributedA,
        dustB: params.totalB - distributedB
    };
}

// ----------------------------------------------------------------------------------------------------- Merkle tree

const word = (n: bigint): string => {
    if (n < 0n || n >= 1n << 256n) throw new Error('Amount does not fit in a uint256.');
    return n.toString(16).padStart(64, '0');
};

/**
 * The leaf the contract recomputes: keccak256(keccak256(abi.encode(index, account, amountA, amountB))). The inner hash
 * over four 32-byte words and the outer hash over its 32-byte digest follow OpenZeppelin's standard-merkle-tree, so a
 * leaf can never be read as an inner node (the second-preimage trap of a single-hash tree).
 */
export function airdropLeaf(index: number, account: string, amountA: bigint, amountB: bigint): string {
    if (!isAddress(account)) throw new Error(`Not an address: ${String(account).slice(0, 46)}`);
    const inner = keccak256Hex('0x' + word(BigInt(index)) + account.slice(2).toLowerCase().padStart(64, '0') + word(amountA) + word(amountB));
    return keccak256Hex(inner);
}

/** Inner nodes hash their two children in sorted order, which is what OpenZeppelin's MerkleProof verifies. */
export function hashPair(a: string, b: string): string {
    const [lo, hi] = a.toLowerCase() <= b.toLowerCase() ? [a, b] : [b, a];
    return keccak256Hex('0x' + lo.slice(2) + hi.slice(2));
}

export interface MerkleTree {
    root: string;
    /** layers[0] are the leaves, the last layer is [root]. */
    layers: string[][];
}

/** A node with no sibling is carried up unchanged (its proof simply has no step at that level). */
export function buildMerkleTree(leaves: readonly string[]): MerkleTree {
    if (leaves.length === 0) throw new Error('An airdrop with nobody in it has no tree.');
    const layers: string[][] = [leaves.map(l => l.toLowerCase())];
    while (layers[layers.length - 1].length > 1) {
        const prev = layers[layers.length - 1];
        const next: string[] = [];
        for (let i = 0; i < prev.length; i += 2) next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
        layers.push(next);
    }
    return { root: layers[layers.length - 1][0], layers };
}

export function merkleProof(tree: MerkleTree, leafIndex: number): string[] {
    if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= tree.layers[0].length) throw new Error('No such leaf.');
    const proof: string[] = [];
    let i = leafIndex;
    for (let level = 0; level < tree.layers.length - 1; level++) {
        const layer = tree.layers[level];
        const sibling = i ^ 1;
        if (sibling < layer.length) proof.push(layer[sibling]);
        i = i >> 1;
    }
    return proof;
}

export function verifyMerkleProof(proof: readonly string[], root: string, leaf: string): boolean {
    let node = leaf.toLowerCase();
    for (const step of proof) node = hashPair(node, step);
    return node === root.toLowerCase();
}

// ------------------------------------------------------------------------------------------------ distribution file

export interface DistributionEntry {
    index: number;
    account: string;
    amountA: string;
    amountB: string;
    /** BDELTA-equivalent staked, for the claim page to show why. */
    stake: string;
    burner: boolean;
    proof: string[];
}

/** The file the administrator publishes and the claim page reads. Amounts are decimal strings. */
export interface Distribution {
    version: 1;
    chainId: number;
    /** The claim contract this tree is for (set once it is deployed), lower case. */
    contract: string | null;
    tokenA: { address: string; symbol: string };
    tokenB: { address: string; symbol: string };
    merkleRoot: string;
    totalA: string;
    totalB: string;
    thresholdWei: string;
    burnerMultiplierBps: string;
    /** Block of the stake snapshot, for anyone who wants to reproduce it. */
    snapshotBlock: number | null;
    entries: DistributionEntry[];
}

export interface DistributionInput {
    plan: AirdropPlan;
    chainId: number;
    contract: string | null;
    tokenA: { address: string; symbol: string };
    tokenB: { address: string; symbol: string };
    snapshotBlock: number | null;
}

export function buildDistribution(input: DistributionInput): Distribution {
    const { plan } = input;
    if (plan.entries.length === 0) throw new Error('Nobody is eligible: there is nothing to distribute.');
    const leaves = plan.entries.map(e => airdropLeaf(e.index, e.account, e.amountA, e.amountB));
    const tree = buildMerkleTree(leaves);
    return {
        version: 1,
        chainId: input.chainId,
        contract: input.contract ? input.contract.toLowerCase() : null,
        tokenA: input.tokenA,
        tokenB: input.tokenB,
        merkleRoot: tree.root,
        // what the contract must hold: the sum of the shares, not the pot (the dust stays with the owner)
        totalA: plan.distributedA.toString(),
        totalB: plan.distributedB.toString(),
        thresholdWei: plan.params.thresholdWei.toString(),
        burnerMultiplierBps: plan.params.burnerMultiplierBps.toString(),
        snapshotBlock: input.snapshotBlock,
        entries: plan.entries.map(e => ({
            index: e.index,
            account: e.account,
            amountA: e.amountA.toString(),
            amountB: e.amountB.toString(),
            stake: e.stake.toString(),
            burner: e.burner,
            proof: merkleProof(tree, e.index)
        }))
    };
}

/**
 * Check a distribution file as someone who does not trust it: every proof must lead to the root, indexes must be a
 * 0..n-1 sequence, accounts must be unique, and the totals must equal the sum of the shares. Returns the problems found.
 */
export function auditDistribution(d: Distribution): string[] {
    const problems: string[] = [];
    if (d.version !== 1) problems.push(`Unknown file version ${String(d.version)}.`);
    const seen = new Set<string>();
    let sumA = 0n;
    let sumB = 0n;
    d.entries.forEach((e, i) => {
        if (e.index !== i) problems.push(`Entry ${i} has index ${e.index}.`);
        const key = e.account.toLowerCase();
        if (seen.has(key)) problems.push(`${e.account} appears twice.`);
        seen.add(key);
        try {
            const a = BigInt(e.amountA);
            const b = BigInt(e.amountB);
            sumA += a;
            sumB += b;
            if (!verifyMerkleProof(e.proof, d.merkleRoot, airdropLeaf(e.index, e.account, a, b))) problems.push(`The proof for ${e.account} does not lead to the root.`);
        } catch (err: any) {
            problems.push(`Entry ${i} (${e.account}): ${err?.message ?? 'unreadable'}`);
        }
    });
    if (sumA.toString() !== d.totalA) problems.push(`totalA is ${d.totalA} but the shares add up to ${sumA}.`);
    if (sumB.toString() !== d.totalB) problems.push(`totalB is ${d.totalB} but the shares add up to ${sumB}.`);
    return problems;
}

/** The entry for a wallet, if it is in the distribution. */
export function findEntry(d: Distribution, wallet: string | null | undefined): DistributionEntry | null {
    if (!wallet) return null;
    const key = wallet.toLowerCase();
    return d.entries.find(e => e.account.toLowerCase() === key) ?? null;
}
