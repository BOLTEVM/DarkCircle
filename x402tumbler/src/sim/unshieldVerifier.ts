/**
 * DarkCircle: reference verifier for the unshield statement ("executable circuit specification")
 * File: src/sim/unshieldVerifier.ts
 *
 * A production shielded pool never sees the note being spent: a SNARK proves, in zero knowledge, that
 * the spender knows a note in the commitment tree that they own, that the public nullifier is that
 * note's nullifier, and that value is conserved. This module checks the SAME statement directly from a
 * witness, so the in-memory pool cannot be drained by a caller that merely supplies a fresh nullifier
 * and a valid root (which is all the earlier pool required).
 *
 * The witness includes the spending key, so this is a simulation-grade verifier: it enforces the
 * constraints, it does not provide zero knowledge. The constraints below are what a real circuit must
 * encode, one for one:
 *
 *   C1  commitment = Poseidon4(npk, token, value, rho)
 *   C2  commitment is the leaf at `leafIndex` under `merkleRoot` (fixed-depth path) and the root is known
 *   C3  npk = Poseidon2(spk.x, vpk.x) with spk = ssk * G and 0 <= ssk < L   (ownership)
 *   C4  nullifier = Poseidon3(ssk, commitment, leafIndex)          (double-spend binding)
 *
 * The range in C3 matters: G has order L, so ssk and ssk + k*L own the same notes, and without it each
 * note would have one nullifier per k (the circuit admits eight). With the range, one key, one nullifier.
 *   C5  value = amount + relayerFee + change.value, all in [0, 2^128)   (conservation, no wrap)
 *   C6  changeCommitment = Poseidon4(change note)                  (change is a real note)
 *   C7  publicInputsHash = H(recipient, token, amount, relayer, fee, root)   (anti-front-running)
 *   C8  the note's deposit origin is read from the pool's own record, never from the request, and
 *       must pass sanctions screening (PPOI)
 */

import { getAddress } from "ethers";
import { Fp } from "../crypto/field.ts";
import { poseidon2, poseidon3, poseidon4 } from "../crypto/poseidon.ts";
import { BABYJUBJUB_L, GENERATOR, scalarMult } from "../crypto/babyjubjub.ts";
import { computePublicInputsHash } from "../crypto/unshield.ts";
import { assertQuaiPaymentAddress } from "../quai/address.ts";
import type { UnshieldRequest, ShieldedUTXO } from "../types/sim.ts";
import type { RailgunSmartWallet } from "./railgunContract.ts";

export const MAX_NOTE_VALUE = 1n << 128n;

export interface WitnessNote {
  npk: bigint;
  token: string;
  value: bigint;
  rho: bigint;
}

/** Private inputs the prover would hold. */
export interface UnshieldWitness {
  inputNote: WitnessNote;
  leafIndex: number;
  /** Merkle authentication path, bottom to top; length must equal the tree depth exactly. */
  siblings: bigint[];
  /** Spending key (private input). A real circuit proves knowledge of it without revealing it. */
  spendingKey: bigint;
  /** x-coordinate of the viewing public key that, with the spending key, defines the note public key. */
  viewingPublicKeyX: bigint;
  changeNote?: WitnessNote;
}

export interface VerifiedUnshield {
  inputCommitment: bigint;
  nullifier: bigint;
  root: bigint;
  origin: ShieldedUTXO;
  changeValue: bigint;
}

function fail(code: string, detail?: string): never {
  throw new Error(detail ? `${code}: ${detail}` : code);
}

function inRange(v: bigint): boolean {
  return v >= 0n && v < MAX_NOTE_VALUE;
}

function noteCommitment(n: WitnessNote): bigint {
  return poseidon4(Fp.canonical(n.npk, "note.npk"), BigInt(getAddress(n.token)), n.value, Fp.canonical(n.rho, "note.rho"));
}

export function verifyUnshieldStatement(req: UnshieldRequest, pool: RailgunSmartWallet): VerifiedUnshield {
  const w = req.witness;
  if (!w) fail("ERR_PROOF_MISSING", "verified pools require an unshield witness");

  // ---- public inputs, canonical ----
  const root = Fp.canonical(req.merkleRoot, "merkleRoot");
  const nullifier = Fp.canonical(req.nullifier, "nullifier");
  if (nullifier === 0n) fail("ERR_NULLIFIER_MALFORMED", "nullifier must be non-zero");

  // ---- addresses ----
  const network = pool.network;
  let recipient: string;
  let relayer: string;
  let token: string;
  try {
    recipient = assertQuaiPaymentAddress(req.recipient, network);
    relayer = assertQuaiPaymentAddress(req.relayerAddress, network);
    token = getAddress(req.token);
  } catch (err) {
    fail("ERR_QUAI_RECIPIENT_INVALID", (err as Error).message);
  }
  if (pool.allowedTokens && !pool.allowedTokens.has(token.toLowerCase())) {
    fail("ERR_TOKEN_NOT_ALLOWED", token);
  }
  if (getAddress(w.inputNote.token) !== token) fail("ERR_TOKEN_MISMATCH", "input note token differs from request token");

  // ---- C5 (ranges and conservation) ----
  const amount = req.amount;
  const fee = req.relayerFee;
  if (amount <= 0n) fail("ERR_AMOUNT_INVALID", "amount must be positive");
  if (!inRange(amount) || !inRange(fee) || !inRange(w.inputNote.value)) fail("ERR_VALUE_OUT_OF_RANGE");
  const hasChange = req.changeCommitment !== undefined && req.changeCommitment !== null && BigInt(req.changeCommitment) !== 0n;
  const changeValue = hasChange ? (w.changeNote?.value ?? -1n) : 0n;
  if (hasChange && (!w.changeNote || changeValue <= 0n || !inRange(changeValue))) fail("ERR_CHANGE_NOTE_INVALID");
  if (!hasChange && w.changeNote) fail("ERR_CHANGE_NOTE_INVALID", "change note supplied without a change commitment");
  if (w.inputNote.value !== amount + fee + changeValue) {
    fail("ERR_VALUE_NOT_CONSERVED", `input ${w.inputNote.value} != amount ${amount} + fee ${fee} + change ${changeValue}`);
  }
  if (relayer === getAddress("0x0000000000000000000000000000000000000000") && fee !== 0n) {
    fail("ERR_VALUE_NOT_CONSERVED", "a direct unshield (zero relayer) cannot pay a relayer fee");
  }

  // ---- C1 / C2 ----
  const commitment = noteCommitment(w.inputNote);
  if (commitment === 0n) fail("ERR_NOTE_INVALID");
  const tree = pool.merkleTree;
  if (!Number.isInteger(w.leafIndex) || w.leafIndex < 0 || w.leafIndex >= tree.nextIndex) fail("ERR_MERKLE_PATH_INVALID", "leaf index out of range");
  if (w.siblings.length !== tree.depth) fail("ERR_MERKLE_PATH_INVALID", `path must have exactly ${tree.depth} siblings`);
  let cur = commitment;
  for (let d = 0; d < tree.depth; d++) {
    const sib = Fp.canonical(w.siblings[d], "sibling");
    cur = ((w.leafIndex >> d) & 1) === 0 ? poseidon2(cur, sib) : poseidon2(sib, cur);
  }
  if (cur !== root) fail("ERR_MERKLE_PATH_INVALID", "note is not in the tree under the supplied root");
  if (!tree.isValidRoot(root)) fail("EXPIRED_MERKLE_ROOT");

  // ---- C3 ownership, C4 nullifier ----
  // The key must be the one canonical scalar of its public key: any ssk + k*L owns the same note but
  // would derive a different nullifier, i.e. spend it again.
  if (typeof w.spendingKey !== "bigint" || w.spendingKey < 0n || w.spendingKey >= BABYJUBJUB_L) {
    fail("ERR_SPENDING_KEY_OUT_OF_RANGE", "the spending key must satisfy 0 <= key < L (the BabyJubjub subgroup order)");
  }
  const ssk = w.spendingKey;
  const spk = scalarMult(ssk, GENERATOR);
  if (Fp.canonical(w.inputNote.npk, "npk") !== poseidon2(spk[0], Fp.canonical(w.viewingPublicKeyX, "vpk.x"))) {
    fail("ERR_NOT_NOTE_OWNER", "spending key does not own this note");
  }
  if (poseidon3(ssk, commitment, BigInt(w.leafIndex)) !== nullifier) fail("ERR_NULLIFIER_MISMATCH");

  // ---- C6 change ----
  if (hasChange) {
    const cn = w.changeNote!;
    if (getAddress(cn.token) !== token) fail("ERR_TOKEN_MISMATCH", "change note token differs");
    if (noteCommitment(cn) !== BigInt(req.changeCommitment!)) fail("ERR_CHANGE_COMMITMENT_MISMATCH");
  }

  // ---- C7 anti-front-running binding (required) ----
  if (!req.publicInputsHash) fail("ERR_PUBLIC_INPUTS_HASH_REQUIRED");
  const expected = computePublicInputsHash({
    recipient,
    token,
    amount,
    relayerAddress: relayer,
    relayerFee: fee,
    merkleRoot: Fp.toHex(root)
  });
  if (expected.toLowerCase() !== String(req.publicInputsHash).toLowerCase()) fail("ANTI_FRONT_RUNNING_HASH_MISMATCH");

  // ---- C8 origin from the pool's own record ----
  const origin = pool.utxoRegistry.get(commitment.toString());
  if (!origin || !origin.depositorAddress) fail("ERR_NOTE_ORIGIN_UNKNOWN", "the pool has no deposit record for this note");

  return { inputCommitment: commitment, nullifier, root, origin: origin!, changeValue };
}
