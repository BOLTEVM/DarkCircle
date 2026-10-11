/**
 * HTTP 402 Payment Required Protocol & Gateway Types
 * DarkCircle Protocol
 */

export interface X402PaymentChallenge {
  recipient: string;        // Payment destination address (often ephemeral)
  amount: bigint;           // Atomic token amount
  token: string;            // ERC-20 token address
  network: string;          // Network name or chainId
  chainId: number;
  invoiceId: string;        // Unique invoice identifier
  expiresAt: number;        // Unix timestamp (ms or sec)
  maxFee?: bigint;          // Optional max relayer fee acceptable
  memo?: string;            // Invoice description or memo
}

export interface X402ChallengeHeaders {
  "www-authenticate"?: string;
  "x-payment-recipient"?: string;
  "x-payment-amount"?: string;
  "x-payment-token"?: string;
  "x-payment-network"?: string;
  "x-payment-invoice-id"?: string;
  "x-payment-expires-at"?: string;
}

export interface X402ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  recipient: string;
  amount: string;
  token: string;
  network: string;
  chainId: number;
  invoiceId: string;
  expiresAt: number;
}

export interface PaymentReceipt {
  receiptId: string;
  invoiceId: string;
  txHash: string;
  blockNumber: number;
  amount: bigint;
  token: string;
  recipient: string;
  relayerAddress: string;
  relayerFee: bigint;
  timestamp: number;
  status: "pending" | "confirmed" | "failed";
}

export interface EphemeralPaymentRequest {
  invoiceId: string;
  ephemeralAddress: string;
  ephemeralPrivateKey?: string;
  amount: bigint;
  token: string;
  expiresAt: number;
  challengeHeader: string;
  status: "PENDING" | "SETTLED" | "SWEPT" | "EXPIRED";
}
