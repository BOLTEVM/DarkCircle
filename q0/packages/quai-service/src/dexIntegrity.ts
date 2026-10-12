// Is the code at each DEX's factory and router still the code this app was written against?
//
// Every address in registries/pools.ts is a constant in this source file, so nothing a user or a pool contract says can
// redirect a swap to a different router. What can change under a constant address is the code behind it (an upgradeable
// proxy, a redeployed contract at a reused address). The hashes pinned next to each DEX are keccak256 of the runtime
// code; a different hash switches that DEX off for routing rather than sending funds to code nobody reviewed.
//
// Three outcomes matter to a caller:
//   VERIFIED / UNPINNED  safe to route through (UNPINNED = no hash on record, e.g. Circleswap, checked by deploy tooling)
//   MISMATCH             the contract is not the pinned one, or there is no contract there: do not route through it
//   UNREADABLE           the node did not answer: unknown. Fine for showing a quote, NOT enough to sign a swap.

import { DEXES, AMM_DEX_IDS, isDexLive, type DexId } from './registries/pools';
import { checksumAddress, keccak256Hex } from './keccak';
import { createBatch, type BatchFn } from './pairs';

export type DexCodeState = 'VERIFIED' | 'UNPINNED' | 'MISMATCH' | 'UNREADABLE' | 'NOT_DEPLOYED';

export interface DexCodeReport {
    dex: DexId;
    state: DexCodeState;
    /** One plain sentence, safe to show. */
    detail: string;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** May a quote through this DEX be shown? Everything except a proven mismatch (and a DEX that does not exist yet). */
export const canQuote = (state: DexCodeState): boolean => state === 'VERIFIED' || state === 'UNPINNED' || state === 'UNREADABLE';

/** May a swap through this DEX be signed? Only when the code was actually read and matched, or there is nothing to match. */
export const canSign = (state: DexCodeState): boolean => state === 'VERIFIED' || state === 'UNPINNED';

/**
 * Compare the code behind each DEX's factory and router with the pinned hashes. One batched read per call; a failure to
 * read is reported as UNREADABLE for that DEX only, never thrown.
 */
export async function verifyDexCode(
    dexes: DexId[] = AMM_DEX_IDS,
    opts: { batch?: BatchFn } = {}
): Promise<Record<DexId, DexCodeReport>> {
    const batch = opts.batch ?? createBatch();
    const out = {} as Record<DexId, DexCodeReport>;
    const todo: { id: DexId; factory: string; router: string; pin: { factory: string; router: string } }[] = [];

    for (const id of dexes) {
        const dex = DEXES[id];
        if (!isDexLive(id) || !dex.factory || !dex.router) {
            out[id] = { dex: id, state: 'NOT_DEPLOYED', detail: `${dex.label} is not deployed yet.` };
        } else if (!dex.codeHash) {
            out[id] = { dex: id, state: 'UNPINNED', detail: `${dex.label} has no code hash on record; it is checked when it is deployed.` };
        } else {
            todo.push({ id, factory: dex.factory, router: dex.router, pin: dex.codeHash });
        }
    }
    if (!todo.length) return out;

    const calls = todo.flatMap(t => [
        { method: 'quai_getCode', params: [checksumAddress(t.factory), 'latest'] },
        { method: 'quai_getCode', params: [checksumAddress(t.router), 'latest'] }
    ]);
    let results: Awaited<ReturnType<BatchFn>>;
    try {
        results = await batch(calls);
    } catch (e: any) {
        results = calls.map(() => ({ ok: false as const, error: e?.message ?? 'request failed' }));
    }

    todo.forEach((t, i) => {
        const label = DEXES[t.id].label;
        const [f, r] = [results[i * 2], results[i * 2 + 1]];
        if (!f?.ok || !r?.ok || typeof f.value !== 'string' || typeof r.value !== 'string') {
            out[t.id] = { dex: t.id, state: 'UNREADABLE', detail: `${label}: the network did not return its contract code, so it could not be checked.` };
            return;
        }
        let fh: string;
        let rh: string;
        try {
            // An empty reply ("0x") is a real answer: there is no contract at that address.
            fh = f.value === '0x' ? '' : keccak256Hex(f.value);
            rh = r.value === '0x' ? '' : keccak256Hex(r.value);
        } catch {
            out[t.id] = { dex: t.id, state: 'UNREADABLE', detail: `${label}: the contract code came back malformed, so it could not be checked.` };
            return;
        }
        if (fh && rh && same(fh, t.pin.factory) && same(rh, t.pin.router)) {
            out[t.id] = { dex: t.id, state: 'VERIFIED', detail: `${label} matches the contract code this app expects.` };
        } else {
            const which = !fh || !same(fh, t.pin.factory) ? 'pool factory' : 'swap router';
            out[t.id] = { dex: t.id, state: 'MISMATCH', detail: `${label} is switched off: its ${which} is not the contract this app was written for.` };
        }
    });
    return out;
}
