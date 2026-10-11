/**
 * DarkCircle Protocol: CLI Checklist Command
 * File: src/cli/commands/checklist.ts
 */

import { CliExitCode, type ChecklistCommandOptions, type CliContext, type CliResult } from "../types.ts";
import { safeJsonStringify } from "../parser.ts";
import { runChecklist, type ChecklistKind } from "../../checklist/shieldedTx.ts";

const KINDS: ChecklistKind[] = ["shield", "unshield", "receive", "sweep", "audit"];
const MARK: Record<string, string> = { pass: "PASS", fail: "FAIL", warn: "WARN", info: "INFO" };

export async function executeChecklistCommand(options: ChecklistCommandOptions, context: CliContext): Promise<CliResult> {
  const kind = (options.kind === "pay" ? "unshield" : options.kind) as ChecklistKind;
  if (!kind || !KINDS.includes(kind)) {
    return { exitCode: CliExitCode.USAGE_ERROR, stdout: "", stderr: `ERROR: checklist kind must be one of ${KINDS.join(", ")}` };
  }
  const result = runChecklist(
    kind,
    { address: options.address, amount: options.amount, token: options.token, invoiceId: options.invoice, wrapNative: options.wrap },
    context
  );
  const exitCode = result.canProceed ? CliExitCode.SUCCESS : CliExitCode.EXECUTION_ERROR;
  if (options.json) {
    return { exitCode, stdout: safeJsonStringify(result), stderr: "" };
  }
  const lines = [`Shielded transaction checklist: ${kind}`];
  let group = "";
  for (const item of result.items) {
    if (item.group !== group) {
      group = item.group;
      lines.push("", group.toUpperCase());
    }
    lines.push(`  [${MARK[item.status]}] ${item.id}  ${item.title}: ${item.detail}`);
  }
  lines.push("", result.canProceed ? `Ready (${result.warnings} warning(s) to acknowledge).` : `BLOCKED by ${result.blockers} failing check(s).`);
  return { exitCode, stdout: lines.join("\n"), stderr: "" };
}
