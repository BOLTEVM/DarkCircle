/**
 * DarkCircle Cryptographic Core Types
 */

export type FpScalar = bigint;
export type Point = [bigint, bigint];

export interface SerializedNote {
  npk: string;         // Hex string (0x...)
  token: string;       // Checksummed hex address
  value: string;       // Decimal string
  rho: string;         // Hex string (0x...)
  memo?: string;
  leafIndex?: number;
  commitment?: string; // Hex string (0x...)
}

export interface MerkleProof {
  leaf: bigint;
  index: number;
  siblings: bigint[];
  pathIndices: number[];
  root: bigint;
}

export interface PPOIProofPayload {
  sanctionsRoot: string;
  depositOriginHash: string;
  smtSiblings: string[];
  isNonSanctioned: boolean;
}

export interface ZKProofPayload {
  membershipProof: {
    leafIndex: number;
    pathIndices: number[];
    siblings: string[];
  };
  balanceProof: {
    inputValue: string;
    outputPayment: string;
    relayerFee: string;
    changeValue: string;
  };
  publicInputsHash: string;
}

export interface UnshieldProof {
  merkleRoot: string;
  nullifier: string;
  recipient: string;
  token: string;
  amount: bigint;
  relayerFee: bigint;
  relayerAddress: string;
  changeCommitment?: string;
  publicInputsHash: string;
  ppoiProof: PPOIProofPayload;
  zkProof: ZKProofPayload;
}
