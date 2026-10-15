#!/usr/bin/env node
/**
 * DarkCircle relayer: Orchard rehearsal (RELAYER_PLAN.md phase 4)
 * File: scripts/relayer-rehearsal.ts
 *
 * Runs the real sequence against the Orchard WQI pool with real transactions:
 *
 *   gate  — byte-compare a KeystoreQuaiSigner signature against a known-good reference for the
 *           same fixed vector (quais SDK if it is importable, else --gate-reference <hex> from the
 *           operator). The rehearsal ABORTS if the encodings differ. Nothing is broadcast before
 *           this passes.
 *   full  — the whole sequence, each step recorded with transaction hashes:
 *             1. verify the pool on chain (code, token immutable)
 *             2. rebuild the Merkle tree from the pool's Shield events
 *             3. quote the relayer fee over its real HTTP API
 *             4. the operator shields amount+fee from their own wallet
 *             5. prove an unshield to a fresh, unfunded recipient with snarkjs
 *             6. relay it through the relayer's real HTTP API and wait for confirmation
 *             7. verify on chain: nullifier spent, nextIndex advanced, recipient paid exactly,
 *                the relayer paid exactly the quoted fee
 *             8. the failure cases, all refusing with a named error before any gas is spent:
 *                relayer offline (SP-EX-04), fee below quote, a proof naming a different relayer
 *             9. write rehearsal-<ts>.json (checklist T-06's record)
 *
 * Environment (same names the production relayer uses, plus the operator key):
 *   RELAYER_NETWORK            default quai-orchard-cyprus1
 *   RELAYER_RPC_URL            override the zone endpoint (default from the registry)
 *   RELAYER_POOL_ADDRESS       the Orchard WQI pool
 *   RELAYER_TOKEN_ADDRESS      its token (checked against the pool's immutable)
 *   RELAYER_KEYSTORE_PATH      the relayer's encrypted keystore (passphrase below)
 *   RELAYER_KEYSTORE_PASSPHRASE
 *   REHEARSAL_OPERATOR_KEY     the operator's shield wallet key (env only, never logged)
 * Flags: --amount <n> (whole token units, default 1), --build-dir <dir> (default ./build),
 *        --gate-reference <hex>, --json-out <path>.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Interface, Wallet, getAddress, id as keccakId } from "ethers";
import * as snarkjs from "snarkjs";
import { QuaiRpcClient, type QuaiReceipt } from "../src/quai/rpc.ts";
import { resolveQuaiNetwork, type QuaiNetwork } from "../src/quai/networks.ts";
import { toQuaiChecksum } from "../src/quai/address.ts";
import { DarkCircleRelayer, type RelayerConfig } from "../src/relayer/relayer.ts";
import { RelayStore } from "../src/relayer/store.ts";
import { PermittedCallSigner, UNSHIELD_SELECTOR, WalletQuaiSigner } from "../src/relayer/signer.ts";
import { createRelayerHttp, type RunningRelayerHttp } from "../src/relayer/http.ts";
import { isRelayerError, type RelayRequest } from "../src/relayer/types.ts";
import { Fp } from "../src/crypto/field.ts";
import { poseidon2, poseidon4 } from "../src/crypto/poseidon.ts";
import { IncrementalMerkleTree } from "../src/crypto/merkleTree.ts";
import { deriveCorporateKeyHierarchy, generateSeed } from "../src/audit/keys.ts";
import { buildWitness } from "../src/sim/witness.ts";

// --------------------------------------------------------------------------- CLI & environment

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--amount", "--build-dir", "--gate-reference", "--json-out"]);
const mode = ((): string => {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (VALUE_FLAGS.has(args[i])) i++; // skip the flag's value
      continue;
    }
    return args[i];
  }
  return "full";
})();

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function env(name: string, dflt?: string): string {
  const v = process.env[name] ?? dflt;
  if (!v || !v.trim()) throw new Error(`ERR_REHEARSAL_CONFIG: ${name} is required`);
  return v.trim();
}

const NETWORK: QuaiNetwork = resolveQuaiNetwork(process.env.RELAYER_NETWORK ?? "quai-orchard-cyprus1")!;
const POOL = getAddress(env("RELAYER_POOL_ADDRESS"));
const TOKEN = getAddress(env("RELAYER_TOKEN_ADDRESS"));
const OPERATOR_KEY = env("REHEARSAL_OPERATOR_KEY");
const AMOUNT_UNITS = BigInt(flag("amount") ?? "1");
const BUILD_DIR = path.resolve(flag("build-dir") ?? "build");
const GATE_REFERENCE = flag("gate-reference");
const JSON_OUT = flag("json-out") ?? `rehearsal-${NETWORK.zone.name}-${Date.now()}.json`;

const ONE = 10n ** 18n;
const PAY_AMOUNT = AMOUNT_UNITS * ONE; // whole token units → base units

const POOL_IFACE = new Interface([
  "function token() view returns (address)",
  "function nextIndex() view returns (uint32)",
  "function currentRoot() view returns (uint256)",
  "function nullifierSpent(uint256) view returns (bool)",
  "function shield(uint256 npk, uint256 amount, uint256 rho)",
  "event Shield(uint256 indexed commitment, uint32 leafIndex, uint256 amount, address indexed depositor)"
]);
const ERC20_IFACE = new Interface([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount)"
]);
const SHIELD_TOPIC = keccakId("Shield(uint256,uint32,uint256,address)");

/** The gate vector: fixed, so a reference signature from any tool is comparable byte for byte. */
const GATE_VECTOR = {
  chainId: 0, // filled per network in gate()
  nonce: 0,
  gasPrice: 1n,
  gasLimit: "0x5208",
  to: POOL,
  value: "0x0",
  data: UNSHIELD_SELECTOR + "00".repeat(64),
  accessList: [] as { address: string; storageKeys: string[] }[]
};

interface Check {
  id: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
  if (!ok) throw new Error(`ERR_REHEARSAL: step ${id} failed: ${detail}`);
}

function rpcClient(): QuaiRpcClient {
  const rpcUrl = process.env.RELAYER_RPC_URL ?? NETWORK.rpcUrl;
  return new QuaiRpcClient({ network: { ...NETWORK, rpcUrl } });
}

async function callView(rpc: QuaiRpcClient, to: string, iface: Interface, fn: string, args: unknown[] = []): Promise<unknown> {
  const raw = await rpc.call({ to, data: iface.encodeFunctionData(fn, args) });
  return iface.decodeFunctionResult(fn, raw)[0];
}

async function waitForReceipt(rpc: QuaiRpcClient, txHash: string, what: string, timeoutMs = 10 * 60_000): Promise<QuaiReceipt> {
  const start = Date.now();
  for (;;) {
    const r = await rpc.getTransactionReceipt(txHash);
    if (r && r.blockNumber !== undefined) return r;
    if (Date.now() - start > timeoutMs) throw new Error(`ERR_REHEARSAL: ${what}: no receipt for ${txHash} within ${timeoutMs / 1000}s`);
    await new Promise((r2) => setTimeout(r2, 5_000));
  }
}

/** The operator's wallet signs whatever the rehearsal needs; the policy guard is the RELAYER's only. */
async function sendOperatorTx(rpc: QuaiRpcClient, signer: WalletQuaiSigner, to: string, data: string, what: string): Promise<string> {
  const prepared = await rpc.prepareContractCall({ from: signer.address, to, data });
  const gasPrice = BigInt(await rpc.request<string>("quai_gasPrice"));
  const nonce = Number(await rpc.getTransactionCount(signer.address));
  const raw = await signer.sign({ ...prepared, nonce, gasPrice });
  const txHash = await rpc.request<string>("quai_sendRawTransaction", [raw]);
  const receipt = await waitForReceipt(rpc, txHash, what);
  if (Number(receipt.status) !== 1) throw new Error(`ERR_REHEARSAL: ${what} reverted on chain: ${txHash}`);
  return txHash;
}

async function openRelayerSigner(): Promise<PermittedCallSigner> {
  return new PermittedCallSigner(
    await WalletQuaiSigner.fromKeystoreFile(env("RELAYER_KEYSTORE_PATH"), env("RELAYER_KEYSTORE_PASSPHRASE")),
    POOL
  );
}

// --------------------------------------------------------------------------- the wire-format gate

/**
 * The gate needs a reference signature produced by a known-good signer. There is no automatic
 * quais attempt on purpose: guessing the SDK's transaction shape here could compare against a
 * wrongly-encoded reference and produce a false pass. The operator signs the printed vector with
 * the quais SDK (or the node's own signer) using the SAME relayer key and passes it in.
 */
async function referenceSignature(): Promise<string> {
  if (GATE_REFERENCE) return GATE_REFERENCE;
  throw new Error(
    "ERR_REHEARSAL_GATE: no reference signature provided.\n" +
      "Sign the gate vector above with the SAME relayer key and re-run with --gate-reference 0x....\n" +
      "With quais (roughly):\n" +
      "  const wallet = new quais.Wallet(RELAYER_PRIVATE_KEY);\n" +
      "  const signed = await wallet.signTransaction({ chainId, nonce: 0, gasPrice: 1,\n" +
      "    gasLimit: 21000, to: POOL, value: 0, data, accessList: [] });\n" +
      "The rehearsal refuses to broadcast until the encodings match byte for byte."
  );
}

async function gate(): Promise<void> {
  const signer = await openRelayerSigner();
  GATE_VECTOR.chainId = NETWORK.chainId;
  const ours = await signer.sign(GATE_VECTOR);
  console.log(`gate vector: chainId=${GATE_VECTOR.chainId} nonce=0 gasPrice=1 gas=0x5208 to=${POOL} value=0`);
  console.log(`our signature: ${ours}`);

  const reference = await referenceSignature();
  const match = ours.toLowerCase() === reference.toLowerCase();
  check(
    "GATE-1",
    match,
    match ? "KeystoreQuaiSigner output is byte-identical to the reference" : `encoding mismatch:\n  ours:      ${ours}\n  reference: ${reference}`
  );
}

// --------------------------------------------------------------------------- the full sequence

interface RehearsalState {
  rpc: QuaiRpcClient;
  operator: WalletQuaiSigner;
  relayer: DarkCircleRelayer;
  http: RunningRelayerHttp;
  authToken: string;
  report: Record<string, unknown>;
}

async function startRelayer(rpc: QuaiRpcClient): Promise<RehearsalState> {
  const signer = await openRelayerSigner();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-rehearsal-"));
  const config: RelayerConfig = {
    poolAddress: POOL,
    tokenAddress: TOKEN,
    minFee: 5n * 10n ** 17n, // 0.5 units, the simulated relayer's floor
    unshieldGasEstimate: 400_000n,
    gasHeadroomPercent: 150,
    quoteValidityBlocks: 12,
    minGasBalance: ONE, // 1 QUAI
    confirmationsRequired: 2,
    maxRelayAttempts: 3,
    txTimeoutBlocks: 64
  };
  const relayer = new DarkCircleRelayer({
    rpc,
    signer,
    store: new RelayStore(path.join(dir, "state.json")),
    config,
    log: (m) => console.log(`  [relayer] ${m}`)
  });
  await relayer.reconcile();
  const authToken = crypto.randomBytes(24).toString("hex");
  const http = await createRelayerHttp({ relayer, port: 0, authToken, log: () => {} });
  return { rpc, operator: WalletQuaiSigner.fromPrivateKey(OPERATOR_KEY), relayer, http, authToken, report: { relayer: signer.address } };
}

async function api(state: RehearsalState, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${state.http.url}${p}`, {
    method,
    headers: { authorization: `Bearer ${state.authToken}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, json: await res.json() };
}

/** Rebuild the pool's Merkle tree from its Shield events so the new note's path is provable. */
async function rebuildTree(rpc: QuaiRpcClient): Promise<{ tree: IncrementalMerkleTree; nextIndex: number }> {
  const nextIndex = Number(await callView(rpc, POOL, POOL_IFACE, "nextIndex"));
  const tree = new IncrementalMerkleTree(16, 64);
  if (nextIndex > 0) {
    const logs = (await rpc.request<{ topics: string[]; data: string }[]>("quai_getLogs", [
      { address: toQuaiChecksum(POOL), fromBlock: "0x0", toBlock: "latest", topics: [SHIELD_TOPIC] }
    ])) ?? [];
    const leaves = logs
      .map((l) => {
        const decoded = POOL_IFACE.decodeEventLog("Shield", l.data, l.topics);
        return { commitment: BigInt(l.topics[1]), leafIndex: Number((decoded as unknown as { leafIndex: bigint }).leafIndex) };
      })
      .sort((a, b) => a.leafIndex - b.leafIndex);
    check("SEQ-2a", leaves.length === nextIndex, `rebuilt ${leaves.length} leaves from Shield events (nextIndex ${nextIndex})`);
    for (const leaf of leaves) tree.insert(leaf.commitment);
  }
  return { tree, nextIndex };
}

async function full(): Promise<void> {
  console.log(`rehearsal on ${NETWORK.id} against pool ${POOL}`);
  const rpc = rpcClient();
  await rpc.assertZone();

  // 1. the pool is what we think it is
  const code = await rpc.getCode(POOL);
  check("SEQ-1a", code !== "0x" && code.length > 2, `pool has code (${(code.length - 2) / 2} bytes)`);
  const poolToken = getAddress(String(await callView(rpc, POOL, POOL_IFACE, "token")));
  check("SEQ-1b", poolToken.toLowerCase() === TOKEN.toLowerCase(), `pool token ${poolToken} matches RELAYER_TOKEN_ADDRESS`);
  const symbol = String(await callView(rpc, TOKEN, ERC20_IFACE, "symbol"));

  const state = await startRelayer(rpc);
  const report = state.report;
  console.log(`relayer ${state.relayer.signerAddress} at ${state.http.url}`);

  // 2. balances fund the sequence
  const relayerGas = await rpc.getBalance(state.relayer.signerAddress);
  check("SEQ-2b", relayerGas > ONE, `relayer holds ${relayerGas / ONE} QUAI (floor 1)`);
  const operatorToken = BigInt(String(await callView(rpc, TOKEN, ERC20_IFACE, "balanceOf", [state.operator.address])));
  console.log(`operator ${state.operator.address} holds ${operatorToken / ONE} ${symbol}; relayer holds ${relayerGas / ONE} QUAI`);

  // 3. quote BEFORE proving (the fee is bound into the proof)
  const quoteRes = await api(state, "POST", "/quote", { token: TOKEN });
  check("SEQ-3a", quoteRes.status === 200, `quote over HTTP: ${JSON.stringify(quoteRes.json)}`);
  const fee = BigInt(quoteRes.json.estimatedFeeUnits);
  const quote = quoteRes.json;
  check("SEQ-3b", quoteRes.json.relayer === state.relayer.signerAddress, "the quote names this relayer");
  check("SEQ-3c", operatorToken >= PAY_AMOUNT + fee, `operator can cover ${PAY_AMOUNT / ONE} + fee ${fee / ONE} ${symbol}`);
  const shieldValue = PAY_AMOUNT + fee;

  // 4. fresh, unfunded recipient
  const recipient = getAddress(Wallet.createRandom().address);
  const recipientGas = await rpc.getBalance(recipient);
  const recipientToken = BigInt(String(await callView(rpc, TOKEN, ERC20_IFACE, "balanceOf", [recipient])));
  check("SEQ-4", recipientGas === 0n && recipientToken === 0n, `recipient ${recipient} is fresh and unfunded`);
  report.recipient = recipient;

  // 5. rebuild the tree, then the operator shields amount+fee from their own wallet
  const { tree } = await rebuildTree(rpc);
  const keys = deriveCorporateKeyHierarchy(generateSeed());
  const npk = poseidon2(keys.spendingPublicKey[0], keys.viewingPublicKey[0]);
  const rho = Fp.random();
  const allowance = BigInt(String(await callView(rpc, TOKEN, ERC20_IFACE, "allowance", [state.operator.address, POOL])));
  if (allowance < shieldValue) {
    const approveHash = await sendOperatorTx(rpc, state.operator, TOKEN, ERC20_IFACE.encodeFunctionData("approve", [POOL, shieldValue]), "approve");
    console.log(`operator approve: ${approveHash}`);
    report.approveTx = approveHash;
  }
  const shieldHash = await sendOperatorTx(rpc, state.operator, POOL, POOL_IFACE.encodeFunctionData("shield", [npk, shieldValue, rho]), "shield");
  console.log(`operator shield: ${shieldHash}`);
  report.shieldTx = shieldHash;

  const commitment = poseidon4(npk, BigInt(TOKEN), shieldValue, rho);
  const nextBefore = Number(await callView(rpc, POOL, POOL_IFACE, "nextIndex"));
  tree.insert(commitment);
  const onChainRoot = BigInt(String(await callView(rpc, POOL, POOL_IFACE, "currentRoot")));
  check("SEQ-5", onChainRoot === tree.root, `note is leaf #${nextBefore - 1} and the on-chain root equals the rebuilt tree`);
  report.note = { leafIndex: nextBefore - 1, value: shieldValue.toString(), commitment: "0x" + commitment.toString(16) };

  // 6. prove the unshield (real snarkjs proof against the build's circuit and zkey)
  const wasm = path.join(BUILD_DIR, "circuit", "unshield_js", "unshield.wasm");
  const zkey = path.join(BUILD_DIR, "keys", "unshield_final.zkey");
  const vkey = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, "keys", "verification_key.json"), "utf8"));
  for (const f of [wasm, zkey]) {
    if (!fs.existsSync(f)) throw new Error(`ERR_REHEARSAL_CONFIG: missing build artifact ${f} (run the admin pipeline first)`);
  }
  const witness = buildWitness({
    keys: { ssk: keys.masterSpendingKey, vpk: keys.viewingPublicKey[0], npk },
    note: { leafIndex: nextBefore - 1, value: shieldValue, commitment, rho, token: TOKEN },
    tree,
    recipient,
    relayer: state.relayer.signerAddress,
    amount: PAY_AMOUNT,
    fee
  });
  check("SEQ-6a", witness.change > 0n, `the spend produces a change note of ${witness.change / ONE} ${symbol} (exercises the change path)`);
  console.log("proving with snarkjs…");
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness.input, wasm, zkey);
  const selfOk = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  check("SEQ-6b", selfOk, `proof generated and verifies (${Date.now() - t0} ms)`);
  const calldata = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [a, b, c, pub] = JSON.parse(`[${calldata}]`) as [string[], string[][], string[], string[]];
  const [pRoot, pNullifier, pChange] = pub.map(BigInt);
  check("SEQ-6c", pRoot === tree.root && pNullifier > 0n && pChange > 0n, "public signals carry the spent root, nullifier and change commitment");
  report.nullifier = "0x" + pNullifier.toString(16);

  // 7. relay through the relayer's real HTTP API
  const relayerNonceBefore = await rpc.getTransactionCount(state.relayer.signerAddress);
  const relayerBalanceBefore = BigInt(String(await callView(rpc, TOKEN, ERC20_IFACE, "balanceOf", [state.relayer.signerAddress])));
  const relayBody: RelayRequest = {
    token: TOKEN,
    proof: { a: a as [string, string], b: b as [[string, string], [string, string]], c: c as [string, string] },
    payment: {
      root: "0x" + pRoot.toString(16),
      nullifier: "0x" + pNullifier.toString(16),
      changeCommitment: "0x" + pChange.toString(16),
      recipient,
      amount: PAY_AMOUNT.toString(),
      relayer: state.relayer.signerAddress,
      fee: fee.toString()
    }
  };
  const relayRes = await api(state, "POST", "/relay", relayBody);
  check("SEQ-7a", relayRes.status === 200 && relayRes.json.status === "pending", `relayed: ${relayRes.json.txHash}`);
  report.relayTx = relayRes.json.txHash;

  let status = relayRes.json;
  const deadline = Date.now() + 15 * 60_000;
  while (status.status !== "confirmed" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    status = (await api(state, "GET", `/status/${relayBody.payment.nullifier}`)).json;
  }
  check("SEQ-7b", status.status === "confirmed", `confirmed with ${status.confirmations} confirmation(s)`);
  check("SEQ-7c", status.fee === fee.toString(), "the record's fee is exactly the quoted fee");

  // 8. verify everything on chain
  const spent = Boolean(await callView(rpc, POOL, POOL_IFACE, "nullifierSpent", [pNullifier]));
  const nextAfter = Number(await callView(rpc, POOL, POOL_IFACE, "nextIndex"));
  const recipientAfter = BigInt(String(await callView(rpc, TOKEN, ERC20_IFACE, "balanceOf", [recipient])));
  const relayerAfter = BigInt(String(await callView(rpc, TOKEN, ERC20_IFACE, "balanceOf", [state.relayer.signerAddress])));
  check("SEQ-8a", spent, "the nullifier is spent on chain");
  check("SEQ-8b", nextAfter === nextBefore + 2, `nextIndex ${nextBefore} → ${nextAfter} (note + change)`);
  check("SEQ-8c", recipientAfter === PAY_AMOUNT, `recipient received exactly ${PAY_AMOUNT / ONE} ${symbol} and needed no QUAI`);
  check("SEQ-8d", relayerAfter - relayerBalanceBefore === fee, `relayer received exactly the quoted fee ${fee / ONE} ${symbol} — no more, no less`);

  // 9. the failure cases: each refuses with a named error and sends nothing
  state.relayer.setOnline(false, "rehearsal: SP-EX-04");
  const offline = await api(state, "POST", "/relay", relayBody);
  check("FAIL-1", offline.status === 503 && offline.json.error === "ERR_RELAYER_OFFLINE", `offline relayer refuses with ${offline.json.error}`);
  state.relayer.setOnline(true);

  const cheap: RelayRequest = { ...relayBody, payment: { ...relayBody.payment, nullifier: "0x" + (pNullifier + 1n).toString(16), fee: (fee - 1n).toString() } };
  const lowFee = await api(state, "POST", "/relay", cheap);
  check("FAIL-2", lowFee.status === 400 && lowFee.json.error === "FEE_BELOW_QUOTE", `fee below quote refuses with ${lowFee.json.error}`);

  const foreign: RelayRequest = { ...relayBody, payment: { ...relayBody.payment, nullifier: "0x" + (pNullifier + 2n).toString(16), relayer: state.operator.address } };
  const wrongRelayer = await api(state, "POST", "/relay", foreign);
  check("FAIL-3", wrongRelayer.status === 400 && wrongRelayer.json.error === "RELAYER_ADDRESS_MISMATCH", `a proof naming another relayer refuses with ${wrongRelayer.json.error}`);

  const relayerNonceAfter = await rpc.getTransactionCount(state.relayer.signerAddress);
  check("FAIL-4", relayerNonceAfter === relayerNonceBefore + 1, `the relayer's on-chain nonce moved by exactly 1: the failure cases sent nothing`);

  report.checks = checks;
  report.quote = quote;
  report.network = NETWORK.id;
  report.pool = POOL;
  report.token = { address: TOKEN, symbol };
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  console.log(`\nrehearsal record written: ${path.resolve(JSON_OUT)}`);
  console.log("phase 4 (Orchard rehearsal) is complete; checklist T-06 is satisfied by the record above");
}

// --------------------------------------------------------------------------- main

try {
  if (mode === "gate") {
    await gate();
  } else if (mode === "full") {
    await gate();
    await full();
  } else {
    throw new Error(`ERR_REHEARSAL_CONFIG: unknown mode '${mode}' (gate | full)`);
  }
  const failed = checks.filter((c) => !c.ok);
  console.log(failed.length === 0 ? `\nall ${checks.length} checks passed` : `\n${failed.length} check(s) FAILED`);
  process.exit(failed.length === 0 ? 0 : 1);
} catch (err) {
  if (isRelayerError(err)) {
    console.error(`refused by the relayer: ${(err as Error).name}: ${(err as Error).message}`);
  } else {
    console.error((err as Error).message);
  }
  if (checks.length > 0) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ checks, failed: true }, null, 2));
    console.error(`partial record written: ${path.resolve(JSON_OUT)}`);
  }
  process.exit(1);
}
