import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  encodeDepositNative,
  encodeDepositWquai,
  encodeRequestWithdrawal,
  encodeProcessWithdrawals,
  encodeClaimWithdrawal,
  readLiquidStakingSnapshot,
  readLiquidWithdrawalRequest,
  readLiquidWithdrawalRequests,
  type BatchFn
} from "../../quai-service/src/liquidStaking";
import { previewLiquidStakingDeposit, previewLiquidStakingRedeem } from "../../quai-service/src/liquidStakingMath";
import { DAY, E18, SEED, deadline } from "./liquidStakingTestUtils";

const batch: BatchFn = async calls => Promise.all(calls.map(async call => {
  try {
    return { ok: true as const, value: await ethers.provider.send(call.method.replace(/^quai_/, "eth_"), call.params as any[]) };
  } catch (error: any) {
    return { ok: false as const, error: error?.message ?? String(error) };
  }
}));

function env(from: string): RunnerEnv {
  return {
    rpc: (method, params) => method === "quai_createAccessList"
      ? Promise.resolve({ accessList: [] })
      : ethers.provider.send(method.replace(/^quai_/, "eth_"), params as any[]),
    wallet: {
      request: async ({ method, params }) => {
        if (method !== "quai_sendTransaction") throw Object.assign(new Error("Method not found"), { code: -32601 });
        const tx: any = (params as any[])[0];
        const signer = await ethers.getSigner(tx.from);
        const sent = await signer.sendTransaction({
          data: tx.data,
          to: tx.to,
          value: BigInt(tx.value ?? 0),
          gasLimit: BigInt(tx.gas),
          ...(tx.nonce !== undefined ? { nonce: Number(BigInt(tx.nonce)) } : {})
        });
        return sent.hash;
      }
    },
    from,
    chainId: 9,
    confirmations: 0,
    pollMs: 1,
    receiptTimeoutMs: 20_000,
    zoneCheck: () => {}
  };
}

async function fixture() {
  const [owner, alice] = await ethers.getSigners();
  const wquai = await (await ethers.getContractFactory("MockWQUAI")).deploy();
  const strategy = await (await ethers.getContractFactory("MockQuaiYieldStrategy")).deploy(await wquai.getAddress());
  const vault = await (await ethers.getContractFactory("QuaiLiquidStaking")).deploy(
    await wquai.getAddress(), await strategy.getAddress(), DAY, owner.address, { value: SEED }
  );
  return { owner, alice, wquai, strategy, vault };
}

describe("liquid-staking client parity", function () {
  this.timeout(120_000);

  it("matches vault calldata and BigInt share previews", async function () {
    const { alice, vault } = await fixture();
    const dl = BigInt(await deadline());
    expect(encodeDepositNative(3n, dl)).to.equal(vault.interface.encodeFunctionData("depositNative", [3n, dl]));
    expect(encodeDepositWquai(5n, 3n, dl)).to.equal(vault.interface.encodeFunctionData("depositWquai", [5n, 3n, dl]));
    expect(encodeRequestWithdrawal(7n, 6n, alice.address)).to.equal(vault.interface.encodeFunctionData("requestWithdrawal", [7n, 6n, alice.address]));
    expect(encodeProcessWithdrawals(20n)).to.equal(vault.interface.encodeFunctionData("processWithdrawals", [20n]));
    expect(encodeClaimWithdrawal(2n)).to.equal(vault.interface.encodeFunctionData("claimWithdrawal", [2n]));

    const managed = await vault.totalManagedAssets();
    const supply = await (await ethers.getContractAt("StQuai", await vault.stQUAI())).totalSupply();
    for (const assets of [1n, E18, 10_000n * E18]) {
      expect(previewLiquidStakingDeposit(assets, managed, supply)).to.equal(await vault.previewDeposit(assets));
      expect(previewLiquidStakingRedeem(assets, managed, supply)).to.equal(await vault.previewRedeem(assets));
    }
  });

  it("reads complete vault, wallet, and withdrawal-request snapshots", async function () {
    const { alice, vault } = await fixture();
    await vault.connect(alice).depositNative(0, await deadline(), { value: 5n * E18 });
    const snapshot = await readLiquidStakingSnapshot(batch, await vault.getAddress(), alice.address);
    expect(snapshot.managedAssets).to.equal(SEED + 5n * E18);
    expect(snapshot.wallet?.nativeBalance).to.be.gt(0n);
    expect(snapshot.wallet?.shareBalance).to.be.closeTo(5n * E18, 2n);
    expect(snapshot.withdrawalDelaySeconds).to.equal(DAY);
    expect(snapshot.requestCount).to.equal(0n);

    await vault.connect(alice).requestWithdrawal(snapshot.wallet!.shareBalance, 0, alice.address);
    const request = await readLiquidWithdrawalRequest(batch, await vault.getAddress(), 0n);
    expect(request.receiver.toLowerCase()).to.equal(alice.address.toLowerCase());
    expect(request.assets).to.be.closeTo(5n * E18, 3n);
    expect(request.claimed).to.equal(false);
    const range = await readLiquidWithdrawalRequests(batch, await vault.getAddress(), 0n, 1n);
    expect(range).to.deep.equal([request]);
    expect((await readLiquidStakingSnapshot(batch, await vault.getAddress())).requestCount).to.equal(1n);
  });
});
