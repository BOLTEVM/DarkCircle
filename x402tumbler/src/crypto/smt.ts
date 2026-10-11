import { Fp, BN254_SCALAR_FIELD } from "./field.ts";
import { poseidon2 } from "./poseidon.ts";
import type { SMTProof, Hash2Fn, ISparseMerkleTree } from "../types/smt.ts";

export const BN254_PRIME = BN254_SCALAR_FIELD;

/**
 * Sparse Merkle Tree (SMT) for DarkCircle Sanctions Screening
 * Optimized with precomputed zero hashes, dynamic node storage, and node pruning.
 */
export class SparseMerkleTree implements ISparseMerkleTree {
  public readonly depth: number;
  private readonly hashFn: Hash2Fn;
  public readonly zeros: bigint[];
  public readonly nodes: Map<string, bigint>;

  constructor(depth: number = 256, hashFn: Hash2Fn = poseidon2) {
    if (depth < 1 || depth > 256) {
      throw new Error(`Invalid SMT depth ${depth}: must be between 1 and 256`);
    }
    this.depth = depth;
    this.hashFn = hashFn;
    this.nodes = new Map<string, bigint>();

    // Precompute default zero hashes: Z[0] = 0n, Z[d] = Hash(Z[d-1], Z[d-1])
    this.zeros = new Array<bigint>(this.depth + 1);
    this.zeros[0] = 0n;
    for (let d = 1; d <= this.depth; d++) {
      this.zeros[d] = this.hashFn(this.zeros[d - 1], this.zeros[d - 1]);
    }
  }

  private nodeKey(level: number, index: bigint): string {
    return `${level}:${index.toString(16)}`;
  }

  public getNode(level: number, index: bigint): bigint {
    const val = this.nodes.get(this.nodeKey(level, index));
    return val !== undefined ? val : this.zeros[level];
  }

  public getRoot(): bigint {
    return this.getNode(this.depth, 0n);
  }

  public get root(): bigint {
    return this.getRoot();
  }

  private normalizeKey(key: bigint): bigint {
    this.validateKey(key);
    if (this.depth === 256) return key;
    return key & ((1n << BigInt(this.depth)) - 1n);
  }

  public get(key: bigint): bigint {
    const k = this.normalizeKey(key);
    return this.getNode(0, k);
  }

  public insert(key: bigint, value: bigint): bigint {
    const k = this.normalizeKey(key);
    if (value < 0n || value >= BN254_PRIME) {
      throw new Error("Value must be a valid BN254 field element");
    }

    // Level 0: leaf node
    const leafKey = this.nodeKey(0, k);
    if (value === 0n) {
      this.nodes.delete(leafKey);
    } else {
      this.nodes.set(leafKey, value);
    }

    // Climb up to root
    for (let d = 0; d < this.depth; d++) {
      const parentIndex = k >> BigInt(d + 1);
      const leftIndex = parentIndex * 2n;
      const rightIndex = leftIndex + 1n;

      const leftHash = this.getNode(d, leftIndex);
      const rightHash = this.getNode(d, rightIndex);

      const parentHash = this.hashFn(leftHash, rightHash);
      const parentKey = this.nodeKey(d + 1, parentIndex);

      // Memory optimization: prune node if it equals default zero hash
      if (parentHash === this.zeros[d + 1]) {
        this.nodes.delete(parentKey);
      } else {
        this.nodes.set(parentKey, parentHash);
      }
    }

    return this.getRoot();
  }

  public delete(key: bigint): bigint {
    return this.insert(key, 0n);
  }

  public createProof(key: bigint): SMTProof {
    const k = this.normalizeKey(key);
    const siblings: bigint[] = [];

    for (let d = 0; d < this.depth; d++) {
      const siblingIndex = (k >> BigInt(d)) ^ 1n;
      siblings.push(this.getNode(d, siblingIndex));
    }

    const value = this.getNode(0, k);
    return {
      root: this.getRoot(),
      key: k,
      value,
      siblings,
      isNonMembership: value === 0n,
    };
  }

  public verifyProof(proof: SMTProof): boolean {
    if (proof.siblings.length !== this.depth) {
      return false;
    }

    const k = this.normalizeKey(proof.key);
    let current = proof.value;
    for (let d = 0; d < this.depth; d++) {
      const bit = (k >> BigInt(d)) & 1n;
      if (bit === 0n) {
        current = this.hashFn(current, proof.siblings[d]);
      } else {
        current = this.hashFn(proof.siblings[d], current);
      }
    }

    return current === proof.root;
  }

  private validateKey(key: bigint): void {
    if (key < 0n || key >= BN254_PRIME) {
      throw new Error(`Key ${key.toString(16)} outside BN254 field range [0, p-1]`);
    }
  }
}
