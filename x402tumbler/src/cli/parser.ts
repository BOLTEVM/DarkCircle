/**
 * DarkCircle Protocol: CLI Zero-Dependency Argument Parser
 * File: src/cli/parser.ts
 *
 * Uses Node built-in `node:util parseArgs`.
 */

import { parseArgs } from "node:util";
import type {
  PayCommandOptions,
  InvoiceCommandOptions,
  SweepCommandOptions,
  AuditCommandOptions,
  BalanceCommandOptions,
  ShieldCommandOptions,
  ChecklistCommandOptions
} from "./types.ts";

/**
 * Safely stringifies objects containing BigInt values.
 */
export function safeJsonStringify(obj: any, indent: number = 2): string {
  return JSON.stringify(
    obj,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    indent
  );
}

/**
 * Parses a CLI amount into base units. The previous parser read a plain integer as BASE units, so
 * `--amount 5` paid 5 units (5e-18 of a token) while `--amount 5.0` paid five tokens. Amounts are now
 * always token amounts: "5" and "5.0" both mean five tokens; base units must be written with an
 * explicit `u` suffix ("5000000000000000000u"). More fractional digits than the token has, negative
 * numbers and anything else are rejected instead of being truncated or guessed.
 */
export function parseTokenAmount(val: string, decimals: number = 18): bigint {
  const clean = String(val).trim();
  if (/^\d+u$/i.test(clean)) {
    return BigInt(clean.slice(0, -1));
  }
  if (!/^\d+(\.\d+)?$/.test(clean)) {
    throw new Error(`ERR_AMOUNT_INVALID: '${val}' is not a token amount (use e.g. 5 or 5.25; base units need a 'u' suffix)`);
  }
  const [whole, frac = ""] = clean.split(".");
  if (frac.length > decimals) {
    throw new Error(`ERR_AMOUNT_INVALID: '${val}' has more than ${decimals} fractional digits`);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/**
 * Sanitizes an option value expected to be a string.
 * Strips out boolean values (caused by parseArgs with strict: false when flag has no argument),
 * whitespace-only strings, and flag-like values starting with '-' (indicating swallowed flags).
 */
export function sanitizeStringOption(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const trimmed = val.trim();
  if (trimmed === "" || trimmed === "true" || trimmed === "false" || trimmed.startsWith("-")) {
    return undefined;
  }
  return trimmed;
}

/**
 * Sanitizes an option value expected to be a numeric string or number.
 * Prevents boolean true from coercing to 1 via Number(true).
 */
export function sanitizeNumberOption(val: unknown): number | undefined {
  if (typeof val === "number" && !isNaN(val)) return val;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed !== "" && trimmed !== "true" && trimmed !== "false" && !trimmed.startsWith("-")) {
      const num = Number(trimmed);
      if (!isNaN(num)) return num;
    }
  }
  return undefined;
}

/**
 * Checks if a token is a CLI flag (starts with --letter or -letter, excluding negative numbers).
 */
export function isFlagToken(str: string): boolean {
  return /^--[a-zA-Z]|^-[a-zA-Z]/.test(str);
}

/**
 * Normalizes command line arguments to prevent options from swallowing adjacent flags.
 * If an option flag (e.g. --token, -t) is immediately followed by another flag
 * (e.g. --json) or appears at the end of args without an attached value,
 * it ensures the flag is normalized (e.g. --token=true) so parseArgs does not
 * consume the subsequent flag as its value.
 */
export function normalizeArgs(args: string[], knownBooleanFlags: Set<string> = new Set()): string[] {
  const normalized: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const current = args[i];

    if (!isFlagToken(current) || current.includes("=")) {
      normalized.push(current);
      continue;
    }

    const flagName = current.replace(/^-+/, "");

    if (knownBooleanFlags.has(flagName)) {
      normalized.push(current);
      continue;
    }

    const next = args[i + 1];
    if (!next || isFlagToken(next)) {
      normalized.push(`${current}=true`);
    } else {
      normalized.push(current);
    }
  }
  return normalized;
}

export interface ParsedGlobalArgs {
  command?: string;
  subcommandArgs: string[];
  help: boolean;
  version: boolean;
}

/**
 * Parses top-level command routing and global flags (--help, --version).
 */
export function parseGlobalArgs(args: string[]): ParsedGlobalArgs {
  if (!args || args.length === 0) {
    return { subcommandArgs: [], help: true, version: false };
  }

  const firstArg = args[0];

  if (firstArg === "--help" || firstArg === "-h") {
    return { subcommandArgs: [], help: true, version: false };
  }

  if (firstArg === "--version" || firstArg === "-v") {
    return { subcommandArgs: [], help: false, version: true };
  }

  if (firstArg === "help") {
    const targetCommand = args[1];
    return {
      command: targetCommand || "help",
      subcommandArgs: targetCommand ? ["--help"] : [],
      help: true,
      version: false
    };
  }

  return {
    command: firstArg,
    subcommandArgs: args.slice(1),
    help: false,
    version: false
  };
}

/**
 * Parses pay command options.
 */
export function parsePayArgs(args: string[]): PayCommandOptions {
  const normalizedArgs = normalizeArgs(args, new Set(["direct", "json"]));
  const { values, positionals } = parseArgs({
    args: normalizedArgs,
    options: {
      url: { type: "string" },
      recipient: { type: "string", short: "r" },
      amount: { type: "string", short: "a" },
      token: { type: "string", short: "t" },
      direct: { type: "boolean" },
      json: { type: "boolean" },
      output: { type: "string", short: "o" },
      "max-cap": { type: "string" },
      "invoice-id": { type: "string" }
    },
    allowPositionals: true,
    strict: false
  });

  let url = sanitizeStringOption(values.url);
  let recipient = sanitizeStringOption(values.recipient);
  let amount = sanitizeStringOption(values.amount);

  // Check positionals
  if (positionals.length > 0) {
    const pos0 = positionals[0];
    if (pos0.startsWith("http://") || pos0.startsWith("https://")) {
      if (!url) url = pos0;
    } else if (pos0.startsWith("0x")) {
      if (!recipient) recipient = pos0;
      if (positionals.length > 1 && !amount && !positionals[1].startsWith("-")) {
        amount = sanitizeStringOption(positionals[1]);
      }
    }
  }

  return {
    url,
    recipient,
    amount,
    token: sanitizeStringOption(values.token),
    direct: values.direct as boolean | undefined,
    json: values.json as boolean | undefined,
    output: sanitizeStringOption(values.output),
    maxCap: sanitizeStringOption(values["max-cap"]),
    invoiceId: sanitizeStringOption(values["invoice-id"])
  };
}

/**
 * Parses invoice command options.
 */
export function parseInvoiceArgs(args: string[]): InvoiceCommandOptions {
  const normalizedArgs = normalizeArgs(args, new Set(["json"]));
  const { values, positionals } = parseArgs({
    args: normalizedArgs,
    options: {
      amount: { type: "string", short: "a" },
      token: { type: "string", short: "t" },
      symbol: { type: "string", short: "s" },
      decimals: { type: "string", short: "d" },
      resource: { type: "string" },
      ttl: { type: "string" },
      "derivation-mode": { type: "string" },
      "merchant-key": { type: "string", short: "k" },
      json: { type: "boolean" },
      output: { type: "string", short: "o" }
    },
    allowPositionals: true,
    strict: false
  });

  let amount = sanitizeStringOption(values.amount) || "";
  if (!amount && positionals.length > 0 && !positionals[0].startsWith("-")) {
    amount = sanitizeStringOption(positionals[0]) || "";
  }

  return {
    amount,
    token: sanitizeStringOption(values.token),
    symbol: sanitizeStringOption(values.symbol),
    decimals: sanitizeNumberOption(values.decimals),
    resource: sanitizeStringOption(values.resource),
    ttl: sanitizeNumberOption(values.ttl),
    derivationMode: sanitizeStringOption(values["derivation-mode"]) as "fast" | "secp256k1" | undefined,
    merchantKey: sanitizeStringOption(values["merchant-key"]),
    json: values.json as boolean | undefined,
    output: sanitizeStringOption(values.output)
  };
}

/**
 * Parses sweep command options.
 */
export function parseSweepArgs(args: string[]): SweepCommandOptions {
  const normalizedArgs = normalizeArgs(args, new Set(["all", "json"]));
  const { values, positionals } = parseArgs({
    args: normalizedArgs,
    options: {
      invoice: { type: "string", short: "i" },
      all: { type: "boolean" },
      threshold: { type: "string" },
      address: { type: "string", short: "a" },
      "private-key": { type: "string", short: "k" },
      token: { type: "string", short: "t" },
      json: { type: "boolean" },
      output: { type: "string", short: "o" }
    },
    allowPositionals: true,
    strict: false
  });

  let invoice = sanitizeStringOption(values.invoice);
  if (!invoice && positionals.length > 0 && !values.all && !positionals[0].startsWith("-")) {
    invoice = sanitizeStringOption(positionals[0]);
  }

  return {
    invoice,
    all: values.all as boolean | undefined,
    threshold: sanitizeStringOption(values.threshold),
    address: sanitizeStringOption(values.address),
    privateKey: sanitizeStringOption(values["private-key"]),
    token: sanitizeStringOption(values.token),
    json: values.json as boolean | undefined,
    output: sanitizeStringOption(values.output)
  };
}

/**
 * Parses audit command options.
 */
export function parseAuditArgs(args: string[]): AuditCommandOptions {
  const normalizedArgs = normalizeArgs(args, new Set(["json", "csv", "reconcile"]));
  const { values, positionals } = parseArgs({
    args: normalizedArgs,
    options: {
      "viewing-key": { type: "string", short: "k" },
      format: { type: "string", short: "f" },
      json: { type: "boolean" },
      csv: { type: "boolean" },
      output: { type: "string", short: "o" },
      entity: { type: "string", short: "e" },
      "from-date": { type: "string" },
      "to-date": { type: "string" },
      token: { type: "string", short: "t" },
      counterparty: { type: "string", short: "c" },
      direction: { type: "string", short: "d" },
      verify: { type: "string" },
      reconcile: { type: "boolean" }
    },
    allowPositionals: true,
    strict: false
  });

  let verify = values.verify as string | boolean | undefined;
  if (typeof verify === "string") {
    const trimmed = verify.trim();
    if (trimmed === "" || trimmed === "true") {
      verify = true;
    } else if (trimmed.startsWith("-")) {
      const flagName = trimmed.replace(/^-+/, "");
      if (flagName === "reconcile") values.reconcile = true;
      if (flagName === "json") values.json = true;
      if (flagName === "csv") values.csv = true;
      verify = true;
    } else {
      verify = trimmed;
    }
  }

  if (verify === true && positionals.length > 0 && !positionals[0].startsWith("-")) {
    verify = positionals[0];
  }

  return {
    viewingKey: sanitizeStringOption(values["viewing-key"]),
    format: sanitizeStringOption(values.format) as "json" | "csv" | undefined,
    json: values.json as boolean | undefined,
    csv: values.csv as boolean | undefined,
    output: sanitizeStringOption(values.output),
    entity: sanitizeStringOption(values.entity),
    fromDate: sanitizeStringOption(values["from-date"]),
    toDate: sanitizeStringOption(values["to-date"]),
    token: sanitizeStringOption(values.token),
    counterparty: sanitizeStringOption(values.counterparty),
    direction: sanitizeStringOption(values.direction),
    verify,
    reconcile: values.reconcile as boolean | undefined
  };
}

/**
 * Parses balance command options.
 */
export function parseBalanceArgs(args: string[]): BalanceCommandOptions {
  const normalizedArgs = normalizeArgs(args, new Set(["json"]));
  const { values, positionals } = parseArgs({
    args: normalizedArgs,
    options: {
      address: { type: "string", short: "a" },
      token: { type: "string", short: "t" },
      "viewing-key": { type: "string", short: "k" },
      json: { type: "boolean" },
      output: { type: "string", short: "o" }
    },
    allowPositionals: true,
    strict: false
  });

  let address = sanitizeStringOption(values.address);
  if (!address && positionals.length > 0 && !positionals[0].startsWith("-")) {
    address = sanitizeStringOption(positionals[0]);
  }

  return {
    address,
    token: sanitizeStringOption(values.token),
    viewingKey: sanitizeStringOption(values["viewing-key"]),
    json: values.json as boolean | undefined,
    output: sanitizeStringOption(values.output)
  };
}

/**
 * Parses shield command options.
 */
export function parseShieldArgs(args: string[]): ShieldCommandOptions {
  const normalizedArgs = normalizeArgs(args, new Set(["json", "wrap"]));
  const { values } = parseArgs({
    args: normalizedArgs,
    options: {
      amount: { type: "string", short: "a" },
      token: { type: "string", short: "t" },
      depositor: { type: "string" },
      wrap: { type: "boolean" },
      json: { type: "boolean" }
    },
    allowPositionals: true,
    strict: false
  });
  return {
    amount: sanitizeStringOption(values.amount),
    token: sanitizeStringOption(values.token),
    depositor: sanitizeStringOption(values.depositor),
    wrap: values.wrap as boolean | undefined,
    json: values.json as boolean | undefined
  };
}

/**
 * Parses checklist command options. The first positional is the kind.
 */
export function parseChecklistArgs(args: string[]): ChecklistCommandOptions {
  const normalizedArgs = normalizeArgs(args, new Set(["json", "wrap"]));
  const { values, positionals } = parseArgs({
    args: normalizedArgs,
    options: {
      address: { type: "string" },
      amount: { type: "string", short: "a" },
      token: { type: "string", short: "t" },
      invoice: { type: "string" },
      wrap: { type: "boolean" },
      json: { type: "boolean" }
    },
    allowPositionals: true,
    strict: false
  });
  return {
    kind: positionals[0],
    address: sanitizeStringOption(values.address),
    amount: sanitizeStringOption(values.amount),
    token: sanitizeStringOption(values.token),
    invoice: sanitizeStringOption(values.invoice),
    wrap: values.wrap as boolean | undefined,
    json: values.json as boolean | undefined
  };
}
