// Probe the live BDelta matching engine: list chain-9 markets and snapshot the Q0 book.
// Read-only: connects, asks, prints, exits. Run from bdelta/packages/matching-engine (ws dep) or pass WS path.
import { createRequire } from 'module';
const require = createRequire('C:/Users/wonfi/Documents/boltevm_multimedia_mine_suite/bdelta/packages/matching-engine/package.json');
const WebSocket = require('ws');

const URL = process.env.ENGINE_WS_URL || 'wss://engine-delta.boltevm.com';
const CHAIN = 9;

const ws = new WebSocket(URL);
const timeout = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 20000);

const send = (o) => ws.send(JSON.stringify(o));

ws.on('open', () => {
  console.log('connected to', URL);
  send({ type: 'LIST_MARKETS', chainId: CHAIN });
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'MARKETS_LIST') {
    const ms = (msg.markets || []).filter((m) => m.chainId === CHAIN);
    console.log(`markets on chain ${CHAIN}: ${ms.length}`);
    for (const m of ms) {
      console.log(`  ${m.marketId}  ${m.baseSymbol}-${m.quoteSymbol}  settlement=${m.settlement}  base=${m.baseAddress} quote=${m.quoteAddress}`);
    }
    const q0 = ms.find((m) => m.baseSymbol === 'Q0');
    if (q0) {
      console.log('subscribing to', q0.marketId);
      send({ type: 'SUBSCRIBE_MARKET', marketId: q0.marketId, chainId: CHAIN });
    } else {
      clearTimeout(timeout); ws.close(); process.exit(0);
    }
  } else if (msg.type === 'ORDERBOOK_SNAPSHOT') {
    console.log(`book ${msg.marketId}: ${msg.bids?.length ?? 0} bids, ${msg.asks?.length ?? 0} asks`);
    for (const b of (msg.bids || []).slice(0, 5)) console.log('  bid', JSON.stringify(b));
    for (const a of (msg.asks || []).slice(0, 5)) console.log('  ask', JSON.stringify(a));
    clearTimeout(timeout); ws.close(); process.exit(0);
  }
});

ws.on('error', (e) => { console.error('WS ERROR', e.message); clearTimeout(timeout); process.exit(1); });
