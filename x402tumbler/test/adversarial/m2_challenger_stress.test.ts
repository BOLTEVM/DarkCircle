/**
 * Milestone 2 Challenger Stress & Adversarial Test Suite
 * File: test/adversarial/m2_challenger_stress.test.ts
 *
 * Empirical verification of SimulatedBlockchain and ERC20Token:
 * - Snapshots & reverts (balances, nonces, allowances, block numbers)
 * - Raw calldata dispatch for valid calls and unknown selectors
 * - Event log querying by block number and contract address
 * - Underflows and unauthorized transferFrom enforcement
 * - EIP-2612 permit: valid signatures, forged signatures, expired deadline, replay defense
 * - Failure mode explorations: transferFrom atomicity and contract state desync
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
  WQUAI_ADDRESS,
  TOPIC_TRANSFER,
  TOPIC_APPROVAL,
  ERC20_ABI,
  ZERO_ADDRESS
} from "../../src/sim/erc20Token.ts";

describe("Milestone 2 Challenger Stress: SimulatedBlockchain & ERC20Token", () => {
  let blockchain: SimulatedBlockchain;
  let usdc: ERC20Token;
  let dai: /* second token (WQI) */ ERC20Token;

  const ALICE = "0x0011111111111111111111111111111111111111";
  const BOB = "0x0022222222222222222222222222222222222222";
  const CHARLIE = "0x0033333333333333333333333333333333333333";

  beforeEach(() => {
    blockchain = new SimulatedBlockchain();
    usdc = ERC20Token.createWQI(blockchain); // permit-capable token under test
    dai = ERC20Token.createWQUAI(blockchain);
  });

  // =========================================================================
  // 1. SimulatedBlockchain: State Snapshots and Reverts
  // =========================================================================
  describe("SimulatedBlockchain: State Snapshots and Reverts", () => {
    it("C-M2.1: Native balance and nonce modifications revert cleanly", () => {
      blockchain.fundAccount(ALICE, 50n * 10n ** 18n);
      const initialBal = blockchain.getBalance(ALICE);
      const initialNonce = blockchain.getNonce(ALICE);

      const snapshotId = blockchain.snapshot();

      // Modify balances and nonces
      blockchain.transferNative(ALICE, BOB, 15n * 10n ** 18n);
      blockchain.incrementNonce(ALICE);
      blockchain.incrementNonce(ALICE);

      assert.equal(blockchain.getBalance(ALICE), initialBal - 15n * 10n ** 18n);
      assert.equal(blockchain.getNonce(ALICE), initialNonce + 2);

      // Revert
      const success = blockchain.revert(snapshotId);
      assert.equal(success, true);
      assert.equal(blockchain.getBalance(ALICE), initialBal, "Native balance must revert");
      assert.equal(blockchain.getNonce(ALICE), initialNonce, "Nonce must revert");
    });

    it("C-M2.2: Token balances and allowances revert cleanly across accounts", () => {
      usdc.mint(ALICE, 1_000_000_000_000_000_000n);
      usdc.approve(BOB, 200_000n, ALICE);

      const snapshotId = blockchain.snapshot();

      // Mutate token balances and allowances
      usdc.mint(ALICE, 500_000_000_000_000_000n);
      usdc.transfer(BOB, 300_000n, ALICE);
      usdc.approve(BOB, 50_000n, ALICE);

      assert.equal(usdc.balanceOf(ALICE), 1_500_000_000_000_000_000n - 300_000n);
      assert.equal(usdc.balanceOf(BOB), 300_000n);
      assert.equal(usdc.allowance(ALICE, BOB), 50_000n);

      // Revert
      assert.equal(blockchain.revert(snapshotId), true);
      assert.equal(usdc.balanceOf(ALICE), 1_000_000_000_000_000_000n, "ALICE balance must revert");
      assert.equal(usdc.balanceOf(BOB), 0n, "BOB balance must revert");
      assert.equal(usdc.allowance(ALICE, BOB), 200_000n, "Allowance must revert");
    });

    it("C-M2.3: Multi-block advancements and newly created accounts revert cleanly", () => {
      const initialBlock = blockchain.currentBlockNumber;
      const initialBlockCount = blockchain.blocks.length;

      const snapshotId = blockchain.snapshot();

      blockchain.mine(5, 12);
      const EOA_NEW = "0x0019999999999999999999999999999999999999";
      blockchain.fundAccount(EOA_NEW, 10n);

      assert.equal(blockchain.currentBlockNumber, initialBlock + 5);
      assert.equal(blockchain.blocks.length, initialBlockCount + 5);
      assert.equal(blockchain.accounts.has(EOA_NEW.toLowerCase()), true);

      assert.equal(blockchain.revert(snapshotId), true);
      assert.equal(blockchain.currentBlockNumber, initialBlock);
      assert.equal(blockchain.blocks.length, initialBlockCount);
      assert.equal(blockchain.accounts.has(EOA_NEW.toLowerCase()), false);
    });

    it("C-M2.4: Nested snapshots restore intermediate and root states accurately", () => {
      usdc.mint(ALICE, 100n);
      const snapRoot = blockchain.snapshot();

      usdc.mint(ALICE, 100n);
      const snapIntermediate = blockchain.snapshot();

      usdc.mint(ALICE, 100n);
      assert.equal(usdc.balanceOf(ALICE), 300n);

      // Revert to intermediate
      assert.equal(blockchain.revert(snapIntermediate), true);
      assert.equal(usdc.balanceOf(ALICE), 200n);

      // Revert to root
      assert.equal(blockchain.revert(snapRoot), true);
      assert.equal(usdc.balanceOf(ALICE), 100n);
    });

    it("C-M2.5: Reverting to invalid or consumed snapshot returns false", () => {
      const snap = blockchain.snapshot();
      assert.equal(blockchain.revert(snap), true);
      // Already consumed
      assert.equal(blockchain.revert(snap), false);
      // Arbitrary ID
      assert.equal(blockchain.revert(9999), false);
    });

    it("C-M2.6: [Finding] Documents totalSupply desync on revert (known limitation)", () => {
      usdc.mint(ALICE, 500n);
      const initialSupply = usdc.totalSupply();
      const snap = blockchain.snapshot();

      usdc.mint(ALICE, 500n);
      assert.equal(usdc.totalSupply(), initialSupply + 500n);

      blockchain.revert(snap);
      assert.equal(usdc.balanceOf(ALICE), 500n);
      // Note: ERC20Token._totalSupply is tracked internally on the contract instance,
      // which is not deep-cloned by blockchain.snapshot().
      // Here we document that the balance reverts while totalSupply remains at post-mint value.
      assert.equal(usdc.totalSupply(), initialSupply + 500n);
    });
  });

  // =========================================================================
  // 2. SimulatedBlockchain: Raw Calldata Dispatch & EVM Execution
  // =========================================================================
  describe("SimulatedBlockchain: Raw Calldata Dispatch", () => {
    const iface = new ethers.Interface(ERC20_ABI);

    it("C-M2.7: Dispatches valid transfer calldata via executeTransaction", () => {
      usdc.mint(ALICE, 50_000_000_000_000_000_000n);
      const calldata = iface.encodeFunctionData("transfer", [BOB, 20_000_000_000_000_000_000n]);

      const receipt = blockchain.executeTransaction({
        from: ALICE,
        to: usdc.address,
        data: calldata
      });

      assert.equal(receipt.status, 1);
      assert.equal(usdc.balanceOf(BOB), 20_000_000_000_000_000_000n);
      assert.equal(usdc.balanceOf(ALICE), 30_000_000_000_000_000_000n);
      assert.equal(receipt.logs.length, 1);
      assert.equal(receipt.logs[0].topics[0], TOPIC_TRANSFER);

      const decoded = iface.decodeFunctionResult("transfer", receipt.returnData!);
      assert.equal(decoded[0], true);
    });

    it("C-M2.8: Dispatches valid approve and transferFrom calldata via executeTransaction", () => {
      usdc.mint(ALICE, 40_000_000_000_000_000_000n);

      // Approve
      const approveData = iface.encodeFunctionData("approve", [BOB, 25_000_000_000_000_000_000n]);
      const approveReceipt = blockchain.executeTransaction({
        from: ALICE,
        to: usdc.address,
        data: approveData
      });
      assert.equal(approveReceipt.status, 1);
      assert.equal(approveReceipt.logs[0].topics[0], TOPIC_APPROVAL);
      assert.equal(usdc.allowance(ALICE, BOB), 25_000_000_000_000_000_000n);

      // TransferFrom
      const transferFromData = iface.encodeFunctionData("transferFrom", [
        ALICE,
        CHARLIE,
        15_000_000_000_000_000_000n
      ]);
      const tfReceipt = blockchain.executeTransaction({
        from: BOB,
        to: usdc.address,
        data: transferFromData
      });
      assert.equal(tfReceipt.status, 1);
      assert.equal(usdc.balanceOf(CHARLIE), 15_000_000_000_000_000_000n);
      assert.equal(usdc.allowance(ALICE, BOB), 10_000_000_000_000_000_000n);
    });

    it("C-M2.9: Dispatches read-only calls via call() and decodes ABI return data", () => {
      usdc.mint(ALICE, 77_000_000_000_000_000_000n);

      const balData = iface.encodeFunctionData("balanceOf", [ALICE]);
      const balRes = blockchain.call({ to: usdc.address, data: balData });
      assert.equal(iface.decodeFunctionResult("balanceOf", balRes)[0], 77_000_000_000_000_000_000n);

      const nameRes = blockchain.call({ to: usdc.address, data: iface.encodeFunctionData("name") });
      assert.equal(iface.decodeFunctionResult("name", nameRes)[0], "Wrapped Qi");

      const decRes = blockchain.call({
        to: usdc.address,
        data: iface.encodeFunctionData("decimals")
      });
      assert.equal(Number(iface.decodeFunctionResult("decimals", decRes)[0]), 18);
    });

    it("C-M2.10: Rejects unknown function selectors on executeTransaction with status 0", () => {
      const receipt = blockchain.executeTransaction({
        from: ALICE,
        to: usdc.address,
        data: "0xdeadbeef12345678"
      });

      assert.equal(receipt.status, 0);
      assert.equal(receipt.error, "UNKNOWN_FUNCTION_SELECTOR");
      assert.equal(receipt.returnData, "0x");
      assert.equal(receipt.logs.length, 0);
    });

    it("C-M2.11: Rejects unknown function selectors on call() throwing error", () => {
      assert.throws(
        () => blockchain.call({ to: usdc.address, data: "0xdeadbeef" }),
        /UNKNOWN_FUNCTION_SELECTOR/
      );
    });

    it("C-M2.12: Rejects call() to non-contract address throwing NO_CONTRACT_AT_ADDRESS", () => {
      assert.throws(
        () => blockchain.call({ to: ALICE, data: iface.encodeFunctionData("balanceOf", [ALICE]) }),
        /NO_CONTRACT_AT_ADDRESS/
      );
    });
  });

  // =========================================================================
  // 3. SimulatedBlockchain: Event Log Querying by Block and Address
  // =========================================================================
  describe("SimulatedBlockchain: Event Log Querying", () => {
    const iface = new ethers.Interface(ERC20_ABI);

    it("C-M2.13: Emits canonical SimLogs with keccak256 topics and 32-byte zero-padded parameters", () => {
      usdc.mint(ALICE, 10_000_000_000_000_000_000n);
      const receipt = blockchain.executeTransaction({
        from: ALICE,
        to: usdc.address,
        data: iface.encodeFunctionData("transfer", [BOB, 4_000_000_000_000_000_000n])
      });

      assert.equal(receipt.logs.length, 1);
      const log = receipt.logs[0];
      assert.equal(log.address.toLowerCase(), usdc.address.toLowerCase());
      assert.equal(log.topics[0], TOPIC_TRANSFER);
      assert.equal(log.topics[1], ethers.zeroPadValue(ALICE, 32).toLowerCase());
      assert.equal(log.topics[2], ethers.zeroPadValue(BOB, 32).toLowerCase());
      assert.equal(BigInt(log.data), 4_000_000_000_000_000_000n);
      assert.equal(log.blockNumber, blockchain.currentBlockNumber);
      assert.equal(log.transactionHash, receipt.transactionHash);
    });

    it("C-M2.14: Accurately filters event logs by block number across multi-block transactions", () => {
      blockchain.createBlock();
      const block1 = blockchain.currentBlockNumber;

      usdc.mint(ALICE, 100n);
      blockchain.executeTransaction({
        from: ALICE,
        to: usdc.address,
        data: iface.encodeFunctionData("transfer", [BOB, 10n])
      });

      blockchain.createBlock();
      const block2 = blockchain.currentBlockNumber;

      blockchain.executeTransaction({
        from: ALICE,
        to: usdc.address,
        data: iface.encodeFunctionData("transfer", [BOB, 20n])
      });
      blockchain.executeTransaction({
        from: ALICE,
        to: usdc.address,
        data: iface.encodeFunctionData("transfer", [CHARLIE, 30n])
      });

      // Filter by block1
      const logsBlock1 = Array.from(blockchain.receipts.values())
        .filter((r) => r.blockNumber === block1)
        .flatMap((r) => r.logs);
      assert.equal(logsBlock1.length, 1);
      assert.equal(BigInt(logsBlock1[0].data), 10n);

      // Filter by block2
      const logsBlock2 = Array.from(blockchain.receipts.values())
        .filter((r) => r.blockNumber === block2)
        .flatMap((r) => r.logs);
      assert.equal(logsBlock2.length, 2);
    });

    it("C-M2.15: Accurately filters event logs by contract address and block range", () => {
      blockchain.createBlock();
      const targetBlock = blockchain.currentBlockNumber;

      usdc.mint(ALICE, 100n);
      dai.mint(ALICE, 100n);

      // WQUAI transfer in targetBlock
      blockchain.executeTransaction({
        from: ALICE,
        to: usdc.address,
        data: iface.encodeFunctionData("transfer", [BOB, 15n])
      });

      // WQI transfer in targetBlock
      blockchain.executeTransaction({
        from: ALICE,
        to: dai.address,
        data: iface.encodeFunctionData("transfer", [BOB, 25n])
      });

      // Query for WQUAI in targetBlock
      const usdcLogs = Array.from(blockchain.receipts.values())
        .filter((r) => r.blockNumber === targetBlock)
        .flatMap((r) => r.logs)
        .filter((l) => l.address.toLowerCase() === usdc.address.toLowerCase());

      assert.equal(usdcLogs.length, 1);
      assert.equal(BigInt(usdcLogs[0].data), 15n);

      // Query for WQI in targetBlock
      const daiLogs = Array.from(blockchain.receipts.values())
        .filter((r) => r.blockNumber === targetBlock)
        .flatMap((r) => r.logs)
        .filter((l) => l.address.toLowerCase() === dai.address.toLowerCase());

      assert.equal(daiLogs.length, 1);
      assert.equal(BigInt(daiLogs[0].data), 25n);
    });

    it("C-M2.16: [Finding] Verifies SimulatedBlockchain does not expose top-level getLogs() method", () => {
      // Documents that consumers must query blockchain.receipts or contract.events directly
      assert.equal(typeof (blockchain as any).getLogs, "undefined");
    });
  });

  // =========================================================================
  // 4. ERC20Token: Underflows and Unauthorized transferFrom
  // =========================================================================
  describe("ERC20Token: Underflows & Unauthorized transferFrom", () => {
    it("C-M2.17: transfer exceeding balance returns false and conserves balances", () => {
      usdc.mint(ALICE, 50n);
      const success = usdc.transfer(BOB, 100n, ALICE);

      assert.equal(success, false);
      assert.equal(usdc.balanceOf(ALICE), 50n);
      assert.equal(usdc.balanceOf(BOB), 0n);
    });

    it("C-M2.18: Negative transfer, mint, and burn amounts throw immediately", () => {
      assert.throws(() => usdc.transfer(BOB, -5n, ALICE), /TRANSFER_AMOUNT_CANNOT_BE_NEGATIVE/);
      assert.throws(() => usdc.mint(ALICE, -10n), /MINT_AMOUNT_CANNOT_BE_NEGATIVE/);
      assert.throws(() => usdc.burn(ALICE, -1n), /BURN_AMOUNT_CANNOT_BE_NEGATIVE/);
      assert.throws(() => usdc.approve(BOB, -1n, ALICE), /APPROVE_AMOUNT_CANNOT_BE_NEGATIVE/);
    });

    it("C-M2.19: burn exceeding balance throws INSUFFICIENT_BALANCE_TO_BURN", () => {
      usdc.mint(ALICE, 25n);
      assert.throws(() => usdc.burn(ALICE, 30n), /INSUFFICIENT_BALANCE_TO_BURN/);
      assert.equal(usdc.balanceOf(ALICE), 25n);
    });

    it("C-M2.20: Unauthorized transferFrom without allowance throws ALLOWANCE_EXCEEDED", () => {
      usdc.mint(ALICE, 100n);
      assert.equal(usdc.allowance(ALICE, BOB), 0n);

      assert.throws(
        () => usdc.transferFrom(ALICE, CHARLIE, 10n, BOB),
        /ALLOWANCE_EXCEEDED/
      );
      assert.equal(usdc.balanceOf(CHARLIE), 0n);
    });

    it("C-M2.21: transferFrom exceeding allowance throws ALLOWANCE_EXCEEDED", () => {
      usdc.mint(ALICE, 100n);
      usdc.approve(BOB, 40n, ALICE);

      assert.throws(
        () => usdc.transferFrom(ALICE, CHARLIE, 50n, BOB),
        /ALLOWANCE_EXCEEDED/
      );
      assert.equal(usdc.allowance(ALICE, BOB), 40n);
    });

    it("C-M2.22: [Finding] transferFrom atomicity: failed transfer slashes allowance", () => {
      // Alice approves Bob 100n, but Alice only possesses 20n.
      usdc.mint(ALICE, 20n);
      usdc.approve(BOB, 100n, ALICE);

      // Bob attempts to transferFrom 50n.
      // Allowance is sufficient (100 >= 50), but Alice balance is insufficient (20 < 50).
      const ok = usdc.transferFrom(ALICE, CHARLIE, 50n, BOB);
      assert.equal(ok, false, "transfer must fail due to insufficient sender balance");

      // In SimulatedBlockchain.transferFromToken, allowance was decremented before transferToken checked balance:
      // Allowance was reduced from 100n to 50n despite the transfer failing.
      const remainingAllowance = usdc.allowance(ALICE, BOB);
      assert.equal(remainingAllowance, 50n, "Documents non-atomic allowance reduction finding");
      assert.equal(usdc.balanceOf(ALICE), 20n, "Sender balance remained unchanged");
      assert.equal(usdc.balanceOf(CHARLIE), 0n, "Recipient received nothing");
    });
  });

  // =========================================================================
  // 5. ERC20Token: EIP-2612 Permit Cryptographic Stress
  // =========================================================================
  describe("ERC20Token: EIP-2612 Permit Cryptographic Stress", () => {
    it("C-M2.23: Valid permit signature via real ethers.Wallet sets allowance and increments nonce", async () => {
      const wallet = ethers.Wallet.createRandom();
      const spender = BOB;
      const value = 12_500_000_000_000_000_000n; // 12.5 WQUAI
      const deadline = blockchain.latestBlock.timestamp + 1800;

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
        owner: ethers.getAddress(wallet.address),
        spender: ethers.getAddress(spender),
        value,
        nonce: usdc.nonces(wallet.address),
        deadline
      };

      const signature = await wallet.signTypedData(domain, types, values);
      const sig = ethers.Signature.from(signature);

      const ok = usdc.permit(wallet.address, spender, value, deadline, sig.v, sig.r, sig.s);
      assert.equal(ok, true);
      assert.equal(usdc.allowance(wallet.address, spender), value);
      assert.equal(usdc.nonces(wallet.address), 1n);

      const lastEvt = usdc.events[usdc.events.length - 1];
      assert.equal(lastEvt.event, "Approval");
      assert.equal(lastEvt.owner, wallet.address.toLowerCase());
      assert.equal(lastEvt.spender, spender.toLowerCase());
      assert.equal(lastEvt.value, value);
    });

    it("C-M2.24: Forged permit signature is rejected with ERC20_PERMIT_INVALID_SIGNATURE", async () => {
      const wallet = ethers.Wallet.createRandom();
      const impostor = ethers.Wallet.createRandom();
      const deadline = blockchain.latestBlock.timestamp + 1800;

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

      // Impostor signs on behalf of Alice
      const signature = await impostor.signTypedData(domain, types, {
        owner: ethers.getAddress(wallet.address),
        spender: ethers.getAddress(BOB),
        value: 5000n,
        nonce: 0n,
        deadline
      });
      const sig = ethers.Signature.from(signature);

      assert.throws(
        () => usdc.permit(wallet.address, BOB, 5000n, deadline, sig.v, sig.r, sig.s),
        /ERC20_PERMIT_INVALID_SIGNATURE/
      );
      assert.equal(usdc.allowance(wallet.address, BOB), 0n);
      assert.equal(usdc.nonces(wallet.address), 0n);
    });

    it("C-M2.25: Expired permit deadline is rejected with ERC20_PERMIT_EXPIRED", async () => {
      const wallet = ethers.Wallet.createRandom();
      const expiredDeadline = blockchain.latestBlock.timestamp - 5;

      assert.throws(
        () =>
          usdc.permit(
            wallet.address,
            BOB,
            1000n,
            expiredDeadline,
            27,
            "0x" + "1".repeat(64),
            "0x" + "2".repeat(64)
          ),
        /ERC20_PERMIT_EXPIRED/
      );
    });

    it("C-M2.26: Replayed permit signature is rejected (verifying replay prevention and error string)", async () => {
      const wallet = ethers.Wallet.createRandom();
      const spender = BOB;
      const value = 100_000n;
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
        owner: ethers.getAddress(wallet.address),
        spender: ethers.getAddress(spender),
        value,
        nonce: usdc.nonces(wallet.address), // 0n
        deadline
      };

      const signature = await wallet.signTypedData(domain, types, values);
      const sig = ethers.Signature.from(signature);

      // First execution succeeds
      const ok = usdc.permit(wallet.address, spender, value, deadline, sig.v, sig.r, sig.s);
      assert.equal(ok, true);
      assert.equal(usdc.nonces(wallet.address), 1n);

      // Replaying the exact same signature must be rejected
      // Cryptographically, nonce incremented to 1, causing digest mismatch
      assert.throws(
        () => usdc.permit(wallet.address, spender, value, deadline, sig.v, sig.r, sig.s),
        (err: any) => {
          // Verify that rejection occurs.
          // Note: Error is ERC20_PERMIT_INVALID_SIGNATURE (EIP-2612 canonical behavior)
          // rather than custom INVALID_PERMIT_NONCE.
          return (
            /ERC20_PERMIT_INVALID_SIGNATURE/.test(err.message) ||
            /INVALID_PERMIT_NONCE/.test(err.message)
          );
        }
      );

      // Nonce must not have incremented on failed replay
      assert.equal(usdc.nonces(wallet.address), 1n);
    });

    it("C-M2.27: Tampered permit parameter (value modified) is rejected", async () => {
      const wallet = ethers.Wallet.createRandom();
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

      // Wallet signs for 100 WQUAI
      const signature = await wallet.signTypedData(domain, types, {
        owner: ethers.getAddress(wallet.address),
        spender: ethers.getAddress(BOB),
        value: 100_000_000_000_000_000_000n,
        nonce: 0n,
        deadline
      });
      const sig = ethers.Signature.from(signature);

      // Attacker attempts to claim 200 WQUAI with the same signature
      assert.throws(
        () => usdc.permit(wallet.address, BOB, 200_000_000_000_000_000_000n, deadline, sig.v, sig.r, sig.s),
        /ERC20_PERMIT_INVALID_SIGNATURE/
      );
    });

    it("C-M2.28: Boundary value testing: MAX_UINT256 permit allowance", async () => {
      const wallet = ethers.Wallet.createRandom();
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

      const signature = await wallet.signTypedData(domain, types, {
        owner: ethers.getAddress(wallet.address),
        spender: ethers.getAddress(BOB),
        value: MAX_UINT256,
        nonce: 0n,
        deadline
      });
      const sig = ethers.Signature.from(signature);

      const ok = usdc.permit(wallet.address, BOB, MAX_UINT256, deadline, sig.v, sig.r, sig.s);
      assert.equal(ok, true);
      assert.equal(usdc.allowance(wallet.address, BOB), MAX_UINT256);
    });
  });
});
