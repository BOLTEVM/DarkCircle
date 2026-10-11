/**
 * DarkCircle Protocol: HTTP 402 challenge construction for Quai
 *
 * Single place that renders an invoice as an x402 challenge (WWW-Authenticate header, X-Payment-*
 * headers and RFC 7807 body), so the merchant gateway and the standalone resource server advertise
 * the same Quai network, chain id and zone-valid ephemeral recipient.
 */

import { DEFAULT_QUAI_NETWORK, type QuaiNetwork } from "../quai/networks.ts";
import { formatTokenAmount } from "../quai/tokens.ts";
import type { PaymentChallengeBody } from "./types.ts";

export interface QuaiChallengeInput {
  network?: QuaiNetwork;
  invoiceId: string;
  resourceUri: string;
  recipient: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: bigint;
  createdAt: number;
  expiresAt: number;
}

export function buildQuaiChallenge(input: QuaiChallengeInput): {
  headers: Record<string, string>;
  body: PaymentChallengeBody;
} {
  const network = input.network ?? DEFAULT_QUAI_NETWORK;
  const pretty = formatTokenAmount(input.amount, input.tokenDecimals).replace(/\.0$/, "");

  const headers: Record<string, string> = {
    "WWW-Authenticate": `x402 scheme="erc20_transfer", network="${network.id}", chainId="${network.chainId}", token="${input.tokenAddress}", recipient="${input.recipient}", amount="${input.amount.toString()}", invoiceId="${input.invoiceId}", expiresAt="${input.expiresAt}", proofType="tx_receipt"`,
    "X-Payment-Required": "true",
    "X-Payment-Scheme": "x402-v1",
    "X-Payment-Network": network.id,
    "X-Payment-Chain-Id": String(network.chainId),
    "X-Payment-Token": input.tokenAddress,
    "X-Payment-Token-Symbol": input.tokenSymbol,
    "X-Payment-Token-Decimals": input.tokenDecimals.toString(),
    "X-Payment-Recipient": input.recipient,
    "X-Payment-Amount": input.amount.toString(),
    "X-Payment-Invoice-Id": input.invoiceId,
    "X-Payment-Expires-At": input.expiresAt.toString(),
    "X-Payment-Resource": input.resourceUri
  };

  const body: PaymentChallengeBody = {
    type: "https://darkcircle.network/errors/payment-required",
    title: "Payment Required",
    status: 402,
    detail: `Access to this endpoint requires a payment of ${pretty} ${input.tokenSymbol} on ${network.title}.`,
    instance: input.resourceUri,
    payment: {
      protocol: "x402",
      version: "1.0.0",
      invoiceId: input.invoiceId,
      network: network.id,
      chainId: network.chainId,
      token: {
        address: input.tokenAddress,
        symbol: input.tokenSymbol,
        decimals: input.tokenDecimals
      },
      amount: input.amount.toString(),
      recipient: input.recipient,
      ephemeral: true,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      proofType: "tx_receipt"
    }
  };

  return { headers, body };
}
