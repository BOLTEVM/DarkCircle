/**
 * DarkCircle Protocol: CLI Balance Command
 * File: src/cli/commands/balance.ts
 */

import fs from "node:fs";
import path from "node:path";
import { formatDecimals } from "../../audit/exporter.ts";
import { DEFAULT_OPERATING_ADDRESS } from "../context.ts";
import { CliExitCode, type BalanceCommandOptions, type CliContext, type CliResult } from "../types.ts";

export async function executeBalanceCommand(
  options: BalanceCommandOptions,
  context: CliContext
): Promise<CliResult> {
  const decimals = context.token?.decimals ?? 18;
  const tokenSymbol = context.token?.symbol ?? "WQUAI";

  // 1. Calculate Shielded Treasury Balances
  let totalShieldedAtomic = 0n;
  const activeUTXOs = context.treasuryUTXOs.filter((u) => u.value > 0n);
  for (const u of activeUTXOs) {
    totalShieldedAtomic += u.value;
  }
  const formattedShielded = formatDecimals(totalShieldedAtomic, decimals);

  // 2. Query Public On-Chain Accounts
  const opAddr = context.corporateOperatingAddress || DEFAULT_OPERATING_ADDRESS;
  const opTokenBal = context.token ? context.token.balanceOf(opAddr) : 0n;
  const opNativeBal = context.blockchain.getOrCreateAccount(opAddr).nativeBalance;

  const relayerAddr = context.relayer.relayerAddress;
  const relayerTokenBal = context.token ? context.token.balanceOf(relayerAddr) : 0n;

  let queryAccount: { address: string; tokenBalance: bigint; nativeBalance: bigint } | undefined;
  const queryAddr =
    typeof options.address === "string" &&
    options.address.trim() !== "" &&
    options.address !== "true" &&
    !options.address.startsWith("-")
      ? options.address.trim()
      : undefined;

  if (queryAddr) {
    const qTokenBal = context.token ? context.token.balanceOf(queryAddr) : 0n;
    const qNativeBal = context.blockchain.getOrCreateAccount(queryAddr).nativeBalance;
    queryAccount = {
      address: queryAddr,
      tokenBalance: qTokenBal,
      nativeBalance: qNativeBal
    };
  }

  // 3. Build Result Data
  const data = {
    shieldedTreasury: {
      corporate0zkAddress: context.corporateKeys.corporate0zkAddress,
      activeUtxos: activeUTXOs.length,
      totalAtomic: totalShieldedAtomic.toString(),
      formatted: formattedShielded,
      assetSymbol: tokenSymbol
    },
    publicAccounts: {
      corporateOperating: {
        address: opAddr,
        tokenBalanceAtomic: opTokenBal.toString(),
        tokenBalanceFormatted: formatDecimals(opTokenBal, decimals),
        nativeBalanceWei: opNativeBal.toString(),
        nativeBalanceEth: (Number(opNativeBal) / 1e18).toFixed(4)
      },
      relayer: {
        address: relayerAddr,
        tokenBalanceAtomic: relayerTokenBal.toString(),
        tokenBalanceFormatted: formatDecimals(relayerTokenBal, decimals)
      },
      ...(queryAccount && {
        queriedAccount: {
          address: queryAccount.address,
          tokenBalanceAtomic: queryAccount.tokenBalance.toString(),
          tokenBalanceFormatted: formatDecimals(queryAccount.tokenBalance, decimals),
          nativeBalanceWei: queryAccount.nativeBalance.toString(),
          nativeBalanceEth: (Number(queryAccount.nativeBalance) / 1e18).toFixed(4)
        }
      })
    }
  };

  // 4. Format Output String
  let outputString: string;
  if (options.json) {
    outputString = JSON.stringify(data, null, 2);
  } else {
    const lines = [
      "═══════════════════════════════════════════════════════════════",
      "DARKCIRCLE TREASURY & ACCOUNT BALANCES",
      "═══════════════════════════════════════════════════════════════",
      "SHIELDED CORPORATE TREASURY (0zk)",
      `  0zk Address:       ${data.shieldedTreasury.corporate0zkAddress}`,
      `  Active UTXO Notes: ${data.shieldedTreasury.activeUtxos}`,
      `  Shielded Balance:  ${data.shieldedTreasury.formatted} ${tokenSymbol} (${data.shieldedTreasury.totalAtomic} atomic)`,
      "",
      "ON-CHAIN PUBLIC ACCOUNTS",
      `  Corporate Operating Wallet: ${data.publicAccounts.corporateOperating.address}`,
      `    ${tokenSymbol} Balance:            ${data.publicAccounts.corporateOperating.tokenBalanceFormatted} ${tokenSymbol}`,
      `    ETH Balance:             ${data.publicAccounts.corporateOperating.nativeBalanceEth} ETH`,
      `  Relayer Broadcaster:        ${data.publicAccounts.relayer.address}`,
      `    ${tokenSymbol} Balance:            ${data.publicAccounts.relayer.tokenBalanceFormatted} ${tokenSymbol}`
    ];

    if (queryAccount) {
      lines.push(
        "",
        `  Queried Address:            ${queryAccount.address}`,
        `    ${tokenSymbol} Balance:            ${formatDecimals(queryAccount.tokenBalance, decimals)} ${tokenSymbol}`,
        `    ETH Balance:             ${(Number(queryAccount.nativeBalance) / 1e18).toFixed(4)} ETH`
      );
    }

    lines.push("═══════════════════════════════════════════════════════════════");
    outputString = lines.join("\n");
  }

  // 5. File Output Handling
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
        stdout: `✓ Balance output successfully written to: ${options.output}`,
        stderr: "",
        data
      };
    } catch (err: any) {
      return {
        exitCode: CliExitCode.EXECUTION_ERROR,
        stdout: "",
        stderr: `ERROR: Failed to write output file: ${err.message}`,
        data
      };
    }
  }

  return {
    exitCode: CliExitCode.SUCCESS,
    stdout: outputString,
    stderr: "",
    data
  };
}
