/**
 * Railgun Zero-Knowledge Protocol & Shielded Pool Types
 * DarkCircle Protocol
 */

import type { SerializedNote, UnshieldProof, MerkleProof } from "./crypto.js";

export interface UTXO {
  npk: bigint;
  token: string;
  value: bigint;
  rho: bigint;
  memo?: string;
  leafIndex: number;
  commitment: bigint;
}

export interface ShieldRequest {
  npk: bigint;
  token: string;
  value: bigint;
  memo?: string;
}

export interface ShieldResult {
  commitment: bigint;
  leafIndex: number;
  treeRoot: bigint;
  note: SerializedNote;
}

export interface UnshieldRequest {
  utxo: UTXO;
  recipient: string;
  paymentAmount: bigint;
  relayerFee: bigint;
  relayerAddress: string;
  memo?: string;
}

export interface UnshieldExecutionResult {
  nullifier: bigint;
  recipient: string;
  amount: bigint;
  relayerAddress: string;
  relayerFee: bigint;
  changeCommitment?: bigint;
  changeNote?: SerializedNote;
  treeRoot: bigint;
  txHash: string;
}

export interface HistoricalRootRecord {
  root: bigint;
  blockNumber: number;
  timestamp: number;
}
