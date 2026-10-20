#!/usr/bin/env node
/**
 * OBSIDIAN PIT — orderbook client for the BDelta VDF CLOB (BOLTDEXV2).
 *
 * pit-1 (the desk's hot key) deposits into the canonical Quai vault and signs
 * EIP-712 orders; the matching engine at wss://engine-delta.boltevm.com books
 * them and its relayer settles matches through the VDF commit-reveal gate.
 * Everything here is one key and a capped tranche — the DarkSafe pit vault
 * holds the reserve, and council custody never signs an order (BOLTDEXV2 is
 * ECDSA-only by design; no contract can be a maker).
 *
 * Commands (run from packages/contracts):
 *   node agents/orderbook.mjs balance                                   vault balances of pit-1
 *   node agents/orderbook.mjs deposit --quai 35 --q0 60000 --broadcast --i-understand-unaudited
 *   node agents/orderbook.mjs withdraw-request --quai 5 --q0 1000 --broadcast --i-understand-unaudited
 *   node agents/orderbook.mjs withdraw --broadcast --i-understand-unaudited   (after the delay, both assets)
 *   node agents/orderbook.mjs book [--depth 5]
 *   node agents/orderbook.mjs orders                                    my open orders
 *   node agents/orderbook.mjs place --side buy --price 0.0043 --amount 1500
 *   node agents/orderbook.mjs ladder                                    the desk's two-sided ladder
 *   node agents/orderbook.mjs cancel --id <orderKey>
 *
 * Order placement is gasless (a signature, not a transaction) — no --broadcast
 * flag needed for place/cancel; the signature IS the authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';
import {
  Wallet, JsonRpcProvider, QuaiTransaction, Interface, getAddress, parseUnits, formatUnits,
} from 'quais';

// ws resolution: prefer the matching-engine workspace checkout (dev machine),
// fall back to the brain's own node_modules (droplet runtime).
let WebSocket;
try {
  const wsRequire = createRequire(path.resolve(process.cwd(), '..', '..', '..', 'bdelta', 'packages', 'matching-engine', 'package.json'));
  WebSocket = wsRequire('ws');
} catch {
  WebSocket = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))('ws');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const RPC = 'https://rpc.quai.network/cyprus1';
const CHAIN_ID = 9;
const ENGINE_WS = process.env.ENGINE_WS_URL || 'wss://engine-delta.boltevm.com';
const VAULT = '0x00664ed083476f770E50B32aD488B15618acd589'; // canonical BOLTDEXV2 (chain 9)
const Q0 = '0x00325150094E51107a931980Fdfc3bB1a4C48379';
const NATIVE = '0x0000000000000000000000000000000000000000';
const MARKET = '9:Q0-QUAI';

const ORDER_TYPES = {
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
const DOMAIN = { name: 'BOLTEVM-DEX', version: '2', chainId: CHAIN_ID, verifyingContract: VAULT };

// The desk's market-making posture on 9:Q0-QUAI (whole-token units).
const LADDER = {
  bids: [
    { price: '0.0043000', amount: '1500' },
    { price: '0.0042950', amount: '1500' },
    { price: '0.0042900', amount: '1500' },
  ],
  asks: [
    { price: '0.0043200', amount: '1500' },
    { price: '0.0043300', amount: '1500' },
    { price: '0.0043400', amount: '1500' },
  ],
  expiryDays: 7,
};

const CHRONICLE_PATH = path.join(ROOT, 'agents', 'chronicle.jsonl');
function chronicle(event, details = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...details });
  try { fs.appendFileSync(CHRONICLE_PATH, line + '\n'); } catch { /* the diary never kills the mind */ }
  console.log(`  chronicle: ${event}${details.note ? ` — ${details.note}` : ''}`);
}

function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }

function parseArgs(argv) {
  const out = { flags: new Set(), _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (['broadcast', 'i-understand-unaudited', 'init'].includes(key)) out.flags.add(key);
    else if (['quai', 'q0', 'side', 'price', 'amount', 'depth', 'id', 'expiry-days'].includes(key)) out[key] = argv[++i];
    else fail(`unknown option ${a}`);
  }
  return out;
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
  return json.result;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const call = (to, data) => rpc('quai_call', [{ to, data }, 'latest']);

const vaultIface = new Interface([
  'function depositNative() payable',
  'function depositToken(address token, uint256 amount)',
  'function requestWithdraw(address token, uint256 amount)',
  'function withdraw(address token)',
  'function balances(address, address) view returns (uint256)',
  'function pendingWithdrawal(address, address) view returns (uint192 amount, uint64 readyBlock)',
]);
const erc20Iface = new Interface([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function approve(address, uint256) returns (bool)',
]);

async function loadTrader(provider, needWallet) {
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'pit-state.json'), 'utf8'));
  if (!st.trader) fail('no pit-1 trader — run obsidian-pit.mjs key first');
  if (!needWallet) return { address: st.trader.address, wallet: null };
  const passwords = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'keys', 'passwords.json'), 'utf8'));
  const wallet = (await Wallet.fromEncryptedJson(
    fs.readFileSync(path.join(ROOT, 'agents', 'keys', 'pit-1.json'), 'utf8'), passwords['pit-1'])).connect(provider);
  if (wallet.address !== st.trader.address) fail('pit-1 keystore mismatch');
  return { address: st.trader.address, wallet };
}

async function waitConfirmed(hash, confirmations = 3) {
  const deadline = Date.now() + 30 * 60_000;
  let seen = null;
  while (Date.now() < deadline) {
    const r = await rpc('quai_getTransactionReceipt', [hash]).catch(() => null);
    if (r?.blockNumber) {
      if (seen !== null && r.blockHash !== seen) console.log('  receipt moved block (reorg); recounting');
      seen = r.blockHash;
      const head = BigInt(await rpc('quai_blockNumber', []));
      if (Number(head - BigInt(r.blockNumber)) + 1 >= confirmations) {
        const again = await rpc('quai_getTransactionReceipt', [hash]);
        if (again?.blockHash === r.blockHash) return again;
      }
    }
    await sleep(4000);
  }
  throw new Error(`no confirmed receipt for ${hash} after 30 minutes`);
}

async function act(trader, tx, gasLimit, label, broadcast) {
  const simTx = { ...tx, from: trader.address, gas: '0x' + gasLimit.toString(16) };
  if (simTx.value !== undefined) simTx.value = '0x' + BigInt(simTx.value).toString(16);
  await rpc('quai_call', [simTx, 'latest']);
  console.log(`  [pit-1] ${label}: simulates cleanly`);
  if (!broadcast) return null;
  const pop = await trader.wallet.populateQuaiTransaction({ ...tx, from: trader.address, gasLimit });
  const signed = await trader.wallet.signTransaction(QuaiTransaction.from(pop));
  const zone = await trader.wallet.zoneFromAddress(trader.address);
  let resp;
  try {
    resp = await trader.wallet.provider.broadcastTransaction(zone, signed, trader.address);
  } catch (e) {
    if (/insufficient funds/i.test(e?.message ?? '')) {
      console.log(`  [pit-1] ${label}: skipped (cannot cover intrinsic cost at current gas prices)`);
      return null;
    }
    throw e;
  }
  console.log(`  [pit-1] ${label}: sent ${resp.hash}`);
  const receipt = await waitConfirmed(resp.hash);
  if (parseInt(receipt.status, 16) !== 1) fail(`${label} reverted (tx ${resp.hash})`);
  console.log(`  [pit-1] ${label}: confirmed in block ${parseInt(receipt.blockNumber, 16)}`);
  return receipt;
}

async function estimate(from, tx, padNum = 120n) {
  const simTx = { ...tx, from };
  if (simTx.value !== undefined) simTx.value = '0x' + BigInt(simTx.value).toString(16);
  const est = BigInt(await rpc('quai_estimateGas', [simTx]));
  return (est * padNum) / 100n;
}

// ---------------------------------------------------------------------------
// Engine WebSocket session
// ---------------------------------------------------------------------------

class Engine {
  constructor(trader) { this.trader = trader; this.pending = new Map(); }

  async connect() {
    this.ws = new WebSocket(ENGINE_WS);
    this.ws.on('message', (raw) => this.onMessage(JSON.parse(raw.toString())));
    await new Promise((res, rej) => {
      this.ws.on('open', res);
      this.ws.on('error', rej);
    });
    // IDENTIFY: personal-sign the engine's login string.
    const address = this.trader.address.toLowerCase();
    const signature = await this.trader.wallet.signMessage(`Login to BOLTEVM DEX at ${address}`);
    const identified = this.waitFor(['IDENTIFIED', 'ERROR']);
    this.send({ type: 'IDENTIFY', address: this.trader.address, signature });
    const msg = await identified;
    if (msg.type === 'ERROR') fail(`engine refused IDENTIFY: ${msg.message}`);
    this.snapshot = this.waitFor(['USER_ORDERS_SNAPSHOT'], 15_000).catch(() => null);
  }

  onMessage(msg) {
    for (const [id, p] of this.pending) {
      if (p.types.includes(msg.type) && (!p.match || p.match(msg))) {
        this.pending.delete(id);
        p.resolve(msg);
        return;
      }
    }
    if (msg.type === 'ORDERBOOK_SNAPSHOT' || msg.type === 'ORDERBOOK_UPDATE') this.lastBook = msg;
  }

  waitFor(types, ms = 20_000, match) {
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`engine timeout waiting for ${types}`)); }, ms);
      this.pending.set(id, { types, match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }

  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(); } catch { /* ignore */ } }

  async book(depth = 5) {
    const got = this.waitFor(['ORDERBOOK_SNAPSHOT'], 20_000);
    this.send({ type: 'SUBSCRIBE_MARKET', marketId: MARKET, chainId: CHAIN_ID });
    const snap = await got;
    return { bids: (snap.bids || []).slice(0, depth), asks: (snap.asks || []).slice(0, depth) };
  }

  async myOrders() {
    const snap = await this.snapshot;
    return (snap?.orders || []).filter((o) => o.status === 'ACTIVE' || o.status === 'OPEN' || o.remaining > 0);
  }

  async place({ side, price, amount, expiryDays = 7 }) {
    const expiry = BigInt(Math.floor(Date.now() / 1000) + expiryDays * 86_400);
    const order = {
      maker: this.trader.address,
      base: Q0, quote: NATIVE,
      side: side === 'buy' ? 0 : 1,
      price: parseUnits(String(price), 18),
      amount: parseUnits(String(amount), 18),
      nonce: BigInt(Date.now()),
      expiry,
    };
    const signature = await this.trader.wallet.signTypedData(DOMAIN, ORDER_TYPES, {
      maker: order.maker, base: order.base, quote: order.quote, side: order.side,
      price: order.price, amount: order.amount, nonce: order.nonce, expiry: order.expiry,
    });
    const answer = this.waitFor(['USER_ORDER_UPDATE', 'ERROR'], 30_000);
    this.send({
      type: 'PLACE_ORDER', chainId: CHAIN_ID, marketId: MARKET,
      order: {
        maker: order.maker, base: order.base, quote: order.quote, side: String(order.side),
        price: order.price.toString(), amount: order.amount.toString(),
        nonce: order.nonce.toString(), expiry: order.expiry.toString(), signature,
      },
    });
    const msg = await answer;
    if (msg.type === 'ERROR') return { ok: false, reason: msg.message };
    return { ok: true, key: msg.orderKey, digest: msg.digest, remaining: msg.remaining, order };
  }

  async cancel(orderId) {
    const answer = this.waitFor(['USER_ORDER_UPDATE', 'ERROR'], 20_000, (m) => !m.orderId || m.orderId === orderId || m.id === orderId);
    this.send({ type: 'CANCEL_ORDER', orderId });
    const msg = await answer;
    return msg.type !== 'ERROR';
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdBalance(trader) {
  for (const [label, token] of [['QUAI', NATIVE], ['Q0  ', Q0]]) {
    const bal = BigInt(await call(VAULT, vaultIface.encodeFunctionData('balances', [trader.address, token])));
    const pending = await call(VAULT, vaultIface.encodeFunctionData('pendingWithdrawal', [trader.address, token]));
    const dec = vaultIface.decodeFunctionResult('pendingWithdrawal', pending);
    console.log(`  ${label}: ${formatUnits(bal, 18)} in BOLTDEXV2` +
      (dec.amount > 0n ? ` (withdrawal of ${formatUnits(dec.amount, 18)} ready at block ${dec.readyBlock})` : ''));
  }
  const quai = BigInt(await rpc('quai_getBalance', [trader.address, 'latest']));
  const q0 = BigInt(await call(Q0, erc20Iface.encodeFunctionData('balanceOf', [trader.address])));
  console.log(`  pit-1 wallet: ${formatUnits(quai, 18)} QUAI | ${formatUnits(q0, 18)} Q0`);
}

async function cmdDeposit(trader, quai, q0, broadcast) {
  if (quai > 0n) {
    const data = vaultIface.encodeFunctionData('depositNative', []);
    const gas = await estimate(trader.address, { to: VAULT, data, value: quai });
    await act(trader, { to: VAULT, data, value: quai }, gas, `depositNative ${formatUnits(quai, 18)} QUAI`, broadcast);
  }
  if (q0 > 0n) {
    const allowance = BigInt(await call(Q0, erc20Iface.encodeFunctionData('allowance', [trader.address, VAULT])));
    if (allowance < q0) {
      const aData = erc20Iface.encodeFunctionData('approve', [VAULT, q0]);
      const aGas = await estimate(trader.address, { to: Q0, data: aData });
      await act(trader, { to: Q0, data: aData }, aGas, `approve Q0 ${formatUnits(q0, 18)}`, broadcast);
    }
    const dData = vaultIface.encodeFunctionData('depositToken', [Q0, q0]);
    const dGas = await estimate(trader.address, { to: VAULT, data: dData });
    await act(trader, { to: VAULT, data: dData }, dGas, `depositToken ${formatUnits(q0, 18)} Q0`, broadcast);
  }
  if (broadcast) chronicle('pit-deposit', { note: `pit-1 escrowed ${formatUnits(quai, 18)} QUAI + ${formatUnits(q0, 18)} Q0 into BOLTDEXV2` });
}

async function cmdWithdrawRequest(trader, quai, q0, broadcast) {
  for (const [token, amount, label] of [[NATIVE, quai, 'QUAI'], [Q0, q0, 'Q0']]) {
    if (amount === 0n) continue;
    const data = vaultIface.encodeFunctionData('requestWithdraw', [token, amount]);
    const gas = await estimate(trader.address, { to: VAULT, data });
    await act(trader, { to: VAULT, data }, gas, `requestWithdraw ${formatUnits(amount, 18)} ${label}`, broadcast);
  }
}

async function cmdWithdraw(trader, broadcast) {
  for (const [token, label] of [[NATIVE, 'QUAI'], [Q0, 'Q0']]) {
    const pending = vaultIface.decodeFunctionResult('pendingWithdrawal',
      await call(VAULT, vaultIface.encodeFunctionData('pendingWithdrawal', [trader.address, token])));
    if (pending.amount === 0n) continue;
    const data = vaultIface.encodeFunctionData('withdraw', [token]);
    const gas = await estimate(trader.address, { to: VAULT, data });
    await act(trader, { to: VAULT, data }, gas, `withdraw ${label}`, broadcast);
  }
}

async function cmdBook(engine, depth) {
  const { bids, asks } = await engine.book(depth);
  console.log(`  ${MARKET}`);
  for (const a of asks.slice().reverse()) console.log(`    ask ${formatUnits(a.price, 18)} × ${formatUnits(a.amount, 18)}`);
  console.log('    ───');
  for (const b of bids) console.log(`    bid ${formatUnits(b.price, 18)} × ${formatUnits(b.amount, 18)}`);
}

async function cmdOrders(engine) {
  const mine = await engine.myOrders();
  if (mine.length === 0) return console.log('  no open orders');
  for (const o of mine) {
    console.log(`  ${o.side} ${formatUnits(o.remaining ?? o.amount, 18)} @ ${formatUnits(o.price, 18)}  ${o.orderKey ?? o.id}`);
  }
}

async function placeOne(engine, side, price, amount, expiryDays) {
  const r = await engine.place({ side, price, amount, expiryDays });
  if (r.ok) {
    console.log(`  ${side.toUpperCase()} ${amount} @ ${price}: booked (${(r.key ?? '').slice(0, 24)}…)`);
    chronicle('pit-order', { note: `${side} ${amount} Q0 @ ${price} QUAI booked on 9:Q0-QUAI` });
  } else {
    console.log(`  ${side.toUpperCase()} ${amount} @ ${price}: REFUSED — ${r.reason}`);
  }
  return r;
}

async function cmdPlace(engine, args) {
  if (!args.side || !args.price || !args.amount) fail('place needs --side buy|sell --price P --amount A');
  await placeOne(engine, args.side, args.price, args.amount, Number(args['expiry-days'] ?? 7));
}

async function cmdLadder(engine) {
  console.log('  posting the desk ladder on 9:Q0-QUAI');
  for (const b of LADDER.bids) { await placeOne(engine, 'buy', b.price, b.amount, LADDER.expiryDays); await sleep(700); }
  for (const a of LADDER.asks) { await placeOne(engine, 'sell', a.price, a.amount, LADDER.expiryDays); await sleep(700); }
}

// ---------------------------------------------------------------------------
// Keepalive — the desk's self-maintaining posture. Records the engineered
// ladder (center + premium over the CircleSwap reference) in ladder-state.json
// and re-plants only when something actually breaks: missing levels, expiry
// within 24h, or the reference drifting more than DRIFT_TRIGGER_PCT (the
// premium is preserved on re-center). Without --broadcast it is a dry run.
// ---------------------------------------------------------------------------
const LADDER_STATE_PATH = path.join(ROOT, 'agents', 'ladder-state.json');
const KEEPALIVE = { bandBps: [30, 50, 70], amount: '1500', expiryDays: 7, driftTriggerPct: 5, expiryFloorSecs: 86_400 };

const loadLadderState = () => { try { return JSON.parse(fs.readFileSync(LADDER_STATE_PATH, 'utf8')); } catch { return null; } };
const saveLadderState = (st) => fs.writeFileSync(LADDER_STATE_PATH, JSON.stringify(st, null, 2) + '\n');

function circleRef() {
  try {
    const ts = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'treasury-state.json'), 'utf8'));
    const readings = ts.readings;
    if (!readings?.length) return null;
    return Number(formatUnits(BigInt(readings[readings.length - 1].priceE18), 18));
  } catch { return null; }
}

function ownMid(orders) {
  const px = (o) => Number(formatUnits(BigInt(o.price), 18));
  const isBid = (o) => o.side === 'BUY' || o.side === 'buy' || String(o.side) === '0';
  const bids = orders.filter(isBid).map(px);
  const asks = orders.filter((o) => !isBid(o)).map(px);
  if (!bids.length || !asks.length) return null;
  return (Math.max(...bids) + Math.min(...asks)) / 2;
}

async function cmdKeepalive(engine, { init, broadcast }) {
  const mine = await engine.myOrders();
  const ref = circleRef();
  let st = loadLadderState();
  const now = Date.now();
  const keysOf = (orders) => orders.map((o) => o.orderKey ?? o.id).filter(Boolean);
  const emit = (o) => console.log(`KEEPALIVE_JSON ${JSON.stringify(o)}`);

  if (init || (!st && mine.length)) {
    const mid = ownMid(mine);
    if (!mid) fail('keepalive --init needs at least one open bid and one open ask to read the desk posture');
    const expiries = mine.map((o) => Number(o.expiry ?? 0)).filter((e) => e > 0);
    st = {
      center: mid, circleRef: ref, premium: ref ? mid / ref : null,
      orderKeys: keysOf(mine), placedAt: new Date(now).toISOString(),
      expiryAt: expiries.length ? Math.min(...expiries) : null,
    };
    saveLadderState(st);
    chronicle('pit-keepalive-init', { note: `posture recorded: center ${mid.toFixed(7)}${st.premium ? `, premium x${st.premium.toFixed(3)} vs CircleSwap` : ''}` });
    console.log(`  posture recorded — center ${mid.toFixed(7)}${st.premium ? ` (x${st.premium.toFixed(3)} vs CircleSwap ${ref})` : ''}, ${st.orderKeys.length} orders`);
    emit({ action: 'init', orders: mine.length, center: mid });
    return;
  }
  if (!st) {
    console.log('  no posture on record and no open orders — run ladder first, then keepalive --init');
    emit({ action: 'none', reason: 'no-posture', orders: 0 });
    return;
  }

  const reasons = [];
  if (mine.length < 6) reasons.push(`only ${mine.length}/6 levels open`);
  const minExpiry = Math.min(...mine.map((o) => Number(o.expiry ?? 0)).filter((e) => e > 0));
  if (Number.isFinite(minExpiry) && minExpiry * 1000 - now < KEEPALIVE.expiryFloorSecs * 1000) reasons.push('expiry within 24h');
  let newCenter = st.center;
  if (ref && st.circleRef && Math.abs(ref / st.circleRef - 1) * 100 > KEEPALIVE.driftTriggerPct) {
    newCenter = st.premium ? ref * st.premium : st.center * (ref / st.circleRef);
    reasons.push(`CircleSwap ref moved ${((ref / st.circleRef - 1) * 100).toFixed(1)}% — re-centering ${st.center.toFixed(7)} -> ${newCenter.toFixed(7)}`);
  }

  if (!reasons.length) {
    const drift = ref && st.circleRef ? `${((ref / st.circleRef - 1) * 100).toFixed(2)}%` : 'n/a';
    console.log(`  ladder healthy — ${mine.length}/6 levels, center ${st.center.toFixed(7)}, ref drift ${drift}`);
    chronicle('pit-keepalive', { note: `healthy — ${mine.length}/6 levels, ref drift ${drift}` });
    emit({ action: 'none', orders: mine.length, center: st.center, circleRef: ref, drift });
    return;
  }

  const bids = KEEPALIVE.bandBps.map((b) => ({ price: (newCenter * (1 - b / 10_000)).toFixed(18), amount: KEEPALIVE.amount }));
  const asks = KEEPALIVE.bandBps.map((b) => ({ price: (newCenter * (1 + b / 10_000)).toFixed(18), amount: KEEPALIVE.amount }));
  console.log(`  keepalive action needed: ${reasons.join('; ')}`);
  if (!broadcast) {
    console.log('  DRY RUN — pass --broadcast --i-understand-unaudited to execute');
    for (const o of mine) console.log(`    would cancel ${String(o.orderKey ?? o.id ?? '').slice(0, 24)}…`);
    for (const b of bids) console.log(`    would bid ${b.amount} @ ${b.price}`);
    for (const a of asks) console.log(`    would ask ${a.amount} @ ${a.price}`);
    emit({ action: 'dry-run', reasons, orders: mine.length, center: newCenter });
    return;
  }

  for (const o of mine) {
    const key = o.orderKey ?? o.id;
    if (!key) continue;
    console.log((await engine.cancel(key)) ? `  cancelled ${String(key).slice(0, 24)}…` : `  cancel refused ${String(key).slice(0, 24)}…`);
    await sleep(500);
  }
  const newKeys = [];
  for (const b of bids) { const r = await placeOne(engine, 'buy', b.price, b.amount, KEEPALIVE.expiryDays); if (r.ok && r.key) newKeys.push(r.key); await sleep(700); }
  for (const a of asks) { const r = await placeOne(engine, 'sell', a.price, a.amount, KEEPALIVE.expiryDays); if (r.ok && r.key) newKeys.push(r.key); await sleep(700); }
  st = {
    center: newCenter, circleRef: ref ?? st.circleRef,
    premium: st.premium ?? (ref ? newCenter / ref : null),
    orderKeys: newKeys, placedAt: new Date().toISOString(),
    expiryAt: Math.floor(now / 1000) + KEEPALIVE.expiryDays * 86_400,
  };
  saveLadderState(st);
  chronicle('pit-keepalive-replant', { note: `${reasons.join('; ')} -> re-planted ${newKeys.length}/6 around ${newCenter.toFixed(7)}` });
  emit({ action: 'replant', reasons, orders: newKeys.length, center: newCenter });
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (!cmd || !['balance', 'deposit', 'withdraw-request', 'withdraw', 'book', 'orders', 'place', 'ladder', 'cancel', 'keepalive'].includes(cmd)) {
  fail('usage: orderbook.mjs <balance|deposit|withdraw-request|withdraw|book|orders|place|ladder|cancel|keepalive> [options]');
}
const broadcast = args.flags.has('broadcast');
if (broadcast && !args.flags.has('i-understand-unaudited')) fail('broadcast requires --i-understand-unaudited');

const provider = new JsonRpcProvider(RPC, CHAIN_ID);
const needsWallet = broadcast || ['place', 'ladder', 'cancel', 'orders', 'book', 'keepalive'].includes(cmd);
const trader = await loadTrader(provider, needsWallet);

if (cmd === 'balance') { await cmdBalance(trader); process.exit(0); }
if (cmd === 'deposit') {
  await cmdDeposit(trader, parseUnits(args.quai ?? '0', 18), parseUnits(args.q0 ?? '0', 18), broadcast);
  process.exit(0);
}
if (cmd === 'withdraw-request') {
  await cmdWithdrawRequest(trader, parseUnits(args.quai ?? '0', 18), parseUnits(args.q0 ?? '0', 18), broadcast);
  process.exit(0);
}
if (cmd === 'withdraw') { await cmdWithdraw(trader, broadcast); process.exit(0); }

const engine = new Engine(trader);
await engine.connect();
try {
  if (cmd === 'book') await cmdBook(engine, Number(args.depth ?? 5));
  else if (cmd === 'orders') await cmdOrders(engine);
  else if (cmd === 'place') await cmdPlace(engine, args);
  else if (cmd === 'ladder') await cmdLadder(engine);
  else if (cmd === 'keepalive') await cmdKeepalive(engine, { init: args.flags.has('init'), broadcast });
  else if (cmd === 'cancel') {
    if (!args.id) fail('cancel needs --id <orderKey>');
    console.log((await engine.cancel(args.id)) ? '  cancelled' : '  cancel refused');
  }
} finally {
  engine.close();
}
