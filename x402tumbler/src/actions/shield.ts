/**
 * DarkCircle: shield (deposit) action
 * File: src/actions/shield.ts
 *
 * Moves tokens from a public Quai address into the corporate shielded pool as a new note. Shared by the
 * CLI `shield` command and the UI Shield modal so both take exactly the same path:
 *
 *   [optional] wrap native QUAI -> WQUAI     (WQUAI only; WQI has no deposit())
 *   approve the pool for the amount           (what the depositor's wallet would sign)
 *   pool.shield(...)                          (verified pool pulls the funds in this call)
 *   journal the deposit                       (double-entry, viewing-key auditable)
 */

import crypto from "node:crypto";
import { Fp } from "../crypto/field.ts";
import { assertQuaiPaymentAddress } from "../quai/address.ts";
import { defaultQuaiTokenRegistry, formatTokenAmount } from "../quai/tokens.ts";
import { ethers } from "ethers";
import type { CliContext } from "../cli/types.ts";
import type { ShieldedUTXO } from "../types/sim.ts";

export interface ShieldOptions {
  amount: bigint;
  /** Symbol or address; defaults to the context's asset. */
  token?: string;
  /** Funding address; defaults to the operating wallet. */
  depositor?: string;
  /** Wrap this much native QUAI into WQUAI first (WQUAI only). */
  wrapNative?: boolean;
  memo?: string;
}

export interface ShieldResult {
  txHash: string;
  blockNumber: number;
  commitment: string;
  leafIndex: number;
  root: string;
  amount: string;
  symbol: string;
  depositor: string;
  wrapped: boolean;
}

const TOPIC_TRANSFER = ethers.id("Transfer(address,address,uint256)");

export function executeShield(ctx: CliContext, opts: ShieldOptions): ShieldResult {
  const network = ctx.blockchain.network;
  const registered = defaultQuaiTokenRegistry.require(opts.token ?? ctx.token?.symbol ?? "WQUAI", network);
  if (!ctx.spendingPolicy.allowedTokens.some((a) => a.toLowerCase() === registered.address.toLowerCase())) {
    throw new Error(`ERR_UNSUPPORTED_CHAIN_OR_TOKEN: ${registered.symbol} is not allowed by the spending policy`);
  }
  const token = ctx.blockchain.getToken(registered.address);
  if (!token) throw new Error(`ERR_QUAI_TOKEN_UNKNOWN: ${registered.symbol} is not deployed on this ledger`);
  if (opts.amount <= 0n) throw new Error("SHIELD_AMOUNT_MUST_BE_POSITIVE");

  const depositor = assertQuaiPaymentAddress(opts.depositor ?? ctx.corporateOperatingAddress ?? "", network);

  // One journal, one asset: refuse before anything moves rather than fail half way.
  const journal = ctx.journal;
  if (journal && journal.entries.length > 0 && journal.assetAddress.toLowerCase() !== registered.address.toLowerCase()) {
    throw new Error(`ERR_AUDIT_MIXED_ASSETS: this ledger is ${journal.assetSymbol}; start a separate context for ${registered.symbol}`);
  }

  let wrapped = false;
  if (opts.wrapNative) {
    if (!token.wrapsNative) throw new Error(`ERR_WRAP_UNSUPPORTED: ${registered.symbol} cannot be wrapped from native QUAI`);
    token.deposit(depositor, opts.amount);
    wrapped = true;
  }

  const balance = token.balanceOf(depositor);
  if (balance < opts.amount) {
    throw new Error(`ERR_SHIELD_FUNDING_FAILED: ${depositor} holds ${formatTokenAmount(balance)} ${registered.symbol}, needs ${formatTokenAmount(opts.amount)}`);
  }

  // The depositor approves the pool for exactly this amount; the verified pool pulls it in shield().
  token.approve(ctx.pool.contractAddress, opts.amount, depositor);

  const blinding = Fp.random();
  const memo = opts.memo ?? "Treasury shield deposit";
  const shielded = ctx.pool.shield(token.address, opts.amount, ctx.corporateKeys.npk, blinding, memo, depositor);

  // The pool's own record of when the note was deposited: PPOI checks the note against it.
  const now = shielded.depositTimestamp;
  const utxo: ShieldedUTXO = {
    commitment: shielded.commitment,
    leafIndex: shielded.leafIndex,
    token: token.address.toLowerCase(),
    value: opts.amount,
    blinding,
    rho: blinding,
    npk: ctx.corporateKeys.npk,
    memo,
    depositorAddress: depositor.toLowerCase(),
    depositTimestamp: now
  };
  ctx.treasuryUTXOs.push(utxo);

  // Give the deposit a transaction with a Transfer log, like the token contract would on Quai.
  const blockNumber = ctx.blockchain.createBlock();
  const recorded = ctx.blockchain.recordSyntheticTransaction({
    from: depositor,
    to: ctx.pool.contractAddress,
    logs: [
      {
        address: token.address,
        topics: [TOPIC_TRANSFER, ethers.zeroPadValue(depositor, 32), ethers.zeroPadValue(ctx.pool.contractAddress, 32)],
        data: ethers.toBeHex(opts.amount, 32)
      }
    ],
    extra: { token: token.address, amount: opts.amount, kind: "shield" }
  });

  journal?.recordInbound(
    recorded.txHash,
    blockNumber,
    "0x" + shielded.commitment.toString(16),
    {
      version: 1,
      token: token.address.toLowerCase(),
      value: opts.amount.toString(),
      blinding: Fp.toHex(blinding),
      npk: Fp.toHex(ctx.corporateKeys.npk),
      direction: "INBOUND_SHIELD",
      counterparty: depositor,
      memo,
      timestamp: now
    }
  );

  return {
    txHash: recorded.txHash || "0x" + crypto.randomBytes(32).toString("hex"),
    blockNumber,
    commitment: "0x" + shielded.commitment.toString(16),
    leafIndex: shielded.leafIndex,
    root: Fp.toHex(shielded.root),
    amount: formatTokenAmount(opts.amount, registered.decimals),
    symbol: registered.symbol,
    depositor,
    wrapped
  };
}
