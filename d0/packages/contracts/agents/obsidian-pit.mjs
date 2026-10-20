#!/usr/bin/env node
/**
 * OBSIDIAN PIT — the cabal's orderbook desk on the BDelta VDF CLOB.
 *
 * Three-tier custody (BOLTDEXV2 verifies plain ECDSA, so no contract can ever
 * be a maker — the chain of custody ends in one hot key with a capped tranche):
 *
 *   obsidianvault (4-of-7 CouncilMultisig: the treasury)
 *     └─ migrate ─▶ DarkSafe vault (4-of-7 DarkSafeVault: desk budget custody)
 *                     └─ tranche ─▶ pit-1 (hot trader EOA: deposits, signs orders)
 *
 * The desk multisig is a DarkSafe v2 vault from the already-deployed mainnet
 * factory (deployments/v2-mainnet.json) — a fresh obsidianpit GUILD would cost
 * ~7.3M gas to found; a DarkSafe proxy is a fraction of that and every tranche
 * cycle (propose + 3 approvals + execute) is ~5x cheaper than a council proposal.
 *
 * Commands (run from packages/contracts):
 *   node agents/obsidian-pit.mjs --network mainnet status
 *   node agents/obsidian-pit.mjs --network mainnet key          generate the pit-1 trader keystore
 *   node agents/obsidian-pit.mjs --network mainnet found   --broadcast --i-understand-unaudited
 *   node agents/obsidian-pit.mjs --network mainnet migrate --broadcast --i-understand-unaudited [--quai 100 --q0 100000]
 *   node agents/obsidian-pit.mjs --network mainnet tranche --broadcast --i-understand-unaudited [--quai 40 --q0 60000]
 *
 * migrate files ONE obsidianvault council proposal and drives it to execution.
 * tranche runs DarkSafe cycles (propose -> approve x3 -> execute), one per asset.
 * Same discipline as corporate-brain.mjs: every tx is simulated with quai_call
 * first, gas limits come from quai_estimateGas, and a member who cannot cover
 * escrow at spike prices is skipped, never crashed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  Wallet, JsonRpcProvider, QuaiTransaction, Interface, getAddress, Zone, getZoneForAddress, isQiAddress,
  keccak256, solidityPacked, getCreate2Address, concat, AbiCoder,
} from 'quais';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DARKSAFE_ROOT = process.env.DARKSAFE_ROOT || path.resolve(ROOT, '..', '..', '..', 'multisigows', 'packages', 'contracts');

const NETWORKS = {
  orchard: { chainId: 15000n, rpc: 'https://orchard.rpc.quai.network/cyprus1', confirmations: 6 },
  mainnet: { chainId: 9n, rpc: 'https://rpc.quai.network/cyprus1', confirmations: 3 },
};

const Q0 = '0x00325150094E51107a931980Fdfc3bB1a4C48379';

// DarkSafe v2, mainnet (multisigows/packages/contracts/deployments/v2-mainnet.json).
const DARKSAFE = {
  factory: '0x0047Fc97C447dd2C30410eA5Ca3ef0d645a396E6',
  implementation: '0x003b7EEf3BA4144b69060AC85356452592baf32f',
  threshold: 4,
  minExecutionDelay: 0, // desk safe: no timelock; quorum is the gate
  trancheExpirySeconds: 7 * 86_400,
};

const MEMBER_ORDER = ['director-1', 'director-2', 'worker-1', 'worker-2', 'worker-3', 'sentinel', 'sovereign'];

const STATE_PATH = path.join(ROOT, 'agents', 'pit-state.json');
const CHRONICLE_PATH = path.join(ROOT, 'agents', 'chronicle.jsonl');

function chronicle(event, details = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...details });
  try { fs.appendFileSync(CHRONICLE_PATH, line + '\n'); } catch { /* the diary never kills the mind */ }
  console.log(`  chronicle: ${event}${details.note ? ` — ${details.note}` : ''}`);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { /* fall through */ }
  return { safe: null, salt: null, trader: null, migrations: [], tranches: [] };
}
function saveState(s) { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n'); }

function fail(msg) { console.error(`error: ${msg}`); process.exit(1); }

function parseArgs(argv) {
  const out = { flags: new Set(), _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (['broadcast', 'i-understand-unaudited'].includes(key)) out.flags.add(key);
    else if (['network', 'quai', 'q0'].includes(key)) out[key] = argv[++i];
    else fail(`unknown option ${a}`);
  }
  out.network ??= 'mainnet';
  return out;
}

function d0Artifact(name) {
  const file = path.join(ROOT, 'artifacts/contracts', `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) fail(`missing ${file}; run \`pnpm build\` first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function dsArtifact(rel) {
  const file = path.join(DARKSAFE_ROOT, 'artifacts/contracts/v2', rel);
  if (!fs.existsSync(file)) fail(`missing ${file}; build multisigows contracts first`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function rpc(url, method, params) {
  const res = await fetch(url, {
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
const jitter = (baseMs) => baseMs + Math.floor(Math.random() * baseMs);
const fmtQuai = (wei) => `${wei / 10n ** 18n}.${(wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4)} QUAI`;
const call = (net, to, data) => rpc(net.rpc, 'quai_call', [{ to, data }, 'latest']);
const uintOf = (hex) => BigInt(hex);

function buildIfaces() {
  return {
    council: new Interface(d0Artifact('CouncilMultisig').abi),
    safeFactory: new Interface(dsArtifact('DarkSafeVaultFactory.sol/DarkSafeVaultFactory.json').abi),
    safe: new Interface(dsArtifact('DarkSafeVault.sol/DarkSafeVault.json').abi),
    erc20: new Interface([
      'function balanceOf(address) view returns (uint256)',
      'function transfer(address to, uint256 amount) returns (bool)',
    ]),
  };
}

function loadManifest() {
  const file = path.join(ROOT, 'agents', 'manifest.json');
  if (!fs.existsSync(file)) fail('agents/manifest.json not found');
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
      wallet = (await Wallet.fromEncryptedJson(fs.readFileSync(path.join(ROOT, ...id.keystore.split(/[\\/]/)), 'utf8'), passwords[id.id])).connect(provider);
      if (wallet.address !== id.address) fail(`keystore ${id.id} unlocks ${wallet.address}, expected ${id.address}`);
    }
    swarm.set(id.id, { ...id, wallet });
  }
  return swarm;
}

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

async function act(net, who, tx, gasLimit, label, { broadcast, confirmations }) {
  const simTx = { ...tx, from: who.address, gas: '0x' + gasLimit.toString(16) };
  if (simTx.value !== undefined) simTx.value = '0x' + BigInt(simTx.value).toString(16);
  await rpc(net.rpc, 'quai_call', [simTx, 'latest']);
  console.log(`  [${who.id ?? 'pit-1'}] ${label}: simulates cleanly`);
  if (!broadcast) return null;
  const pop = await who.wallet.populateQuaiTransaction({ ...tx, from: who.address, gasLimit });
  const signed = await who.wallet.signTransaction(QuaiTransaction.from(pop));
  const zone = await who.wallet.zoneFromAddress(who.address);
  let resp;
  try {
    resp = await who.wallet.provider.broadcastTransaction(zone, signed, who.address);
  } catch (e) {
    if (/insufficient funds/i.test(e?.message ?? '')) {
      console.log(`  [${who.id ?? 'pit-1'}] ${label}: skipped (cannot cover intrinsic cost at current gas prices)`);
      return null;
    }
    throw e;
  }
  console.log(`  [${who.id ?? 'pit-1'}] ${label}: sent ${resp.hash}`);
  const receipt = await waitConfirmed(net, resp.hash, confirmations);
  if (parseInt(receipt.status, 16) !== 1) fail(`${label} reverted (tx ${resp.hash})`);
  console.log(`  [${who.id ?? 'pit-1'}] ${label}: confirmed in block ${parseInt(receipt.blockNumber, 16)}`);
  return receipt;
}

async function estimate(net, from, tx, padNum = 120n) {
  const simTx = { ...tx, from };
  if (simTx.value !== undefined) simTx.value = '0x' + BigInt(simTx.value).toString(16);
  const est = BigInt(await rpc(net.rpc, 'quai_estimateGas', [simTx]));
  return (est * padNum) / 100n;
}

/** First member of the preferred order who can escrow gasLimit at the current price. */
async function pickActor(net, swarm, gasLimit) {
  const gasPrice = BigInt(await rpc(net.rpc, 'quai_gasPrice', []));
  for (const id of MEMBER_ORDER) {
    const w = swarm.get(id);
    if (!w) continue;
    const bal = BigInt(await rpc(net.rpc, 'quai_getBalance', [w.address, 'latest']));
    if (bal >= gasLimit * gasPrice) return w;
  }
  return null;
}

// ---------------------------------------------------------------------------
// DarkSafe CREATE2 mining (mirrors @darksafe/core vault/create2.ts)
// ---------------------------------------------------------------------------

const isCyprus1QuaiAddress = (a) => a.slice(2, 4) === '00' && parseInt(a.slice(4, 6), 16) < 0x80;

function proxyCreationCode() {
  return dsArtifact('DarkSafeVaultProxy.sol/DarkSafeVaultProxy.json').bytecode;
}

function vaultInitCodeHash(ifaces, owners) {
  const initData = ifaces.safe.encodeFunctionData('initialize', [owners, DARKSAFE.threshold, DARKSAFE.minExecutionDelay]);
  const args = AbiCoder.defaultAbiCoder().encode(['address', 'bytes'], [DARKSAFE.implementation, initData]);
  return keccak256(concat([proxyCreationCode(), args]));
}

function mineVaultSalt(ifaces, creator, owners) {
  const initHash = vaultInitCodeHash(ifaces, owners);
  for (let attempts = 1; attempts <= 1_000_000; attempts++) {
    const salt = '0x' + crypto.randomBytes(32).toString('hex');
    const fullSalt = keccak256(solidityPacked(['address', 'bytes32'], [creator, salt]));
    const address = getCreate2Address(DARKSAFE.factory, fullSalt, initHash);
    if (isCyprus1QuaiAddress(address)) return { salt, address, attempts };
  }
  fail('salt mining found no Cyprus-1 address in 1M attempts (astronomically unlikely)');
}

// ---------------------------------------------------------------------------
// obsidianvault council: file one proposal, drive it through 4 approvals
// ---------------------------------------------------------------------------

async function fileAndDriveCouncil(net, council, swarm, ifaces, opts, metadata, actions) {
  const data = ifaces.council.encodeFunctionData('createProposal', [metadata, actions]);
  const gasLimit = await estimate(net, swarm.get('director-1').address, { to: council, data });
  const filer = await pickActor(net, swarm, gasLimit);
  if (!filer) fail(`no member can cover ${gasLimit}-gas filing escrow at current prices — retry later`);
  console.log(`  ${filer.id} files "${metadata.slice(0, 72)}…" (gas ${gasLimit})`);
  const receipt = await act(net, filer, { to: council, data }, gasLimit, 'council createProposal', opts);
  if (!opts.broadcast || !receipt) return null;
  const id = Number(ifaces.council.decodeFunctionResult('proposalCount',
    await call(net, council, ifaces.council.encodeFunctionData('proposalCount', [])))[0]) - 1;
  console.log(`  council proposal #${id} on chain — driving approvals`);

  const getProp = async (pid) => ifaces.council.decodeFunctionResult('getProposal',
    await call(net, council, ifaces.council.encodeFunctionData('getProposal', [pid])))[0];
  const gasPrice = BigInt(await rpc(net.rpc, 'quai_gasPrice', []));
  let count = Number((await getProp(id)).approvals);
  for (const mid of MEMBER_ORDER) {
    if ((await getProp(id)).executed) return { id, result: 'executed' };
    const w = swarm.get(mid);
    const approved = ifaces.council.decodeFunctionResult('hasApproved',
      await call(net, council, ifaces.council.encodeFunctionData('hasApproved', [id, w.address])))[0];
    if (approved) continue;
    const executing = count >= 3;
    const aGas = executing
      ? await estimate(net, w.address, { to: council, data: ifaces.council.encodeFunctionData('approve', [BigInt(id), true]) })
      : 150_000n;
    const balance = BigInt(await rpc(net.rpc, 'quai_getBalance', [w.address, 'latest']));
    if (balance < aGas * gasPrice) {
      console.log(`  council: ${mid} cannot cover ${executing ? 'executing ' : ''}approval gas — skipped`);
      continue;
    }
    await act(net, w, { to: council, data: ifaces.council.encodeFunctionData('approve', [BigInt(id), executing]) },
      aGas, `council approve #${id}${executing ? ' + execute' : ''} (${mid})`, opts);
    count++;
    await sleep(jitter(8_000));
    if ((await getProp(id)).executed) return { id, result: 'executed' };
  }
  return { id, result: (await getProp(id)).executed ? 'executed' : 'open' };
}

// ---------------------------------------------------------------------------
// DarkSafe: one propose -> approve x3 -> execute cycle
// ---------------------------------------------------------------------------

async function safeTransact(net, st, swarm, ifaces, opts, { to, value, data, callGas, note }) {
  const safe = st.safe;
  const wantData = (data ?? '0x').toLowerCase();
  // Resume-first: a previous run may have died mid-cycle (shell timeout, gas
  // spike). If an identical open tx exists, drive it instead of proposing a
  // duplicate that could double-send.
  const count = Number(ifaces.safe.decodeFunctionResult('getTransactionCount',
    await call(net, safe, ifaces.safe.encodeFunctionData('getTransactionCount', [])))[0]);
  let txHash = null;
  if (count > 0) {
    const recent = ifaces.safe.decodeFunctionResult('getTransactionHashes',
      await call(net, safe, ifaces.safe.encodeFunctionData('getTransactionHashes', [Math.max(0, count - 5), Math.min(5, count)])))[0];
    for (const h of recent) {
      const t = ifaces.safe.decodeFunctionResult('getTransaction',
        await call(net, safe, ifaces.safe.encodeFunctionData('getTransaction', [h])))[0];
      if (t.executed || t.cancelled || t.expired) continue;
      if (t.to.toLowerCase() === to.toLowerCase() && BigInt(t.value) === value && t.data.toLowerCase() === wantData) {
        console.log(`  resuming open safe tx ${h.slice(0, 18)}… (${note})`);
        txHash = h;
        break;
      }
    }
  }
  let approvals;
  if (txHash) {
    approvals = Number(ifaces.safe.decodeFunctionResult('getApprovalCount',
      await call(net, safe, ifaces.safe.encodeFunctionData('getApprovalCount', [txHash])))[0]);
  } else {
    const expiration = Math.floor(Date.now() / 1000) + DARKSAFE.trancheExpirySeconds;
    const proposer = await pickActor(net, swarm, 600_000n);
    if (!proposer) fail('no owner can cover proposal gas at current prices — retry later');
    const pData = ifaces.safe.encodeFunctionData('proposeTransaction', [to, value, data ?? '0x', callGas, expiration, 0]);
    const pGas = await estimate(net, proposer.address, { to: safe, data: pData });
    console.log(`  ${proposer.id} proposes: ${note}`);
    const receipt = await act(net, proposer, { to: safe, data: pData }, pGas, 'safe propose', opts);
    if (!opts.broadcast || !receipt) return null;
    const hashes = ifaces.safe.decodeFunctionResult('getTransactionHashes',
      await call(net, safe, ifaces.safe.encodeFunctionData('getTransactionHashes', [count, 1])))[0];
    txHash = hashes[0];
    approvals = 1; // the proposer's approval is recorded with the proposal
    console.log(`  safe tx ${txHash.slice(0, 18)}… proposed — collecting ${DARKSAFE.threshold - 1} more approvals`);
  }

  const gasPrice = BigInt(await rpc(net.rpc, 'quai_gasPrice', []));
  for (const mid of MEMBER_ORDER) {
    if (approvals >= DARKSAFE.threshold) break;
    const w = swarm.get(mid);
    const approved = ifaces.safe.decodeFunctionResult('hasApproved',
      await call(net, safe, ifaces.safe.encodeFunctionData('hasApproved', [txHash, w.address])))[0];
    if (approved) continue;
    const aData = ifaces.safe.encodeFunctionData('approveTransaction', [txHash]);
    const aGas = await estimate(net, w.address, { to: safe, data: aData });
    const balance = BigInt(await rpc(net.rpc, 'quai_getBalance', [w.address, 'latest']));
    if (balance < aGas * gasPrice) { console.log(`  safe: ${mid} cannot cover approval gas — skipped`); continue; }
    await act(net, w, { to: safe, data: aData }, aGas, `safe approve (${mid})`, opts);
    approvals++;
    await sleep(jitter(6_000));
  }
  if (approvals < DARKSAFE.threshold) fail(`only ${approvals}/${DARKSAFE.threshold} approvals landed — rerun tranche to continue`);

  const executor = await pickActor(net, swarm, 800_000n);
  if (!executor) fail('no owner can cover execution gas — retry later');
  const xData = ifaces.safe.encodeFunctionData('executeTransaction', [txHash]);
  const xGas = await estimate(net, executor.address, { to: safe, data: xData });
  console.log(`  ${executor.id} executes: ${note}`);
  await act(net, executor, { to: safe, data: xData }, xGas, 'safe execute', opts);
  const tx = ifaces.safe.decodeFunctionResult('getTransaction',
    await call(net, safe, ifaces.safe.encodeFunctionData('getTransaction', [txHash])))[0];
  if (!tx.executed) fail(`safe tx ${txHash} did not execute`);
  if (tx.failed) fail(`safe tx ${txHash} executed but the inner call FAILED`);
  return txHash;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdKey() {
  const st = loadState();
  if (st.trader) fail(`pit-1 already exists at ${st.trader.address}; refusing to replace it`);
  const isCyprus1Quai = (a) => getZoneForAddress(a) === Zone.Cyprus1 && !isQiAddress(a);
  let wallet;
  do { wallet = new Wallet('0x' + crypto.randomBytes(32).toString('hex')); } while (!isCyprus1Quai(wallet.address));
  const password = crypto.randomBytes(24).toString('base64url');
  const json = await wallet.encrypt(password);
  fs.writeFileSync(path.join(ROOT, 'agents', 'keys', 'pit-1.json'), json);
  const pwPath = path.join(ROOT, 'agents', 'keys', 'passwords.json');
  const passwords = JSON.parse(fs.readFileSync(pwPath, 'utf8'));
  passwords['pit-1'] = password;
  fs.writeFileSync(pwPath, JSON.stringify(passwords, null, 2) + '\n');
  st.trader = { address: wallet.address, keystore: 'agents/keys/pit-1.json', createdAt: new Date().toISOString() };
  saveState(st);
  chronicle('pit-key', { note: `pit-1 ground into Cyprus-1: ${wallet.address} — the desk's one hot key` });
  console.log(`pit-1 trader: ${wallet.address}`);
  console.log('keystore: agents/keys/pit-1.json (gitignored); password recorded in agents/keys/passwords.json');
}

async function cmdFound(net, swarm, ifaces, opts) {
  const st = loadState();
  if (st.safe) fail(`pit safe already founded: ${st.safe}`);
  // Pin check: the on-chain factory must point at the recorded implementation.
  const onChainImpl = getAddress('0x' + (await call(net, DARKSAFE.factory, ifaces.safeFactory.encodeFunctionData('implementation', []))).slice(-40));
  if (onChainImpl.toLowerCase() !== DARKSAFE.implementation.toLowerCase()) {
    fail(`factory implementation ${onChainImpl} != recorded ${DARKSAFE.implementation} — aborting`);
  }
  const owners = MEMBER_ORDER.map((id) => swarm.get(id).address);
  // The probe needs a salt that actually lands in Cyprus-1 (a bad-zone CREATE2
  // reverts, which is why mining exists). Mine for the sovereign to size the
  // limit; calldata length — and therefore gas — is identical for any salt.
  const sovereign = swarm.get('sovereign');
  const probeSalt = mineVaultSalt(ifaces, sovereign.address, owners).salt;
  const probeData = ifaces.safeFactory.encodeFunctionData('createWallet', [
    owners, DARKSAFE.threshold, DARKSAFE.minExecutionDelay, probeSalt,
  ]);
  const gasLimit = await estimate(net, sovereign.address, { to: DARKSAFE.factory, data: probeData });
  const gasPrice = BigInt(await rpc(net.rpc, 'quai_gasPrice', []));
  console.log(`  createWallet estimate -> limit ${gasLimit} (escrow ${fmtQuai(gasLimit * gasPrice)} at current prices)`);
  const creator = await pickActor(net, swarm, gasLimit);
  if (!creator) fail(`no member can escrow ${fmtQuai(gasLimit * gasPrice)} for createWallet — retry when gas cools or consolidate first`);
  const mined = mineVaultSalt(ifaces, creator.address, owners);
  console.log(`  mined salt after ${mined.attempts} attempts for ${creator.id} -> ${mined.address}`);
  const data = ifaces.safeFactory.encodeFunctionData('createWallet', [owners, DARKSAFE.threshold, DARKSAFE.minExecutionDelay, mined.salt]);
  const receipt = await act(net, creator, { to: DARKSAFE.factory, data }, gasLimit, 'darksafe createWallet (obsidianpit)', opts);
  if (opts.broadcast && receipt) {
    const onChain = await call(net, DARKSAFE.factory, ifaces.safeFactory.encodeFunctionData('isWallet', [mined.address]));
    if (BigInt(onChain) !== 1n) fail(`factory does not recognise ${mined.address} as its wallet — aborting`);
    st.safe = mined.address; st.salt = mined.salt; saveState(st);
    chronicle('pit-founded', { note: `the pit is open — DarkSafe vault ${mined.address}, ${DARKSAFE.threshold}-of-${owners.length}, no timelock` });
    console.log(`  pit live: DarkSafe vault ${mined.address}`);
  } else if (!opts.broadcast) {
    console.log('  (dry run — pass --broadcast --i-understand-unaudited to create on chain)');
  }
}

async function cmdMigrate(net, swarm, ifaces, opts, quai, q0) {
  const st = loadState();
  if (!st.safe) fail('pit safe not founded yet — run found first');
  const ts = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'treasury-state.json'), 'utf8'));
  const vaultCouncil = ts.vault?.module;
  if (!ts.vault?.guild || !vaultCouncil) fail('obsidianvault not found in treasury-state.json');
  const quaiWei = BigInt(quai) * 10n ** 18n;
  const q0Wei = BigInt(q0) * 10n ** 18n;
  const actions = [];
  if (quaiWei > 0n) actions.push([st.safe, quaiWei, '0x']);
  if (q0Wei > 0n) actions.push([Q0, 0n, ifaces.erc20.encodeFunctionData('transfer', [st.safe, q0Wei])]);
  if (actions.length === 0) fail('nothing to migrate (--quai 0 --q0 0)');
  const metadata = `PIT MIGRATION — ${quai} QUAI + ${q0} Q0 from the vault to the obsidianpit desk safe (${st.safe}). Budget custody for VDF orderbook operations.`;
  console.log(`  migrate: ${quai} QUAI + ${q0} Q0  vault ${ts.vault.guild} -> safe ${st.safe}`);
  const r = await fileAndDriveCouncil(net, vaultCouncil, swarm, ifaces, opts, metadata, actions);
  if (r?.result === 'executed') {
    st.migrations.push({ proposalId: r.id, quai, q0, at: new Date().toISOString() });
    saveState(st);
    chronicle('pit-migration', { note: `${quai} QUAI + ${q0} Q0 moved vault -> pit safe (council proposal #${r.id})` });
    console.log(`  migration executed — pit safe funded`);
  } else if (r) {
    console.log(`  migration proposal #${r.id} still open — rerun migrate to keep driving`);
  }
}

async function cmdTranche(net, swarm, ifaces, opts, quai, q0) {
  const st = loadState();
  if (!st.safe) fail('pit safe not founded yet — run found first');
  if (!st.trader) fail('no trader key — run key first');
  const quaiWei = BigInt(quai) * 10n ** 18n;
  const q0Wei = BigInt(q0) * 10n ** 18n;
  if (quaiWei === 0n && q0Wei === 0n) fail('empty tranche');
  if (quaiWei > 0n) {
    const h = await safeTransact(net, st, swarm, ifaces, opts, {
      to: st.trader.address, value: quaiWei, data: '0x', callGas: 100_000,
      note: `PIT TRANCHE — ${quai} QUAI to pit-1 (${st.trader.address})`,
    });
    if (h) {
      st.tranches.push({ txHash: h, asset: 'QUAI', amount: quai, at: new Date().toISOString() });
      saveState(st);
      chronicle('pit-tranche', { note: `${quai} QUAI armed pit-1 (safe tx ${h.slice(0, 18)}…)` });
    }
    await sleep(jitter(5_000));
  }
  if (q0Wei > 0n) {
    const h = await safeTransact(net, st, swarm, ifaces, opts, {
      to: Q0, value: 0n, data: ifaces.erc20.encodeFunctionData('transfer', [st.trader.address, q0Wei]), callGas: 200_000,
      note: `PIT TRANCHE — ${q0} Q0 to pit-1 (${st.trader.address})`,
    });
    if (h) {
      st.tranches.push({ txHash: h, asset: 'Q0', amount: q0, at: new Date().toISOString() });
      saveState(st);
      chronicle('pit-tranche', { note: `${q0} Q0 armed pit-1 (safe tx ${h.slice(0, 18)}…)` });
    }
  }
  console.log('  tranche complete — pit-1 armed');
}

async function cmdStatus(net, ifaces) {
  const st = loadState();
  const ts = JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'treasury-state.json'), 'utf8'));
  const line = async (label, addr) => {
    if (!addr) return console.log(`${label}: —`);
    const quai = BigInt(await rpc(net.rpc, 'quai_getBalance', [addr, 'latest']));
    const q0 = uintOf(await call(net, Q0, ifaces.erc20.encodeFunctionData('balanceOf', [addr])));
    console.log(`${label}: ${addr}\n  ${fmtQuai(quai)} | ${q0 / 10n ** 18n} Q0`);
  };
  console.log('── obsidian pit status ──');
  await line('vault  ', ts.vault?.guild);
  await line('pit safe', st.safe);
  if (st.safe) {
    const threshold = ifaces.safe.decodeFunctionResult('getThreshold',
      await call(net, st.safe, ifaces.safe.encodeFunctionData('getThreshold', [])))[0];
    const owners = ifaces.safe.decodeFunctionResult('getOwners',
      await call(net, st.safe, ifaces.safe.encodeFunctionData('getOwners', [])))[0];
    console.log(`  ${threshold}-of-${owners.length} DarkSafe vault`);
  }
  await line('pit-1  ', st.trader?.address);
  console.log(`migrations: ${st.migrations.length}  tranches: ${st.tranches.length}`);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (!cmd || !['key', 'found', 'migrate', 'tranche', 'status'].includes(cmd)) {
  fail('usage: obsidian-pit.mjs --network mainnet <key|found|migrate|tranche|status> [--broadcast --i-understand-unaudited] [--quai N --q0 N]');
}
const net = NETWORKS[args.network];
if (!net) fail(`unknown network ${args.network}`);
const broadcast = args.flags.has('broadcast');
if (broadcast && !args.flags.has('i-understand-unaudited')) fail('broadcast requires --i-understand-unaudited');
const opts = { broadcast, confirmations: net.confirmations };

const ifaces = buildIfaces();
const provider = new JsonRpcProvider(net.rpc, Number(net.chainId));
const manifest = loadManifest();
const swarm = await loadSwarm(manifest, provider, broadcast);

if (cmd === 'key') await cmdKey();
else if (cmd === 'found') await cmdFound(net, swarm, ifaces, opts);
else if (cmd === 'migrate') await cmdMigrate(net, swarm, ifaces, opts, args.quai ?? '100', args.q0 ?? '100000');
else if (cmd === 'tranche') await cmdTranche(net, swarm, ifaces, opts, args.quai ?? '40', args.q0 ?? '60000');
else if (cmd === 'status') await cmdStatus(net, ifaces);
