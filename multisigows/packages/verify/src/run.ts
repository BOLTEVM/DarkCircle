import { formatUnits } from 'ethers';
import {
  RpcLike,
  ReadSource,
  VaultDeployment,
  getNetworkConfig,
  verifyFactory,
  resolveDeployment,
  readVaultAcrossSources,
  verifyVaultTransaction,
  describeRisk,
  summarizeCall,
  assessVaultConfig,
  groupAddress,
  formatDuration,
  formatUtc,
  isCyprus1QuaiAddress,
} from '@safebuddy/core';

/**
 * safebuddy-verify: checks a SafeBuddy v2 factory, vault or transaction straight from the
 * chain, independently of the web app. Owners use it to confirm what they are approving
 * when they do not trust (or cannot inspect) the UI in front of them.
 */

export const EXIT = { OK: 0, FAILED: 1, DISAGREEMENT: 2, USAGE: 64 } as const;

export interface VerifyDeps {
  makeRpc(url: string): RpcLike;
  write(line: string): void;
}

const USAGE = `Usage:
  safebuddy-verify factory <address>          check a factory against the pinned build
  safebuddy-verify vault <address>            check a vault and print its governance state
  safebuddy-verify tx <vault> <txHash>        check a transaction and print what it does

Options:
  --network testnet|mainnet   default testnet (Orchard)
  --rpc <url>                 repeat to cross-check several nodes (default: the network's public RPC)
  --factory <address>         factory to trust instead of the recorded deployment (still verified)
  --chain-id <n>              for private test networks only; requires --rpc
  --json                      machine-readable output

Exit codes: 0 verified, 1 verification failed, 2 sources disagree, 64 usage error.`;

interface Options {
  command: string;
  args: string[];
  network: 'mainnet' | 'testnet';
  rpcs: string[];
  factory: string | null;
  chainId: number | null;
  json: boolean;
}

function parse(argv: string[]): Options | string {
  const o: Options = { command: '', args: [], network: 'testnet', rpcs: [], factory: null, chainId: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') continue; // pnpm forwards a bare -- separator
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    try {
      if (a === '--help' || a === '-h') return USAGE;
      else if (a === '--json') o.json = true;
      else if (a === '--network') {
        const n = value();
        if (n !== 'mainnet' && n !== 'testnet' && n !== 'orchard') return `Unknown network ${n}.\n\n${USAGE}`;
        o.network = n === 'mainnet' ? 'mainnet' : 'testnet';
      } else if (a === '--rpc') o.rpcs.push(value());
      else if (a === '--factory') o.factory = value();
      else if (a === '--chain-id') o.chainId = Number(value());
      else if (a.startsWith('--')) return `Unknown option ${a}.\n\n${USAGE}`;
      else if (!o.command) o.command = a;
      else o.args.push(a);
    } catch (err: any) {
      return `${err.message}.\n\n${USAGE}`;
    }
  }
  const need = { factory: 1, vault: 1, tx: 2 }[o.command];
  if (need === undefined) return USAGE;
  if (o.args.length !== need) return `${o.command} takes ${need} argument(s).\n\n${USAGE}`;
  if (o.chainId !== null && (!Number.isInteger(o.chainId) || o.rpcs.length === 0)) return `--chain-id needs a whole number and an explicit --rpc.\n\n${USAGE}`;
  return o;
}

export async function runVerify(argv: string[], deps: VerifyDeps): Promise<number> {
  const parsed = parse(argv);
  if (typeof parsed === 'string') {
    deps.write(parsed);
    return parsed === USAGE && argv.some((a) => a === '--help' || a === '-h') ? EXIT.OK : EXIT.USAGE;
  }
  const o = parsed;
  const network = getNetworkConfig(o.network);
  const chainId = o.chainId ?? network.chainId;
  const urls = o.rpcs.length ? o.rpcs : [network.rpcUrl];
  const sources: ReadSource[] = urls.map((url, i) => ({ name: urls.length > 1 ? `rpc${i + 1} (${url})` : url, rpc: deps.makeRpc(url) }));
  const primary = sources[0]!.rpc;
  const lines: string[] = [];
  const say = (line: string) => lines.push(line);
  const report: Record<string, unknown> = { command: o.command, chainId };
  const finish = (code: number) => {
    if (o.json) deps.write(JSON.stringify({ ...report, exitCode: code }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    else lines.forEach((l) => deps.write(l));
    return code;
  };

  try {
    // Hashes commit to the chain id, so every source must be on the chain we verify for.
    for (const s of sources) {
      const reported = parseInt(String(await s.rpc.rawRequest('quai_chainId', [])), 16);
      if (reported !== chainId) {
        say(`✘ ${s.name} is on chain ${reported}, not ${chainId}`);
        report.error = `chain mismatch on ${s.name}`;
        return finish(EXIT.FAILED);
      }
    }

    if (o.command === 'factory') {
      const f = await verifyFactory(primary, o.args[0]!);
      say(`✔ ${f.factory} is a genuine SafeBuddy v2 factory`);
      say(`  implementation ${f.implementation} (pinned vault code)`);
      report.factory = f;
      return finish(EXIT.OK);
    }

    const deployment: VaultDeployment = await resolveDeployment(primary, chainId, o.factory);
    say(`✔ factory ${deployment.factory} matches the pinned build (${deployment.source === 'recorded' ? 'recorded deployment' : 'given with --factory'})`);
    say(`  implementation ${deployment.implementation}`);
    report.deployment = deployment;

    if (o.command === 'vault') {
      const read = await readVaultAcrossSources(sources, o.args[0]!, deployment);
      const { snapshot } = read.value;
      report.vault = { address: read.value.address, codeHash: read.value.codeHash, ...snapshot };
      report.agreement = read.status;
      report.problems = read.problems;
      say(`✔ ${read.value.address} runs the pinned SafeBuddyVaultProxy code, points at the implementation, and was created by the factory`);
      say(agreementLine(read.status, read.block, read.reports.filter((r) => r.outcome === 'ok').length));
      read.problems.forEach((p) => say(`  ${p}`));
      say(`owners (${snapshot.owners.length}):`);
      snapshot.owners.forEach((a) => say(`  ${groupAddress(a)}${isCyprus1QuaiAddress(a) ? '' : '   <- not a Quai-ledger account'}`));
      say(`approvals needed: ${snapshot.threshold} of ${snapshot.owners.length}`);
      say(`timelock: ${snapshot.minExecutionDelay ? formatDuration(snapshot.minExecutionDelay) : 'none'}`);
      say(`transactions proposed: ${snapshot.txNonce}`);
      say(`balance: ${formatUnits(snapshot.balance, 18)} QUAI`);
      const grade = assessVaultConfig(snapshot.owners.length, snapshot.threshold, snapshot.minExecutionDelay);
      say(`configuration grade: ${grade.grade}`);
      grade.notes.forEach((n) => say(`  ${n}`));
      return finish(read.status === 'disagreement' ? EXIT.DISAGREEMENT : EXIT.OK);
    }

    // tx
    const review = await verifyVaultTransaction({ sources, address: o.args[0]!, deployment, chainId, hash: o.args[1]! });
    const { tx, decoded, vault } = review;
    const risks = describeRisk(decoded, {
      vault: vault.address,
      owners: vault.snapshot.owners,
      threshold: vault.snapshot.threshold,
      minExecutionDelay: vault.snapshot.minExecutionDelay,
      balance: vault.snapshot.balance,
    });
    report.transaction = tx;
    report.decoded = decoded;
    report.risks = risks;
    report.digest = review.digestDisplay;
    report.agreement = review.agreement;
    report.problems = review.problems;
    say(`✔ vault ${vault.address} is genuine`);
    say(`✔ transaction ${tx.hash} re-derives from its stored contents (position ${tx.nonce})`);
    say(agreementLine(review.agreement, review.block, review.reports.filter((r) => r.outcome === 'ok').length));
    review.problems.forEach((p) => say(`  ${p}`));
    say(`what it does: ${summarizeCall(decoded)}`);
    say(`destination: ${groupAddress(tx.to)}${tx.to.toLowerCase() === vault.address.toLowerCase() ? '  (the vault itself: an admin change)' : ''}`);
    say(`QUAI sent: ${formatUnits(tx.value, 18)} (${tx.value} wei)`);
    say(`calldata: ${tx.data}`);
    if (tx.to.toLowerCase() !== vault.address.toLowerCase()) say(`gas committed to the call: ${tx.gasLimit}`);
    say(`timelock after quorum: ${tx.executionDelay ? formatDuration(tx.executionDelay) : 'none'}`);
    say(`expires: ${formatUtc(tx.expiration)}`);
    say(`status: ${tx.status}; approvals ${tx.approvals.length} of ${vault.snapshot.threshold}`);
    tx.approvals.forEach((a) => say(`  approved by ${a}`));
    if (risks.length) say('risks:');
    risks.forEach((r) => say(`  ${r.level.toUpperCase()} ${r.message}`));
    say(`review digest: ${review.digestDisplay}   (must match what the app shows)`);
    return finish(review.agreement === 'disagreement' ? EXIT.DISAGREEMENT : EXIT.OK);
  } catch (err: any) {
    say(`✘ ${err?.message ?? String(err)}`);
    report.error = err?.message ?? String(err);
    return finish(EXIT.FAILED);
  }
}

function agreementLine(status: string, block: bigint, agreeing: number): string {
  if (status === 'agreed') return `✔ ${agreeing} sources agree at block ${block}`;
  if (status === 'single-source') return `! checked against one source only (block ${block}); pass more --rpc URLs to cross-check`;
  return `✘ SOURCES DISAGREE at block ${block}: do not act on this`;
}
