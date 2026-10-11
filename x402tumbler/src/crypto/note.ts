import { getAddress } from "ethers";
import { Fp } from "./field.ts";
import { poseidon3, poseidon4 } from "./poseidon.ts";
import { BABYJUBJUB_L } from "./babyjubjub.ts";
import type { SerializedNote } from "../types/crypto.ts";

/**
 * DarkCircle UTXO Note Implementation
 * Note commitment: Poseidon4(npk, token, value, rho)
 * Nullifier: Poseidon3(ssk, commitment, leafIndex)
 */
export class Note {
  public readonly npk: bigint;
  public readonly token: string;
  public readonly value: bigint;
  public readonly rho: bigint;
  public readonly memo?: string;
  public leafIndex?: number;

  constructor(params: {
    npk: bigint;
    token: string;
    value: bigint;
    rho: bigint;
    memo?: string;
    leafIndex?: number;
  }) {
    if (params.value <= 0n) {
      throw new Error("Note value must be strictly positive (> 0)");
    }
    this.npk = Fp.mod(params.npk);
    this.token = getAddress(params.token);
    this.value = params.value;
    this.rho = Fp.mod(params.rho);
    this.memo = params.memo;
    this.leafIndex = params.leafIndex;
  }

  public static create(params: {
    npk: bigint;
    token: string;
    value: bigint;
    rho?: bigint;
    memo?: string;
    leafIndex?: number;
  }): Note {
    return new Note({
      npk: params.npk,
      token: params.token,
      value: params.value,
      rho: params.rho ?? Fp.random(),
      memo: params.memo,
      leafIndex: params.leafIndex
    });
  }

  public get tokenBigInt(): bigint {
    return BigInt(this.token);
  }

  public computeCommitment(): bigint {
    return poseidon4(this.npk, this.tokenBigInt, this.value, this.rho);
  }

  public computeNullifier(ssk: bigint): bigint {
    if (this.leafIndex === undefined || this.leafIndex === null) {
      throw new Error("Cannot compute nullifier without assigned leafIndex");
    }
    // Only the canonical scalar in [0, L) is accepted by the pool and the circuit (one nullifier per note).
    if (ssk < 0n || ssk >= BABYJUBJUB_L) {
      throw new Error("ERR_SPENDING_KEY_OUT_OF_RANGE: the spending key must satisfy 0 <= key < L");
    }
    const commitment = this.computeCommitment();
    return poseidon3(ssk, commitment, BigInt(this.leafIndex));
  }

  public serialize(): SerializedNote {
    return {
      npk: Fp.toHex(this.npk),
      token: this.token,
      value: this.value.toString(),
      rho: Fp.toHex(this.rho),
      memo: this.memo,
      leafIndex: this.leafIndex,
      commitment: Fp.toHex(this.computeCommitment())
    };
  }

  public static deserialize(data: SerializedNote): Note {
    return new Note({
      npk: Fp.fromHex(data.npk),
      token: data.token,
      value: BigInt(data.value),
      rho: Fp.fromHex(data.rho),
      memo: data.memo,
      leafIndex: data.leafIndex
    });
  }
}
