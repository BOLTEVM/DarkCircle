import { Fp } from "./field.ts";
import { poseidon2 } from "./poseidon.ts";
import type { MerkleProof } from "../types/crypto.ts";

/**
 * Incremental Merkle Tree (IMT) for Shielded Note Commitments
 * Default depth: 16 (capacity 65,536 leaves).
 * Includes O(depth) node caching, precomputed zero hashes, and historical root ring buffer.
 */
export class IncrementalMerkleTree {
  public readonly depth: number;
  public readonly capacity: number;
  public nextIndex: number = 0;
  public readonly zeros: bigint[] = [];
  public readonly nodes: Map<string, bigint> = new Map();
  public readonly historicalRoots: bigint[] = [];
  public readonly maxHistoricalRoots: number;

  constructor(depth: number = 16, maxHistoricalRoots: number = 64) {
    if (depth < 1 || depth > 32) {
      throw new Error(`Invalid Merkle tree depth ${depth}: must be between 1 and 32`);
    }
    this.depth = depth;
    this.capacity = 2 ** depth;
    this.maxHistoricalRoots = maxHistoricalRoots;

    // Precompute zero hashes for each level
    this.zeros.push(0n); // Level 0: empty leaf
    for (let i = 0; i < depth; i++) {
      this.zeros.push(poseidon2(this.zeros[i], this.zeros[i]));
    }

    // Seed initial empty root into historical buffer
    this.historicalRoots.push(this.zeros[depth]);
  }

  public getNode(level: number, index: number): bigint {
    const key = `${level}_${index}`;
    return this.nodes.get(key) ?? this.zeros[level];
  }

  public get root(): bigint {
    return this.getNode(this.depth, 0);
  }

  public insert(leaf: bigint): number {
    if (this.nextIndex >= this.capacity) {
      throw new Error(`MERKLE_TREE_FULL: capacity of ${this.capacity} leaves exceeded`);
    }
    const leafIndex = this.nextIndex;
    const normalizedLeaf = Fp.mod(leaf);
    this.nodes.set(`0_${leafIndex}`, normalizedLeaf);

    let curIdx = leafIndex;
    for (let d = 0; d < this.depth; d++) {
      const parentIdx = Math.floor(curIdx / 2);
      const leftIdx = parentIdx * 2;
      const rightIdx = leftIdx + 1;
      const leftVal = this.getNode(d, leftIdx);
      const rightVal = this.getNode(d, rightIdx);
      const parentVal = poseidon2(leftVal, rightVal);
      this.nodes.set(`${d + 1}_${parentIdx}`, parentVal);
      curIdx = parentIdx;
    }

    this.nextIndex++;
    const currentRoot = this.root;
    this.historicalRoots.push(currentRoot);
    if (this.historicalRoots.length > this.maxHistoricalRoots) {
      this.historicalRoots.shift();
    }
    return leafIndex;
  }

  public generateProof(index: number): MerkleProof {
    if (index < 0 || index >= this.nextIndex) {
      throw new Error(`LEAF_INDEX_OUT_OF_BOUNDS: index ${index} out of bounds (nextIndex: ${this.nextIndex})`);
    }
    const leaf = this.getNode(0, index);
    const siblings: bigint[] = [];
    const pathIndices: number[] = [];

    let curIdx = index;
    for (let d = 0; d < this.depth; d++) {
      const isRight = curIdx % 2 === 1;
      pathIndices.push(isRight ? 1 : 0);
      const sibIdx = isRight ? curIdx - 1 : curIdx + 1;
      siblings.push(this.getNode(d, sibIdx));
      curIdx = Math.floor(curIdx / 2);
    }

    return {
      leaf,
      index,
      siblings,
      pathIndices,
      root: this.root
    };
  }

  public static verifyProof(proof: MerkleProof): boolean {
    let cur = proof.leaf;
    for (let d = 0; d < proof.siblings.length; d++) {
      if (proof.pathIndices[d] === 0) {
        cur = poseidon2(cur, proof.siblings[d]);
      } else {
        cur = poseidon2(proof.siblings[d], cur);
      }
    }
    return cur === proof.root;
  }

  public isValidRoot(root: bigint): boolean {
    return this.root === root || this.historicalRoots.includes(root);
  }
}
