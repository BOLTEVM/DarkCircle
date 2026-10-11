/**
 * Sparse Merkle Tree (SMT) Type Definitions
 * DarkCircle Cryptographic Core
 */

export interface SMTProof {
  root: bigint;
  key: bigint;
  value: bigint;
  siblings: bigint[];
  isNonMembership: boolean;
}

export interface SMTProofSerialized {
  root: string;
  key: string;
  value: string;
  siblings: string[];
  isNonMembership: boolean;
}

export type Hash2Fn = (left: bigint, right: bigint) => bigint;
export type Hash1Fn = (input: bigint) => bigint;

export interface ISparseMerkleTree {
  readonly depth: number;
  getRoot(): bigint;
  getNode(level: number, index: bigint): bigint;
  get(key: bigint): bigint;
  insert(key: bigint, value: bigint): bigint;
  delete(key: bigint): bigint;
  createProof(key: bigint): SMTProof;
  verifyProof(proof: SMTProof): boolean;
}
