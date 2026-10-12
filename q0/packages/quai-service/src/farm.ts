// CircleswapMasterChef: reading it, encoding calls to it, and checking admin changes before they are sent.
//
// This is the one place that knows the farm's ABI on the client side. The Farms page, the admin dashboard and the
// CLI inspector all use it, so what the page shows and what the tools report cannot drift apart.
//
// What the contract is (contracts/CircleswapMasterChef.sol), because the UI has to be honest about it:
//  * NOT upgradeable: a plain constructor contract, reward tokens and the boost source are immutable.
//  * Expandable by its owner only: addPool / setPool / setEmissionRates / pause. There is no removePool, and addPool
//    has no duplicate guard and no cap on the number of pools (massUpdatePools loops over all of them).
//  * It pays rewards only from inventory above what users have staked, never from principal.
//
// No value imports on purpose, so this loads in plain Node for tests. Reads take a `batch` function.

/** Run read-only calls; one entry per call, undefined when that call failed. */
export type FarmBatch = (calls: { to: string; data: string }[]) => Promise<(string | undefined)[]>;

export const FARM_SELECTORS = {
  owner: '0x8da5cb5b',
  pendingOwner: '0xe30c3978',
  paused: '0x5c975abb',
  rewardTokenA: '0x6b8ba92c',
  rewardTokenB: '0xaa7b83e3',
  qrb: '0xa9fbcf74',
  rewardAPerSecond: '0x95fb75d3',
  rewardBPerSecond: '0x466f1899',
  totalAllocPoint: '0x17caf6f1',
  poolLength: '0x081e3eda',
  poolInfo: '0x1526fe27',
  userInfo: '0x93f1a40b',
  pendingRewards: '0xd18df53c',
  stakedByToken: '0x87a7bfa4',
  MAX_ALLOC_POINT: '0xf958d1f9',
  MAX_EMISSION_PER_SECOND: '0x7d8bf6ec',
  MAX_BOOST_BPS: '0x3d9a581a',
  deposit: '0xe2bbb158',
  withdraw: '0x441a3e70',
  harvest: '0xddc63262',
  emergencyWithdraw: '0x5312ea8e',
  addPool: '0x33ba8882',
  setPool: '0x46430af1',
  setEmissionRates: '0xade621ee',
  pause: '0x8456cb59',
  unpause: '0x3f4ba83a',
  transferOwnership: '0xf2fde38b',
  acceptOwnership: '0x79ba5097',
  renounceOwnership: '0x715018a6',
  massUpdatePools: '0x630b5ba1',
  updatePool: '0x51eb05a6'
} as const;

export const TOKEN_SELECTORS = {
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
  approve: '0x095ea7b3',
  transfer: '0xa9059cbb',
  totalSupply: '0x18160ddd',
  symbol: '0x95d89b41',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  getReserves: '0x0902f1ac'
} as const;

/** The boost source's own function: how much it actually grants (the farm's MAX_BOOST_BPS is only a clamp). */
export const QRB_SELECTORS = { BOOST_BPS: '0x52ae311e' } as const;

/** Above this many pools every pool update walks the whole list; warn the owner. */
export const POOL_COUNT_WARN = 25;
/** Far beyond what one transaction can sensibly update: refuse to add more from the dashboard. */
export const POOL_COUNT_MAX = 150;
export const SECONDS_PER_DAY = 86_400;
export const SECONDS_PER_YEAR = 31_536_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const U256 = (1n << 256n) - 1n;

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------

function word(value: bigint | number): string {
  const v = BigInt(value);
  if (v < 0n || v > U256) throw new Error('Value does not fit in 256 bits');
  return v.toString(16).padStart(64, '0');
}

function addressWord(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Not an address: ${address}`);
  return address.slice(2).toLowerCase().padStart(64, '0');
}

/** Calldata for every farm function the UI sends. Pure: nothing here sends anything. */
export const farmTx = {
  deposit: (pid: number, amount: bigint) => FARM_SELECTORS.deposit + word(pid) + word(amount),
  withdraw: (pid: number, amount: bigint) => FARM_SELECTORS.withdraw + word(pid) + word(amount),
  harvest: (pid: number) => FARM_SELECTORS.harvest + word(pid),
  emergencyWithdraw: (pid: number) => FARM_SELECTORS.emergencyWithdraw + word(pid),
  addPool: (allocPoint: bigint, lpToken: string) => FARM_SELECTORS.addPool + word(allocPoint) + addressWord(lpToken),
  setPool: (pid: number, allocPoint: bigint) => FARM_SELECTORS.setPool + word(pid) + word(allocPoint),
  setEmissionRates: (a: bigint, b: bigint) => FARM_SELECTORS.setEmissionRates + word(a) + word(b),
  pause: () => FARM_SELECTORS.pause,
  unpause: () => FARM_SELECTORS.unpause,
  transferOwnership: (to: string) => FARM_SELECTORS.transferOwnership + addressWord(to),
  acceptOwnership: () => FARM_SELECTORS.acceptOwnership,
  massUpdatePools: () => FARM_SELECTORS.massUpdatePools
};

export const erc20Tx = {
  approve: (spender: string, amount: bigint) => TOKEN_SELECTORS.approve + addressWord(spender) + word(amount),
  transfer: (to: string, amount: bigint) => TOKEN_SELECTORS.transfer + addressWord(to) + word(amount)
};

// ---------------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------------

function words(hex: string | undefined): string[] | undefined {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{64})+$/.test(hex)) return undefined;
  const body = hex.slice(2);
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 64) out.push(body.slice(i, i + 64));
  return out;
}
const uintOf = (w: string | undefined): bigint | undefined => (w === undefined ? undefined : BigInt('0x' + w));
const addressOf = (w: string | undefined): string | undefined => {
  if (w === undefined || !/^0{24}[0-9a-fA-F]{40}$/.test(w)) return undefined;
  return '0x' + w.slice(24);
};
const first = (hex: string | undefined) => words(hex)?.[0];

const callData = (selector: string, ...args: string[]) => selector + args.join('');

// ---------------------------------------------------------------------------------------------
// Farm state
// ---------------------------------------------------------------------------------------------

export interface FarmPoolState {
  pid: number;
  /** Lower-case address of the staked token (an LP token, or a single asset). */
  lpToken: string;
  allocPoint: bigint;
  lastRewardTime: bigint;
  accRewardAPerShare: bigint;
  accRewardBPerShare: bigint;
  totalStaked: bigint;
  /** This pool's share of emissions, 0..100. */
  sharePct: number;
}

export interface RewardInventory {
  token: string;
  /** Everything the farm holds of this token. */
  balance: bigint;
  /** Staked by users (principal, never paid out as reward). */
  staked: bigint;
  /** balance - staked: what can be paid as reward. */
  available: bigint;
}

export interface FarmState {
  address: string;
  owner: string;
  pendingOwner: string | null;
  paused: boolean;
  rewardTokenA: string;
  rewardTokenB: string;
  /** The boost source, or null for a farm with no boost. */
  qrb: string | null;
  rewardAPerSecond: bigint;
  rewardBPerSecond: bigint;
  totalAllocPoint: bigint;
  maxAllocPoint: bigint;
  maxEmissionPerSecond: bigint;
  /** The farm's clamp on any boost (a contract constant, usually far above what the boost source grants). */
  maxBoostBps: bigint;
  /**
   * The largest boost a wallet can actually receive: the boost source's own BOOST_BPS, never above `maxBoostBps`; 0 when
   * the farm has no boost source. Use this, not `maxBoostBps`, for runway and "up to" APR.
   */
  boostBps: bigint;
  pools: FarmPoolState[];
  inventoryA: RewardInventory;
  inventoryB: RewardInventory;
  readAt: number;
}

export class FarmReadError extends Error {
  // An explicit field, not a constructor parameter property: Node's type stripping (used by the unit tests) refuses those.
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`The farm could not be read completely (${missing.join(', ')}). Nothing is shown from a partial read.`);
    this.name = 'FarmReadError';
    this.missing = missing;
  }
}

/**
 * Read the whole farm in three round trips. Throws FarmReadError when anything essential is unreadable: a farm
 * page that shows some of the numbers is worse than one that says it could not read them.
 */
export async function readFarmState(batch: FarmBatch, farm: string, now: () => number = Date.now): Promise<FarmState> {
  const scalarNames = [
    'owner', 'pendingOwner', 'paused', 'rewardTokenA', 'rewardTokenB', 'qrb', 'rewardAPerSecond', 'rewardBPerSecond',
    'totalAllocPoint', 'poolLength', 'MAX_ALLOC_POINT', 'MAX_EMISSION_PER_SECOND', 'MAX_BOOST_BPS'
  ] as const;
  const raw = await batch(scalarNames.map(n => ({ to: farm, data: FARM_SELECTORS[n] })));
  const v = Object.fromEntries(scalarNames.map((n, i) => [n, first(raw[i])])) as Record<(typeof scalarNames)[number], string | undefined>;

  const owner = addressOf(v.owner);
  const pendingOwner = addressOf(v.pendingOwner);
  const rewardTokenA = addressOf(v.rewardTokenA);
  const rewardTokenB = addressOf(v.rewardTokenB);
  const qrb = addressOf(v.qrb);
  const rewardAPerSecond = uintOf(v.rewardAPerSecond);
  const rewardBPerSecond = uintOf(v.rewardBPerSecond);
  const totalAllocPoint = uintOf(v.totalAllocPoint);
  const poolLength = uintOf(v.poolLength);
  const maxAllocPoint = uintOf(v.MAX_ALLOC_POINT);
  const maxEmissionPerSecond = uintOf(v.MAX_EMISSION_PER_SECOND);
  const maxBoostBps = uintOf(v.MAX_BOOST_BPS);
  const paused = uintOf(v.paused);

  const missing: string[] = [];
  if (!owner) missing.push('owner');
  if (pendingOwner === undefined) missing.push('pendingOwner');
  if (!rewardTokenA) missing.push('rewardTokenA');
  if (!rewardTokenB) missing.push('rewardTokenB');
  if (qrb === undefined) missing.push('qrb');
  if (rewardAPerSecond === undefined) missing.push('rewardAPerSecond');
  if (rewardBPerSecond === undefined) missing.push('rewardBPerSecond');
  if (totalAllocPoint === undefined) missing.push('totalAllocPoint');
  if (poolLength === undefined) missing.push('poolLength');
  if (paused === undefined) missing.push('paused');
  if (maxAllocPoint === undefined) missing.push('MAX_ALLOC_POINT');
  if (maxEmissionPerSecond === undefined) missing.push('MAX_EMISSION_PER_SECOND');
  if (maxBoostBps === undefined) missing.push('MAX_BOOST_BPS');
  if (missing.length) throw new FarmReadError(missing);
  if (poolLength! > 5000n) throw new FarmReadError(['poolLength (implausible: ' + poolLength + ')']);

  const count = Number(poolLength);
  const second = await batch([
    ...Array.from({ length: count }, (_, i) => ({ to: farm, data: callData(FARM_SELECTORS.poolInfo, word(i)) })),
    { to: rewardTokenA!, data: callData(TOKEN_SELECTORS.balanceOf, addressWord(farm)) },
    { to: rewardTokenB!, data: callData(TOKEN_SELECTORS.balanceOf, addressWord(farm)) },
    { to: farm, data: callData(FARM_SELECTORS.stakedByToken, addressWord(rewardTokenA!)) },
    { to: farm, data: callData(FARM_SELECTORS.stakedByToken, addressWord(rewardTokenB!)) },
    ...(qrb && qrb !== ZERO_ADDRESS ? [{ to: qrb, data: QRB_SELECTORS.BOOST_BPS }] : [])
  ]);

  const pools: FarmPoolState[] = [];
  const poolMissing: string[] = [];
  for (let i = 0; i < count; i++) {
    const w = words(second[i]);
    const lp = addressOf(w?.[0]);
    if (!w || w.length < 6 || !lp) { poolMissing.push(`poolInfo(${i})`); continue; }
    const alloc = uintOf(w[1])!;
    pools.push({
      pid: i,
      lpToken: lp.toLowerCase(),
      allocPoint: alloc,
      lastRewardTime: uintOf(w[2])!,
      accRewardAPerShare: uintOf(w[3])!,
      accRewardBPerShare: uintOf(w[4])!,
      totalStaked: uintOf(w[5])!,
      sharePct: totalAllocPoint! === 0n ? 0 : Number((alloc * 1_000_000n) / totalAllocPoint!) / 10_000
    });
  }
  const balA = uintOf(first(second[count]));
  const balB = uintOf(first(second[count + 1]));
  const stkA = uintOf(first(second[count + 2]));
  const stkB = uintOf(first(second[count + 3]));
  if (balA === undefined) poolMissing.push('reward A balance');
  if (balB === undefined) poolMissing.push('reward B balance');
  if (stkA === undefined) poolMissing.push('reward A staked');
  if (stkB === undefined) poolMissing.push('reward B staked');
  const hasBoostSource = Boolean(qrb && qrb !== ZERO_ADDRESS);
  const sourceBps = hasBoostSource ? uintOf(first(second[count + 4])) : 0n;
  if (hasBoostSource && sourceBps === undefined) poolMissing.push('boost source BOOST_BPS');
  if (poolMissing.length) throw new FarmReadError(poolMissing);

  const inv = (token: string, balance: bigint, staked: bigint): RewardInventory => ({
    token, balance, staked, available: balance > staked ? balance - staked : 0n
  });

  return {
    address: farm,
    owner: owner!,
    pendingOwner: pendingOwner === ZERO_ADDRESS ? null : pendingOwner!,
    paused: paused !== 0n,
    rewardTokenA: rewardTokenA!,
    rewardTokenB: rewardTokenB!,
    qrb: qrb === ZERO_ADDRESS ? null : qrb!,
    rewardAPerSecond: rewardAPerSecond!,
    rewardBPerSecond: rewardBPerSecond!,
    totalAllocPoint: totalAllocPoint!,
    maxAllocPoint: maxAllocPoint!,
    maxEmissionPerSecond: maxEmissionPerSecond!,
    maxBoostBps: maxBoostBps!,
    boostBps: sourceBps! > maxBoostBps! ? maxBoostBps! : sourceBps!,
    pools,
    inventoryA: inv(rewardTokenA!, balA!, stkA!),
    inventoryB: inv(rewardTokenB!, balB!, stkB!),
    readAt: now()
  };
}

export interface FarmPosition {
  pid: number;
  /** Staked in the farm. */
  staked: bigint;
  /** Earned and claimable now, boost and anything left unpaid by a shortfall included. */
  pendingA: bigint;
  pendingB: bigint;
  /** Owed from an earlier shortfall (already part of pending). */
  unpaidA: bigint;
  unpaidB: bigint;
  /** In the wallet, not staked. */
  walletBalance: bigint;
  /** How much the farm may pull from the wallet. */
  allowance: bigint;
}

/** One round trip for a wallet's position in every pool. A pool whose reads fail is omitted, never zeroed. */
export async function readUserPositions(batch: FarmBatch, farm: FarmState, user: string): Promise<FarmPosition[]> {
  const per = 4;
  const calls = farm.pools.flatMap(pool => [
    { to: farm.address, data: callData(FARM_SELECTORS.userInfo, word(pool.pid), addressWord(user)) },
    { to: farm.address, data: callData(FARM_SELECTORS.pendingRewards, word(pool.pid), addressWord(user)) },
    { to: pool.lpToken, data: callData(TOKEN_SELECTORS.balanceOf, addressWord(user)) },
    { to: pool.lpToken, data: callData(TOKEN_SELECTORS.allowance, addressWord(user), addressWord(farm.address)) }
  ]);
  if (calls.length === 0) return [];
  const raw = await batch(calls);
  const out: FarmPosition[] = [];
  farm.pools.forEach((pool, i) => {
    const info = words(raw[i * per]);
    const pend = words(raw[i * per + 1]);
    const bal = uintOf(first(raw[i * per + 2]));
    const allow = uintOf(first(raw[i * per + 3]));
    if (!info || info.length < 5 || !pend || pend.length < 2 || bal === undefined || allow === undefined) return;
    out.push({
      pid: pool.pid,
      staked: uintOf(info[0])!,
      unpaidA: uintOf(info[3])!,
      unpaidB: uintOf(info[4])!,
      pendingA: uintOf(pend[0])!,
      pendingB: uintOf(pend[1])!,
      walletBalance: bal,
      allowance: allow
    });
  });
  return out;
}

/**
 * What a wallet holds of each token (one round trip), for the tokens a page wants to show a balance for even though
 * the farm has no pool for them. A token whose read fails is omitted, never zeroed.
 */
export async function readWalletBalances(batch: FarmBatch, tokens: readonly string[], user: string): Promise<Record<string, bigint>> {
  const unique = [...new Set(tokens.map(t => t.toLowerCase()))];
  if (unique.length === 0) return {};
  const raw = await batch(unique.map(t => ({ to: t, data: callData(TOKEN_SELECTORS.balanceOf, addressWord(user)) })));
  const out: Record<string, bigint> = {};
  unique.forEach((t, i) => {
    const v = uintOf(first(raw[i]));
    if (v !== undefined) out[t] = v;
  });
  return out;
}

export interface PairInfo {
  lpToken: string;
  /** Present only for a two-token LP. A single-asset pool has neither. */
  token0?: string;
  token1?: string;
  reserve0?: bigint;
  reserve1?: bigint;
  totalSupply?: bigint;
}

/** token0/token1/reserves/supply for a set of staked tokens; single assets simply come back without tokens. */
export async function readPairs(batch: FarmBatch, lpTokens: string[]): Promise<Record<string, PairInfo>> {
  const unique = [...new Set(lpTokens.map(a => a.toLowerCase()))];
  const per = 4;
  const raw = unique.length
    ? await batch(unique.flatMap(lp => [
        { to: lp, data: TOKEN_SELECTORS.token0 },
        { to: lp, data: TOKEN_SELECTORS.token1 },
        { to: lp, data: TOKEN_SELECTORS.getReserves },
        { to: lp, data: TOKEN_SELECTORS.totalSupply }
      ]))
    : [];
  const out: Record<string, PairInfo> = {};
  unique.forEach((lp, i) => {
    const t0 = addressOf(first(raw[i * per]));
    const t1 = addressOf(first(raw[i * per + 1]));
    const res = words(raw[i * per + 2]);
    const supply = uintOf(first(raw[i * per + 3]));
    const isPair = Boolean(t0 && t1 && res && res.length >= 2);
    out[lp] = isPair
      ? { lpToken: lp, token0: t0!.toLowerCase(), token1: t1!.toLowerCase(), reserve0: uintOf(res![0]), reserve1: uintOf(res![1]), totalSupply: supply }
      : { lpToken: lp, totalSupply: supply };
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Analytics (display maths; none of it is sent anywhere)
// ---------------------------------------------------------------------------------------------

const toNumber = (value: bigint, decimals: number): number => Number(value) / 10 ** decimals;

/** Seconds the available inventory lasts at the current rate, including the largest boost; null = never runs out. */
export function runwaySeconds(available: bigint, ratePerSecond: bigint, boostBps: bigint = 0n): number | null {
  if (ratePerSecond === 0n) return null;
  const burn = ratePerSecond + (ratePerSecond * boostBps) / 10_000n;
  return Number(available / burn);
}

export interface AprInput {
  ratePerSecondA: bigint;
  ratePerSecondB: bigint;
  decimalsA: number;
  decimalsB: number;
  priceUsdA?: number;
  priceUsdB?: number;
  /** 0..100 */
  sharePct: number;
  tvlUsd?: number;
}

/**
 * Reward APR for one pool, in percent. Undefined when it cannot be known: a missing price or an empty pool is
 * "unknown", never 0% and never infinite.
 */
export function poolApr(i: AprInput): { aprA?: number; aprB?: number; total?: number } {
  if (!i.tvlUsd || i.tvlUsd <= 0) return {};
  const yearly = (rate: bigint, decimals: number, price?: number) =>
    price === undefined ? undefined : toNumber(rate, decimals) * SECONDS_PER_YEAR * (i.sharePct / 100) * price;
  const a = yearly(i.ratePerSecondA, i.decimalsA, i.priceUsdA);
  const b = yearly(i.ratePerSecondB, i.decimalsB, i.priceUsdB);
  const aprA = a === undefined ? undefined : (a / i.tvlUsd) * 100;
  const aprB = b === undefined ? undefined : (b / i.tvlUsd) * 100;
  const total = aprA === undefined && aprB === undefined ? undefined : (aprA ?? 0) + (aprB ?? 0);
  return { aprA, aprB, total };
}

/** Value in USD of `amount` LP tokens of a two-token pair, from reserves and token prices; undefined if unknowable. */
export function lpValueUsd(
  amount: bigint,
  pair: PairInfo,
  priceUsd: { token0?: number; token1?: number },
  decimals: { token0: number; token1: number }
): number | undefined {
  if (!pair.totalSupply || pair.totalSupply === 0n || pair.reserve0 === undefined || pair.reserve1 === undefined) return undefined;
  const side0 = priceUsd.token0 === undefined ? undefined : toNumber(pair.reserve0, decimals.token0) * priceUsd.token0;
  const side1 = priceUsd.token1 === undefined ? undefined : toNumber(pair.reserve1, decimals.token1) * priceUsd.token1;
  // A balanced pool is worth twice either side; with one known price that is the best honest estimate.
  const total = side0 !== undefined && side1 !== undefined ? side0 + side1 : side0 !== undefined ? side0 * 2 : side1 !== undefined ? side1 * 2 : undefined;
  if (total === undefined) return undefined;
  return total * (Number(amount) / Number(pair.totalSupply));
}

// ---------------------------------------------------------------------------------------------
// Admin checks: run these BEFORE the owner is asked to sign anything
// ---------------------------------------------------------------------------------------------

export interface Check {
  level: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}
export const hasErrors = (checks: Check[]) => checks.some(c => c.level === 'error');

export interface AddPoolInput {
  lpToken: string;
  allocPoint: bigint;
  farm: FarmState;
  /** Is there contract code at lpToken? */
  isContract: boolean;
  /** From readPairs(); undefined when it could not be read. */
  pair?: PairInfo;
  /** True when the AMM factory itself reports this address as one of its pools. */
  isFactoryPool?: boolean;
}

export function checkAddPool(i: AddPoolInput): Check[] {
  const out: Check[] = [];
  const lp = i.lpToken.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(lp)) {
    out.push({ level: 'error', code: 'NOT_AN_ADDRESS', message: 'That is not a contract address.' });
    return out;
  }
  if (lp.toLowerCase() === ZERO_ADDRESS) out.push({ level: 'error', code: 'ZERO_ADDRESS', message: 'The zero address cannot be staked.' });
  if (!/^0x00/i.test(lp)) out.push({ level: 'error', code: 'NOT_CYPRUS1', message: 'Cyprus-1 contract addresses begin with 0x00; this one is on another shard and cannot be staked here.' });
  if (!i.isContract) out.push({ level: 'error', code: 'NOT_A_CONTRACT', message: 'There is no contract at this address, so there is nothing to stake. Check the address.' });

  const existing = i.farm.pools.find(p => p.lpToken === lp.toLowerCase());
  if (existing) {
    out.push({
      level: 'error',
      code: 'DUPLICATE',
      message: `This token is already pool #${existing.pid}. A second pool for the same token would split its rewards between two pools and make both harder to reason about; change pool #${existing.pid}'s allocation instead.`
    });
  }

  if (i.allocPoint > i.farm.maxAllocPoint) {
    out.push({ level: 'error', code: 'ALLOC_TOO_HIGH', message: `Allocation is above the contract's maximum (${i.farm.maxAllocPoint}).` });
  }
  if (i.allocPoint === 0n) {
    out.push({ level: 'warning', code: 'ALLOC_ZERO', message: 'With 0 allocation this pool earns nothing until its allocation is raised. It can still be created.' });
  }

  if (i.farm.pools.length >= POOL_COUNT_MAX) {
    out.push({ level: 'error', code: 'TOO_MANY_POOLS', message: `The farm already has ${i.farm.pools.length} pools. Every pool update walks the whole list, and pools cannot be removed; adding more risks making deposits too expensive for everyone.` });
  } else if (i.farm.pools.length >= POOL_COUNT_WARN) {
    out.push({ level: 'warning', code: 'MANY_POOLS', message: `The farm has ${i.farm.pools.length} pools. Pools cannot be removed and every change updates all of them, so each new pool makes every future deposit and harvest slightly more expensive.` });
  }

  if (i.pair && i.pair.token0 && i.pair.token1) {
    if (i.isFactoryPool === false) {
      out.push({ level: 'warning', code: 'NOT_A_CIRCLESWAP_POOL', message: 'This is a two-token LP token, but the Circleswap factory does not list it. It may belong to another DEX. That is allowed; make sure it is the pool you mean.' });
    } else if (i.isFactoryPool === true) {
      out.push({ level: 'info', code: 'CIRCLESWAP_POOL', message: 'The Circleswap factory lists this as one of its pools.' });
    }
    if (!i.pair.totalSupply || i.pair.totalSupply === 0n) {
      out.push({ level: 'warning', code: 'EMPTY_PAIR', message: 'This pool has no liquidity yet, so it has no value to reward and nothing to stake.' });
    }
  } else if (i.isContract) {
    out.push({ level: 'info', code: 'SINGLE_ASSET', message: 'This does not look like a two-token LP token, so it will be a single-asset staking pool.' });
  }

  const rewardTokens = [i.farm.rewardTokenA.toLowerCase(), i.farm.rewardTokenB.toLowerCase()];
  if (rewardTokens.includes(lp.toLowerCase())) {
    out.push({ level: 'info', code: 'STAKES_REWARD_TOKEN', message: 'This pool stakes a reward token. That is supported: rewards are only ever paid from the balance above what users have staked.' });
  }

  // A Circleswap LP token is the pair's own standard ERC-20 and never takes a fee on transfer, so the warning only means
  // something for a token the factory did not make: a single asset, or another DEX's LP.
  if (!(i.pair?.token0 && i.isFactoryPool === true)) {
    out.push({
      level: 'warning',
      code: 'NO_FEE_ON_TRANSFER',
      message: 'Fee-on-transfer and rebasing tokens are not supported: deposits are credited at face value, so a token that takes a fee would leave the farm short. The contract cannot check this; confirm it for the token.'
    });
  }
  return out;
}

export interface EmissionInput {
  rateA: bigint;
  rateB: bigint;
  farm: FarmState;
}

export function checkEmission(i: EmissionInput): Check[] {
  const out: Check[] = [];
  if (i.rateA > i.farm.maxEmissionPerSecond || i.rateB > i.farm.maxEmissionPerSecond) {
    out.push({ level: 'error', code: 'ABOVE_MAX', message: 'A rate is above the contract maximum; the transaction would revert.' });
  }
  const bigger = (next: bigint, prev: bigint) => prev > 0n && next > prev * 10n;
  if (bigger(i.rateA, i.farm.rewardAPerSecond) || bigger(i.rateB, i.farm.rewardBPerSecond)) {
    out.push({ level: 'warning', code: 'TEN_X', message: 'This raises a rate more than 10x. Check the units: rates are wei of the reward token per second (1e18 = one whole token per second).' });
  }
  if (i.rateA === 0n && i.rateB === 0n) {
    out.push({ level: 'warning', code: 'ZERO_EMISSION', message: 'Both rates are 0: farmers stop earning. Staked tokens stay withdrawable.' });
  }
  const boost = i.farm.boostBps;
  const runA = runwaySeconds(i.farm.inventoryA.available, i.rateA, boost);
  const runB = runwaySeconds(i.farm.inventoryB.available, i.rateB, boost);
  const short = (s: number | null) => s !== null && s < 7 * SECONDS_PER_DAY;
  if (short(runA) || short(runB)) {
    out.push({
      level: 'warning',
      code: 'SHORT_RUNWAY',
      message: 'At these rates the reward inventory lasts under 7 days (counting the largest boost). Fund the farm first, or farmers will be owed rewards the farm cannot pay yet.'
    });
  }
  return out;
}

export function checkSetPool(pid: number, allocPoint: bigint, farm: FarmState): Check[] {
  const out: Check[] = [];
  if (!farm.pools.some(p => p.pid === pid)) out.push({ level: 'error', code: 'NO_SUCH_POOL', message: `There is no pool #${pid}.` });
  if (allocPoint > farm.maxAllocPoint) out.push({ level: 'error', code: 'ALLOC_TOO_HIGH', message: `Allocation is above the contract's maximum (${farm.maxAllocPoint}).` });
  const pool = farm.pools.find(p => p.pid === pid);
  if (pool && allocPoint === 0n && pool.totalStaked > 0n) {
    out.push({ level: 'warning', code: 'STOPS_REWARDS', message: 'Setting 0 stops this pool earning while it still has stakers. Their stake stays withdrawable.' });
  }
  const others = farm.totalAllocPoint - (pool?.allocPoint ?? 0n);
  if (pool && others === 0n && allocPoint === 0n && farm.pools.length > 0) {
    out.push({ level: 'info', code: 'NO_ALLOCATION', message: 'With every pool at 0 allocation nothing is emitted.' });
  }
  return out;
}

/** What each pool's share becomes if `pid` gets `allocPoint` (or, for a new pool, `pid` = null). */
export function sharesAfter(farm: FarmState, change: { pid: number | null; allocPoint: bigint }): { pid: number | null; sharePct: number }[] {
  const next = farm.pools.map(p => ({ pid: p.pid as number | null, alloc: p.pid === change.pid ? change.allocPoint : p.allocPoint }));
  if (change.pid === null) next.push({ pid: null, alloc: change.allocPoint });
  const total = next.reduce((s, p) => s + p.alloc, 0n);
  return next.map(p => ({ pid: p.pid, sharePct: total === 0n ? 0 : Number((p.alloc * 1_000_000n) / total) / 10_000 }));
}

/** The owner is "safe" only when it is a contract (multisig or timelock), not a single key. */
export function ownerRisk(isContract: boolean): Check {
  return isContract
    ? { level: 'info', code: 'OWNER_IS_CONTRACT', message: 'The owner is a contract (a multisig or timelock), so a single key cannot change the farm.' }
    : {
        level: 'warning',
        code: 'OWNER_IS_ACCOUNT',
        message: 'The owner is a single account. Whoever holds its key can add pools, change allocations, set emissions up to the contract maximum, and pause deposits and harvests. It can never take staked tokens. Moving ownership to a multisig or the timelock removes that single point of failure.'
      };
}

// ---------------------------------------------------------------------------------------------
// View model: everything the Farms page and the admin dashboard show, derived in one place
// ---------------------------------------------------------------------------------------------

/** What the page knows about one token: from the contract (symbol/decimals) and the explorer (price/logo). */
export interface FarmTokenInfo {
  symbol: string;
  decimals: number;
  priceUsd?: number;
  iconUrl?: string;
  /** Total supply in base units, read from the contract. Only used to size a single-token pool's "if everyone deposited". */
  totalSupply?: bigint;
}

export interface FarmRow {
  pid: number;
  lpToken: string;
  /** A two-token LP, or one staked asset. */
  kind: 'LP' | 'SINGLE';
  token0?: string;
  token1?: string;
  /** "BDELTA / WQUAI" or the single token's symbol; "Unknown token" when nothing could be read. */
  label: string;
  allocPoint: bigint;
  sharePct: number;
  totalStaked: bigint;
  /** Decimals of the staked token (18 for an LP). */
  stakeDecimals: number;
  /**
   * False for a single token whose decimals could not be read from its contract: `stakeDecimals` is then a placeholder
   * and no amount of that token may be parsed or shown with it.
   */
  stakeDecimalsKnown: boolean;
  /** Value of everything staked in this pool, USD; undefined when a price is missing. */
  tvlUsd?: number;
  /** Reward APR in percent from the current emission, before any Qrb boost. Undefined when it cannot be known. */
  aprA?: number;
  aprB?: number;
  aprTotal?: number;
  /** The largest APR a Qrb holder can reach (base * (1 + max boost)); undefined without a boost source or an APR. */
  aprMax?: number;
  /** Tokens this pool receives per day at the current emission and allocation. */
  dailyA: number;
  dailyB: number;
  position?: FarmPosition;
  /** USD value of the wallet's stake / of its claimable rewards; undefined when a price is missing. */
  stakedUsd?: number;
  pendingUsd?: number;
}

export interface FarmSummary {
  tvlUsd?: number;
  /** USD emitted per day across all pools; undefined when a reward price is unknown. */
  emissionUsdPerDay?: number;
  yourStakedUsd?: number;
  yourPendingUsd?: number;
  /** Claimable now, per reward token, in token units. */
  pendingA: number;
  pendingB: number;
  poolsWithStake: number;
}

export interface BuildRowsInput {
  farm: FarmState;
  /** From readPairs(); keyed by lower-case staked-token address. */
  pairs: Record<string, PairInfo>;
  /** Keyed by lower-case token address. */
  tokens: Record<string, FarmTokenInfo | undefined>;
  positions?: FarmPosition[];
}

const LP_DECIMALS = 18;

/** Rows for the page, in pool order. Anything that cannot be known is left undefined, never guessed as 0. */
export function buildFarmRows(i: BuildRowsInput): { rows: FarmRow[]; summary: FarmSummary } {
  const { farm } = i;
  const tok = (a?: string) => (a ? i.tokens[a.toLowerCase()] : undefined);
  const rewardA = tok(farm.rewardTokenA);
  const rewardB = tok(farm.rewardTokenB);
  const decA = rewardA?.decimals ?? LP_DECIMALS;
  const decB = rewardB?.decimals ?? LP_DECIMALS;
  const boostBps = farm.boostBps;

  const rows: FarmRow[] = farm.pools.map(pool => {
    const pair = i.pairs[pool.lpToken.toLowerCase()];
    const isLp = Boolean(pair?.token0 && pair?.token1);
    const t0 = isLp ? tok(pair!.token0) : undefined;
    const t1 = isLp ? tok(pair!.token1) : undefined;
    const single = !isLp ? tok(pool.lpToken) : undefined;
    const stakeDecimals = isLp ? LP_DECIMALS : single?.decimals ?? LP_DECIMALS;
    const stakeDecimalsKnown = isLp || single?.decimals !== undefined;

    const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '?');
    const label = isLp
      ? `${t0?.symbol ?? short(pair!.token0)} / ${t1?.symbol ?? short(pair!.token1)}`
      : single?.symbol ?? 'Unknown token';

    const stakeToUsd = (amount: bigint): number | undefined => {
      if (isLp) {
        return lpValueUsd(
          amount,
          pair!,
          { token0: t0?.priceUsd, token1: t1?.priceUsd },
          { token0: t0?.decimals ?? LP_DECIMALS, token1: t1?.decimals ?? LP_DECIMALS }
        );
      }
      return single?.priceUsd === undefined ? undefined : toNumber(amount, stakeDecimals) * single.priceUsd;
    };

    const tvlUsd = pool.totalStaked > 0n ? stakeToUsd(pool.totalStaked) : undefined;
    const apr = poolApr({
      ratePerSecondA: farm.rewardAPerSecond,
      ratePerSecondB: farm.rewardBPerSecond,
      decimalsA: decA,
      decimalsB: decB,
      priceUsdA: rewardA?.priceUsd,
      priceUsdB: rewardB?.priceUsd,
      sharePct: pool.sharePct,
      tvlUsd
    });
    const aprMax = apr.total === undefined || boostBps === 0n ? undefined : apr.total * (1 + Number(boostBps) / 10_000);

    const position = i.positions?.find(p => p.pid === pool.pid);
    let pendingUsd: number | undefined;
    if (position) {
      if (position.pendingA === 0n && position.pendingB === 0n) pendingUsd = 0;
      else {
        const aKnown = position.pendingA === 0n || rewardA?.priceUsd !== undefined;
        const bKnown = position.pendingB === 0n || rewardB?.priceUsd !== undefined;
        if (aKnown && bKnown) {
          pendingUsd = toNumber(position.pendingA, decA) * (rewardA?.priceUsd ?? 0) + toNumber(position.pendingB, decB) * (rewardB?.priceUsd ?? 0);
        }
      }
    }

    return {
      pid: pool.pid,
      lpToken: pool.lpToken,
      kind: isLp ? 'LP' : 'SINGLE',
      token0: pair?.token0,
      token1: pair?.token1,
      label,
      allocPoint: pool.allocPoint,
      sharePct: pool.sharePct,
      totalStaked: pool.totalStaked,
      stakeDecimals,
      stakeDecimalsKnown,
      tvlUsd,
      aprA: apr.aprA,
      aprB: apr.aprB,
      aprTotal: apr.total,
      aprMax,
      dailyA: toNumber(farm.rewardAPerSecond, decA) * SECONDS_PER_DAY * (pool.sharePct / 100),
      dailyB: toNumber(farm.rewardBPerSecond, decB) * SECONDS_PER_DAY * (pool.sharePct / 100),
      position,
      stakedUsd: position ? (position.staked === 0n ? 0 : stakeToUsd(position.staked)) : undefined,
      pendingUsd
    };
  });

  const sum = (vals: (number | undefined)[]): number | undefined =>
    vals.some(v => v === undefined) ? undefined : (vals as number[]).reduce((s, v) => s + v, 0);
  const staked = rows.filter(r => r.totalStaked > 0n);
  const mine = rows.filter(r => r.position && r.position.staked > 0n);
  const claimable = rows.filter(r => r.position && (r.position.pendingA > 0n || r.position.pendingB > 0n));

  const summary: FarmSummary = {
    tvlUsd: sum(staked.map(r => r.tvlUsd)),
    emissionUsdPerDay:
      rewardA?.priceUsd !== undefined && rewardB?.priceUsd !== undefined
        ? toNumber(farm.rewardAPerSecond, decA) * SECONDS_PER_DAY * rewardA.priceUsd +
          toNumber(farm.rewardBPerSecond, decB) * SECONDS_PER_DAY * rewardB.priceUsd
        : undefined,
    yourStakedUsd: i.positions ? sum(mine.map(r => r.stakedUsd)) : undefined,
    yourPendingUsd: i.positions ? sum(claimable.map(r => r.pendingUsd)) : undefined,
    pendingA: toNumber(rows.reduce((s, r) => s + (r.position?.pendingA ?? 0n), 0n), decA),
    pendingB: toNumber(rows.reduce((s, r) => s + (r.position?.pendingB ?? 0n), 0n), decB),
    poolsWithStake: mine.length
  };
  return { rows, summary };
}

// ---------------------------------------------------------------------------------------------
// Single-token pools: stake Q0 or BDELTA itself
// ---------------------------------------------------------------------------------------------

/** A single-token pool the project plans to run (structurally the registry's SingleStakePlan). */
export interface PlannedSinglePool {
  /** Address of the token that is deposited (any case). */
  stakeToken: string;
  symbol: string;
  /** The weight the deploy flow plans for it. */
  allocPoint: bigint;
}

export interface SingleStakeCandidate {
  stakeToken: string;
  symbol: string;
  allocPoint: bigint;
  /** IN_FARM: the farm already has a pool for this token. NOT_IN_FARM: its owner has not added it yet. */
  state: 'IN_FARM' | 'NOT_IN_FARM';
  pid: number | null;
}

/**
 * For each single-token pool in the plan: is it in the deployed farm, or still to be added? The answer comes from the
 * farm's own pool list (the plan's pool ids mean nothing on a live farm), compared by token address, so a pool added
 * at any position, with any weight, counts. A token listed twice in the plan is one candidate.
 */
export function singleStakeCandidates(farm: Pick<FarmState, 'pools'>, planned: readonly PlannedSinglePool[]): SingleStakeCandidate[] {
  const seen = new Set<string>();
  const out: SingleStakeCandidate[] = [];
  for (const p of planned) {
    const token = p.stakeToken.toLowerCase();
    if (seen.has(token)) continue;
    seen.add(token);
    const live = farm.pools.find(pool => pool.lpToken.toLowerCase() === token);
    out.push({
      stakeToken: token,
      symbol: p.symbol,
      allocPoint: p.allocPoint,
      state: live ? 'IN_FARM' : 'NOT_IN_FARM',
      pid: live ? live.pid : null
    });
  }
  return out;
}

/** What a pool is called on the page: "Stake Q0" for a single token, "BDELTA / WQUAI" for a pair. */
export function poolTitle(row: Pick<FarmRow, 'kind' | 'label'>): string {
  return row.kind === 'SINGLE' ? `Stake ${row.label}` : row.label;
}

/** "Earn BDELTA + Q0": the plain-language line under a pool's name. Both rewards are paid by every pool. */
export function earnsLine(rewardSymbolA: string, rewardSymbolB: string): string {
  return `Earn ${rewardSymbolA} + ${rewardSymbolB}`;
}

/**
 * A human amount ("12.5") to base units, or null when it is not a plain non-negative decimal or has more places than
 * the token. (units.parseUnits throws instead; the form code wants a value it can test without a try block.)
 */
export function tryParseUnits(text: string, decimals: number): bigint | null {
  const t = text.trim();
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null;
  const [whole, frac = ''] = t.split('.');
  if (frac.length > decimals) return null;
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Tokens per day (human) to wei per second; null if not a valid amount. Truncates below 1 wei/s. */
export function ratePerSecondFromDaily(perDay: string, decimals: number): bigint | null {
  const wei = tryParseUnits(perDay, decimals);
  return wei === null ? null : wei / BigInt(SECONDS_PER_DAY);
}
