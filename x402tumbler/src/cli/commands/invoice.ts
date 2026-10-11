/**
 * DarkCircle Protocol: CLI Invoice Command
 * File: src/cli/commands/invoice.ts
 */

import fs from "node:fs";
import path from "node:path";
import { formatDecimals } from "../../audit/exporter.ts";
import { parseTokenAmount, safeJsonStringify } from "../parser.ts";
import { CliExitCode, type InvoiceCommandOptions, type CliContext, type CliResult } from "../types.ts";
import { WQUAI_ADDRESS } from "../../sim/erc20Token.ts";
import { resolveTokenArg } from "../context.ts";

export async function executeInvoiceCommand(
  options: InvoiceCommandOptions,
  context: CliContext
): Promise<CliResult> {
  // 1. Validate required amount flag
  const rawAmount = typeof options.amount === "string" ? options.amount.trim() : "";
  if (!rawAmount || rawAmount === "true" || rawAmount.startsWith("-")) {
    return {
      exitCode: CliExitCode.USAGE_ERROR,
      stdout: "",
      stderr: "ERROR: Missing required flag --amount <amount>"
    };
  }

  const decimals =
    typeof options.decimals === "number" && !isNaN(options.decimals) && options.decimals >= 0
      ? options.decimals
      : context.token?.decimals ?? 18;

  const tokenSymbol =
    typeof options.symbol === "string" && options.symbol.trim() !== "" && options.symbol !== "true" && !options.symbol.startsWith("-")
      ? options.symbol.trim()
      : context.token?.symbol ?? "WQUAI";

  const tokenAddress =
    typeof options.token === "string" && options.token.trim() !== "" && options.token !== "true" && !options.token.startsWith("-")
      ? resolveTokenArg(options.token.trim(), context)
      : context.tokenAddress || WQUAI_ADDRESS;

  const resourceUri =
    typeof options.resource === "string" && options.resource.trim() !== "" && options.resource !== "true" && !options.resource.startsWith("-")
      ? options.resource.trim()
      : "/api/v1/protected/resource";

  const ttl =
    typeof options.ttl === "number" && !isNaN(options.ttl) && options.ttl > 0
      ? options.ttl
      : 900;

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

  // 2. Generate Challenge with Ephemeral Stealth Address
  const challengeResult = context.merchantGateway.createPaymentChallenge(
    resourceUri,
    parsedAmount,
    tokenAddress,
    tokenSymbol,
    decimals,
    ttl
  );

  const formattedAmount = formatDecimals(parsedAmount, decimals);

  // 3. Format Output
  let outputString: string;
  if (options.json) {
    // The ephemeral private key controls the payee address; it stays inside the invoice registry until
    // the sweep zeroizes it and must never be printed, logged or returned over an API.
    outputString = safeJsonStringify(
      { ...challengeResult, invoice: { ...challengeResult.invoice, ephemeralPrivateKey: "[REDACTED]" } },
      2
    );
  } else {
    const inv = challengeResult.invoice;
    const expiresDate = new Date(inv.expiresAt * 1000).toISOString();
    outputString = [
      "═══════════════════════════════════════════════════════════════",
      "DARKCIRCLE x402 PAYMENT INVOICE",
      "═══════════════════════════════════════════════════════════════",
      `Invoice ID:          ${inv.invoiceId}`,
      `Resource URI:        ${inv.resourceUri}`,
      `Required Amount:     ${formattedAmount} ${tokenSymbol} (${parsedAmount.toString()} atomic units)`,
      `Recipient (Stealth): ${inv.ephemeralAddress}`,
      `Token Contract:      ${inv.tokenAddress}`,
      `Status:              ${inv.status}`,
      `Expires At:          ${expiresDate}`,
      `Network:             ${context.blockchain.network.title} (Chain ID: ${context.blockchain.chainId})`,
      "───────────────────────────────────────────────────────────────",
      "RFC 7235 Authentication Header:",
      `  WWW-Authenticate: ${challengeResult.challengeHeaders["WWW-Authenticate"]}`,
      "═══════════════════════════════════════════════════════════════"
    ].join("\n");
  }

  // 4. File Output Handling
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
    try {
      const resolved = path.resolve(process.cwd(), options.output.trim());
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, outputString, "utf8");
      return {
        exitCode: CliExitCode.SUCCESS,
        stdout: `✓ Invoice successfully generated and written to: ${options.output}`,
        stderr: "",
        data: challengeResult
      };
    } catch (err: any) {
      return {
        exitCode: CliExitCode.EXECUTION_ERROR,
        stdout: "",
        stderr: `ERROR: Failed to write output file: ${err.message}`,
        data: challengeResult
      };
    }
  }

  return {
    exitCode: CliExitCode.SUCCESS,
    stdout: outputString,
    stderr: "",
    data: challengeResult
  };
}
