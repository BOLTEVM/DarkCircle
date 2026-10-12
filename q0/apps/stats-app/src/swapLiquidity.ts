// Everything the swap screen needs to know about liquidity, read in one go and with no React in it:
// every pool on every DEX factory (Quaiswap, Quainance, both Quainance launch AMMs, Circleswap), the tokens found in them,
// whether each DEX's contracts are still the ones this app was written for, and the current gas price.
//
// The pure parts (making an untrusted factory list safe to route over, ranking routes) live in quai-service so they are
// tested on fixtures; this file only does the reading.

import {
  AMM_DEX_IDS,
  POOL_REGISTRY,
  SELECTORS,
  buildAggregate,
  canQuote,
  createBatch,
  loadPairSnapshots,
  mergePools,
  verifyDexCode,
  type BatchFn,
  type DexCodeReport,
  type DexId,
  type LPReserves,
  type PairSnapshot,
  type PoolInfo,
  type TokenInfo
} from 'quai-service';

export interface SwapLiquidity {
  /** Every pool that can be routed through (curated first), registry keys for its tokens. */
  pools: PoolInfo[];
  /** Live reserves keyed by lower-cased pair address. */
  reserves: Record<string, LPReserves>;
  /** Tokens found in pools that are not curated, deepest first (already in TOKEN_REGISTRY). */
  tokens: TokenInfo[];
  /** Every pair the factories reported, for the Quainance list. */
  snapshots: PairSnapshot[];
  /** Pairs each factory reports, so a partial read can be told from a small DEX. */
  totals: Partial<Record<DexId, number>>;
  /** Whether each DEX's factory and router are the contracts this app pins. */
  dexState: Record<DexId, DexCodeReport>;
  /** Wei of QUAI per unit of gas, or null when the node would not say. */
  gasPriceWei: bigint | null;
  /** Pairs left out because a token could not be read, was empty, or was past the cap. */
  skippedPools: number;
  /** Plain-language notes about anything that could not be read. */
  errors: string[];
  block: number;
}

const word = (hex: string) => hex.replace('0x', '').toLowerCase().padStart(64, '0');

/** Reserves for registry pools the factory read did not return (a failed read must not blank the curated pools). */
async function readRegistryPools(missing: PoolInfo[], batch: BatchFn): Promise<Record<string, LPReserves>> {
  const out: Record<string, LPReserves> = {};
  if (!missing.length) return out;
  const calls = missing.flatMap(p => [SELECTORS.token0, SELECTORS.token1, SELECTORS.getReserves].map(data => ({ method: 'quai_call', params: [{ to: p.pair, data }, 'latest'] })));
  const res = await batch(calls);
  missing.forEach((p, i) => {
    const [t0, t1, r] = res.slice(i * 3, i * 3 + 3);
    if (!t0.ok || !t1.ok || !r.ok || typeof t0.value !== 'string' || typeof t1.value !== 'string' || typeof r.value !== 'string' || r.value.length < 130) return;
    const body = r.value.slice(2);
    out[p.pair.toLowerCase()] = {
      token0: '0x' + t0.value.slice(-40),
      token1: '0x' + t1.value.slice(-40),
      reserve0: BigInt('0x' + body.slice(0, 64)).toString(),
      reserve1: BigInt('0x' + body.slice(64, 128)).toString(),
      blockTime: 0
    };
  });
  return out;
}

export async function loadSwapLiquidity(batch: BatchFn = createBatch()): Promise<SwapLiquidity> {
  const [snap, dexState, gas] = await Promise.all([
    loadPairSnapshots(AMM_DEX_IDS, { maxPerDex: 1000, batch }),
    verifyDexCode(AMM_DEX_IDS, { batch }),
    batch([{ method: 'quai_gasPrice', params: [] }]).then(r => r[0]).catch(() => null)
  ]);

  const agg = buildAggregate(snap.pairs);
  const errors = [...snap.errors];
  // A DEX whose contracts are not the pinned ones is switched off: its pools take no part in any route.
  const off = new Set<DexId>(AMM_DEX_IDS.filter(id => !canQuote(dexState[id].state) && dexState[id].state !== 'NOT_DEPLOYED'));
  for (const id of off) errors.push(dexState[id].detail);

  const pools = mergePools(POOL_REGISTRY, agg.pools).filter(p => !off.has(p.dex));
  const reserves: Record<string, LPReserves> = {};
  for (const p of pools) {
    const r = agg.reserves[p.pair.toLowerCase()];
    if (r) reserves[p.pair.toLowerCase()] = r;
  }
  const missing = pools.filter(p => !reserves[p.pair.toLowerCase()] && POOL_REGISTRY.some(r => r.pair.toLowerCase() === p.pair.toLowerCase()));
  Object.assign(reserves, await readRegistryPools(missing, batch));

  let gasPriceWei: bigint | null = null;
  if (gas && gas.ok && typeof gas.value === 'string') {
    try {
      const v = BigInt(gas.value);
      if (v > 0n && v < 10n ** 18n) gasPriceWei = v;
    } catch {
      gasPriceWei = null;
    }
  }

  return {
    pools,
    reserves,
    tokens: agg.tokens,
    snapshots: snap.pairs,
    totals: snap.totals,
    dexState,
    gasPriceWei,
    skippedPools: agg.skipped.decimals + agg.skipped.overCap,
    errors,
    block: snap.block
  };
}

/** Token balances and LP balances for a wallet in a handful of batched requests instead of one request each. */
export async function loadBalances(
  address: string,
  tokens: TokenInfo[],
  pairs: string[],
  batch: BatchFn = createBatch()
): Promise<{ raw: Record<string, string>; lp: Record<string, string> }> {
  const holder = word(address);
  const calls = [
    ...tokens.map(t =>
      t.isNative
        ? { method: 'quai_getBalance', params: [address, 'latest'] }
        : { method: 'quai_call', params: [{ to: t.address, data: SELECTORS.balanceOf + holder }, 'latest'] }
    ),
    ...pairs.map(pair => ({ method: 'quai_call', params: [{ to: pair, data: SELECTORS.balanceOf + holder }, 'latest'] }))
  ];
  const res = await batch(calls);
  const raw: Record<string, string> = {};
  const lp: Record<string, string> = {};
  const value = (r: (typeof res)[number]): string | null => {
    if (!r.ok || typeof r.value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(r.value)) return null;
    try {
      return BigInt(r.value === '0x' ? '0x0' : r.value).toString();
    } catch {
      return null;
    }
  };
  tokens.forEach((t, i) => {
    const v = value(res[i]);
    // A failed read stays unset (shown as a dash) rather than being shown as zero.
    if (v !== null) raw[t.symbol] = v;
  });
  pairs.forEach((pair, i) => {
    const v = value(res[tokens.length + i]);
    if (v !== null) lp[pair.toLowerCase()] = v;
  });
  return { raw, lp };
}
