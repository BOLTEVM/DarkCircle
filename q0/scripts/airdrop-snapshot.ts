// Snapshot who has BDELTA staked on Quainance, plan the airdrop, and write the distribution file the claim contract checks.
// READ-ONLY: nothing is signed or sent; it reads the chain and writes two files.
//
//   bun run q0/scripts/airdrop-snapshot.ts                       # the Quainance BDELTA/WQUAI pool, 2.1M Q0 + 210k QAXE
//   bun run q0/scripts/airdrop-snapshot.ts --pair 0x... --pair 0x...   # more pools (each must contain BDELTA)
//   bun run q0/scripts/airdrop-snapshot.ts --contract 0x...      # stamp the claim contract into the file
//   bun run q0/scripts/airdrop-snapshot.ts --out q0/airdrop      # where to write (default q0/airdrop/out)
//   bun run q0/scripts/airdrop-snapshot.ts --snapshot snapshot-123.json   # re-plan from a saved snapshot, no chain reads
//   bun run q0/scripts/airdrop-snapshot.ts --count-burned        # burned liquidity also counts as stake (default: it only earns the 1.5x)
//   bun run q0/scripts/airdrop-snapshot.ts --exclude 0x...       # an account that does not take part (repeatable)
//
// Output: snapshot-<block>.json (every position, for audit) and distribution-<root8>.json (what the admin dashboard loads and
// the claim page reads). The distribution is only final once the stake window you announced has closed: run it again then.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    AIRDROP_DEFAULTS,
    TOKEN_REGISTRY,
    auditDistribution,
    buildDistribution,
    planAirdrop,
    snapshotPool,
    type StakePosition
} from '../packages/quai-service/src/index';

const args = process.argv.slice(2);
const flag = (name: string): string[] => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const pairs = flag('--pair').length ? flag('--pair') : ['0x006524c3e3d2197dd61a64fef54f099260387209'];
const contract = flag('--contract')[0] ?? null;
const outDir = flag('--out')[0] ?? 'q0/airdrop/out';
const snapshotFile = flag('--snapshot')[0] ?? null;
const countBurned = args.includes('--count-burned');
const exclude = flag('--exclude');

const BDELTA = TOKEN_REGISTRY.BDELTA.address;
const Q0 = TOKEN_REGISTRY.Q0;
const QAXE = TOKEN_REGISTRY.QAXE;
const fmt = (n: bigint, d = 18) => (Number(n) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: 2 });

async function main() {
    const merged: StakePosition[] = [];
    let block = 0;
    const warnings: string[] = [];
    if (snapshotFile) {
        const saved = JSON.parse(readFileSync(snapshotFile, 'utf8'));
        block = Number(saved.block);
        warnings.push(...(saved.warnings ?? []));
        for (const p of saved.positions) merged.push({ account: p.account, held: BigInt(p.held), burned: BigInt(p.burned) });
        console.log(`Using the saved snapshot at block ${block}: ${merged.length} positions`);
    }
    for (const pair of snapshotFile ? [] : pairs) {
        process.stdout.write(`Reading ${pair} ... `);
        const snap = await snapshotPool(BDELTA, pair, { onProgress: (w, f) => process.stdout.write(`\rReading ${pair}: ${w} windows, ${f} transfers   `) });
        block = Math.max(block, snap.block);
        console.log(`\n  block ${snap.block}, supply ${fmt(snap.totalSupply)} LP, ${fmt(snap.burnedTotal)} LP at the zero/dead address, ${snap.positions.length} accounts`);
        if (!snap.complete) warnings.push(`${pair}: the log history did not reach the pool's first mint; a burner may be missing.`);
        for (const h of snap.contractHolders) warnings.push(`${pair}: ${h} is a contract holding liquidity; whoever is behind it is not counted.`);
        for (const g of snap.gauges) console.log(`  staking gauge ${g}: its depositors were read one by one`);
        for (const u of snap.unattributed) warnings.push(`${pair}: ${u}.`);
        merged.push(...snap.positions.map(p => ({ ...p, account: p.account })));
        // the pair itself must not take part
        merged.push({ account: pair, held: 0n, burned: 0n });
    }

    const plan = planAirdrop(merged, { exclude: [...pairs, ...exclude], countBurned });
    console.log('');
    console.log(`Pot            ${fmt(plan.params.totalA)} Q0 + ${fmt(plan.params.totalB)} QAXE`);
    console.log(`Rule           at least ${fmt(plan.params.thresholdWei)} BDELTA staked; burners x${Number(plan.params.burnerMultiplierBps) / 10_000}; burned liquidity ${plan.params.countBurned ? 'counts as stake' : 'only earns the multiplier'}`);
    console.log(`Accounts seen  ${plan.accounts}, below the threshold ${plan.belowThreshold}, eligible ${plan.entries.length} (${plan.burners} burners)`);
    for (const e of plan.entries) {
        console.log(`  #${e.index} ${e.account}  stake ${fmt(e.stake)} BDELTA${e.burner ? ` (burned ${fmt(e.burned)})` : ''}  ->  ${fmt(e.amountA)} Q0 + ${fmt(e.amountB)} QAXE`);
    }
    for (const w of warnings) console.log(`WARNING: ${w}`);
    if (plan.entries.length === 0) {
        console.log('\nNobody is eligible under this rule, so there is no distribution to write.');
        return;
    }

    const dist = buildDistribution({
        plan,
        chainId: 9,
        contract,
        tokenA: { address: Q0.address.toLowerCase(), symbol: 'Q0' },
        tokenB: { address: QAXE.address.toLowerCase(), symbol: 'QAXE' },
        snapshotBlock: block
    });
    const problems = auditDistribution(dist);
    if (problems.length) {
        console.error('The file failed its own audit:', problems);
        process.exit(1);
    }
    mkdirSync(outDir, { recursive: true });
    const snapPath = join(outDir, `snapshot-${block}.json`);
    const distPath = join(outDir, `distribution-${dist.merkleRoot.slice(2, 10)}.json`);
    writeFileSync(snapPath, JSON.stringify({ block, pairs, params: { thresholdWei: plan.params.thresholdWei.toString(), burnerMultiplierBps: plan.params.burnerMultiplierBps.toString() }, positions: merged.map(p => ({ account: p.account, held: p.held.toString(), burned: p.burned.toString() })), warnings }, null, 2));
    writeFileSync(distPath, JSON.stringify(dist, null, 2));
    console.log(`\nMerkle root ${dist.merkleRoot}`);
    console.log(`Contract must hold ${fmt(BigInt(dist.totalA))} Q0 and ${fmt(BigInt(dist.totalB))} QAXE (the pot minus ${plan.dustA} / ${plan.dustB} wei of rounding dust)`);
    console.log(`Wrote ${snapPath}\nWrote ${distPath}`);
    void AIRDROP_DEFAULTS;
}

main().catch(e => {
    console.error(e?.message ?? e);
    process.exit(1);
});
