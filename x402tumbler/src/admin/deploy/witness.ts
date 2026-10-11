/**
 * DarkCircle admin console: circuit witness from a simulation note
 * File: src/admin/deploy/witness.ts
 *
 * ADMIN-ONLY, REDACTED BEFORE PRODUCTION.
 *
 * Turns a real note in a simulated pool into the input object circuits/unshield.circom expects, so the
 * pipeline can prove a statement the simulation itself would accept. The build is read-only: it spends
 * nothing and changes no state, it only reads the note, its Merkle path and the keys.
 */

import { getAddress } from "ethers";
import { Fp } from "../../crypto/field.ts";
import { poseidon3, poseidon4 } from "../../crypto/poseidon.ts";
import { computePublicInputsHash } from "../../crypto/unshield.ts";
import { BABYJUBJUB_L } from "../../crypto/babyjubjub.ts";
import type { CliContext } from "../../cli/types.ts";

/** Public signals in the order the circuit and the verifier contract use. */
export const PUBLIC_SIGNALS = [
  "merkleRoot",
  "nullifier",
  "changeCommitment",
  "recipient",
  "token",
  "amount",
  "relayer",
  "relayerFee",
  "publicInputsHash"
] as const;

export type PublicSignalName = (typeof PUBLIC_SIGNALS)[number];

export interface UnshieldCircuitInput {
  [key: string]: string | string[];
}

export interface BuiltWitness {
  /** Decimal-string input for snarkjs / the circom witness generator. */
  input: UnshieldCircuitInput;
  /**
   * The same spend with the key replaced by key + L and the nullifier that key derives: the same public key,
   * so the same note, but a second nullifier. The circuit must refuse it (C3's range), or every note could
   * be spent more than once. Self-tests use it as the attack they must reject.
   */
  aliasedKeyInput: UnshieldCircuitInput;
  /** The public signals the simulation itself derives, as decimal strings, in PUBLIC_SIGNALS order. */
  expectedPublic: string[];
  note: { leafIndex: number; value: bigint; commitment: bigint };
  amount: bigint;
  fee: bigint;
  change: bigint;
  recipient: string;
  relayer: string;
  token: string;
}

const dec = (v: bigint) => v.toString(10);

/** What the circuit needs to know, independent of where the note lives (a simulated pool or a local EVM). */
export interface WitnessParts {
  keys: { ssk: bigint; vpk: bigint; npk: bigint };
  note: { leafIndex: number; value: bigint; commitment: bigint; rho: bigint; token: string };
  tree: { root: bigint; generateProof(index: number): { siblings: bigint[] } };
  recipient: string;
  relayer: string;
  amount: bigint;
  fee: bigint;
}

export function buildUnshieldWitness(
  ctx: CliContext,
  opts: { recipient: string; amount: bigint; fee?: bigint; noteIndex?: number }
): BuiltWitness {
  const fee = opts.fee ?? ctx.relayer.minimumFee;
  const need = opts.amount + fee;
  const utxo = opts.noteIndex !== undefined ? ctx.treasuryUTXOs[opts.noteIndex] : ctx.treasuryUTXOs.find((u) => u.value >= need);
  if (!utxo) throw new Error("ERR_NO_NOTE: no treasury note is large enough to prove a payment of this size");
  return buildWitness({
    keys: ctx.corporateKeys,
    note: { leafIndex: utxo.leafIndex, value: utxo.value, commitment: utxo.commitment, rho: utxo.rho ?? utxo.blinding, token: utxo.token },
    tree: (ctx.pool as any).merkleTree,
    recipient: opts.recipient,
    relayer: ctx.relayer.relayerAddress,
    amount: opts.amount,
    fee
  });
}

export function buildWitness(p: WitnessParts): BuiltWitness {
  const { keys, tree } = p;
  const utxo = p.note;
  const fee = p.fee;
  const need = p.amount + fee;
  if (utxo.value < need) throw new Error("ERR_NOTE_TOO_SMALL: the chosen note cannot cover the amount plus the fee");

  const token = getAddress(utxo.token);
  const recipient = getAddress(p.recipient);
  const relayer = getAddress(p.relayer);
  const change = utxo.value - need;
  const changeRho = Fp.random();
  const root: bigint = tree.root;
  const path = tree.generateProof(utxo.leafIndex);

  if (keys.ssk < 0n || keys.ssk >= BABYJUBJUB_L) throw new Error("ERR_SPENDING_KEY_OUT_OF_RANGE: the spending key must satisfy 0 <= key < L");
  const nullifier = poseidon3(keys.ssk, utxo.commitment, BigInt(utxo.leafIndex));
  const changeCommitment = change > 0n ? poseidon4(keys.npk, BigInt(token), change, changeRho) : 0n;
  const publicInputsHash = BigInt(
    computePublicInputsHash({ recipient, token, amount: p.amount, relayerAddress: relayer, relayerFee: fee, merkleRoot: Fp.toHex(root) })
  );

  const publicValues: Record<PublicSignalName, bigint> = {
    merkleRoot: root,
    nullifier,
    changeCommitment,
    recipient: BigInt(recipient),
    token: BigInt(token),
    amount: p.amount,
    relayer: BigInt(relayer),
    relayerFee: fee,
    publicInputsHash
  };

  const input: UnshieldCircuitInput = {
    ...Object.fromEntries(PUBLIC_SIGNALS.map((k) => [k, dec(publicValues[k])])),
    spendingKey: dec(keys.ssk),
    viewingPublicKeyX: dec(keys.vpk),
    inValue: dec(utxo.value),
    inRho: dec(utxo.rho),
    leafIndex: String(utxo.leafIndex),
    siblings: (path.siblings as bigint[]).map(dec),
    changeNpk: dec(keys.npk),
    changeValue: dec(change),
    changeRho: dec(changeRho)
  };

  const aliasedKey = keys.ssk + BABYJUBJUB_L;
  const aliasedKeyInput: UnshieldCircuitInput = {
    ...input,
    spendingKey: dec(aliasedKey),
    nullifier: dec(poseidon3(aliasedKey, utxo.commitment, BigInt(utxo.leafIndex)))
  };

  return {
    input,
    aliasedKeyInput,
    expectedPublic: PUBLIC_SIGNALS.map((k) => dec(publicValues[k])),
    note: { leafIndex: utxo.leafIndex, value: utxo.value, commitment: utxo.commitment },
    amount: p.amount,
    fee,
    change,
    recipient,
    relayer,
    token
  };
}
