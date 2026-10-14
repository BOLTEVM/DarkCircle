/**
 * DarkCircle production relayer: shared types
 * File: src/relayer/types.ts
 *
 * The request carries a proof and public fields only — never a spending key, a viewing key, a note
 * or a blinding factor (RELAYER_PLAN.md §2). The proof and payment shape mirror the on-chain
 * DarkCirclePool.unshield(Proof, Payment) exactly; the pool supplies the token itself, so the token
 * is configured per relayer process rather than proven.
 */

/** Groth16 proof points as decimal/hex strings straight from snarkjs publicSignals/calldata. */
export interface RelayProof {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
}

/** Mirrors DarkCirclePool.Payment (token is the pool's immutable, not a field). */
export interface RelayPayment {
  root: string;
  nullifier: string;
  changeCommitment: string;
  recipient: string;
  amount: string;
  relayer: string;
  fee: string;
}

export interface RelayRequest {
  /** The settlement asset the caller believes it is spending; must equal this relayer's pool token. */
  token: string;
  proof: RelayProof;
  payment: RelayPayment;
}

export interface RelayQuote {
  relayer: string;
  feeToken: string;
  /** Base units of the pool token; the client binds exactly this (or more) in the proof. */
  estimatedFeeUnits: string;
  /** First block at which the quote is no longer honoured (12 blocks by default). */
  expiresAtBlock: number;
  gasPrice: string;
  quoteBlock: number;
}

export type RelayRecordStatus =
  | "pending" /** sent, waiting for confirmations */
  | "confirmed"
  | "reverted" /** on-chain revert; nullifier NOT spent, a retry may be attempted */
  | "dropped" /** never landed within the timeout; a retry may be attempted */
  | "reorged"; /** was pending, its receipt disappeared (reorg or stale RPC); being re-checked */

export interface RelayRecord {
  nullifier: string;
  status: RelayRecordStatus;
  txHash?: string;
  nonce?: number;
  fee?: string;
  recipient?: string;
  amount?: string;
  submittedAtBlock?: number;
  attempts: number;
  confirmations?: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Named refusal errors. Every refuse path in the relayer throws one of these as `Error.name`; the
 * HTTP layer maps them to status codes and the log shows the name, never the payload.
 */
export const RELAYER_ERRORS = [
  "ERR_RELAYER_OFFLINE",
  "ERR_RELAYER_GAS_FLOOR",
  "ERR_RELAYER_RECONCILING",
  "TOKEN_POOL_MISMATCH",
  "RELAYER_ADDRESS_MISMATCH",
  "FEE_BELOW_QUOTE",
  "QUOTE_EXPIRED",
  "NULLIFIER_ALREADY_SPENT",
  "UNKNOWN_ROOT",
  "RELAY_SIMULATION_FAILED",
  "NULLIFIER_RECORD_CONFLICT",
  "RELAY_ATTEMPTS_EXHAUSTED",
  "ERR_RPC_TX_DROPPED",
  "ERR_SIGNER_POLICY",
  "ERR_BAD_REQUEST"
] as const;

export type RelayerErrorName = (typeof RELAYER_ERRORS)[number];

export class RelayerError extends Error {
  constructor(name: RelayerErrorName, detail?: string) {
    super(detail ? `${name}: ${detail}` : name);
    this.name = name;
  }
}

export function isRelayerError(err: unknown, name?: RelayerErrorName): boolean {
  return err instanceof RelayerError && (name === undefined || err.name === name);
}
