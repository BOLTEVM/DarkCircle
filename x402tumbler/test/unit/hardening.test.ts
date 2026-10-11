/**
 * DarkCircle Protocol: audit remediation regression suite
 * File: test/unit/hardening.test.ts
 *
 * One test per finding in AUDIT.md that was fixed in code. Each attack here succeeded against the
 * pre-audit code (the finding id is in the test name); they must keep failing.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { createDefaultCliContext } from "../../src/cli/context.ts";
import { runCli } from "../../src/cli/index.ts";
import { SettlementCoordinator } from "../../src/proxy/settlement.ts";
import { ResourceServer } from "../../src/server/resourceServer.ts";
import { InboundMerchantGateway } from "../../src/gateway/gateway.ts";
import { Fp } from "../../src/crypto/field.ts";
import { poseidon3, poseidon4 } from "../../src/crypto/poseidon.ts";
import { computePublicInputsHash } from "../../src/crypto/unshield.ts";
import { isInPrimeSubgroup, isIdentity, BASE8 } from "../../src/crypto/babyjubjub.ts";
import { encryptNotePayload, decryptNotePayload } from "../../src/audit/decryptor.ts";
import { assertStrongSeed, generateSeed, PUBLIC_DEMO_SEEDS } from "../../src/audit/keys.ts";
import { SimulatedBlockchain } from "../../src/sim/blockchain.ts";
import { ERC20Token, ERC20_ABI } from "../../src/sim/erc20Token.ts";
import { RailgunPool } from "../../src/sim/railgunContract.ts";
import { SIM_VENDOR_ADDRESS, SIM_MERCHANT_ADDRESS } from "../../src/sim/defaults.ts";
import type { ShieldedUTXO, UnshieldRequest } from "../../src/types/sim.ts";
import type { AsyncReceiptSource } from "../../src/gateway/paymentEvidence.ts";

type Ctx = ReturnType<typeof createDefaultCliContext>;
const VENDOR = SIM_VENDOR_ADDRESS;
const TOKEN_UNIT = 10n ** 18n;
const LONG_HASH = (n: string) => "0x" + n.repeat(32).slice(0, 64);

/** Builds a fully valid unshield request for `utxo`, mirroring what SettlementCoordinator produces. */
function buildRequest(
  ctx: Ctx,
  utxo: ShieldedUTXO,
  o: { recipient?: string; amount: bigint; fee?: bigint }
): UnshieldRequest {
  const keys = ctx.corporateKeys as any;
  const pool = ctx.pool;
  const fee = o.fee ?? ctx.relayer.minimumFee;
  const token = ethers.getAddress(utxo.token);
  const remainder = utxo.value - o.amount - fee;
  const changeBlinding = Fp.random();
  const changeCommitment = remainder > 0n ? poseidon4(keys.npk, BigInt(token), remainder, changeBlinding) : undefined;
  const root = pool.merkleTree.root;
  const recipient = o.recipient ?? VENDOR;
  const proof = ctx.ppoiEngine!.generateProofOfInnocence(utxo.depositorAddress!, utxo.depositTimestamp);
  return {
    witness: {
      inputNote: { npk: utxo.npk ?? keys.npk, token, value: utxo.value, rho: utxo.rho ?? utxo.blinding },
      leafIndex: utxo.leafIndex,
      siblings: pool.merkleTree.generateProof(utxo.leafIndex).siblings,
      spendingKey: keys.ssk,
      viewingPublicKeyX: keys.vpk,
      changeNote: changeCommitment ? { npk: keys.npk, token, value: remainder, rho: changeBlinding } : undefined
    },
    merkleRoot: root,
    nullifier: poseidon3(Fp.mod(keys.ssk), utxo.commitment, BigInt(utxo.leafIndex)),
    recipient,
    token,
    amount: o.amount,
    relayerFee: fee,
    relayerAddress: ctx.relayer.relayerAddress,
    changeCommitment,
    publicInputsHash: computePublicInputsHash({
      recipient,
      token,
      amount: o.amount,
      relayerAddress: ctx.relayer.relayerAddress,
      relayerFee: fee,
      merkleRoot: Fp.toHex(root)
    }),
    ppoiProof: {
      sanctionsRoot: proof.sanctionsRoot,
      depositOrigin: proof.depositOrigin,
      isNonSanctioned: true,
      smtProof: proof.smtProof,
      depositTimestamp: utxo.depositTimestamp
    }
  };
}

async function reject(p: Promise<unknown> | (() => unknown), re: RegExp) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    assert.match((err as Error).message, re);
    return;
  }
  assert.fail(`expected rejection matching ${re}`);
}

/** Pays an invoice's ephemeral address with a real ERC-20 transfer transaction and returns its hash. */
function payOnChain(ctx: Ctx, invoice: { ephemeralAddress: string }, amount: bigint, from = SIM_MERCHANT_ADDRESS, tokenObj = ctx.token!) {
  tokenObj.mint(from, amount);
  const iface = new ethers.Interface(ERC20_ABI);
  const r = ctx.blockchain.executeTransaction({
    from,
    to: tokenObj.address,
    data: iface.encodeFunctionData("transfer", [invoice.ephemeralAddress, amount])
  });
  assert.equal(r.status, 1, r.error);
  return r.transactionHash;
}

describe("Audit remediation regression suite", () => {
  describe("shielded pool soundness (verified mode)", () => {
    it("A-02: a fresh nullifier and a valid root no longer drain the pool", async () => {
      const ctx = createDefaultCliContext();
      const before = ctx.token!.balanceOf(VENDOR);
      const attack: UnshieldRequest = {
        merkleRoot: ctx.pool.merkleTree.root,
        nullifier: 123456789n,
        recipient: VENDOR,
        token: ctx.token!.address,
        amount: 90n * TOKEN_UNIT,
        relayerFee: ctx.relayer.minimumFee,
        relayerAddress: ctx.relayer.relayerAddress,
        ppoiProof: { depositOrigin: "0x0000000000000000000000000000000000000001", isNonSanctioned: true }
      };
      await reject(ctx.relayer.broadcastUnshield(attack), /ERR_PROOF_MISSING/);
      assert.equal(ctx.token!.balanceOf(VENDOR), before);
    });

    it("A-02: a forged witness for a note that is not in the tree is rejected", async () => {
      const ctx = createDefaultCliContext();
      const real = ctx.treasuryUTXOs[0];
      const req = buildRequest(ctx, real, { amount: TOKEN_UNIT });
      // claim the note is worth 10x more: the recomputed commitment is not in the tree
      req.witness!.inputNote.value = real.value * 10n;
      req.witness!.changeNote!.value = req.witness!.inputNote.value - req.amount - req.relayerFee;
      await reject(ctx.relayer.broadcastUnshield(req), /ERR_MERKLE_PATH_INVALID/);
    });

    it("A-02: spending a note with someone else's key is rejected", async () => {
      const ctx = createDefaultCliContext();
      const req = buildRequest(ctx, ctx.treasuryUTXOs[0], { amount: TOKEN_UNIT });
      req.witness!.spendingKey = 42n;
      await reject(ctx.relayer.broadcastUnshield(req), /ERR_NOT_NOTE_OWNER/);
    });

    it("A-02: value must be conserved (amount + fee + change == note value)", async () => {
      const ctx = createDefaultCliContext();
      const req = buildRequest(ctx, ctx.treasuryUTXOs[0], { amount: TOKEN_UNIT });
      req.amount = 5n * TOKEN_UNIT; // ask for more than the witness accounts for
      req.publicInputsHash = computePublicInputsHash({
        recipient: req.recipient, token: req.token, amount: req.amount, relayerAddress: req.relayerAddress,
        relayerFee: req.relayerFee, merkleRoot: Fp.toHex(req.merkleRoot as bigint)
      });
      await reject(ctx.relayer.broadcastUnshield(req), /ERR_VALUE_NOT_CONSERVED/);
    });

    it("A-02: the Merkle path must have exactly the tree depth (no interior-node substitution)", async () => {
      const ctx = createDefaultCliContext();
      const req = buildRequest(ctx, ctx.treasuryUTXOs[0], { amount: TOKEN_UNIT });
      req.witness!.siblings = req.witness!.siblings.slice(0, 8);
      await reject(ctx.relayer.broadcastUnshield(req), /ERR_MERKLE_PATH_INVALID.*exactly 16/);
    });

    it("A-03: a nullifier cannot be replayed by re-encoding it (decimal, hex, n + p)", async () => {
      const ctx = createDefaultCliContext();
      const utxo = ctx.treasuryUTXOs[0];
      const req = buildRequest(ctx, utxo, { amount: TOKEN_UNIT });
      await ctx.relayer.broadcastUnshield(req);

      const n = req.nullifier as bigint;
      for (const spelling of [n, n.toString(), "0x" + n.toString(16), "0x" + n.toString(16).padStart(70, "0")]) {
        const replay = buildRequest(ctx, ctx.treasuryUTXOs.at(-1)!, { amount: TOKEN_UNIT });
        replay.nullifier = spelling as any;
        await reject(ctx.relayer.broadcastUnshield(replay), /ERROR_NULLIFIER_ALREADY_SPENT|ERR_NULLIFIER_MISMATCH/);
      }
      // n + p is not a valid field element at all
      const aliased = buildRequest(ctx, utxo, { amount: TOKEN_UNIT });
      aliased.nullifier = n + Fp.p;
      await reject(ctx.relayer.broadcastUnshield(aliased), /ERR_FIELD_ELEMENT_OUT_OF_RANGE/);
      // and the exact original request is a plain double spend
      await reject(ctx.relayer.broadcastUnshield({ ...req, publicInputsHash: req.publicInputsHash }), /ERROR_NULLIFIER_ALREADY_SPENT/);
    });

    it("A-04: sanctions origin comes from the pool's deposit record, not from the request", async () => {
      const ctx = createDefaultCliContext();
      const keys = ctx.corporateKeys as any;
      const dirty = "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b"; // OFAC-listed
      // a sanctioned party funds a note through the merchant's address
      const funder = "0x0044444444444444444444444444444444444444";
      ctx.token!.mint(funder, 10n * TOKEN_UNIT);
      ctx.token!.approve(ctx.pool.contractAddress, 10n * TOKEN_UNIT, funder);
      const blinding = Fp.random();
      const shielded = ctx.pool.shield(ctx.token!.address, 10n * TOKEN_UNIT, keys.npk, blinding, "dirty", funder, dirty);
      const utxo: ShieldedUTXO = {
        commitment: shielded.commitment, leafIndex: shielded.leafIndex, token: ctx.token!.address, value: 10n * TOKEN_UNIT,
        blinding, rho: blinding, npk: keys.npk, memo: "dirty", depositorAddress: dirty.toLowerCase(), depositTimestamp: Math.floor(Date.now() / 1000)
      };
      const req = buildRequest({ ...ctx, ppoiEngine: ctx.ppoiEngine } as Ctx, { ...utxo, depositorAddress: "0x0033333333333333333333333333333333333333" }, { amount: TOKEN_UNIT });
      // the request LIES about the origin (claims a clean address); the pool knows better
      await reject(ctx.relayer.broadcastUnshield(req), /PPOI_SANCTIONED_INPUT/);
    });

    it("A-05: shield pulls funds; an unfunded depositor cannot mint a note", () => {
      const ctx = createDefaultCliContext();
      const keys = ctx.corporateKeys as any;
      const broke = "0x0055555555555555555555555555555555555555";
      assert.throws(
        () => ctx.pool.shield(ctx.token!.address, 1000n * TOKEN_UNIT, keys.npk, Fp.random(), "unbacked", broke),
        /ERR_SHIELD_FUNDING_FAILED/
      );
      assert.equal(ctx.pool.merkleTree.nextIndex, 1); // only the seeded treasury note
    });

    it("A-05: the same note cannot be shielded twice to overwrite its recorded origin", () => {
      const ctx = createDefaultCliContext();
      const keys = ctx.corporateKeys as any;
      const a = "0x0066666666666666666666666666666666666666";
      ctx.token!.mint(a, 4n * TOKEN_UNIT);
      ctx.token!.approve(ctx.pool.contractAddress, 4n * TOKEN_UNIT, a);
      const blinding = Fp.random();
      ctx.pool.shield(ctx.token!.address, TOKEN_UNIT, keys.npk, blinding, "one", a);
      assert.throws(() => ctx.pool.shield(ctx.token!.address, TOKEN_UNIT, keys.npk, blinding, "two", a, "0x0077777777777777777777777777777777777777"), /ERR_COMMITMENT_EXISTS/);
    });

    it("A-06: a request whose fee cannot be paid moves no funds and burns no nullifier", async () => {
      const chain = new SimulatedBlockchain();
      const token = ERC20Token.createWQUAI(chain);
      const pool = new RailgunPool(chain, { mode: "trusted-harness" });
      token.mint(pool.contractAddress, 10n * TOKEN_UNIT); // covers the amount but not amount + fee
      const req: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 777n,
        recipient: VENDOR,
        token: token.address,
        amount: 10n * TOKEN_UNIT,
        relayerFee: TOKEN_UNIT,
        relayerAddress: "0x0024Eb33E0e381844d7f56B748f6Ad8969c3cf79",
        ppoiProof: { depositOrigin: "0x0000000000000000000000000000000000000001", isNonSanctioned: true }
      };
      assert.throws(() => pool.unshield(req), /INSUFFICIENT_POOL_BALANCE_FOR_FEE/);
      assert.equal(token.balanceOf(VENDOR), 0n);
      assert.equal(pool.spentNullifiers.has(777n), false);
      // the identical request succeeds once the pool can pay, i.e. it was not half-executed before
      token.mint(pool.contractAddress, TOKEN_UNIT);
      pool.unshield(req);
      assert.equal(token.balanceOf(VENDOR), 10n * TOKEN_UNIT);
    });

    it("A-07: change-note leaf index survives a deposit landing mid-settlement", async () => {
      const ctx = createDefaultCliContext();
      const c = new SettlementCoordinator({
        spendingPolicy: ctx.spendingPolicy, relayer: ctx.relayer, corporateKeys: ctx.corporateKeys as any,
        ppoiEngine: ctx.ppoiEngine, sanctionsRegistry: ctx.sanctionsRegistry, treasuryUTXOs: ctx.treasuryUTXOs
      });
      const challenge = (i: number) => ({
        invoiceId: `inv_race_${i}`, amount: TOKEN_UNIT, tokenAddress: ctx.token!.address, chainId: 9, network: "quai-cyprus1",
        recipientAddress: VENDOR, expiresAt: Math.floor(Date.now() / 1000) + 600
      });
      const keys = ctx.corporateKeys as any;
      const depositor = "0x0038888888888888888888888888888888888888";
      ctx.token!.mint(depositor, 50n * TOKEN_UNIT);
      ctx.token!.approve(ctx.pool.contractAddress, 50n * TOKEN_UNIT, depositor);
      const inFlight = c.settleChallenge(challenge(1));
      ctx.pool.shield(ctx.token!.address, 5n * TOKEN_UNIT, keys.npk, Fp.random(), "race", depositor); // lands mid-flight
      await inFlight;
      // the change note must still be spendable: its recorded leaf index has to be its real one
      const change = c.treasuryUTXOs.find((u) => u.memo === "change_note")!;
      assert.equal(ctx.pool.merkleTree.leaves[change.leafIndex], change.commitment);
      await c.settleChallenge(challenge(2));
      assert.equal(ctx.token!.balanceOf(VENDOR), 2n * TOKEN_UNIT);
    });

    it("A-08: recipients must be valid Quai addresses in the pool's zone", async () => {
      const ctx = createDefaultCliContext();
      const req = buildRequest(ctx, ctx.treasuryUTXOs[0], { amount: TOKEN_UNIT, recipient: "0x1111111254eeb25477b68fb85ed929f73a960582" });
      await reject(ctx.relayer.broadcastUnshield(req), /ERR_QUAI_RECIPIENT_INVALID/);
    });

    it("solvency: the pool holds at least the value of every unspent note after mixed activity", async () => {
      const ctx = createDefaultCliContext();
      const c = new SettlementCoordinator({
        spendingPolicy: ctx.spendingPolicy, relayer: ctx.relayer, corporateKeys: ctx.corporateKeys as any,
        ppoiEngine: ctx.ppoiEngine, sanctionsRegistry: ctx.sanctionsRegistry, treasuryUTXOs: ctx.treasuryUTXOs
      });
      for (let i = 0; i < 3; i++) {
        await c.settleChallenge({
          invoiceId: `inv_sol_${i}`, amount: BigInt(i + 1) * TOKEN_UNIT, tokenAddress: ctx.token!.address, chainId: 9, network: "quai-cyprus1",
          recipientAddress: VENDOR, expiresAt: Math.floor(Date.now() / 1000) + 600
        });
      }
      const rows = ctx.pool.solvency();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].ok, true);
      assert.equal(rows[0].poolBalance, rows[0].liabilities); // exactly backed: nothing minted, nothing lost
    });

    it("trust mode is visible: the default pool is verified, the legacy pool says so", () => {
      const chain = new SimulatedBlockchain();
      assert.equal(new RailgunPool(chain).status().mode, "verified");
      assert.equal(new RailgunPool(chain, { mode: "trusted-harness" }).status().mode, "trusted-harness");
    });
  });

  describe("spending policy", () => {
    function coordinatorWith(ctx: Ctx, policy: Record<string, unknown>) {
      return new SettlementCoordinator({
        spendingPolicy: { ...ctx.spendingPolicy, ...policy } as any, relayer: ctx.relayer, corporateKeys: ctx.corporateKeys as any,
        ppoiEngine: ctx.ppoiEngine, sanctionsRegistry: ctx.sanctionsRegistry, treasuryUTXOs: ctx.treasuryUTXOs
      });
    }
    const ch = (ctx: Ctx, i: number, extra: Record<string, unknown> = {}) => ({
      invoiceId: `inv_pol_${i}`, amount: TOKEN_UNIT, tokenAddress: ctx.token!.address, chainId: 9, network: "quai-cyprus1",
      recipientAddress: VENDOR, expiresAt: Math.floor(Date.now() / 1000) + 600, ...extra
    });

    it("A-09: dailyBudgetCap is enforced, including under concurrency", async () => {
      const ctx = createDefaultCliContext();
      const c = coordinatorWith(ctx, { dailyBudgetCap: 3n * TOKEN_UNIT });
      const results = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => c.settleChallenge(ch(ctx, i))));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
      const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      assert.ok(failures.every((f) => /ERR_SPENDING_POLICY_DAILY_BUDGET_EXCEEDED/.test(f.reason.message)));
      assert.equal(c.spentLast24h(ctx.token!.address), 3n * TOKEN_UNIT);
    });

    it("A-09b: the daily cap accumulates across separate commands, not per coordinator", async () => {
      const ctx = createDefaultCliContext();
      ctx.spendingPolicy.dailyBudgetCap = 5n * TOKEN_UNIT;
      const pay = (amount: string) => runCli(["pay", "--recipient", VENDOR, "--amount", amount, "--json"], ctx);
      assert.equal((await pay("3")).exitCode, 0);
      const over = await pay("3");
      assert.notEqual(over.exitCode, 0, "the second command must see the first command's spend");
      assert.match(over.stderr, /ERR_SPENDING_POLICY_DAILY_BUDGET_EXCEEDED/);
      assert.equal((await pay("2")).exitCode, 0);
      assert.equal(ctx.spendTracker!.spent(ctx.token!.address), 5n * TOKEN_UNIT);
    });

    it("A-10: an expired or nearly expired invoice is refused before a note is spent", async () => {
      const ctx = createDefaultCliContext();
      const c = coordinatorWith(ctx, { minInvoiceTtlSeconds: 30 });
      const notes = ctx.treasuryUTXOs.length;
      await reject(c.settleChallenge(ch(ctx, 1, { expiresAt: Math.floor(Date.now() / 1000) - 5 })), /ERR_INVOICE_EXPIRED_OR_EXPIRING/);
      await reject(c.settleChallenge(ch(ctx, 2, { expiresAt: Math.floor(Date.now() / 1000) + 10 })), /ERR_INVOICE_EXPIRED_OR_EXPIRING/);
      assert.equal(ctx.treasuryUTXOs.length, notes);
      await c.settleChallenge(ch(ctx, 3));
    });

    it("A-11: a relayer fee above the challenge's maxFee is refused, not overpaid", async () => {
      const ctx = createDefaultCliContext();
      const c = coordinatorWith(ctx, {});
      await reject(c.settleChallenge(ch(ctx, 1, { maxFee: 1n })), /ERR_RELAYER_FEE_EXCEEDS_MAX_FEE/);
      assert.equal(ctx.token!.balanceOf(VENDOR), 0n);
    });

    it("A-12: direct unshield (treasury as sender) is refused unless explicitly allowed", () => {
      const ctx = createDefaultCliContext();
      assert.throws(
        () => new SettlementCoordinator({ spendingPolicy: ctx.spendingPolicy, relayer: ctx.relayer, corporateKeys: ctx.corporateKeys as any, preferDirectUnshield: true }),
        /ERR_DIRECT_UNSHIELD_NOT_ALLOWED/
      );
    });

    it("zero and negative amounts are refused by policy", () => {
      const ctx = createDefaultCliContext();
      const c = coordinatorWith(ctx, {});
      assert.throws(() => c.validatePolicy({ ...ch(ctx, 1), amount: 0n }), /AMOUNT_INVALID/);
      assert.throws(() => c.validatePolicy({ ...ch(ctx, 1), amount: -1n }), /AMOUNT_INVALID/);
    });
  });

  describe("payment verification (merchant side)", () => {
    function invoiceFor(ctx: Ctx, amount = 5n * TOKEN_UNIT) {
      return ctx.merchantGateway.createPaymentChallenge("/r", amount, ctx.token!.address, ctx.token!.symbol, 18).invoice;
    }

    it("A-01: an unknown transaction hash no longer unlocks an invoice whose address holds the tokens", () => {
      const ctx = createDefaultCliContext();
      const inv = invoiceFor(ctx);
      ctx.token!.mint(inv.ephemeralAddress, inv.requiredAmount); // funds present, but no transaction proves it
      const res = ctx.merchantGateway.verifyPayment(inv.invoiceId, LONG_HASH("de"));
      assert.equal(res.success, false);
      assert.equal(res.error, "ERR_TX_NOT_FOUND");
      assert.equal(res.statusCode, 402);
    });

    it("A-01: the caller-supplied amountSent is not trusted", () => {
      const ctx = createDefaultCliContext();
      const inv = invoiceFor(ctx);
      const res = ctx.merchantGateway.verifyPayment(inv.invoiceId, LONG_HASH("ab"), 10n ** 30n);
      assert.equal(res.success, false);
      assert.equal(res.error, "ERR_TX_NOT_FOUND");
    });

    it("A-01: a real transfer of the full amount is accepted and the payer is recorded from the log", () => {
      const ctx = createDefaultCliContext();
      const inv = invoiceFor(ctx);
      const hash = payOnChain(ctx, inv, inv.requiredAmount);
      const res = ctx.merchantGateway.verifyPayment(inv.invoiceId, hash);
      assert.equal(res.success, true);
      assert.equal(inv.payerAddress, SIM_MERCHANT_ADDRESS.toLowerCase());
      assert.equal(res.payerIsPool, false); // an ordinary account paid, not the shielded pool
    });

    it("A-01: underpayment, a different token, and a transfer to another address are all rejected", () => {
      const ctx = createDefaultCliContext();
      const inv = invoiceFor(ctx);
      assert.equal(ctx.merchantGateway.verifyPayment(inv.invoiceId, payOnChain(ctx, inv, inv.requiredAmount - 1n)).error, "ERR_UNDERPAYMENT");

      const inv2 = invoiceFor(ctx);
      const other = ctx.blockchain.getToken("0x002b2596ecf05c93a31ff916e8b456df6c77c750")!;
      assert.equal(ctx.merchantGateway.verifyPayment(inv2.invoiceId, payOnChain(ctx, inv2, inv2.requiredAmount, SIM_MERCHANT_ADDRESS, other)).error, "ERR_RECIPIENT_MISMATCH");

      const inv3 = invoiceFor(ctx);
      const elsewhere = payOnChain(ctx, { ephemeralAddress: VENDOR }, inv3.requiredAmount);
      assert.equal(ctx.merchantGateway.verifyPayment(inv3.invoiceId, elsewhere).error, "ERR_RECIPIENT_MISMATCH");
    });

    it("A-01: one transaction cannot settle two invoices (replay)", () => {
      const ctx = createDefaultCliContext();
      const a = invoiceFor(ctx);
      const b = invoiceFor(ctx);
      const hash = payOnChain(ctx, a, a.requiredAmount);
      assert.equal(ctx.merchantGateway.verifyPayment(a.invoiceId, hash).success, true);
      const replay = ctx.merchantGateway.verifyPayment(b.invoiceId, hash);
      assert.equal(replay.success, false);
      assert.equal(replay.statusCode, 409);
    });

    it("A-01: confirmations are counted from the receipt's block", () => {
      const ctx = createDefaultCliContext();
      const gw = new InboundMerchantGateway({
        masterMerchantKey: "confirmation-test-key", corporate0zkAddress: "0zk", corporateNpk: 1n, blockchain: ctx.blockchain, pool: ctx.pool, minConfirmations: 3
      });
      const inv = gw.createPaymentChallenge("/r", TOKEN_UNIT, ctx.token!.address).invoice;
      const hash = payOnChain(ctx, inv, TOKEN_UNIT);
      assert.equal(gw.verifyPayment(inv.invoiceId, hash).error, "ERR_PAYMENT_UNCONFIRMED");
      ctx.blockchain.mine(2);
      assert.equal(gw.verifyPayment(inv.invoiceId, hash).success, true);
    });

    it("A-13: inbound screening checks the PAYER, not the fresh ephemeral address", async () => {
      const ctx = createDefaultCliContext();
      const sanctioned = "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b";
      const inv = invoiceFor(ctx);
      const hash = payOnChain(ctx, inv, inv.requiredAmount, SIM_MERCHANT_ADDRESS);
      assert.equal(ctx.merchantGateway.verifyPayment(inv.invoiceId, hash).success, true);
      // the log says the payer was a sanctioned party
      inv.payerAddress = sanctioned.toLowerCase();
      (ctx.merchantGateway.sweeper as any).sanctionsRegistry = ctx.sanctionsRegistry;
      await reject(ctx.merchantGateway.sweepAndShield(inv.invoiceId), /SANCTIONED_DEPOSIT_DETECTED/);
      // funds stay put on the ephemeral address; nothing was shielded
      assert.equal(ctx.token!.balanceOf(inv.ephemeralAddress), inv.requiredAmount);
    });

    it("A-14: a sweep moves funds atomically: pool custody, fee to the relayer, note with the payer as origin", async () => {
      const ctx = createDefaultCliContext();
      (ctx.merchantGateway.sweeper as any).sweepFeeUnits = TOKEN_UNIT / 10n;
      const inv = invoiceFor(ctx);
      const hash = payOnChain(ctx, inv, inv.requiredAmount);
      ctx.merchantGateway.verifyPayment(inv.invoiceId, hash);
      const poolBefore = ctx.token!.balanceOf(ctx.pool.contractAddress);
      const relayerBefore = ctx.token!.balanceOf(ctx.relayer.relayerAddress);
      const receipt = await ctx.merchantGateway.sweepAndShield(inv.invoiceId);
      assert.equal(ctx.token!.balanceOf(inv.ephemeralAddress), 0n);
      assert.equal(ctx.token!.balanceOf(ctx.pool.contractAddress), poolBefore + receipt.sweptAmount);
      assert.equal(ctx.token!.balanceOf(ctx.relayer.relayerAddress), relayerBefore + receipt.feeAmount!);
      assert.equal(ctx.pool.utxoRegistry.get(receipt.shieldedCommitment.toString())!.depositorAddress, SIM_MERCHANT_ADDRESS.toLowerCase());
      assert.ok(ctx.pool.solvency().every((r) => r.ok));
    });

    it("A-01: live verification path reads the receipt from an injected async source and fails closed", async () => {
      const ctx = createDefaultCliContext();
      const inv = invoiceFor(ctx);
      const hash = payOnChain(ctx, inv, inv.requiredAmount);
      const real = ctx.blockchain.receipts.get(hash)!;
      const source: AsyncReceiptSource = {
        getReceipt: async () => ({ ok: real.status === 1, blockNumber: real.blockNumber, logs: real.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) }),
        headBlock: async () => ctx.blockchain.currentBlockNumber + 5
      };
      const gw = new InboundMerchantGateway({
        masterMerchantKey: "live-test-key", corporate0zkAddress: "0zk", corporateNpk: 1n, blockchain: ctx.blockchain, pool: ctx.pool, receiptSource: source
      });
      const inv2 = gw.createPaymentChallenge("/r", inv.requiredAmount, ctx.token!.address).invoice;
      const hash2 = payOnChain(ctx, inv2, inv2.requiredAmount);
      const real2 = ctx.blockchain.receipts.get(hash2)!;
      (source as any).getReceipt = async () => ({ ok: true, blockNumber: real2.blockNumber, logs: real2.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) });
      assert.equal((await gw.verifyPaymentAsync(inv2.invoiceId, hash2)).success, true);

      const inv3 = gw.createPaymentChallenge("/r", TOKEN_UNIT, ctx.token!.address).invoice;
      (source as any).getReceipt = async () => { throw new Error("rpc down"); };
      const down = await gw.verifyPaymentAsync(inv3.invoiceId, LONG_HASH("cc"));
      assert.equal(down.success, false);
      assert.equal(down.statusCode, 503);
    });
  });

  describe("resource server", () => {
    it("A-15: refuses to start without a gateway unless demo mode is explicit", () => {
      assert.throws(() => new ResourceServer(), /ERR_RESOURCE_SERVER_GATEWAY_REQUIRED/);
      assert.throws(() => new ResourceServer({ autoSweep: false }), /ERR_RESOURCE_SERVER_GATEWAY_REQUIRED/);
      assert.doesNotThrow(() => new ResourceServer({ demo: true }));
    });

    it("A-16: malformed credentials are a 400, not a fresh invoice", async () => {
      const ctx = createDefaultCliContext();
      const server = new ResourceServer(ctx.merchantGateway);
      const before = ctx.merchantGateway.invoiceRegistry.size;
      for (const bad of ["0xnothex", "x".repeat(500), "0x" + "g".repeat(64)]) {
        const res = await server.handleRequest("GET", "/api/v1/protected/analytics", { "x-payment-invoice-id": "inv_x", "x-payment-proof": bad });
        assert.equal(res.status, 400);
      }
      assert.equal(ctx.merchantGateway.invoiceRegistry.size, before);
    });

    it("A-17: the invoice registry is bounded", () => {
      const ctx = createDefaultCliContext();
      ctx.merchantGateway.invoiceRegistry.maxInvoices = 3;
      for (let i = 0; i < 3; i++) ctx.merchantGateway.createPaymentChallenge("/r", TOKEN_UNIT, ctx.token!.address);
      assert.throws(() => ctx.merchantGateway.createPaymentChallenge("/r", TOKEN_UNIT, ctx.token!.address), /ERR_INVOICE_CAPACITY/);
    });

    it("end to end: 402 -> shielded payment -> 200 with an honest decoupling header and a spendable swept note", async () => {
      const ctx = createDefaultCliContext();
      const server = new ResourceServer(ctx.merchantGateway);
      const challenge = await server.handleRequest("GET", "/api/v1/protected/analytics");
      assert.equal(challenge.status, 402);

      // a customer with their OWN shielded pool pays through the relayer
      const customer = createDefaultCliContext({ seed: "customer-treasury-seed-0123456789-abcdefgh" });
      customer.blockchain.registerToken(ctx.token!);
      const c = new SettlementCoordinator({
        spendingPolicy: { ...customer.spendingPolicy, maxPaymentCap: 100n * TOKEN_UNIT }, relayer: ctx.relayer, corporateKeys: ctx.corporateKeys as any,
        ppoiEngine: ctx.ppoiEngine, sanctionsRegistry: ctx.sanctionsRegistry, treasuryUTXOs: ctx.treasuryUTXOs
      });
      const parsed = (await import("../../src/proxy/parser.ts")).ChallengeParser.parse(challenge.headers, challenge.body);
      const { headers } = await c.settleChallenge(parsed);

      const res = await server.handleRequest("GET", "/api/v1/protected/analytics", headers as any);
      assert.equal(res.status, 200);
      assert.equal(res.headers["X-Payment-Relayer-Decoupled"], "true"); // payer on chain = the pool
      assert.equal(res.headers["X-Payment-Sweep"], undefined);
      // auto-sweep shielded the payment into the merchant's pool position
      const swept = ctx.merchantGateway.invoiceRegistry.get(parsed.invoiceId)!;
      assert.equal(swept.status, "SWEPT");
    });

    it("A-18: a failed sweep is reported, not swallowed", async () => {
      const ctx = createDefaultCliContext();
      const seen: string[] = [];
      const server = new ResourceServer({ gateway: ctx.merchantGateway, onSweepError: (id) => seen.push(id) });
      const challenge = await server.handleRequest("GET", "/api/v1/protected/analytics");
      const inv = ctx.merchantGateway.invoiceRegistry.get(challenge.headers["X-Payment-Invoice-Id"])!;
      const hash = payOnChain(ctx, inv, inv.requiredAmount);
      ctx.merchantGateway.sweeper.minSweepThreshold = 10n ** 40n; // make the sweep fail
      const res = await server.handleRequest("GET", "/api/v1/protected/analytics", { "x-payment-invoice-id": inv.invoiceId, "x-payment-proof": hash });
      assert.equal(res.status, 200); // the customer still gets what they paid for
      assert.match(res.headers["X-Payment-Sweep"], /^deferred; reason=/);
      assert.deepEqual(seen, [inv.invoiceId]);
    });
  });

  describe("cryptographic hygiene", () => {
    it("C-01: Fp.random is uniform in [0, p) and canonical() refuses out-of-range spellings", () => {
      for (let i = 0; i < 2000; i++) {
        const r = Fp.random();
        assert.ok(r >= 0n && r < Fp.p);
      }
      assert.equal(Fp.canonical("0x10"), 16n);
      assert.equal(Fp.canonical("16"), 16n);
      assert.throws(() => Fp.canonical(Fp.p), /OUT_OF_RANGE/);
      assert.throws(() => Fp.canonical(-1n), /OUT_OF_RANGE/);
      assert.throws(() => Fp.canonical("0xzz"), /MALFORMED/);
      assert.throws(() => Fp.canonical("1e3"), /MALFORMED/);
    });

    it("C-02: small-order and identity points are not valid viewing keys or ephemeral keys", () => {
      const order2: [bigint, bigint] = [0n, Fp.p - 1n]; // on the curve, order 2
      assert.equal(isInPrimeSubgroup(BASE8), true);
      assert.equal(isInPrimeSubgroup(order2), false);
      assert.equal(isIdentity([0n, 1n]), true);
      assert.equal(isInPrimeSubgroup([0n, 1n]), false);
      assert.equal(isInPrimeSubgroup([1n, 1n]), false); // not even on the curve

      const payload = { version: 1, token: "0x1", value: "1", blinding: "0x1", npk: "0x1", direction: "INBOUND_SWEEP" as const, counterparty: "x", memo: "m", timestamp: 1 };
      assert.throws(() => encryptNotePayload(order2, payload as any), /ERR_NOTE_RECIPIENT_KEY_INVALID/);
      const ok = encryptNotePayload(BASE8, payload as any);
      assert.ok(decryptNotePayload(1n, ok));
      assert.equal(decryptNotePayload(1n, { ...ok, ephemeralPubKey: ["0", (Fp.p - 1n).toString(16)] }), null);
    });

    it("C-03: seeds that ship in the repo or are too short are refused at entry points", () => {
      for (const s of PUBLIC_DEMO_SEEDS) assert.throws(() => assertStrongSeed(s), /ERR_SEED_PUBLIC_DEMO/);
      assert.throws(() => assertStrongSeed("hunter2"), /ERR_SEED_WEAK/);
      assert.throws(() => assertStrongSeed("0x1234"), /ERR_SEED_WEAK/);
      assert.throws(() => assertStrongSeed(Buffer.alloc(8)), /ERR_SEED_WEAK/);
      assert.doesNotThrow(() => assertStrongSeed(generateSeed()));
      assert.doesNotThrow(() => assertStrongSeed(Buffer.alloc(32, 7)));
    });
  });
});
