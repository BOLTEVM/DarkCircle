/**
 * DarkCircle: environment snapshots
 * File: src/persistence/snapshot.ts
 *
 * captureEnvironment() turns a live multi-asset environment into one string; restoreEnvironment() builds a
 * FRESH environment from the factory, overlays the snapshot onto it in place, and only returns it if it
 * passes verifyEnvironment(). A snapshot that fails verification never touches the running state.
 *
 * What is saved: the ledger (accounts, blocks, transactions, receipts, token supply / nonces / events),
 * the compliance state (sanctions registry, quarantined notes), and per asset lane the pool (tree, spent
 * nullifiers, note registry, events), relayer settings, the invoice registry WITH the single-use payee
 * private keys, treasury notes WITH their blinding factors, the journal, the spend log and the payment caps.
 *
 * What is deliberately NOT saved: the corporate spending key and the merchant master key. They are
 * re-derived from the process's own configuration, and the snapshot records fingerprints of them so a
 * restore under a different seed is refused instead of producing notes nobody can spend.
 */

import crypto from "node:crypto";
import { Wallet } from "ethers";
import { IncrementalMerkleTree } from "../crypto/merkleTree.ts";
import { canonicalJson, decode, encode, type Encoded } from "./codec.ts";
import type { MultiAssetEnvironment } from "../cli/context.ts";
import type { CliContext } from "../cli/types.ts";

export const SNAPSHOT_SCHEMA = "darkcircle-env";
export const SNAPSHOT_VERSION = 1;
/** Above this many leaves the full tree is not rebuilt during verification; sampled paths are checked instead. */
const FULL_REBUILD_LIMIT = 4096;
const SAMPLED_PATHS = 48;

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/* ------------------------------------------------------------------ in-place replacement */

function replaceMap<K, V>(target: Map<K, V>, source: Map<K, V>): void {
  target.clear();
  for (const [k, v] of source) target.set(k, v);
}

function replaceSet<T>(target: Set<T>, source: Set<T>): void {
  target.clear();
  for (const v of source) target.add(v);
}

function replaceArray<T>(target: T[], source: T[]): void {
  target.length = 0;
  for (const v of source) target.push(v);
}

/* ------------------------------------------------------------------ capture */

function identityOf(env: MultiAssetEnvironment) {
  const keys = env.shared.corporateKeys;
  return {
    corporateFingerprint: sha256(`corporate|${keys.npk.toString(16)}|${keys.corporate0zkAddress}`),
    merchantFingerprint: sha256(`merchant|${env.shared.merchantKey}`)
  };
}

function captureLane(ctx: CliContext) {
  const pool = ctx.pool as any;
  const tree = pool.merkleTree;
  const gw = ctx.merchantGateway as any;
  const registry = gw.invoiceRegistry;
  const journal = ctx.journal as any;
  const relayer = ctx.relayer;
  return {
    pool: {
      tree: { nextIndex: tree.nextIndex, nodes: tree.nodes, historicalRoots: tree.historicalRoots, leaves: tree.leaves },
      nullifiers: pool.nullifiers,
      spentNullifiers: pool.spentNullifiers,
      spentCommitments: pool.spentCommitments,
      sanctionsNodes: pool.sanctionsSMT.nodes,
      utxoRegistry: pool.utxoRegistry,
      poolEvents: pool.poolEvents,
      standbyWindowSeconds: pool.standbyWindowSeconds
    },
    relayer: {
      relayerAddress: relayer.relayerAddress,
      minimumFee: relayer.minimumFee,
      minGasBalance: relayer.minGasBalance,
      online: relayer.online,
      offlineReason: relayer.offlineReason
    },
    gateway: { invoices: registry, usedReceipts: registry.usedReceiptRegistry },
    treasuryUTXOs: ctx.treasuryUTXOs,
    journal: journal
      ? {
          entries: journal.entries,
          utxoMap: journal.utxoMap,
          runningBalance: journal.runningBalance,
          assetAddress: journal.assetAddress,
          assetSymbol: journal.assetSymbol,
          decimals: journal.decimals,
          assetFixed: journal.assetFixed
        }
      : null,
    spendLog: ctx.spendTracker ? ctx.spendTracker.entries() : [],
    policy: {
      maxPaymentCap: ctx.spendingPolicy.maxPaymentCap,
      dailyBudgetCap: ctx.spendingPolicy.dailyBudgetCap,
      minInvoiceTtlSeconds: ctx.spendingPolicy.minInvoiceTtlSeconds
    }
  };
}

/** One string holding the whole environment. Contains private keys: only ever write it through EncryptedStore. */
export function captureEnvironment(env: MultiAssetEnvironment, now: Date = new Date()): string {
  const chain = env.shared.blockchain as any;
  const registry = env.shared.sanctionsRegistry as any;
  const engine = env.shared.ppoiEngine as any;
  const body = {
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    savedAt: now.toISOString(),
    network: { id: env.shared.blockchain.network.id, chainId: env.shared.chainId },
    assets: env.assets,
    identity: identityOf(env),
    chain: {
      currentBlockNumber: chain.currentBlockNumber,
      timeOffset: chain._currentTimeOffset,
      accounts: chain.accounts,
      blocks: chain.blocks,
      transactions: chain.transactions,
      receipts: chain.receipts,
      tokens: Object.fromEntries(
        [...env.shared.tokens].map(([symbol, t]) => {
          const tok = t as any;
          return [symbol, { totalSupply: tok._totalSupply, nonces: tok._nonces, events: tok.events }];
        })
      )
    },
    compliance: {
      sanctions: { entries: registry.entries, nodes: registry.smt.nodes, historicalRoots: registry.historicalRoots },
      quarantined: engine.quarantinedNotes
    },
    lanes: Object.fromEntries(env.assets.map((symbol) => [symbol, captureLane(env.lanes[symbol])]))
  };
  const encoded = encode(body);
  return JSON.stringify({ digest: sha256(canonicalJson(encoded)), body: encoded });
}

/* ------------------------------------------------------------------ restore */

export interface CheckResult {
  id: string;
  ok: boolean;
  /** A failed fatal check refuses the restore. */
  fatal: boolean;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  checks: CheckResult[];
}

export interface SnapshotSummary {
  savedAt: string;
  network: { id: string; chainId: number };
  assets: string[];
  lanes: Record<string, { leaves: number; notes: number; invoices: number; spentNullifiers: number; journalEntries: number }>;
  blocks: number;
}

function summarise(body: any): SnapshotSummary {
  const lanes: SnapshotSummary["lanes"] = {};
  for (const [symbol, lane] of Object.entries<any>(body.lanes)) {
    lanes[symbol] = {
      leaves: lane.pool.tree.nextIndex,
      notes: lane.treasuryUTXOs.length,
      invoices: lane.gateway.invoices.size,
      spentNullifiers: lane.pool.spentNullifiers.size,
      journalEntries: lane.journal ? lane.journal.entries.length : 0
    };
  }
  return { savedAt: body.savedAt, network: body.network, assets: body.assets, lanes, blocks: body.chain.blocks.length };
}

function overlayLane(ctx: CliContext, lane: any): void {
  const pool = ctx.pool as any;
  const tree = pool.merkleTree;
  tree.nextIndex = lane.pool.tree.nextIndex;
  replaceMap(tree.nodes, lane.pool.tree.nodes);
  replaceArray(tree.historicalRoots, lane.pool.tree.historicalRoots);
  replaceArray(tree.leaves, lane.pool.tree.leaves);
  replaceSet(pool.nullifiers, lane.pool.nullifiers);
  replaceSet(pool.spentNullifiers, lane.pool.spentNullifiers);
  replaceSet(pool.spentCommitments, lane.pool.spentCommitments);
  replaceMap(pool.sanctionsSMT.nodes, lane.pool.sanctionsNodes);
  replaceMap(pool.utxoRegistry, lane.pool.utxoRegistry);
  replaceArray(pool.poolEvents, lane.pool.poolEvents);
  pool.standbyWindowSeconds = lane.pool.standbyWindowSeconds;

  const relayer = ctx.relayer;
  relayer.setRelayerAddress(lane.relayer.relayerAddress);
  relayer.minimumFee = lane.relayer.minimumFee;
  relayer.minGasBalance = lane.relayer.minGasBalance;
  relayer.setOnline(lane.relayer.online, lane.relayer.offlineReason);

  const gw = ctx.merchantGateway as any;
  const registry = gw.invoiceRegistry;
  replaceMap(registry, lane.gateway.invoices);
  replaceSet(registry.usedReceiptRegistry, lane.gateway.usedReceipts);
  if (gw.usedReceiptRegistry && gw.usedReceiptRegistry !== registry.usedReceiptRegistry) replaceSet(gw.usedReceiptRegistry, lane.gateway.usedReceipts);

  replaceArray(ctx.treasuryUTXOs, lane.treasuryUTXOs);
  const ledger = gw.sweeper?.treasuryLedger;
  if (ledger && ledger !== ctx.treasuryUTXOs) replaceArray(ledger, lane.treasuryUTXOs);

  if (lane.journal && ctx.journal) {
    const j = ctx.journal as any;
    replaceArray(j.entries, lane.journal.entries);
    replaceMap(j.utxoMap, lane.journal.utxoMap);
    j.runningBalance = lane.journal.runningBalance;
    j.assetAddress = lane.journal.assetAddress;
    j.assetSymbol = lane.journal.assetSymbol;
    j.decimals = lane.journal.decimals;
    j.assetFixed = lane.journal.assetFixed;
  }

  ctx.spendTracker?.load(lane.spendLog);
  ctx.spendingPolicy.maxPaymentCap = lane.policy.maxPaymentCap;
  ctx.spendingPolicy.dailyBudgetCap = lane.policy.dailyBudgetCap;
  ctx.spendingPolicy.minInvoiceTtlSeconds = lane.policy.minInvoiceTtlSeconds;
}

/**
 * Integrity checks on a (restored) environment. Every fatal failure means the snapshot must not be used.
 * These run on the live objects, so they also serve as an operator's "is this state coherent" probe.
 */
export function verifyEnvironment(env: MultiAssetEnvironment): VerifyReport {
  const checks: CheckResult[] = [];
  const add = (id: string, ok: boolean, detail: string, fatal = true) => checks.push({ id, ok, fatal, detail });

  for (const symbol of env.assets) {
    const ctx = env.lanes[symbol];
    const pool = ctx.pool as any;
    const tree = pool.merkleTree;

    // R-01: the stored root is the root of the stored leaves
    let rootOk: boolean;
    let how: string;
    if (tree.leaves.length !== tree.nextIndex) {
      rootOk = false;
      how = `leaf list has ${tree.leaves.length} entries but nextIndex is ${tree.nextIndex}`;
    } else if (tree.nextIndex <= FULL_REBUILD_LIMIT) {
      const rebuilt = new IncrementalMerkleTree(tree.depth, tree.maxHistoricalRoots);
      for (const leaf of tree.leaves as bigint[]) rebuilt.insert(leaf);
      rootOk = rebuilt.root === tree.root;
      how = `rebuilt from ${tree.leaves.length} leaves`;
    } else {
      rootOk = true;
      const step = Math.max(1, Math.floor(tree.nextIndex / SAMPLED_PATHS));
      for (let i = 0; i < tree.nextIndex && rootOk; i += step) {
        const p = tree.generateProof(i);
        rootOk = IncrementalMerkleTree.verifyProof(p) && p.leaf === tree.leaves[i];
      }
      how = `${SAMPLED_PATHS} sampled paths of ${tree.nextIndex} leaves`;
    }
    add(`R-01/${symbol}`, rootOk, `${symbol} pool: Merkle root ${rootOk ? "matches" : "DOES NOT match"} its leaves (${how})`);

    // R-02: every treasury note sits at its recorded leaf
    const stray = (ctx.treasuryUTXOs as any[]).filter((u) => tree.getNode(0, u.leafIndex) !== u.commitment);
    add(`R-02/${symbol}`, stray.length === 0, `${symbol}: ${ctx.treasuryUTXOs.length - stray.length}/${ctx.treasuryUTXOs.length} treasury notes are at their recorded leaf`);

    // R-03: solvency
    const solvent = pool.solvency().every((r: any) => r.ok);
    add(`R-03/${symbol}`, solvent, `${symbol} pool custody ${solvent ? "covers" : "DOES NOT cover"} every unspent note`);

    // R-04: journal reconciles
    if (ctx.journal) {
      const rec = ctx.journal.verifyReconciliation();
      add(`R-04/${symbol}`, rec, `${symbol} journal ${rec ? "reconciles with" : "DOES NOT reconcile with"} the unspent note set`);
    }

    // R-05: a payee key that is still present must derive the address it is supposed to control
    const registry = (ctx.merchantGateway as any).invoiceRegistry as Map<string, any>;
    let live = 0;
    let mismatched = 0;
    for (const inv of registry.values()) {
      if (!inv.ephemeralPrivateKey || /^0x0+$/.test(inv.ephemeralPrivateKey)) continue;
      live++;
      try {
        if (new Wallet(inv.ephemeralPrivateKey).address.toLowerCase() !== String(inv.ephemeralAddress).toLowerCase()) mismatched++;
      } catch {
        mismatched++;
      }
    }
    add(`R-05/${symbol}`, mismatched === 0, `${symbol}: ${live - mismatched}/${live} payee keys derive their invoice address${mismatched ? " (a mismatch is expected only for the simulation-only 'fast' derivation)" : ""}`, false);
  }

  // R-06: token supply equals the sum of balances
  const chain = env.shared.blockchain as any;
  for (const [symbol, token] of env.shared.tokens) {
    let sum = 0n;
    for (const acc of chain.accounts.values()) sum += acc.tokens.get(token.address.toLowerCase()) ?? 0n;
    const supply = token.totalSupply();
    add(`R-06/${symbol}`, sum === supply, `${symbol} supply ${supply} ${sum === supply ? "equals" : "DOES NOT equal"} the sum of balances ${sum}`);
  }

  return { ok: checks.every((c) => c.ok || !c.fatal), checks };
}

/**
 * Builds an environment from `factory`, overlays the snapshot, and verifies it. Throws (leaving nothing
 * changed) on a bad digest, a schema or identity mismatch, or any fatal verification failure.
 */
export function restoreEnvironment(
  plaintext: string,
  factory: () => MultiAssetEnvironment
): { env: MultiAssetEnvironment; summary: SnapshotSummary; verification: VerifyReport } {
  let wrapper: { digest: string; body: Encoded };
  try {
    wrapper = JSON.parse(plaintext);
  } catch {
    throw new Error("ERR_RESTORE_MALFORMED: snapshot is not valid JSON");
  }
  if (sha256(canonicalJson(wrapper.body)) !== wrapper.digest) throw new Error("ERR_RESTORE_DIGEST: snapshot content does not match its digest");
  const body = decode(wrapper.body) as any;
  if (body.schema !== SNAPSHOT_SCHEMA) throw new Error("ERR_RESTORE_SCHEMA: not a DarkCircle environment snapshot");
  if (body.version !== SNAPSHOT_VERSION) throw new Error(`ERR_RESTORE_VERSION: snapshot version ${body.version} is not supported (this build reads ${SNAPSHOT_VERSION})`);

  const env = factory();
  if (body.network.id !== env.shared.blockchain.network.id || body.network.chainId !== env.shared.chainId) {
    throw new Error(`ERR_RESTORE_NETWORK: snapshot is for ${body.network.id} (chain ${body.network.chainId}), this process runs ${env.shared.blockchain.network.id} (chain ${env.shared.chainId})`);
  }
  if (JSON.stringify(body.assets) !== JSON.stringify(env.assets)) {
    throw new Error(`ERR_RESTORE_ASSETS: snapshot has assets ${body.assets.join(",")}, this process has ${env.assets.join(",")}`);
  }
  const identity = identityOf(env);
  if (body.identity.corporateFingerprint !== identity.corporateFingerprint) {
    throw new Error("ERR_RESTORE_IDENTITY: the corporate key hierarchy differs from the one that produced this snapshot (wrong seed?); its notes would be unspendable");
  }
  if (body.identity.merchantFingerprint !== identity.merchantFingerprint) {
    throw new Error("ERR_RESTORE_IDENTITY: the merchant master key differs from the one that produced this snapshot");
  }

  const chain = env.shared.blockchain as any;
  chain.currentBlockNumber = body.chain.currentBlockNumber;
  chain._currentTimeOffset = body.chain.timeOffset;
  replaceMap(chain.accounts, body.chain.accounts);
  replaceArray(chain.blocks, body.chain.blocks);
  replaceMap(chain.transactions, body.chain.transactions);
  replaceMap(chain.receipts, body.chain.receipts);
  for (const [symbol, t] of Object.entries<any>(body.chain.tokens)) {
    const token = env.shared.tokens.get(symbol) as any;
    if (!token) throw new Error(`ERR_RESTORE_ASSETS: snapshot has token ${symbol} that this process does not deploy`);
    token._totalSupply = t.totalSupply;
    replaceMap(token._nonces, t.nonces);
    replaceArray(token.events, t.events);
  }

  const registry = env.shared.sanctionsRegistry as any;
  replaceMap(registry.entries, body.compliance.sanctions.entries);
  replaceMap(registry.smt.nodes, body.compliance.sanctions.nodes);
  replaceSet(registry.historicalRoots, body.compliance.sanctions.historicalRoots);
  replaceSet((env.shared.ppoiEngine as any).quarantinedNotes, body.compliance.quarantined);

  for (const symbol of env.assets) overlayLane(env.lanes[symbol], body.lanes[symbol]);

  const verification = verifyEnvironment(env);
  if (!verification.ok) {
    const failed = verification.checks.filter((c) => !c.ok && c.fatal).map((c) => `${c.id}: ${c.detail}`);
    throw new Error(`ERR_RESTORE_VERIFICATION: the restored state is not coherent (${failed.join("; ")})`);
  }
  return { env, summary: summarise(body), verification };
}

/** Header-level description of a snapshot without building an environment. */
export function describeSnapshot(plaintext: string): SnapshotSummary {
  const wrapper = JSON.parse(plaintext) as { digest: string; body: Encoded };
  if (sha256(canonicalJson(wrapper.body)) !== wrapper.digest) throw new Error("ERR_RESTORE_DIGEST: snapshot content does not match its digest");
  return summarise(decode(wrapper.body));
}
