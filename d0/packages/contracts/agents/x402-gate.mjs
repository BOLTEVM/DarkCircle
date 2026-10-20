#!/usr/bin/env node
/**
 * The 402 gate — serves the cabal's sealed intel drops per agents/X402.md.
 *
 *   node agents/x402-gate.mjs [--port 8402] [--rpc https://rpc.quai.network/cyprus1]
 *
 * Endpoints:
 *   GET /healthz            -> { ok: true }
 *   GET /intel/catalog      -> the public manifest (free — the advertisement)
 *   GET /intel/<product>    -> 402 + payment block, or the signed drop when the
 *                              X-PAYMENT: <txHash> header carries a verified,
 *                              never-before-claimed Q0 Transfer to the vault.
 *
 * Verification is self-contained (no facilitator): fetch the receipt, require
 * status 1, scan for an ERC-20 Transfer log from the Q0 token to the vault with
 * value >= the product price. One tx hash buys one drop; claimed hashes persist
 * in agents/drops/claimed.json (gitignored like the rest of the shelf).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const AGENTS = path.dirname(fileURLToPath(import.meta.url));
const DROPS = path.join(AGENTS, 'drops');
const CLAIMED = path.join(DROPS, 'claimed.json');

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const PORT = Number(opt('port', 8402));
const RPC = opt('rpc', 'https://rpc.quai.network/cyprus1');

// keccak256("Transfer(address,address,uint256)")
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function loadManifest() {
  return JSON.parse(fs.readFileSync(path.join(DROPS, 'manifest.json'), 'utf8'));
}
function loadClaimed() {
  try { return new Set(JSON.parse(fs.readFileSync(CLAIMED, 'utf8')).hashes); } catch { return new Set(); }
}
function saveClaimed(set) {
  fs.writeFileSync(CLAIMED, JSON.stringify({ hashes: [...set] }, null, 2) + '\n');
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

const addrTopic = (a) => '0x' + a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

// Returns null when the payment is good, else a reason string.
async function paymentRejection(txHash, product, manifest) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash ?? '')) return 'X-PAYMENT must be a 32-byte tx hash';
  const claimed = loadClaimed();
  if (claimed.has(txHash.toLowerCase())) return 'this tx hash has already bought a drop — one hash, one drop';
  let receipt;
  try {
    receipt = await rpc('quai_getTransactionReceipt', [txHash]);
  } catch (e) {
    return `rpc fault while verifying: ${e?.message ?? e}`;
  }
  if (!receipt) return 'no such transaction (yet?) — confirm it first';
  if (parseInt(receipt.status, 16) !== 1) return 'the payment transaction reverted';
  // Freshness rail: the payment must answer THIS 402, not some ancient generosity.
  // Without it, any old large transfer to the vault could be retro-claimed.
  const block = await rpc('quai_getBlockByNumber', [receipt.blockNumber, false]).catch(() => null);
  const ageH = block ? (Date.now() / 1000 - parseInt(block.timestamp, 16)) / 3600 : 0;
  if (!block || ageH > 72) return 'payment too old — pay in answer to the 402 (within 72h)';
  const token = manifest.payment.token.address.toLowerCase();
  const vaultTopic = addrTopic(manifest.payment.to);
  const need = BigInt(product.priceQ0) * 10n ** 18n;
  for (const log of receipt.logs ?? []) {
    if ((log.address ?? '').toLowerCase() !== token) continue;
    if ((log.topics?.[0] ?? '').toLowerCase() !== TOPIC_TRANSFER) continue;
    if ((log.topics?.[2] ?? '').toLowerCase() !== vaultTopic) continue;
    if (BigInt(log.data) >= need) {
      claimed.add(txHash.toLowerCase());
      saveClaimed(claimed);
      return null; // paid
    }
  }
  return `no Q0 Transfer of at least ${product.priceQ0} to the vault in that receipt`;
}

function send(res, code, obj, headers = {}) {
  const body = JSON.stringify(obj, null, 2) + '\n';
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });
    if (url.pathname === '/intel/catalog') return send(res, 200, loadManifest());
    const m = url.pathname.match(/^\/intel\/([a-z0-9-]+)$/);
    if (m) {
      const manifest = loadManifest();
      const product = manifest.products.find((p) => p.product === m[1]);
      if (!product) return send(res, 404, { error: `unknown product "${m[1]}" — see /intel/catalog` });
      const payHeader = req.headers['x-payment'];
      if (!payHeader) {
        return send(res, 402, {
          error: 'payment required',
          product: product.product,
          priceQ0: product.priceQ0,
          payment: manifest.payment,
          how: `transfer >= ${product.priceQ0} Q0 to ${manifest.payment.to} on ${manifest.payment.chain}, then retry with header X-PAYMENT: <txHash>`,
        }, { 'x-price-q0': product.priceQ0, 'x-pay-to': manifest.payment.to });
      }
      const rejection = await paymentRejection(payHeader, product, manifest);
      if (rejection) return send(res, 402, { error: rejection, product: product.product, priceQ0: product.priceQ0 });
      const drop = JSON.parse(fs.readFileSync(path.join(DROPS, path.basename(product.file)), 'utf8'));
      return send(res, 200, drop);
    }
    send(res, 404, { error: 'unknown path — try /intel/catalog' });
  } catch (e) {
    send(res, 500, { error: e?.message ?? String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`cabal 402 gate on 127.0.0.1:${PORT} — catalog at /intel/catalog (rpc ${RPC})`);
});
