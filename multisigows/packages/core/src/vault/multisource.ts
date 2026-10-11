import { FactoryAuthenticityError, UnknownVaultCodeError, VaultDeployment, VerifiedVault, assertVaultAuthentic } from './authenticity.js';
import { VaultStateMismatchError, VaultTransaction, readVaultTransaction } from './reader.js';
import { RpcLike, readBlockNumber } from './rpc.js';

/**
 * Security-relevant reads (owners, threshold, delay, transaction contents) come from at
 * least two independent nodes where possible: the app's configured RPC first, then the
 * user's wallet (which talks to its own node) or a second RPC. They are compared at one
 * common block. A disagreement blocks every write; a missing second source is reported so
 * the UI can show reduced assurance instead of a green state.
 */
export interface ReadSource {
  name: string;
  rpc: RpcLike;
}

export type AgreementStatus = 'agreed' | 'single-source' | 'disagreement';

export interface SourceReport {
  source: string;
  head: bigint | null;
  /** 'ok' = read and matched the primary; 'mismatch' = read but differed; 'lagging'/'unavailable' = not compared. */
  outcome: 'ok' | 'mismatch' | 'lagging' | 'unavailable';
  detail?: string;
}

export interface AgreedRead<T> {
  status: AgreementStatus;
  block: bigint;
  /** The primary source's value; only trust it for writes when status !== 'disagreement'. */
  value: T;
  reports: SourceReport[];
  problems: string[];
}

export class SourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

/** Errors that mean "this source says something different", as opposed to "this source is down". */
function isContentError(err: unknown): boolean {
  return err instanceof UnknownVaultCodeError || err instanceof VaultStateMismatchError || err instanceof FactoryAuthenticityError;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : typeof v === 'string' ? v.toLowerCase() : v));
}

/**
 * Runs `read` on every source at one common block and compares the results with the first
 * (primary) source. The block is the lowest head among sources no more than `maxLagBlocks`
 * behind the highest, so every compared source has that block.
 */
export async function readAcrossSources<T>(
  sources: readonly ReadSource[],
  read: (rpc: RpcLike, block: bigint) => Promise<T>,
  opts: { maxLagBlocks?: number; describe?: string; atBlock?: bigint } = {}
): Promise<AgreedRead<T>> {
  if (sources.length === 0) throw new SourceUnavailableError('No RPC source configured.');
  const maxLag = BigInt(opts.maxLagBlocks ?? 64);
  const what = opts.describe ?? 'state';

  const heads = await Promise.all(sources.map((s) => readBlockNumber(s.rpc).catch(() => null)));
  if (heads[0] === null) throw new SourceUnavailableError(`${sources[0]!.name} is not responding.`);
  const highest = heads.reduce<bigint>((m, h) => (h !== null && h > m ? h : m), 0n);
  // With atBlock (e.g. a watcher reading at a confirmed depth), every source must have reached it.
  const usable = heads.map((h) => h !== null && (opts.atBlock !== undefined ? h >= opts.atBlock : highest - h <= maxLag));
  if (!usable[0]) {
    throw new SourceUnavailableError(
      opts.atBlock !== undefined
        ? `${sources[0]!.name} has not reached block ${opts.atBlock}.`
        : `${sources[0]!.name} is ${highest - heads[0]!} blocks behind another source.`
    );
  }
  const block = opts.atBlock ?? heads.reduce<bigint>((m, h, i) => (usable[i] && h! < m ? h! : m), heads[0]!);

  const results = await Promise.all(
    sources.map((s, i) => (usable[i] ? read(s.rpc, block).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e })) : null))
  );
  const primary = results[0]!;
  if (!primary.ok) throw primary.e;
  const reference = canonical(primary.v);

  const reports: SourceReport[] = [{ source: sources[0]!.name, head: heads[0]!, outcome: 'ok' }];
  const problems: string[] = [];
  let compared = 0;
  let disagreement = false;
  for (let i = 1; i < sources.length; i++) {
    const name = sources[i]!.name;
    const r = results[i];
    if (heads[i] === null) {
      reports.push({ source: name, head: null, outcome: 'unavailable', detail: 'not responding' });
      problems.push(`${name} is not responding, so ${what} was read from one source only.`);
    } else if (!usable[i]) {
      const behind = opts.atBlock !== undefined ? `has not reached block ${opts.atBlock}` : `is ${highest - heads[i]!} blocks behind`;
      reports.push({ source: name, head: heads[i]!, outcome: 'lagging', detail: behind });
      problems.push(`${name} ${behind}, so it was not compared.`);
    } else if (r && r.ok) {
      compared++;
      if (canonical(r.v) === reference) {
        reports.push({ source: name, head: heads[i]!, outcome: 'ok' });
      } else {
        disagreement = true;
        reports.push({ source: name, head: heads[i]!, outcome: 'mismatch', detail: `reports different ${what}` });
        problems.push(`${name} reports different ${what} than ${sources[0]!.name} at block ${block}.`);
      }
    } else if (r && !r.ok && isContentError(r.e)) {
      compared++;
      disagreement = true;
      reports.push({ source: name, head: heads[i]!, outcome: 'mismatch', detail: (r.e as Error).message });
      problems.push(`${name} disagrees: ${(r.e as Error).message}`);
    } else {
      const msg = r && !r.ok ? ((r.e as Error)?.message ?? String(r.e)) : 'no result';
      reports.push({ source: name, head: heads[i]!, outcome: 'unavailable', detail: msg });
      problems.push(`${name} could not read ${what} (${msg}).`);
    }
  }
  const status: AgreementStatus = disagreement ? 'disagreement' : compared > 0 ? 'agreed' : 'single-source';
  return { status, block, value: primary.v, reports, problems };
}

export function readVaultAcrossSources(
  sources: readonly ReadSource[],
  address: string,
  deployment: VaultDeployment,
  opts: { maxLagBlocks?: number; atBlock?: bigint } = {}
): Promise<AgreedRead<VerifiedVault>> {
  return readAcrossSources(sources, (rpc, block) => assertVaultAuthentic(rpc, address, deployment, block), { ...opts, describe: 'vault state' });
}

export function readTransactionAcrossSources(
  sources: readonly ReadSource[],
  vault: string,
  hash: string,
  nonce: number,
  opts: { maxLagBlocks?: number } = {}
): Promise<AgreedRead<VaultTransaction>> {
  return readAcrossSources(sources, (rpc, block) => readVaultTransaction(rpc, vault, hash, nonce, block), { ...opts, describe: 'transaction contents' });
}
