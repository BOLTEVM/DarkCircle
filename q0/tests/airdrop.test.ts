import { describe, expect, test } from 'bun:test';
import {
    AIRDROP_DEFAULTS,
    airdropLeaf,
    auditDistribution,
    buildDistribution,
    buildMerkleTree,
    findEntry,
    hashPair,
    merkleProof,
    planAirdrop,
    verifyMerkleProof,
    type StakePosition
} from '../packages/quai-service/src/airdrop';
import {
    TRANSFER_TOPIC,
    burnedBy,
    parseTransferLog,
    positionsFromPool,
    scanTransfers,
    shareOfReserve,
    type LpTransfer
} from '../packages/quai-service/src/airdropSnapshot';
import type { BatchCall, BatchFn } from '../packages/quai-service/src/pairs';
import { AIRDROP_SELECTORS, readAirdropState } from '../packages/quai-service/src/airdropTx';
import { QUAINANCE_GAUGE_V2, readQuainanceBdeltaStake } from '../packages/quai-service/src/quainanceStake';

const E18 = 10n ** 18n;
const acct = (n: number) => '0x00' + n.toString(16).padStart(38, '0');
const pos = (n: number, held: bigint, burned = 0n): StakePosition => ({ account: acct(n), held: held * E18, burned: burned * E18 });

describe('planAirdrop', () => {
    test('the pot, the threshold and the burner multiplier are the ones the project set', () => {
        expect(AIRDROP_DEFAULTS.totalA).toBe(2_100_000n * E18);
        expect(AIRDROP_DEFAULTS.totalB).toBe(210_000n * E18);
        expect(AIRDROP_DEFAULTS.thresholdWei).toBe(1_000n * E18);
        expect(AIRDROP_DEFAULTS.burnerMultiplierBps).toBe(15_000n);
    });

    test('below 1,000 BDELTA is out, exactly 1,000 is in', () => {
        const plan = planAirdrop([pos(1, 999n), pos(2, 1000n), pos(3, 5000n)]);
        expect(plan.entries.map(e => e.account)).toEqual([acct(2), acct(3)]);
        expect(plan.belowThreshold).toBe(1);
        expect(plan.accounts).toBe(3);
    });

    test('by default only what is still staked counts: burned liquidity earns the multiplier but is not stake', () => {
        const plan = planAirdrop([pos(1, 1000n), pos(2, 0n, 5000n), pos(3, 1000n, 5000n)]);
        // account 2 burned a lot and holds nothing: not eligible. Account 3 is eligible on its held 1,000 alone.
        expect(plan.entries.map(e => e.account)).toEqual([acct(1), acct(3)]);
        const [plain, burner] = plan.entries;
        expect(plain.stake).toBe(1000n * E18);
        expect(burner.stake).toBe(1000n * E18);
        expect(burner.burner).toBe(true);
        // same stake, 1.5x the weight: 3 : 2 between burner and plain
        expect(burner.amountA * 2n).toBeGreaterThanOrEqual(plain.amountA * 3n - 2n);
        expect(burner.amountA * 2n).toBeLessThanOrEqual(plain.amountA * 3n + 2n);
    });

    test('a burner counts 1.5x the same stake, and with countBurned the burned liquidity counts toward the threshold', () => {
        const plan = planAirdrop([pos(1, 1000n), pos(2, 0n, 1000n)], { countBurned: true });
        expect(plan.params.countBurned).toBe(true);
        const [plain, burner] = plan.entries;
        expect(plain.burner).toBe(false);
        expect(burner.burner).toBe(true);
        // 1.5 : 1
        expect(burner.amountA * 2n).toBeGreaterThanOrEqual(plain.amountA * 3n - 2n);
        expect(burner.amountA * 2n).toBeLessThanOrEqual(plain.amountA * 3n + 2n);
        expect(plan.entries.reduce((s, e) => s + e.amountA, 0n)).toBe(plan.distributedA);
    });

    test('shares are floored: never more than the pot, and the remainder is reported as dust', () => {
        const plan = planAirdrop([pos(1, 1000n), pos(2, 1000n), pos(3, 1000n)], { totalA: 100n, totalB: 10n });
        expect(plan.entries.map(e => e.amountA)).toEqual([33n, 33n, 33n]);
        expect(plan.distributedA).toBe(99n);
        expect(plan.dustA).toBe(1n);
        expect(plan.distributedB + plan.dustB).toBe(10n);
    });

    test('the whole pot is distributed within a few wei for a realistic spread', () => {
        const positions = Array.from({ length: 200 }, (_, i) => pos(i + 1, BigInt(1000 + ((i * 7919) % 90_000)), i % 9 === 0 ? BigInt(500 + i) : 0n));
        const plan = planAirdrop(positions);
        expect(plan.distributedA + plan.dustA).toBe(AIRDROP_DEFAULTS.totalA);
        expect(plan.distributedB + plan.dustB).toBe(AIRDROP_DEFAULTS.totalB);
        expect(plan.dustA < BigInt(plan.entries.length)).toBe(true);
        expect(plan.dustB < BigInt(plan.entries.length)).toBe(true);
        expect(plan.burners).toBe(plan.entries.filter(e => e.burned > 0n).length);
    });

    test('the same account listed twice is one account; the zero, dead and excluded addresses never take part', () => {
        const pair = acct(99);
        const plan = planAirdrop(
            [
                pos(1, 600n),
                pos(1, 600n),
                { account: '0x0000000000000000000000000000000000000000', held: 50_000n * E18, burned: 0n },
                { account: '0x000000000000000000000000000000000000dEaD', held: 50_000n * E18, burned: 0n },
                { account: pair, held: 50_000n * E18, burned: 0n }
            ],
            { exclude: [pair] }
        );
        expect(plan.entries).toHaveLength(1);
        expect(plan.entries[0].stake).toBe(1200n * E18);
    });

    test('order is by address, so the same positions in any order give the same plan', () => {
        const a = planAirdrop([pos(3, 2000n), pos(1, 3000n), pos(2, 1500n)]);
        const b = planAirdrop([pos(2, 1500n), pos(3, 2000n), pos(1, 3000n)]);
        expect(a.entries.map(e => [e.index, e.account, e.amountA, e.amountB])).toEqual(b.entries.map(e => [e.index, e.account, e.amountA, e.amountB]));
        expect(a.entries.map(e => e.index)).toEqual([0, 1, 2]);
    });

    test('bad input is refused, not guessed at', () => {
        expect(() => planAirdrop([{ account: 'nope', held: 1n, burned: 0n }])).toThrow(/Not an address/);
        expect(() => planAirdrop([{ account: acct(1), held: -1n, burned: 0n }])).toThrow(/Negative/);
        expect(() => planAirdrop([pos(1, 2000n)], { burnerMultiplierBps: 5_000n })).toThrow(/punish/);
    });

    test('nobody eligible gives an empty plan and no distribution', () => {
        const plan = planAirdrop([pos(1, 10n)]);
        expect(plan.entries).toHaveLength(0);
        expect(plan.dustA).toBe(AIRDROP_DEFAULTS.totalA);
        expect(() => buildDistribution({ plan, chainId: 9, contract: null, tokenA: { address: acct(10), symbol: 'Q0' }, tokenB: { address: acct(11), symbol: 'QAXE' }, snapshotBlock: 1 })).toThrow(/nothing to distribute/);
    });
});

describe('merkle tree', () => {
    const leaves = (n: number) => Array.from({ length: n }, (_, i) => airdropLeaf(i, acct(i + 1), BigInt(i + 1) * E18, BigInt(i + 1) * 10n ** 17n));

    test('every proof verifies for 1..9 leaves (odd counts carry a node up)', () => {
        for (let n = 1; n <= 9; n++) {
            const l = leaves(n);
            const tree = buildMerkleTree(l);
            for (let i = 0; i < n; i++) expect(verifyMerkleProof(merkleProof(tree, i), tree.root, l[i])).toBe(true);
        }
    });

    test('a proof does not verify for another leaf, another root, or a changed amount', () => {
        const l = leaves(5);
        const tree = buildMerkleTree(l);
        const proof = merkleProof(tree, 2);
        expect(verifyMerkleProof(proof, tree.root, l[3])).toBe(false);
        expect(verifyMerkleProof(proof, buildMerkleTree(leaves(4)).root, l[2])).toBe(false);
        expect(verifyMerkleProof(proof, tree.root, airdropLeaf(2, acct(3), 4n * E18, 3n * 10n ** 17n))).toBe(false);
    });

    test('pairs hash in sorted order', () => {
        const [a, b] = leaves(2);
        expect(hashPair(a, b)).toBe(hashPair(b, a));
    });

    test('a leaf is a double hash: it can never be read as an inner node', () => {
        const [a, b] = leaves(2);
        expect(airdropLeaf(0, acct(1), 1n * E18, 1n * 10n ** 17n)).toBe(a);
        expect(a).not.toBe(b);
        expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    });

    test('an empty tree is refused', () => {
        expect(() => buildMerkleTree([])).toThrow();
    });
});

describe('distribution file', () => {
    const plan = planAirdrop(Array.from({ length: 13 }, (_, i) => pos(i + 1, BigInt(1000 + i * 250), i % 4 === 0 ? 300n : 0n)));
    const d = buildDistribution({ plan, chainId: 9, contract: '0x00AbCdEf00000000000000000000000000000001', tokenA: { address: acct(200), symbol: 'Q0' }, tokenB: { address: acct(201), symbol: 'QAXE' }, snapshotBlock: 123 });

    test('a file built from a plan passes its own audit', () => {
        expect(auditDistribution(d)).toEqual([]);
        expect(d.contract).toBe('0x00abcdef00000000000000000000000000000001');
        expect(BigInt(d.totalA)).toBe(plan.distributedA);
    });

    test('the audit catches a changed amount, a swapped proof, a wrong total and a duplicate', () => {
        const tampered = structuredClone(d);
        tampered.entries[3].amountA = (BigInt(tampered.entries[3].amountA) + 1n).toString();
        expect(auditDistribution(tampered).some(p => /does not lead to the root/.test(p))).toBe(true);

        const swapped = structuredClone(d);
        swapped.entries[1].proof = swapped.entries[2].proof;
        expect(auditDistribution(swapped).some(p => /does not lead to the root/.test(p))).toBe(true);

        const wrongTotal = structuredClone(d);
        wrongTotal.totalB = (BigInt(wrongTotal.totalB) + 1n).toString();
        expect(auditDistribution(wrongTotal).some(p => /totalB/.test(p))).toBe(true);

        const dup = structuredClone(d);
        dup.entries[4].account = dup.entries[5].account;
        expect(auditDistribution(dup).some(p => /twice/.test(p))).toBe(true);
    });

    test('findEntry matches a wallet in any case and returns null for a stranger', () => {
        expect(findEntry(d, d.entries[2].account.toUpperCase().replace('0X', '0x'))?.index).toBe(2);
        expect(findEntry(d, acct(9999))).toBeNull();
        expect(findEntry(d, null)).toBeNull();
    });
});

describe('snapshot arithmetic', () => {
    const PAIR = acct(500);
    const T = (from: string, to: string, value: bigint, block = 1, logIndex = 0): LpTransfer => ({ from, to, value, block, logIndex });
    const ZERO = '0x0000000000000000000000000000000000000000';
    const DEAD = '0x000000000000000000000000000000000000dead';

    test('only an account sending liquidity to the zero or dead address is a burner; the pair removing liquidity is not', () => {
        const burned = burnedBy(
            [
                T(ZERO, ZERO, 1000n), // the pair's own minimum liquidity
                T(ZERO, acct(1), 5000n),
                T(acct(1), ZERO, 2000n), // a burner
                T(acct(1), DEAD, 500n),
                T(acct(2), PAIR, 700n),
                T(PAIR, ZERO, 700n) // removal: the pair burning what it was sent
            ],
            PAIR
        );
        expect([...burned.entries()]).toEqual([[acct(1), 2500n]]);
    });

    test('liquidity tokens become the share of the staked token they represent, on either side of the pair', () => {
        expect(shareOfReserve(25n, 1000n, 100n)).toBe(250n);
        const balances = new Map([[acct(1), 50n * E18], [acct(2), 10n * E18]]);
        const burned = new Map([[acct(3), 20n * E18]]);
        const base = { pair: PAIR, reserve0: 4000n * E18, reserve1: 9000n * E18, totalSupply: 100n * E18, balances, burned };
        const asToken0 = positionsFromPool({ ...base, tokenIsToken0: true });
        const asToken1 = positionsFromPool({ ...base, tokenIsToken0: false });
        expect(asToken0.find(p => p.account === acct(1))!.held).toBe(2000n * E18);
        expect(asToken1.find(p => p.account === acct(1))!.held).toBe(4500n * E18);
        expect(asToken0.find(p => p.account === acct(3))!.burned).toBe(800n * E18);
    });

    test('a Transfer log is parsed, anything else is not', () => {
        const ok = parseTransferLog({ topics: [TRANSFER_TOPIC, '0x' + '0'.repeat(24) + 'aa'.repeat(20), '0x' + '0'.repeat(24) + 'bb'.repeat(20)], data: '0x' + (5n * E18).toString(16).padStart(64, '0'), blockNumber: '0x10', logIndex: '0x2' });
        expect(ok).toEqual({ from: '0x' + 'aa'.repeat(20), to: '0x' + 'bb'.repeat(20), value: 5n * E18, block: 16, logIndex: 2 });
        expect(parseTransferLog({ topics: [TRANSFER_TOPIC], data: '0x01' })).toBeNull();
        expect(parseTransferLog({ topics: ['0x1234', '0x0', '0x0'], data: '0x01' })).toBeNull();
    });

    test('the scan walks back window by window and stops at the first mint', async () => {
        const log = (block: number, from: string, to: string, v: bigint) => ({
            topics: [TRANSFER_TOPIC, '0x' + '0'.repeat(24) + from.slice(2), '0x' + '0'.repeat(24) + to.slice(2)],
            data: '0x' + v.toString(16).padStart(64, '0'),
            blockNumber: '0x' + block.toString(16),
            logIndex: '0x0'
        });
        const logs = [log(25_000, ZERO, ZERO, 1000n), log(25_001, ZERO, acct(1), 9000n), log(34_000, acct(1), ZERO, 100n)];
        const seen: [number, number][] = [];
        const batch: BatchFn = async (calls: BatchCall[]) =>
            calls.map(c => {
                const f = c.params[0] as { fromBlock: string; toBlock: string };
                const from = Number(BigInt(f.fromBlock));
                const to = Number(BigInt(f.toBlock));
                seen.push([from, to]);
                return { ok: true as const, value: logs.filter(l => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to) };
            });
        const r = await scanTransfers(batch, PAIR, 40_000, { perCall: 2, maxWindows: 50 });
        expect(r.complete).toBe(true);
        expect(r.transfers.map(t => t.block)).toEqual([25_000, 25_001, 34_000]);
        // windows are contiguous and never overlap
        const sorted = seen.slice().sort((a, b) => b[0] - a[0]);
        for (let i = 1; i < sorted.length; i++) expect(sorted[i][1]).toBe(sorted[i - 1][0] - 1);
    });

    test('a scan that hits its window limit before the first mint says it is incomplete', async () => {
        const batch: BatchFn = async calls => calls.map(() => ({ ok: true as const, value: [] }));
        const r = await scanTransfers(batch, PAIR, 1_000_000, { perCall: 4, maxWindows: 8 });
        expect(r.complete).toBe(false);
        expect(r.windows).toBe(8);
    });

    test('a node error aborts the scan instead of returning a partial history', async () => {
        const batch: BatchFn = async calls => calls.map(() => ({ ok: false as const, error: 'rate limited' }));
        await expect(scanTransfers(batch, PAIR, 50_000, { perCall: 2, retryDelayMs: 0 })).rejects.toThrow(/rate limited/);
    });

    test('a window that fails once is retried and the scan carries on', async () => {
        let failed = false;
        const batch: BatchFn = async calls =>
            calls.map(() => {
                if (!failed) {
                    failed = true;
                    return { ok: false as const, error: 'timed out' };
                }
                return { ok: true as const, value: [] };
            });
        const r = await scanTransfers(batch, PAIR, 25_000, { perCall: 3, maxWindows: 3, retryDelayMs: 0 });
        expect(r.windows).toBe(3);
    });

    test('an ordinary mint to a provider is not the first mint: the scan keeps going', async () => {
        const ordinary = { topics: [TRANSFER_TOPIC, '0x' + '0'.repeat(64), '0x' + '0'.repeat(24) + 'aa'.repeat(20)], data: '0x' + '64'.padStart(64, '0'), blockNumber: '0x5', logIndex: '0x0' };
        const batch: BatchFn = async calls => calls.map(() => ({ ok: true as const, value: [ordinary] }));
        const r = await scanTransfers(batch, PAIR, 100_000, { perCall: 2, maxWindows: 4 });
        expect(r.complete).toBe(false);
        expect(r.windows).toBe(4);
    });
});

describe('reading the contract and the stake', () => {
    const W = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
    const A = (a: string) => '0x' + '0'.repeat(24) + a.slice(2).toLowerCase();
    const CONTRACT = acct(300);
    const QA = acct(301);
    const QB = acct(302);

    test('the contract state is read field by field and the balances come from the two tokens', async () => {
        const answers = new Map<string, string>([
            [AIRDROP_SELECTORS.owner, A(acct(1))],
            [AIRDROP_SELECTORS.pendingOwner, A('0x' + '0'.repeat(40))],
            [AIRDROP_SELECTORS.tokenA, A(QA)],
            [AIRDROP_SELECTORS.tokenB, A(QB)],
            [AIRDROP_SELECTORS.merkleRoot, '0x' + 'ab'.repeat(32)],
            [AIRDROP_SELECTORS.totalA, W(5n)],
            [AIRDROP_SELECTORS.totalB, W(7n)],
            [AIRDROP_SELECTORS.claimDeadline, W(1_900_000_000n)],
            [AIRDROP_SELECTORS.claimedA, W(1n)],
            [AIRDROP_SELECTORS.claimedB, W(2n)]
        ]);
        const batch: BatchFn = async calls =>
            calls.map(c => {
                const p = c.params[0] as { to: string; data: string };
                if (p.data.startsWith('0x70a08231')) return { ok: true as const, value: W(p.to === QA ? 4n : 6n) };
                const v = answers.get(p.data);
                return v ? { ok: true as const, value: v } : { ok: false as const, error: 'unknown' };
            });
        const s = await readAirdropState(batch, CONTRACT);
        expect(s).toMatchObject({ tokenA: QA, tokenB: QB, rootSet: true, totalA: 5n, totalB: 7n, claimDeadline: 1_900_000_000, claimedA: 1n, claimedB: 2n, balanceA: 4n, balanceB: 6n, pendingOwner: null });
    });

    test('a contract that does not answer is named, not guessed at', async () => {
        const batch: BatchFn = async calls => calls.map(() => ({ ok: false as const, error: 'execution reverted' }));
        await expect(readAirdropState(batch, CONTRACT)).rejects.toThrow(/owner\(\)/);
    });

    test('the BDELTA a wallet has on Quainance is its liquidity in the wallet plus what is staked in the gauge', async () => {
        const bdelta = '0x002d4A4fBAC3DF3342eD17FDBa5139818a43B508';
        const wallet = acct(77);
        const reserves = (r0: bigint, r1: bigint) => '0x' + r0.toString(16).padStart(64, '0') + r1.toString(16).padStart(64, '0') + '0'.repeat(64);
        const mk = (bdeltaIsToken0: boolean): BatchFn => async calls =>
            calls.map(c => {
                const p = c.params[0] as { to: string; data: string };
                if (p.data === '0x0dfe1681') return { ok: true as const, value: bdeltaIsToken0 ? A(bdelta) : A(acct(9)) };
                if (p.data === '0x0902f1ac') return { ok: true as const, value: bdeltaIsToken0 ? reserves(40_000n * E18, 120_000n * E18) : reserves(120_000n * E18, 40_000n * E18) };
                if (p.data === '0x18160ddd') return { ok: true as const, value: W(100n * E18) };
                if (p.data.startsWith('0x70a08231')) return { ok: true as const, value: W(1n * E18) }; // 1 of 100 LP in the wallet
                if (p.to === QUAINANCE_GAUGE_V2 && p.data.length === 10 + 64) return { ok: true as const, value: W(5n) + W(1n).slice(2) }; // pid 5, exists
                if (p.to === QUAINANCE_GAUGE_V2) return { ok: true as const, value: W(2n * E18) }; // 2 LP staked
                return { ok: false as const, error: 'unexpected ' + p.data };
            });
        for (const side of [true, false]) {
            const s = await readQuainanceBdeltaStake(mk(side), wallet);
            expect(s.lpHeld).toBe(1n * E18);
            expect(s.lpStaked).toBe(2n * E18);
            // 3 of 100 LP of a pool holding 40,000 BDELTA: 1,200 BDELTA
            expect(s.bdelta).toBe(1200n * E18);
            expect(s.meetsThreshold).toBe(true);
        }
    });

    test('below 1,000 BDELTA does not meet the threshold, and an unreadable chain throws instead of reporting none', async () => {
        const small: BatchFn = async calls =>
            calls.map(c => {
                const p = c.params[0] as { to: string; data: string };
                if (p.data === '0x0dfe1681') return { ok: true as const, value: A('0x002d4A4fBAC3DF3342eD17FDBa5139818a43B508') };
                if (p.data === '0x0902f1ac') return { ok: true as const, value: '0x' + (40_000n * E18).toString(16).padStart(64, '0') + (1n).toString(16).padStart(64, '0') + '0'.repeat(64) };
                if (p.data === '0x18160ddd') return { ok: true as const, value: W(100n * E18) };
                if (p.data.startsWith('0x70a08231')) return { ok: true as const, value: W(E18 / 10n) };
                return { ok: true as const, value: W(0n) + W(0n).slice(2) };
            });
        const s = await readQuainanceBdeltaStake(small, acct(78));
        expect(s.bdelta).toBe(40n * E18);
        expect(s.meetsThreshold).toBe(false);
        const down: BatchFn = async calls => calls.map(() => ({ ok: false as const, error: 'down' }));
        await expect(readQuainanceBdeltaStake(down, acct(78))).rejects.toThrow();
    });
});
