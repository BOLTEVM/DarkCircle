import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";
import { expect } from "chai";
import type { Wallet } from "ethers";
import {
  mineVaultSalt,
  walletCreatedFromLogs,
  vaultCalls,
  adminCalls,
  proposedHashFromLogs,
  readChainClock,
  chooseExpiration,
  reviewDigest,
  formatDigest,
  vaultInterface,
} from "@safebuddy/core";
import type { RpcLike, VaultDeployment } from "@safebuddy/core";
import { runVerify, EXIT } from "@safebuddy/verify";
import { pollOnce, emptyState } from "@safebuddy/watcher";
import type { Alert, WatcherState } from "@safebuddy/watcher";
import { hardhatQuaiRpc, quaiWallets, deployCyprusV2 } from "./quai-shim.ts";

const { ethers, network } = hre;
const EXEC = { gasLimit: 5_000_000 };

describe("safebuddy-verify and the watcher against the real v2 contracts", function () {
  this.timeout(180_000);

  let rpc: RpcLike;
  let deployment: VaultDeployment;
  let owners: Wallet[];
  let vault: string;
  let chainId: number;

  const send = async (from: Wallet, data: string) => (await (await from.sendTransaction({ to: vault, data, ...EXEC })).wait())!;
  const verify = async (argv: string[], sources: RpcLike[] = [rpc]) => {
    const lines: string[] = [];
    let i = 0;
    const code = await runVerify([...argv, "--chain-id", String(chainId), ...sources.flatMap((_, k) => ["--rpc", `hh${k}`])], {
      makeRpc: () => sources[i++]!,
      write: (l) => lines.push(l),
    });
    return { code, out: lines.join("\n") };
  };
  const kinds = (alerts: Alert[]) => alerts.map((a) => `${a.level}:${a.kind}`);

  before(async () => {
    const v2 = await deployCyprusV2();
    deployment = v2.deployment;
    chainId = deployment.chainId;
    rpc = hardhatQuaiRpc();
    owners = await quaiWallets(3);
    const params = { owners: owners.map((o) => o.address), threshold: 2, minExecutionDelay: 3600 };
    const mined = mineVaultSalt({ factory: deployment.factory, implementation: deployment.implementation, creator: owners[0]!.address, params });
    const receipt = await (await v2.factory.connect(owners[0]!).createWallet(params.owners, 2, 3600, mined.salt)).wait();
    vault = walletCreatedFromLogs(receipt.logs, deployment.factory).wallet;
  });

  it("verifies a factory, a vault and a transaction, and fails closed", async () => {
    const f = await verify(["factory", deployment.factory]);
    expect(f.code).to.equal(EXIT.OK);
    expect(f.out).to.contain("is a genuine SafeBuddy v2 factory");

    const v = await verify(["vault", vault, "--factory", deployment.factory], [rpc, hardhatQuaiRpc()]);
    expect(v.code, v.out).to.equal(EXIT.OK);
    expect(v.out).to.contain("2 sources agree");
    expect(v.out).to.contain("approvals needed: 2 of 3");
    expect(v.out).to.contain("timelock: 1h");

    const clock = await readChainClock(rpc);
    const hash = proposedHashFromLogs(
      (await send(owners[0]!, vaultCalls.propose({ to: vault, value: 0n, data: adminCalls.changeThreshold(1), gasLimit: 0n, expiration: chooseExpiration(clock, 0), requestedDelay: 0 }))).logs as any,
      vault
    );
    const t = await verify(["tx", vault, hash, "--factory", deployment.factory]);
    expect(t.code, t.out).to.equal(EXIT.OK);
    expect(t.out).to.contain("re-derives from its stored contents");
    expect(t.out).to.contain("what it does: Change threshold to 1");
    expect(t.out).to.match(/CRITICAL/);
    // The same digest the web app shows for this transaction.
    const digest = formatDigest(reviewDigest({ txHash: hash, owners: owners.map((o) => o.address), threshold: 2, minExecutionDelay: 3600 }));
    expect(t.out).to.contain(`review digest: ${digest}`);

    const getTx = vaultInterface.getFunction("getTransaction")!.selector;
    const liar = hardhatQuaiRpc((method, params: any[], result) => {
      if (method !== "quai_call" || !String(params[0]?.data).startsWith(getTx)) return result;
      const [tx] = vaultInterface.decodeFunctionResult("getTransaction", result);
      return vaultInterface.encodeFunctionResult("getTransaction", [{ ...tx.toObject(), data: adminCalls.changeThreshold(2) }]);
    });
    expect((await verify(["tx", vault, hash, "--factory", deployment.factory], [rpc, liar])).code).to.equal(EXIT.DISAGREEMENT);
    expect((await verify(["tx", vault, hash, "--factory", deployment.factory], [liar])).code).to.equal(EXIT.FAILED);
    const impostor = await verify(["vault", owners[1]!.address, "--factory", deployment.factory]);
    expect(impostor.code).to.equal(EXIT.FAILED);
    expect(impostor.out).to.contain("no contract code");

    // Leave the vault as it was for the watcher test.
    await send(owners[0]!, vaultCalls.cancel(hash));
  });

  it("reports proposals, quorum, execution and governance changes once each", async () => {
    let state: WatcherState = emptyState(chainId);
    const deps = { sources: [{ name: "rpc", rpc }], deployment, vaults: [vault], confirmations: 1, largeValueWei: ethers.parseEther("1") };
    const poll = async () => {
      const r = await pollOnce(state, deps);
      state = r.state;
      return r.alerts;
    };

    expect(kinds(await poll())).to.deep.equal(["info:watching"]);
    expect(await poll(), "no new block, nothing to say").to.deep.equal([]);

    const clock = await readChainClock(rpc);
    const hash = proposedHashFromLogs(
      (await send(owners[0]!, vaultCalls.propose({ to: vault, value: 0n, data: adminCalls.changeThreshold(3), gasLimit: 0n, expiration: chooseExpiration(clock, 0), requestedDelay: 0 }))).logs as any,
      vault
    );
    const proposed = await poll();
    expect(kinds(proposed)).to.deep.equal(["critical:proposed"]);
    expect(proposed[0]!.message).to.contain("Change threshold to 3");

    await send(owners[1]!, vaultCalls.approve(hash));
    expect(kinds(await poll())).to.deep.equal(["critical:threshold-reached"]);

    await send(owners[2]!, vaultCalls.execute(hash));
    expect(kinds(await poll()).sort()).to.deep.equal(["high:threshold-changed", "info:executed"]);
    expect(Object.keys(state.vaults[vault]!.open)).to.deep.equal([]);
    expect(state.vaults[vault]!.threshold).to.equal(3);
  });

  it("notices when the block it last confirmed is reorganised away", async () => {
    let state: WatcherState = emptyState(chainId);
    const deps = { sources: [{ name: "rpc", rpc }], deployment, vaults: [vault], confirmations: 1 };
    const snapshot = await network.provider.send("evm_snapshot", []);
    await network.provider.send("evm_mine", []);
    state = (await pollOnce(state, deps)).state;

    await network.provider.send("evm_revert", [snapshot]);
    const latest = await ethers.provider.getBlock("latest");
    await network.provider.send("evm_setNextBlockTimestamp", [latest!.timestamp + 777]);
    await network.provider.send("evm_mine", []);
    await network.provider.send("evm_mine", []);

    const { alerts } = await pollOnce(state, deps);
    expect(kinds(alerts)).to.include("high:reorg");
  });
});
