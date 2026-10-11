import { expect } from "chai";
import hre from "hardhat";
import "@nomicfoundation/hardhat-toolbox";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import type { Wallet } from "ethers";

const { ethers, network, artifacts } = hre;
import {
  DAY,
  MAX_DELAY,
  cyprusWallets,
  cyprusAddress,
  createVault,
  deployV2,
  propose,
  runSelfCall,
  atNext,
  now,
  TxStatus,
  EXEC_GAS,
} from "./helpers.ts";

describe("SafeBuddyVault v2", function () {
  let A: Wallet, B: Wallet, C: Wallet, D: Wallet, outsider: Wallet;

  before(async function () {
    [A, B, C, D, outsider] = await cyprusWallets(5);
  });

  async function recorder() {
    const r = await (await ethers.getContractFactory("CallRecorder")).deploy();
    return r;
  }

  async function vault2of3(minDelay = 0) {
    const ctx = await createVault({ owners: [A.address, B.address, C.address], threshold: 2, minDelay });
    await A.sendTransaction({ to: ctx.address, value: ethers.parseEther("10") });
    return ctx;
  }

  const iface = new ethers.Interface([
    "function addOwner(address,uint256)",
    "function removeOwner(address,uint256)",
    "function changeThreshold(uint256)",
    "function setMinExecutionDelay(uint32)",
    "function cancelByConsensus(bytes32)",
    "function executeTransaction(bytes32)",
  ]);

  // ------------------------------------------------------------------ deployment & factory

  describe("factory and proxy", function () {
    it("creates an initialised, registered proxy at the predicted address with the pinned proxy code", async function () {
      const { implementation, factory } = await deployV2();
      const salt = ethers.id("salt-1");
      const owners = [A.address, B.address, C.address];
      const predicted = await factory.predictWalletAddress(A.address, owners, 2, DAY, salt);
      await expect(factory.connect(A).createWallet(owners, 2, DAY, salt))
        .to.emit(factory, "WalletCreated")
        .withArgs(predicted, A.address, owners, 2, DAY, salt);

      expect(await factory.isWallet(predicted)).to.equal(true);
      expect(await factory.walletCount()).to.equal(1n);
      const vault = await ethers.getContractAt("SafeBuddyVault", predicted);
      expect(await vault.getOwners()).to.deep.equal(owners);
      expect(await vault.threshold()).to.equal(2n);
      expect(await vault.getThreshold()).to.equal(2n);
      expect(await vault.minExecutionDelay()).to.equal(BigInt(DAY));

      const proxy = await ethers.getContractAt("SafeBuddyVaultProxy", predicted);
      expect(await proxy.getImplementation()).to.equal(await implementation.getAddress());
      const code = await ethers.provider.getCode(predicted);
      expect(ethers.keccak256(code)).to.equal(await factory.proxyCodeHash());
    });

    it("folds the creator into the salt, so a mined salt cannot be squatted by someone else", async function () {
      const { factory } = await deployV2();
      const salt = ethers.id("contested");
      const owners = [A.address];
      const forA = await factory.predictWalletAddress(A.address, owners, 1, 0, salt);
      const forB = await factory.predictWalletAddress(B.address, owners, 1, 0, salt);
      expect(forA).to.not.equal(forB);
      await factory.connect(B).createWallet(owners, 1, 0, salt);
      await factory.connect(A).createWallet(owners, 1, 0, salt);
      expect(await factory.isWallet(forA)).to.equal(true);
    });

    it("rejects invalid configurations with the vault's own errors", async function () {
      const { factory, implementation } = await deployV2();
      const vaultErr = implementation;
      const salt = ethers.ZeroHash;
      await expect(factory.createWallet([], 1, 0, salt)).to.be.revertedWithCustomError(vaultErr, "OwnersRequired");
      await expect(factory.createWallet([A.address], 0, 0, salt)).to.be.revertedWithCustomError(vaultErr, "InvalidThreshold");
      await expect(factory.createWallet([A.address], 2, 0, salt)).to.be.revertedWithCustomError(vaultErr, "InvalidThreshold");
      await expect(factory.createWallet([A.address, A.address], 1, 0, salt))
        .to.be.revertedWithCustomError(vaultErr, "DuplicateOwner")
        .withArgs(A.address);
      for (const bad of [ethers.ZeroAddress, "0x0000000000000000000000000000000000000001", "0x1234567890123456789012345678901234567890"]) {
        await expect(factory.createWallet([bad], 1, 0, salt)).to.be.revertedWithCustomError(vaultErr, "InvalidOwnerAddress");
      }
      const tooMany = Array.from({ length: 21 }, () => cyprusAddress());
      await expect(factory.createWallet(tooMany, 1, 0, salt)).to.be.revertedWithCustomError(vaultErr, "TooManyOwners");
      await expect(factory.createWallet([A.address], 1, MAX_DELAY + 1, salt)).to.be.revertedWithCustomError(
        vaultErr,
        "ExecutionDelayTooLong"
      );
      await expect(factory.createWallet([A.address], 1, MAX_DELAY, salt)).to.emit(factory, "WalletCreated");
    });

    it("refuses an implementation address with no code", async function () {
      const Factory = await ethers.getContractFactory("SafeBuddyVaultFactory");
      await expect(Factory.deploy(cyprusAddress())).to.be.revertedWithCustomError(Factory, "InvalidImplementation");
    });

    it("locks the implementation and allows initialize only once per proxy", async function () {
      const { vault, implementation } = await vault2of3();
      await expect(implementation.initialize([A.address], 1, 0)).to.be.revertedWithCustomError(implementation, "AlreadyInitialized");
      await expect(vault.initialize([outsider.address], 1, 0)).to.be.revertedWithCustomError(vault, "AlreadyInitialized");
    });

    it("refuses plain QUAI sent to the ownerless implementation, but the proxy accepts and logs it", async function () {
      const { address, implementation } = await vault2of3();
      await expect(A.sendTransaction({ to: await implementation.getAddress(), value: 1n })).to.be.reverted;
      const proxy = await ethers.getContractAt("SafeBuddyVaultProxy", address);
      await expect(A.sendTransaction({ to: address, value: 5n })).to.emit(proxy, "Received").withArgs(A.address, 5n);
    });

    it("has no upgrade path: upgradeToAndCall does not exist on the proxy or the vault", async function () {
      const { address, implementation } = await vault2of3();
      const upgrade = new ethers.Interface(["function upgradeToAndCall(address,bytes)"]);
      await expect(
        A.sendTransaction({ to: address, data: upgrade.encodeFunctionData("upgradeToAndCall", [await implementation.getAddress(), "0x"]) })
      ).to.be.reverted;
      expect(await (await ethers.getContractAt("SafeBuddyVaultProxy", address)).getImplementation()).to.equal(
        await implementation.getAddress()
      );
    });
  });

  // ------------------------------------------------------------------ bytecode (I1)

  describe("I1: bytecode", function () {
    it("contains no DELEGATECALL, CALLCODE, SELFDESTRUCT, CREATE/CREATE2 or post-Paris opcode", async function () {
      const art = artifacts.readArtifactSync("SafeBuddyVault");
      const bytes = Buffer.from(art.deployedBytecode.slice(2), "hex");
      const meta = (bytes[bytes.length - 2]! << 8) | bytes[bytes.length - 1]!;
      const code = bytes.subarray(0, bytes.length - meta - 2);
      const forbidden = new Set([0xf4, 0xf2, 0xff, 0xf0, 0xf5, 0x5f, 0x5c, 0x5d, 0x5e, 0x49, 0x4a]);
      const violations: string[] = [];
      for (let i = 0; i < code.length; ) {
        const op = code[i]!;
        if (forbidden.has(op)) violations.push(`0x${op.toString(16)}@${i}`);
        i += op >= 0x60 && op <= 0x7f ? op - 0x5e : 1;
      }
      expect(code.length).to.be.greaterThan(5000);
      expect(violations).to.deep.equal([]);
    });
  });

  // ------------------------------------------------------------------ proposing

  describe("proposing (I8, I5)", function () {
    it("auto-approves for the proposer and emits every field of the transaction", async function () {
      const { vault } = await vault2of3();
      const r = await recorder();
      const t = await atNext();
      const expiration = t + 7 * DAY;
      const data = r.interface.encodeFunctionData("record", ["0xbeef"]);
      const tx = vault.connect(A).proposeTransaction(await r.getAddress(), 7n, data, 150_000n, expiration, 0);
      await expect(tx)
        .to.emit(vault, "TransactionProposed")
        .withArgs(
          await vault.getTransactionHash(await r.getAddress(), 7n, data, 150_000n, expiration, 0, 0),
          A.address,
          await r.getAddress(),
          7n,
          data,
          150_000n,
          expiration,
          0
        );
      const hash = await vault.getTransactionHash(await r.getAddress(), 7n, data, 150_000n, expiration, 0, 0);
      expect(await vault.hasApproved(hash, A.address)).to.equal(true);
      expect(await vault.status(hash)).to.equal(TxStatus.Pending);
      expect(await vault.txNonce()).to.equal(1n);
    });

    it("only owners can propose, approve, revoke, execute or cancel", async function () {
      const { vault } = await vault2of3();
      const hash = await propose(vault, A, { to: await (await recorder()).getAddress() });
      await expect(propose(vault, outsider, { to: A.address })).to.be.revertedWithCustomError(vault, "NotAnOwner");
      for (const fn of ["approveTransaction", "revokeApproval", "executeTransaction", "cancelTransaction"] as const) {
        await expect(vault.connect(outsider)[fn](hash)).to.be.revertedWithCustomError(vault, "NotAnOwner");
      }
    });

    it("requires a destination and a bounded gas limit for external calls", async function () {
      const { vault } = await vault2of3();
      const exp = (await now()) + 7 * DAY;
      await expect(vault.connect(A).proposeTransaction(ethers.ZeroAddress, 0, "0x", 1n, exp, 0)).to.be.revertedWithCustomError(
        vault,
        "InvalidDestination"
      );
      await expect(vault.connect(A).proposeTransaction(B.address, 0, "0x", 0n, exp, 0)).to.be.revertedWithCustomError(
        vault,
        "InvalidGasLimit"
      );
      await expect(vault.connect(A).proposeTransaction(B.address, 0, "0x", 30_000_001n, exp, 0)).to.be.revertedWithCustomError(
        vault,
        "InvalidGasLimit"
      );
    });

    it("requires an expiration strictly after the timelock and within 30 days of it", async function () {
      const { vault } = await vault2of3(DAY);
      const t = await atNext();
      await expect(vault.connect(A).proposeTransaction(B.address, 0, "0x", 50_000n, t + DAY, 0)).to.be.revertedWithCustomError(
        vault,
        "ExpirationTooSoon"
      );
      const t2 = await atNext();
      await expect(vault.connect(A).proposeTransaction(B.address, 0, "0x", 50_000n, 0, 0)).to.be.revertedWithCustomError(
        vault,
        "ExpirationTooSoon"
      );
      const t3 = await atNext();
      await expect(
        vault.connect(A).proposeTransaction(B.address, 0, "0x", 50_000n, t3 + DAY + 30 * DAY + 1, 0)
      ).to.be.revertedWithCustomError(vault, "ExpirationTooFar");
      const t4 = await atNext();
      await expect(vault.connect(A).proposeTransaction(B.address, 0, "0x", 50_000n, t4 + DAY + 1, 0)).to.emit(
        vault,
        "TransactionProposed"
      );
      expect(t2).to.be.greaterThan(0);
    });

    it("uses max(floor, requested) as the delay and caps the request at 30 days", async function () {
      const { vault } = await vault2of3(DAY);
      const low = await propose(vault, A, { to: B.address, requestedDelay: 60 });
      const high = await propose(vault, A, { to: B.address, requestedDelay: 3 * DAY });
      expect((await vault.getTransaction(low)).executionDelay).to.equal(BigInt(DAY));
      expect((await vault.getTransaction(high)).executionDelay).to.equal(BigInt(3 * DAY));
      await expect(propose(vault, A, { to: B.address, requestedDelay: MAX_DELAY + 1 })).to.be.revertedWithCustomError(
        vault,
        "ExecutionDelayTooLong"
      );
    });

    it("restricts self-calls to the admin selectors, with no value, no gas limit and no delay", async function () {
      const { vault, address } = await vault2of3(3 * DAY);
      const exp = (await now()) + 7 * DAY;
      const ok = iface.encodeFunctionData("changeThreshold", [3]);
      await expect(vault.connect(A).proposeTransaction(address, 1n, ok, 0n, exp, 0)).to.be.revertedWithCustomError(
        vault,
        "SelfCallValueNotAllowed"
      );
      await expect(vault.connect(A).proposeTransaction(address, 0n, ok, 1n, exp, 0)).to.be.revertedWithCustomError(
        vault,
        "InvalidGasLimit"
      );
      const exec = iface.encodeFunctionData("executeTransaction", [ethers.ZeroHash]);
      await expect(vault.connect(A).proposeTransaction(address, 0n, exec, 0n, exp, 0))
        .to.be.revertedWithCustomError(vault, "UnrecognizedSelfCall")
        .withArgs(exec.slice(0, 10));
      await expect(vault.connect(A).proposeTransaction(address, 0n, "0x12", 0n, exp, 0)).to.be.revertedWithCustomError(
        vault,
        "UnrecognizedSelfCall"
      );
      const hash = await propose(vault, A, { to: address, data: ok, requestedDelay: 5 * DAY });
      expect((await vault.getTransaction(hash)).executionDelay).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------ approvals and execution

  describe("approvals and execution (I2)", function () {
    it("executes an external call once quorum is reached and forwards exactly the proposed call", async function () {
      const { vault, address } = await vault2of3();
      const r = await recorder();
      const data = r.interface.encodeFunctionData("record", ["0xc0ffee"]);
      const hash = await propose(vault, A, { to: await r.getAddress(), value: ethers.parseEther("1"), data });
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS))
        .to.be.revertedWithCustomError(vault, "NotEnoughApprovals")
        .withArgs(1, 2);
      await expect(vault.connect(A).approveTransaction(hash)).to.be.revertedWithCustomError(vault, "AlreadyApproved");
      await expect(vault.connect(B).approveTransaction(hash)).to.emit(vault, "ThresholdReached");
      expect(await vault.status(hash)).to.equal(TxStatus.Executable);

      await expect(vault.connect(C).executeTransaction(hash, EXEC_GAS)).to.emit(vault, "TransactionExecuted").withArgs(hash, C.address);
      expect(await r.calls()).to.equal(1n);
      expect(await r.lastValue()).to.equal(ethers.parseEther("1"));
      expect(await r.lastData()).to.equal("0xc0ffee");
      expect(await r.lastSender()).to.equal(address);
      expect(await vault.status(hash)).to.equal(TxStatus.Executed);
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS)).to.be.revertedWithCustomError(vault, "TransactionAlreadyExecuted");
      await expect(vault.connect(C).approveTransaction(hash)).to.be.revertedWithCustomError(vault, "TransactionAlreadyExecuted");
    });

    it("requires quorum at execution time, even after the clock started", async function () {
      const { vault } = await vault2of3();
      const hash = await propose(vault, A, { to: B.address, value: 1n });
      await vault.connect(B).approveTransaction(hash);
      await expect(vault.connect(B).revokeApproval(hash)).to.emit(vault, "ApprovalRevoked").withArgs(hash, B.address);
      await expect(vault.connect(B).revokeApproval(hash)).to.be.revertedWithCustomError(vault, "NotApproved");
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS)).to.be.revertedWithCustomError(vault, "NotEnoughApprovals");
      expect(await vault.status(hash)).to.equal(TxStatus.Pending);
    });

    it("transactions are independent: a stuck one does not block others", async function () {
      const { vault } = await vault2of3();
      const stuck = await propose(vault, A, { to: B.address, value: 1n });
      const other = await propose(vault, A, { to: C.address, value: 1n });
      await vault.connect(B).approveTransaction(other);
      await expect(vault.connect(A).executeTransaction(other, EXEC_GAS)).to.emit(vault, "TransactionExecuted");
      expect(await vault.status(stuck)).to.equal(TxStatus.Pending);
    });

    it("binds the hash to this vault and chain, so approvals cannot replay across vaults", async function () {
      const one = await vault2of3();
      const two = await vault2of3();
      const args = [B.address, 1n, "0x", 50_000n, 999_999_999n, 0, 0] as const;
      expect(await one.vault.getTransactionHash(...args)).to.not.equal(await two.vault.getTransactionHash(...args));
      await expect(two.vault.connect(A).approveTransaction(await one.vault.getTransactionHash(...args))).to.be.revertedWithCustomError(
        two.vault,
        "TransactionNotFound"
      );
    });
  });

  // ------------------------------------------------------------------ timelock (I3)

  describe("timelock (I3)", function () {
    it("blocks execution until approvedAt + delay and emits ThresholdReached once", async function () {
      const { vault } = await vault2of3(DAY);
      const hash = await propose(vault, A, { to: B.address, value: 1n });
      const tx = await vault.connect(B).approveTransaction(hash);
      const approvedAt = (await ethers.provider.getBlock(tx.blockNumber!))!.timestamp;
      await expect(tx).to.emit(vault, "ThresholdReached").withArgs(hash, approvedAt, approvedAt + DAY);
      expect(await vault.status(hash)).to.equal(TxStatus.Timelocked);

      await time.setNextBlockTimestamp(approvedAt + DAY - 1);
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS))
        .to.be.revertedWithCustomError(vault, "TimelockNotElapsed")
        .withArgs(approvedAt + DAY);
      await time.setNextBlockTimestamp(approvedAt + DAY);
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS)).to.emit(vault, "TransactionExecuted");
    });

    it("never resets approvedAt: revoking and re-approving keeps the original clock", async function () {
      const { vault } = await vault2of3(DAY);
      const hash = await propose(vault, A, { to: B.address, value: 1n });
      await vault.connect(B).approveTransaction(hash);
      const first = (await vault.getTransaction(hash)).approvedAt;
      await time.increase(DAY / 2);
      await vault.connect(B).revokeApproval(hash);
      await time.increase(DAY / 4);
      await expect(vault.connect(C).approveTransaction(hash)).to.not.emit(vault, "ThresholdReached");
      expect((await vault.getTransaction(hash)).approvedAt).to.equal(first);
      await time.setNextBlockTimestamp(Number(first) + DAY);
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS)).to.emit(vault, "TransactionExecuted");
    });

    it("starts the clock lazily when quorum arrives by a threshold drop, without executing if a delay applies", async function () {
      const { vault, address } = await vault2of3(DAY);
      const hash = await propose(vault, A, { to: B.address, value: 1n });
      // threshold 2 -> 1 via consensus: the pending tx now has quorum but no clock
      await runSelfCall(vault, [A, B], iface.encodeFunctionData("changeThreshold", [1]));
      expect((await vault.getTransaction(hash)).approvedAt).to.equal(0n);

      const tx = await vault.connect(A).executeTransaction(hash, EXEC_GAS);
      await expect(tx).to.emit(vault, "ThresholdReached");
      await expect(tx).to.not.emit(vault, "TransactionExecuted");
      expect(await vault.status(hash)).to.equal(TxStatus.Timelocked);
      await time.increase(DAY);
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS)).to.emit(vault, "TransactionExecuted");
      expect(address).to.be.properAddress;
    });

    it("with no delay, a lazily started transaction executes in the same call", async function () {
      const { vault } = await vault2of3(0);
      const hash = await propose(vault, A, { to: B.address, value: 1n });
      await runSelfCall(vault, [A, B], iface.encodeFunctionData("changeThreshold", [1]));
      const tx = vault.connect(A).executeTransaction(hash, EXEC_GAS);
      await expect(tx).to.emit(vault, "ThresholdReached");
      await expect(tx).to.emit(vault, "TransactionExecuted");
    });

    it("keeps an in-flight transaction's delay when the floor changes", async function () {
      const { vault } = await vault2of3(3 * DAY);
      const hash = await propose(vault, A, { to: B.address, value: 1n });
      await runSelfCall(vault, [A, B], iface.encodeFunctionData("setMinExecutionDelay", [0]));
      expect(await vault.minExecutionDelay()).to.equal(0n);
      await vault.connect(B).approveTransaction(hash);
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS)).to.be.revertedWithCustomError(vault, "TimelockNotElapsed");
      expect((await vault.getTransaction(hash)).executionDelay).to.equal(BigInt(3 * DAY));
    });

    it("executes admin self-calls immediately even when the vault has a floor", async function () {
      const { vault } = await vault2of3(7 * DAY);
      await expect(runSelfCall(vault, [A, B], iface.encodeFunctionData("changeThreshold", [3])))
        .to.emit(vault, "ThresholdChanged")
        .withArgs(3);
    });

    it("caps the floor at 30 days on change too", async function () {
      const { vault } = await vault2of3();
      await expect(runSelfCall(vault, [A, B], iface.encodeFunctionData("setMinExecutionDelay", [MAX_DELAY + 1]))).to.be.revertedWithCustomError(
        vault,
        "SelfCallFailed"
      );
      await expect(runSelfCall(vault, [A, B], iface.encodeFunctionData("setMinExecutionDelay", [MAX_DELAY])))
        .to.emit(vault, "MinExecutionDelayChanged")
        .withArgs(0, MAX_DELAY);
    });
  });

  // ------------------------------------------------------------------ expiry (I8)

  describe("expiry (I8)", function () {
    it("checks expiry before the timelock and lets anyone close an expired transaction", async function () {
      const { vault } = await vault2of3(DAY);
      const t = await atNext();
      const expiration = t + DAY + 60;
      await vault.connect(A).proposeTransaction(B.address, 1n, "0x", 50_000n, expiration, 0);
      const hash = await vault.getTransactionHash(B.address, 1n, "0x", 50_000n, expiration, DAY, 0);
      await vault.connect(B).approveTransaction(hash);

      await expect(vault.connect(outsider).expireTransaction(hash)).to.be.revertedWithCustomError(vault, "TransactionNotExpired");
      await time.increaseTo(expiration + 1);
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS)).to.be.revertedWithCustomError(vault, "TransactionIsExpired");
      await expect(vault.connect(C).approveTransaction(hash)).to.be.revertedWithCustomError(vault, "TransactionIsExpired");
      expect(await vault.status(hash)).to.equal(TxStatus.Expired);

      await expect(vault.connect(outsider).expireTransaction(hash)).to.emit(vault, "TransactionExpired").withArgs(hash);
      await expect(vault.connect(outsider).expireTransaction(hash)).to.be.revertedWithCustomError(vault, "TransactionAlreadyExpired");
    });

    it("executes right up to and including the expiration second", async function () {
      const { vault } = await vault2of3(0);
      const t = await atNext();
      const expiration = t + 3600;
      await vault.connect(A).proposeTransaction(B.address, 1n, "0x", 50_000n, expiration, 0);
      const hash = await vault.getTransactionHash(B.address, 1n, "0x", 50_000n, expiration, 0, 0);
      await vault.connect(B).approveTransaction(hash);
      await time.setNextBlockTimestamp(expiration);
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS)).to.emit(vault, "TransactionExecuted");
    });
  });

  // ------------------------------------------------------------------ cancellation (I7)

  describe("cancellation (I7)", function () {
    it("lets only the proposer cancel, and only before quorum was ever reached", async function () {
      const { vault } = await vault2of3();
      const early = await propose(vault, A, { to: B.address, value: 1n });
      await expect(vault.connect(B).cancelTransaction(early)).to.be.revertedWithCustomError(vault, "NotProposer");
      await expect(vault.connect(A).cancelTransaction(early)).to.emit(vault, "TransactionCancelled").withArgs(early, A.address);
      await expect(vault.connect(B).approveTransaction(early)).to.be.revertedWithCustomError(vault, "TransactionAlreadyCancelled");
      expect(await vault.status(early)).to.equal(TxStatus.Cancelled);

      const approved = await propose(vault, A, { to: B.address, value: 2n });
      await vault.connect(B).approveTransaction(approved);
      await vault.connect(B).revokeApproval(approved);
      await expect(vault.connect(A).cancelTransaction(approved)).to.be.revertedWithCustomError(
        vault,
        "CannotCancelApprovedTransaction"
      );
    });

    it("cancels an approved transaction by consensus, and never by a direct call", async function () {
      const { vault } = await vault2of3(DAY);
      const target = await propose(vault, A, { to: B.address, value: 1n });
      await vault.connect(B).approveTransaction(target);
      await expect(vault.connect(A).cancelByConsensus(target)).to.be.revertedWithCustomError(vault, "OnlySelf");
      await expect(runSelfCall(vault, [A, C], iface.encodeFunctionData("cancelByConsensus", [target])))
        .to.emit(vault, "TransactionCancelled")
        .withArgs(target, await vault.getAddress());
      await time.increase(DAY);
      await expect(vault.connect(A).executeTransaction(target, EXEC_GAS)).to.be.revertedWithCustomError(vault, "TransactionAlreadyCancelled");
    });
  });

  // ------------------------------------------------------------------ owners (I4, I9)

  describe("owner management (I4, I9)", function () {
    it("administration works only through consensus self-calls", async function () {
      const { vault } = await vault2of3();
      await expect(vault.connect(A).addOwner(D.address, 2)).to.be.revertedWithCustomError(vault, "OnlySelf");
      await expect(vault.connect(A).removeOwner(B.address, 1)).to.be.revertedWithCustomError(vault, "OnlySelf");
      await expect(vault.connect(A).changeThreshold(1)).to.be.revertedWithCustomError(vault, "OnlySelf");
      await expect(vault.connect(A).setMinExecutionDelay(0)).to.be.revertedWithCustomError(vault, "OnlySelf");

      await expect(runSelfCall(vault, [A, B], iface.encodeFunctionData("addOwner", [D.address, 3])))
        .to.emit(vault, "OwnerAdded")
        .withArgs(D.address);
      expect(await vault.getOwners()).to.include(D.address);
      expect(await vault.threshold()).to.equal(3n);
      await expect(runSelfCall(vault, [A, B, D], iface.encodeFunctionData("removeOwner", [C.address, 2])))
        .to.emit(vault, "OwnerRemoved")
        .withArgs(C.address);
      expect(await vault.isOwner(C.address)).to.equal(false);
    });

    it("rolls back the whole self-call when an admin change is invalid", async function () {
      const { vault } = await vault2of3();
      for (const data of [
        iface.encodeFunctionData("addOwner", [A.address, 2]),
        iface.encodeFunctionData("addOwner", [await vault.getAddress(), 2]),
        iface.encodeFunctionData("addOwner", ["0x1234567890123456789012345678901234567890", 2]),
        iface.encodeFunctionData("addOwner", [D.address, 5]),
        iface.encodeFunctionData("removeOwner", [outsider.address, 1]),
        iface.encodeFunctionData("removeOwner", [A.address, 3]),
        iface.encodeFunctionData("changeThreshold", [0]),
        iface.encodeFunctionData("changeThreshold", [4]),
      ]) {
        const hash = await propose(vault, A, { to: await vault.getAddress(), data });
        await vault.connect(B).approveTransaction(hash);
        await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS)).to.be.revertedWithCustomError(vault, "SelfCallFailed");
        expect(await vault.status(hash)).to.equal(TxStatus.Executable);
      }
      expect(await vault.getOwners()).to.deep.equal([A.address, B.address, C.address]);
      expect(await vault.threshold()).to.equal(2n);
    });

    it("cannot remove the last owner or exceed 20 owners", async function () {
      const solo = await createVault({ owners: [A.address], threshold: 1 });
      await expect(runSelfCall(solo.vault, [A], iface.encodeFunctionData("removeOwner", [A.address, 1]))).to.be.revertedWithCustomError(
        solo.vault,
        "SelfCallFailed"
      );

      const twenty = [A.address, ...Array.from({ length: 19 }, () => cyprusAddress())];
      const full = await createVault({ owners: twenty, threshold: 1 });
      await expect(runSelfCall(full.vault, [A], iface.encodeFunctionData("addOwner", [B.address, 1]))).to.be.revertedWithCustomError(
        full.vault,
        "SelfCallFailed"
      );
      expect((await full.vault.getOwners()).length).to.equal(20);
    });

    it("invalidates a removed owner's approvals, and they stay invalid if the owner is re-added", async function () {
      const { vault } = await vault2of3();
      const hash = await propose(vault, A, { to: B.address, value: 1n });
      await vault.connect(C).approveTransaction(hash);
      expect(await vault.getApprovalCount(hash)).to.equal(2n);

      // The tx had quorum (A + C). Removing C must drop it back below quorum.
      await runSelfCall(vault, [A, B], iface.encodeFunctionData("removeOwner", [C.address, 2]));
      expect(await vault.getApprovalCount(hash)).to.equal(1n);
      expect(await vault.getApprovals(hash)).to.deep.equal([A.address]);
      expect(await vault.ownerEpoch(C.address)).to.equal(1n);

      await runSelfCall(vault, [A, B], iface.encodeFunctionData("addOwner", [C.address, 2]));
      expect(await vault.hasApproved(hash, C.address)).to.equal(false);
      expect(await vault.getApprovalCount(hash)).to.equal(1n);

      await vault.connect(C).approveTransaction(hash);
      expect(await vault.getApprovalCount(hash)).to.equal(2n);
    });
  });

  // ------------------------------------------------------------------ failure handling (I6)

  describe("failure handling (I6)", function () {
    it("marks a reverting call terminal, keeping at most 256 bytes of returndata", async function () {
      const { vault } = await vault2of3();
      const bomb = await (await ethers.getContractFactory("ReturnBomb")).deploy();
      const hash = await propose(vault, A, {
        to: await bomb.getAddress(),
        data: bomb.interface.encodeFunctionData("explode"),
        gasLimit: 300_000n,
      });
      await vault.connect(B).approveTransaction(hash);
      const tx = await vault.connect(A).executeTransaction(hash, { gasLimit: 2_000_000 });
      const receipt = await tx.wait();
      const failed = receipt!.logs.map((l) => vault.interface.parseLog(l)).find((l) => l?.name === "TransactionFailed")!;
      expect(ethers.getBytes(failed.args.returnData).length).to.equal(256);
      expect(await vault.status(hash)).to.equal(TxStatus.Failed);
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS)).to.be.revertedWithCustomError(vault, "TransactionAlreadyExecuted");
    });

    it("reports the target's revert reason on failure", async function () {
      const { vault } = await vault2of3();
      const bomb = await (await ethers.getContractFactory("ReturnBomb")).deploy();
      const hash = await propose(vault, A, {
        to: await bomb.getAddress(),
        data: bomb.interface.encodeFunctionData("plainRevert"),
      });
      await vault.connect(B).approveTransaction(hash);
      const reason = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["target said no"]);
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS))
        .to.emit(vault, "TransactionFailed")
        .withArgs(hash, A.address, "0x08c379a0" + reason.slice(2));
    });

    it("C2 regression: an under-gassed execute reverts instead of burning the approved transaction", async function () {
      const { vault } = await vault2of3();
      const hungry = await (await ethers.getContractFactory("GasHungry")).deploy();
      const data = hungry.interface.encodeFunctionData("burn", [20]);
      const hash = await propose(vault, A, { to: await hungry.getAddress(), data, gasLimit: 700_000n });
      await vault.connect(B).approveTransaction(hash);

      // An attacker-owner (or careless executor) supplies just enough outer gas to reach the
      // call but not enough for the call's committed gas.
      await expect(vault.connect(C).executeTransaction(hash, { gasLimit: 400_000 })).to.be.revertedWithCustomError(
        vault,
        "InsufficientGas"
      );
      expect(await vault.status(hash)).to.equal(TxStatus.Executable);
      expect(await hungry.runs()).to.equal(0n);

      await expect(vault.connect(A).executeTransaction(hash, { gasLimit: 1_500_000 })).to.emit(vault, "TransactionExecuted");
      expect(await hungry.runs()).to.equal(1n);
    });

    it("gives the call its committed gas and no more", async function () {
      const { vault } = await vault2of3();
      const hungry = await (await ethers.getContractFactory("GasHungry")).deploy();
      const data = hungry.interface.encodeFunctionData("burn", [20]);
      const hash = await propose(vault, A, { to: await hungry.getAddress(), data, gasLimit: 100_000n });
      await vault.connect(B).approveTransaction(hash);
      await expect(vault.connect(A).executeTransaction(hash, { gasLimit: 5_000_000 })).to.emit(vault, "TransactionFailed");
      expect(await hungry.runs()).to.equal(0n);
    });

    it("insufficient balance is not terminal: the transaction runs once the vault is funded", async function () {
      const { vault, address } = await createVault({ owners: [A.address, B.address], threshold: 1 });
      const hash = await propose(vault, A, { to: C.address, value: ethers.parseEther("2") });
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS))
        .to.be.revertedWithCustomError(vault, "InsufficientBalance")
        .withArgs(0, ethers.parseEther("2"));
      await A.sendTransaction({ to: address, value: ethers.parseEther("2") });
      await expect(vault.connect(A).executeTransaction(hash, EXEC_GAS)).to.changeEtherBalance(C, ethers.parseEther("2"));
    });
  });

  // ------------------------------------------------------------------ reentrancy (I10)

  describe("reentrancy (I10)", function () {
    it("blocks an owner contract from re-entering executeTransaction during a call", async function () {
      const attackerAddr = cyprusAddress();
      const art = artifacts.readArtifactSync("ReentrantAttacker");
      await network.provider.send("hardhat_setCode", [attackerAddr, art.deployedBytecode]);
      const attacker = await ethers.getContractAt("ReentrantAttacker", attackerAddr);

      const { vault, address } = await createVault({ owners: [A.address, B.address, attackerAddr], threshold: 2 });
      await A.sendTransaction({ to: address, value: ethers.parseEther("5") });

      const victim = await propose(vault, A, { to: D.address, value: ethers.parseEther("1") });
      await vault.connect(B).approveTransaction(victim);
      await attacker.arm(address, victim);

      const trigger = await propose(vault, A, { to: attackerAddr, value: 1n, gasLimit: 300_000n });
      await vault.connect(B).approveTransaction(trigger);
      await expect(vault.connect(A).executeTransaction(trigger, EXEC_GAS)).to.emit(vault, "TransactionExecuted");

      expect(await attacker.attempted()).to.equal(true);
      expect(await attacker.attackSucceeded()).to.equal(false);
      expect(await vault.status(victim)).to.equal(TxStatus.Executable);
    });
  });

  // ------------------------------------------------------------------ views (I12)

  describe("views (I12)", function () {
    it("paginates transaction hashes and rejects unbounded pages", async function () {
      const { vault } = await vault2of3();
      const hashes: string[] = [];
      for (let i = 0; i < 3; i++) hashes.push(await propose(vault, A, { to: B.address, value: BigInt(i + 1) }));
      expect(await vault.getTransactionCount()).to.equal(3n);
      expect(await vault.getTransactionHashes(0, 2)).to.deep.equal(hashes.slice(0, 2));
      expect(await vault.getTransactionHashes(2, 10)).to.deep.equal(hashes.slice(2));
      expect(await vault.getTransactionHashes(5, 10)).to.deep.equal([]);
      await expect(vault.getTransactionHashes(0, 0)).to.be.revertedWithCustomError(vault, "InvalidPagination");
      await expect(vault.getTransactionHashes(0, 101)).to.be.revertedWithCustomError(vault, "InvalidPagination");
    });

    it("reports None for unknown hashes and rejects actions on them", async function () {
      const { vault } = await vault2of3();
      expect(await vault.status(ethers.ZeroHash)).to.equal(TxStatus.None);
      await expect(vault.connect(A).approveTransaction(ethers.ZeroHash)).to.be.revertedWithCustomError(vault, "TransactionNotFound");
      await expect(vault.connect(A).expireTransaction(ethers.ZeroHash)).to.be.revertedWithCustomError(vault, "TransactionNotFound");
    });
  });
});
