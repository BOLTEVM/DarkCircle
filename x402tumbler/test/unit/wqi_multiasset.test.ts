/**
 * DarkCircle Protocol: WQI pool and multi-asset tests
 * File: test/unit/wqi_multiasset.test.ts
 *
 * WQUAI and WQI each get their own pool, relayer, gateway, treasury and journal on one shared ledger.
 * WQI is the token with EIP-2612 permit, so it is also the one that can be swept without gas.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { createDefaultCliContext, createMultiAssetEnvironment } from "../../src/cli/context.ts";
import { runChecklist } from "../../src/checklist/shieldedTx.ts";
import { runCli } from "../../src/cli/index.ts";
import { CliExitCode } from "../../src/cli/types.ts";
import { SimulatedBlockchain } from "../../src/sim/blockchain.ts";
import { ERC20Token, ERC20_ABI, PERMIT_TYPES, WQI_ADDRESS, WQUAI_ADDRESS } from "../../src/sim/erc20Token.ts";
import { SIM_MERCHANT_ADDRESS, SIM_VENDOR_ADDRESS, SIM_POOL_ADDRESS, SIM_POOL_WQI_ADDRESS } from "../../src/sim/defaults.ts";
import type { CliContext } from "../../src/cli/types.ts";

const UNIT = 10n ** 18n;
const VENDOR = SIM_VENDOR_ADDRESS;

/** A customer pays an invoice with a real transfer transaction; returns the hash. */
function payOnChain(ctx: CliContext, invoice: { ephemeralAddress: string }, amount: bigint): string {
  ctx.token!.mint(SIM_MERCHANT_ADDRESS, amount);
  const r = ctx.blockchain.executeTransaction({
    from: SIM_MERCHANT_ADDRESS,
    to: ctx.token!.address,
    data: new ethers.Interface(ERC20_ABI).encodeFunctionData("transfer", [invoice.ephemeralAddress, amount])
  });
  assert.equal(r.status, 1, r.error);
  return r.transactionHash;
}

async function settledInvoice(ctx: CliContext, amount = 4n * UNIT) {
  const inv = ctx.merchantGateway.createPaymentChallenge("/r", amount, ctx.token!.address, ctx.token!.symbol, 18).invoice;
  const hash = payOnChain(ctx, inv, amount);
  assert.equal(ctx.merchantGateway.verifyPayment(inv.invoiceId, hash).success, true);
  return inv;
}

describe("WQI pool and multi-asset environment", () => {
  describe("two pools on one ledger", () => {
    it("each asset has its own pool, relayer, gateway, treasury and journal; the ledger is shared", () => {
      const env = createMultiAssetEnvironment();
      const q = env.lanes.WQUAI;
      const w = env.lanes.WQI;
      assert.deepEqual(env.assets, ["WQUAI", "WQI"]);
      assert.equal(q.blockchain, w.blockchain); // one ledger: one block height, one relayer gas balance
      assert.equal(q.pool.contractAddress, SIM_POOL_ADDRESS);
      assert.equal(w.pool.contractAddress, SIM_POOL_WQI_ADDRESS);
      assert.notEqual(q.pool, w.pool);
      assert.notEqual(q.merchantGateway, w.merchantGateway);
      assert.equal(q.relayer.relayerAddress, w.relayer.relayerAddress); // same operator
      assert.equal(q.journal!.assetSymbol, "WQUAI");
      assert.equal(w.journal!.assetSymbol, "WQI");
      assert.equal(q.treasuryUTXOs.length + w.treasuryUTXOs.length, 2);
      assert.equal(w.token!.address, WQI_ADDRESS.toLowerCase());
      // both pools are custodied and solvent
      assert.equal(w.token!.balanceOf(w.pool.contractAddress), 100n * UNIT);
      assert.equal(q.token!.balanceOf(q.pool.contractAddress), 100n * UNIT);
      assert.ok(q.pool.solvency().every((r) => r.ok) && w.pool.solvency().every((r) => r.ok));
      assert.equal(w.pool.status().mode, "verified");
      // the operating wallet holds both assets
      assert.equal(w.token!.balanceOf(w.corporateOperatingAddress!), 50n * UNIT);
      assert.equal(q.token!.balanceOf(q.corporateOperatingAddress!), 50n * UNIT);
    });

    it("a pool accepts only its own asset", () => {
      const { lanes } = createMultiAssetEnvironment();
      const keys = lanes.WQI.corporateKeys;
      lanes.WQUAI.token!.mint(SIM_MERCHANT_ADDRESS, UNIT);
      lanes.WQUAI.token!.approve(lanes.WQI.pool.contractAddress, UNIT, SIM_MERCHANT_ADDRESS);
      assert.throws(
        () => lanes.WQI.pool.shield(WQUAI_ADDRESS.toLowerCase(), UNIT, keys.npk, 5n, "wrong pool", SIM_MERCHANT_ADDRESS),
        /ERR_TOKEN_NOT_ALLOWED/
      );
      assert.equal(lanes.WQI.pool.merkleTree.nextIndex, 1);
    });

    it("the WQI lane refuses to pay WQUAI, and its checklist says why", async () => {
      const { lanes } = createMultiAssetEnvironment();
      const res = await runCli(["pay", "--recipient", VENDOR, "--amount", "1", "--token", "wquai", "--json"], lanes.WQI);
      assert.notEqual(res.exitCode, CliExitCode.SUCCESS);
      const cl = runChecklist("unshield", { address: VENDOR, amount: "1", token: "WQUAI" }, lanes.WQI);
      assert.equal(cl.items.find((i) => i.id === "SP-IN-01")!.status, "fail");
      assert.equal(cl.canProceed, false);
    });

    it("paying in WQI moves only WQI: fee in WQI, WQUAI pool untouched, block height shared", async () => {
      const { lanes } = createMultiAssetEnvironment();
      const q = lanes.WQUAI;
      const w = lanes.WQI;
      const qBefore = q.token!.balanceOf(q.pool.contractAddress);
      const blockBefore = w.blockchain.currentBlockNumber;
      const res = await runCli(["pay", "--recipient", VENDOR, "--amount", "5", "--json"], w);
      assert.equal(res.exitCode, CliExitCode.SUCCESS, res.stderr);
      assert.equal(w.token!.balanceOf(VENDOR), 5n * UNIT);
      assert.equal(w.token!.balanceOf(w.relayer.relayerAddress), w.relayer.minimumFee);
      assert.equal(q.token!.balanceOf(VENDOR), 0n);
      assert.equal(q.token!.balanceOf(q.pool.contractAddress), qBefore);
      assert.ok(w.blockchain.currentBlockNumber > blockBefore);
      assert.equal(q.blockchain.currentBlockNumber, w.blockchain.currentBlockNumber);
      assert.equal(w.pool.status().spentNullifiers, 1);
      assert.equal(q.pool.status().spentNullifiers, 0);
      assert.ok(w.pool.solvency().every((r) => r.ok));
      // the WQI journal recorded it; the WQUAI journal did not
      assert.equal(w.journal!.entries.length, 2);
      assert.equal(q.journal!.entries.length, 1);
    });

    it("a transaction that paid a WQI invoice cannot settle a WQUAI invoice", async () => {
      const { lanes } = createMultiAssetEnvironment();
      const wInv = await settledInvoice(lanes.WQI, UNIT);
      const qInv = lanes.WQUAI.merchantGateway.createPaymentChallenge("/r", UNIT, lanes.WQUAI.token!.address).invoice;
      const wHash = lanes.WQI.merchantGateway.invoiceRegistry.get(wInv.invoiceId)!.settlementTxHash!;
      const res = lanes.WQUAI.merchantGateway.verifyPayment(qInv.invoiceId, wHash);
      assert.equal(res.success, false);
      assert.equal(res.error, "ERR_RECIPIENT_MISMATCH");
    });

    it("audit reports are per asset and reconcile independently", async () => {
      const { lanes } = createMultiAssetEnvironment();
      await runCli(["pay", "--recipient", VENDOR, "--amount", "2", "--json"], lanes.WQI);
      const w = JSON.parse((await runCli(["audit", "--format", "json"], lanes.WQI)).stdout);
      const q = JSON.parse((await runCli(["audit", "--format", "json"], lanes.WQUAI)).stdout);
      assert.equal(w.financialSummary.assetSymbol, "WQI");
      assert.equal(q.financialSummary.assetSymbol, "WQUAI");
      assert.equal(w.financialSummary.endingShieldedBalance.formatted, "97.500000000000000000");
      assert.equal(q.financialSummary.endingShieldedBalance.formatted, "100.000000000000000000");
      assert.ok(lanes.WQI.journal!.verifyReconciliation() && lanes.WQUAI.journal!.verifyReconciliation());
    });
  });

  describe("WQI: EIP-2612 permit and the gasless sweep", () => {
    it("the simulated permit domain hashes to the deployed WQI contract's DOMAIN_SEPARATOR", () => {
      // 0xd2b1…fdc0 was read from WQI on Cyprus-1 on 2026-09-21 (`pnpm verify:quai` re-checks it live).
      const chain = new SimulatedBlockchain();
      assert.equal(
        ERC20Token.createWQI(chain).DOMAIN_SEPARATOR(),
        "0xd2b1836a50194d1efa6aba84257c050eed7b08e6354c4414ddfda829e3a4fdc0"
      );
    });

    it("a WQI sweep is signed with the payee key as an EIP-2612 permit and needs no gas at the payee address", async () => {
      const { lanes } = createMultiAssetEnvironment();
      const w = lanes.WQI;
      assert.equal((w.merchantGateway.sweeper as any).gasSponsorshipMode, "PERMIT_SPONSORED");
      const inv = await settledInvoice(w);
      w.blockchain.setBalance(inv.ephemeralAddress, 0n); // the fresh address holds no QUAI at all
      const nonceBefore = w.token!.nonces(inv.ephemeralAddress);
      const poolBefore = w.token!.balanceOf(w.pool.contractAddress);

      const receipt = await w.merchantGateway.sweepAndShield(inv.invoiceId);

      assert.equal(receipt.sweepMethod, "permit");
      assert.equal(w.token!.nonces(inv.ephemeralAddress), nonceBefore + 1n); // the permit was consumed
      assert.ok(w.token!.events.some((e) => e.event === "Approval" && e.owner === inv.ephemeralAddress.toLowerCase() && e.spender === w.pool.contractAddress.toLowerCase()));
      assert.equal(w.blockchain.getBalance(inv.ephemeralAddress), 0n); // no gas was needed or spent
      assert.equal(w.token!.balanceOf(inv.ephemeralAddress), 0n);
      assert.equal(w.token!.balanceOf(w.pool.contractAddress), poolBefore + receipt.sweptAmount);
      assert.equal(w.pool.utxoRegistry.get(receipt.shieldedCommitment.toString())!.depositorAddress, SIM_MERCHANT_ADDRESS.toLowerCase());
      assert.ok(w.pool.solvency().every((r) => r.ok));
      assert.equal(w.merchantGateway.invoiceRegistry.get(inv.invoiceId)!.status, "SWEPT");
    });

    it("WQUAI has no permit, so its sweep uses an allowance and the relayer must fund gas", async () => {
      const { lanes } = createMultiAssetEnvironment();
      const q = lanes.WQUAI;
      assert.equal((q.merchantGateway.sweeper as any).gasSponsorshipMode, "RELAYER_BROADCAST");
      const inv = await settledInvoice(q);
      const receipt = await q.merchantGateway.sweepAndShield(inv.invoiceId);
      assert.equal(receipt.sweepMethod, "allowance");
    });

    it("a permit signed by the wrong key is rejected and nothing moves", async () => {
      const { lanes } = createMultiAssetEnvironment();
      const w = lanes.WQI;
      const inv = await settledInvoice(w);
      const real = inv.ephemeralPrivateKey;
      inv.ephemeralPrivateKey = ethers.Wallet.createRandom().privateKey; // an attacker's key, not the payee's
      const leaves = w.pool.merkleTree.nextIndex;
      await assert.rejects(w.merchantGateway.sweepAndShield(inv.invoiceId), /ERC20_PERMIT_INVALID_SIGNATURE/);
      assert.equal(w.token!.balanceOf(inv.ephemeralAddress), inv.requiredAmount); // funds still there
      assert.equal(w.pool.merkleTree.nextIndex, leaves); // nothing shielded
      assert.equal(w.token!.nonces(inv.ephemeralAddress), 0n);
      // with the right key the same invoice then sweeps normally
      inv.ephemeralPrivateKey = real;
      assert.equal((await w.merchantGateway.sweepAndShield(inv.invoiceId)).sweepMethod, "permit");
    });

    it("a permit cannot be replayed: the nonce is consumed", async () => {
      const chain = new SimulatedBlockchain();
      const wqi = ERC20Token.createWQI(chain);
      const owner = ethers.Wallet.createRandom();
      const spender = SIM_POOL_WQI_ADDRESS;
      const deadline = chain.latestBlock.timestamp + 600;
      const sign = () => owner.signTypedData(wqi.permitDomain(), PERMIT_TYPES, { owner: owner.address, spender, value: UNIT, nonce: wqi.nonces(owner.address), deadline });
      const sig = ethers.Signature.from(await sign());
      assert.equal(wqi.permit(owner.address, spender, UNIT, deadline, sig.v, sig.r, sig.s), true);
      assert.equal(wqi.allowance(owner.address, spender), UNIT);
      assert.throws(() => wqi.permit(owner.address, spender, UNIT, deadline, sig.v, sig.r, sig.s), /ERC20_PERMIT_INVALID_SIGNATURE/);
      // a permit for a different value than was signed fails too
      const sig2 = ethers.Signature.from(await sign());
      assert.throws(() => wqi.permit(owner.address, spender, UNIT * 2n, deadline, sig2.v, sig2.r, sig2.s), /ERC20_PERMIT_INVALID_SIGNATURE/);
    });

    it("the CLI reports the sweep method and reads the key zeroization back instead of asserting it", async () => {
      const { lanes } = createMultiAssetEnvironment();
      const w = lanes.WQI;
      const inv = await settledInvoice(w);
      const out = JSON.parse((await runCli(["sweep", "--invoice", inv.invoiceId, "--json"], w)).stdout);
      assert.equal(out.sweepMethod, "permit");
      assert.equal(out.forwardSecrecyKeyZeroization, "CONFIRMED");
      assert.match(w.merchantGateway.invoiceRegistry.get(inv.invoiceId)!.ephemeralPrivateKey, /^0x0+$/);
    });

    it("the WQI checklist shows gasless sweeping, and refuses to wrap QUAI into WQI", () => {
      const { lanes } = createMultiAssetEnvironment();
      const w = lanes.WQI;
      assert.equal(runChecklist("receive", { amount: "5" }, w).items.find((i) => i.id === "SP-RC-03")!.status, "pass");
      assert.equal(runChecklist("shield", { amount: "1", wrapNative: true }, w).items.find((i) => i.id === "SP-FN-06")!.status, "fail");
      assert.equal(runChecklist("shield", { amount: "10" }, w).canProceed, true);
    });

    it("shielding WQI works over the CLI with WQI as the default asset", async () => {
      const w = createDefaultCliContext({ asset: "WQI" });
      const res = await runCli(["shield", "--amount", "10", "--json"], w);
      assert.equal(res.exitCode, CliExitCode.SUCCESS, res.stderr);
      assert.equal(JSON.parse(res.stdout).symbol, "WQI");
      assert.equal(w.pool.contractAddress, SIM_POOL_WQI_ADDRESS);
      assert.ok(w.pool.solvency().every((r) => r.ok));
    });
  });
});
