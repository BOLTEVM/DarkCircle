#!/usr/bin/env node
/**
 * A local chain the web app can use as if it were Orchard, for trying the v2 flows without
 * testnet funds. Development only.
 *
 *   node scripts/local-quai-chain.mjs [--port 8546] [--origin http://localhost:3010]
 *
 *  - starts anvil as chain 15000 on 127.0.0.1:8545,
 *  - serves a quai_* JSON-RPC proxy on --port that maps to eth_* and reshapes blocks into
 *    Quai's format (woHeader.number / woHeader.timestamp),
 *  - deploys the Hardhat-compiled (pinned) implementation and factory at Cyprus-1 addresses,
 *  - creates a 2-of-3 vault (1 h timelock) through the factory with a mined salt,
 *  - proposes a 1 QUAI transfer and an admin change (threshold 2 -> 1),
 *  - writes apps/web/.env.localchain.local so `vite --mode localchain` points at it.
 *
 * Accounts are anvil-impersonated addresses: no private keys exist. quai_sendTransaction on
 * the proxy impersonates `from`, so a test wallet in the browser can "sign" as any owner.
 * Stop with Ctrl+C (anvil is stopped with it).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getCreateAddress, getAddress, hexlify, randomBytes, AbiCoder, parseEther } from 'ethers';
import {
  isCyprus1QuaiAddress,
  mineVaultSalt,
  createWalletCall,
  vaultCalls,
  adminCalls,
  walletCreatedFromLogs,
  proposedHashFromLogs,
} from '@darksafe/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const PROXY_PORT = Number(arg('port', '8546'));
const ORIGIN = arg('origin', 'http://localhost:3010');
const ANVIL = 'http://127.0.0.1:8545';
const CHAIN_ID = 15000;

let id = 0;
async function anvil(method, params = []) {
  const res = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
  const body = await res.json();
  if (body.error) throw Object.assign(new Error(body.error.message), body.error);
  return body.result;
}

function artifact(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts/contracts/v2', `${name}.sol`, `${name}.json`), 'utf8'));
}

function randomCyprus() {
  for (;;) {
    const a = getAddress(hexlify(randomBytes(20)));
    if (isCyprus1QuaiAddress(a)) return a;
  }
}

/** An address whose first CREATE lands in Cyprus-1, as it must on Quai. */
function cyprusDeployer() {
  for (;;) {
    const a = getAddress(hexlify(randomBytes(20)));
    if (isCyprus1QuaiAddress(getCreateAddress({ from: a, nonce: 0 }))) return a;
  }
}

async function sendAs(from, tx) {
  await anvil('anvil_impersonateAccount', [from]);
  await anvil('anvil_setBalance', [from, '0x' + parseEther('1000').toString(16)]);
  const hash = await anvil('eth_sendTransaction', [{ from, ...tx }]);
  // anvil mines asynchronously: the receipt appears shortly after the hash.
  for (let i = 0; i < 100; i++) {
    const receipt = await anvil('eth_getTransactionReceipt', [hash]);
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error(`transaction ${hash} from ${from} reverted`);
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no receipt for ${hash}`);
}

async function waitForAnvil() {
  for (let i = 0; i < 50; i++) {
    try {
      return await anvil('eth_chainId');
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('anvil did not start');
}

async function proxy(method, params) {
  if (method === 'quai_sendTransaction') {
    const { gasLimit, ...tx } = params[0];
    await anvil('anvil_impersonateAccount', [tx.from]);
    // Test accounts start empty; give the impersonated sender gas money.
    await anvil('anvil_setBalance', [tx.from, '0x' + parseEther('1000').toString(16)]);
    return anvil('eth_sendTransaction', [{ ...tx, gas: gasLimit }]);
  }
  const eth = method.replace(/^quai_/, 'eth_');
  const result = await anvil(eth, params);
  if (eth === 'eth_getBlockByNumber' && result) {
    return { hash: result.hash, woHeader: { number: result.number, timestamp: result.timestamp }, header: { number: [] } };
  }
  return result;
}

// Cancun, like the Hardhat test chain: later forks add a per-transaction gas cap Quai does not have.
const child = spawn('anvil', ['--chain-id', String(CHAIN_ID), '--port', '8545', '--host', '127.0.0.1', '--hardfork', 'cancun', '--silent'], { stdio: 'inherit' });
process.on('SIGINT', () => {
  child.kill();
  process.exit(0);
});
process.on('exit', () => child.kill());

await waitForAnvil();

const vaultArt = artifact('DarkSafeVault');
const factoryArt = artifact('DarkSafeVaultFactory');
const implDeployer = cyprusDeployer();
const implementation = walletCreatedGuard((await sendAs(implDeployer, { data: vaultArt.bytecode })).contractAddress);
const factoryDeployer = cyprusDeployer();
const factory = walletCreatedGuard(
  (await sendAs(factoryDeployer, { data: factoryArt.bytecode + AbiCoder.defaultAbiCoder().encode(['address'], [implementation]).slice(2) })).contractAddress
);

function walletCreatedGuard(address) {
  const a = getAddress(address);
  if (!isCyprus1QuaiAddress(a)) throw new Error(`${a} is not a Cyprus-1 address`);
  return a;
}

const owners = [randomCyprus(), randomCyprus(), randomCyprus()];
const params = { owners, threshold: 2, minExecutionDelay: 3600 };
const mined = mineVaultSalt({ factory, implementation, creator: owners[0], params });
const created = await sendAs(owners[0], { to: factory, data: createWalletCall(owners, 2, 3600, mined.salt) });
const vault = walletCreatedFromLogs(created.logs, factory).wallet;
await sendAs(owners[0], { to: vault, value: '0x' + parseEther('10').toString(16) });

const block = await anvil('eth_getBlockByNumber', ['latest', false]);
const now = Number(BigInt(block.timestamp));
const recipient = randomCyprus();
const transfer = await sendAs(owners[0], {
  to: vault,
  data: vaultCalls.propose({ to: recipient, value: parseEther('1'), data: '0x', gasLimit: 60_000n, expiration: now + 3600 + 7 * 86400, requestedDelay: 0 }),
  gas: '0x4c4b40',
});
const admin = await sendAs(owners[0], {
  to: vault,
  data: vaultCalls.propose({ to: vault, value: 0n, data: adminCalls.changeThreshold(1), gasLimit: 0n, expiration: now + 7 * 86400, requestedDelay: 0 }),
  gas: '0x4c4b40',
});

const summary = {
  rpc: `http://127.0.0.1:${PROXY_PORT}`,
  chainId: CHAIN_ID,
  factory,
  implementation,
  vault,
  owners,
  recipient,
  proposals: { transfer: proposedHashFromLogs(transfer.logs, vault), admin: proposedHashFromLogs(admin.logs, vault) },
};
fs.writeFileSync(path.join(ROOT, '.localchain.json'), JSON.stringify(summary, null, 2) + '\n');
fs.writeFileSync(
  path.resolve(ROOT, '../../apps/web/.env.localchain.local'),
  [
    '# Written by packages/contracts/scripts/local-quai-chain.mjs (development only).',
    'VITE_QUAI_NETWORK=testnet',
    `VITE_QUAI_RPC_URL=${summary.rpc}`,
    `VITE_V2_FACTORY_ADDRESS=${factory}`,
    'VITE_TX_CONFIRMATIONS=1',
    '',
  ].join('\n')
);

http
  .createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, accept');
    if (req.method === 'OPTIONS') return res.end();
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const handle = async (msg) => {
      try {
        return { jsonrpc: '2.0', id: msg.id, result: await proxy(msg.method, msg.params ?? []) };
      } catch (err) {
        return { jsonrpc: '2.0', id: msg.id, error: { code: err.code ?? -32000, message: err.message, data: err.data } };
      }
    };
    const body = JSON.parse(raw);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(Array.isArray(body) ? await Promise.all(body.map(handle)) : await handle(body)));
  })
  .listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(JSON.stringify(summary, null, 2));
    console.log(`quai proxy ready on ${summary.rpc}; run: pnpm -F @darksafe/web exec vite --mode localchain --port 3010`);
  });
