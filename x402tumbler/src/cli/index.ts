/**
 * DarkCircle Protocol: CLI Entrypoint & Programmatic Runner
 * File: src/cli/index.ts
 */

import { CliExitCode, type CliContext, type CliResult } from "./types.ts";
import {
  parseGlobalArgs,
  parseBalanceArgs,
  parseInvoiceArgs,
  parsePayArgs,
  parseSweepArgs,
  parseAuditArgs,
  parseShieldArgs,
  parseChecklistArgs
} from "./parser.ts";
import { createDefaultCliContext } from "./context.ts";
import {
  getHelpText,
  executeBalanceCommand,
  executeInvoiceCommand,
  executePayCommand,
  executeSweepCommand,
  executeAuditCommand,
  executeShieldCommand,
  executeChecklistCommand
} from "./commands/index.ts";

export * from "./types.ts";
export * from "./parser.ts";
export * from "./context.ts";
export * from "./commands/index.ts";

/**
 * Executes a DarkCircle CLI command programmatically.
 */
export async function runCli(
  args: string[],
  context?: CliContext
): Promise<CliResult> {
  const globalParsed = parseGlobalArgs(args);

  // 1. Version flag
  if (globalParsed.version) {
    return {
      exitCode: CliExitCode.SUCCESS,
      stdout: "DarkCircle v1.0.0",
      stderr: ""
    };
  }

  // 2. Top-level help flag or empty arguments
  if (globalParsed.help && !globalParsed.command) {
    return {
      exitCode: CliExitCode.SUCCESS,
      stdout: getHelpText(),
      stderr: ""
    };
  }

  const command = globalParsed.command?.toLowerCase();
  const subArgs = globalParsed.subcommandArgs;

  // 3. Command-specific help
  if (command === "help") {
    const target = subArgs[0] || undefined;
    return {
      exitCode: CliExitCode.SUCCESS,
      stdout: getHelpText(target),
      stderr: ""
    };
  }

  if (subArgs.includes("--help") || subArgs.includes("-h")) {
    return {
      exitCode: CliExitCode.SUCCESS,
      stdout: getHelpText(command),
      stderr: ""
    };
  }

  // 4. Initialize Execution Context
  // DARKCIRCLE_ASSET=WQI settles the simulated treasury in Wrapped Qi instead of the WQUAI default.
  const ctx = context || createDefaultCliContext({ asset: process.env.DARKCIRCLE_ASSET || undefined });

  // 5. Route to Subcommand Handler
  switch (command) {
    case "balance": {
      const options = parseBalanceArgs(subArgs);
      return executeBalanceCommand(options, ctx);
    }

    case "invoice": {
      const options = parseInvoiceArgs(subArgs);
      return executeInvoiceCommand(options, ctx);
    }

    case "pay": {
      const options = parsePayArgs(subArgs);
      return executePayCommand(options, ctx);
    }

    case "sweep": {
      const options = parseSweepArgs(subArgs);
      return executeSweepCommand(options, ctx);
    }

    case "shield": {
      return executeShieldCommand(parseShieldArgs(subArgs), ctx);
    }

    case "checklist": {
      return executeChecklistCommand(parseChecklistArgs(subArgs), ctx);
    }

    case "audit": {
      const options = parseAuditArgs(subArgs);
      return executeAuditCommand(options, ctx);
    }

    default: {
      return {
        exitCode: CliExitCode.USAGE_ERROR,
        stdout: "",
        stderr: `ERROR: Unknown command '${globalParsed.command}'. Run 'darkcircle --help' for available commands.`
      };
    }
  }
}
