/**
 * DarkCircle: relayer online/offline control
 * File: test/unit/relayer_control.test.ts
 *
 * An operator can take the relayer offline. While it is offline every broadcast and every sweep must refuse
 * cleanly (ERR_RELAYER_OFFLINE), change nothing, and the checklist must say so before anything is sent.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { createDefaultCliContext } from "../../src/cli/context.ts";
import { runCli } from "../../src/cli/index.ts";
import { runChecklist } from "../../src/checklist/shieldedTx.ts";
import { ERC20_ABI } from "../../src/sim/erc20Token.ts";
import { SIM_MERCHANT_ADDRESS, SIM_VENDOR_ADDRESS } from "../../src/sim/defaults.ts";

const ONE = 10n ** 18n;

async function settledInvoice(ctx: ReturnType<typeof createDefaultCliContext>, amount = 5n * ONE) {
  const inv = ctx.merchantGateway.createPaymentChallenge("/r", amount, ctx.token!.address).invoice;
  ctx.token!.mint(SIM_MERCHANT_ADDRESS, amount);
  const tx = ctx.blockchain.executeTransaction({
    from: SIM_MERCHANT_ADDRESS,
    to: ctx.token!.address,
    data: new ethers.Interface(ERC20_ABI).encodeFunctionData("transfer", [inv.ephemeralAddress, amount])
  });
  assert.equal(tx.status, 1);
  const verified = await (ctx.merchantGateway as any).verifyPaymentAsync(inv.invoiceId, tx.transactionHash);
  assert.equal(verified.success, true);
  return inv;
}

describe("relayer control", () => {
  it("starts online, and going offline records the reason", () => {
    const ctx = createDefaultCliContext();
    assert.equal(ctx.relayer.online, true);
    ctx.relayer.setOnline(false, "maintenance window");
    assert.equal(ctx.relayer.online, false);
    assert.equal(ctx.relayer.offlineReason, "maintenance window");
    assert.throws(() => ctx.relayer.assertOnline(), /ERR_RELAYER_OFFLINE: maintenance window/);
    ctx.relayer.setOnline(true);
    assert.equal(ctx.relayer.offlineReason, undefined);
    ctx.relayer.assertOnline();
  });

  it("an offline relayer refuses a payment and moves nothing", async () => {
    const ctx = createDefaultCliContext();
    ctx.relayer.setOnline(false, "incident 42");
    const notes = ctx.treasuryUTXOs.map((u) => u.commitment);
    const before = ctx.token!.balanceOf(SIM_VENDOR_ADDRESS);
    const res = await runCli(["pay", "--recipient", SIM_VENDOR_ADDRESS, "--amount", "3", "--json"], ctx);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.stderr, /ERR_RELAYER_OFFLINE: incident 42/);
    assert.equal(ctx.token!.balanceOf(SIM_VENDOR_ADDRESS), before);
    assert.deepEqual(ctx.treasuryUTXOs.map((u) => u.commitment), notes, "the spent note must still be spendable");
    assert.equal(ctx.spendTracker!.spent(ctx.token!.address), 0n, "a refused payment must not count against the daily budget");
    assert.ok((ctx.pool as any).solvency().every((r: any) => r.ok));

    ctx.relayer.setOnline(true);
    const ok = await runCli(["pay", "--recipient", SIM_VENDOR_ADDRESS, "--amount", "3", "--json"], ctx);
    assert.equal(ok.exitCode, 0, ok.stderr);
  });

  it("the checklist blocks a payment and a sweep, and only informs a shield", () => {
    const ctx = createDefaultCliContext();
    ctx.relayer.setOnline(false, "maintenance");
    const pay = runChecklist("unshield", { address: SIM_VENDOR_ADDRESS, amount: "5" }, ctx);
    const ex04 = pay.items.find((i) => i.id === "SP-EX-04")!;
    assert.equal(ex04.status, "fail");
    assert.equal(ex04.blocking, true);
    assert.match(ex04.detail, /OFFLINE \(maintenance\)/);
    assert.equal(pay.canProceed, false);

    const shield = runChecklist("shield", { amount: "10" }, ctx);
    assert.equal(shield.items.find((i) => i.id === "SP-EX-04")!.status, "info");
    assert.equal(shield.canProceed, true, "a shield is sent by the depositor and must not need the relayer");

    ctx.relayer.setOnline(true);
    const back = runChecklist("unshield", { address: SIM_VENDOR_ADDRESS, amount: "5" }, ctx);
    assert.equal(back.items.find((i) => i.id === "SP-EX-04")!.status, "pass");
    assert.equal(back.canProceed, true);
  });

  it("an offline relayer defers a sweep: funds stay on the payee address, the invoice stays SETTLED, and it sweeps once the relayer is back", async () => {
    const ctx = createDefaultCliContext();
    ctx.relayer.setOnline(false, "maintenance");
    const inv = await settledInvoice(ctx);
    const record = (ctx.merchantGateway as any).invoiceRegistry.get(inv.invoiceId);
    assert.equal(record.status, "SETTLED", "auto-sweep must not have run");
    assert.equal(ctx.token!.balanceOf(inv.ephemeralAddress), 5n * ONE);

    await assert.rejects(ctx.merchantGateway.sweeper.sweepAndShield(inv.invoiceId), /ERR_RELAYER_OFFLINE: maintenance/);
    assert.equal(record.status, "SETTLED");
    assert.notEqual(record.ephemeralPrivateKey, undefined);
    assert.equal(ctx.token!.balanceOf(inv.ephemeralAddress), 5n * ONE, "funds must not have moved");

    const sweepChecklist = runChecklist("sweep", { invoiceId: inv.invoiceId }, ctx);
    assert.equal(sweepChecklist.items.find((i) => i.id === "SP-EX-04")!.status, "fail");
    assert.equal(sweepChecklist.canProceed, false);

    ctx.relayer.setOnline(true);
    const swept = await ctx.merchantGateway.sweeper.sweepAndShield(inv.invoiceId);
    assert.ok(swept);
    assert.equal(record.status, "SWEPT");
    assert.ok((ctx.pool as any).solvency().every((r: any) => r.ok));
  });

  it("the gas alert threshold is configurable and drives SP-EX-02", () => {
    const ctx = createDefaultCliContext();
    const gas = ctx.blockchain.getBalance(ctx.relayer.relayerAddress);
    ctx.relayer.setMinGasBalance(gas + 1n);
    const low = runChecklist("unshield", { address: SIM_VENDOR_ADDRESS, amount: "5" }, ctx).items.find((i) => i.id === "SP-EX-02")!;
    assert.equal(low.status, "warn");
    ctx.relayer.setMinGasBalance(gas);
    assert.equal(runChecklist("unshield", { address: SIM_VENDOR_ADDRESS, amount: "5" }, ctx).items.find((i) => i.id === "SP-EX-02")!.status, "pass");
    assert.throws(() => ctx.relayer.setMinGasBalance(-1n), /NON_NEGATIVE/);
  });
});
