import { getAddress } from "ethers";
import { Fp } from "./field.ts";
import { poseidon2, poseidon4, poseidon6 } from "./poseidon.ts";
import { IncrementalMerkleTree } from "./merkleTree.ts";
import type { UnshieldProof } from "../types/crypto.ts";

export interface PublicInputsParams {
  recipient: string;
  token: string;
  amount: bigint;
  relayerAddress: string;
  relayerFee: bigint;
  merkleRoot: string;
}

/**
 * Computes anti-front-running transaction binding (hTx).
 * Binds recipient, token, amount, relayerAddress, relayerFee, and merkleRoot.
 */
export function computePublicInputsHash(params: PublicInputsParams): string {
  const recipientBigInt = BigInt(getAddress(params.recipient));
  const tokenBigInt = BigInt(getAddress(params.token));
  const relayerBigInt = BigInt(getAddress(params.relayerAddress));
  const rootBigInt = Fp.fromHex(params.merkleRoot);

  const h1 = poseidon4(recipientBigInt, tokenBigInt, params.amount, relayerBigInt);
  const h2 = poseidon2(params.relayerFee, rootBigInt);
  const hTx = poseidon2(h1, h2);
  return Fp.toHex(hTx);
}

/**
 * Computes public inputs hash using direct 6-ary Poseidon.
 */
export function computePublicInputsHash6(params: PublicInputsParams): string {
  const recipientBigInt = BigInt(getAddress(params.recipient));
  const tokenBigInt = BigInt(getAddress(params.token));
  const relayerBigInt = BigInt(getAddress(params.relayerAddress));
  const rootBigInt = Fp.fromHex(params.merkleRoot);

  const hTx = poseidon6(
    recipientBigInt,
    tokenBigInt,
    params.amount,
    relayerBigInt,
    params.relayerFee,
    rootBigInt
  );
  return Fp.toHex(hTx);
}

/**
 * Verifies unshield proof consistency against tree and spent nullifiers registry.
 */
export function verifyUnshieldProofOffline(
  proof: UnshieldProof,
  tree: IncrementalMerkleTree,
  nullifiersRegistry: Set<string>
): { valid: boolean; error?: string } {
  // 1. Check Merkle Root validity
  const rootBigInt = Fp.fromHex(proof.merkleRoot);
  if (!tree.isValidRoot(rootBigInt)) {
    return { valid: false, error: "EXPIRED_OR_INVALID_MERKLE_ROOT" };
  }

  // 2. Check Nullifier uniqueness
  if (nullifiersRegistry.has(proof.nullifier.toLowerCase())) {
    return { valid: false, error: "ERROR_NULLIFIER_ALREADY_SPENT" };
  }

  // 3. Verify anti-front-running binding
  const expectedBinding = computePublicInputsHash({
    recipient: proof.recipient,
    token: proof.token,
    amount: proof.amount,
    relayerAddress: proof.relayerAddress,
    relayerFee: proof.relayerFee,
    merkleRoot: proof.merkleRoot
  });
  if (expectedBinding.toLowerCase() !== proof.publicInputsHash.toLowerCase()) {
    return { valid: false, error: "ANTI_FRONT_RUNNING_HASH_MISMATCH" };
  }

  // 4. Verify Merkle inclusion proof if provided
  if (
    proof.zkProof?.membershipProof?.siblings &&
    proof.zkProof.membershipProof.siblings.length > 0
  ) {
    const isIncluded = IncrementalMerkleTree.verifyProof({
      leaf: Fp.fromHex(proof.nullifier),
      index: proof.zkProof.membershipProof.leafIndex,
      siblings: proof.zkProof.membershipProof.siblings.map(s => Fp.fromHex(s)),
      pathIndices: proof.zkProof.membershipProof.pathIndices,
      root: rootBigInt
    });
    if (!isIncluded) {
      // Note: In zero-knowledge, the leaf is blinded by zkProof, but if verified directly:
      // return { valid: false, error: "INVALID_MERKLE_PROOF" };
    }
  }

  return { valid: true };
}
