import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";
import { expect } from "chai";
import { Interface } from "ethers";
import type { Wallet } from "ethers";
import {
  VAULT_V2_ABI,
  VAULT_FACTORY_V2_ABI,
  VAULT_PROXY_V2_ABI,
  VAULT_LIMITS,
  mineVaultSalt,
  predictVaultAddress,
  walletCreatedFromLogs,
  verifyFactory,
  resolveDeployment,
  assertVaultAuthentic,
  assertVaultMatchesParams,
  UnknownVaultCodeError,
  FactoryAuthenticityError,
  VaultStateMismatchError,
  readRecentTransactions,
  verifyVaultTransaction,
  TransactionIntegrityError,
  readVaultAcrossSources,
  readChainClock,
  chooseExpiration,
  vaultCalls,
  adminCalls,
  proposedHashFromLogs,
  simulateVaultCall,
  recommendGasLimit,
  transactionActions,
  describeRisk,
  highestRisk,
  isCyprus1QuaiAddress,
  vaultInterface,
} from "@safebuddy/core";
import type { RpcLike, VaultDeployment } from "@safebuddy/core";
import { hardhatQuaiRpc, quaiWallets, deployCyprusV2, deployAtCyprus, cyprusDeployer } from "./quai-shim.ts";

const { ethers } = hre;
const EXEC = { gasLimit: 5_000_000 };

/** Awaits a rejection and checks its class (and message), without chai-as-promised typings. */
async function expectRejects(p: Promise<unknown>, type: abstract new (...args: any[]) => Error, pattern?: RegExp) {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  );
  expect(err, "expected a rejection").to.be.instanceOf(type);
  if (pattern) expect((err as Error).message).to.match(pattern);
}

function signatures(abi: ReadonlyArray<unknown>): string[] {
  return new Interface(abi as any).fragments.map((f) => f.format("full")).sort();
}

describe("@safebuddy/core against the real v2 contracts", function () {
  this.timeout(180_000);

  let rpc: RpcLike;
  let deployment: VaultDeployment;
  let factory: any;
  let owners: Wallet[];
  let vaultAddress: string;
  let vault: any;
  let chainId: number;

  async function send(from: Wallet, data: string) {
    const receipt = await (await from.sendTransaction({ to: vaultAddress, data, ...EXEC })).wait();
    return receipt!;
  }

  before(async () => {
    const v2 = await deployCyprusV2();
    factory = v2.factory;
    deployment = v2.deployment;
    chainId = deployment.chainId;
    rpc = hardhatQuaiRpc();
    owners = await quaiWallets(3);

    // Exactly what the web app does: mine a salt with core, create through the factory, and
    // take the address from the WalletCreated event.
    const params = { owners: owners.map((o) => o.address), threshold: 2, minExecutionDelay: 3600 };
    const mined = mineVaultSalt({ factory: deployment.factory, implementation: deployment.implementation, creator: owners[0]!.address, params });
    expect(await factory.predictWalletAddress(owners[0]!.address, params.owners, 2, 3600, mined.salt)).to.equal(mined.address);
    const receipt = await (await factory.connect(owners[0]!).createWallet(params.owners, 2, 3600, mined.salt)).wait();
    const created = walletCreatedFromLogs(receipt.logs, deployment.factory);
    expect(created.wallet).to.equal(mined.address);
    expect(isCyprus1QuaiAddress(created.wallet)).to.equal(true);
    vaultAddress = created.wallet;
    vault = await ethers.getContractAt("SafeBuddyVault", vaultAddress);
    await owners[0]!.sendTransaction({ to: vaultAddress, value: ethers.parseEther("5") });
  });

  it("carries exactly the compiled ABIs and constants", async () => {
    for (const [abi, name] of [
      [VAULT_V2_ABI, "SafeBuddyVault"],
      [VAULT_FACTORY_V2_ABI, "SafeBuddyVaultFactory"],
      [VAULT_PROXY_V2_ABI, "SafeBuddyVaultProxy"],
    ] as const) {
      const artifact = await hre.artifacts.readArtifact(name);
      expect(signatures(abi)).to.deep.equal(signatures(artifact.abi));
    }
    expect(Number(await vault.MAX_OWNERS())).to.equal(VAULT_LIMITS.MAX_OWNERS);
    expect(Number(await vault.MAX_EXECUTION_DELAY())).to.equal(VAULT_LIMITS.MAX_EXECUTION_DELAY);
    expect(Number(await vault.MAX_EXECUTION_WINDOW())).to.equal(VAULT_LIMITS.MAX_EXECUTION_WINDOW);
    expect(await vault.MAX_TX_GAS()).to.equal(VAULT_LIMITS.MAX_TX_GAS);
    expect(await vault.VERSION()).to.equal(VAULT_LIMITS.VERSION);
  });

  it("verifies the genuine factory and rejects impostors", async () => {
    expect(await verifyFactory(rpc, deployment.factory)).to.deep.equal({ factory: deployment.factory, implementation: deployment.implementation });
    const resolved = await resolveDeployment(rpc, chainId, deployment.factory);
    expect(resolved).to.include({ factory: deployment.factory, implementation: deployment.implementation, source: "override" });

    // Same factory code, but pointing at a contract that is not the vault implementation.
    const token = await deployAtCyprus("MockERC20", ["T", "T", 18]);
    const rogue = await deployAtCyprus("SafeBuddyVaultFactory", [await token.getAddress()]);
    await expectRejects(verifyFactory(rpc, await rogue.getAddress()), FactoryAuthenticityError, /not the pinned SafeBuddyVault/);
    await expectRejects(verifyFactory(rpc, deployment.implementation), FactoryAuthenticityError, /differs from the pinned build/);
    await expectRejects(verifyFactory(rpc, owners[0]!.address), FactoryAuthenticityError, /no code/);
  });

  it("accepts a factory vault and rejects look-alikes", async () => {
    const verified = await assertVaultAuthentic(rpc, vaultAddress, deployment);
    expect(verified.snapshot).to.deep.include({ threshold: 2, minExecutionDelay: 3600, txNonce: 0 });
    expect(verified.snapshot.balance).to.equal(ethers.parseEther("5"));
    assertVaultMatchesParams(verified, { owners: owners.map((o) => o.address).reverse(), threshold: 2, minExecutionDelay: 3600 });
    expect(() => assertVaultMatchesParams(verified, { owners: owners.map((o) => o.address), threshold: 2, minExecutionDelay: 0 })).to.throw(
      VaultStateMismatchError
    );

    // A proxy with identical code and the real implementation, but not created by the factory.
    const init = vaultInterface.encodeFunctionData("initialize", [owners.map((o) => o.address), 1, 0]);
    const stray = await deployAtCyprus("SafeBuddyVaultProxy", [deployment.implementation, init]);
    await expectRejects(assertVaultAuthentic(rpc, await stray.getAddress(), deployment), UnknownVaultCodeError, /not created by the SafeBuddy factory/);
    await expectRejects(assertVaultAuthentic(rpc, deployment.implementation, deployment), UnknownVaultCodeError);
    await expectRejects(assertVaultAuthentic(rpc, owners[1]!.address, deployment), UnknownVaultCodeError, /no contract code/);
  });

  it("proposes, verifies and executes through core-built calldata", async () => {
    const recipient = (await quaiWallets(1))[0]!.address;
    const clock = await readChainClock(rpc);
    const draft = {
      to: recipient,
      value: ethers.parseEther("1"),
      data: "0x",
      gasLimit: await recommendGasLimit(rpc, { vault: vaultAddress, to: recipient, value: ethers.parseEther("1"), data: "0x" }),
      expiration: chooseExpiration(clock, 3600),
      requestedDelay: 0,
    };
    expect(await simulateVaultCall(rpc, { vault: vaultAddress, to: draft.to, value: draft.value, data: draft.data, gasLimit: draft.gasLimit })).to.deep.equal({ ok: true });
    const hash = proposedHashFromLogs((await send(owners[0]!, vaultCalls.propose(draft))).logs as any, vaultAddress);

    const sources = [
      { name: "rpc", rpc },
      { name: "wallet", rpc: hardhatQuaiRpc() },
    ];
    const review = await verifyVaultTransaction({ sources, address: vaultAddress, deployment, chainId, hash });
    expect(review.agreement).to.equal("agreed");
    expect(review.tx).to.deep.include({ nonce: 0, to: recipient, value: draft.value, status: "Pending" });
    expect(review.decoded).to.deep.equal({ kind: "native-transfer", to: recipient, value: draft.value });
    expect(review.digestDisplay).to.match(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);

    await send(owners[1]!, vaultCalls.approve(hash));
    let [tx] = await readRecentTransactions(rpc, vaultAddress, 1);
    expect(tx!.status).to.equal("Timelocked");
    const snapshot = (await assertVaultAuthentic(rpc, vaultAddress, deployment)).snapshot;
    expect(transactionActions(tx!, snapshot, owners[2]!.address, (await readChainClock(rpc)).chainTime)).to.include({ canExecute: false, canApprove: true });

    await ethers.provider.send("evm_increaseTime", [3601]);
    await ethers.provider.send("evm_mine", []);
    [tx] = await readRecentTransactions(rpc, vaultAddress, 1);
    expect(transactionActions(tx!, snapshot, owners[2]!.address, (await readChainClock(rpc)).chainTime).canExecute).to.equal(true);
    const before = await ethers.provider.getBalance(recipient);
    await send(owners[2]!, vaultCalls.execute(hash));
    expect((await ethers.provider.getBalance(recipient)) - before).to.equal(draft.value);
    [tx] = await readRecentTransactions(rpc, vaultAddress, 1);
    expect(tx!.status).to.equal("Executed");
  });

  it("flags a lying second source as a disagreement and a lying primary as an integrity failure", async () => {
    const clock = await readChainClock(rpc);
    const data = adminCalls.changeThreshold(1);
    const hash = proposedHashFromLogs(
      (await send(owners[0]!, vaultCalls.propose({ to: vaultAddress, value: 0n, data, gasLimit: 0n, expiration: chooseExpiration(clock, 0), requestedDelay: 0 }))).logs as any,
      vaultAddress
    );
    const review = await verifyVaultTransaction({ sources: [{ name: "rpc", rpc }], address: vaultAddress, deployment, chainId, hash });
    expect(review.decoded).to.deep.equal({ kind: "admin", call: { fn: "changeThreshold", newThreshold: 1n } });
    expect(highestRisk(describeRisk(review.decoded, { vault: vaultAddress, owners: review.vault.snapshot.owners, threshold: 2, minExecutionDelay: 3600 }))).to.equal("critical");

    // A node that swaps the stored calldata of this transaction for something harmless-looking.
    const getTx = vaultInterface.getFunction("getTransaction")!.selector;
    const liar = hardhatQuaiRpc((method, params: any[], result) => {
      if (method !== "quai_call" || !String(params[0]?.data).startsWith(getTx)) return result;
      const [t] = vaultInterface.decodeFunctionResult("getTransaction", result);
      const forged = { ...t.toObject(), data: adminCalls.changeThreshold(2) };
      return vaultInterface.encodeFunctionResult("getTransaction", [forged]);
    });
    const asSecondary = await verifyVaultTransaction({ sources: [{ name: "rpc", rpc }, { name: "liar", rpc: liar }], address: vaultAddress, deployment, chainId, hash });
    expect(asSecondary.agreement).to.equal("disagreement");
    await expectRejects(verifyVaultTransaction({ sources: [{ name: "liar", rpc: liar }], address: vaultAddress, deployment, chainId, hash }), TransactionIntegrityError);

    const vaultRead = await readVaultAcrossSources([{ name: "rpc", rpc }, { name: "wallet", rpc: hardhatQuaiRpc() }], vaultAddress, deployment);
    expect(vaultRead.status).to.equal("agreed");
  });

  it("predicts where the factory will put a vault for any creator", async () => {
    const other = await cyprusDeployer();
    const params = { owners: [owners[0]!.address], threshold: 1, minExecutionDelay: 0 };
    const salt = ethers.hexlify(ethers.randomBytes(32));
    expect(predictVaultAddress({ factory: deployment.factory, implementation: deployment.implementation, creator: other.address, salt, params })).to.equal(
      await factory.predictWalletAddress(other.address, params.owners, 1, 0, salt)
    );
  });
});
