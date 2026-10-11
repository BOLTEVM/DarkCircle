/**
 * DarkCircle Protocol - Milestone 3 Adversarial & Cryptographic Verification Suite
 * File: test/adversarial/challenger_m3_empirical.test.ts
 *
 * Empirical Challenger: challenger_m3_2
 * Role: Critic & Cryptographic Verification Specialist
 *
 * Adversarially verifies:
 * 1. On-Chain Graph Decoupling:
 *    - All unshield settlements logged on SimulatedBlockchain record from: relayerAddress and to: poolAddress.
 *    - Zero trace of corporate treasury key, secret key, viewing key, or address in on-chain blocks, transactions, receipts, or token transfers.
 * 2. Front-Running Protection:
 *    - Modifying recipient, amount, relayer fee, relayer address, token, or Merkle root after computing publicInputsHash causes ANTI_FRONT_RUNNING_HASH_MISMATCH.
 * 3. PPOI Sanctions Screening:
 *    - Attempting unshield from a sanctioned depositor address fails with PPOI_SANCTIONED_INPUT.
 *    - Retroactive depositor sanctioning blocks unshield.
 *    - Sanctioned payee recipient is blocked with ERR_PAYEE_SANCTIONED.
 *    - Forged PPOI proof flag isNonSanctioned=false is rejected with PPOI_SANCTIONED_INPUT.
 * 4. Boundary & Injection Stress:
 *    - Malformed headers, missing parameters, invalid schemes.
 *    - SQL injection, XSS payloads, shell metacharacters, path traversals, null bytes, unicode RTL in invoiceId.
 *    - Negative, zero, NaN, Infinity, multi-dot decimals, and MAX_UINT256 amounts.
 *    - High-concurrency flight-key coalescing with zero deadlocks.
 * 5. Forbidden Term Audit:
 *    - Absolute zero occurrences of the forbidden 4-letter term across M3 codebase and test suites.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getAddress } from "ethers";

import {
  ChallengeParser,
  parseAmountToBaseUnits,
  type ParsedPaymentChallenge
} from "../../src/proxy/parser.ts";
import {
  ReceiptCache,
  SingleFlightCoalescer,
  type CachedReceipt
} from "../../src/proxy/receiptCache.ts";
import {
  SettlementCoordinator,
  type SpendingPolicy
} from "../../src/proxy/settlement.ts";
import {
  OutboundPaymentInterceptor,
  type CorporateKeys
} from "../../src/proxy/interceptor.ts";
import {
  PaymentClient,
  OutboundPaymentProxy
} from "../../src/proxy/client.ts";
import { SimulatedBlockchain, MAX_UINT256 } from "../../src/sim/blockchain.ts";
import { ERC20Token, WQUAI_ADDRESS } from "../../src/sim/erc20Token.ts";
import {
  RailgunPool,
  RailgunSmartWallet,
  addressToBigInt
} from "../../src/sim/railgunContract.ts";
import { RelayerNetwork } from "../../src/sim/relayerNetwork.ts";
import { ResourceServer } from "../../src/server/resourceServer.ts";
import { SanctionsRegistry } from "../../src/ppoi/sanctionsList.ts";
import { PPOIEngine } from "../../src/ppoi/ppoiEngine.ts";
import { poseidon2 } from "../../src/crypto/poseidon.ts";
import { Fp, BN254_SCALAR_FIELD } from "../../src/crypto/field.ts";
import { computePublicInputsHash } from "../../src/crypto/unshield.ts";
import type { UnshieldRequest } from "../../src/types/sim.ts";

describe("Challenger M3 Empirical Verification: Outbound Private Payment Proxy", () => {
  const WQUAI = WQUAI_ADDRESS;
  const CLEAN_MERCHANT = "0x0022222254eeb25477b68fb85ed929f73a960582";
  const SANCTIONED_ADDRESS = "0x0076acc5c05d6ce88f4e49bf65bdf0c62f91353c";
  const RELAYER_ADDRESS = "0x0077777754eeb25477b68fb85ed929f73a960582";
  const ATTACKER_ADDRESS = "0x0019999954eeb25477b68fb85ed929f73a960582";

  let corporateKeys: CorporateKeys;
  let blockchain: SimulatedBlockchain;
  let usdc: ERC20Token;
  let pool: RailgunPool;
  let relayer: RelayerNetwork;
  let sanctionsRegistry: SanctionsRegistry;
  let ppoiEngine: PPOIEngine;
  let defaultPolicy: SpendingPolicy;

  beforeEach(() => {
    corporateKeys = {
      ssk: 0xa1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff01n % Fp.p,
      spk: 0xb1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff02n % Fp.p,
      vsk: 0xc1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff03n % Fp.p,
      vpk: 0xd1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff04n % Fp.p,
      npk: 0xe1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff05n % Fp.p,
      corporate0zkAddress: "0zkCorporateTreasuryMasterIdentifier999"
    };

    blockchain = new SimulatedBlockchain();
    usdc = ERC20Token.createWQUAI(blockchain);
    pool = new RailgunPool(blockchain, { mode: "trusted-harness" });

    sanctionsRegistry = new SanctionsRegistry(poseidon2, undefined, 16);
    sanctionsRegistry.loadDefaultSanctions();
    ppoiEngine = new PPOIEngine(sanctionsRegistry, 0);

    pool.registerSanctionedAddress(SANCTIONED_ADDRESS);

    relayer = new RelayerNetwork(pool, RELAYER_ADDRESS, 500_000_000_000_000_000n);

    defaultPolicy = {
      maxPaymentCap: 50_000_000_000_000_000_000n, // 50 WQUAI
      allowedTokens: [WQUAI],
      allowedChainIds: [9],
      screenRecipients: true
    };
  });

  // ===========================================================================
  // 1. On-Chain Graph Decoupling
  // ===========================================================================
  describe("1. On-Chain Graph Decoupling & Privacy Invariants", () => {
    it("verifies that every unshield settlement logged on SimulatedBlockchain records from: relayerAddress and to: poolAddress", async () => {
      const coordinator = new SettlementCoordinator({
        spendingPolicy: defaultPolicy,
        relayer,
        corporateKeys,
        ppoiEngine,
        sanctionsRegistry
      });

      const initialDeposit = 200_000_000_000_000_000_000n; // 200 WQUAI
      usdc.mint(pool.contractAddress, initialDeposit);
      const depositor = "0x0011111154eeb25477b68fb85ed929f73a960582";
      const shieldRes = pool.shield(
        WQUAI,
        initialDeposit,
        corporateKeys.npk,
        5555n,
        "treasury_seed",
        depositor
      );

      coordinator.addTreasuryUTXO({
        commitment: shieldRes.commitment,
        leafIndex: shieldRes.leafIndex,
        token: WQUAI.toLowerCase(),
        value: initialDeposit,
        blinding: 5555n,
        memo: "treasury_seed",
        depositorAddress: depositor,
        depositTimestamp: Math.floor(Date.now() / 1000) - 1000
      });

      // Execute unshield payment
      const paymentAmount = 15_000_000_000_000_000_000n; // 15 WQUAI
      const res = await coordinator.settleChallenge({
        invoiceId: "inv_decouple_001",
        amount: paymentAmount,
        tokenAddress: WQUAI,
        chainId: 9,
        recipientAddress: CLEAN_MERCHANT,
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        targetResource: "/api/v1/protected/analytics"
      });

      assert.ok(res.receipt.txHash, "Transaction hash must be generated");

      // Verify transaction inside latest block
      const latestBlock = blockchain.latestBlock;
      assert.ok(latestBlock.transactions.length > 0, "Latest block must record settlement transaction");

      const settlementTx = latestBlock.transactions.find((tx) => tx.hash === res.receipt.txHash);
      assert.ok(settlementTx, "Settlement transaction must exist in blockchain block");

      // STRICT CHECK: from must be relayerAddress, to must be poolAddress
      assert.equal(
        settlementTx.from.toLowerCase(),
        relayer.relayerAddress.toLowerCase(),
        "Transaction sender must be the independent Relayer address"
      );
      assert.equal(
        settlementTx.to.toLowerCase(),
        pool.contractAddress.toLowerCase(),
        "Transaction destination must be the Shielded Pool contract address"
      );
    });

    it("conducts exhaustive search verifying zero trace of corporate treasury key or address on ledger", async () => {
      const coordinator = new SettlementCoordinator({
        spendingPolicy: defaultPolicy,
        relayer,
        corporateKeys,
        ppoiEngine,
        sanctionsRegistry
      });

      const initialDeposit = 150_000_000_000_000_000_000n;
      usdc.mint(pool.contractAddress, initialDeposit);
      const depositor = "0x0011111154eeb25477b68fb85ed929f73a960582";
      const shieldRes = pool.shield(
        WQUAI,
        initialDeposit,
        corporateKeys.npk,
        7777n,
        "treasury_seed",
        depositor
      );

      coordinator.addTreasuryUTXO({
        commitment: shieldRes.commitment,
        leafIndex: shieldRes.leafIndex,
        token: WQUAI.toLowerCase(),
        value: initialDeposit,
        blinding: 7777n,
        memo: "treasury_seed",
        depositorAddress: depositor,
        depositTimestamp: Math.floor(Date.now() / 1000) - 1000
      });

      await coordinator.settleChallenge({
        invoiceId: "inv_audit_trace_002",
        amount: 8_000_000_000_000_000_000n,
        tokenAddress: WQUAI,
        chainId: 9,
        recipientAddress: CLEAN_MERCHANT,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });

      // Target identifiers that MUST NOT appear anywhere on ledger
      const forbiddenIdentifiers = [
        corporateKeys.corporate0zkAddress.toLowerCase(),
        corporateKeys.ssk.toString(16),
        corporateKeys.spk.toString(16),
        corporateKeys.vsk.toString(16),
        corporateKeys.vpk.toString(16),
        corporateKeys.npk.toString(16)
      ];

      const bigIntReplacer = (_k: string, v: unknown) =>
        typeof v === "bigint" ? v.toString(16) : v;

      // Scan all blocks and transactions
      for (const block of blockchain.blocks) {
        for (const tx of block.transactions) {
          const serialized = JSON.stringify(tx, bigIntReplacer).toLowerCase();
          for (const forbidden of forbiddenIdentifiers) {
            assert.equal(
              serialized.includes(forbidden),
              false,
              `Leak detected! Forbidden corporate identifier ${forbidden} found in on-chain block transaction`
            );
          }
        }
      }

      // Scan all pool events
      for (const event of pool.poolEvents) {
        const serialized = JSON.stringify(event, bigIntReplacer).toLowerCase();
        for (const forbidden of forbiddenIdentifiers) {
          assert.equal(
            serialized.includes(forbidden),
            false,
            `Leak detected! Forbidden corporate identifier ${forbidden} found in pool event log`
          );
        }
      }

      // Scan blockchain accounts map
      for (const [accountAddr] of blockchain.accounts.entries()) {
        assert.notEqual(
          accountAddr.toLowerCase(),
          corporateKeys.corporate0zkAddress.toLowerCase(),
          "Corporate 0zk address must never exist as a ledger account"
        );
      }
    });

    it("verifies sequential unshield settlements remain decoupled with independent change note tracking", async () => {
      const coordinator = new SettlementCoordinator({
        spendingPolicy: defaultPolicy,
        relayer,
        corporateKeys,
        ppoiEngine,
        sanctionsRegistry
      });

      const initialDeposit = 300_000_000_000_000_000_000n; // 300 WQUAI
      usdc.mint(pool.contractAddress, initialDeposit);
      const depositor = "0x0011111154eeb25477b68fb85ed929f73a960582";
      const shieldRes = pool.shield(
        WQUAI,
        initialDeposit,
        corporateKeys.npk,
        8888n,
        "seed",
        depositor
      );

      coordinator.addTreasuryUTXO({
        commitment: shieldRes.commitment,
        leafIndex: shieldRes.leafIndex,
        token: WQUAI.toLowerCase(),
        value: initialDeposit,
        blinding: 8888n,
        memo: "seed",
        depositorAddress: depositor,
        depositTimestamp: Math.floor(Date.now() / 1000) - 1000
      });

      // 3 consecutive unshield payments
      for (let i = 1; i <= 3; i++) {
        const res = await coordinator.settleChallenge({
          invoiceId: `inv_sequential_${i}`,
          amount: 5_000_000_000_000_000_000n,
          tokenAddress: WQUAI,
          chainId: 9,
          recipientAddress: CLEAN_MERCHANT,
          expiresAt: Math.floor(Date.now() / 1000) + 900
        });

        assert.equal(res.receipt.relayerAddress.toLowerCase(), relayer.relayerAddress.toLowerCase());
      }

      // Check change note in treasury
      assert.equal(coordinator.treasuryUTXOs.length, 1);
      const expectedBalance = initialDeposit - (3n * (5_000_000_000_000_000_000n + relayer.minimumFee));
      assert.equal(coordinator.treasuryUTXOs[0].value, expectedBalance);
    });
  });

  // ===========================================================================
  // 2. Front-Running Protection
  // ===========================================================================
  describe("2. Front-Running Resistance & Anti-Front-Running Hash Mismatch", () => {
    let unshieldReq: UnshieldRequest;

    beforeEach(() => {
      const depositAmount = 100_000_000_000_000_000_000n;
      usdc.mint(pool.contractAddress, depositAmount);
      const depositor = "0x0011111154eeb25477b68fb85ed929f73a960582";
      const shieldRes = pool.shield(WQUAI, depositAmount, corporateKeys.npk, 123n, "note", depositor);

      const nullifier = poseidon2(corporateKeys.ssk, shieldRes.commitment);
      const merkleRoot = pool.merkleTree.root;
      const relayerFee = relayer.minimumFee;
      const paymentAmount = 5_000_000_000_000_000_000n;

      const safeRecipient = getAddress(CLEAN_MERCHANT);
      const safeToken = getAddress(WQUAI);
      const safeRelayer = getAddress(relayer.relayerAddress);

      const publicInputsHash = computePublicInputsHash({
        recipient: safeRecipient,
        token: safeToken,
        amount: paymentAmount,
        relayerAddress: safeRelayer,
        relayerFee,
        merkleRoot: Fp.toHex(merkleRoot)
      });

      unshieldReq = {
        merkleRoot,
        nullifier,
        recipient: CLEAN_MERCHANT,
        token: WQUAI,
        amount: paymentAmount,
        relayerFee,
        relayerAddress: relayer.relayerAddress,
        publicInputsHash,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: depositor,
          isNonSanctioned: true,
          depositTimestamp: Math.floor(Date.now() / 1000) - 500
        }
      };
    });

    it("rejects broadcast when recipient is modified after computing public inputs hash", async () => {
      // Attacker tampers with recipient to divert payment
      const tamperedReq: UnshieldRequest = {
        ...unshieldReq,
        recipient: ATTACKER_ADDRESS
      };

      await assert.rejects(async () => {
        await relayer.broadcastUnshield(tamperedReq);
      }, /ANTI_FRONT_RUNNING_HASH_MISMATCH/);
    });

    it("rejects broadcast when payment amount is modified after computing public inputs hash", async () => {
      // Attacker tampers with payment amount (+1 base unit)
      const tamperedReq1: UnshieldRequest = {
        ...unshieldReq,
        amount: unshieldReq.amount + 1n
      };
      await assert.rejects(async () => {
        await relayer.broadcastUnshield(tamperedReq1);
      }, /ANTI_FRONT_RUNNING_HASH_MISMATCH/);

      // Attacker tampers with payment amount (inflated amount)
      const tamperedReq2: UnshieldRequest = {
        ...unshieldReq,
        amount: unshieldReq.amount * 2n
      };
      await assert.rejects(async () => {
        await relayer.broadcastUnshield(tamperedReq2);
      }, /ANTI_FRONT_RUNNING_HASH_MISMATCH/);
    });

    it("rejects broadcast when relayer fee is modified after computing public inputs hash", async () => {
      // Attacker increases relayer fee
      const tamperedReq: UnshieldRequest = {
        ...unshieldReq,
        relayerFee: unshieldReq.relayerFee + 100000n
      };

      await assert.rejects(async () => {
        await relayer.broadcastUnshield(tamperedReq);
      }, /ANTI_FRONT_RUNNING_HASH_MISMATCH/);
    });

    it("rejects broadcast when relayer fee is reduced below minimum", async () => {
      // Attacker reduces relayer fee below minimum
      const tamperedReq: UnshieldRequest = {
        ...unshieldReq,
        relayerFee: 100n
      };

      await assert.rejects(async () => {
        await relayer.broadcastUnshield(tamperedReq);
      }, /FEE_BELOW_MINIMUM/);
    });

    it("rejects broadcast when relayer address is modified", async () => {
      // Attacker switches relayer address
      const tamperedReq: UnshieldRequest = {
        ...unshieldReq,
        relayerAddress: ATTACKER_ADDRESS
      };

      await assert.rejects(async () => {
        await relayer.broadcastUnshield(tamperedReq);
      }, /RELAYER_ADDRESS_MISMATCH_FRONT_RUNNING_DETECTED/);
    });

    it("rejects broadcast when token address is modified after computing public inputs hash", async () => {
      // Attacker substitutes token address
      const alternateToken = "0x0033333354eeb25477b68fb85ed929f73a960582";
      const tamperedReq: UnshieldRequest = {
        ...unshieldReq,
        token: alternateToken
      };

      await assert.rejects(async () => {
        await relayer.broadcastUnshield(tamperedReq);
      }, /ANTI_FRONT_RUNNING_HASH_MISMATCH/);
    });

    it("rejects broadcast when Merkle root is modified after computing public inputs hash", async () => {
      // Attacker alters Merkle root
      const tamperedReq: UnshieldRequest = {
        ...unshieldReq,
        merkleRoot: Fp.mod(BigInt(unshieldReq.merkleRoot) + 1n)
      };

      await assert.rejects(async () => {
        await relayer.broadcastUnshield(tamperedReq);
      }, /ANTI_FRONT_RUNNING_HASH_MISMATCH/);
    });
  });

  // ===========================================================================
  // 3. PPOI Sanctions Screening
  // ===========================================================================
  describe("3. PPOI Sanctions Screening & Illicit Funds Quarantine", () => {
    let coordinator: SettlementCoordinator;

    beforeEach(() => {
      coordinator = new SettlementCoordinator({
        spendingPolicy: defaultPolicy,
        relayer,
        corporateKeys,
        ppoiEngine,
        sanctionsRegistry
      });
    });

    it("strictly rejects unshield when depositor address is on the sanctions list with PPOI_SANCTIONED_INPUT", async () => {
      const taintedAmount = 50_000_000_000_000_000_000n;
      usdc.mint(pool.contractAddress, taintedAmount);

      const shieldRes = pool.shield(
        WQUAI,
        taintedAmount,
        corporateKeys.npk,
        9999n,
        "tainted_deposit",
        SANCTIONED_ADDRESS
      );

      coordinator.addTreasuryUTXO({
        commitment: shieldRes.commitment,
        leafIndex: shieldRes.leafIndex,
        token: WQUAI.toLowerCase(),
        value: taintedAmount,
        blinding: 9999n,
        memo: "tainted_deposit",
        depositorAddress: SANCTIONED_ADDRESS,
        depositTimestamp: Math.floor(Date.now() / 1000) - 200
      });

      await assert.rejects(async () => {
        await coordinator.settleChallenge({
          invoiceId: "inv_sanctioned_depositor",
          amount: 5_000_000_000_000_000_000n,
          tokenAddress: WQUAI,
          chainId: 9,
          recipientAddress: CLEAN_MERCHANT,
          expiresAt: Math.floor(Date.now() / 1000) + 900
        });
      }, /PPOI_SANCTIONED_INPUT/);
    });

    it("strictly rejects unshield when depositor is retroactively added to sanctions registry", async () => {
      const initiallyCleanDepositor = "0x0055555554eeb25477b68fb85ed929f73a960582";
      const depositAmount = 50_000_000_000_000_000_000n;
      usdc.mint(pool.contractAddress, depositAmount);

      const shieldRes = pool.shield(
        WQUAI,
        depositAmount,
        corporateKeys.npk,
        12345n,
        "clean_deposit_initially",
        initiallyCleanDepositor
      );

      coordinator.addTreasuryUTXO({
        commitment: shieldRes.commitment,
        leafIndex: shieldRes.leafIndex,
        token: WQUAI.toLowerCase(),
        value: depositAmount,
        blinding: 12345n,
        memo: "clean_deposit_initially",
        depositorAddress: initiallyCleanDepositor,
        depositTimestamp: Math.floor(Date.now() / 1000) - 500
      });

      // Retroactively designate depositor as sanctioned in both registry and pool SMT
      sanctionsRegistry.addSanctionedAddress(initiallyCleanDepositor);
      pool.registerSanctionedAddress(initiallyCleanDepositor);

      await assert.rejects(async () => {
        await coordinator.settleChallenge({
          invoiceId: "inv_retroactive_sanction",
          amount: 5_000_000_000_000_000_000n,
          tokenAddress: WQUAI,
          chainId: 9,
          recipientAddress: CLEAN_MERCHANT,
          expiresAt: Math.floor(Date.now() / 1000) + 900
        });
      }, /PPOI_SANCTIONED_INPUT/);
    });

    it("strictly rejects challenge if payee recipient is sanctioned with ERR_PAYEE_SANCTIONED", () => {
      assert.throws(() => {
        coordinator.validatePolicy({
          amount: 5_000_000_000_000_000_000n,
          tokenAddress: WQUAI,
          chainId: 9,
          recipientAddress: SANCTIONED_ADDRESS
        });
      }, /ERR_PAYEE_SANCTIONED/);
    });

    it("rejects unshield when PPOI proof has isNonSanctioned=false", async () => {
      const cleanDepositor = "0x0066666654eeb25477b68fb85ed929f73a960582";
      const depositAmount = 50_000_000_000_000_000_000n;
      usdc.mint(pool.contractAddress, depositAmount);

      const shieldRes = pool.shield(
        WQUAI,
        depositAmount,
        corporateKeys.npk,
        1234n,
        "note",
        cleanDepositor
      );

      const nullifier = poseidon2(corporateKeys.ssk, shieldRes.commitment);
      const req: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier,
        recipient: CLEAN_MERCHANT,
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: cleanDepositor,
          isNonSanctioned: false // Forged / tainted flag
        }
      };

      assert.throws(() => {
        pool.unshield(req);
      }, /PPOI_SANCTIONED_INPUT/);
    });

    it("successfully settles valid unshield note from non-sanctioned depositor on identical pool", async () => {
      const cleanDepositor = "0x0077777754eeb25477b68fb85ed929f73a960582";
      const depositAmount = 50_000_000_000_000_000_000n;
      usdc.mint(pool.contractAddress, depositAmount);

      const shieldRes = pool.shield(
        WQUAI,
        depositAmount,
        corporateKeys.npk,
        3456n,
        "clean_note",
        cleanDepositor
      );

      coordinator.addTreasuryUTXO({
        commitment: shieldRes.commitment,
        leafIndex: shieldRes.leafIndex,
        token: WQUAI.toLowerCase(),
        value: depositAmount,
        blinding: 3456n,
        memo: "clean_note",
        depositorAddress: cleanDepositor,
        depositTimestamp: Math.floor(Date.now() / 1000) - 600
      });

      const res = await coordinator.settleChallenge({
        invoiceId: "inv_clean_unshield_success",
        amount: 5_000_000_000_000_000_000n,
        tokenAddress: WQUAI,
        chainId: 9,
        recipientAddress: CLEAN_MERCHANT,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });

      assert.ok(res.receipt.txHash);
      assert.equal(usdc.balanceOf(CLEAN_MERCHANT), 5_000_000_000_000_000_000n);
    });
  });

  // ===========================================================================
  // 4. Boundary & Injection Stress
  // ===========================================================================
  describe("4. Boundary Defenses & Injection Stress", () => {
    describe("Malformed Headers & Missing Parameters", () => {
      it("rejects empty headers and body with ERR_402_CHALLENGE_INVALID", () => {
        assert.throws(() => {
          ChallengeParser.parse(undefined, undefined);
        }, /ERR_402_CHALLENGE_INVALID/);

        assert.throws(() => {
          ChallengeParser.parse({}, {});
        }, /ERR_402_CHALLENGE_INVALID/);
      });

      it("rejects non-x402 WWW-Authenticate schemes", () => {
        const headers = { "WWW-Authenticate": 'Basic realm="Restricted Area"' };
        assert.throws(() => {
          ChallengeParser.parse(headers, undefined);
        }, /ERR_402_CHALLENGE_INVALID/);
      });

      it("rejects malformed syntax in WWW-Authenticate header", () => {
        const headers1 = { "WWW-Authenticate": "x402" };
        assert.throws(() => {
          ChallengeParser.parse(headers1, undefined);
        }, /ERR_402_CHALLENGE_INVALID/);

        const headers2 = { "WWW-Authenticate": "x402 ???!@#$%^&*() invalid" };
        assert.throws(() => {
          ChallengeParser.parse(headers2, undefined);
        }, /ERR_402_CHALLENGE_INVALID/);
      });

      it("rejects WWW-Authenticate missing recipient or invoiceId", () => {
        const missingRecipient = `x402 amount="5000000000000000000", invoiceId="inv_1"`;
        assert.throws(() => {
          ChallengeParser.parse({ "www-authenticate": missingRecipient });
        }, /ERR_402_CHALLENGE_INVALID/);

        const missingInvoice = `x402 recipient="${CLEAN_MERCHANT}", amount="5000000000000000000"`;
        assert.throws(() => {
          ChallengeParser.parse({ "www-authenticate": missingInvoice });
        }, /ERR_402_CHALLENGE_INVALID/);
      });

      it("rejects X-Payment-* headers missing mandatory parameters", () => {
        // Missing amount
        assert.throws(() => {
          ChallengeParser.parse({
            "x-payment-recipient": CLEAN_MERCHANT,
            "x-payment-invoice-id": "inv_x_no_amount"
          });
        }, /ERR_402_CHALLENGE_INVALID/);

        // Missing recipient
        assert.throws(() => {
          ChallengeParser.parse({
            "x-payment-amount": "5000000000000000000",
            "x-payment-invoice-id": "inv_x_no_recipient"
          });
        }, /ERR_402_CHALLENGE_INVALID/);

        // Missing invoice ID
        assert.throws(() => {
          ChallengeParser.parse({
            "x-payment-recipient": CLEAN_MERCHANT,
            "x-payment-amount": "5000000000000000000"
          });
        }, /ERR_402_CHALLENGE_INVALID/);
      });
    });

    describe("Injection Strings in invoiceId", () => {
      const injectionVectors = [
        // SQL Injections
        "' OR '1'='1",
        "'; DROP TABLE invoices; --",
        "admin'--",
        "1 UNION SELECT * FROM users--",
        // XSS Injections
        "<script>alert('xss')</script>",
        "<img src=x onerror=alert(1)>",
        "<svg onload=alert(document.domain)>",
        // Command Injections
        "; cat /etc/passwd ;",
        "$(whoami)",
        "| dir |",
        "& echo pwned &",
        // Path Traversal
        "../../../../secret.key",
        "C:\\Windows\\System32\\drivers\\etc\\hosts",
        // Unicode, Null Bytes & Special Characters
        "inv_\x00_test",
        "inv_💸_payment_⚡",
        "inv_\u202Ereversed_invoice",
        "inv_\r\nSet-Cookie: malicious=true",
        "%s%s%s%s%n",
        // Extremely long identifier (1,000 characters)
        "inv_" + "A".repeat(1000)
      ];

      for (const injection of injectionVectors) {
        it(`safely preserves injection string in invoiceId: ${injection.slice(0, 30)}...`, () => {
          const body = {
            payment: {
              recipient: CLEAN_MERCHANT,
              amount: "5000000000000000000",
              invoiceId: injection,
              token: { address: WQUAI }
            }
          };

          const parsed = ChallengeParser.parse(undefined, body);
          assert.equal(parsed.invoiceId, injection, "invoiceId must be preserved verbatim");

          // Test header formatting with injection string
          const auth = ChallengeParser.formatAuthorizationHeader(injection, "0xproof123", RELAYER_ADDRESS);
          assert.ok(auth.includes(injection));

          const headers = ChallengeParser.formatPaymentProofHeaders(injection, "0xproof123", RELAYER_ADDRESS);
          assert.equal(headers["X-Payment-Invoice-Id"], injection);

          // Test ReceiptCache indexing and eviction with injection string
          const cache = new ReceiptCache();
          const receipt: CachedReceipt = {
            cacheKey: "/resource?inv=" + encodeURIComponent(injection),
            invoiceId: injection,
            txHash: "0xtxhash_test",
            relayerAddress: RELAYER_ADDRESS,
            amount: 5_000_000_000_000_000_000n,
            token: WQUAI,
            expiresAt: Math.floor(Date.now() / 1000) + 900
          };

          cache.set(receipt.cacheKey, receipt);
          assert.equal(cache.getByInvoiceId(injection)?.invoiceId, injection);

          const evicted = cache.evictByInvoice(injection);
          assert.equal(evicted, true);
          assert.equal(cache.has(receipt.cacheKey), false);
        });
      }
    });

    describe("Amounts: Negative, Zero, Extreme BigInt & Policy Caps", () => {
      it("rejects negative amounts across all input formats", () => {
        assert.throws(() => parseAmountToBaseUnits(-1n, 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits(-5000000n, 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits(-1, 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits("-1", 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits("-5.0", 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits("-0.000001", 6), /ERR_402_CHALLENGE_INVALID/);
      });

      it("rejects zero and empty amounts across all input formats", () => {
        assert.throws(() => parseAmountToBaseUnits(0n, 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits(0, 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits("0", 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits("0.0", 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits("0.000000", 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits("", 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits("   ", 6), /ERR_402_CHALLENGE_INVALID/);
      });

      it("rejects invalid numeric strings and non-finite representations", () => {
        assert.throws(() => parseAmountToBaseUnits(NaN, 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits(Infinity, 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits(-Infinity, 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits("1.2.3", 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits("abc", 6), /ERR_402_CHALLENGE_INVALID/);
        assert.throws(() => parseAmountToBaseUnits({}, 6), /ERR_402_CHALLENGE_INVALID/);
      });

      it("rejects payment challenges exceeding maximum payment cap", () => {
        const coordinator = new SettlementCoordinator({
          spendingPolicy: {
            ...defaultPolicy,
            maxPaymentCap: 10_000_000_000_000_000_000n // 10 WQUAI cap
          },
          relayer,
          corporateKeys
        });

        // 10.000001000000000000 WQUAI (exceeds cap by 1 base unit)
        assert.throws(() => {
          coordinator.validatePolicy({
            amount: 10_000_001_000_000_000_000n,
            tokenAddress: WQUAI,
            chainId: 9,
            recipientAddress: CLEAN_MERCHANT
          });
        }, /ERR_SPENDING_POLICY_REJECTED_AMOUNT_EXCEEDS_CAP/);

        // MAX_UINT256
        assert.throws(() => {
          coordinator.validatePolicy({
            amount: MAX_UINT256,
            tokenAddress: WQUAI,
            chainId: 9,
            recipientAddress: CLEAN_MERCHANT
          });
        }, /ERR_SPENDING_POLICY_REJECTED_AMOUNT_EXCEEDS_CAP/);

        // Greater than BN254 scalar field
        assert.throws(() => {
          coordinator.validatePolicy({
            amount: BN254_SCALAR_FIELD + 1000n,
            tokenAddress: WQUAI,
            chainId: 9,
            recipientAddress: CLEAN_MERCHANT
          });
        }, /ERR_SPENDING_POLICY_REJECTED_AMOUNT_EXCEEDS_CAP/);
      });
    });

    describe("High-Concurrency SingleFlightCoalescer Stress", () => {
      it("stress-tests 50 concurrent requests across distinct flight keys with zero deadlock", async () => {
        const coalescer = new SingleFlightCoalescer<number>();
        const executedCounters: Record<string, number> = { k1: 0, k2: 0, k3: 0 };

        const makeTask = (key: "k1" | "k2" | "k3") => () =>
          new Promise<number>((resolve) => {
            executedCounters[key]++;
            setTimeout(() => resolve(executedCounters[key]), 15);
          });

        const promises: Promise<{ result: number; shared: boolean }>[] = [];
        for (let i = 0; i < 50; i++) {
          const key = i % 3 === 0 ? "k1" : i % 3 === 1 ? "k2" : "k3";
          promises.push(coalescer.execute(key, makeTask(key)));
        }

        const results = await Promise.all(promises);
        assert.equal(results.length, 50);

        // Each key should have executed exactly once
        assert.equal(executedCounters.k1, 1);
        assert.equal(executedCounters.k2, 1);
        assert.equal(executedCounters.k3, 1);

        // Lock map must be completely drained
        assert.equal(coalescer.size, 0);
      });
    });
  });

  // ===========================================================================
  // 5. Zero Occurrences of Forbidden Term Audit
  // ===========================================================================
  describe("5. Forbidden Term Verification", () => {
    it("empirically verifies zero occurrences of the forbidden 4-letter term across all proxy code and test files", () => {
      // Construct search pattern dynamically to ensure test file itself has 0 literal occurrences
      const forbiddenPattern = new RegExp(
        String.fromCharCode(109, 111, 99, 107), // 'm' 'o' 'c' 'k'
        "i"
      );

      const targetFiles = [
        "src/proxy/parser.ts",
        "src/proxy/receiptCache.ts",
        "src/proxy/settlement.ts",
        "src/proxy/interceptor.ts",
        "src/proxy/client.ts",
        "src/proxy/index.ts",
        "src/index.ts",
        "test/unit/proxy.test.ts",
        "test/adversarial/challenger_m3_empirical.test.ts"
      ];

      const violations: string[] = [];

      for (const relPath of targetFiles) {
        const fullPath = path.resolve(process.cwd(), relPath);
        if (!fs.existsSync(fullPath)) {
          violations.push(`File missing: ${relPath}`);
          continue;
        }

        const content = fs.readFileSync(fullPath, "utf-8");
        const lines = content.split("\n");

        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
          const line = lines[lineNum];
          if (forbiddenPattern.test(line)) {
            violations.push(`${relPath}:${lineNum + 1}: ${line.trim()}`);
          }
        }
      }

      assert.deepEqual(
        violations,
        [],
        `Forbidden term violations found:\n${violations.join("\n")}`
      );
    });
  });
});
