/**
 * DarkCircle Protocol: CLI Shield Command
 * File: src/cli/commands/shield.ts
 */

import { CliExitCode, type ShieldCommandOptions, type CliContext, type CliResult } from "../types.ts";
import { parseTokenAmount, safeJsonStringify } from "../parser.ts";
import { resolveTokenArg } from "../context.ts";
import { executeShield } from "../../actions/shield.ts";

export async function executeShieldCommand(options: ShieldCommandOptions, context: CliContext): Promise<CliResult> {
  if (!options.amount) {
    return { exitCode: CliExitCode.USAGE_ERROR, stdout: "", stderr: "ERROR: --amount is required" };
  }
  try {
    const decimals = context.token?.decimals ?? 18;
    const amount = parseTokenAmount(options.amount, decimals);
    const token = options.token ? resolveTokenArg(options.token, context) : undefined;
    const r = executeShield(context, { amount, token, depositor: options.depositor, wrapNative: options.wrap });
    if (options.json) {
      return { exitCode: CliExitCode.SUCCESS, stdout: safeJsonStringify({ status: "CONFIRMED", ...r }), stderr: "" };
    }
    return {
      exitCode: CliExitCode.SUCCESS,
      stdout: [
        "SHIELD CONFIRMED",
        `Amount:      ${r.amount} ${r.symbol}${r.wrapped ? " (wrapped from native QUAI)" : ""}`,
        `Depositor:   ${r.depositor}`,
        `Commitment:  ${r.commitment}`,
        `Leaf index:  ${r.leafIndex}`,
        `TX hash:     ${r.txHash}`,
        `Block:       ${r.blockNumber}`
      ].join("\n"),
      stderr: ""
    };
  } catch (err: any) {
    return { exitCode: CliExitCode.EXECUTION_ERROR, stdout: "", stderr: `ERROR: ${err.message}` };
  }
}
