/**
 * DarkCircle: second audit, application findings
 * File: test/unit/audit_remediation.test.ts
 *
 * One test (or group) per finding of the 2026-09-23 audit (docs/AUDIT_2026-09-23.md) that lives in code a
 * release keeps. The circuit and contract findings are also proven against the compiled artifacts by the
 * build's local EVM run (checks E-12 to E-17). Each case here failed against the code before the fix.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ethers } from "ethers";
import { createDefaultCliContext } from "../../src/cli/context.ts";
import { executeShield } from "../../src/actions/shield.ts";
import { ResourceServer } from "../../src/server/resourceServer.ts";
import { InboundMerchantGateway, LIVE_MIN_CONFIRMATIONS } from "../../src/gateway/gateway.ts";
import { InvoiceRegistry } from "../../src/gateway/invoiceRegistry.ts";
import { Fp } from "../../src/crypto/field.ts";
import { Note } from "../../src/crypto/note.ts";
import { poseidon3, poseidon4 } from "../../src/crypto/poseidon.ts";
import { BABYJUBJUB_L } from "../../src/crypto/babyjubjub.ts";
import { computePublicInputsHash } from "../../src/crypto/unshield.ts";
import { verifyUnshieldStatement } from "../../src/sim/unshieldVerifier.ts";
import { evaluateTransferReceipt, receiptSucceeded, TRANSFER_TOPIC } from "../../src/quai/paymentVerifier.ts";
import { decode } from "../../src/persistence/codec.ts";
import { startApiServer } from "../../src/api/server.ts";
import { PersistenceManager } from "../../src/persistence/manager.ts";
import { ERC20_ABI } from "../../src/sim/erc20Token.ts";
import { SIM_MERCHANT_ADDRESS, SIM_VENDOR_ADDRESS } from "../../src/sim/defaults.ts";
import type { ShieldedUTXO, UnshieldRequest } from "../../src/types/sim.ts";
import type { AsyncReceiptSource } from "../../src/gateway/paymentEvidence.ts";

type Ctx = ReturnType<typeof createDefaultCliContext>;
const UNIT = 10n ** 18n;
const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** A valid unshield request for `utxo` under spending key `ssk` (the settlement coordinator's shape). */
function request(ctx: Ctx, utxo: ShieldedUTXO, ssk: bigint, amount: bigint): UnshieldRequest {
  const keys = ctx.corporateKeys as any;
  const pool = ctx.pool;
  const fee = ctx.relayer.minimumFee;
  const token = ethers.getAddress(utxo.token);
  const remainder = utxo.value - amount - fee;
  const changeRho = Fp.random();
  const changeCommitment = remainder > 0n ? poseidon4(keys.npk, BigInt(token), remainder, changeRho) : undefined;
  const root = pool.merkleTree.root;
  const proof = ctx.ppoiEngine!.generateProofOfInnocence(utxo.depositorAddress!, utxo.depositTimestamp);
  return {
    witness: {
      inputNote: { npk: utxo.npk ?? keys.npk, token, value: utxo.value, rho: utxo.rho ?? utxo.blinding },
      leafIndex: utxo.leafIndex,
      siblings: pool.merkleTree.generateProof(utxo.leafIndex).siblings,
      spendingKey: ssk,
      viewingPublicKeyX: keys.vpk,
      changeNote: changeCommitment ? { npk: keys.npk, token, value: remainder, rho: changeRho } : undefined
    },
    merkleRoot: root,
    // the nullifier the key derives: for ssk + L a different one, which is the whole attack
    nullifier: poseidon3(Fp.mod(ssk), utxo.commitment, BigInt(utxo.leafIndex)),
    recipient: SIM_VENDOR_ADDRESS,
    token,
    amount,
    relayerFee: fee,
    relayerAddress: ctx.relayer.relayerAddress,
    changeCommitment,
    publicInputsHash: computePublicInputsHash({ recipient: SIM_VENDOR_ADDRESS, token, amount, relayerAddress: ctx.relayer.relayerAddress, relayerFee: fee, merkleRoot: Fp.toHex(root) }),
    ppoiProof: { sanctionsRoot: proof.sanctionsRoot, depositOrigin: proof.depositOrigin, isNonSanctioned: true, smtProof: proof.smtProof, depositTimestamp: utxo.depositTimestamp }
  };
}

/** Pays an invoice's payee address with a real ERC-20 transfer on the simulated ledger. */
function payOnChain(ctx: Ctx, invoice: { ephemeralAddress: string }, amount: bigint, tokenObj = ctx.token!) {
  tokenObj.mint(SIM_MERCHANT_ADDRESS, amount);
  const r = ctx.blockchain.executeTransaction({
    from: SIM_MERCHANT_ADDRESS,
    to: tokenObj.address,
    data: new ethers.Interface(ERC20_ABI).encodeFunctionData("transfer", [invoice.ephemeralAddress, amount])
  });
  assert.equal(r.status, 1, r.error);
  return r.transactionHash;
}

const past = () => Math.floor(Date.now() / 1000) - 10;

describe("2026-09-23 audit: application findings", () => {
  describe("DCP-01: one note, one nullifier (the executable specification)", () => {
    it("the specification refuses spendingKey + L: the same public key, so the same note, under a second nullifier", () => {
      const ctx = createDefaultCliContext();
      const utxo = ctx.treasuryUTXOs[0];
      const ssk = (ctx.corporateKeys as any).ssk as bigint;
      assert.ok(ssk < BABYJUBJUB_L, "keys are derived in [0, L)");

      const honest = verifyUnshieldStatement(request(ctx, utxo, ssk, 5n * UNIT), ctx.pool as any);
      assert.equal(honest.inputCommitment, utxo.commitment, "control: the honest key proves the note");

      const aliased = request(ctx, utxo, ssk + BABYJUBJUB_L, 5n * UNIT);
      assert.notEqual(aliased.nullifier, poseidon3(ssk, utxo.commitment, BigInt(utxo.leafIndex)), "a genuinely different nullifier");
      assert.throws(() => verifyUnshieldStatement(aliased, ctx.pool as any), /ERR_SPENDING_KEY_OUT_OF_RANGE/);
      for (const k of [BABYJUBJUB_L, ssk + 7n * BABYJUBJUB_L, -1n]) {
        assert.throws(() => verifyUnshieldStatement(request(ctx, utxo, k, 5n * UNIT), ctx.pool as any), /ERR_SPENDING_KEY_OUT_OF_RANGE/, `key ${k}`);
      }
    });

    it("the pool refuses the second spend, and a wallet refuses to derive the aliased nullifier", () => {
      const ctx = createDefaultCliContext();
      const utxo = ctx.treasuryUTXOs[0];
      const ssk = (ctx.corporateKeys as any).ssk as bigint;
      ctx.pool.unshield(request(ctx, utxo, ssk, 5n * UNIT));
      assert.throws(() => ctx.pool.unshield(request(ctx, utxo, ssk + BABYJUBJUB_L, 5n * UNIT)), /ERR_SPENDING_KEY_OUT_OF_RANGE/);
      const note = new Note({ npk: 1n, token: utxo.token, value: 1n, rho: 2n, leafIndex: 0 });
      assert.throws(() => note.computeNullifier(ssk + BABYJUBJUB_L), /ERR_SPENDING_KEY_OUT_OF_RANGE/);
      assert.equal(note.computeNullifier(ssk), poseidon3(ssk, note.computeCommitment(), 0n));
    });
  });

  describe("APP-01: a payment buys the resource it was invoiced for", () => {
    it("an invoice paid for the 5-token route does not unlock the 10-token route, and presenting it there changes nothing", async () => {
      const ctx = createDefaultCliContext();
      const server = new ResourceServer({ gateway: ctx.merchantGateway, autoSweep: false });
      const challenge = await server.handleRequest("GET", "/api/v1/protected/analytics");
      assert.equal(challenge.status, 402);
      const inv = ctx.merchantGateway.invoiceRegistry.get(challenge.headers["X-Payment-Invoice-Id"])!;
      assert.equal(inv.requiredAmount, 5n * UNIT);
      const hash = payOnChain(ctx, inv, inv.requiredAmount);

      const elsewhere = await server.handleRequest("GET", "/api/v1/protected/ai-inference", { "x-payment-invoice-id": inv.invoiceId, "x-payment-proof": hash });
      assert.equal(elsewhere.status, 403);
      assert.equal(elsewhere.body.error, "ERR_INVOICE_RESOURCE_MISMATCH");
      assert.equal(inv.status, "PENDING", "refused before verification: nothing was settled");
      assert.equal(ctx.merchantGateway.usedReceiptRegistry.has(hash.toLowerCase()), false);

      const right = await server.handleRequest("GET", "/api/v1/protected/analytics", { "x-payment-invoice-id": inv.invoiceId, "x-payment-proof": hash });
      assert.equal(right.status, 200);
    });

    it("an invoice for the right path but another token is refused too", async () => {
      const ctx = createDefaultCliContext();
      const server = new ResourceServer({ gateway: ctx.merchantGateway, autoSweep: false });
      const wqi = "0x002b2596ecf05c93a31ff916e8b456df6c77c750";
      const inv = ctx.merchantGateway.createPaymentChallenge("/api/v1/protected/analytics", 5n * UNIT, wqi, "WQI", 18).invoice;
      const res = await server.handleRequest("GET", "/api/v1/protected/analytics", { "x-payment-invoice-id": inv.invoiceId, "x-payment-proof": "0x" + "ab".repeat(32) });
      assert.equal(res.status, 403);
    });

    it("the gateway middleware binds the same way, and ignores the query string", async () => {
      const ctx = createDefaultCliContext();
      const mw = ctx.merchantGateway.createMiddleware({ protectedPrefixes: ["/api/v1/protected"], autoSweep: false });
      const run = async (url: string, headers: Record<string, string> = {}) => {
        let status = 200;
        let body: any;
        let next = false;
        const res = { setHeader() {}, set statusCode(v: number) { status = v; }, get statusCode() { return status; }, json(b: unknown) { body = b; }, end(s: string) { body = JSON.parse(s); } };
        await mw({ url, headers }, res, () => { next = true; });
        return { status, body, next };
      };
      const first = await run("/api/v1/protected/a?x=1");
      assert.equal(first.status, 402);
      const inv = ctx.merchantGateway.invoiceRegistry.get(first.body.invoiceId ?? [...ctx.merchantGateway.invoiceRegistry.keys()].pop()!)!;
      assert.equal(inv.resourceUri, "/api/v1/protected/a", "the resource is the path, not the query");
      const hash = payOnChain(ctx, inv, inv.requiredAmount);
      const wrong = await run("/api/v1/protected/b", { "x-payment-invoice-id": inv.invoiceId, "x-payment-proof": hash });
      assert.equal(wrong.status, 403);
      assert.equal(wrong.next, false);
      const ok = await run("/api/v1/protected/a?y=2", { "x-payment-invoice-id": inv.invoiceId, "x-payment-proof": hash });
      assert.equal(ok.next, true);
    });
  });

  describe("APP-02: expiry never strands a payment", () => {
    function invoice(ctx: Ctx) {
      return ctx.merchantGateway.createPaymentChallenge("/r", 5n * UNIT, ctx.token!.address, ctx.token!.symbol, 18).invoice;
    }

    it("a settled, not yet swept invoice presented after its TTL keeps its status, is not pruned, and can still be swept", async () => {
      const ctx = createDefaultCliContext();
      const inv = invoice(ctx);
      const hash = payOnChain(ctx, inv, inv.requiredAmount);
      assert.equal(ctx.merchantGateway.verifyPayment(inv.invoiceId, hash).success, true);
      inv.expiresAt = past();

      const again = ctx.merchantGateway.verifyPayment(inv.invoiceId, hash);
      assert.equal(again.statusCode, 410, "the access the payment bought has ended");
      assert.equal(inv.status, "SETTLED", "before the fix this became EXPIRED, which the sweeper skips");
      assert.equal(ctx.merchantGateway.invoiceRegistry.pruneExpired(0), 0, "before the fix this deleted the invoice and its payee key");
      await ctx.merchantGateway.sweepAndShield(inv.invoiceId);
      assert.equal(inv.status, "SWEPT", "the customer's funds reached the pool");
    });

    it("a payment made in time whose proof arrives after the TTL is honoured, and swept", async () => {
      const ctx = createDefaultCliContext();
      const inv = invoice(ctx);
      const hash = payOnChain(ctx, inv, inv.requiredAmount);
      inv.expiresAt = past(); // the proof shows up late (confirmations on Quai take minutes)
      const res = ctx.merchantGateway.verifyPayment(inv.invoiceId, hash);
      assert.equal(res.success, true, res.error);
      assert.equal(inv.status, "SETTLED");
      assert.equal(inv.settledAfterExpiry, true);
      await ctx.merchantGateway.sweepAndShield(inv.invoiceId);
      assert.equal(inv.status, "SWEPT");
    });

    it("an expired invoice without a valid payment is still 410, but is only pruned once its address is proven empty", () => {
      const ctx = createDefaultCliContext();
      const empty = invoice(ctx);
      const funded = invoice(ctx);
      ctx.token!.mint(funded.ephemeralAddress, funded.requiredAmount); // money arrived, no proof was ever presented
      for (const i of [empty, funded]) i.expiresAt = past();
      const r = ctx.merchantGateway.verifyPayment(empty.invoiceId, "0x" + "de".repeat(32));
      assert.equal(r.statusCode, 410);
      assert.equal(empty.status, "EXPIRED");
      assert.equal(ctx.merchantGateway.invoiceRegistry.pruneExpired(0), 1);
      assert.equal(ctx.merchantGateway.invoiceRegistry.has(empty.invoiceId), false);
      assert.equal(ctx.merchantGateway.invoiceRegistry.has(funded.invoiceId), true, "its key is the only way to reach those funds");
    });

    it("when balances are not authoritative (a live zone), nothing is pruned", () => {
      const ctx = createDefaultCliContext();
      const reg = new InvoiceRegistry("live-mode-merchant-key-0123456789abcdef", ctx.blockchain as any, { balanceAuthoritative: false });
      const inv = reg.createInvoice("/r", UNIT, ctx.token!.address, "WQUAI", 18, -100);
      assert.equal(reg.pruneExpired(0), 0);
      assert.equal(reg.has(inv.invoiceId), true);
    });

    it("a settled invoice cannot be re-settled by a different transaction", () => {
      const ctx = createDefaultCliContext();
      const inv = invoice(ctx);
      const first = payOnChain(ctx, inv, inv.requiredAmount);
      assert.equal(ctx.merchantGateway.verifyPayment(inv.invoiceId, first).success, true);
      const second = payOnChain(ctx, inv, inv.requiredAmount);
      const res = ctx.merchantGateway.verifyPayment(inv.invoiceId, second);
      assert.equal(res.statusCode, 409);
      assert.equal(res.error, "ERR_INVOICE_ALREADY_SETTLED");
      assert.equal(inv.settlementTxHash, first.toLowerCase());
    });
  });

  describe("APP-10: a shielded note carries the pool's own deposit time", () => {
    it("a clock tick between the pool's record and the wallet's copy no longer strands the note", () => {
      const ctx = createDefaultCliContext();
      const real = Date.now;
      // every read is a new second (starting a minute in the past, so the deposit is mature): whatever the
      // shield path reads after the pool has recorded the deposit is guaranteed to be a different second
      let t = real() - 60_000;
      Date.now = () => (t += 1000);
      try {
        executeShield(ctx, { amount: 3n * UNIT, token: "WQUAI" });
      } finally {
        Date.now = real;
      }
      const note = ctx.treasuryUTXOs.at(-1)!;
      const record = (ctx.pool as any).utxoRegistry.get(note.commitment.toString()) as ShieldedUTXO;
      assert.equal(note.depositTimestamp, record.depositTimestamp, "before the fix the wallet re-read the clock and was a second off");
      // and the note is spendable: PPOI binds it to the pool's record (PPOI_TIMESTAMP_MISMATCH before)
      const ssk = (ctx.corporateKeys as any).ssk as bigint;
      const r = ctx.pool.unshield(request(ctx, note, ssk, 1n * UNIT));
      assert.equal(r.amount, 1n * UNIT);
    });
  });

  describe("APP-03: reset is confirmed by the server, and never lets saved state age out", () => {
    it("needs the typed confirmation; with persistence on, the discarded state is saved and pinned before anything is reset", async () => {
      const api = await startApiServer({ port: 0 });
      const post = (a: typeof api, body: unknown) =>
        fetch(a.url + "api/reset", { method: "POST", headers: { "X-DarkCircle-Session": a.token, "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
      try {
        const bare = await post(api, { asset: "WQUAI" });
        assert.equal(bare.status, 400);
        assert.equal(bare.json.error.code, "CONFIRMATION_REQUIRED");
        assert.equal((await post(api, { asset: "WQUAI", confirm: "RESET" })).status, 200);
      } finally {
        await api.close();
      }

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-reset-"));
      dirs.push(dir);
      const persistence = PersistenceManager.open({ dir, passphrase: "correct horse battery staple", kdf: { N: 1 << 12, r: 8, p: 1 }, autosaveDebounceMs: 0, keep: 1 });
      const persisted = await startApiServer({ port: 0, persistence });
      try {
        const before = persisted.state.env;
        const r = await post(persisted, { asset: "WQUAI", confirm: "RESET" });
        assert.equal(r.status, 200);
        assert.notEqual(persisted.state.env, before, "the reset happened");
        const seq = r.json.preservedSnapshot.seq;
        for (let i = 0; i < 3; i++) await persistence.save(persisted.state.env); // keep=1: every unpinned snapshot but the newest goes
        const pinned = persistence.status().snapshots.find((s) => s.seq === seq);
        assert.ok(pinned?.pinned, "before the fix the discarded state was one autosave from being pruned for good");
        assert.equal(pinned!.pinReason, "state before a reset");
      } finally {
        await persisted.close();
      }
    });
  });

  describe("APP-04: receipt parsing", () => {
    it("a malformed log is skipped instead of failing the whole verification, and a numeric status counts as success", () => {
      const token = "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB";
      const payee = "0x0012345678901234567890123456789012345678";
      const pad = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
      const logs = [
        { address: token, topics: [TRANSFER_TOPIC, pad(SIM_MERCHANT_ADDRESS), pad(payee)], data: "0x" }, // malformed value
        { address: token, topics: [TRANSFER_TOPIC, pad(SIM_MERCHANT_ADDRESS)], data: "0x" + "0".repeat(63) + "1" }, // wrong arity
        { address: token, topics: [TRANSFER_TOPIC, pad(SIM_MERCHANT_ADDRESS), pad(payee)], data: ethers.toBeHex(5n * UNIT, 32) }
      ];
      const v = evaluateTransferReceipt({ receipt: { ok: true, blockNumber: 10, logs }, headBlock: 12, token: { address: token }, recipient: payee, minAmount: 5n * UNIT });
      assert.equal(v.ok, true);
      assert.equal(v.transferred, 5n * UNIT);
      assert.equal(receiptSucceeded(1), true);
      assert.equal(receiptSucceeded("0x1"), true);
      assert.equal(receiptSucceeded("0x0"), false);
      assert.equal(receiptSucceeded(undefined), false);
    });
  });

  describe("APP-06 / APP-07 / APP-08: hygiene", () => {
    it("APP-06: a '__proto__' key in a snapshot is an ordinary field, never a prototype", () => {
      const out = decode(JSON.parse('{"__proto__": {"polluted": true}, "a": 1}')) as Record<string, unknown>;
      assert.equal(Object.getPrototypeOf(out), Object.prototype);
      assert.equal((out as any).polluted, undefined);
      assert.deepEqual(Object.keys(out).sort(), ["__proto__", "a"]);
      assert.equal(({} as any).polluted, undefined);
    });

    it("APP-07: a swept note's blinding is a full field element (the old sweep never exceeded 2^128)", async () => {
      const ctx = createDefaultCliContext();
      const inv = ctx.merchantGateway.createPaymentChallenge("/r", 5n * UNIT, ctx.token!.address, ctx.token!.symbol, 18).invoice;
      ctx.merchantGateway.verifyPayment(inv.invoiceId, payOnChain(ctx, inv, inv.requiredAmount));
      await ctx.merchantGateway.sweepAndShield(inv.invoiceId);
      const note = [...(ctx.pool as any).utxoRegistry.values()].find((u: ShieldedUTXO) => u.memo === inv.invoiceId) as ShieldedUTXO;
      assert.ok(note, "the swept note exists");
      assert.ok(note.blinding >= 1n << 128n && note.blinding < Fp.p, "uniform in [0, p): below 2^128 with probability 2^-126");
    });

    it("APP-08: verifying against a live zone defaults to two confirmations and makes pruning conservative", () => {
      const ctx = createDefaultCliContext();
      const source: AsyncReceiptSource = { getReceipt: async () => null, headBlock: async () => 0 };
      const live = new InboundMerchantGateway({ masterMerchantKey: "live-merchant-key-0123456789abcdef", corporate0zkAddress: "0zk", corporateNpk: 1n, blockchain: ctx.blockchain, pool: ctx.pool, receiptSource: source });
      assert.equal(live.invoiceRegistry.minConfirmations, LIVE_MIN_CONFIRMATIONS);
      assert.equal(live.invoiceRegistry.balanceAuthoritative, false);
      const local = new InboundMerchantGateway({ masterMerchantKey: "local-merchant-key-0123456789abcdef", corporate0zkAddress: "0zk", corporateNpk: 1n, blockchain: ctx.blockchain, pool: ctx.pool });
      assert.equal(local.invoiceRegistry.minConfirmations, 1);
      assert.equal(local.invoiceRegistry.balanceAuthoritative, true);
    });
  });
});
