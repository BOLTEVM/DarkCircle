/**
 * Milestone 2 Unit Tests: Simulated Blockchain, ERC-20 (EIP-2612), Railgun Pool, & Relayer
 * DarkCircle Protocol - Production Standard
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";

import {
  SimulatedBlockchain,
  DEFAULT_NATIVE_BALANCE,
  MAX_UINT256,
  DEFAULT_CHAIN_ID
} from "../../src/sim/blockchain.ts";
import {
  ERC20Token,
  ZERO_ADDRESS,
  WQUAI_ADDRESS,
  WQI_ADDRESS,
  TOPIC_TRANSFER,
  TOPIC_APPROVAL,
  ERC20_ABI
} from "../../src/sim/erc20Token.ts";
import {
  RailgunSmartWallet,
  RailgunPool,
  addressToBigInt
} from "../../src/sim/railgunContract.ts";
import { RelayerNetwork } from "../../src/sim/relayerNetwork.ts";
import { poseidon2, poseidon4 } from "../../src/crypto/poseidon.ts";
import { computePublicInputsHash } from "../../src/crypto/unshield.ts";
import type { UnshieldRequest } from "../../src/types/sim.ts";

describe("Milestone 2 Unit Tests: Simulated Blockchain & Production Contracts (Production Standard)", () => {
  let blockchain: SimulatedBlockchain;
  let pool: RailgunPool;
  let relayer: RelayerNetwork;

  const WQUAI = WQUAI_ADDRESS;
  const ALICE = "0x0011111111111111111111111111111111111111";
  const BOB = "0x0022222222222222222222222222222222222222";
  const CHARLIE = "0x0033333333333333333333333333333333333333";
  const TEST_NPK = 12345678901234567890n;
  const TEST_BLINDING = 9876543210n;

  beforeEach(() => {
    blockchain = new SimulatedBlockchain();
    pool = new RailgunPool(blockchain, { mode: "trusted-harness" });
    relayer = new RelayerNetwork(pool);
  });

  // =========================================================================
  // 1. Simulated Blockchain Ledger
  // =========================================================================
  describe("SimulatedBlockchain", () => {
    it("initializes account with default 100 ETH native balance on first access", () => {
      const bal = blockchain.getBalance(ALICE);
      assert.equal(bal, DEFAULT_NATIVE_BALANCE);
    });

    it("normalizes addresses case-insensitively", () => {
      const upper = "0xABCDEF0123456789ABCDEF0123456789ABCDEF01";
      const lower = upper.toLowerCase();
      blockchain.setBalance(upper, 500n);
      assert.equal(blockchain.getBalance(lower), 500n);
    });

    it("transfers native currency successfully between accounts", () => {
      const initialAlice = blockchain.getBalance(ALICE);
      const initialBob = blockchain.getBalance(BOB);
      const transferVal = 5n * 10n ** 18n;

      const success = blockchain.transferNative(ALICE, BOB, transferVal);
      assert.equal(success, true);
      assert.equal(blockchain.getBalance(ALICE), initialAlice - transferVal);
      assert.equal(blockchain.getBalance(BOB), initialBob + transferVal);
    });

    it("fails native transfer when sender has insufficient funds", () => {
      const excessive = 1000n * 10n ** 18n;
      const success = blockchain.transferNative(ALICE, BOB, excessive);
      assert.equal(success, false);
    });

    it("starts at block 1001 after constructor initialization", () => {
      assert.equal(blockchain.currentBlockNumber, 1001);
      assert.equal(blockchain.blocks.length, 1);
      assert.equal(blockchain.blocks[0].number, 1001);
    });

    it("increments block number and records block metadata on createBlock", () => {
      const initial = blockchain.currentBlockNumber;
      const nextNum = blockchain.createBlock();
      assert.equal(nextNum, initial + 1);
      assert.equal(blockchain.currentBlockNumber, initial + 1);
      assert.equal(blockchain.latestBlock.number, initial + 1);
      assert.ok(blockchain.latestBlock.hash.startsWith("0x"));
    });

    it("mines multiple blocks with specified time interval", () => {
      const prevBlock = blockchain.currentBlockNumber;
      const prevTime = blockchain.latestBlock.timestamp;
      blockchain.mine(5, 12);
      assert.equal(blockchain.currentBlockNumber, prevBlock + 5);
      assert.ok(blockchain.latestBlock.timestamp >= prevTime + 60);
    });

    it("fastForward advances simulated block timestamp", () => {
      const t1 = blockchain.latestBlock.timestamp;
      blockchain.fastForward(600);
      blockchain.createBlock();
      assert.ok(blockchain.latestBlock.timestamp >= t1 + 600);
    });

    it("creates state snapshot and restores state cleanly on revert", () => {
      const token = ERC20Token.createWQUAI(blockchain);
      token.mint(ALICE, 1_000_000_000_000_000_000n);

      const snapshotId = blockchain.snapshot();

      token.mint(ALICE, 500_000_000_000_000_000n);
      blockchain.transferNative(ALICE, BOB, 10n * 10n ** 18n);
      blockchain.createBlock();

      assert.equal(token.balanceOf(ALICE), 1_500_000_000_000_000_000n);

      const reverted = blockchain.revert(snapshotId);
      assert.equal(reverted, true);
      assert.equal(token.balanceOf(ALICE), 1_000_000_000_000_000_000n);
      assert.equal(blockchain.getBalance(ALICE), DEFAULT_NATIVE_BALANCE);
    });
  });

  // =========================================================================
  // 2. Production-Grade ERC20Token with EIP-2612 & EVM Dispatch
  // =========================================================================
  describe("ERC20Token", () => {
    let usdc: ERC20Token;

    beforeEach(() => {
      // WQI carries EIP-2612 permit like the deployed contract; WQUAI is covered in its own block below.
      usdc = ERC20Token.createWQI(blockchain);
    });

    it("verifies WQI metadata and canonical address", () => {
      assert.equal(usdc.name, "Wrapped Qi");
      assert.equal(usdc.symbol, "WQI");
      assert.equal(usdc.decimals, 18);
      assert.equal(usdc.address, WQI_ADDRESS);
      assert.equal(usdc.supportsPermit, true);
      assert.equal(usdc.wrapsNative, false);
    });

    it("WQUAI: 18 decimals, WETH9-style wrap/unwrap backed 1:1 by native QUAI, no permit", () => {
      const wquai = ERC20Token.createWQUAI(blockchain);
      assert.equal(wquai.name, "Wrapped Quai");
      assert.equal(wquai.symbol, "WQUAI");
      assert.equal(wquai.decimals, 18);
      assert.equal(wquai.address, WQUAI_ADDRESS);

      const nativeBefore = blockchain.getBalance(ALICE);
      wquai.deposit(ALICE, 3n * 10n ** 18n);
      assert.equal(wquai.balanceOf(ALICE), 3n * 10n ** 18n);
      assert.equal(blockchain.getBalance(ALICE), nativeBefore - 3n * 10n ** 18n);
      assert.equal(blockchain.getBalance(wquai.address), 3n * 10n ** 18n + DEFAULT_NATIVE_BALANCE);

      wquai.withdraw(ALICE, 1n * 10n ** 18n);
      assert.equal(wquai.balanceOf(ALICE), 2n * 10n ** 18n);
      assert.equal(blockchain.getBalance(ALICE), nativeBefore - 2n * 10n ** 18n);

      assert.throws(() => wquai.permit(ALICE, BOB, 1n, 9_999_999_999, 27, "0x" + "1".repeat(64), "0x" + "2".repeat(64)), /ERC20_PERMIT_UNSUPPORTED/);
      assert.throws(() => usdc.deposit(ALICE, 1n), /ERC20_DEPOSIT_UNSUPPORTED/);
    });

    it("WQUAI: deposit()/withdraw() dispatch through calldata; mint() calldata is refused", () => {
      const wquai = ERC20Token.createWQUAI(blockchain);
      const iface = new ethers.Interface(ERC20_ABI);
      const dep = blockchain.executeTransaction({
        from: ALICE,
        to: wquai.address,
        value: 2n * 10n ** 18n,
        data: iface.encodeFunctionData("deposit")
      });
      assert.equal(dep.status, 1);
      assert.equal(wquai.balanceOf(ALICE), 2n * 10n ** 18n);

      const wd = blockchain.executeTransaction({
        from: ALICE,
        to: wquai.address,
        data: iface.encodeFunctionData("withdraw", [10n ** 18n])
      });
      assert.equal(wd.status, 1);
      assert.equal(wquai.balanceOf(ALICE), 10n ** 18n);

      const mint = blockchain.executeTransaction({
        from: ALICE,
        to: wquai.address,
        data: iface.encodeFunctionData("mint", [ALICE, 10n ** 30n])
      });
      assert.equal(mint.status, 0);
      assert.equal(wquai.balanceOf(ALICE), 10n ** 18n);
    });

    it("reverted call returns attached native value to the sender", () => {
      const wquai = ERC20Token.createWQUAI(blockchain);
      const iface = new ethers.Interface(ERC20_ABI);
      const before = blockchain.getBalance(ALICE);
      const r = blockchain.executeTransaction({
        from: ALICE,
        to: wquai.address,
        value: 5n * 10n ** 18n,
        data: iface.encodeFunctionData("withdraw", [10n ** 18n]) // no WQUAI balance -> reverts
      });
      assert.equal(r.status, 0);
      assert.equal(blockchain.getBalance(ALICE), before);
    });

    it("mints tokens, updates totalSupply, and emits Transfer event", () => {
      usdc.mint(ALICE, 100_000_000_000_000_000_000n);
      assert.equal(usdc.balanceOf(ALICE), 100_000_000_000_000_000_000n);
      assert.equal(usdc.totalSupply(), 100_000_000_000_000_000_000n);

      const evt = usdc.events.find((e) => e.event === "Transfer" && e.to === ALICE.toLowerCase());
      assert.ok(evt);
      assert.equal(evt.from, ZERO_ADDRESS);
      assert.equal(evt.value, 100_000_000_000_000_000_000n);
    });

    it("burns tokens and updates totalSupply, rejecting excessive burns", () => {
      usdc.mint(ALICE, 50_000_000_000_000_000_000n);
      usdc.burn(ALICE, 20_000_000_000_000_000_000n);
      assert.equal(usdc.balanceOf(ALICE), 30_000_000_000_000_000_000n);
      assert.equal(usdc.totalSupply(), 30_000_000_000_000_000_000n);

      assert.throws(() => usdc.burn(ALICE, 50_000_000_000_000_000_000n), /INSUFFICIENT_BALANCE_TO_BURN/);
    });

    it("transfers tokens directly between accounts and emits Transfer event", () => {
      usdc.mint(ALICE, 10_000_000_000_000_000_000n);
      const ok = usdc.transfer(BOB, 4_000_000_000_000_000_000n, ALICE);
      assert.equal(ok, true);
      assert.equal(usdc.balanceOf(ALICE), 6_000_000_000_000_000_000n);
      assert.equal(usdc.balanceOf(BOB), 4_000_000_000_000_000_000n);

      const evt = usdc.events[usdc.events.length - 1];
      assert.equal(evt.event, "Transfer");
      assert.equal(evt.from, ALICE.toLowerCase());
      assert.equal(evt.to, BOB.toLowerCase());
      assert.equal(evt.value, 4_000_000_000_000_000_000n);
    });

    it("approves allowances and handles transferFrom with allowance decrement", () => {
      usdc.mint(ALICE, 10_000_000_000_000_000_000n);
      usdc.approve(BOB, 5_000_000_000_000_000_000n, ALICE);
      assert.equal(usdc.allowance(ALICE, BOB), 5_000_000_000_000_000_000n);

      const ok = usdc.transferFrom(ALICE, CHARLIE, 3_000_000_000_000_000_000n, BOB);
      assert.equal(ok, true);
      assert.equal(usdc.balanceOf(ALICE), 7_000_000_000_000_000_000n);
      assert.equal(usdc.balanceOf(CHARLIE), 3_000_000_000_000_000_000n);
      assert.equal(usdc.allowance(ALICE, BOB), 2_000_000_000_000_000_000n);

      assert.throws(
        () => usdc.transferFrom(ALICE, CHARLIE, 5_000_000_000_000_000_000n, BOB),
        /ALLOWANCE_EXCEEDED/
      );
    });

    it("does not decrement allowance if set to MAX_UINT256 (infinite approval)", () => {
      usdc.mint(ALICE, 10_000_000_000_000_000_000n);
      usdc.approve(BOB, MAX_UINT256, ALICE);
      usdc.transferFrom(ALICE, CHARLIE, 2_000_000_000_000_000_000n, BOB);
      assert.equal(usdc.allowance(ALICE, BOB), MAX_UINT256);
    });

    it("computes authentic EIP-712 DOMAIN_SEPARATOR", () => {
      const sep = usdc.DOMAIN_SEPARATOR();
      assert.ok(sep.startsWith("0x"));
      assert.equal(sep.length, 66); // 32 bytes hex
    });

    it("executes cryptographic EIP-2612 permit with genuine secp256k1 signature verification", async () => {
      const wallet = ethers.Wallet.createRandom();
      const ownerAddress = wallet.address;
      const spenderAddress = BOB;
      const permitValue = 25_000_000_000_000_000_000n; // 25 WQUAI
      const deadline = blockchain.latestBlock.timestamp + 3600;

      const domain = {
        name: usdc.name,
        version: "1",
        chainId: blockchain.chainId,
        verifyingContract: ethers.getAddress(usdc.address)
      };

      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };

      const values = {
        owner: ethers.getAddress(ownerAddress),
        spender: ethers.getAddress(spenderAddress),
        value: permitValue,
        nonce: usdc.nonces(ownerAddress),
        deadline
      };

      // Sign canonical typed data with private key
      const signature = await wallet.signTypedData(domain, types, values);
      const sig = ethers.Signature.from(signature);

      // Verify permit on-contract
      const permitSuccess = usdc.permit(
        ownerAddress,
        spenderAddress,
        permitValue,
        deadline,
        sig.v,
        sig.r,
        sig.s
      );

      assert.equal(permitSuccess, true);
      assert.equal(usdc.allowance(ownerAddress, spenderAddress), permitValue);
      assert.equal(usdc.nonces(ownerAddress), 1n);

      // Emitted Approval event
      const lastEvt = usdc.events[usdc.events.length - 1];
      assert.equal(lastEvt.event, "Approval");
      assert.equal(lastEvt.owner, ownerAddress.toLowerCase());
      assert.equal(lastEvt.spender, spenderAddress.toLowerCase());
      assert.equal(lastEvt.value, permitValue);
    });

    it("rejects permit with expired deadline (ERC20_PERMIT_EXPIRED)", async () => {
      const wallet = ethers.Wallet.createRandom();
      const pastDeadline = blockchain.latestBlock.timestamp - 10;

      assert.throws(() => {
        usdc.permit(
          wallet.address,
          BOB,
          1000n,
          pastDeadline,
          27,
          "0x" + "1".repeat(64),
          "0x" + "2".repeat(64)
        );
      }, /ERC20_PERMIT_EXPIRED/);
    });

    it("rejects permit with forged/tampered signature (ERC20_PERMIT_INVALID_SIGNATURE)", async () => {
      const wallet = ethers.Wallet.createRandom();
      const impostorWallet = ethers.Wallet.createRandom();
      const deadline = blockchain.latestBlock.timestamp + 3600;

      const domain = {
        name: usdc.name,
        version: "1",
        chainId: blockchain.chainId,
        verifyingContract: ethers.getAddress(usdc.address)
      };

      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };

      // Impostor signs for Alice
      const signature = await impostorWallet.signTypedData(domain, types, {
        owner: ethers.getAddress(wallet.address),
        spender: ethers.getAddress(BOB),
        value: 1000n,
        nonce: 0n,
        deadline
      });
      const sig = ethers.Signature.from(signature);

      assert.throws(() => {
        usdc.permit(wallet.address, BOB, 1000n, deadline, sig.v, sig.r, sig.s);
      }, /ERC20_PERMIT_INVALID_SIGNATURE/);
    });

    it("dispatches raw EVM transaction calldata via handleTransaction and emits canonical SimLogs", () => {
      usdc.mint(ALICE, 50_000_000_000_000_000_000n);

      const iface = new ethers.Interface(ERC20_ABI);
      const calldata = iface.encodeFunctionData("transfer", [BOB, 15_000_000_000_000_000_000n]);

      const receipt = blockchain.executeTransaction({
        from: ALICE,
        to: usdc.address,
        data: calldata
      });

      assert.equal(receipt.status, 1);
      assert.equal(usdc.balanceOf(BOB), 15_000_000_000_000_000_000n);
      assert.equal(receipt.logs.length, 1);
      assert.equal(receipt.logs[0].topics[0], TOPIC_TRANSFER);
    });

    it("dispatches read-only calls via call() and returns ABI-encoded values", () => {
      usdc.mint(ALICE, 42_000_000_000_000_000_000n);

      const iface = new ethers.Interface(ERC20_ABI);
      const callData = iface.encodeFunctionData("balanceOf", [ALICE]);
      const returnHex = blockchain.call({ to: usdc.address, data: callData });

      const decoded = iface.decodeFunctionResult("balanceOf", returnHex);
      assert.equal(decoded[0], 42_000_000_000_000_000_000n);
    });

    it("provides ergonomic view via connect(signer)", () => {
      const aliceUsdc = usdc.connect(ALICE);
      usdc.mint(ALICE, 5_000_000_000_000_000_000n);
      assert.equal(aliceUsdc.balanceOf(), 5_000_000_000_000_000_000n);

      aliceUsdc.transfer(BOB, 2_000_000_000_000_000_000n);
      assert.equal(aliceUsdc.balanceOf(), 3_000_000_000_000_000_000n);
      assert.equal(usdc.balanceOf(BOB), 2_000_000_000_000_000_000n);
    });
  });

  // =========================================================================
  // 3. RailgunSmartWallet / RailgunPool
  // =========================================================================
  describe("RailgunSmartWallet / RailgunPool", () => {
    it("initializes with depth 16 Merkle Tree and 64 historical roots capacity", () => {
      assert.equal(pool.merkleTree.depth, 16);
      assert.equal(pool.merkleTree.maxHistoricalRoots, 64);
      assert.equal(pool.nullifiers.size, 0);
      assert.equal(pool.contractAddress, "0x000be6cd2cAc6d3e23020993eA384386A11FDF3C");
      assert.equal(pool.standbyWindowSeconds, 0);
    });

    it("seeds initial empty root in historical roots buffer", () => {
      assert.equal(pool.merkleTree.historicalRoots.length, 1);
      assert.equal(pool.merkleTree.historicalRoots[0], pool.merkleTree.root);
    });

    it("successfully shields positive token amounts and inserts leaf into tree", () => {
      const { leafIndex, commitment, root } = pool.shield(
        WQUAI,
        100_000_000_000_000_000_000n,
        TEST_NPK,
        TEST_BLINDING,
        "initial_deposit",
        "0xDepositorOrigin"
      );

      assert.equal(leafIndex, 0);
      assert.ok(commitment > 0n);
      assert.equal(root, pool.merkleTree.root);
      assert.equal(pool.merkleTree.leaves.length, 1);
      assert.equal(pool.utxoRegistry.size, 1);

      const utxo = pool.utxoRegistry.get(commitment.toString());
      assert.ok(utxo);
      assert.equal(utxo.value, 100_000_000_000_000_000_000n);
      assert.equal(utxo.depositorAddress, "0xdepositororigin");
    });

    it("rejects shielding zero amount with SHIELD_AMOUNT_MUST_BE_POSITIVE", () => {
      assert.throws(() => {
        pool.shield(WQUAI, 0n, TEST_NPK, TEST_BLINDING);
      }, /SHIELD_AMOUNT_MUST_BE_POSITIVE/);
    });

    it("rejects shielding negative amount with SHIELD_AMOUNT_MUST_BE_POSITIVE", () => {
      assert.throws(() => {
        pool.shield(WQUAI, -5_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING);
      }, /SHIELD_AMOUNT_MUST_BE_POSITIVE/);
    });

    it("evicts oldest historical roots when exceeding 64 roots", () => {
      const initialRoot = pool.merkleTree.root;
      for (let i = 0; i < 65; i++) {
        pool.shield(WQUAI, 1_000_000_000_000_000_000n, TEST_NPK, BigInt(i + 100));
      }
      assert.equal(pool.merkleTree.historicalRoots.length, 64);
      assert.equal(pool.merkleTree.historicalRoots.includes(initialRoot), false);
    });

    it("executes valid unshield, transfers tokens, pays relayer, and records nullifier", () => {
      blockchain.mintToken(WQUAI, pool.contractAddress, 100_000_000_000_000_000_000n);
      const shieldRes = pool.shield(WQUAI, 100_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "seed", ALICE);

      const recipient = BOB;
      const initialBal = blockchain.getTokenBalance(WQUAI, recipient);
      const initialRelayerBal = blockchain.getTokenBalance(WQUAI, relayer.relayerAddress);

      const unshieldReq: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 9988776655n,
        recipient,
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: 0n,
          isNonSanctioned: true
        }
      };

      const result = pool.unshield(unshieldReq);
      assert.ok(result.txHash);
      assert.ok(result.blockNumber > 0);
      assert.equal(result.nullifier, "9988776655");

      assert.equal(blockchain.getTokenBalance(WQUAI, recipient) - initialBal, 5_000_000_000_000_000_000n);
      assert.equal(
        blockchain.getTokenBalance(WQUAI, relayer.relayerAddress) - initialRelayerBal,
        500_000_000_000_000_000n
      );
      assert.ok(pool.nullifiers.has("9988776655"));
    });

    it("strictly prevents double-spend of nullifier (ERROR_NULLIFIER_ALREADY_SPENT)", () => {
      blockchain.mintToken(WQUAI, pool.contractAddress, 100_000_000_000_000_000_000n);
      pool.shield(WQUAI, 100_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "seed", ALICE);

      const unshieldReq: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 1122334455n,
        recipient: BOB,
        token: WQUAI,
        amount: 1_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: 0n,
          isNonSanctioned: true
        }
      };

      pool.unshield(unshieldReq);

      assert.throws(() => {
        pool.unshield(unshieldReq);
      }, /ERROR_NULLIFIER_ALREADY_SPENT/);
    });

    it("rejects unshield with invalid or expired Merkle root (EXPIRED_MERKLE_ROOT)", () => {
      const fakeRoot = 999999999999999999n;
      const unshieldReq: UnshieldRequest = {
        merkleRoot: fakeRoot,
        nullifier: 778899n,
        recipient: BOB,
        token: WQUAI,
        amount: 1_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: 0n,
          isNonSanctioned: true
        }
      };

      assert.throws(() => {
        pool.unshield(unshieldReq);
      }, /EXPIRED_MERKLE_ROOT/);
    });

    it("inserts change commitment if provided in unshield request", () => {
      blockchain.mintToken(WQUAI, pool.contractAddress, 100_000_000_000_000_000_000n);
      pool.shield(WQUAI, 100_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "seed", ALICE);

      const leavesBefore = pool.merkleTree.leaves.length;
      const changeCommitment = 5544332211n;

      const unshieldReq: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 33445566n,
        recipient: BOB,
        token: WQUAI,
        amount: 1_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        changeCommitment,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: 0n,
          isNonSanctioned: true
        }
      };

      pool.unshield(unshieldReq);
      assert.equal(pool.merkleTree.leaves.length, leavesBefore + 1);
      assert.equal(pool.merkleTree.leaves[pool.merkleTree.leaves.length - 1], changeCommitment);
    });

    it("rejects unshield if isNonSanctioned flag is false (PPOI_SANCTIONED_INPUT)", () => {
      blockchain.mintToken(WQUAI, pool.contractAddress, 100_000_000_000_000_000_000n);
      pool.shield(WQUAI, 100_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "seed", ALICE);

      const unshieldReq: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 44556677n,
        recipient: BOB,
        token: WQUAI,
        amount: 1_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: 0n,
          isNonSanctioned: false
        }
      };

      assert.throws(() => {
        pool.unshield(unshieldReq);
      }, /PPOI_SANCTIONED_INPUT/);
    });

    it("rejects unshield if deposit origin is dynamically registered as sanctioned", () => {
      blockchain.mintToken(WQUAI, pool.contractAddress, 100_000_000_000_000_000_000n);
      const sanctionedOrigin = "0xTaintedHackerCluster";
      const key = addressToBigInt(sanctionedOrigin);
      pool.registerSanctionedAddress(sanctionedOrigin);

      pool.shield(WQUAI, 100_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "tainted", sanctionedOrigin);

      const unshieldReq: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 55667788n,
        recipient: BOB,
        token: WQUAI,
        amount: 1_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: key,
          isNonSanctioned: true
        }
      };

      assert.throws(() => {
        pool.unshield(unshieldReq);
      }, /PPOI_SANCTIONED_INPUT/);
    });

    it("enforces standby window: rejects unshield to third party during active window", () => {
      blockchain.mintToken(WQUAI, pool.contractAddress, 100_000_000_000_000_000_000n);
      pool.standbyWindowSeconds = 300; // 5 minute window
      const depositor = "0xCorporateDepositorOrigin";
      const depositorKey = addressToBigInt(depositor);

      pool.shield(WQUAI, 10_000_000_000_000_000_000n, TEST_NPK, 12345n, "standby_test", depositor);

      const unshieldReq: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 66778899n,
        recipient: "0xThirdPartyVendor",
        token: WQUAI,
        amount: 1_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: depositorKey,
          isNonSanctioned: true
        }
      };

      assert.throws(() => {
        pool.unshield(unshieldReq);
      }, /STANDBY_WINDOW_ACTIVE_ONLY_DEPOSITOR_UNSHIELD_ALLOWED/);
    });

    it("allows unshield back to original depositor during active standby window", () => {
      blockchain.mintToken(WQUAI, pool.contractAddress, 100_000_000_000_000_000_000n);
      pool.standbyWindowSeconds = 300;
      const depositor = "0xCorporateDepositorOrigin";
      const depositorKey = addressToBigInt(depositor);

      pool.shield(WQUAI, 10_000_000_000_000_000_000n, TEST_NPK, 12345n, "standby_test", depositor);

      const unshieldReq: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 77889900n,
        recipient: depositor, // Return to self!
        token: WQUAI,
        amount: 1_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: depositorKey,
          isNonSanctioned: true
        }
      };

      const res = pool.unshield(unshieldReq);
      assert.ok(res.txHash);
    });
  });

  // =========================================================================
  // 4. RelayerNetwork
  // =========================================================================
  describe("RelayerNetwork", () => {
    beforeEach(() => {
      blockchain.mintToken(WQUAI, pool.contractAddress, 100_000_000_000_000_000_000n);
      pool.shield(WQUAI, 100_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "seed", ALICE);
    });

    it("returns accurate quote with relayerAddress and minimumFee", () => {
      const quote = relayer.getQuote(WQUAI);
      assert.equal(quote.relayerAddress, relayer.relayerAddress);
      assert.equal(quote.feeToken, WQUAI);
      assert.equal(quote.estimatedFeeUnits, relayer.minimumFee);
    });

    it("broadcasts unshield and decouples corporate treasury on-chain", async () => {
      const unshieldReq: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 88990011n,
        recipient: BOB,
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: relayer.minimumFee,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: 0n,
          isNonSanctioned: true
        }
      };

      const receipt = await relayer.broadcastUnshield(unshieldReq);
      assert.equal(receipt.status, "confirmed");
      assert.equal(receipt.relayerAddress, relayer.relayerAddress);

      // Verify on-chain pool event decouples corporate address
      const lastEvent = pool.poolEvents[pool.poolEvents.length - 1];
      assert.equal(lastEvent.type, "UNSHIELD");
      assert.equal(lastEvent.relayer, relayer.relayerAddress);
    });

    it("rejects broadcast when relayer fee is below minimum (FEE_BELOW_MINIMUM)", async () => {
      const unshieldReq: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 99001122n,
        recipient: BOB,
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: relayer.minimumFee - 1n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: 0n,
          isNonSanctioned: true
        }
      };

      await assert.rejects(async () => {
        await relayer.broadcastUnshield(unshieldReq);
      }, /FEE_BELOW_MINIMUM/);
    });

    it("detects front-running and rejects mismatched relayerAddress", async () => {
      const unshieldReq: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 11002233n,
        recipient: BOB,
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: relayer.minimumFee,
        relayerAddress: "0xAttacker_FrontRunning_Relayer",
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: 0n,
          isNonSanctioned: true
        }
      };

      await assert.rejects(async () => {
        await relayer.broadcastUnshield(unshieldReq);
      }, /RELAYER_ADDRESS_MISMATCH_FRONT_RUNNING_DETECTED/);
    });

    it("verifies cryptographic publicInputsHash binding if provided", async () => {
      const unshieldReq: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 22113344n,
        recipient: BOB,
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: relayer.minimumFee,
        relayerAddress: relayer.relayerAddress,
        publicInputsHash: "0xfaketamperedhash",
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: 0n,
          isNonSanctioned: true
        }
      };

      await assert.rejects(async () => {
        await relayer.broadcastUnshield(unshieldReq);
      }, /ANTI_FRONT_RUNNING_HASH_MISMATCH/);
    });
  });
});
