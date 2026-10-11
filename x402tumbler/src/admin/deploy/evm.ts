/**
 * DarkCircle admin console: local EVM deployment scenario
 * File: src/admin/deploy/evm.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION.
 *
 * Deploys the compiled Poseidon hashers, verifier, dev token and pool into an in-process EVM
 * (@ethereumjs/evm, which includes the BN254 pairing precompile) and drives them with a REAL proof: shield
 * tokens, prove an unshield with snarkjs, submit it, and check that the on-chain result agrees with the
 * simulation everywhere the two overlap (commitments, Merkle roots, balances), and that every tampered call
 * is refused.
 *
 * This is the strongest check available without a network: it runs the exact bytecode that would be
 * deployed. It is still a local EVM, not Quai: Quai-specific behaviour (access lists, zone addressing,
 * in-contract CREATE grinding, gas) is not exercised here.
 */

import fs from "node:fs";
import path from "node:path";
import { AbiCoder, Interface, keccak256, getAddress } from "ethers";
import { createEVM } from "@ethereumjs/evm";
import { Common, Mainnet, Hardfork } from "@ethereumjs/common";
import { Address, bytesToHex, hexToBytes } from "@ethereumjs/util";
import { Fp } from "../../crypto/field.ts";
import { IncrementalMerkleTree } from "../../crypto/merkleTree.ts";
import { poseidon2, poseidon4 } from "../../crypto/poseidon.ts";
import { deriveCorporateKeyHierarchy, generateSeed } from "../../audit/keys.ts";
import { SIM_RELAYER_ADDRESS, SIM_VENDOR_ADDRESS } from "../../sim/defaults.ts";
import * as snarkjs from "snarkjs";
import { buildWitness } from "./witness.ts";
import { proveAndVerify } from "./circuit.ts";
import { expectedRuntimeHash, type RuntimeArtifact } from "./bytecode.ts";

const ONE = 10n ** 18n;

export interface EvmCheck {
  id: string;
  ok: boolean;
  detail: string;
}

export interface EvmReport {
  ok: boolean;
  checks: EvmCheck[];
  gas: Record<string, number>;
  addresses: Record<string, string>;
  /** keccak256 of the code actually deployed (the hashers' runtime code is only knowable this way). */
  deployedCodeHashes: Record<string, string>;
  proveMs: number;
}

interface Artifact extends RuntimeArtifact {
  abi: any[];
  bytecode: string;
  bytecodeHash: string;
}

const load = (dir: string, name: string): Artifact => JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));

function revertReason(data: Uint8Array): string {
  const h = bytesToHex(data);
  if (h.startsWith("0x08c379a0")) {
    try {
      return AbiCoder.defaultAbiCoder().decode(["string"], "0x" + h.slice(10))[0] as string;
    } catch {
      /* fall through */
    }
  }
  return h === "0x" ? "reverted with no reason" : `reverted (${h.slice(0, 18)}…)`;
}

class LocalChain {
  private readonly evm: any;
  private deployers = 0;
  public gas: Record<string, number> = {};

  private constructor(evm: any) {
    this.evm = evm;
  }

  static async create(): Promise<LocalChain> {
    const common = new Common({ chain: Mainnet, hardfork: Hardfork.Shanghai });
    return new LocalChain(await createEVM({ common }));
  }

  async deploy(label: string, a: Artifact, args: unknown[] = []): Promise<{ address: Address; hex: string }> {
    const r = await this.tryDeploy(label, a, args);
    if (!r.ok) throw new Error(`ERR_EVM_DEPLOY: ${label}: ${r.reason}`);
    return r;
  }

  /** Like deploy, but reports a failed constructor instead of throwing. */
  async tryDeploy(label: string, a: Artifact, args: unknown[] = []): Promise<{ ok: true; address: Address; hex: string } | { ok: false; reason: string }> {
    const iface = new Interface(a.abi);
    const data = a.bytecode + (args.length ? iface.encodeDeploy(args).slice(2) : "");
    // a fresh deployer per contract keeps CREATE addresses independent of nonce bookkeeping
    const caller = new Address(hexToBytes(("0x" + (0xd0 + ++this.deployers).toString(16).padStart(40, "0")) as `0x${string}`));
    const r = await this.evm.runCall({ caller, data: hexToBytes(data as `0x${string}`), gasLimit: 30_000_000n });
    if (r.execResult.exceptionError || !r.createdAddress) return { ok: false, reason: `${r.execResult.exceptionError?.error ?? "no address"}: ${revertReason(r.execResult.returnValue)}` };
    this.gas[`deploy.${label}`] = Number(r.execResult.executionGasUsed);
    return { ok: true, address: r.createdAddress, hex: r.createdAddress.toString() };
  }

  /** Runs a call. Returns the decoded result, or a revert reason instead of throwing. */
  async send(to: string, a: Artifact, fn: string, args: unknown[], from: string, gasLabel?: string): Promise<{ ok: true; value: any; logs: any[] } | { ok: false; reason: string }> {
    const iface = new Interface(a.abi);
    const caller = new Address(hexToBytes(from as `0x${string}`));
    const r = await this.evm.runCall({ caller, to: new Address(hexToBytes(to as `0x${string}`)), data: hexToBytes(iface.encodeFunctionData(fn, args) as `0x${string}`), gasLimit: 30_000_000n });
    if (r.execResult.exceptionError) return { ok: false, reason: r.execResult.exceptionError.error === "revert" ? revertReason(r.execResult.returnValue) : String(r.execResult.exceptionError.error) };
    if (gasLabel) this.gas[gasLabel] = Number(r.execResult.executionGasUsed);
    const value = iface.getFunction(fn)!.outputs.length ? iface.decodeFunctionResult(fn, bytesToHex(r.execResult.returnValue)) : null;
    const logs = (r.execResult.logs ?? []).map((l: any) => ({ address: bytesToHex(l[0]), topics: l[1].map((t: Uint8Array) => bytesToHex(t)), data: bytesToHex(l[2]) }));
    return { ok: true, value, logs };
  }

  async codeHash(address: Address): Promise<string> {
    return keccak256(bytesToHex(await this.evm.stateManager.getCode(address)));
  }
}

export async function runLocalEvmScenario(o: { buildDir: string; log: (m: string) => void }): Promise<EvmReport> {
  const contractsDir = path.join(o.buildDir, "contracts");
  const circuitDir = path.join(o.buildDir, "circuit");
  const keysDir = path.join(o.buildDir, "keys");
  const wasm = path.join(circuitDir, "unshield_js", "unshield.wasm");
  const zkey = path.join(keysDir, "unshield_final.zkey");
  const vkey = JSON.parse(fs.readFileSync(path.join(keysDir, "verification_key.json"), "utf8"));
  const art = { t3: load(contractsDir, "PoseidonT3"), t5: load(contractsDir, "PoseidonT5"), verifier: load(contractsDir, "Groth16Verifier"), token: load(contractsDir, "DevToken"), pool: load(contractsDir, "DarkCirclePool") };

  const checks: EvmCheck[] = [];
  const check = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok, detail });
    o.log(`${ok ? "PASS" : "FAIL"} ${id}: ${detail}`);
  };

  const chain = await LocalChain.create();
  o.log("deploying Poseidon hashers, verifier, dev token and pool into a local EVM");
  const t3 = await chain.deploy("PoseidonT3", art.t3);
  const t5 = await chain.deploy("PoseidonT5", art.t5);
  const verifier = await chain.deploy("Groth16Verifier", art.verifier);
  const token = await chain.deploy("DevToken", art.token);
  const pool = await chain.deploy("DarkCirclePool", art.pool, [token.hex, verifier.hex, t3.hex, t5.hex]);
  const addresses = { PoseidonT3: t3.hex, PoseidonT5: t5.hex, Groth16Verifier: verifier.hex, DevToken: token.hex, DarkCirclePool: pool.hex };
  const deployedCodeHashes = {
    PoseidonT3: await chain.codeHash(t3.address),
    PoseidonT5: await chain.codeHash(t5.address),
    Groth16Verifier: await chain.codeHash(verifier.address),
    DarkCirclePool: await chain.codeHash(pool.address)
  };

  const who = { depositor: "0x00000000000000000000000000000000000d3905", relayer: SIM_RELAYER_ADDRESS, recipient: SIM_VENDOR_ADDRESS, anyone: "0x0000000000000000000000000000000000000abc" };
  const call = (to: string, a: Artifact, fn: string, args: unknown[], from = who.anyone, gasLabel?: string) => chain.send(to, a, fn, args, from, gasLabel);
  const view = async (to: string, a: Artifact, fn: string, args: unknown[] = []) => {
    const r = await call(to, a, fn, args);
    if (!r.ok) throw new Error(`ERR_EVM_VIEW: ${fn}: ${r.reason}`);
    return r.value[0];
  };

  // E-01: the on-chain hashers are the same function as the simulation's
  // circomlibjs emits two overloads (bytes32[n] and uint256[n]), so the full signature is needed
  const h2 = await view(t3.hex, art.t3, "poseidon(uint256[2])", [[1n, 2n]]);
  const h4 = await view(t5.hex, art.t5, "poseidon(uint256[4])", [[1n, 2n, 3n, 4n]]);
  check("E-01", h2 === poseidon2(1n, 2n) && h4 === poseidon4(1n, 2n, 3n, 4n), "on-chain Poseidon (2 and 4 inputs) equals the simulation's poseidon-lite");

  // E-02: the empty tree's root
  const jsTree = new IncrementalMerkleTree(16, 64);
  check("E-02", (await view(pool.hex, art.pool, "currentRoot")) === jsTree.root, "the contract's empty-tree root equals the simulation's");

  // keys the way the simulation derives them
  const hierarchy = deriveCorporateKeyHierarchy(generateSeed());
  const keys = { ssk: hierarchy.masterSpendingKey, vpk: hierarchy.viewingPublicKey[0], npk: poseidon2(hierarchy.spendingPublicKey[0], hierarchy.viewingPublicKey[0]) };
  const tokenWord = BigInt(getAddress(token.hex));

  // E-10: shield guards
  await call(token.hex, art.token, "mint", [who.depositor, 100n * ONE]);
  const noAllowance = await call(pool.hex, art.pool, "shield", [keys.npk, 1n * ONE, 5n], who.depositor);
  const zero = await call(pool.hex, art.pool, "shield", [keys.npk, 0n, 5n], who.depositor);
  const nonCanonical = await call(pool.hex, art.pool, "shield", [Fp.mod(1n) + 21888242871839275222246405745257275088548364400416034343698204186575808495617n, 1n * ONE, 5n], who.depositor);
  check("E-10", !noAllowance.ok && !zero.ok && !nonCanonical.ok, `shield refuses no allowance (${(noAllowance as any).reason}), zero amount (${(zero as any).reason}) and a non-canonical key (${(nonCanonical as any).reason})`);

  // E-03: shield, then compare commitment and root with the simulation
  await call(token.hex, art.token, "approve", [pool.hex, 100n * ONE], who.depositor);
  const rho = Fp.random();
  const shield = await call(pool.hex, art.pool, "shield", [keys.npk, 100n * ONE, rho], who.depositor, "shield");
  if (!shield.ok) throw new Error(`ERR_EVM_SHIELD: ${shield.reason}`);
  const [commitment, leafIndex] = shield.value as [bigint, bigint];
  const simCommitment = poseidon4(keys.npk, tokenWord, 100n * ONE, rho);
  jsTree.insert(commitment);
  check("E-03", commitment === simCommitment && (await view(pool.hex, art.pool, "currentRoot")) === jsTree.root && leafIndex === 0n, "the shield's commitment and the tree root equal what the simulation computes for the same note");

  // prove an unshield of 5 with a 0.5 fee
  const amount = 5n * ONE;
  const fee = ONE / 2n;
  const w = buildWitness({ keys, note: { leafIndex: 0, value: 100n * ONE, commitment, rho, token: token.hex }, tree: jsTree, recipient: who.recipient, relayer: who.relayer, amount, fee });
  o.log("proving the unshield with snarkjs (Groth16)");
  const proof = await proveAndVerify({ input: w.input, wasm, zkey, vkey });
  if (!proof.verified) throw new Error("ERR_PROOF_INVALID: snarkjs did not verify its own proof");
  const [a, b, c, pub] = JSON.parse(`[${proof.calldata}]`) as [string[], string[][], string[], string[]];
  const [root, nullifier, changeCommitment] = pub.map(BigInt);
  const unshield = (over: { proof?: [string[], string[][], string[]]; root?: bigint; nullifier?: bigint; change?: bigint; recipient?: string; amount?: bigint; relayer?: string; fee?: bigint } = {}, label?: string) =>
    call(pool.hex, art.pool, "unshield", [over.proof ?? [a, b, c], [over.root ?? root, over.nullifier ?? nullifier, over.change ?? changeCommitment, over.recipient ?? who.recipient, over.amount ?? amount, over.relayer ?? who.relayer, over.fee ?? fee]], who.relayer, label);

  // E-07 / E-08 / E-09: tampering with anything the proof binds must be refused, and must change nothing
  const before = await view(token.hex, art.token, "balanceOf", [pool.hex]);
  const badAmount = await unshield({ amount: amount + 1n });
  const badRecipient = await unshield({ recipient: who.anyone });
  const badRelayer = await unshield({ relayer: who.anyone });
  const badFee = await unshield({ fee: fee - 1n });
  check("E-07", [badAmount, badRecipient, badRelayer, badFee].every((r) => !r.ok && /invalid proof/.test((r as any).reason)), "a proof does not carry over to a different amount, recipient, relayer or fee");
  const badRoot = await unshield({ root: root + 1n });
  check("E-09", !badRoot.ok && /unknown root/.test((badRoot as any).reason), `an unknown Merkle root is refused (${(badRoot as any).reason})`);
  const badNullifier = await unshield({ nullifier: nullifier + 1n });
  check("E-08", !badNullifier.ok, "a different nullifier does not verify against the same proof");

  // E-15: the pool's own guards, independent of the verifier (they run before the proof is even checked)
  const reasonOf = (r: { ok: boolean }) => (r as any).reason as string | undefined;
  const feeWithoutRelayer = await unshield({ relayer: "0x0000000000000000000000000000000000000000", fee: 1n });
  const paysItself = await unshield({ recipient: pool.hex });
  const hugeFee = await unshield({ fee: 1n << 128n });
  const aliasedFee = await unshield({ fee: fee + 21888242871839275222246405745257275088548364400416034343698204186575808495617n });
  const zeroAmount = await unshield({ amount: 0n });
  check(
    "E-15",
    /a fee needs a relayer/.test(reasonOf(feeWithoutRelayer) ?? "") && /the pool cannot pay itself/.test(reasonOf(paysItself) ?? "") && /fee out of range/.test(reasonOf(hugeFee) ?? "") && /fee out of range/.test(reasonOf(aliasedFee) ?? "") && /amount out of range/.test(reasonOf(zeroAmount) ?? ""),
    `the pool refuses a fee with no relayer (${reasonOf(feeWithoutRelayer)}), paying itself (${reasonOf(paysItself)}), a fee of 2^128 or fee + p (${reasonOf(aliasedFee)}) and a zero amount (${reasonOf(zeroAmount)}) before it asks the verifier`
  );

  // E-13: the attack this audit found. key + L is the same public key, so it owns the same note, but it
  // derives a second nullifier: without the circuit's range on the key, this note could be spent twice.
  const aliasedWtns = path.join(o.buildDir, "circuit", ".evm-aliased.wtns");
  let aliasedProvable = true;
  try {
    await snarkjs.wtns.calculate(w.aliasedKeyInput, wasm, aliasedWtns);
  } catch {
    aliasedProvable = false;
  } finally {
    fs.rmSync(aliasedWtns, { force: true });
  }
  check("E-13", !aliasedProvable && w.aliasedKeyInput.nullifier !== w.input.nullifier, "an aliased spending key (key + L: same note, second nullifier) cannot be proven, so a note cannot be spent twice");
  check("E-07b", (await view(token.hex, art.token, "balanceOf", [pool.hex])) === before, "refused calls moved no tokens");

  // E-04: the real thing
  const ok = await unshield({}, "unshield");
  if (!ok.ok) throw new Error(`ERR_EVM_UNSHIELD: the valid proof was refused: ${ok.reason}`);
  const recipientBal = await view(token.hex, art.token, "balanceOf", [who.recipient]);
  const relayerBal = await view(token.hex, art.token, "balanceOf", [who.relayer]);
  const custody = await view(token.hex, art.token, "balanceOf", [pool.hex]);
  check("E-04", recipientBal === amount && relayerBal === fee && custody === 100n * ONE - amount - fee && (await view(pool.hex, art.pool, "nullifierSpent", [nullifier])) === true, `a real proof was accepted: recipient +5, relayer +0.5, pool custody ${Number(custody) / 1e18}, nullifier spent`);

  // E-05: the change note landed in the tree exactly where the simulation would put it
  jsTree.insert(changeCommitment);
  check("E-05", (await view(pool.hex, art.pool, "currentRoot")) === jsTree.root && (await view(pool.hex, art.pool, "nextIndex")) === 2n, "the change note was inserted and the on-chain root equals the simulation's after two leaves");

  // E-06: replay
  const replay = await unshield();
  check("E-06", !replay.ok && /already spent/.test((replay as any).reason), `replaying the same proof is refused (${(replay as any).reason})`);

  // E-11: solvency
  const unspent = w.change;
  check("E-11", custody === unspent, `pool custody ${Number(custody) / 1e18} equals the value of the one unspent note (${Number(unspent) / 1e18})`);

  // E-17: the change note is a real, spendable note; spending all of it creates no change and says so (NO_LEAF)
  const changeRho = BigInt(w.input.changeRho as string);
  const w2 = buildWitness({ keys, note: { leafIndex: 1, value: w.change, commitment: changeCommitment, rho: changeRho, token: token.hex }, tree: jsTree, recipient: who.recipient, relayer: who.relayer, amount: w.change, fee: 0n });
  o.log("proving a second unshield that spends the whole change note");
  const proof2 = await proveAndVerify({ input: w2.input, wasm, zkey, vkey });
  const [a2, b2, c2, pub2] = JSON.parse(`[${proof2.calldata}]`) as [string[], string[][], string[], string[]];
  const spend2 = await call(pool.hex, art.pool, "unshield", [[a2, b2, c2], [BigInt(pub2[0]), BigInt(pub2[1]), BigInt(pub2[2]), who.recipient, w.change, who.relayer, 0n]], who.relayer, "unshield.noChange");
  const poolIface = new Interface(art.pool.abi);
  const unshieldEvent = spend2.ok ? spend2.logs.map((l: any) => { try { return poolIface.parseLog(l); } catch { return null; } }).find((e: any) => e?.name === "Unshield") : null;
  const noLeaf = await view(pool.hex, art.pool, "NO_LEAF");
  const drained = await view(token.hex, art.token, "balanceOf", [pool.hex]);
  check(
    "E-17",
    spend2.ok && proof2.verified && BigInt(pub2[2]) === 0n && unshieldEvent !== null && unshieldEvent !== undefined && BigInt(unshieldEvent.args.changeLeafIndex) === BigInt(noLeaf) && drained === 0n && (await view(token.hex, art.token, "balanceOf", [who.recipient])) === amount + w.change,
    spend2.ok ? `the change note (leaf #1) was spent in full: no change commitment, changeLeafIndex = NO_LEAF, pool custody now ${Number(drained) / 1e18}` : `spending the change note failed: ${(spend2 as any).reason}`
  );

  // E-12: every deployed contract is byte-for-byte the artifact the on-chain check will expect. The pool's
  // code carries its four immutables, so it is rebuilt from its constructor values: comparing it with the
  // compiled code (zero placeholders) can never match, which is exactly what a naive check would do.
  const expectedPool = expectedRuntimeHash(art.pool, { token: token.hex, verifier: verifier.hex, hasher2: t3.hex, hasher4: t5.hex });
  const same = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  const exact = {
    PoseidonT3: same(deployedCodeHashes.PoseidonT3, art.t3.bytecodeHash),
    PoseidonT5: same(deployedCodeHashes.PoseidonT5, art.t5.bytecodeHash),
    Groth16Verifier: same(deployedCodeHashes.Groth16Verifier, art.verifier.bytecodeHash),
    DarkCirclePool: same(deployedCodeHashes.DarkCirclePool, expectedPool)
  };
  check(
    "E-12",
    Object.values(exact).every(Boolean) && !same(deployedCodeHashes.DarkCirclePool, art.pool.bytecodeHash),
    `deployed code equals the artifacts exactly (${Object.entries(exact).map(([n, ok]) => `${n} ${ok ? "ok" : "DIFFERS"}`).join(", ")}); the pool matches only once its immutables are filled in`
  );

  // E-16: the constructor refuses a dependency with no code (an EOA verifier would make every proof check fail)
  const codeless = await chain.tryDeploy("DarkCirclePool.codeless", art.pool, [token.hex, who.anyone, t3.hex, t5.hex]);
  check("E-16", !codeless.ok && /dependency has no code/.test((codeless as any).reason ?? ""), `a pool whose verifier address has no code is refused at construction (${(codeless as any).reason ?? "it was DEPLOYED"})`);

  return { ok: checks.every((k) => k.ok), checks, gas: chain.gas, addresses, deployedCodeHashes, proveMs: proof.proveMs };
}
