/**
 * Private Proof of Innocence (PPOI) Type Definitions
 * DarkCircle Compliance Engine
 */

import type { SMTProofSerialized } from "./smt.js";

export type SanctionCategory =
  | "OFAC_SDN"
  | "EXPLOIT_CLUSTER"
  | "RANSOMWARE"
  | "DARKNET_MARKET"
  | "TESTNET_SANCTION";

export interface SanctionedEntry {
  addressOrCommitment: string;
  key: bigint;
  category: SanctionCategory;
  description: string;
  addedAt: number;
}

export interface PPOIProof {
  sanctionsRoot: string;
  depositOrigin: string;
  key: string;
  smtProof: SMTProofSerialized;
  depositTimestamp?: number;
  proofTimestamp: number;
  standbyWindowElapsed: boolean;
  signatureOrWitness?: string;
}

export interface PPOIVerificationResult {
  isValid: boolean;
  isSanctioned: boolean;
  isRootKnown: boolean;
  isMature: boolean;
  reason?: string;
}

export interface UnshieldValidationRequest {
  merkleRoot: string;
  nullifier: string;
  recipient: string;
  token: string;
  amount: bigint;
  relayerFee: bigint;
  relayerAddress: string;
  depositOrigin: string;
  depositTimestamp: number;
  ppoiProof: PPOIProof;
}
