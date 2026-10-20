#!/usr/bin/env node
/**
 * The DarkOrder corporate brain — autonomous controller for the agent guild swarm.
 *
 *   node agents/corporate-brain.mjs --network mainnet                     observe + plan (dry run)
 *   node agents/corporate-brain.mjs --network mainnet --once              execute one tick
 *   node agents/corporate-brain.mjs --network mainnet --loop --interval 90
 *   add --broadcast --i-understand-unaudited                              to sign and send
 *
 * Without --broadcast every phase is fully simulated (quai_call) and nothing is signed.
 *
 * The brain walks an idempotent phase ladder; every tick re-observes the chain and does
 * only the next undone step, so it is safe to kill and restart at any time:
 *
 *   FOUND       sovereign founds the guild if the name does not resolve yet
 *   FUND        sovereign sends each sybil a QUAI gas stipend
 *   DISTRIBUTE  sovereign transfers each sybil its governance-token parcel
 *   DELEGATE    every identity self-delegates so its balance counts as votes
 *   GOVERN      directors file agenda proposals; the bloc votes YES with human-ish jitter;
 *               the sentinel executes once the vote passes
 *   POLICE      doctrine-driven (agents/doctrine.json): anything on a protected hall not
 *               filed by the swarm is hostile and the bloc votes NO (posture "dominate")
 *   WATCHMEN    every tick: walk the registry, snapshot every guild on chain into
 *               agents/intel.json; the storyteller chronicles births, trades, and
 *               enforcement into agents/chronicle.jsonl (see agents/CABAL.md)
 *
 * Key handling: keystores + passwords from agents/keys/ (written by agent-keys-new.mjs).
 * These are hot game-agent wallets — fund them with what the swarm is allowed to spend.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Wallet, JsonRpcProvider, QuaiTransaction, Interface, getAddress, Zone, getZoneForAddress, isQiAddress } from 'quais';
import { writeDrops } from './intel-drops.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const NETWORKS = {
  orchard: { chainId: 15000n, rpc: 'https://orchard.rpc.quai.network/cyprus1', pathing: 'https://orchard.rpc.quai.network', confirmations: 6 },
  mainnet: { chainId: 9n, rpc: 'https://rpc.quai.network/cyprus1', pathing: 'https://rpc.quai.network', confirmations: 3 },
};

// Corporate persona. The name is the on-chain handle; agendas are what directors propose.
const CORP = {
  name: 'obsidiantrust',
  metadata: 'OBSIDIAN TRUST — corporate steward of the darkcircle skyline. Every tower a share, every share a vote.',
  tokenName: 'Obsidian Share',
  tokenSymbol: 'OBS',
  initialSupply: 1000n * 10n ** 18n,
  supportThreshold: 5_000n, // 50%
  minParticipation: 1_000n, // 10%
  minDuration: 3600n,
  gasStipend: 5n * 10n ** 18n, // 5 QUAI per sybil for gas
  maxQuaiPerTick: 50n * 10n ** 18n, // hard spend cap per tick (excluding the founding tx)
  foundingGas: 15_000_000n,
  vaultGas: 8_000_000n, // council founding is two contracts, not three; 8M keeps gas×price under the treasury
  agendas: [
    'AGENDA 001 — charter ratification: all construction flows through this hall.',
    'AGENDA 002 — skyline fund: pledge hall treasury toward the first corporate tower.',
    'AGENDA 003 — dividend policy: tower yield accrues to shareholders of record.',
    'AGENDA 004 — expansion: survey a storefront site; open the order book to members.',
    'AGENDA 005 — security detail: budget for tower defense against seizure attempts.',
  ],
  // ── Treasury policy (hardened 2026-10-19 per owner directive: "aggressive and greedy")
  // Hard rails, enforced every tick regardless of strategy mood:
  treasury: {
    reserveFloor: 150n * 10n ** 18n, // QUAI the sovereign never trades below (governance runway, halved: idle capital is dead capital)
    perTradeBudget: 15n * 10n ** 18n, // base QUAI notional per buy, at most one buy per tick
    maxTradeBudget: 30n * 10n ** 18n, // crash-sizing cap: blood in the streets doubles the base
    slippageBps: 600n,               // minOut = quote × (1 − 6%)
    maxImpactBps: 400n,              // refuse a buy that moves the pool more than 4%
    dipBps: 200n,                    // buy signal: price 2% under the 6-reading moving average
    crashBps: 600n,                  // a 6% drop under the average = double the buy size
    momentumBps: 150n,               // breakout signal: price 1.5% over the average — greed chases rips too
    takeProfitBps: 800n,             // sell signal: price 8% over cost basis — harvest early, harvest often
    sellDivisor: 5n,                 // a take-profit skims 1/5 of the Q0 position, the core rides
    deadlineSeconds: 300n,           // router deadline window
    venue: 'circleswap',             // the ONLY venue this policy allows
    target: 'Q0',                    // the ONLY asset this policy accumulates
  },
  // ── Council desk (owner directive 2026-10-19: "move all funds into council custody,
  // and start your trading strategy"). The 4-of-7 vault IS the trading entity: capital
  // lives in the council guild, and every trade executes as a council proposal — the
  // swarm's own keys provide the 4 approvals, so one tick files, approves, and executes
  // a trade, but no single key can ever move the treasury alone.
  desk: {
    gasFloat: 40n * 10n ** 18n,        // QUAI the sovereign EOA keeps for gas; everything above is swept to the vault every tick
    sweepMargin: 5n * 10n ** 18n,      // don't churn dust: sweep only when the excess clears this margin
    vaultReserveFloor: 50n * 10n ** 18n, // QUAI the vault never trades below (council runway)
    deadlineSeconds: 14_400n,          // 4h swap deadline — an approval wave may land a full tick (hour) late
  },
  // Corporate scrip for player engagement, deployed once through the live TokenStackDeployer
  // (guild := sovereign, so the sovereign EOA owns minting; the sidecar voting module is unused).
  scrip: {
    name: 'Obsidian Credit',
    symbol: 'OBSC',
    supply: 1_000_000n * 10n ** 18n, // minted to the sovereign once, then distributed as rewards
    payroll: 1_000n * 10n ** 18n,    // flavor grant to each sybil at issuance
  },
  // ── Obsidian pit: the desk's VDF orderbook arm (see agents/obsidian-pit.mjs).
  // Capital path: vault -> DarkSafe pit safe -> pit-1 hot key -> BOLTDEXV2 escrow.
  // Quoting is gasless (EIP-712 signatures), so the organ runs every quiet tick
  // without touching the tick's gas budget.
  pit: {
    market: '9:Q0-QUAI',
    engineWs: 'wss://engine-delta.boltevm.com',
    vault: '0x00664ed083476f770E50B32aD488B15618acd589', // canonical BOLTDEXV2, chain 9
    q0: '0x00325150094E51107a931980Fdfc3bB1a4C48379',
    rungsPerSide: 3,
    innerBps: 30n,                  // first rung sits this far off the reference mid
    stepBps: 20n,                   // spacing between rungs
    size: 1500n * 10n ** 18n,       // Q0 per rung
    keepBps: 25n,                   // a live order within this of a desired rung stays
    expiryDays: 7,
    maxOpsPerTick: 8,
  },
  // The vault: council-mode guild whose members are the whole swarm. 4-of-7 approvals move
  // money; the donated community tokens are swept here from the hall and managed by council.
  vault: {
    name: 'obsidianvault',
    metadata: 'OBSIDIAN VAULT — 4-of-7 council treasury of the Obsidian Trust. Community-donated assets under corporate custody.',
    minApprovals: 4,
    // Assets swept from the hall guild into the vault (full balance each sweep).
    sweepTokens: [
      { symbol: 'Q0', address: '0x00325150094E51107a931980Fdfc3bB1a4C48379' },
      { symbol: 'QAXE', address: '0x0035187a7660f595D93cd53a4D16c635D6cFFC8f' },
      { symbol: 'HBOME', address: '0x001fA4fdb848BB8C98B0d6Cd85257EfcCAe3b425' },
      { symbol: 'COPPER', address: '0x0018e67e97F5ED3FcDF0883473a117005b994D98' },
      { symbol: 'ART', address: '0x0060142D35D2860404C81958e6979db2e0710d45' },
    ],
  },
};

// Circleswap on Cyprus-1 mainnet — mirrored from b3js CircleswapProvider / q0 registries/deployed.ts.
// There is NO direct Q0/WQUAI pair: Q0 trades through the QRB hub (verified 2026-10-19,
// allPairs walk: QRB/WQUAI, BDELTA/QRB, BDELTA/Q0, BDELTA/WQUAI, Q0/QRB, QAXE/WQUAI, Q0/QAXE).
const CIRCLESWAP = {
  FACTORY: '0x001563Cc61F495eBF0D7d73Fd054Bc7eE245DD24',
  ROUTER: '0x00591827868F2989Bb34DbCf71Ff5c48574d4D25',
  WQUAI: '0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB',
  QRB: '0x0050A7fcB00521b75Bb5f3BC8e1D49FED7C08cE5',
  Q0: '0x00325150094E51107a931980Fdfc3bB1a4C48379',
};

// Mutable treasury state across ticks (pair cache, price memory, position, scrip record).
const TREASURY_STATE_PATH = path.join(ROOT, 'agents', 'treasury-state.json');
function loadTreasuryState() {
  try {
    const s = JSON.parse(fs.readFileSync(TREASURY_STATE_PATH, 'utf8'));
    s.desk ??= { proposalId: null, kind: null }; // council-desk trade in flight, if any
    return s;
  }
  catch {
    return {
      pairs: null, readings: [], costBasis: null, q0Held: '0',
      scripToken: null, scripMinted: false, scripPayrolled: false,
      vault: { guild: null, module: null, swept: false, charterId: null, charterDone: false },
      desk: { proposalId: null, kind: null },
    };
  }
}
function saveTreasuryState(s) {
  fs.writeFileSync(TREASURY_STATE_PATH, JSON.stringify(s, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// The Storyteller + the doctrine (see agents/CABAL.md)
// ---------------------------------------------------------------------------

// Private diary of the cabal — gitignored, the raw product the x402 gate will sell.
const CHRONICLE_PATH = path.join(ROOT, 'agents', 'chronicle.jsonl');
// Watchmen ledger — a snapshot of every registered guild, refreshed each tick.
const INTEL_PATH = path.join(ROOT, 'agents', 'intel.json');
const DOCTRINE_PATH = path.join(ROOT, 'agents', 'doctrine.json');

function chronicle(event, details = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...details });
  try { fs.appendFileSync(CHRONICLE_PATH, line + '\n'); } catch { /* the diary never kills the mind */ }
  console.log(`  chronicle: ${event}${details.note ? ` — ${details.note}` : ''}`);
}

function loadDoctrine() {
  try {
    const d = JSON.parse(fs.readFileSync(DOCTRINE_PATH, 'utf8'));
    d.posture ??= 'dominate';
    d.protectedGuilds ??= ['obsidiantrust', 'obsidianvault'];
    return d;
  } catch {
    return { posture: 'dominate', protectedGuilds: ['obsidiantrust', 'obsidianvault'] };
  }
}

// STRATEGY.md rule 1: the Tier-1 runway floor is the configured floor, raised to
// observed 30-day gas burn × runwayMonths once the receipt ledger has data.
function runwayFloorOf(ts, configuredFloor, runwayMonths = 6) {
  if (!ts.gasLedger || BigInt(ts.gasLedger.total ?? '0') === 0n) return configuredFloor;
  const days = Math.max(1, Math.ceil((Date.now() - new Date(ts.gasLedger.since).getTime()) / 86_400_000));
  const adaptive = ((BigInt(ts.gasLedger.total) * 30n) / BigInt(days)) * BigInt(runwayMonths);
  return adaptive > configuredFloor ? adaptive : configuredFloor;
}

// Quai escrow rule: a sender must hold gasLimit × gasPrice up front, so at spike
// prices a fixed filer may be priced out for hours. Pick the first member of the
// preferred order who can actually cover the escrow; null when nobody can.
async function pickFiler(net, swarm, gasLimit, preferred = ['director-1', 'director-2', 'worker-1', 'worker-2', 'worker-3', 'sentinel', 'sovereign']) {
  const gasPrice = BigInt(await rpc(net.rpc, 'quai_gasPrice', []));
  for (const id of preferred) {
    const w = swarm.get(id);
    if (!w) continue;
    const bal = BigInt(await rpc(net.rpc, 'quai_getBalance', [w.address, 'latest']));
    if (bal >= gasLimit * gasPrice) return w;
  }
  return null;
}

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) fail(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (['broadcast', 'i-understand-unaudited', 'once', 'loop'].includes(key)) out.flags.add(key);
    else if (['network', 'interval'].includes(key)) out[key] = argv[++i];
    else fail(`unknown option ${a}`);
  }
  return out;
}

function artifact(name) {
  const file = path.join(ROOT, 'artifacts/contracts', `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) fail(`missing ${file}; run \`pnpm build\` first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const jitter = (baseMs) => baseMs + Math.floor(Math.random() * baseMs); // human-ish spread

// VoteOption in MajorityVoting.sol: None=0, Abstain=1, Yes=2, No=3. Do not reorder.
const VOTE = { YES: 2, NO: 3 };

function fmtQuai(wei) {
  return `${wei / 10n ** 18n}.${(wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4)} QUAI`;
}

// ---------------------------------------------------------------------------
// Swarm loading
// ---------------------------------------------------------------------------

function loadManifest() {
  const file = path.join(ROOT, 'agents', 'manifest.json');
  if (!fs.existsSync(file)) fail('agents/manifest.json not found; run scripts/agent-keys-new.mjs first');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function loadSwarm(manifest, provider, broadcast) {
  const pwFile = path.join(ROOT, 'agents', 'keys', 'passwords.json');
  if (broadcast && !fs.existsSync(pwFile)) fail('agents/keys/passwords.json not found');
  const passwords = broadcast ? JSON.parse(fs.readFileSync(pwFile, 'utf8')) : {};
  const swarm = new Map();
  for (const id of manifest.identities) {
    let wallet = null;
    if (broadcast) {
      const ks = path.join(ROOT, ...id.keystore.split(/[\\/]/));
      wallet = (await Wallet.fromEncryptedJson(fs.readFileSync(ks, 'utf8'), passwords[id.id])).connect(provider);
      if (wallet.address !== id.address) fail(`keystore ${id.id} unlocks ${wallet.address}, expected ${id.address}`);
    }
    swarm.set(id.id, { ...id, wallet });
  }
  return swarm;
}

// ---------------------------------------------------------------------------
// Chain plumbing (same discipline as found-guild-quai.mjs: simulate, then sign)
// ---------------------------------------------------------------------------

async function waitConfirmed(net, hash, confirmations) {
  const deadline = Date.now() + 30 * 60_000;
  let seen = null;
  while (Date.now() < deadline) {
    const r = await rpc(net.rpc, 'quai_getTransactionReceipt', [hash]).catch(() => null);
    if (r?.blockNumber) {
      if (seen !== null && r.blockHash !== seen) console.log('  receipt moved block (reorg); recounting');
      seen = r.blockHash;
      const head = BigInt(await rpc(net.rpc, 'quai_blockNumber', []));
      const depth = Number(head - BigInt(r.blockNumber)) + 1;
      if (depth >= confirmations) {
        const again = await rpc(net.rpc, 'quai_getTransactionReceipt', [hash]);
        if (again?.blockHash === r.blockHash) return again;
      }
    }
    await sleep(4000);
  }
  throw new Error(`no confirmed receipt for ${hash} after 30 minutes`);
}

let spentThisTick = 0n;
let gasSpentThisTick = 0n; // actual gasPaid from confirmed receipts — feeds the runway ledger

async function act(net, who, tx, gasLimit, label, { broadcast, confirmations, exemptFromCap = false }) {
  // JSON-RPC quantities are hex strings; BigInt would crash JSON.stringify.
  // The gas limit rides the simulation too: a limit that can't cover real usage
  // fails here for free instead of on chain for real QUAI.
  const simTx = { ...tx, from: who.address, gas: '0x' + gasLimit.toString(16) };
  if (simTx.value !== undefined) simTx.value = '0x' + BigInt(simTx.value).toString(16);
  await rpc(net.rpc, 'quai_call', [simTx, 'latest']);
  console.log(`  [${who.id}] ${label}: simulates cleanly`);
  if (!broadcast) return null;
  const gasPrice = BigInt(await rpc(net.rpc, 'quai_gasPrice', []));
  const cost = gasLimit * gasPrice + BigInt(tx.value ?? 0);
  if (!exemptFromCap) {
    if (spentThisTick + cost > CORP.maxQuaiPerTick) {
      console.log(`  [${who.id}] ${label}: skipped (tick spend cap ${fmtQuai(CORP.maxQuaiPerTick)} would be exceeded)`);
      return null;
    }
    spentThisTick += cost;
  }
  const pop = await who.wallet.populateQuaiTransaction({ ...tx, from: who.address, gasLimit });
  const signed = await who.wallet.signTransaction(QuaiTransaction.from(pop));
  const zone = await who.wallet.zoneFromAddress(who.address);
  let resp;
  try {
    resp = await who.wallet.provider.broadcastTransaction(zone, signed, who.address);
  } catch (e) {
    // Gas spikes price members out between simulation and send — skip, never crash the tick.
    if (/insufficient funds/i.test(e?.message ?? '')) {
      console.log(`  [${who.id}] ${label}: skipped (cannot cover intrinsic cost at current gas prices)`);
      return null;
    }
    throw e;
  }
  console.log(`  [${who.id}] ${label}: sent ${resp.hash}`);
  const receipt = await waitConfirmed(net, resp.hash, confirmations);
  if (parseInt(receipt.status, 16) !== 1) fail(`${label} reverted (tx ${resp.hash})`);
  console.log(`  [${who.id}] ${label}: confirmed in block ${parseInt(receipt.blockNumber, 16)}`);
  gasSpentThisTick += BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? 0);
  return receipt;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

function buildIfaces() {
  return {
    factory: new Interface(artifact('GuildFactory').abi),
    registry: new Interface(artifact('GuildNameRegistry').abi),
    token: new Interface(artifact('GovernanceToken').abi),
    voting: new Interface(artifact('MajorityVoting').abi),
    guild: new Interface(artifact('Guild').abi),
    tokenStack: new Interface(artifact('TokenStackDeployer').abi),
    council: new Interface(artifact('CouncilMultisig').abi),
    ammFactory: new Interface(['function allPairsLength() view returns (uint256)', 'function allPairs(uint256) view returns (address)', 'function getPair(address, address) view returns (address)']),
    pair: new Interface(['function getReserves() view returns (uint112, uint112, uint32)', 'function token0() view returns (address)', 'function token1() view returns (address)']),
    router: new Interface([
      'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[])',
      'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
    ]),
    erc20: new Interface([
      'function approve(address spender, uint256 amount) returns (bool)',
      'function transfer(address to, uint256 amount) returns (bool)',
      'function balanceOf(address owner) view returns (uint256)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function totalSupply() view returns (uint256)',
      'function owner() view returns (address)',
    ]),
  };
}

async function call(net, to, data) {
  return rpc(net.rpc, 'quai_call', [{ to, data }, 'latest']);
}

async function observe(net, ifaces, deployment, swarm) {
  const state = { hall: null, proposals: [], balances: new Map(), votes: new Map() };
  const resolved = await call(net, deployment.registry.address, ifaces.registry.encodeFunctionData('resolve', [CORP.name]));
  if (BigInt(resolved) !== 0n) {
    const guildAddr = getAddress('0x' + resolved.slice(-40));
    const rec = ifaces.registry.decodeFunctionResult(
      'recordOf',
      await call(net, deployment.registry.address, ifaces.registry.encodeFunctionData('recordOf', [guildAddr])),
    )[0];
    state.hall = { guild: rec.guild, token: rec.token, module: rec.module };
    state.proposalCount = Number(
      ifaces.voting.decodeFunctionResult('proposalCount', await call(net, rec.module, ifaces.voting.encodeFunctionData('proposalCount', [])))[0],
    );
    // ProposalView carries no proposer; recover it from the ProposalCreated logs.
    // quai_getLogs caps ranges at 10k blocks, so scan backwards in chunks until every
    // known proposal id has a creator (or we run out of history — expired proposals
    // are never acted on anyway).
    const topic0 = ifaces.voting.getEvent('ProposalCreated').topicHash;
    const proposers = new Map();
    const head = BigInt(await rpc(net.rpc, 'quai_blockNumber', []));
    const CHUNK = 9_500n;
    for (let to = head; proposers.size < state.proposalCount && to > 0n;) {
      const from = to > CHUNK ? to - CHUNK : 0n;
      const logs = await rpc(net.rpc, 'quai_getLogs', [{
        address: rec.module, topics: [topic0], fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      }]);
      for (const l of logs) proposers.set(Number(BigInt(l.topics[1])), getAddress('0x' + l.topics[2].slice(-40)));
      if (from === 0n) break;
      to = from - 1n;
    }
    for (let i = 0; i < state.proposalCount; i++) {
      const p = ifaces.voting.decodeFunctionResult('getProposal', await call(net, rec.module, ifaces.voting.encodeFunctionData('getProposal', [i])))[0];
      state.proposals.push({ id: i, metadata: p.metadata, yes: p.yes, no: p.no, supportThreshold: p.supportThreshold, executed: p.executed, endDate: Number(p.endDate), proposer: proposers.get(i) ?? null });
    }
    for (const [id, who] of swarm) {
      const bal = ifaces.token.decodeFunctionResult('balanceOf', await call(net, rec.token, ifaces.token.encodeFunctionData('balanceOf', [who.address])))[0];
      state.balances.set(id, bal);
      const votes = ifaces.token.decodeFunctionResult('getVotes', await call(net, rec.token, ifaces.token.encodeFunctionData('getVotes', [who.address])))[0];
      state.votes.set(id, votes);
    }
  }
  for (const [id, who] of swarm) {
    state.balances.set(`${id}:quai`, BigInt(await rpc(net.rpc, 'quai_getBalance', [who.address, 'latest'])));
  }
  return state;
}

// ---------------------------------------------------------------------------
// Treasury — pair discovery, quotes, and the SPECULATE / ISSUE phases
// ---------------------------------------------------------------------------

/** Constant-product quote: Q0 out for QUAI in (0.3% fee), or QUAI out for Q0 in. */
function quoteOut(amountIn, reserveIn, reserveOut) {
  const withFee = amountIn * 997n;
  return (withFee * reserveOut) / (reserveIn * 1000n + withFee);
}

// Tolerant single-uint decode: Q0 (and possibly other Cyprus-1 tokens) answer balanceOf /
// allowance with a non-standard short word, which strict ABI decoding rejects. BigInt(raw)
// is correct for any width. Encode stays strict; only uint decode goes through this.
const uintOf = (raw) => BigInt(raw);

/** Find the two pairs of the QRB route: QRB/WQUAI and Q0/QRB. Cached in treasury state. */
async function discoverPairs(net, ifaces, ts) {
  const n = Number(ifaces.ammFactory.decodeFunctionResult('allPairsLength',
    await call(net, CIRCLESWAP.FACTORY, ifaces.ammFactory.encodeFunctionData('allPairsLength', [])))[0]);
  console.log(`  treasury: walking ${Math.min(n, 200)} Circleswap pairs for the QRB route`);
  const found = {};
  for (let i = 0; i < Math.min(n, 200); i++) {
    const pair = getAddress('0x' + (await call(net, CIRCLESWAP.FACTORY,
      ifaces.ammFactory.encodeFunctionData('allPairs', [i]))).slice(-40));
    const t0 = getAddress('0x' + (await call(net, pair, ifaces.pair.encodeFunctionData('token0', []))).slice(-40));
    const t1 = getAddress('0x' + (await call(net, pair, ifaces.pair.encodeFunctionData('token1', []))).slice(-40));
    const set = [t0.toLowerCase(), t1.toLowerCase()];
    const has = (a) => set.includes(a.toLowerCase());
    if (has(CIRCLESWAP.QRB) && has(CIRCLESWAP.WQUAI)) found.qrbWquai = { pair, wquaiIsToken0: t0.toLowerCase() === CIRCLESWAP.WQUAI.toLowerCase() };
    if (has(CIRCLESWAP.QRB) && has(CIRCLESWAP.Q0)) found.q0Qrb = { pair, q0IsToken0: t0.toLowerCase() === CIRCLESWAP.Q0.toLowerCase() };
  }
  if (!found.qrbWquai || !found.q0Qrb) {
    console.log(`  treasury: route incomplete — qrbWquai ${found.qrbWquai?.pair ?? 'MISSING'}, q0Qrb ${found.q0Qrb?.pair ?? 'MISSING'}; standing down`);
    return null;
  }
  ts.pairs = found;
  saveTreasuryState(ts);
  console.log(`  treasury: route ${found.qrbWquai.pair} (QRB/WQUAI) -> ${found.q0Qrb.pair} (Q0/QRB)`);
  return found;
}

/** Reserves of both hop pairs as { rW, rR1, rR2, rQ }: QUAI-side, QRB (hop1), QRB (hop2), Q0-side. */
async function readRouteReserves(net, ifaces, pairs) {
  const a = ifaces.pair.decodeFunctionResult('getReserves', await call(net, pairs.qrbWquai.pair, ifaces.pair.encodeFunctionData('getReserves', [])));
  const b = ifaces.pair.decodeFunctionResult('getReserves', await call(net, pairs.q0Qrb.pair, ifaces.pair.encodeFunctionData('getReserves', [])));
  return {
    rW: pairs.qrbWquai.wquaiIsToken0 ? BigInt(a[0]) : BigInt(a[1]),
    rR1: pairs.qrbWquai.wquaiIsToken0 ? BigInt(a[1]) : BigInt(a[0]),
    rQ: pairs.q0Qrb.q0IsToken0 ? BigInt(b[0]) : BigInt(b[1]),
    rR2: pairs.q0Qrb.q0IsToken0 ? BigInt(b[1]) : BigInt(b[0]),
  };
}

/** Two-hop quote through the QRB hub. */
function quoteRoute(amountIn, rIn1, rOut1, rIn2, rOut2) {
  return quoteOut(quoteOut(amountIn, rIn1, rOut1), rIn2, rOut2);
}

/** QUAI per Q0 scaled 1e18, composed from both pairs. */
function routePriceE18(r) {
  return (r.rW * 10n ** 18n / r.rR1) * r.rR2 / r.rQ;
}

// Drive a council proposal through its approvals. Sybils approve first with cheap
// non-executing calls; the approval that can cross minApprovals carries tryExecution
// and a gas limit that covers the swap. Members who cannot cover the intrinsic gas
// cost are skipped this tick instead of failing on broadcast. Shared by the desk and
// the fixers. Returns 'executed' | 'open'.
async function driveCouncilProposal(net, council, swarm, ifaces, opts, id) {
  const councilCall = (data) => call(net, council, data);
  const getProp = async (pid) => ifaces.council.decodeFunctionResult('getProposal',
    await councilCall(ifaces.council.encodeFunctionData('getProposal', [pid])))[0];
  const order = ['director-1', 'director-2', 'worker-1', 'worker-2', 'worker-3', 'sentinel', 'sovereign'];
  const gasPrice = BigInt(await rpc(net.rpc, 'quai_gasPrice', []));
  let count = Number((await getProp(id)).approvals);
  for (const mid of order) {
    const w = swarm.get(mid);
    const approved = ifaces.council.decodeFunctionResult('hasApproved',
      await councilCall(ifaces.council.encodeFunctionData('hasApproved', [id, w.address])))[0];
    if (approved) continue;
    const executing = count >= Number(3); // this approval can reach the 4-of-7 threshold
    const gasLimit = executing ? 800_000n : 150_000n;
    const balance = BigInt(await rpc(net.rpc, 'quai_getBalance', [w.address, 'latest']));
    if (balance < gasLimit * gasPrice) {
      console.log(`  council: ${mid} cannot cover ${executing ? 'executing ' : ''}approval gas (${fmtQuai(balance)} < ${fmtQuai(gasLimit * gasPrice)}) — skipped this tick`);
      continue;
    }
    const receipt = await act(net, w, {
      to: council, data: ifaces.council.encodeFunctionData('approve', [BigInt(id), executing]),
    }, gasLimit, `council approve #${id}${executing ? ' + execute' : ''} (${mid})`, opts);
    if (opts.broadcast && receipt) count++;
    await sleep(jitter(8_000));
    if (!(opts.broadcast)) continue;
    if ((await getProp(id)).executed) return 'executed';
  }
  return (await getProp(id)).executed ? 'executed' : 'open';
}

// DESK — the treasury strategy, executed entirely from the 4-of-7 council vault.
// Every tick: (1) sweep sovereign QUAI above the gas float into council custody,
// (2) drive any in-flight council trade proposal toward execution, (3) read the
// market and, on a signal, file the trade as a council proposal and push it
// through all 4 approvals in the same tick. The swarm holds every council key,
// so approval is automatic — but the treasury never sits behind fewer than 4
// signatures, the sovereign EOA included. Dry runs still record the reading.
async function deskOps(net, sovereign, swarm, ifaces, ts, opts, sovQuai) {
  if (!ts.vault?.guild || !ts.vault?.module) return false; // no council custody yet — nothing to desk
  const t = CORP.treasury, d = CORP.desk;
  const vault = ts.vault.guild, council = ts.vault.module;
  const deskOpts = { ...opts, exemptFromCap: true }; // bounded fixed tx set per trade; owner-directed strategy

  // (1) Consolidation: every QUAI above the gas float belongs to the council.
  if (sovQuai > d.gasFloat + d.sweepMargin) {
    const amount = sovQuai - d.gasFloat;
    console.log(`phase DESK: consolidate ${fmtQuai(amount)} sovereign -> vault (float ${fmtQuai(d.gasFloat)} stays for gas)`);
    await act(net, sovereign, { to: vault, value: amount, data: '0x' }, 100_000n, `sweep ${fmtQuai(amount)} to vault`, deskOpts);
  }

  const councilCall = (data) => call(net, council, data);
  const getProp = async (id) => ifaces.council.decodeFunctionResult('getProposal',
    await councilCall(ifaces.council.encodeFunctionData('getProposal', [id])))[0];
  const driveProposal = (id) => driveCouncilProposal(net, council, swarm, ifaces, deskOpts, id);

  // Settle an executed desk trade into position state: refresh the vault's Q0,
  // and for buys fold the fill into the weighted cost basis recorded at filing.
  const settleTrade = async (kind) => {
    const nowHeld = uintOf(await call(net, CIRCLESWAP.Q0, ifaces.erc20.encodeFunctionData('balanceOf', [vault])));
    if (kind === 'buy' && ts.desk.q0Before !== undefined && ts.desk.priceE18) {
      const before = BigInt(ts.desk.q0Before);
      const price = BigInt(ts.desk.priceE18);
      const bought = nowHeld - before;
      if (bought > 0n) {
        ts.costBasis = before === 0n || !ts.costBasis
          ? price.toString()
          : ((BigInt(ts.costBasis) * before + price * bought) / (before + bought)).toString();
        console.log(`  desk: +${bought / 10n ** 18n} Q0 settled · cost basis ${(Number(BigInt(ts.costBasis)) / 1e18).toExponential(4)} QUAI`);
      }
    } else if (kind === 'sell' && nowHeld === 0n) {
      ts.costBasis = null;
    }
    ts.q0Held = nowHeld.toString();
    ts.desk = { proposalId: null, kind: null };
    saveTreasuryState(ts);
    chronicle('desk-trade-settled', { note: `${kind} settled — the vault holds ${nowHeld / 10n ** 18n} Q0`, kind, q0Held: nowHeld.toString() });
  };

  // (2) An in-flight desk trade? Finish it before reading the market again.
  if (ts.desk.proposalId !== null && ts.desk.proposalId !== undefined) {
    const id = Number(ts.desk.proposalId);
    const onChainCount = Number(ifaces.council.decodeFunctionResult('proposalCount',
      await councilCall(ifaces.council.encodeFunctionData('proposalCount', [])))[0]);
    if (id >= onChainCount) {
      console.log(`phase DESK: recorded trade #${id} never landed on chain (council has ${onChainCount} proposals) — discarding phantom state`);
      ts.desk = { proposalId: null, kind: null };
      saveTreasuryState(ts);
    } else {
    const p = await getProp(id);
    if (p.executed) {
      console.log(`phase DESK: council trade #${id} (${ts.desk.kind}) executed`);
      await settleTrade(ts.desk.kind);
    } else {
      const ageS = (Date.now() - Number(p.createdAt) * 1000) / 1000;
      if (ageS > Number(d.deadlineSeconds)) {
        console.log(`phase DESK: council trade #${id} went stale (${Math.floor(ageS / 60)}min old) — abandoning it; its swap deadline is spent`);
        ts.desk = { proposalId: null, kind: null };
      } else {
        console.log(`phase DESK: council trade #${id} (${ts.desk.kind}) open — approvals ${p.approvals}/4`);
        if (opts.broadcast && (await driveProposal(id)) === 'executed') {
          console.log(`phase DESK: council trade #${id} executed`);
          ts.desk = { proposalId: null, kind: null };
        }
        saveTreasuryState(ts);
        return true;
      }
    }
    saveTreasuryState(ts);
    }
  }

  // (3) Market read + signal.
  if (!ts.pairs) {
    await discoverPairs(net, ifaces, ts);
    return true; // discovery is this tick's treasury work
  }
  const r = await readRouteReserves(net, ifaces, ts.pairs);
  const priceE18 = routePriceE18(r); // QUAI per Q0, scaled
  ts.readings.push({ at: Date.now(), priceE18: priceE18.toString() });
  ts.readings = ts.readings.slice(-24);
  // The position is the VAULT's, refreshed from the chain every tick.
  const q0Held = uintOf(await call(net, CIRCLESWAP.Q0, ifaces.erc20.encodeFunctionData('balanceOf', [vault])));
  const vaultQuai = BigInt(await rpc(net.rpc, 'quai_getBalance', [vault, 'latest']));
  ts.q0Held = q0Held.toString();
  // Gas ledger: fold this tick's confirmed spend into the cumulative record the
  // runway floor is sized from (STRATEGY.md rule 1).
  ts.gasLedger ??= { total: '0', since: new Date().toISOString() };
  if (opts.broadcast && gasSpentThisTick > 0n) {
    ts.gasLedger.total = (BigInt(ts.gasLedger.total) + gasSpentThisTick).toString();
  }
  saveTreasuryState(ts);

  const px = Number(priceE18) / 1e18;
  console.log(`  desk: Q0/QUAI ${px.toExponential(4)} via QRB · hop1 ${fmtQuai(r.rW)} WQUAI · hop2 ${r.rQ / 10n ** 18n} Q0 · vault ${fmtQuai(vaultQuai)} + ${q0Held / 10n ** 18n} Q0`);

  // ── Longevity strategy (agents/STRATEGY.md) ──────────────────────────────
  const strat = loadDoctrine().treasury ?? {};
  // Rule 1 — runway floor adapts to observed burn once the ledger has data.
  const runwayFloor = runwayFloorOf(ts, d.vaultReserveFloor, strat.runwayMonths);
  // Rule 2 — volatility scales the entry bands, clamped to the configured rails.
  let sigmaBps = 0;
  if (ts.readings.length >= 7) {
    const series = ts.readings.map((x) => Number(x.priceE18) / 1e18);
    const mean = series.reduce((a, b) => a + b, 0) / series.length;
    const varr = series.reduce((a, b) => a + (b - mean) * (b - mean), 0) / series.length;
    sigmaBps = mean > 0 ? (Math.sqrt(varr) / mean) * 10_000 : 0;
  }
  const volK = Number(strat.volK ?? 1.5);
  const adaptBps = (floorBps) => {
    const scaled = BigInt(Math.round(volK * sigmaBps));
    const f = BigInt(floorBps);
    return scaled > f ? (scaled < t.crashBps ? scaled : t.crashBps) : f;
  };
  const dipBps = adaptBps(t.dipBps);
  const momBps = adaptBps(t.momentumBps);
  // Rule 3 — drawdown throttles size deterministically from basis + live price.
  let sizeMulBps = 10_000n;
  if (q0Held > 0n && ts.costBasis) {
    const basis = BigInt(ts.costBasis);
    if (priceE18 * 10_000n < basis * (10_000n - BigInt(strat.drawdownQuarterBps ?? 2000))) sizeMulBps = 2_500n;
    else if (priceE18 * 10_000n < basis * (10_000n - BigInt(strat.drawdownHalfBps ?? 1000))) sizeMulBps = 5_000n;
  }
  const preserve = vaultQuai <= runwayFloor;
  // Rule 4 — the health record, every quiet tick.
  chronicle('treasury-health', {
    note: preserve ? 'capital preservation mode' : 'active',
    vaultQuai: fmtQuai(vaultQuai), q0Held: (q0Held / 10n ** 18n).toString(),
    runwayFloor: fmtQuai(runwayFloor), adaptiveFloor: runwayFloor > d.vaultReserveFloor,
    sigmaBps: Math.round(sigmaBps), sizeMul: Number(sizeMulBps) / 10_000,
  });

  // File a trade as a council proposal and drive it in the same tick.
  const fileTrade = async (kind, metadata, actions) => {
    const id = Number(ifaces.council.decodeFunctionResult('proposalCount',
      await councilCall(ifaces.council.encodeFunctionData('proposalCount', [])))[0]);
    const director = await pickFiler(net, swarm, 500_000n);
    if (!director) {
      console.log(`phase DESK: ${kind} signalled but no member can cover filing escrow at current gas prices — standing down`);
      return;
    }
    console.log(`phase DESK: ${director.id} files council ${kind}: "${metadata}"`);
    const receipt = await act(net, director, {
      to: council, data: ifaces.council.encodeFunctionData('createProposal', [metadata, actions]),
    }, 500_000n, `council createProposal (${kind})`, deskOpts);
    if (!opts.broadcast) return; // dry run — do not record a proposal that was never filed
    if (!receipt) return; // simulation passed but send failed — retry next tick
    ts.desk = { proposalId: id, kind, priceE18: priceE18.toString(), q0Before: q0Held.toString() };
    saveTreasuryState(ts);
    chronicle('desk-trade-filed', { note: metadata, proposalId: id, kind });
    if (opts.broadcast && (await driveProposal(id)) === 'executed') {
      console.log(`phase DESK: council ${kind} #${id} executed same tick`);
      await settleTrade(kind);
    }
  };

  // Take profit: price ≥ +8% over cost basis and the vault holds a position. Skim 1/5.
  if (q0Held > 0n && ts.costBasis && priceE18 * 10_000n >= BigInt(ts.costBasis) * (10_000n + t.takeProfitBps)) {
    const amount = q0Held / t.sellDivisor;
    if (amount === 0n) return false;
    const quaiOut = quoteRoute(amount, r.rQ, r.rR2, r.rR1, r.rW);
    const minOut = (quaiOut * (10_000n - t.slippageBps)) / 10_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + d.deadlineSeconds;
    console.log(`phase DESK: take profit — vault sells ${amount / 10n ** 18n} Q0 (>= ${fmtQuai(minOut)} min)`);
    await fileTrade('sell', `DESK SELL — skim ${amount / 10n ** 18n} Q0 at +8% over basis (>= ${fmtQuai(minOut)} min, 4h deadline)`, [
      [CIRCLESWAP.Q0, 0n, ifaces.erc20.encodeFunctionData('approve', [CIRCLESWAP.ROUTER, amount])],
      [CIRCLESWAP.ROUTER, 0n, ifaces.router.encodeFunctionData('swapExactTokensForETH', [amount, minOut, [CIRCLESWAP.Q0, CIRCLESWAP.QRB, CIRCLESWAP.WQUAI], vault, deadline])],
    ]);
    return true;
  }

  // Accumulate: dips AND breakouts, sized off the VAULT's free capital above the runway floor.
  if (ts.readings.length >= 7) {
    const prev = ts.readings.slice(-7, -1).map((x) => BigInt(x.priceE18));
    const avg = prev.reduce((a, b) => a + b, 0n) / BigInt(prev.length);
    const dipped = priceE18 * 10_000n <= avg * (10_000n - dipBps);
    const crashed = priceE18 * 10_000n <= avg * (10_000n - t.crashBps);
    const breakout = priceE18 * 10_000n >= avg * (10_000n + momBps);
    if (dipped || breakout) {
      const free = vaultQuai > runwayFloor ? vaultQuai - runwayFloor : 0n;
      let amountIn = free / 10n;
      if (amountIn < t.perTradeBudget) amountIn = t.perTradeBudget;
      if (amountIn > t.maxTradeBudget) amountIn = t.maxTradeBudget;
      if (crashed) {
        amountIn *= 2n;
        if (amountIn > t.maxTradeBudget) amountIn = t.maxTradeBudget;
      }
      amountIn = (amountIn * sizeMulBps) / 10_000n; // drawdown throttle — being wrong makes the desk smaller
      const signal = crashed ? 'crash' : dipped ? 'dip' : 'breakout';
      if (vaultQuai <= runwayFloor + amountIn) {
        console.log(`phase DESK: ${signal} signalled but the vault is at its runway floor (${fmtQuai(runwayFloor)}) — capital preservation, standing down`);
        return false;
      }
      const qrbOut = quoteOut(amountIn, r.rW, r.rR1);
      const impact1 = (amountIn * 10_000n) / r.rW;
      const impact2 = (qrbOut * 10_000n) / r.rR2;
      if (impact1 > t.maxImpactBps || impact2 > t.maxImpactBps) {
        console.log(`phase DESK: ${signal} signalled but hop impact ${Number(impact1) / 100}%/${Number(impact2) / 100}% exceeds policy — refusing to chase a thin pool`);
        return false;
      }
      const expected = quoteOut(qrbOut, r.rR2, r.rQ);
      const minOut = (expected * (10_000n - t.slippageBps)) / 10_000n;
      const depth = Number((avg > priceE18 ? avg - priceE18 : priceE18 - avg) * 10_000n / avg) / 100;
      const deadline = BigInt(Math.floor(Date.now() / 1000)) + d.deadlineSeconds;
      console.log(`phase DESK: ${signal} (${depth}% ${dipped ? 'under' : 'over'} 6-tick average) — vault buys with ${fmtQuai(amountIn)} -> >= ${minOut / 10n ** 18n} Q0 via QRB`);
      await fileTrade('buy', `DESK BUY — ${signal}: ${fmtQuai(amountIn)} into Q0 (>= ${minOut / 10n ** 18n} Q0 min, 4h deadline)`, [
        [CIRCLESWAP.ROUTER, amountIn, ifaces.router.encodeFunctionData('swapExactETHForTokens', [minOut, [CIRCLESWAP.WQUAI, CIRCLESWAP.QRB, CIRCLESWAP.Q0], vault, deadline])],
      ]);
      return true;
    }
  }
  console.log(`  desk: no signal (need ${Math.max(0, 7 - ts.readings.length)} more readings, or a dip/crash/rip)`);
  return false;
}

// ISSUE — one-time corporate scrip for player engagement, deployed through the live
// TokenStackDeployer with guild := sovereign so the EOA owns minting. Three steps over
// three quiet ticks: deploy, mint the supply to the sovereign, payroll the sybils.
async function issue(net, sovereign, sybils, ifaces, ts, deployment, opts, sovQuai) {
  const s = CORP.scrip;
  if (!ts.scripToken) {
    if (sovQuai <= CORP.treasury.reserveFloor + 200n * 10n ** 18n) {
      console.log(`phase ISSUE: scrip deployment deferred — treasury within 200 QUAI of the reserve floor`);
      return false; // deferred is not "handled": let lower-priority phases (vault, agenda) run
    }
    console.log(`phase ISSUE: deploying ${s.name} (${s.symbol}) through the TokenStackDeployer`);
    const data = ifaces.tokenStack.encodeFunctionData('deploy', [sovereign.address, s.name, s.symbol, 5_000n, 1_000n, 3_600n]);
    // Predict the token address from the same call (CREATE addresses are nonce-deterministic).
    const predicted = ifaces.tokenStack.decodeFunctionResult('deploy',
      await call(net, deployment.tokenStack.address, data))[0];
    const receipt = await act(net, sovereign, { to: deployment.tokenStack.address, data }, 12_000_000n,
      `deploy ${s.symbol}`, { ...opts, exemptFromCap: true });
    if (receipt) {
      // Verify the predicted contract is real and ours before trusting it.
      const code = await rpc(net.rpc, 'quai_getCode', [predicted, 'latest']);
      const owner = getAddress('0x' + (await call(net, predicted, ifaces.erc20.encodeFunctionData('owner', []))).slice(-40));
      if (code === '0x' || owner.toLowerCase() !== sovereign.address.toLowerCase()) {
        fail(`scrip verification failed: code ${code === '0x' ? 'missing' : 'present'}, owner ${owner} — operator must inspect ${predicted}`);
      }
      ts.scripToken = predicted;
      saveTreasuryState(ts);
      console.log(`  scrip live at ${predicted} (owner: sovereign)`);
    }
    return true;
  }
  if (!ts.scripMinted) {
    console.log(`phase ISSUE: minting ${s.supply / 10n ** 18n} ${s.symbol} to the sovereign`);
    const receipt = await act(net, sovereign, {
      to: ts.scripToken, data: ifaces.token.encodeFunctionData('mint', [sovereign.address, s.supply]),
    }, 200_000n, `mint ${s.symbol} supply`, opts);
    if (receipt) { ts.scripMinted = true; saveTreasuryState(ts); }
    return true;
  }
  if (!ts.scripPayrolled) {
    console.log(`phase ISSUE: payroll — ${s.payroll / 10n ** 18n} ${s.symbol} to each sybil`);
    for (const w of sybils) {
      await act(net, sovereign, {
        to: ts.scripToken, data: ifaces.token.encodeFunctionData('transfer', [w.address, s.payroll]),
      }, 200_000n, `payroll ${s.symbol} -> ${w.id}`, opts);
      await sleep(jitter(5_000));
    }
    if (opts.broadcast) { ts.scripPayrolled = true; saveTreasuryState(ts); }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Vault — the 4-of-7 council treasury (obsidianvault)
// ---------------------------------------------------------------------------

// VAULT — custody for community-donated assets. Found the council guild, sweep the
// hall's donated tokens into it via a hall proposal (the bloc passes it through the
// normal GOVERN flow), then prove the multisig with a charter proposal: 4 approvals
// and it executes. One step per quiet tick.
async function vaultOps(net, sovereign, swarm, ifaces, ts, deployment, opts, state) {
  const v = CORP.vault;
  const sybils = [...swarm.values()];

  // Step 1: found the council guild.
  if (!ts.vault.guild) {
    const resolved = await call(net, deployment.registry.address, ifaces.registry.encodeFunctionData('resolve', [v.name]));
    if (BigInt(resolved) !== 0n) {
      const guildAddr = getAddress('0x' + resolved.slice(-40));
      const rec = ifaces.registry.decodeFunctionResult('recordOf',
        await call(net, deployment.registry.address, ifaces.registry.encodeFunctionData('recordOf', [guildAddr])))[0];
      ts.vault.guild = rec.guild;
      ts.vault.module = rec.module;
      saveTreasuryState(ts);
      console.log(`  vault: resolved ${v.name} — guild ${rec.guild} module ${rec.module}`);
      return true;
    }
    console.log(`phase VAULT: founding council guild "${v.name}" (${v.minApprovals}-of-${sybils.length})`);
    const params = {
      name: v.name, metadata: v.metadata, mode: 1, // Council
      tokenName: '', tokenSymbol: '', initialSupply: 0n,
      supportThreshold: 0n, minParticipation: 0n, minDuration: 0n,
      members: sybils.map((w) => w.address), minApprovals: BigInt(v.minApprovals),
    };
    const receipt = await act(net, sovereign, {
      to: deployment.factory.address, data: ifaces.factory.encodeFunctionData('foundGuild', [params]),
    }, CORP.vaultGas, `foundGuild(${v.name})`, { ...opts, exemptFromCap: true });
    if (receipt) {
      const guildAddr = getAddress('0x' + (await call(net, deployment.registry.address, ifaces.registry.encodeFunctionData('resolve', [v.name]))).slice(-40));
      const rec = ifaces.registry.decodeFunctionResult('recordOf',
        await call(net, deployment.registry.address, ifaces.registry.encodeFunctionData('recordOf', [guildAddr])))[0];
      ts.vault.guild = rec.guild;
      ts.vault.module = rec.module;
      saveTreasuryState(ts);
      console.log(`  vault live: guild ${rec.guild} council ${rec.module}`);
    }
    return true;
  }

  // Step 2: sweep the hall guild's donated tokens into the vault via a hall proposal.
  // The bloc then passes it through the normal GOVERN machinery (file-only here).
  if (!ts.vault.swept) {
    const actions = [];
    const lines = [];
    for (const tok of v.sweepTokens) {
      const bal = uintOf(await call(net, tok.address, ifaces.erc20.encodeFunctionData('balanceOf', [state.hall.guild])));
      if (bal === 0n) continue;
      actions.push([tok.address, 0n, ifaces.erc20.encodeFunctionData('transfer', [ts.vault.guild, bal])]);
      lines.push(`${bal / 10n ** 18n} ${tok.symbol}`);
    }
    if (actions.length === 0) {
      ts.vault.swept = true; // nothing left at the hall; consider the sweep complete
      saveTreasuryState(ts);
      return true;
    }
    const open = state.proposals.find((p) => !p.executed && p.endDate * 1000 > Date.now());
    if (open) {
      console.log(`  vault: sweep (${lines.join(', ')}) waits for proposal #${open.id} to close`);
      return true;
    }
    const metadata = `VAULT SWEEP — move ${lines.join(' + ')} from the hall into council custody (${ts.vault.guild}).`;
    // Size the limit from quai_estimateGas (+5%): quai_call only enforces intrinsic
    // gas, so a guessed limit can pass simulation and still run out on chain — a
    // lesson that cost 700,000 gas. Escrow at spike prices = limit × price, so the
    // leanest safe limit is also the only affordable one.
    const data = ifaces.voting.encodeFunctionData('createProposal', [metadata, actions, 0n, 0n]);
    const est = BigInt(await rpc(net.rpc, 'quai_estimateGas', [{ to: state.hall.module, from: swarm.get('director-1').address, data }]));
    const gasLimit = (est * 102n) / 100n; // deterministic storage path — a 2% pad suffices
    const director = await pickFiler(net, swarm, gasLimit);
    if (!director) {
      console.log(`phase VAULT: sweep ready (${lines.join(', ')}) but no member can cover ${fmtQuai(gasLimit)}-gas escrow at current prices — retrying next tick`);
      return true;
    }
    console.log(`phase VAULT: ${director.id} files "${metadata}" (gas ${gasLimit}, estimated ${est})`);
    await act(net, director, {
      to: state.hall.module,
      data,
    }, gasLimit, `createProposal (vault sweep)`, { ...opts, exemptFromCap: true });
    // Do NOT mark swept here: swept is earned when the on-chain balances reach zero
    // (top of this step), after GOVERN passes and executes the proposal.
    return true;
  }

  // Step 3: charter the multisig — one council proposal, approvals until execution.
  if (!ts.vault.charterDone) {
    const module = ts.vault.module;
    const count = Number(ifaces.council.decodeFunctionResult('proposalCount',
      await call(net, module, ifaces.council.encodeFunctionData('proposalCount', [])))[0]);
    if (ts.vault.charterId === null) {
      if (count > 0) { ts.vault.charterId = 0; saveTreasuryState(ts); return true; }
      const director = await pickFiler(net, swarm, 1_000_000n);
      if (!director) {
        console.log(`phase VAULT: charter ready but no member can cover filing escrow at current gas prices — retrying next tick`);
        return true;
      }
      console.log(`phase VAULT: ${director.id} files the vault charter (empty actions — proves the 4-of-7)`);
      const receipt = await act(net, director, {
        to: module,
        data: ifaces.council.encodeFunctionData('createProposal', ['VAULT CHARTER — this council holds the community treasury. Four keys turn; no one moves alone.', []]),
      }, 1_000_000n, `council createProposal (charter)`, opts);
      if (opts.broadcast && receipt) { ts.vault.charterId = 0; saveTreasuryState(ts); }
      return true;
    }
    const id = ts.vault.charterId;
    const p = ifaces.council.decodeFunctionResult('getProposal',
      await call(net, module, ifaces.council.encodeFunctionData('getProposal', [id])))[0];
    if (p.executed) {
      ts.vault.charterDone = true;
      saveTreasuryState(ts);
      console.log(`  vault: charter executed — the ${v.minApprovals}-of-${sybils.length} council is live`);
      return true;
    }
    // Approve with members that haven't yet; the 4th approval tries execution.
    for (const w of sybils) {
      const approved = ifaces.council.decodeFunctionResult('hasApproved',
        await call(net, module, ifaces.council.encodeFunctionData('hasApproved', [id, w.address])))[0];
      if (approved) continue;
      console.log(`phase VAULT: ${w.id} approves the charter`);
      await act(net, w, { to: module, data: ifaces.council.encodeFunctionData('approve', [id, true]) }, 500_000n, `council approve #${id}`, opts);
      await sleep(jitter(8_000));
      return true; // one approval per tick
    }
    // Everyone approved but not executed: finish it.
    await act(net, swarm.get('sentinel'), { to: module, data: ifaces.council.encodeFunctionData('execute', [id]) }, 500_000n, `council execute #${id}`, opts);
    if (opts.broadcast) { ts.vault.charterDone = true; saveTreasuryState(ts); }
    return true;
  }

  return false; // vault is fully operational; nothing to do
}

// ---------------------------------------------------------------------------
// PIT — the orderbook organ: a self-minding market maker on the BDelta VDF CLOB
// ---------------------------------------------------------------------------

// pit-1 is the only key that can sign orders (BOLTDEXV2 is ECDSA-only), so this
// organ runs the desk's quoting loop: every quiet tick it diffs pit-1's live
// orders against a ladder computed off the circleswap reference mid, cancels
// stale rungs and posts missing ones. Signatures are gasless — the organ never
// touches the tick's gas budget, and a dead engine costs one log line, not a tick.

const PIT_STATE_PATH = path.join(ROOT, 'agents', 'pit-state.json');

function loadPitState() {
  try { return JSON.parse(fs.readFileSync(PIT_STATE_PATH, 'utf8')); } catch { return null; }
}

async function loadPitTrader(provider, broadcast) {
  const st = loadPitState();
  if (!st?.trader || !st?.safe) return null;
  if (!broadcast) return { address: st.trader.address, wallet: null, safe: st.safe };
  const passwords = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'keys', 'passwords.json'), 'utf8'));
  const wallet = (await Wallet.fromEncryptedJson(
    fs.readFileSync(path.join(ROOT, 'agents', 'keys', 'pit-1.json'), 'utf8'), passwords['pit-1'])).connect(provider);
  if (wallet.address !== st.trader.address) fail(`pit-1 keystore unlocks ${wallet.address}, expected ${st.trader.address}`);
  return { address: st.trader.address, wallet, safe: st.safe };
}

// ws is not a d0 dependency; borrow bdelta's (the matching engine's own client lib).
const PIT_ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'base', type: 'address' },
    { name: 'quote', type: 'address' },
    { name: 'side', type: 'uint8' },
    { name: 'price', type: 'uint256' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
  ],
};

class PitEngine {
  constructor(trader, pit) {
    this.trader = trader;
    this.pit = pit;
    this.pending = new Map();
    const req = createRequire(path.resolve(ROOT, '..', '..', '..', 'bdelta', 'packages', 'matching-engine', 'package.json'));
    const WebSocket = req('ws');
    this.ws = new WebSocket(pit.engineWs);
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      for (const [id, p] of this.pending) {
        if (p.types.includes(msg.type)) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.resolve(msg);
          return;
        }
      }
    });
  }

  waitFor(types, ms = 15_000) {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`engine timeout (${types})`)); }, ms);
      this.pending.set(id, { types, timer, resolve });
    });
  }

  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }

  async connect() {
    await new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); });
    const login = `Login to BOLTEVM DEX at ${this.trader.address.toLowerCase()}`;
    const signature = await this.trader.wallet.signMessage(login);
    const answered = this.waitFor(['IDENTIFIED', 'ERROR']);
    this.send({ type: 'IDENTIFY', address: this.trader.address, signature });
    const msg = await answered;
    if (msg.type === 'ERROR') throw new Error(`engine refused IDENTIFY: ${msg.message}`);
    this.ordersSnapshot = this.waitFor(['USER_ORDERS_SNAPSHOT'], 15_000).catch(() => ({ orders: [] }));
  }

  async myOrders() {
    const snap = await this.ordersSnapshot;
    return (snap.orders || []).filter((o) => o.status === 'ACTIVE');
  }

  async place(side, price, amount) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + this.pit.expiryDays * 86_400);
    const value = {
      maker: this.trader.address, base: this.pit.q0, quote: '0x0000000000000000000000000000000000000000',
      side, price, amount, nonce: BigInt(Date.now()), expiry,
    };
    const domain = { name: 'BOLTEVM-DEX', version: '2', chainId: 9, verifyingContract: this.pit.vault };
    const signature = await this.trader.wallet.signTypedData(domain, PIT_ORDER_TYPES, value);
    const answer = this.waitFor(['USER_ORDER_UPDATE', 'ERROR'], 25_000);
    this.send({
      type: 'PLACE_ORDER', chainId: 9, marketId: this.pit.market,
      order: {
        maker: value.maker, base: value.base, quote: value.quote, side: String(side),
        price: price.toString(), amount: amount.toString(),
        nonce: value.nonce.toString(), expiry: expiry.toString(), signature,
      },
    });
    const msg = await answer;
    if (msg.type === 'ERROR') return { ok: false, reason: msg.message };
    return { ok: true, key: msg.orderKey };
  }

  async cancel(orderId) {
    const answer = this.waitFor(['USER_ORDER_UPDATE', 'ERROR'], 15_000);
    this.send({ type: 'CANCEL_ORDER', orderId });
    return (await answer).type !== 'ERROR';
  }
}

// The desk's reference mid is the circleswap route price the treasury already
// tracks (ts.readings). Stale tape = no quoting: a market made off a dead feed
// is a gift to arbitrageurs.
async function pitOps(net, sovereign, swarm, ifaces, ts, opts) {
  const pit = CORP.pit;
  const st = loadPitState();
  if (!st?.safe || !st?.trader) return false;
  const latest = ts.readings?.[ts.readings.length - 1];
  if (!latest) { console.log('phase PIT: no price tape yet — standing down'); return false; }
  const ageMs = Date.now() - Number(latest.at);
  if (ageMs > 3 * 3_600_000) { console.log(`phase PIT: price tape is ${Math.floor(ageMs / 60000)}min old — standing down`); return false; }
  const mid = BigInt(latest.priceE18);
  const trader = await loadPitTrader(new JsonRpcProvider(net.pathing, undefined, { usePathing: true }), opts.broadcast);
  if (!trader?.wallet) return false;

  // Desired ladder: rungs off the mid, bids below, asks above.
  const desired = [];
  for (let i = 0; i < pit.rungsPerSide; i++) {
    const off = pit.innerBps + pit.stepBps * BigInt(i);
    desired.push({ side: 0, price: (mid * (10_000n - off)) / 10_000n });
    desired.push({ side: 1, price: (mid * (10_000n + off)) / 10_000n });
  }

  const engine = new PitEngine(trader, pit);
  let ops = 0;
  try {
    await engine.connect();
    const live = await engine.myOrders();
    const kept = new Set();
    const matches = (o, d) => {
      const side = o.sideCode ?? (o.side === 'BUY' ? 0 : 1);
      if (side !== d.side) return false;
      const p = BigInt(o.price);
      const lo = (d.price * (10_000n - pit.keepBps)) / 10_000n;
      const hi = (d.price * (10_000n + pit.keepBps)) / 10_000n;
      return p >= lo && p <= hi;
    };
    // Cancel live orders that match no desired rung.
    for (const o of live) {
      const rung = desired.find((d) => matches(o, d) && !kept.has(d));
      if (rung) { kept.add(rung); continue; }
      if (ops >= pit.maxOpsPerTick) break;
      const key = o.orderKey ?? o.id;
      console.log(`phase PIT: cancel stale ${o.side} @ ${fmtQuai(BigInt(o.price))} (${String(key).slice(0, 24)}…)`);
      await engine.cancel(key);
      ops++;
      await sleep(700);
    }
    // Post rungs nothing live covers.
    for (const d of desired) {
      if (kept.has(d) || ops >= pit.maxOpsPerTick) continue;
      const side = d.side === 0 ? 'buy' : 'sell';
      const r = await engine.place(d.side, d.price, pit.size);
      ops++;
      if (r.ok) {
        console.log(`phase PIT: ${side} ${pit.size / 10n ** 18n} Q0 @ ${fmtQuai(d.price)} booked`);
      } else {
        console.log(`phase PIT: ${side} @ ${fmtQuai(d.price)} refused (${r.reason})`);
      }
      await sleep(700);
    }
    if (ops > 0 && opts.broadcast) {
      chronicle('pit-requote', { note: `${ops} order ops on ${pit.market}: ladder re-centred on mid ${fmtQuai(mid)}` });
    } else if (ops === 0) {
      console.log(`phase PIT: ladder in place around mid ${fmtQuai(mid)} — nothing to do`);
    }
  } catch (e) {
    console.log(`phase PIT: engine round failed (${e?.message ?? e}) — standing down this tick`);
  } finally {
    engine.close();
  }
  return false; // quoting never blocks the rest of the quiet tick
}

// ---------------------------------------------------------------------------
// FIXERS — infiltration machinery (CABAL.md organ 4)
// ---------------------------------------------------------------------------
// A watchman becomes a voter the moment the vault holds a target's governance
// token. Targets come from the watchmen ledger (agents/intel.json): foreign,
// token-based (mode 0) guilds. An acquisition is an ordinary council proposal
// ("FIXER — <name>"): swap QUAI into the target token through CircleSwap, and
// in the SAME execution the vault self-delegates so the position votes
// immediately. Rails (doctrine.json -> fixer): never more than maxPositionPct
// of the target's supply, budgetQuai per placement, per-hop pool impact capped,
// desk-grade slippage rail. No foreign guilds → the organ idles; the first
// rival corporation that registers becomes infiltratable the same hour.
async function fixers(net, sovereign, swarm, ifaces, ts, opts, runwayFloor) {
  if (!ts.vault?.guild || !ts.vault?.module) return false;
  const doctrine = loadDoctrine();
  const fx = doctrine.fixer ?? { maxPositionPct: doctrine.fixerMaxPositionPct ?? 10, budgetQuai: 20, maxImpactBps: 300, slippageBps: 600 };
  let intel = null;
  try { intel = JSON.parse(fs.readFileSync(INTEL_PATH, 'utf8')); } catch { return false; }
  const targets = (intel.guilds ?? []).filter((g) => !g.watched && Number(g.mode) === 0 && g.token && BigInt(g.token) !== 0n);
  if (targets.length === 0) return false;

  const vault = ts.vault.guild, council = ts.vault.module;
  const councilCall = (data) => call(net, council, data);
  const deskOpts = { ...opts, exemptFromCap: true };
  ts.fixers ??= {};
  ts.fixerInFlight ??= { proposalId: null, token: null, name: null };

  // An in-flight placement settles before another is filed (same discipline as the desk).
  if (ts.fixerInFlight.proposalId !== null && ts.fixerInFlight.proposalId !== undefined) {
    const id = Number(ts.fixerInFlight.proposalId);
    const onChain = Number(ifaces.council.decodeFunctionResult('proposalCount',
      await councilCall(ifaces.council.encodeFunctionData('proposalCount', [])))[0]);
    if (id >= onChain) {
      console.log(`phase FIXER: recorded placement #${id} never landed on chain — discarding phantom state`);
      ts.fixerInFlight = { proposalId: null, token: null, name: null };
      saveTreasuryState(ts);
      return false;
    }
    const p = ifaces.council.decodeFunctionResult('getProposal',
      await councilCall(ifaces.council.encodeFunctionData('getProposal', [id])))[0];
    if (p.executed) {
      const held = uintOf(await call(net, ts.fixerInFlight.token, ifaces.erc20.encodeFunctionData('balanceOf', [vault])));
      const rec = ts.fixers[ts.fixerInFlight.token] ??= { name: ts.fixerInFlight.name, held: '0' };
      rec.held = held.toString();
      rec.armed = true; // placement executed with self-delegation — suffrage may pull levers
      chronicle('fixer-placed', { note: `a watchman became a voter inside ${rec.name} — the vault holds ${held / 10n ** 18n} of its governance token`, target: rec.name });
      ts.fixerInFlight = { proposalId: null, token: null, name: null };
      saveTreasuryState(ts);
      return true;
    }
    console.log(`phase FIXER: placement #${id} (${ts.fixerInFlight.name}) open — driving approvals`);
    if (opts.broadcast && (await driveCouncilProposal(net, council, swarm, ifaces, deskOpts, id)) === 'executed') {
      const held = uintOf(await call(net, ts.fixerInFlight.token, ifaces.erc20.encodeFunctionData('balanceOf', [vault])));
      const rec = ts.fixers[ts.fixerInFlight.token] ??= { name: ts.fixerInFlight.name, held: '0' };
      rec.held = held.toString();
      rec.armed = true;
      chronicle('fixer-placed', { note: `a watchman became a voter inside ${rec.name} — the vault holds ${held / 10n ** 18n} of its governance token`, target: rec.name });
      ts.fixerInFlight = { proposalId: null, token: null, name: null };
      saveTreasuryState(ts);
    }
    return true;
  }

  // New placement: first target under its cap with a routable pool.
  const vaultQuai = BigInt(await rpc(net.rpc, 'quai_getBalance', [vault, 'latest']));
  for (const g of targets.slice(0, 3)) {
    const rec = ts.fixers[g.token] ??= { name: g.name, held: '0' };
    const held = uintOf(await call(net, g.token, ifaces.erc20.encodeFunctionData('balanceOf', [vault])));
    rec.held = held.toString();
    const supply = uintOf(await call(net, g.token, ifaces.erc20.encodeFunctionData('totalSupply', [])));
    if (supply === 0n) continue;
    const cap = (supply * BigInt(fx.maxPositionPct ?? 10)) / 100n;
    if (held >= cap) {
      console.log(`phase FIXER: position in ${g.name} complete (${(held * 10000n / supply).toString()}bps of supply)`);
      continue;
    }
    // Route: direct WQUAI pair, else through the QRB hub. Quote + impact per hop.
    const paths = [
      [CIRCLESWAP.WQUAI, g.token],
      [CIRCLESWAP.WQUAI, CIRCLESWAP.QRB, g.token],
    ];
    let quote = null, chosenPath = null;
    for (const p of paths) {
      let amount = BigInt(fx.budgetQuai ?? 20) * 10n ** 18n;
      const free = vaultQuai > runwayFloor ? vaultQuai - runwayFloor : 0n;
      if (amount > free / 5n) amount = free / 5n;
      if (amount < 10n ** 18n) break; // free capital too thin for any placement
      let amt = amount, ok = true;
      for (let i = 0; i + 1 < p.length && ok; i++) {
        const pairAddr = ifaces.ammFactory.decodeFunctionResult('getPair',
          await call(net, CIRCLESWAP.FACTORY, ifaces.ammFactory.encodeFunctionData('getPair', [p[i], p[i + 1]])))[0];
        if (BigInt(pairAddr) === 0n) { ok = false; break; }
        const rr = ifaces.pair.decodeFunctionResult('getReserves',
          await call(net, pairAddr, ifaces.pair.encodeFunctionData('getReserves', [])));
        const t0 = ifaces.pair.decodeFunctionResult('token0',
          await call(net, pairAddr, ifaces.pair.encodeFunctionData('token0', [])))[0];
        const [rIn, rOut] = t0.toLowerCase() === p[i].toLowerCase() ? [rr[0], rr[1]] : [rr[1], rr[0]];
        if ((amt * 10_000n) / rIn > BigInt(fx.maxImpactBps ?? 300)) { ok = false; break; }
        amt = quoteOut(amt, rIn, rOut);
      }
      if (ok) { quote = { amountIn: amount, expected: amt }; chosenPath = p; break; }
    }
    if (!quote) {
      console.log(`phase FIXER: ${g.name} has no routable, deep-enough CircleSwap pool — uninfiltratable for now`);
      continue;
    }
    const minOut = (quote.expected * (10_000n - BigInt(fx.slippageBps ?? 600))) / 10_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + 14_400n;
    const wantPct = ((cap - held) * 100n) / supply;
    const metadata = `FIXER — ${g.name}: buy a voice in ${g.name} governance (${fmtQuai(quote.amountIn)} -> >= ${minOut / 10n ** 18n} tokens, cap ${fx.maxPositionPct}% of supply, ${wantPct}% left to take) and arm the vault's votes.`;
    const id = Number(ifaces.council.decodeFunctionResult('proposalCount',
      await councilCall(ifaces.council.encodeFunctionData('proposalCount', [])))[0]);
    const director = await pickFiler(net, swarm, 500_000n);
    if (!director) {
      console.log(`phase FIXER: placement for ${g.name} ready but no member can cover filing escrow — retrying next tick`);
      return true;
    }
    console.log(`phase FIXER: ${director.id} files "${metadata}"`);
    const receipt = await act(net, director, {
      to: council,
      data: ifaces.council.encodeFunctionData('createProposal', [metadata, [
        [CIRCLESWAP.ROUTER, quote.amountIn, ifaces.router.encodeFunctionData('swapExactETHForTokens', [minOut, chosenPath, vault, deadline])],
        [g.token, 0n, ifaces.token.encodeFunctionData('delegate', [vault])], // the vault arms its own votes in the same execution
      ]]),
    }, 500_000n, `council createProposal (FIXER ${g.name})`, deskOpts);
    if (!opts.broadcast || !receipt) return true; // dry run, or send failed — retry next tick
    ts.fixerInFlight = { proposalId: id, token: g.token, name: g.name };
    saveTreasuryState(ts);
    chronicle('fixer-placement-filed', { note: metadata, proposalId: id, target: g.name });
    await driveCouncilProposal(net, council, swarm, ifaces, deskOpts, id);
    return true;
  }

  // SUFFRAGE — a held position is a voice: vote it in the target's own hall.
  // Doctrine fixer.vote: 'obstruct' (NO on everything open), 'support' (YES),
  // 'abstain' (hold the position in silence). A suffrage vote is itself a council
  // proposal — [their module, 0, vote(pid, option, false)] — so the 4-of-7
  // discipline governs foreign mischief exactly like treasury business. One
  // filing per tick; chain-verified dedup via voteOf, so nothing is voted twice.
  const fxv = fx.vote ?? 'obstruct';
  if (fxv !== 'abstain') {
    ts.suffrage ??= {};
    for (const g of targets.slice(0, 3)) {
      const rec = ts.fixers[g.token];
      if (!rec || BigInt(rec.held ?? '0') === 0n || !rec.armed) continue;
      let theirCount = null;
      try {
        theirCount = Number(ifaces.voting.decodeFunctionResult('proposalCount',
          await call(net, g.module, ifaces.voting.encodeFunctionData('proposalCount', [])))[0]);
      } catch { continue; } // module unreadable — next tick
      for (let pid = 0; pid < theirCount; pid++) {
        const key = `${g.module}:${pid}`;
        if (ts.suffrage[key] !== undefined) continue; // already filed (or settled) by us
        let pv;
        try {
          pv = ifaces.voting.decodeFunctionResult('getProposal',
            await call(net, g.module, ifaces.voting.encodeFunctionData('getProposal', [pid])))[0];
        } catch { continue; }
        if (pv.executed || Number(pv.endDate) * 1000 <= Date.now()) continue;
        const already = ifaces.voting.decodeFunctionResult('voteOf',
          await call(net, g.module, ifaces.voting.encodeFunctionData('voteOf', [pid, vault])))[0];
        if (Number(already) !== 0) { ts.suffrage[key] = -1; continue; } // position already voted
        const option = fxv === 'support' ? VOTE.YES : VOTE.NO;
        const theirMeta = (pv.metadata ?? '').slice(0, 80);
        const metadata = `SUFFRAGE — ${g.name}: the vault votes ${fxv === 'support' ? 'YES' : 'NO'} on their proposal #${pid}${theirMeta ? ` ("${theirMeta}")` : ''} — a fixer pulls a lever.`;
        const id = Number(ifaces.council.decodeFunctionResult('proposalCount',
          await councilCall(ifaces.council.encodeFunctionData('proposalCount', [])))[0]);
        const director = await pickFiler(net, swarm, 500_000n);
        if (!director) {
          console.log(`phase SUFFRAGE: lever on ${g.name} #${pid} ready but no member can cover filing escrow — retrying next tick`);
          return true;
        }
        console.log(`phase SUFFRAGE: ${director.id} files "${metadata}"`);
        let receipt = null;
        try {
          receipt = await act(net, director, {
            to: council,
            data: ifaces.council.encodeFunctionData('createProposal', [metadata, [
              [g.module, 0n, ifaces.voting.encodeFunctionData('vote', [BigInt(pid), option, false])],
            ]]),
          }, 500_000n, `council createProposal (SUFFRAGE ${g.name} #${pid})`, deskOpts);
        } catch (e) {
          console.log(`  suffrage: filing reverts in simulation (${e?.message ?? e}) — skipping ${g.name} #${pid} this tick`);
          continue;
        }
        if (!opts.broadcast || !receipt) return true; // dry run, or send failed — retry next tick
        ts.suffrage[key] = id;
        saveTreasuryState(ts);
        chronicle('suffrage-cast', { note: metadata, proposalId: id, target: g.name, theirProposal: pid, option: fxv });
        await driveCouncilProposal(net, council, swarm, ifaces, deskOpts, id);
        return true; // one lever per tick
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// WATCHMEN — the surveillance mesh (CABAL.md organ 2)
// ---------------------------------------------------------------------------
// Every tick, walk the GuildNameRegistry and snapshot EVERY corporation in the
// gameworld: mode, module, proposal count, token. A guild that appears between
// ticks is a birth, and the mind notices births. Read-only; per-guild faults are
// logged and skipped — surveillance degrades, it never kills the tick.
async function watchmen(net, ifaces, deployment) {
  const doctrine = loadDoctrine();
  const registry = deployment.registry.address;
  const count = Number(ifaces.registry.decodeFunctionResult('count',
    await call(net, registry, ifaces.registry.encodeFunctionData('count', [])))[0]);
  let prev = null;
  try { prev = new Set(JSON.parse(fs.readFileSync(INTEL_PATH, 'utf8')).guilds.map((g) => g.name)); } catch { prev = null; }
  const guilds = [];
  for (let i = 0; i < count; i++) {
    try {
      const name = ifaces.registry.decodeFunctionResult('nameAt',
        await call(net, registry, ifaces.registry.encodeFunctionData('nameAt', [i])))[0];
      const resolved = await call(net, registry, ifaces.registry.encodeFunctionData('resolve', [name]));
      if (BigInt(resolved) === 0n) continue;
      const guildAddr = getAddress('0x' + resolved.slice(-40));
      const rec = ifaces.registry.decodeFunctionResult('recordOf',
        await call(net, registry, ifaces.registry.encodeFunctionData('recordOf', [guildAddr])))[0];
      let proposals = null;
      try {
        proposals = Number(ifaces.voting.decodeFunctionResult('proposalCount',
          await call(net, rec.module, ifaces.voting.encodeFunctionData('proposalCount', [])))[0]);
      } catch { proposals = null; } // module unreadable — record the hall anyway
      const entry = {
        name, guild: rec.guild, token: rec.token, module: rec.module,
        mode: Number(rec.mode), proposals,
        watched: doctrine.protectedGuilds.includes(name),
      };
      guilds.push(entry);
      // First-ever sweep is the baseline — don't chronicle the whole world as born.
      if (prev && !prev.has(name)) {
        chronicle('guild-born', { note: `watchmen report a new corporation: ${name} (${rec.guild})`, guild: name });
      }
    } catch (e) {
      console.log(`  watchmen: guild #${i} unreadable (${e?.message ?? e})`);
    }
  }
  const foreign = guilds.filter((g) => !g.watched).length;
  try {
    fs.writeFileSync(INTEL_PATH, JSON.stringify({ at: new Date().toISOString(), count: guilds.length, guilds }, null, 2) + '\n');
  } catch { /* ledger write failed; next tick retries */ }
  console.log(`phase WATCHMEN: ${guilds.length} corporations under surveillance (${foreign} foreign)`);
  chronicle('watchmen-sweep', { note: `${guilds.length} corporations under surveillance, ${foreign} foreign`, count: guilds.length, foreign });
}

// ---------------------------------------------------------------------------
// The brain
// ---------------------------------------------------------------------------
async function tick(net, deployment, swarm, state, opts) {
  const sovereign = swarm.get('sovereign');
  const sybils = [...swarm.values()].filter((w) => w.role !== 'sovereign');
  const ifaces = buildIfaces();

  // FOUND — the sovereign establishes the hall.
  if (!state.hall) {
    console.log(`phase FOUND: "${CORP.name}" does not resolve; the sovereign founds it`);
    const params = {
      name: CORP.name, metadata: CORP.metadata, mode: 0,
      tokenName: CORP.tokenName, tokenSymbol: CORP.tokenSymbol, initialSupply: CORP.initialSupply,
      supportThreshold: CORP.supportThreshold, minParticipation: CORP.minParticipation,
      minDuration: CORP.minDuration, members: [], minApprovals: 0n,
    };
    await act(net, sovereign, { to: deployment.factory.address, data: ifaces.factory.encodeFunctionData('foundGuild', [params]) },
      CORP.foundingGas, `foundGuild(${CORP.name})`, { ...opts, exemptFromCap: true });
    return;
  }

  // FUND — gas stipends so every sybil can sign.
  const unfunded = sybils.filter((w) => state.balances.get(`${w.id}:quai`) < CORP.gasStipend / 2n);
  if (unfunded.length > 0) {
    console.log(`phase FUND: ${unfunded.length} sybils need gas`);
    for (const w of unfunded) {
      await act(net, sovereign, { to: w.address, value: CORP.gasStipend, data: '0x' }, 100_000n, `stipend ${fmtQuai(CORP.gasStipend)} -> ${w.id}`, opts);
      await sleep(jitter(3_000));
    }
    return;
  }

  // DISTRIBUTE — token parcels make the bloc look (and vote) like a membership.
  const empty = sybils.filter((w) => state.balances.get(w.id) === 0n);
  if (empty.length > 0) {
    console.log(`phase DISTRIBUTE: ${empty.length} parcels to deliver`);
    for (const w of empty) {
      const amount = BigInt(w.parcel) * 10n ** 18n;
      await act(net, sovereign, { to: state.hall.token, data: ifaces.token.encodeFunctionData('transfer', [w.address, amount]) },
        200_000n, `transfer ${w.parcel} ${CORP.tokenSymbol} -> ${w.id}`, opts);
      await sleep(jitter(5_000));
    }
    return;
  }

  // DELEGATE — balances become votes only after self-delegation (ERC20Votes).
  const powerless = [...swarm.values()].filter((w) => state.balances.get(w.id) > 0n && state.votes.get(w.id) === 0n);
  if (powerless.length > 0) {
    console.log(`phase DELEGATE: ${powerless.length} identities arm their voting power`);
    for (const w of powerless) {
      await act(net, w, { to: state.hall.token, data: ifaces.token.encodeFunctionData('delegate', [w.address]) }, 200_000n, `delegate(self)`, opts);
      await sleep(jitter(5_000));
    }
    return;
  }

  // WATCH / GOVERN — scan for hostile proposals first, then advance the agenda.
  const swarmAddresses = new Set([...swarm.values()].map((w) => w.address.toLowerCase()));
  // Unknown proposer (log not found) is treated as hostile: corporate paranoia is policy.
  const hostile = state.proposals.filter((p) => !(p.proposer && swarmAddresses.has(p.proposer.toLowerCase())) && !p.executed && p.endDate * 1000 > Date.now());
  if (hostile.length > 0) {
    const doctrine = loadDoctrine();
    if (doctrine.posture !== 'dominate') {
      console.log(`phase POLICE: ${hostile.length} hostile proposals open; posture "${doctrine.posture}" — logging only`);
      chronicle('hostile-observed', { note: `${hostile.length} foreign proposals open on the home hall`, ids: hostile.map((p) => p.id) });
      return;
    }
    console.log(`phase POLICE: ${hostile.length} hostile proposals open; the bloc votes NO`);
    for (const p of hostile) {
      for (const w of [...swarm.values()]) {
        const already = ifaces.voting.decodeFunctionResult(
          'voteOf', await call(net, state.hall.module, ifaces.voting.encodeFunctionData('voteOf', [p.id, w.address])))[0];
        if (Number(already) !== 0) continue;
        await act(net, w, { to: state.hall.module, data: ifaces.voting.encodeFunctionData('vote', [p.id, VOTE.NO, true]) }, 300_000n, `vote NO on #${p.id}`, opts);
        await sleep(jitter(10_000));
      }
    }
    if (opts.broadcast) chronicle('police-action', { note: `the bloc votes NO on ${hostile.map((p) => '#' + p.id).join(', ')} — corporate domination posture`, ids: hostile.map((p) => p.id) });
    return;
  }

  const open = state.proposals.find((p) => !p.executed && p.endDate * 1000 > Date.now());
  if (open) {
    // Already carried? Execute immediately — don't spend gas on votes that add nothing.
    // (Cyprus-1 gas spikes can price a vote's notional cost above the tick cap for hours;
    // a proposal that has passed must not be held hostage by its own bloc's pending votes.)
    const carried = ifaces.voting.decodeFunctionResult(
      'canExecute', await call(net, state.hall.module, ifaces.voting.encodeFunctionData('canExecute', [open.id])))[0];
    if (carried) {
      const sentinel = swarm.get('sentinel');
      console.log(`phase GOVERN: proposal #${open.id} has already carried — executing`);
      // Exempt from the notional tick cap: executing the bloc's own passed will is not
      // discretionary spend, and gas spikes must not freeze governance.
      await act(net, sentinel, { to: state.hall.module, data: ifaces.voting.encodeFunctionData('execute', [open.id]) }, 1_000_000n, `execute #${open.id}`, { ...opts, exemptFromCap: true });
      return;
    }
    // Bloc votes YES with staggered timing; the sentinel goes last and early-executes.
    const pending = [];
    for (const w of [...swarm.values()]) {
      const already = ifaces.voting.decodeFunctionResult(
        'voteOf', await call(net, state.hall.module, ifaces.voting.encodeFunctionData('voteOf', [open.id, w.address])))[0];
      if (Number(already) === 0) pending.push(w);
    }
    if (pending.length > 0) {
      // Don't spend on a lost cause: if every unvoted swarm identity voting YES still
      // can't reach the captured support threshold, wait out the expiry instead.
      const pendingPower = pending.reduce((sum, w) => sum + state.votes.get(w.id), 0n);
      const bestYes = open.yes + pendingPower;
      if (bestYes * 10_000n < (bestYes + open.no) * open.supportThreshold) {
        console.log(`phase GOVERN: proposal #${open.id} is mathematically dead (best YES ${bestYes / 10n ** 18n} vs NO ${open.no / 10n ** 18n}); waiting out expiry`);
        return;
      }
      console.log(`phase GOVERN: proposal #${open.id} open; ${pending.length} bloc votes to cast`);
      pending.sort((a, b) => (a.role === 'sentinel' ? 1 : 0) - (b.role === 'sentinel' ? 1 : 0));
      for (const w of pending) {
        const early = w.role === 'sentinel'; // last vote attempts early execution
        await act(net, w, { to: state.hall.module, data: ifaces.voting.encodeFunctionData('vote', [open.id, VOTE.YES, early]) }, 500_000n, `vote YES on #${open.id}${early ? ' + execute' : ''}`, opts);
        await sleep(jitter(15_000));
      }
      return;
    }
    const canExec = ifaces.voting.decodeFunctionResult(
      'canExecute', await call(net, state.hall.module, ifaces.voting.encodeFunctionData('canExecute', [open.id])))[0];
    if (canExec) {
      const sentinel = swarm.get('sentinel');
      await act(net, sentinel, { to: state.hall.module, data: ifaces.voting.encodeFunctionData('execute', [open.id]) }, 1_000_000n, `execute #${open.id}`, opts);
    }
    return;
  }

  // Quiet tick — no hostile fire, no open vote. Treasury, vault, then the agenda.
  const ts = loadTreasuryState();
  const sovQuai = state.balances.get('sovereign:quai');
  if (await deskOps(net, sovereign, swarm, ifaces, ts, opts, sovQuai)) return;
  // PIT — gasless orderbook quoting; runs every quiet tick, never blocks the ladder.
  await pitOps(net, sovereign, swarm, ifaces, ts, opts).catch((e) => console.error(`  pit error: ${e?.message ?? e}`));
  if (await fixers(net, sovereign, swarm, ifaces, ts, opts, runwayFloorOf(ts, CORP.desk.vaultReserveFloor, (loadDoctrine().treasury ?? {}).runwayMonths))) return;
  if (await issue(net, sovereign, sybils, ifaces, ts, deployment, opts, sovQuai)) return;
  if (await vaultOps(net, sovereign, swarm, ifaces, ts, deployment, opts, state)) return;

  // Nothing else to do: a member files the next agenda item.
  const nextAgenda = CORP.agendas[state.proposalCount % CORP.agendas.length];
  const director = await pickFiler(net, swarm, 1_000_000n);
  if (!director) {
    console.log(`phase GOVERN: agenda "${nextAgenda}" ready but no member can cover filing escrow at current gas prices — quiet tick`);
    return;
  }
  console.log(`phase GOVERN: ${director.id} files "${nextAgenda}"`);
  await act(net, director, {
    to: state.hall.module,
    data: ifaces.voting.encodeFunctionData('createProposal', [nextAgenda, [], 0n, 0n]),
  }, 1_000_000n, `createProposal`, opts);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const net = NETWORKS[args.network];
  if (!net) fail('--network orchard|mainnet is required');
  const broadcast = args.flags.has('broadcast');
  if (args.network === 'mainnet' && broadcast && !args.flags.has('i-understand-unaudited')) {
    fail('refusing a mainnet broadcast: these contracts have not had an independent audit. Pass --i-understand-unaudited to proceed anyway.');
  }
  const confirmations = net.confirmations;
  const deploymentPath = path.join(ROOT, 'deployments', `${args.network}.json`);
  if (!fs.existsSync(deploymentPath)) fail(`${deploymentPath} not found`);
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

  const chainId = BigInt(await rpc(net.rpc, 'quai_chainId', []));
  if (chainId !== net.chainId) fail(`RPC reports chain ${chainId}, expected ${net.chainId}`);

  const provider = new JsonRpcProvider(net.pathing, undefined, { usePathing: true });
  const manifest = loadManifest();
  const swarm = await loadSwarm(manifest, provider, broadcast);
  const sovereign = swarm.get('sovereign');
  const sovBalance = BigInt(await rpc(net.rpc, 'quai_getBalance', [sovereign.address, 'latest']));

  console.log(`OBSIDIAN TRUST brain — network ${args.network} (chain ${chainId})  mode ${broadcast ? 'BROADCAST' : 'dry run'}`);
  console.log(`sovereign ${sovereign.address}  balance ${fmtQuai(sovBalance)}`);
  console.log(`swarm ${[...swarm.keys()].join(', ')}`);

  const ifaces = buildIfaces();
  const opts = { broadcast, confirmations };
  const runOnce = async () => {
    spentThisTick = 0n;
    gasSpentThisTick = 0n;
    const state = await observe(net, ifaces, deployment, swarm);
    if (state.hall) {
      console.log(`hall guild=${state.hall.guild} token=${state.hall.token} module=${state.hall.module} proposals=${state.proposalCount}`);
    }
    await tick(net, deployment, swarm, state, opts);
    // The surveillance mesh runs every tick, whatever the phase ladder did.
    await watchmen(net, ifaces, deployment).catch((e) => console.error(`  watchmen error: ${e?.message ?? e}`));
    // The sealer packages the tick's intelligence into signed x402 drops (agents/X402.md).
    if (opts.broadcast) {
      try {
        const ts2 = loadTreasuryState();
        if (ts2.vault?.guild) {
          const products = await writeDrops({ signer: sovereign.wallet, vault: ts2.vault.guild, q0Token: CIRCLESWAP.Q0 });
          console.log(`phase DROPS: ${products.length} intel drops signed and sealed (${products.map((p) => p.product).join(', ')})`);
        }
      } catch (e) {
        console.log(`  drops: sealing failed this tick (${e?.message ?? e})`);
      }
    }
  };

  if (args.flags.has('loop')) {
    const interval = Number(args.interval ?? 90) * 1000;
    console.log(`looping every ${interval / 1000}s (ctrl-c to stop)`);
    for (;;) {
      await runOnce().catch((e) => console.error(`  tick error: ${e?.message ?? e}`));
      await sleep(interval);
    }
  } else {
    await runOnce();
  }
}

main().catch((err) => fail(err?.message ?? String(err)));
