#!/usr/bin/env node
/**
 * Soak test: runs the whole SafeBuddy v2 lifecycle on a live chain and records what it cost.
 *
 *   node scripts/soak-v2.mjs --network local        (anvil, via scripts/local-quai-chain.mjs)
 *   node scripts/soak-v2.mjs --network orchard --owners a.json,b.json,c.json [--confirmations 2] [--resume]
 *
 * Every step goes through the same pipeline the app uses (packages/core/src/tx.ts: simulate,
 * access list, explicit gas), waits for confirmations, then asserts the vault's state through
 * @safebuddy/core. The steps: create a vault through the factory and fund it; propose, approve,
 * wait out the timelock and execute; check that a starved execute reverts; revoke; cancel; let
 * a transaction expire; admin changes (threshold, remove and re-add an owner to check stale
 * approvals are dropped, timelock); cancel by consensus; then the watcher and safebuddy-verify
 * over the result.
 *
 * Progress is saved after every step (deployments/soak-<network>.state.json); --resume carries
 * on after an interruption, which matters on Orchard where blocks can be many minutes apart.
 * The report (estimate vs limit vs used gas, blocks and seconds to confirm, QUAI spent) goes to
 * deployments/soak-<network>-<timestamp>.json.
 *
 * Keys: on Quai networks the three owner keys come only from encrypted keystores (password from
 * SAFEBUDDY_KEYSTORE_PASSWORD_FILE, one file for all three, or a hidden prompt per keystore).
 * Locally, accounts are anvil-impersonated and no keys exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Wallet, JsonRpcProvider, QuaiTransaction } from 'quais';
import { getAddress, hexlify, randomBytes, parseEther, formatEther } from 'ethers';
import {
  QuaiRpcClient,
  prepareQuaiTransaction,
  waitForConfirmations,
  receiptSucceeded,
  resolveDeployment,
  assertVaultAuthentic,
  assertVaultMatchesParams,
  readVaultTransaction,
  readChainClock,
  mineVaultSalt,
  createWalletCall,
  walletCreatedFromLogs,
  proposedHashFromLogs,
  vaultCalls,
  adminCalls,
  describeVaultRevert,
  isCyprus1QuaiAddress,
  formatDuration,
} from '@safebuddy/core';
import { runVerify } from '@safebuddy/verify';
import { pollOnce, emptyState } from '@safebuddy/watcher';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const NETWORKS = {
  local: { chainId: 15000, rpc: 'http://127.0.0.1:8546', confirmations: 1, pollMs: 300, timeoutMs: 60_000, fund: parseEther('1'), pay: parseEther('0.01') },
  orchard: {
    chainId: 15000,
    rpc: 'https://orchard.rpc.quai.network/cyprus1',
    pathingBase: 'https://orchard.rpc.quai.network',
    confirmations: 6,
    pollMs: 5_000,
    timeoutMs: 90 * 60_000,
    fund: parseEther('0.02'),
    pay: parseEther('0.001'),
  },
  mainnet: {
    chainId: 9,
    rpc: 'https://rpc.quai.network/cyprus1',
    pathingBase: 'https://rpc.quai.network',
    confirmations: 3,
    pollMs: 5_000,
    timeoutMs: 60 * 60_000,
    fund: parseEther('0.02'),
    pay: parseEther('0.001'),
  },
};
const DELAY = 120; // vault timelock for the soak, seconds
const DELAY_AFTER = 60; // after setMinExecutionDelay

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue; // pnpm forwards a bare -- separator
    if (!a.startsWith('--')) fail(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (['resume', 'mainnet-audited'].includes(key)) out.flags.add(key);
    else if (['network', 'owners', 'factory', 'confirmations'].includes(key)) out[key] = argv[++i];
    else fail(`unknown option ${a}`);
  }
  return out;
}

async function hiddenPrompt(question) {
  if (!process.stdin.isTTY) fail('no TTY for the password prompt; set SAFEBUDDY_KEYSTORE_PASSWORD_FILE');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => (s.includes(question) ? write(s) : undefined);
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

const jsonBig = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n';

// ---------------------------------------------------------------- senders

/** Signs with an encrypted keystore through quais (the only way keys enter this script). */
async function keystoreSender(file, net) {
  if (!fs.existsSync(file)) fail(`keystore ${file} not found`);
  const pwFile = process.env.SAFEBUDDY_KEYSTORE_PASSWORD_FILE;
  const password = pwFile ? fs.readFileSync(pwFile, 'utf8').replace(/\r?\n$/, '') : await hiddenPrompt(`Password for ${path.basename(file)}: `);
  const provider = new JsonRpcProvider(net.pathingBase, undefined, { usePathing: true });
  const wallet = (await Wallet.fromEncryptedJson(fs.readFileSync(file, 'utf8'), password)).connect(provider);
  const address = getAddress(wallet.address);
  if (!isCyprus1QuaiAddress(address)) fail(`${file} holds ${address}, which is not a Cyprus-1 Quai address`);
  return {
    address,
    async send(prepared) {
      const pop = await wallet.populateQuaiTransaction({
        from: prepared.from,
        to: prepared.to,
        data: prepared.data,
        value: prepared.value ?? 0n,
        gasLimit: prepared.gasLimit,
        accessList: prepared.accessList,
      });
      if (BigInt(pop.gasLimit) !== prepared.gasLimit) fail('quais changed the prepared gas limit; not sending');
      const signed = await wallet.signTransaction(QuaiTransaction.from(pop));
      const resp = await provider.broadcastTransaction(await wallet.zoneFromAddress(address), signed, address);
      return resp.hash;
    },
  };
}

/** Local only: the proxy impersonates `from` on anvil (and funds it). */
function impersonatedSender(rpc, address) {
  return {
    address,
    async send(prepared) {
      const tx = { from: prepared.from, data: prepared.data, gasLimit: '0x' + prepared.gasLimit.toString(16) };
      if (prepared.to) tx.to = prepared.to;
      if (prepared.value) tx.value = '0x' + prepared.value.toString(16);
      if (prepared.accessList) tx.accessList = prepared.accessList;
      return rpc.rawRequest('quai_sendTransaction', [tx]);
    },
  };
}

function randomCyprus() {
  for (;;) {
    const a = getAddress(hexlify(randomBytes(20)));
    if (isCyprus1QuaiAddress(a)) return a;
  }
}

// ---------------------------------------------------------------- main

const args = parseArgs(process.argv.slice(2));
const netName = args.network ?? fail('--network local|orchard|mainnet is required');
const net = NETWORKS[netName] ?? fail(`unknown network ${netName}`);
if (netName === 'mainnet' && !args.flags.has('mainnet-audited')) {
  fail('refusing a mainnet soak without --mainnet-audited: v2 has not had an independent audit yet');
}
const confirmations = Number(args.confirmations ?? net.confirmations);
const rpc = new QuaiRpcClient(net.rpc, { maxRetries: 3, timeoutMs: 30_000 });
const reportedChain = parseInt(await rpc.rawRequest('quai_chainId', []), 16);
if (reportedChain !== net.chainId) fail(`RPC reports chain ${reportedChain}, expected ${net.chainId}`);

let factoryOverride = args.factory ?? null;
if (netName === 'local' && !factoryOverride) {
  const local = path.join(ROOT, '.localchain.json');
  if (!fs.existsSync(local)) fail('start scripts/local-quai-chain.mjs first (or pass --factory)');
  factoryOverride = JSON.parse(fs.readFileSync(local, 'utf8')).factory;
}
const deployment = await resolveDeployment(rpc, net.chainId, factoryOverride);
console.log(`network ${netName} (chain ${net.chainId}), factory ${deployment.factory} verified, ${confirmations} confirmation(s)`);

let senders;
if (netName === 'local') {
  senders = [randomCyprus(), randomCyprus(), randomCyprus()].map((a) => impersonatedSender(rpc, a));
} else {
  const files = (args.owners ?? fail('--owners a.json,b.json,c.json (three encrypted keystores) is required')).split(',');
  if (files.length !== 3) fail('--owners needs exactly three keystores');
  senders = [];
  for (const f of files) senders.push(await keystoreSender(f, net));
  if (new Set(senders.map((s) => s.address.toLowerCase())).size !== 3) fail('the three keystores must hold different accounts');
}
const [A, B, C] = senders;

const statePath = path.join(ROOT, 'deployments', `soak-${netName}.state.json`);
fs.mkdirSync(path.dirname(statePath), { recursive: true });
let state =
  args.flags.has('resume') && fs.existsSync(statePath)
    ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
    : { network: netName, owners: senders.map((s) => s.address), factory: deployment.factory, startedAt: new Date().toISOString(), done: [], records: [], txs: {}, vault: null, notes: [] };
if (state.owners.join() !== senders.map((s) => s.address).join() && netName !== 'local') fail('--resume with different owners than the saved run');
if (netName === 'local' && args.flags.has('resume')) fail('--resume is for live networks; local runs are quick');
const save = () => fs.writeFileSync(statePath, jsonBig(state));

async function balanceOf(address) {
  return BigInt(await rpc.rawRequest('quai_getBalance', [address, 'latest']));
}

/** One on-chain transaction through the app's pipeline; returns the receipt and records the cost. */
async function send(label, sender, draft) {
  const started = Date.now();
  const prepared = await prepareQuaiTransaction(rpc, { from: sender.address, ...draft });
  const hash = await sender.send(prepared);
  process.stdout.write(`  ${label}: ${hash} `);
  const receipt = await waitForConfirmations(rpc, hash, {
    confirmations,
    timeoutMs: net.timeoutMs,
    pollMs: net.pollMs,
    onProgress: (p) => p.stage === 'mined' && process.stdout.write('.'),
  });
  if (!receiptSucceeded(receipt)) throw new Error(`${label} reverted on chain (${hash})`);
  const gasUsed = BigInt(receipt.gasUsed);
  const price = BigInt(receipt.effectiveGasPrice ?? '0x0');
  state.records.push({
    label,
    txHash: hash,
    from: sender.address,
    estimatedGas: prepared.estimatedGas,
    gasLimit: prepared.gasLimit,
    gasUsed,
    usedOverEstimate: Number((gasUsed * 1000n) / (prepared.estimatedGas || 1n)) / 1000,
    usedOverLimit: Number((gasUsed * 1000n) / prepared.gasLimit) / 1000,
    feeWei: gasUsed * price,
    seconds: Math.round((Date.now() - started) / 1000),
    block: BigInt(receipt.blockNumber),
  });
  console.log(` ok (gas ${gasUsed}/${prepared.gasLimit}, estimate ${prepared.estimatedGas})`);
  return receipt;
}

async function propose(label, sender, { to, value = 0n, data = '0x', gasLimit, windowSeconds = 7 * 86_400, requestedDelay = 0 }) {
  const clock = await readChainClock(rpc);
  const self = to.toLowerCase() === state.vault.toLowerCase();
  const snapshot = (await assertVaultAuthentic(rpc, state.vault, deployment)).snapshot;
  const delay = self ? 0 : Math.max(snapshot.minExecutionDelay, requestedDelay);
  const expiration = clock.chainTime + delay + windowSeconds;
  const receipt = await send(label, sender, {
    to: state.vault,
    data: vaultCalls.propose({ to, value, data, gasLimit: self ? 0n : gasLimit ?? 60_000n, expiration, requestedDelay }),
  });
  const hash = proposedHashFromLogs(receipt.logs, state.vault);
  state.txs[label] = { hash, nonce: snapshot.txNonce };
  return hash;
}

const act = (label, sender, kind, name) => send(label, sender, { to: state.vault, data: vaultCalls[kind](state.txs[name].hash) });
const tx = (name) => readVaultTransaction(rpc, state.vault, state.txs[name].hash, state.txs[name].nonce);
const vaultState = async () => (await assertVaultAuthentic(rpc, state.vault, deployment)).snapshot;

function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
}

/** Waits until chain time passes `t` (locally, moves anvil's clock instead of waiting). */
async function waitForChainTime(t, why) {
  if (netName === 'local') {
    const now = (await readChainClock(rpc)).chainTime;
    if (now <= t) {
      await rpc.rawRequest('evm_increaseTime', [t - now + 1]);
      await rpc.rawRequest('evm_mine', []);
    }
    return;
  }
  for (;;) {
    const now = (await readChainClock(rpc)).chainTime;
    if (now > t) return;
    process.stdout.write(`\r  waiting ${formatDuration(t - now + 1)} of chain time (${why})   `);
    await new Promise((r) => setTimeout(r, net.pollMs));
  }
}

const STEPS = [
  [
    'create-vault',
    async () => {
      const params = { owners: senders.map((s) => s.address), threshold: 2, minExecutionDelay: DELAY };
      const mined = mineVaultSalt({ factory: deployment.factory, implementation: deployment.implementation, creator: A.address, params });
      const receipt = await send('createWallet', A, { to: deployment.factory, data: createWalletCall(params.owners, 2, DELAY, mined.salt) });
      const created = walletCreatedFromLogs(receipt.logs, deployment.factory);
      check(created.wallet === mined.address, `vault landed at ${created.wallet}, predicted ${mined.address}`);
      state.vault = created.wallet;
      assertVaultMatchesParams(await assertVaultAuthentic(rpc, state.vault, deployment), params);
      console.log(`  vault ${state.vault} (salt found in ${mined.attempts} attempts)`);
    },
  ],
  [
    'fund',
    async () => {
      await send('fund vault', A, { to: state.vault, data: '0x', value: net.fund });
      check((await balanceOf(state.vault)) === net.fund, 'vault balance after funding');
    },
  ],
  [
    'transfer-lifecycle',
    async () => {
      await propose('T1', A, { to: A.address, value: net.pay });
      check((await tx('T1')).status === 'Pending', 'T1 pending after proposal');
      await act('approve T1', B, 'approve', 'T1');
      const t1 = await tx('T1');
      check(t1.status === 'Timelocked' && t1.approvedAt > 0, 'T1 timelocked with the clock started');

      // A starved execute must revert (InsufficientGas), never burn the transaction. Simulated only:
      // on Quai a reverted transaction is charged its whole gas limit.
      await waitForChainTime(t1.approvedAt + t1.executionDelay, 'T1 timelock');
      const starved = await rpc
        .rawRequest('quai_call', [{ from: C.address, to: state.vault, data: vaultCalls.execute(state.txs.T1.hash), gas: '0x' + (150_000).toString(16) }, 'latest'])
        .then(
          () => 'did not revert',
          (e) => describeVaultRevert(e?.data) ?? e?.message
        );
      // 150k clears the pre-checks but not the ~161k the vault requires for a 60k call.
      state.notes.push(`starved execute (150k gas) simulation: ${starved}`);
      const exact = /InsufficientGas/.test(starved);
      // Some Quai nodes return no revert data from quai_call; then a bare revert is accepted but noted.
      check(exact || (netName !== 'local' && /revert/i.test(starved)), `starved execute should revert with InsufficientGas, got: ${starved}`);

      const before = await balanceOf(state.vault);
      await act('execute T1', C, 'execute', 'T1');
      check((await tx('T1')).status === 'Executed', 'T1 executed');
      check(before - (await balanceOf(state.vault)) === net.pay, 'T1 moved exactly the proposed value');
    },
  ],
  [
    'revoke-and-expire',
    async () => {
      await propose('T2', A, { to: A.address, value: net.pay, windowSeconds: 90 });
      await act('approve T2', B, 'approve', 'T2');
      const approvedAt = (await tx('T2')).approvedAt;
      await act('revoke T2', B, 'revoke', 'T2');
      const t2 = await tx('T2');
      check(t2.approvals.length === 1 && t2.approvedAt === approvedAt, 'revoking keeps approvedAt and drops the approval');
      await waitForChainTime(t2.expiration, 'T2 expiry');
      await act('expire T2', B, 'expire', 'T2');
      check((await tx('T2')).status === 'Expired', 'T2 expired');
    },
  ],
  [
    'cancel',
    async () => {
      await propose('T3', A, { to: B.address, value: net.pay });
      await act('cancel T3', A, 'cancel', 'T3');
      check((await tx('T3')).status === 'Cancelled', 'T3 cancelled by its proposer');
    },
  ],
  [
    'admin-and-epochs',
    async () => {
      const runAdmin = async (label, data, approvers) => {
        await propose(label, A, { to: state.vault, data });
        for (const s of approvers) await act(`approve ${label}`, s, 'approve', label);
        await act(`execute ${label}`, A, 'execute', label);
        check((await tx(label)).status === 'Executed', `${label} executed`);
      };
      await runAdmin('threshold-3', adminCalls.changeThreshold(3), [B]);
      check((await vaultState()).threshold === 3, 'threshold is 3');

      await propose('T6', A, { to: A.address, value: net.pay });
      await act('approve T6', C, 'approve', 'T6');
      check((await tx('T6')).approvals.length === 2, 'T6 has two approvals');

      await runAdmin('remove-C', adminCalls.removeOwner(C.address, 2), [B, C]);
      let snap = await vaultState();
      check(snap.owners.length === 2 && snap.threshold === 2, 'C removed, threshold 2');
      check((await tx('T6')).approvals.length === 1, "C's approval of T6 stopped counting");

      await runAdmin('re-add-C', adminCalls.addOwner(C.address, 2), [B]);
      snap = await vaultState();
      check(snap.owners.length === 3, 'C re-added');
      check((await tx('T6')).approvals.length === 1, "C's old approval did not come back");

      await runAdmin('delay-60', adminCalls.setMinExecutionDelay(DELAY_AFTER), [B]);
      check((await vaultState()).minExecutionDelay === DELAY_AFTER, 'timelock changed');
    },
  ],
  [
    'cancel-by-consensus',
    async () => {
      await propose('T7', A, { to: A.address, value: net.pay });
      await act('approve T7', B, 'approve', 'T7');
      check((await tx('T7')).approvedAt > 0, 'T7 reached quorum');
      await propose('cancel-T7', A, { to: state.vault, data: adminCalls.cancelByConsensus(state.txs.T7.hash) });
      await act('approve cancel-T7', B, 'approve', 'cancel-T7');
      await act('execute cancel-T7', A, 'execute', 'cancel-T7');
      check((await tx('T7')).status === 'Cancelled', 'T7 cancelled by consensus after quorum');
    },
  ],
  [
    'tools',
    async () => {
      const lines = [];
      const makeRpc = () => rpc;
      const extra = netName === 'local' ? ['--chain-id', String(net.chainId), '--rpc', net.rpc] : ['--network', netName === 'mainnet' ? 'mainnet' : 'testnet', '--rpc', net.rpc];
      const vaultCode = await runVerify(['vault', state.vault, '--factory', deployment.factory, ...extra], { makeRpc, write: (l) => lines.push(l) });
      const txCode = await runVerify(['tx', state.vault, state.txs.T1.hash, '--factory', deployment.factory, ...extra], { makeRpc, write: (l) => lines.push(l) });
      state.notes.push(...lines.filter((l) => /digest|agree|grade/.test(l)).map((l) => `verify: ${l.trim()}`));
      check(vaultCode === 0 && txCode === 0, `safebuddy-verify exit codes ${vaultCode}/${txCode}`);

      // The watcher from an empty cursor sees the vault and its open transaction (T6).
      const { alerts, state: w } = await pollOnce(emptyState(net.chainId), { sources: [{ name: 'rpc', rpc }], deployment, vaults: [state.vault], confirmations: 1 });
      check(alerts.some((a) => a.kind === 'watching'), 'watcher baselined the vault');
      check(Object.keys(w.vaults[state.vault].open).includes(state.txs.T6.hash), 'watcher tracks the open transaction');
      state.notes.push(`watcher: ${alerts.map((a) => a.kind).join(', ')}`);
    },
  ],
];

const spentBefore = await Promise.all(senders.map((s) => balanceOf(s.address)));
try {
  for (const [id, run] of STEPS) {
    if (state.done.includes(id)) {
      console.log(`- ${id} (done)`);
      continue;
    }
    console.log(`- ${id}`);
    await run();
    state.done.push(id);
    save();
  }
} catch (err) {
  save();
  console.error(`\nsoak stopped: ${err?.message ?? err}`);
  console.error(`progress saved to ${path.relative(process.cwd(), statePath)}${netName === 'local' ? '' : '; rerun with --resume'}`);
  process.exit(1);
}

const spentAfter = await Promise.all(senders.map((s) => balanceOf(s.address)));
const report = {
  network: netName,
  chainId: net.chainId,
  factory: deployment.factory,
  implementation: deployment.implementation,
  vault: state.vault,
  confirmations,
  startedAt: state.startedAt,
  finishedAt: new Date().toISOString(),
  transactions: state.records.length,
  feesWei: state.records.reduce((sum, r) => sum + BigInt(r.feeWei), 0n),
  // Locally the proxy tops up impersonated senders, so balance changes mean nothing there.
  ownerBalanceChangeWei: netName === 'local' ? null : spentAfter.reduce((sum, b, i) => sum + (b - spentBefore[i]), 0n),
  worstUsedOverEstimate: Math.max(...state.records.map((r) => r.usedOverEstimate)),
  worstUsedOverLimit: Math.max(...state.records.map((r) => r.usedOverLimit)),
  records: state.records,
  notes: state.notes,
};
const out = path.join(ROOT, 'deployments', `soak-${netName}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(out, jsonBig(report));
fs.rmSync(statePath, { force: true });
console.log(`\nsoak passed: ${report.transactions} transactions, ${formatEther(report.feesWei)} QUAI in fees`);
console.log(`worst gas used/estimate ${report.worstUsedOverEstimate}, worst used/limit ${report.worstUsedOverLimit}`);
state.notes.forEach((n) => console.log(`  ${n}`));
console.log(`report: ${path.relative(process.cwd(), out)}`);
