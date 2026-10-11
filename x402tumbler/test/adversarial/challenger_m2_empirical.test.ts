/**
 * Challenger M2 Empirical Stress & Security Verification Test Suite
 *
 * Adversarially verifies:
 * 1. RailgunSmartWallet:
 *    - Nullifier double-spend strictly rejected with ERROR_NULLIFIER_ALREADY_SPENT
 *    - Unshielding with expired Merkle root strictly rejected with EXPIRED_MERKLE_ROOT
 *    - Unshielding with sanctioned depositor strictly rejected with PPOI_SANCTIONED_INPUT
 *    - Zero or negative deposit amounts rejected with SHIELD_AMOUNT_MUST_BE_POSITIVE
 * 2. RelayerNetwork:
 *    - Fee below minimum rejected with FEE_BELOW_MINIMUM
 *    - Relayer front-running mismatch rejected with RELAYER_ADDRESS_MISMATCH_FRONT_RUNNING_DETECTED
 *    - Public input hash mismatch rejected with ANTI_FRONT_RUNNING_HASH_MISMATCH
 * 3. ResourceServer:
 *    - Unauthenticated request returns HTTP 402 with RFC 7807 JSON and RFC 7235 headers
 *    - Valid payment proof returns HTTP 200 OK and triggers sweep
 *    - Expired invoice returns HTTP 410
 *    - Cross-invoice transaction replay returns HTTP 409 (ERR_REPLAY_DETECTED)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { SimulatedBlockchain } from "../../src/sim/blockchain.ts";
import { ERC20Token, WQUAI_ADDRESS } from "../../src/sim/erc20Token.ts";
import {
  RailgunSmartWallet,
  RailgunPool,
  addressToBigInt
} from "../../src/sim/railgunContract.ts";
import { RelayerNetwork } from "../../src/sim/relayerNetwork.ts";
import { ResourceServer } from "../../src/server/resourceServer.ts";
import { InboundMerchantGateway } from "../e2e/harness.ts";
import { computePublicInputsHash } from "../../src/crypto/unshield.ts";
import { Fp } from "../../src/crypto/field.ts";
import type { UnshieldRequest } from "../../src/types/sim.ts";

describe("Challenger M2 Empirical Stress Verification", () => {
  let blockchain: SimulatedBlockchain;
  let pool: RailgunSmartWallet;
  let relayer: RelayerNetwork;

  const WQUAI = WQUAI_ADDRESS;
  const ALICE = "0x0011111111111111111111111111111111111111";
  const BOB = "0x0022222222222222222222222222222222222222";
  const CHARLIE = "0x0033333333333333333333333333333333333333";
  const RELAYER_ADDR = "0x0044444444444444444444444444444444444444";
  const ATTACKER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

  const TEST_NPK = 11223344556677889900n;
  const TEST_BLINDING = 99887766554433221100n;

  beforeEach(() => {
    blockchain = new SimulatedBlockchain();
    pool = new RailgunSmartWallet(blockchain, { mode: "trusted-harness" });
    relayer = new RelayerNetwork(pool, RELAYER_ADDR);
  });

  // =========================================================================
  // 1. RailgunSmartWallet Empirical Stress Tests
  // =========================================================================
  describe("1. RailgunSmartWallet Invariants", () => {
    beforeEach(() => {
      blockchain.mintToken(WQUAI, pool.contractAddress, 500_000_000_000_000_000_000n);
    });

    describe("1.1 Nullifier Double-Spend Rejection (ERROR_NULLIFIER_ALREADY_SPENT)", () => {
      it("strictly rejects identical nullifier reuse on sequential unshields", () => {
        pool.shield(WQUAI, 100_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "deposit_alice", ALICE);

        const nullifier = 0x99887766554433n;
        const unshieldReq: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier,
          recipient: BOB,
          token: WQUAI,
          amount: 10_000_000_000_000_000_000n,
          relayerFee: 500_000_000_000_000_000n,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        // First unshield MUST succeed
        const res1 = pool.unshield(unshieldReq);
        assert.ok(res1.txHash);
        assert.ok(pool.nullifiers.has(nullifier.toString()));

        // Second unshield with exact same nullifier MUST fail with ERROR_NULLIFIER_ALREADY_SPENT
        assert.throws(() => {
          pool.unshield(unshieldReq);
        }, (err: any) => {
          assert.ok(
            err.message.includes("ERROR_NULLIFIER_ALREADY_SPENT"),
            `Expected ERROR_NULLIFIER_ALREADY_SPENT, got: ${err.message}`
          );
          return true;
        });
      });

      it("strictly rejects double-spend even when attacker alters recipient and amount", () => {
        pool.shield(WQUAI, 100_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "seed", ALICE);
        const nullifier = 0x1234567890abcdefn;

        const legitimateReq: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier,
          recipient: BOB,
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
        pool.unshield(legitimateReq);

        const attackerReq: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier, // Reused nullifier!
          recipient: ATTACKER,
          token: WQUAI,
          amount: 20_000_000_000_000_000_000n, // Different amount
          relayerFee: 1_000_000_000_000_000_000n,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        const poolBalBefore = blockchain.getTokenBalance(WQUAI, pool.contractAddress);
        const attackerBalBefore = blockchain.getTokenBalance(WQUAI, ATTACKER);

        assert.throws(() => {
          pool.unshield(attackerReq);
        }, /ERROR_NULLIFIER_ALREADY_SPENT/);

        // Invariant: Pool balance and attacker balance must remain unchanged
        assert.equal(blockchain.getTokenBalance(WQUAI, pool.contractAddress), poolBalBefore);
        assert.equal(blockchain.getTokenBalance(WQUAI, ATTACKER), attackerBalBefore);
      });

      it("strictly rejects double-spend across case variations and string/bigint representation", () => {
        pool.shield(WQUAI, 100_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "seed", ALICE);
        const hexNullifier = "0xAbCdEf1234567890";

        const req1: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: hexNullifier as any,
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
        pool.unshield(req1);

        // Attempt second unshield with lower-case representation
        const req2: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: hexNullifier.toLowerCase() as any,
          recipient: CHARLIE,
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
          pool.unshield(req2);
        }, /ERROR_NULLIFIER_ALREADY_SPENT/);
      });

      it("strictly rejects rapid repetitive double-spends (stress loop)", () => {
        pool.shield(WQUAI, 100_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "seed", ALICE);
        const nullifier = 8877665544332211n;

        const req: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier,
          recipient: BOB,
          token: WQUAI,
          amount: 100_000n,
          relayerFee: 50_000n,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        pool.unshield(req);

        // 25 repeated attempts must all strictly fail
        for (let i = 0; i < 25; i++) {
          assert.throws(() => {
            pool.unshield(req);
          }, /ERROR_NULLIFIER_ALREADY_SPENT/);
        }
      });
    });

    describe("1.2 Expired Merkle Root Rejection (EXPIRED_MERKLE_ROOT)", () => {
      it("rejects unshield with completely fabricated Merkle root", () => {
        pool.shield(WQUAI, 10_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "seed", ALICE);

        const fakeRoots = [
          0n,
          9999999999999999999999999999999999999999n,
          BigInt("0x" + crypto.randomBytes(31).toString("hex")) % Fp.p
        ];

        for (const fakeRoot of fakeRoots) {
          const req: UnshieldRequest = {
            merkleRoot: fakeRoot,
            nullifier: BigInt(Math.floor(Math.random() * 1e12)),
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
            pool.unshield(req);
          }, (err: any) => {
            assert.ok(
              err.message.includes("EXPIRED_MERKLE_ROOT"),
              `Expected EXPIRED_MERKLE_ROOT, got: ${err.message}`
            );
            return true;
          });
        }
      });

      it("strictly rejects root that was evicted after ring buffer capacity (64 roots)", () => {
        // Initial root after first deposit
        const initialShield = pool.shield(WQUAI, 1_000_000_000_000_000_000n, TEST_NPK, 1n, "first", ALICE);
        const root0 = initialShield.root;
        assert.ok(pool.merkleTree.historicalRoots.includes(root0));

        // Insert exactly 63 more shields (total historical roots in buffer = 64, root0 is still present)
        for (let i = 2; i <= 64; i++) {
          pool.shield(WQUAI, 1_000_000_000_000_000_000n, TEST_NPK, BigInt(i), `fill_${i}`, ALICE);
        }
        assert.equal(pool.merkleTree.historicalRoots.length, 64);
        assert.ok(pool.merkleTree.historicalRoots.includes(root0), "root0 should still be in ring buffer");

        // Unshield using root0 at this point MUST succeed
        const reqAt64: UnshieldRequest = {
          merkleRoot: root0,
          nullifier: 5544332211n,
          recipient: BOB,
          token: WQUAI,
          amount: 500_000_000_000_000_000n,
          relayerFee: 500_000_000_000_000_000n,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };
        const resAt64 = pool.unshield(reqAt64);
        assert.ok(resAt64.txHash);

        // Now perform 1 additional shield (65th total shield) -> root0 MUST be evicted!
        pool.shield(WQUAI, 1_000_000_000_000_000_000n, TEST_NPK, 65n, "evictor", ALICE);
        assert.equal(pool.merkleTree.historicalRoots.length, 64);
        assert.equal(pool.merkleTree.historicalRoots.includes(root0), false, "root0 MUST be evicted");

        // Now unshield specifying root0 MUST strictly throw EXPIRED_MERKLE_ROOT
        const reqAfterEviction: UnshieldRequest = {
          merkleRoot: root0,
          nullifier: 9988112233n,
          recipient: BOB,
          token: WQUAI,
          amount: 500_000_000_000_000_000n,
          relayerFee: 500_000_000_000_000_000n,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        assert.throws(() => {
          pool.unshield(reqAfterEviction);
        }, (err: any) => {
          assert.ok(
            err.message.includes("EXPIRED_MERKLE_ROOT"),
            `Expected EXPIRED_MERKLE_ROOT, got: ${err.message}`
          );
          return true;
        });

        // Meanwhile, current latest root MUST succeed
        const currentRoot = pool.merkleTree.root;
        const validReqCurrent: UnshieldRequest = {
          merkleRoot: currentRoot,
          nullifier: 7711223344n,
          recipient: BOB,
          token: WQUAI,
          amount: 500_000_000_000_000_000n,
          relayerFee: 500_000_000_000_000_000n,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };
        const validRes = pool.unshield(validReqCurrent);
        assert.ok(validRes.txHash);
      });
    });

    describe("1.3 Sanctioned Depositor Unshielding Rejection (PPOI_SANCTIONED_INPUT)", () => {
      it("strictly rejects unshield when isNonSanctioned flag is false", () => {
        pool.shield(WQUAI, 10_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "seed", ALICE);

        const req: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 3311224455n,
          recipient: BOB,
          token: WQUAI,
          amount: 1_000_000_000_000_000_000n,
          relayerFee: 500_000_000_000_000_000n,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: false // Tampered or flagged sanctioned
          }
        };

        assert.throws(() => {
          pool.unshield(req);
        }, (err: any) => {
          assert.ok(
            err.message.includes("PPOI_SANCTIONED_INPUT"),
            `Expected PPOI_SANCTIONED_INPUT, got: ${err.message}`
          );
          return true;
        });
      });

      it("strictly rejects unshield when deposit origin address is registered as sanctioned in SMT", () => {
        const sanctionedHacker = "0xLazarus_Group_Tainted_Vault";
        const hackerKey = addressToBigInt(sanctionedHacker);

        // Register address as sanctioned
        pool.registerSanctionedAddress(sanctionedHacker);
        assert.notEqual(pool.sanctionsSMT.get(hackerKey), 0n);

        // Hacker shields tainted funds
        pool.shield(WQUAI, 50_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "tainted_loot", sanctionedHacker);

        // Attempting to unshield with depositOrigin as string
        const reqStrOrigin: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 4422113355n,
          recipient: BOB,
          token: WQUAI,
          amount: 5_000_000_000_000_000_000n,
          relayerFee: 500_000_000_000_000_000n,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: sanctionedHacker,
            isNonSanctioned: true
          }
        };

        assert.throws(() => {
          pool.unshield(reqStrOrigin);
        }, /PPOI_SANCTIONED_INPUT/);

        // Attempting to unshield with depositOrigin as BigInt key
        const reqBigIntOrigin: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 4422113356n,
          recipient: BOB,
          token: WQUAI,
          amount: 5_000_000_000_000_000_000n,
          relayerFee: 500_000_000_000_000_000n,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: hackerKey,
            isNonSanctioned: true
          }
        };

        assert.throws(() => {
          pool.unshield(reqBigIntOrigin);
        }, /PPOI_SANCTIONED_INPUT/);
      });

      it("strictly rejects unshield when clean deposit is later marked sanctioned (ex-post sanction)", () => {
        const suspectAccount = "0xSuspectDepositor123";
        pool.shield(WQUAI, 10_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "pre_sanction_deposit", suspectAccount);

        // Now address is flagged on sanctions list
        pool.registerSanctionedAddress(suspectAccount);

        const req: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 6611882233n,
          recipient: BOB,
          token: WQUAI,
          amount: 2_000_000_000_000_000_000n,
          relayerFee: 500_000_000_000_000_000n,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: suspectAccount,
            isNonSanctioned: true
          }
        };

        assert.throws(() => {
          pool.unshield(req);
        }, /PPOI_SANCTIONED_INPUT/);
      });
    });

    describe("1.4 Shield Amount Validation (SHIELD_AMOUNT_MUST_BE_POSITIVE)", () => {
      it("strictly rejects zero amount deposit (0n)", () => {
        assert.throws(() => {
          pool.shield(WQUAI, 0n, TEST_NPK, TEST_BLINDING, "zero_deposit", ALICE);
        }, (err: any) => {
          assert.ok(
            err.message.includes("SHIELD_AMOUNT_MUST_BE_POSITIVE"),
            `Expected SHIELD_AMOUNT_MUST_BE_POSITIVE, got: ${err.message}`
          );
          return true;
        });
      });

      it("strictly rejects negative amount deposits (-1n, -5_000_000_000_000_000_000n)", () => {
        const negativeAmounts = [-1n, -100n, -5_000_000_000_000_000_000n, -1_000_000_000_000_000_000_000n];

        for (const negAmount of negativeAmounts) {
          assert.throws(() => {
            pool.shield(WQUAI, negAmount, TEST_NPK, TEST_BLINDING, "neg_deposit", ALICE);
          }, (err: any) => {
            assert.ok(
              err.message.includes("SHIELD_AMOUNT_MUST_BE_POSITIVE"),
              `Expected SHIELD_AMOUNT_MUST_BE_POSITIVE, got: ${err.message}`
            );
            return true;
          });
        }
      });

      it("accepts minimal positive amount (1n) and inserts into tree", () => {
        const initialLeaves = pool.merkleTree.leaves.length;
        const res = pool.shield(WQUAI, 1n, TEST_NPK, TEST_BLINDING, "minimal", ALICE);
        assert.equal(res.leafIndex, initialLeaves);
        assert.ok(res.commitment > 0n);
        assert.equal(pool.merkleTree.leaves.length, initialLeaves + 1);
      });
    });
  });

  // =========================================================================
  // 2. RelayerNetwork Empirical Stress Tests
  // =========================================================================
  describe("2. RelayerNetwork Invariants", () => {
    beforeEach(() => {
      blockchain.mintToken(WQUAI, pool.contractAddress, 500_000_000_000_000_000_000n);
      pool.shield(WQUAI, 100_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "seed", ALICE);
    });

    describe("2.1 Fee Below Minimum Rejection (FEE_BELOW_MINIMUM)", () => {
      it("rejects broadcast when relayer fee is 1 unit below minimumFee", async () => {
        const insufficientFee = relayer.minimumFee - 1n;

        const req: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 1122339900n,
          recipient: BOB,
          token: WQUAI,
          amount: 5_000_000_000_000_000_000n,
          relayerFee: insufficientFee,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        await assert.rejects(async () => {
          await relayer.broadcastUnshield(req);
        }, (err: any) => {
          assert.ok(
            err.message.includes("FEE_BELOW_MINIMUM"),
            `Expected FEE_BELOW_MINIMUM, got: ${err.message}`
          );
          return true;
        });
      });

      it("rejects broadcast when relayer fee is zero or negative", async () => {
        const zeroFeeReq: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 1122339901n,
          recipient: BOB,
          token: WQUAI,
          amount: 5_000_000_000_000_000_000n,
          relayerFee: 0n,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        await assert.rejects(async () => {
          await relayer.broadcastUnshield(zeroFeeReq);
        }, /FEE_BELOW_MINIMUM/);

        const negativeFeeReq: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 1122339902n,
          recipient: BOB,
          token: WQUAI,
          amount: 5_000_000_000_000_000_000n,
          relayerFee: -500_000_000_000_000_000n,
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        await assert.rejects(async () => {
          await relayer.broadcastUnshield(negativeFeeReq);
        }, /FEE_BELOW_MINIMUM/);
      });

      it("enforces dynamically updated minimumFee", async () => {
        const originalMin = relayer.minimumFee; // 500,000n
        relayer.setMinimumFee(2_000_000_000_000_000_000n); // Raised to 2.0 WQUAI

        const req: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 1122339903n,
          recipient: BOB,
          token: WQUAI,
          amount: 5_000_000_000_000_000_000n,
          relayerFee: originalMin, // Now below the updated minimum!
          relayerAddress: relayer.relayerAddress,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        await assert.rejects(async () => {
          await relayer.broadcastUnshield(req);
        }, /FEE_BELOW_MINIMUM/);

        // Updating fee to meet new minimum succeeds
        req.relayerFee = 2_000_000_000_000_000_000n;
        const receipt = await relayer.broadcastUnshield(req);
        assert.equal(receipt.status, "confirmed");
      });
    });

    describe("2.2 Relayer Front-Running Mismatch (RELAYER_ADDRESS_MISMATCH_FRONT_RUNNING_DETECTED)", () => {
      it("strictly detects and rejects front-running attempt when relayerAddress is hijacked", async () => {
        const attackerRelayer = "0xAttacker_FrontRunning_Broadcaster";

        const hijackedReq: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 5566778899n,
          recipient: BOB,
          token: WQUAI,
          amount: 5_000_000_000_000_000_000n,
          relayerFee: relayer.minimumFee,
          relayerAddress: attackerRelayer, // Hijacked relayer binding
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        await assert.rejects(async () => {
          await relayer.broadcastUnshield(hijackedReq);
        }, (err: any) => {
          assert.ok(
            err.message.includes("RELAYER_ADDRESS_MISMATCH_FRONT_RUNNING_DETECTED"),
            `Expected RELAYER_ADDRESS_MISMATCH_FRONT_RUNNING_DETECTED, got: ${err.message}`
          );
          return true;
        });
      });

      it("normalizes relayerAddress case-insensitively while preventing address substitution", async () => {
        // Case variation of the legitimate relayer address should be accepted
        const legitimateMixedCase = relayer.relayerAddress.toUpperCase();

        const validReq: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 5566778801n,
          recipient: BOB,
          token: WQUAI,
          amount: 1_000_000_000_000_000_000n,
          relayerFee: relayer.minimumFee,
          relayerAddress: legitimateMixedCase,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        const res = await relayer.broadcastUnshield(validReq);
        assert.equal(res.status, "confirmed");
      });
    });

    describe("2.3 Public Input Hash Verification (ANTI_FRONT_RUNNING_HASH_MISMATCH)", () => {
      it("rejects broadcast when publicInputsHash does not match computed parameters", async () => {
        const tamperedHash = "0x" + crypto.randomBytes(32).toString("hex");

        const req: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 7788990011n,
          recipient: BOB,
          token: WQUAI,
          amount: 5_000_000_000_000_000_000n,
          relayerFee: relayer.minimumFee,
          relayerAddress: relayer.relayerAddress,
          publicInputsHash: tamperedHash, // Forged / mismatched hash
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        await assert.rejects(async () => {
          await relayer.broadcastUnshield(req);
        }, (err: any) => {
          assert.ok(
            err.message.includes("ANTI_FRONT_RUNNING_HASH_MISMATCH"),
            `Expected ANTI_FRONT_RUNNING_HASH_MISMATCH, got: ${err.message}`
          );
          return true;
        });
      });

      it("accepts broadcast when authentic publicInputsHash is provided", async () => {
        const rootHex = Fp.toHex(pool.merkleTree.root);
        const amount = 3_000_000_000_000_000_000n;
        const fee = relayer.minimumFee;

        const validHash = computePublicInputsHash({
          recipient: BOB,
          token: WQUAI,
          amount,
          relayerAddress: relayer.relayerAddress,
          relayerFee: fee,
          merkleRoot: rootHex
        });

        const req: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 7788990022n,
          recipient: BOB,
          token: WQUAI,
          amount,
          relayerFee: fee,
          relayerAddress: relayer.relayerAddress,
          publicInputsHash: validHash,
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        const receipt = await relayer.broadcastUnshield(req);
        assert.equal(receipt.status, "confirmed");
        assert.equal(receipt.relayerAddress, relayer.relayerAddress);
      });

      it("detects parameter tampering: recipient modification invalidates authentic publicInputsHash", async () => {
        const rootHex = Fp.toHex(pool.merkleTree.root);
        const amount = 3_000_000_000_000_000_000n;
        const fee = relayer.minimumFee;

        // Hash computed for BOB as recipient
        const validHashForBob = computePublicInputsHash({
          recipient: BOB,
          token: WQUAI,
          amount,
          relayerAddress: relayer.relayerAddress,
          relayerFee: fee,
          merkleRoot: rootHex
        });

        // Attacker intercepts and swaps recipient to ATTACKER
        const tamperedReq: UnshieldRequest = {
          merkleRoot: pool.merkleTree.root,
          nullifier: 7788990033n,
          recipient: ATTACKER, // Tampered!
          token: WQUAI,
          amount,
          relayerFee: fee,
          relayerAddress: relayer.relayerAddress,
          publicInputsHash: validHashForBob, // Still carries Bob's hash
          ppoiProof: {
            sanctionsRoot: pool.sanctionsSMT.root,
            depositOrigin: 0n,
            isNonSanctioned: true
          }
        };

        await assert.rejects(async () => {
          await relayer.broadcastUnshield(tamperedReq);
        }, /ANTI_FRONT_RUNNING_HASH_MISMATCH/);
      });
    });
  });

  // =========================================================================
  // 3. ResourceServer Empirical Stress Tests
  // =========================================================================
  describe("3. ResourceServer x402 Protocol & Security Defenses", () => {
    let serverStandalone: ResourceServer;
    let serverIntegrated: ResourceServer;
    let gateway: InboundMerchantGateway;

    const MERCHANT_KEY = "darkcircle_challenger_secret_merchant_key";
    const CORP_0ZK = "0zk1qcorporate0zkaddressforprivacygateway123456789";
    const CORP_NPK = 77777777777777777777n;

    beforeEach(() => {
      // 1. Standalone zero-config server
      serverStandalone = new ResourceServer({ demo: true });

      // 2. Gateway-integrated server
      gateway = new InboundMerchantGateway(
        MERCHANT_KEY,
        CORP_0ZK,
        CORP_NPK,
        blockchain as any,
        pool as any
    );
      serverIntegrated = new ResourceServer(gateway);
    });

    describe("3.1 Unauthenticated Request -> HTTP 402 with RFC 7807 JSON & RFC 7235 Headers", () => {
      it("returns compliant RFC 7807 problem details and RFC 7235 headers on /analytics", async () => {
        for (const srv of [serverStandalone, serverIntegrated]) {
          const res = await srv.handleRequest("GET", "/api/v1/protected/analytics");

          // Status check
          assert.equal(res.status, 402, "Must return HTTP 402 Payment Required");

          // Headers check (RFC 7235 + x402 headers)
          assert.equal(res.headers["Content-Type"], "application/problem+json");
          assert.equal(res.headers["X-Payment-Required"], "true");
          assert.equal(res.headers["X-Payment-Scheme"], "x402-v1");
          assert.equal(res.headers["X-Payment-Network"], "quai-cyprus1");
          assert.equal(res.headers["X-Payment-Amount"], "5000000000000000000"); // 5 WQUAI
          assert.ok(res.headers["X-Payment-Token"]);
          assert.ok(res.headers["X-Payment-Recipient"].startsWith("0x"));
          assert.ok(res.headers["X-Payment-Invoice-Id"].startsWith("inv_"));
          assert.ok(res.headers["WWW-Authenticate"].startsWith("x402 "));
          assert.ok(res.headers["WWW-Authenticate"].includes('scheme="erc20_transfer"'));

          // RFC 7807 problem details JSON structure
          assert.equal(res.body.type, "https://darkcircle.network/errors/payment-required");
          assert.equal(res.body.title, "Payment Required");
          assert.equal(res.body.status, 402);
          assert.equal(res.body.instance, "/api/v1/protected/analytics");
          assert.ok(res.body.detail);
          assert.ok(res.body.payment);
          assert.equal(res.body.payment.protocol, "x402");
          assert.equal(res.body.payment.amount, "5000000000000000000");
          assert.equal(res.body.payment.ephemeral, true);
          assert.equal(res.body.payment.proofType, "tx_receipt");
        }
      });

      it("returns compliant 402 on /ai-inference with 10 WQUAI required", async () => {
        const res = await serverIntegrated.handleRequest(
          "POST",
          "/api/v1/protected/ai-inference",
          {},
          { model: "llama-3-8b" }
        );

        assert.equal(res.status, 402);
        assert.equal(res.headers["X-Payment-Amount"], "10000000000000000000");
        assert.equal(res.body.payment.amount, "10000000000000000000");
        assert.equal(res.body.instance, "/api/v1/protected/ai-inference");
      });

      it("returns 402 via Web Fetch API interface", async () => {
        const response = await serverStandalone.fetch("http://localhost/api/v1/protected/analytics");
        assert.equal(response.status, 402);
        assert.equal(response.headers.get("x-payment-required"), "true");
        const json = (await response.json()) as any;
        assert.equal(json.title, "Payment Required");
        assert.equal(json.status, 402);
      });
    });

    describe("3.2 Valid Payment Proof -> HTTP 200 OK & Triggers Sweep", () => {
      it("grants HTTP 200 OK on valid settlement and automatically triggers sweep (Standalone)", async () => {
        // 1. Trigger 402 challenge
        const chRes = await serverStandalone.handleRequest("GET", "/api/v1/protected/analytics");
        const invoiceId = chRes.headers["X-Payment-Invoice-Id"];
        const txHash = "0x" + crypto.randomBytes(32).toString("hex");

        // 2. Submit payment proof
        const grantRes = await serverStandalone.handleRequest("GET", "/api/v1/protected/analytics", {
          "x-payment-invoice-id": invoiceId,
          "x-payment-proof": txHash
        });

        // 3. Verify HTTP 200 OK response
        assert.equal(grantRes.status, 200);
        assert.equal(grantRes.headers["X-Payment-Status"], "SETTLED");
        assert.ok(grantRes.headers["X-Payment-Receipt-Id"].startsWith("rct_"));
        // The demo gateway cannot see who paid, so it must not claim decoupling.
        assert.equal(grantRes.headers["X-Payment-Relayer-Decoupled"], undefined);
        assert.equal(grantRes.body.status, "success");
        assert.ok(grantRes.body.data.activeUsers);

        // 4. Verify auto-sweep triggered: ephemeral key zeroed out
        const invoice = serverStandalone.gateway.invoiceRegistry?.get(invoiceId);
        assert.ok(invoice);
        assert.equal(invoice.status, "SWEPT");
        assert.equal(
          invoice.ephemeralPrivateKey,
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        );
      });

      it("grants HTTP 200 OK on valid settlement and sweeps funds to corporate pool (Integrated)", async () => {
        // 1. Challenge
        const challenge = gateway.createPaymentChallenge(
          "/api/v1/protected/analytics",
          5_000_000_000_000_000_000n,
          WQUAI
        );
        const { invoiceId, ephemeralAddress } = challenge.invoice;

        // 2. Fund ephemeral address on simulated chain
        blockchain.mintToken(WQUAI, ephemeralAddress, 5_000_000_000_000_000_000n);

        // 3. Submit proof
        const txHash = "0x" + crypto.randomBytes(32).toString("hex");
        const grantRes = await serverIntegrated.handleRequest("GET", "/api/v1/protected/analytics", {
          "X-Payment-Invoice-Id": invoiceId,
          "X-Payment-Proof": txHash
        });

        assert.equal(grantRes.status, 200);
        assert.equal(grantRes.headers["X-Payment-Status"], "SETTLED");

        // 4. Verify auto-sweep completed
        const invoice = gateway.invoiceRegistry.get(invoiceId)!;
        assert.equal(invoice.status, "SWEPT");
        assert.equal(
          invoice.ephemeralPrivateKey,
          "0x0000000000000000000000000000000000000000000000000000000000000000"
        );
      });
    });

    describe("3.3 Expired Invoice Rejection -> HTTP 410", () => {
      it("returns HTTP 410 Gone when invoice is expired (Standalone)", async () => {
        // Manually generate an expired invoice (TTL = -100)
        const ch = serverStandalone.gateway.createPaymentChallenge(
          "/api/v1/protected/analytics",
          5_000_000_000_000_000_000n,
          WQUAI,
          "WQUAI",
          18,
          -100 // Expired in the past!
        );

        const res = await serverStandalone.handleRequest("GET", "/api/v1/protected/analytics", {
          "x-payment-invoice-id": ch.invoice.invoiceId,
          "x-payment-proof": "0x" + "ab".repeat(32)
        });

        assert.equal(res.status, 410, "Must return HTTP 410 Gone");
        assert.equal(res.body.error, "ERR_INVOICE_EXPIRED");
      });

      it("returns HTTP 410 Gone when invoice is expired (Integrated)", async () => {
        const ch = gateway.createPaymentChallenge(
          "/api/v1/protected/analytics",
          5_000_000_000_000_000_000n,
          WQUAI,
          "WQUAI",
          18,
          -50 // Expired
        );

        const res = await serverIntegrated.handleRequest("GET", "/api/v1/protected/analytics", {
          "x-payment-invoice-id": ch.invoice.invoiceId,
          "x-payment-proof": "0x" + "ab".repeat(32)
        });

        assert.equal(res.status, 410, "Must return HTTP 410 Gone");
        assert.equal(res.body.error, "ERR_INVOICE_EXPIRED");
      });
    });

    describe("3.4 Cross-Invoice Transaction Replay Rejection -> HTTP 409 (ERR_REPLAY_DETECTED)", () => {
      it("strictly rejects transaction hash reuse across different invoices (Standalone)", async () => {
        // Step 1: Create and settle invoice 1
        const ch1 = serverStandalone.gateway.createPaymentChallenge(
          "/api/v1/protected/analytics",
          5_000_000_000_000_000_000n,
          WQUAI
        );
        const legitimateTxHash = "0x" + crypto.randomBytes(32).toString("hex");

        const res1 = await serverStandalone.handleRequest("GET", "/api/v1/protected/analytics", {
          "x-payment-invoice-id": ch1.invoice.invoiceId,
          "x-payment-proof": legitimateTxHash
        });
        assert.equal(res1.status, 200);

        // Step 2: Attacker gets challenge for invoice 2 and attempts to replay legitimateTxHash
        const ch2 = serverStandalone.gateway.createPaymentChallenge(
          "/api/v1/protected/ai-inference",
          10_000_000_000_000_000_000n,
          WQUAI
        );

        const replayRes = await serverStandalone.handleRequest("POST", "/api/v1/protected/ai-inference", {
          "x-payment-invoice-id": ch2.invoice.invoiceId,
          "x-payment-proof": legitimateTxHash // Replayed!
        });

        assert.equal(replayRes.status, 409, "Must return HTTP 409 Conflict");
        assert.equal(replayRes.body.error, "ERR_REPLAY_DETECTED");

        // Invariant: invoice 2 must remain PENDING
        const inv2 = serverStandalone.gateway.invoiceRegistry?.get(ch2.invoice.invoiceId);
        assert.equal(inv2?.status, "PENDING");
      });

      it("strictly rejects transaction hash reuse across different invoices (Integrated)", async () => {
        // Invoice 1 settled
        const ch1 = gateway.createPaymentChallenge("/api/v1/protected/analytics", 5_000_000_000_000_000_000n, WQUAI);
        blockchain.mintToken(WQUAI, ch1.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
        const txHash = "0x" + crypto.randomBytes(32).toString("hex");

        const res1 = await serverIntegrated.handleRequest("GET", "/api/v1/protected/analytics", {
          "x-payment-invoice-id": ch1.invoice.invoiceId,
          "x-payment-proof": txHash
        });
        assert.equal(res1.status, 200);

        // Invoice 2 replayed with txHash
        const ch2 = gateway.createPaymentChallenge("/api/v1/protected/ai-inference", 10_000_000_000_000_000_000n, WQUAI);
        blockchain.mintToken(WQUAI, ch2.invoice.ephemeralAddress, 10_000_000_000_000_000_000n);

        const replayRes = await serverIntegrated.handleRequest("POST", "/api/v1/protected/ai-inference", {
          "x-payment-invoice-id": ch2.invoice.invoiceId,
          "x-payment-proof": txHash
        });

        assert.equal(replayRes.status, 409);
        assert.equal(replayRes.body.error, "ERR_REPLAY_DETECTED");
      });

      it("allows idempotent replay for the SAME invoice (legitimate retry)", async () => {
        const ch = serverStandalone.gateway.createPaymentChallenge(
          "/api/v1/protected/analytics",
          5_000_000_000_000_000_000n,
          WQUAI
        );
        const txHash = "0x" + crypto.randomBytes(32).toString("hex");

        const res1 = await serverStandalone.handleRequest("GET", "/api/v1/protected/analytics", {
          "x-payment-invoice-id": ch.invoice.invoiceId,
          "x-payment-proof": txHash
        });
        assert.equal(res1.status, 200);

        // Same invoice retried with same txHash MUST be idempotent (200 OK)
        const res2 = await serverStandalone.handleRequest("GET", "/api/v1/protected/analytics", {
          "x-payment-invoice-id": ch.invoice.invoiceId,
          "x-payment-proof": txHash
        });
        assert.equal(res2.status, 200);
      });
    });

    describe("3.5 Underpayment Attack Defense (ERR_UNDERPAYMENT)", () => {
      it("rejects access when on-chain deposit is less than required amount", async () => {
        const ch = gateway.createPaymentChallenge("/api/v1/protected/analytics", 5_000_000_000_000_000_000n, WQUAI);
        // Attacker funds only 1 WQUAI instead of 5 WQUAI
        blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 1_000_000_000_000_000_000n);
        const txHash = "0x" + crypto.randomBytes(32).toString("hex");

        const res = await serverIntegrated.handleRequest("GET", "/api/v1/protected/analytics", {
          "x-payment-invoice-id": ch.invoice.invoiceId,
          "x-payment-proof": txHash
        });

        assert.equal(res.status, 402, "Underpayment must return HTTP 402");
        assert.equal(res.body.error, "ERR_UNDERPAYMENT");
      });
    });

    describe("3.6 Non-Existent Invoice Defense (ERR_INVOICE_NOT_FOUND)", () => {
      it("returns HTTP 404 when invoiceId is unrecognized", async () => {
        const fakeInvoiceId = "inv_nonexistent_fictional_id_99999";
        const txHash = "0x" + crypto.randomBytes(32).toString("hex");

        const res = await serverIntegrated.handleRequest("GET", "/api/v1/protected/analytics", {
          "x-payment-invoice-id": fakeInvoiceId,
          "x-payment-proof": txHash
        });

        assert.equal(res.status, 404, "Unknown invoice must return HTTP 404");
        assert.equal(res.body.error, "ERR_INVOICE_NOT_FOUND");
      });
    });

    describe("3.7 Multi-Scheme Authorization Header Support", () => {
      it("accepts Authorization: x402 scheme challenge response", async () => {
        const ch = serverStandalone.gateway.createPaymentChallenge("/api/v1/protected/analytics", 5_000_000_000_000_000_000n, WQUAI);
        const txHash = "0x" + crypto.randomBytes(32).toString("hex");

        const authHeader = `x402 scheme="erc20_transfer", invoice="${ch.invoice.invoiceId}", proof="${txHash}"`;
        const res = await serverStandalone.handleRequest("GET", "/api/v1/protected/analytics", {
          Authorization: authHeader
        });

        assert.equal(res.status, 200);
        assert.equal(res.headers["X-Payment-Status"], "SETTLED");
      });

      it("accepts Authorization: Bearer JSON-encoded token", async () => {
        const ch = serverStandalone.gateway.createPaymentChallenge("/api/v1/protected/analytics", 5_000_000_000_000_000_000n, WQUAI);
        const txHash = "0x" + crypto.randomBytes(32).toString("hex");

        const token = JSON.stringify({ invoiceId: ch.invoice.invoiceId, proof: txHash });
        const res = await serverStandalone.handleRequest("GET", "/api/v1/protected/analytics", {
          Authorization: `Bearer ${token}`
        });

        assert.equal(res.status, 200);
      });

      it("accepts Authorization: Bearer Base64-encoded token", async () => {
        const ch = serverStandalone.gateway.createPaymentChallenge("/api/v1/protected/analytics", 5_000_000_000_000_000_000n, WQUAI);
        const txHash = "0x" + crypto.randomBytes(32).toString("hex");

        const tokenJson = JSON.stringify({ invoiceId: ch.invoice.invoiceId, proof: txHash });
        const b64 = Buffer.from(tokenJson).toString("base64");
        const res = await serverStandalone.handleRequest("GET", "/api/v1/protected/analytics", {
          Authorization: `Bearer ${b64}`
        });

        assert.equal(res.status, 200);
      });
    });
  });

  // =========================================================================
  // 4. On-Chain Graph Decoupling & Relayer Privacy Verification
  // =========================================================================
  describe("4. On-Chain Graph Decoupling & Relayer Privacy Invariants", () => {
    it("confirms blockchain block transaction sender is relayer address, completely decoupling corporate depositor", async () => {
      blockchain.mintToken(WQUAI, pool.contractAddress, 100_000_000_000_000_000_000n);
      const corporateDepositor = "0xCorporate_Treasury_Master_Cold_Storage";
      pool.shield(WQUAI, 50_000_000_000_000_000_000n, TEST_NPK, TEST_BLINDING, "shielded_reserve", corporateDepositor);

      const unshieldReq: UnshieldRequest = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 8877112299n,
        recipient: BOB,
        token: WQUAI,
        amount: 10_000_000_000_000_000_000n,
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

      // Verify simulated blockchain ledger records
      const latestBlock = blockchain.latestBlock;
      assert.ok(latestBlock.transactions.length > 0);
      const onChainTx = latestBlock.transactions[latestBlock.transactions.length - 1];

      assert.equal(onChainTx.from, relayer.relayerAddress, "Transaction sender on-chain MUST be relayer");
      assert.notEqual(onChainTx.from, corporateDepositor, "Corporate treasury MUST NOT appear as sender");

      // Verify on-chain pool event
      const lastEvent = pool.poolEvents[pool.poolEvents.length - 1];
      assert.equal(lastEvent.type, "UNSHIELD");
      assert.equal(lastEvent.relayer, relayer.relayerAddress);
      assert.equal((lastEvent as any).depositorAddress, undefined);
    });
  });
});
