/**
 * The intel sealer — packages the cabal's intelligence into signed, content-addressed
 * drops (agents/X402.md). Runs at the end of every broadcast tick; unsigned runs are
 * for testing only and must never be served.
 *
 *   import { writeDrops } from './intel-drops.mjs';
 *   await writeDrops({ signer, vault, q0Token });   // signer: quais Wallet (sovereign)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const AGENTS = path.dirname(fileURLToPath(import.meta.url));
const DROPS = path.join(AGENTS, 'drops');
const CHRONICLE = path.join(AGENTS, 'chronicle.jsonl');
const INTEL = path.join(AGENTS, 'intel.json');
const TSTATE = path.join(AGENTS, 'treasury-state.json');

// The catalog. Prices are policy: changing them is a code change, not a negotiation.
export const PRODUCTS = {
  'guilds-ledger': { priceQ0: '25000', blurb: 'Every corporation on chain: mode, module, token, proposal counts, foreign flags.' },
  'desk-tape': { priceQ0: '50000', blurb: 'The desk’s own position: Q0 held, cost basis, latest readings, gas ledger.' },
  'chronicle-stream': { priceQ0: '100000', blurb: 'The last 50 private chronicle entries — trades, enforcement, births, treasury-health.' },
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readChronicle(limit = 50) {
  try {
    const lines = fs.readFileSync(CHRONICLE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export async function writeDrops({ signer = null, vault, q0Token } = {}) {
  fs.mkdirSync(DROPS, { recursive: true });
  const at = new Date().toISOString();
  const issuer = signer?.address ?? null;

  const intel = JSON.parse(fs.readFileSync(INTEL, 'utf8'));
  const ts = JSON.parse(fs.readFileSync(TSTATE, 'utf8'));

  const payloads = {
    'guilds-ledger': intel,
    'desk-tape': {
      costBasis: ts.costBasis ?? null,
      q0Held: ts.q0Held ?? '0',
      readings: (ts.readings ?? []).slice(-24),
      gasLedger: ts.gasLedger ?? null,
    },
    'chronicle-stream': { entries: readChronicle(50) },
  };

  const products = [];
  for (const [product, meta] of Object.entries(PRODUCTS)) {
    const payload = payloads[product];
    const id = sha256(JSON.stringify({ product, payload }));
    const drop = {
      kind: 'cabal-intel-drop', version: 1, product, id, at,
      payload, issuer,
      signature: signer ? await signer.signMessage(id) : null,
    };
    const file = path.join(DROPS, `${product}-${id.slice(0, 12)}.json`);
    fs.writeFileSync(file, JSON.stringify(drop, null, 2) + '\n');
    products.push({ product, ...meta, id, file: `drops/${path.basename(file)}`, signed: drop.signature !== null });
  }

  const manifest = {
    kind: 'cabal-intel-catalog', version: 1, at, issuer,
    payment: {
      chain: 'quai-mainnet-cyprus-1', chainId: 9,
      token: { symbol: 'Q0', address: q0Token },
      to: vault,
      proof: 'quai_getTransactionReceipt — an ERC-20 Transfer of at least priceQ0 to the vault, log-verified; one tx hash buys one drop',
    },
    products,
  };
  fs.writeFileSync(path.join(DROPS, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return products;
}
