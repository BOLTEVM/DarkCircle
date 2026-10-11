/**
 * Simulated Blockchain & Production-Grade Contract Types
 * DarkCircle Protocol
 */

export interface SimAccount {
  address: string;
  nativeBalance: bigint;
  nonce: number;
  tokens: Map<string, bigint>; // tokenAddress (lowercase) -> balance
  allowances: Map<string, Map<string, bigint>>; // tokenAddress -> spender -> amount
}

export interface SimBlock {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  transactions: SimTransaction[];
  gasUsed: bigint;
  gasLimit: bigint;
}

export interface SimTransaction {
  hash: string;
  from: string;
  to: string;
  value: bigint;
  nonce: number;
  gasLimit?: bigint;
  gasPrice?: bigint;
  data?: string;
  accessList?: Array<{ address: string; storageKeys: string[] }>;
  blockNumber: number;
  timestamp: number;
  status: "success" | "reverted";
  error?: string;
  tokenTransfer?: {
    token: string;
    from: string;
    to: string;
    amount: bigint;
  };
}

export interface SimTransactionRequest {
  from: string;
  to: string;
  /** Quai access list; required whenever the call touches more than the target contract. */
  accessList?: Array<{ address: string; storageKeys: string[] }>;
  value?: bigint;
  nonce?: number;
  data?: string;
  gasLimit?: bigint;
  gasPrice?: bigint;
  tokenTransfer?: {
    token: string;
    from: string;
    to: string;
    amount: bigint;
  };
}

export interface SimTransactionReceipt {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  from: string;
  to: string;
  status: 1 | 0; // 1 = success, 0 = reverted
  gasUsed: bigint;
  logs: SimLog[];
  returnData?: string;
  error?: string;
}

export interface SimLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
}

export interface SimCallRequest {
  to: string;
  from?: string;
  data: string;
  value?: bigint;
}

export interface SimContract {
  address: string;
  handleTransaction(tx: SimTransaction): {
    status: 1 | 0;
    logs: SimLog[];
    returnData: string;
    error?: string;
  };
  handleCall(data: string, from?: string): string;
  /** Other contracts this calldata reaches; a non-empty result makes the Quai access-list rule apply. */
  touchedContracts?(data: string): string[];
}

export interface ERC20Metadata {
  name: string;
  symbol: string;
  decimals: number;
  address: string;
}

export interface ERC20Event {
  event: "Transfer" | "Approval";
  token: string;
  from?: string;
  to?: string;
  owner?: string;
  spender?: string;
  value: bigint;
  blockNumber: number;
  timestamp: number;
  txHash?: string;
}

export interface EIP712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

export interface PermitData {
  owner: string;
  spender: string;
  value: bigint;
  nonce: bigint;
  deadline: number;
  v: number;
  r: string;
  s: string;
}

export interface ERC20PermitRequest {
  owner: string;
  spender: string;
  value: bigint;
  deadline: number;
  v: number;
  r: string;
  s: string;
}

export interface IERC20 {
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  totalSupply(): bigint;
  balanceOf(account: string): bigint;
  transfer(to: string, amount: bigint, from?: string): boolean;
  allowance(owner: string, spender: string): bigint;
  approve(spender: string, amount: bigint, owner?: string): boolean;
  transferFrom(from: string, to: string, amount: bigint, spender?: string): boolean;
  mint(to: string, amount: bigint): void;
  burn(from: string, amount: bigint): void;
  permit(
    owner: string,
    spender: string,
    value: bigint,
    deadline: number,
    v: number,
    r: string,
    s: string
  ): boolean;
  nonces(owner: string): bigint;
  DOMAIN_SEPARATOR(): string;
}

export interface ERC20ContractView {
  readonly address: string;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly signer: string;
  balanceOf(): bigint;
  transfer(to: string, amount: bigint): boolean;
  approve(spender: string, amount: bigint): boolean;
  allowance(spender: string): bigint;
  transferFrom(from: string, to: string, amount: bigint): boolean;
  permit(
    spender: string,
    value: bigint,
    deadline: number,
    v: number,
    r: string,
    s: string
  ): boolean;
}

export interface SimStateSnapshot {
  id: number;
  blockNumber: number;
  timestamp: number;
  accounts: Map<
    string,
    {
      address: string;
      nativeBalance: bigint;
      nonce: number;
      tokens: Map<string, bigint>;
      allowances: Map<string, Map<string, bigint>>;
    }
  >;
  blocksCount: number;
}

/**
 * Shielded Note UTXO stored in pool registry.
 */
export interface ShieldedUTXO {
  commitment: bigint;
  leafIndex: number;
  token: string;
  value: bigint;
  blinding: bigint;
  rho?: bigint;
  npk?: bigint;
  memo: string;
  depositorAddress?: string;
  depositTimestamp: number;
}

/**
 * Unshield transaction request payload.
 */
export interface UnshieldRequest {
  /** Private inputs for the unshield statement; required by verified pools (see unshieldVerifier.ts). */
  witness?: import("../sim/unshieldVerifier.ts").UnshieldWitness;
  merkleRoot: bigint | string;
  nullifier: bigint | string;
  recipient: string;
  token: string;
  amount: bigint;
  relayerFee: bigint;
  relayerAddress: string;
  changeCommitment?: bigint | string;
  publicInputsHash?: string;
  ppoiProof: {
    sanctionsRoot?: bigint | string;
    depositOrigin: bigint | string;
    isNonSanctioned: boolean;
    smtProof?: any;
    depositTimestamp?: number;
  };
}

export type SimUnshieldRequest = UnshieldRequest;

/**
 * Structured event logged by Shielded Pool.
 */
export interface PoolEvent {
  type: "SHIELD" | "UNSHIELD";
  leafIndex?: number;
  commitment?: bigint;
  txHash?: string;
  nullifier?: string;
  recipient?: string;
  token: string;
  amount: bigint;
  fee?: bigint;
  relayer?: string;
  depositorAddress?: string;
  memo?: string;
  blockNumber: number;
  timestamp: number;
}

/**
 * Result returned upon successful unshield execution.
 */
export interface UnshieldResult {
  /** Leaf index of the change note, when the unshield produced one. */
  changeLeafIndex?: number;
  /** Commitment of the spent input note (verified pools only). */
  inputCommitment?: string;
  txHash: string;
  blockNumber: number;
  nullifier: string;
  recipient: string;
  amount: bigint;
  fee: bigint;
  relayer: string;
}

/**
 * Relayer fee quote response.
 */
export interface RelayerQuote {
  relayerAddress: string;
  feeToken: string;
  estimatedFeeUnits: bigint;
}

/**
 * Result returned upon broadcasting unshield transaction.
 */
export interface RelayerBroadcastResult {
  changeLeafIndex?: number;
  txHash: string;
  blockNumber: number;
  relayerAddress: string;
  status: "confirmed";
}
