/**
 * DarkCircle Protocol: CLI Pay Command
 * File: src/cli/commands/pay.ts
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { formatDecimals } from "../../audit/exporter.ts";
import { parseTokenAmount, safeJsonStringify } from "../parser.ts";
import { CliExitCode, type PayCommandOptions, type CliContext, type CliResult } from "../types.ts";
import { SettlementCoordinator } from "../../proxy/settlement.ts";
import { PaymentClient } from "../../proxy/client.ts";
import { WQUAI_ADDRESS } from "../../sim/erc20Token.ts";
import { resolveTokenArg } from "../context.ts";
import { Fp } from "../../crypto/field.ts";
import type { DecryptedNotePayload } from "../../types/audit.ts";

export async function executePayCommand(
  options: PayCommandOptions,
  context: CliContext
): Promise<CliResult> {
  const rawUrl =
    typeof options.url === "string" && options.url.trim() !== "" && options.url !== "true" && !options.url.startsWith("-")
      ? options.url.trim()
      : undefined;
  const rawRecipient =
    typeof options.recipient === "string" && options.recipient.trim() !== "" && options.recipient !== "true" && !options.recipient.startsWith("-")
      ? options.recipient.trim()
      : undefined;

  // 1. Validation: Ensure either URL or Recipient is provided
  if (!rawUrl && !rawRecipient) {
    return {
      exitCode: CliExitCode.USAGE_ERROR,
      stdout: "",
      stderr: "ERROR: Specify either --url <endpoint> or --recipient <address> --amount <amount>"
    };
  }

  const decimals = context.token?.decimals ?? 18;
  const tokenAddress =
    typeof options.token === "string" && options.token.trim() !== "" && options.token !== "true" && !options.token.startsWith("-")
      ? resolveTokenArg(options.token.trim(), context)
      : context.tokenAddress || WQUAI_ADDRESS;

  // Optional spending policy max-cap override
  if (
    options.maxCap &&
    typeof options.maxCap === "string" &&
    options.maxCap.trim() !== "" &&
    options.maxCap !== "true" &&
    !options.maxCap.startsWith("-")
  ) {
    try {
      context.spendingPolicy.maxPaymentCap = parseTokenAmount(options.maxCap.trim(), decimals);
    } catch (err: any) {
      return {
        exitCode: CliExitCode.USAGE_ERROR,
        stdout: "",
        stderr: `ERROR: Invalid max-cap format: ${err.message}`
      };
    }
  }

  // -------------------------------------------------------------------------
  // Case A: Direct Unshield Settlement to Recipient
  // -------------------------------------------------------------------------
  if (rawRecipient) {
    const rawAmount = typeof options.amount === "string" ? options.amount.trim() : "";
    if (!rawAmount || rawAmount === "true" || rawAmount.startsWith("-")) {
      return {
        exitCode: CliExitCode.USAGE_ERROR,
        stdout: "",
        stderr: "ERROR: Missing required flag --amount <amount> for recipient payment"
      };
    }

    let parsedAmount: bigint;
    try {
      parsedAmount = parseTokenAmount(rawAmount, decimals);
    } catch (err: any) {
      return {
        exitCode: CliExitCode.USAGE_ERROR,
        stdout: "",
        stderr: `ERROR: Invalid amount format: ${err.message}`
      };
    }

    if (parsedAmount <= 0n) {
      return {
        exitCode: CliExitCode.USAGE_ERROR,
        stdout: "",
        stderr: "ERROR: Amount must be greater than zero"
      };
    }

    try {
      const coordinator = new SettlementCoordinator({
        spendingPolicy: context.spendingPolicy,
        relayer: context.relayer,
        corporateKeys: context.corporateKeys,
        treasuryUTXOs: context.treasuryUTXOs,
        ppoiEngine: context.ppoiEngine,
        sanctionsRegistry: context.sanctionsRegistry,
        preferDirectUnshield: options.direct ?? false,
        spendTracker: context.spendTracker
      });

      const invoiceId =
        options.invoiceId ||
        `inv_direct_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;

      const challenge = {
        invoiceId,
        amount: parsedAmount,
        tokenAddress,
        chainId: context.blockchain.chainId,
        recipientAddress: rawRecipient,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        targetResource: "direct_payment"
      };

      const prevUtxos = [...coordinator.treasuryUTXOs];
      const fee = options.direct ? 0n : context.relayer.minimumFee;
      const totalRequired = parsedAmount + fee;
      const spentUtxo = prevUtxos.find((u) => u.value >= totalRequired);

      const { receipt } = await coordinator.settleChallenge(challenge);

      // Identify newly created change UTXO note if remainder existed
      const currentUtxos = coordinator.treasuryUTXOs;
      const changeUtxo = currentUtxos.find((u) => !prevUtxos.includes(u));

      // Synchronize context treasury UTXOs
      context.treasuryUTXOs.length = 0;
      context.treasuryUTXOs.push(...currentUtxos);

      // Log in double-entry journal if available
      if (context.journal && spentUtxo) {
        const spentCommitment = "0x" + spentUtxo.commitment.toString(16);
        let changeCommitment: string | undefined;
        let changeNotePayload: DecryptedNotePayload | undefined;

        if (changeUtxo) {
          changeCommitment = "0x" + changeUtxo.commitment.toString(16);
          changeNotePayload = {
            version: 1,
            token: changeUtxo.token,
            value: changeUtxo.value.toString(),
            blinding: Fp.toHex(changeUtxo.blinding),
            npk: Fp.toHex(changeUtxo.npk || context.corporateKeys.npk),
            direction: "OUTBOUND_CHANGE",
            counterparty: context.corporateKeys.corporate0zkAddress,
            invoiceId: receipt.invoiceId,
            memo: "Change Note",
            timestamp: receipt.settledAt
          };
        }

        context.journal.recordOutboundUnshield(
          receipt.txHash,
          receipt.blockNumber,
          receipt.settledAt,
          (receipt as any).nullifier || ("0x" + crypto.randomBytes(32).toString("hex")),
          spentCommitment,
          receipt.recipient,
          receipt.amount,
          fee,
          receipt.relayerAddress,
          changeCommitment,
          changeNotePayload,
          receipt.invoiceId,
          `Direct Payment to ${receipt.recipient}`
        );
      }

      const formattedAmount = formatDecimals(parsedAmount, decimals);
      const data = {
        status: "CONFIRMED",
        invoiceId: receipt.invoiceId,
        recipient: receipt.recipient,
        amount: parsedAmount.toString(),
        amountFormatted: formattedAmount,
        relayerAddress: receipt.relayerAddress,
        txHash: receipt.txHash,
        blockNumber: receipt.blockNumber,
        settledAt: receipt.settledAt
      };

      let outputString: string;
      if (options.json) {
        outputString = safeJsonStringify(data, 2);
      } else {
        const dateStr = new Date(receipt.settledAt * 1000).toISOString();
        outputString = [
          "═══════════════════════════════════════════════════════════════",
          "DARKCIRCLE PAYMENT SETTLEMENT CONFIRMED",
          "═══════════════════════════════════════════════════════════════",
          `Status:            ${data.status}`,
          `Invoice ID:        ${data.invoiceId}`,
          `Recipient:         ${data.recipient}`,
          `Amount:            ${data.amountFormatted} ${context.token?.symbol ?? "WQUAI"} (${data.amount} atomic units)`,
          `Relayer Address:   ${data.relayerAddress}`,
          `On-Chain TX Hash:  ${data.txHash}`,
          `Block Number:      ${data.blockNumber}`,
          `Settled At:        ${dateStr}`,
          "Decoupled Sender:  CONFIRMED (Treasury decoupled via Relayer broadcast)",
          "═══════════════════════════════════════════════════════════════"
        ].join("\n");
      }

      if (options.output) {
        if (
          typeof options.output !== "string" ||
          options.output.trim() === "" ||
          options.output === "true" ||
          options.output.startsWith("-")
        ) {
          return {
            exitCode: CliExitCode.USAGE_ERROR,
            stdout: "",
            stderr: "ERROR: Missing required argument for --output <file>"
          };
        }
        const resolved = path.resolve(process.cwd(), options.output.trim());
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, outputString, "utf8");
        return {
          exitCode: CliExitCode.SUCCESS,
          stdout: `✓ Direct payment completed and written to: ${options.output}`,
          stderr: "",
          data
        };
      }

      return {
        exitCode: CliExitCode.SUCCESS,
        stdout: outputString,
        stderr: "",
        data
      };
    } catch (err: any) {
      return {
        exitCode: CliExitCode.EXECUTION_ERROR,
        stdout: "",
        stderr: `ERROR: Settlement failed: ${err.message}`
      };
    }
  }

  // -------------------------------------------------------------------------
  // Case B: Transparent HTTP 402 URL Payment
  // -------------------------------------------------------------------------
  try {
    const client = new PaymentClient({
      spendingPolicy: context.spendingPolicy,
      relayer: context.relayer,
      corporateKeys: context.corporateKeys,
      treasuryUTXOs: context.treasuryUTXOs,
      fetchFn:
        context.fetchFn ||
        (typeof globalThis.fetch !== "undefined"
          ? globalThis.fetch.bind(globalThis)
          : undefined),
      options: {
        ppoiEngine: context.ppoiEngine,
        sanctionsRegistry: context.sanctionsRegistry,
        preferDirectUnshield: options.direct ?? false
      }
    });

    const targetUrl = rawUrl!;
    const prevUtxos = [...context.treasuryUTXOs];
    const response = await client.fetch(targetUrl);

    // Synchronize context treasury UTXOs
    const currentUtxos = client.interceptor.treasuryUTXOs;
    context.treasuryUTXOs.length = 0;
    context.treasuryUTXOs.push(...currentUtxos);

    let payload: any;
    try {
      payload = await response.clone().json();
    } catch {
      try {
        payload = await response.clone().text();
      } catch {
        payload = null;
      }
    }

    const cacheKey = client.extractCacheKey(targetUrl);
    const receipt =
      client.interceptor.receiptCache.get(cacheKey) ||
      client.interceptor.receiptCache.get(targetUrl);

    // Record in journal if an unshield occurred
    if (receipt && context.journal) {
      const spentUtxo = prevUtxos.find((u) => !currentUtxos.includes(u));
      const changeUtxo = currentUtxos.find((u) => !prevUtxos.includes(u));
      if (spentUtxo) {
        const spentCommitment = "0x" + spentUtxo.commitment.toString(16);
        let changeCommitment: string | undefined;
        let changeNotePayload: DecryptedNotePayload | undefined;
        if (changeUtxo) {
          changeCommitment = "0x" + changeUtxo.commitment.toString(16);
          changeNotePayload = {
            version: 1,
            token: changeUtxo.token,
            value: changeUtxo.value.toString(),
            blinding: Fp.toHex(changeUtxo.blinding),
            npk: Fp.toHex(changeUtxo.npk || context.corporateKeys.npk),
            direction: "OUTBOUND_CHANGE",
            counterparty: context.corporateKeys.corporate0zkAddress,
            invoiceId: receipt.invoiceId,
            memo: "Change Note",
            timestamp: receipt.settledAt ?? Math.floor(Date.now() / 1000)
          };
        }
        context.journal.recordOutboundUnshield(
          receipt.txHash,
          receipt.blockNumber || context.blockchain.currentBlockNumber,
          receipt.settledAt ?? Math.floor(Date.now() / 1000),
          (receipt as any).nullifier || ("0x" + crypto.randomBytes(32).toString("hex")),
          spentCommitment,
          receipt.recipient || "0xRecipient",
          receipt.amount,
          context.relayer.minimumFee,
          receipt.relayerAddress,
          changeCommitment,
          changeNotePayload,
          receipt.invoiceId,
          `x402 Resource Payment: ${targetUrl}`
        );
      }
    }

    if (response.status !== 200) {
      return {
        exitCode: CliExitCode.EXECUTION_ERROR,
        stdout: "",
        stderr: `ERROR: Request failed with HTTP status ${response.status}: ${JSON.stringify(payload)}`,
        data: { status: response.status, payload }
      };
    }

    const data = {
      status: 200,
      statusText: "OK",
      url: targetUrl,
      payload,
      receipt
    };

    let outputString: string;
    if (options.json) {
      outputString = safeJsonStringify(data, 2);
    } else {
      const formattedAmt = receipt ? formatDecimals(receipt.amount, decimals) : "N/A";
      outputString = [
        "═══════════════════════════════════════════════════════════════",
        "DARKCIRCLE x402 PAYMENT & RESOURCE ACCESS SUCCEEDED",
        "═══════════════════════════════════════════════════════════════",
        `Resource URL:      ${targetUrl}`,
        "HTTP Status:       200 OK",
        `Invoice ID:        ${receipt?.invoiceId || "N/A"}`,
        `Settlement TX:     ${receipt?.txHash || "N/A"}`,
        `Relayer Address:   ${receipt?.relayerAddress || "N/A"}`,
        `Amount Paid:       ${formattedAmt} ${context.token?.symbol ?? "WQUAI"}`,
        "───────────────────────────────────────────────────────────────",
        "Response Payload:",
        typeof payload === "object" ? JSON.stringify(payload, null, 2) : String(payload),
        "═══════════════════════════════════════════════════════════════"
      ].join("\n");
    }

    if (options.output) {
      if (
        typeof options.output !== "string" ||
        options.output.trim() === "" ||
        options.output === "true" ||
        options.output.startsWith("-")
      ) {
        return {
          exitCode: CliExitCode.USAGE_ERROR,
          stdout: "",
          stderr: "ERROR: Missing required argument for --output <file>"
        };
      }
      const resolved = path.resolve(process.cwd(), options.output.trim());
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, outputString, "utf8");
      return {
        exitCode: CliExitCode.SUCCESS,
        stdout: `✓ Payment succeeded and response written to: ${options.output}`,
        stderr: "",
        data
      };
    }

    return {
      exitCode: CliExitCode.SUCCESS,
      stdout: outputString,
      stderr: "",
      data
    };
  } catch (err: any) {
    return {
      exitCode: CliExitCode.EXECUTION_ERROR,
      stdout: "",
      stderr: `ERROR: Transparent payment failed: ${err.message}`
    };
  }
}
