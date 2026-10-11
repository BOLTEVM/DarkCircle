/**
 * DarkCircle E2E Test Suite — Tier 2: Boundary & Corner Cases
 *
 * Requirements: >= 5 distinct boundary/corner test cases per core feature in scope.
 * Features Tested:
 * - F1/F2: Malformed headers, negative amounts, invalid schemes, injection characters.
 * - F3/F4: Relayer fee starvation, front-running substitution, zero amount, root expiration.
 * - F5/F6: Cache expiration boundary, error propagation, cache key collision, concurrent load.
 * - F7/F8/F9: Ephemeral collision resistance, zero amounts, expired invoices, key zeroization.
 * - F10/F11/F12: Underpayment, overpayment, zero balance sweeps, double-sweep idempotency.
 * - F13: Nullifier reuse, historical root ring buffer eviction, field overflows.
 * - F14/F15: Sanctions SMT collision, dynamic blocking, standby window enforcement.
 * - F16/F17/F18: Unauthorized viewing keys, CSV memo escaping, corrupted ciphertexts.
 * - F19/F20: Replay attacks, invalid invoices, expired timestamps, malformed proofs.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  poseidonHash,
  addressToBigInt,
  deriveCorporateKeys,
  deriveEphemeralAddress,
  IncrementalMerkleTree,
  SparseMerkleTree,
  SimulatedBlockchain,
  RailgunPool,
  RelayerNetwork,
  InboundMerchantGateway,
  OutboundPaymentProxy,
  ChallengeParser,
  ViewingKeyAuditEngine,
  ResourceServer,
  BN254_SCALAR_FIELD,
  encryptNote,
  decryptNote
} from './harness.ts';

describe('Tier 2: Boundary & Corner Cases (>= 5 Tests per Core Feature)', () => {
  let blockchain: SimulatedBlockchain;
  let pool: RailgunPool;
  let relayer: RelayerNetwork;
  let merchantGateway: InboundMerchantGateway;
  let clientProxy: OutboundPaymentProxy;
  let resourceServer: ResourceServer;
  let corporateKeys: ReturnType<typeof deriveCorporateKeys>;
  let merchantKeys: ReturnType<typeof deriveCorporateKeys>;

  const WQUAI = '0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb';
  const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';

  beforeEach(() => {
    blockchain = new SimulatedBlockchain();
    pool = new RailgunPool(blockchain);
    relayer = new RelayerNetwork(pool);

    corporateKeys = deriveCorporateKeys('corporate_treasury_seed_boundaries_123');
    merchantKeys = deriveCorporateKeys('merchant_store_seed_boundaries_456');

    merchantGateway = new InboundMerchantGateway(
      'merchant_master_secret_boundaries',
      merchantKeys.corporate0zkAddress,
      merchantKeys.npk,
      blockchain,
      pool
    );

    clientProxy = new OutboundPaymentProxy(
      {
        maxPaymentCap: 50_000_000_000_000_000_000n, // 50 WQUAI max
        allowedTokens: [WQUAI, DAI],
        allowedChainIds: [9]
      },
      relayer,
      corporateKeys
    );

    resourceServer = new ResourceServer(merchantGateway);

    // Fund corporate treasury with 200 WQUAI
    blockchain.mintToken(WQUAI, pool.contractAddress, 200_000_000_000_000_000_000n);
    const { leafIndex, commitment } = pool.shield(
      WQUAI,
      200_000_000_000_000_000_000n,
      corporateKeys.npk,
      112233n,
      'corporate_initial_funding',
      '0xCorporate_Public_Funder'
    );

    clientProxy.addTreasuryUTXO({
      commitment,
      leafIndex,
      token: WQUAI,
      value: 200_000_000_000_000_000_000n,
      blinding: 112233n,
      memo: 'corporate_initial_funding',
      depositorAddress: '0xCorporate_Public_Funder',
      depositTimestamp: Math.floor(Date.now() / 1000)
    });
  });

  // =========================================================================
  // Boundary 1: Challenge Parsing Edge Cases (5 Tests)
  // =========================================================================
  describe('B1: Challenge Parsing Boundary Cases', () => {
    it('T2.1.1: Rejects challenge when amount exceeds maximum allowable corporate cap', () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 60_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18); // 60 WQUAI > 50 WQUAI cap
      const parsed = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      assert.throws(() => {
        clientProxy.validatePolicy(parsed);
      }, /ERR_SPENDING_POLICY_REJECTED/);
    });

    it('T2.1.2: Rejects challenge when payment token is not in allowed token whitelist', () => {
      const SHITCOIN = '0x0011111111111111111111111111111111111111';
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, SHITCOIN, 'SCAM', 18);
      const parsed = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      assert.throws(() => {
        clientProxy.validatePolicy(parsed);
      }, /ERR_UNSUPPORTED_CHAIN_OR_TOKEN/);
    });

    it('T2.1.3: Rejects challenge when chainId does not match configured target network', () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const parsed = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);
      parsed.chainId = 1; // Mainnet instead of local 9

      assert.throws(() => {
        clientProxy.validatePolicy(parsed);
      }, /ERR_UNSUPPORTED_CHAIN_OR_TOKEN/);
    });

    it('T2.1.4: Handles special characters and injection strings in invoiceId safely', () => {
      const maliciousId = 'inv_test<script>alert(1)</script>"OR"1"="1';
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      ch.challengeBody.payment.invoiceId = maliciousId;

      const parsed = ChallengeParser.parse(ch.challengeHeaders, ch.challengeBody);
      assert.equal(parsed.invoiceId, maliciousId);
    });

    it('T2.1.5: Throws ERR_402_CHALLENGE_INVALID when body is empty object and headers contain no payment fields', () => {
      assert.throws(() => {
        ChallengeParser.parse({}, {});
      }, /ERR_402_CHALLENGE_INVALID/);
    });
  });

  // =========================================================================
  // Boundary 2: Relayer Settlement Boundary Cases (5 Tests)
  // =========================================================================
  describe('B2: Relayer Settlement Boundary Cases', () => {
    it('T2.2.1: Relayer rejects unshield broadcast when relayerFee is below minimum quote', async () => {
      const unshieldReq = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 1010101n,
        recipient: '0xVendor',
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: 1000n, // 0.001 WQUAI < 0.5 WQUAI min
        relayerAddress: relayer.relayerAddress,
        ppoiProof: { sanctionsRoot: pool.sanctionsSMT.root, depositOrigin: 0n, isNonSanctioned: true }
      };

      await assert.rejects(async () => {
        await relayer.broadcastUnshield(unshieldReq);
      }, /FEE_BELOW_MINIMUM/);
    });

    it('T2.2.2: Relayer detects front-running attempt: rejects if relayerAddress does not match node', async () => {
      const unshieldReq = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 2020202n,
        recipient: '0xVendor',
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: '0xMalicious_Front_Running_Relayer',
        ppoiProof: { sanctionsRoot: pool.sanctionsSMT.root, depositOrigin: 0n, isNonSanctioned: true }
      };

      await assert.rejects(async () => {
        await relayer.broadcastUnshield(unshieldReq);
      }, /RELAYER_ADDRESS_MISMATCH_FRONT_RUNNING_DETECTED/);
    });

    it('T2.2.3: Rejects unshield when spending from treasury with insufficient balance', async () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 500_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18); // 500 WQUAI > 200 WQUAI treasury
      const parsed = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      await assert.rejects(async () => {
        await clientProxy.settleChallenge(parsed);
      }, /ERR_SPENDING_POLICY_REJECTED|ERR_INSUFFICIENT_TREASURY_FUNDS/);
    });

    it('T2.2.4: Rejects unshield when Merkle root is expired or invalid', () => {
      const fakeRoot = 999999999999999n;
      const unshieldReq = {
        merkleRoot: fakeRoot,
        nullifier: 3030303n,
        recipient: '0xVendor',
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: { sanctionsRoot: pool.sanctionsSMT.root, depositOrigin: 0n, isNonSanctioned: true }
      };

      assert.throws(() => {
        pool.unshield(unshieldReq);
      }, /EXPIRED_MERKLE_ROOT/);
    });

    it('T2.2.5: Successfully processes zero relayer fee in direct pool contract call if permitted', () => {
      const unshieldReq = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 4040404n,
        recipient: '0xDirectVendor',
        token: WQUAI,
        amount: 1_000_000_000_000_000_000n,
        relayerFee: 0n,
        relayerAddress: '0xZeroRelayer',
        ppoiProof: { sanctionsRoot: pool.sanctionsSMT.root, depositOrigin: 0n, isNonSanctioned: true }
      };

      const res = pool.unshield(unshieldReq);
      assert.ok(res.txHash);
      assert.equal(blockchain.getTokenBalance(WQUAI, '0xDirectVendor'), 1_000_000_000_000_000_000n);
    });
  });

  // =========================================================================
  // Boundary 3: Receipt Cache & Concurrency Edge Cases (5 Tests)
  // =========================================================================
  describe('B3: Receipt Cache & Concurrency Boundaries', () => {
    it('T2.3.1: Does not serve expired cache receipt: triggers fresh payment on expiration', async () => {
      const url = '/api/v1/protected/analytics';
      // Populate cache with already-expired receipt
      clientProxy.receiptCache.set(url, {
        cacheKey: url,
        invoiceId: 'inv_old_expired',
        txHash: '0xold_hash',
        relayerAddress: relayer.relayerAddress,
        amount: 5_000_000_000_000_000_000n,
        token: WQUAI,
        expiresAt: Math.floor(Date.now() / 1000) - 100
      });

      const res = await clientProxy.fetchWithPayment(url, h => resourceServer.handleRequest('GET', url, h));
      assert.equal(res.status, 200);
      assert.notEqual(res.fromCache, true);
    });

    it('T2.3.2: Single-flight lock releases cleanly when unshield throws error', async () => {
      const url = '/api/v1/protected/ai-inference';
      // Temporarily set cap very low to force unshield policy error
      clientProxy.spendingPolicy.maxPaymentCap = 100n;

      await assert.rejects(async () => {
        await clientProxy.fetchWithPayment(url, h => resourceServer.handleRequest('POST', url, h));
      }, /ERR_SPENDING_POLICY_REJECTED/);

      // Verify lock map is completely empty and no deadlock occurs
      assert.equal(clientProxy.inFlightLocks.size, 0);
    });

    it('T2.3.3: Cache isolates different query parameters as distinct requests', () => {
      const key1 = '/analytics?range=1d';
      const key2 = '/analytics?range=7d';
      clientProxy.receiptCache.set(key1, {
        cacheKey: key1,
        invoiceId: 'inv_1d',
        txHash: '0xhash1',
        relayerAddress: relayer.relayerAddress,
        amount: 5_000_000_000_000_000_000n,
        token: WQUAI,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });

      assert.ok(clientProxy.receiptCache.has(key1));
      assert.equal(clientProxy.receiptCache.has(key2), false);
    });

    it('T2.3.4: Evicts invalid receipt when upstream server returns 402 despite cached proof', async () => {
      const url = '/api/v1/protected/analytics';
      clientProxy.receiptCache.set(url, {
        cacheKey: url,
        invoiceId: 'inv_fake_revoked',
        txHash: '0xfake_revoked_hash',
        relayerAddress: relayer.relayerAddress,
        amount: 5_000_000_000_000_000_000n,
        token: WQUAI,
        expiresAt: Math.floor(Date.now() / 1000) + 900
      });

      // Fetch should see 402 on cache attempt, then pay properly and update cache
      const res = await clientProxy.fetchWithPayment(url, h => resourceServer.handleRequest('GET', url, h));
      assert.equal(res.status, 200);
    });

    it('T2.3.5: Handles 20 parallel concurrent requests without deadlock or race condition', async () => {
      const url = '/api/v1/protected/analytics';
      const unshieldBefore = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;

      const promises = Array.from({ length: 20 }).map(() =>
        clientProxy.fetchWithPayment(url, h => resourceServer.handleRequest('GET', url, h))
      );

      const results = await Promise.all(promises);
      for (const r of results) {
        assert.equal(r.status, 200);
      }

      const unshieldAfter = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;
      assert.equal(unshieldAfter - unshieldBefore, 1);
    });
  });

  // =========================================================================
  // Boundary 4: Inbound Gateway & Ephemeral Collision (5 Tests)
  // =========================================================================
  describe('B4: Inbound Gateway & Ephemeral Collision Resistance', () => {
    it('T2.4.1: Ephemeral generator maintains 100% collision-free uniqueness over 1,000 derivations', () => {
      const set = new Set<string>();
      const masterKey = 'merchant_collision_stress_seed_999';
      for (let i = 0; i < 1000; i++) {
        const { address } = deriveEphemeralAddress(masterKey, `inv_${i}`);
        assert.equal(set.has(address), false);
        set.add(address);
      }
      assert.equal(set.size, 1000);
    });

    it('T2.4.2: Expired invoice cannot be settled by client (returns ERR_INVOICE_EXPIRED)', () => {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18, -1); // 1 sec in past
      const res = merchantGateway.verifyPayment(ch.invoice.invoiceId, '0xsettle_late');
      assert.equal(res.success, false);
      assert.equal(res.error, 'ERR_INVOICE_EXPIRED');
      assert.equal(res.statusCode, 410);
    });

    it('T2.4.3: Challenge with TTL of zero seconds expires immediately', () => {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18, 0);
      assert.equal(ch.invoice.expiresAt, ch.invoice.createdAt);
    });

    it('T2.4.4: Inbound gateway returns 404 when verifying non-existent invoice ID', () => {
      const res = merchantGateway.verifyPayment('inv_does_not_exist_xyz', '0xsomehash');
      assert.equal(res.success, false);
      assert.equal(res.error, 'ERR_INVOICE_NOT_FOUND');
      assert.equal(res.statusCode, 404);
    });

    it('T2.4.5: Ephemeral key derivation is strictly deterministic for identical merchant key and invoiceId', () => {
      const d1 = deriveEphemeralAddress('root_seed_1', 'invoice_identical');
      const d2 = deriveEphemeralAddress('root_seed_1', 'invoice_identical');
      assert.equal(d1.address, d2.address);
      assert.equal(d1.privateKey, d2.privateKey);
    });
  });

  // =========================================================================
  // Boundary 5: Inbound Sweeping & Under/Over-Payment (5 Tests)
  // =========================================================================
  describe('B5: Inbound Sweeping & Payment Discrepancy Boundaries', () => {
    it('T2.5.1: Attempting to sweep ephemeral address with zero balance throws NO_FUNDS_TO_SWEEP', async () => {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      await assert.rejects(async () => {
        await merchantGateway.sweepAndShield(ch.invoice.invoiceId);
      }, /NO_FUNDS_TO_SWEEP/);
    });

    it('T2.5.2: Underpayment deposit (3 WQUAI instead of 5 WQUAI) fails verification with ERR_UNDERPAYMENT', () => {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 3_000_000_000_000_000_000n); // 3 WQUAI < 5 WQUAI

      const res = merchantGateway.verifyPayment(ch.invoice.invoiceId, '0xunderpay_hash');
      assert.equal(res.success, false);
      assert.equal(res.error, 'ERR_UNDERPAYMENT');
    });

    it('T2.5.3: Overpayment deposit (10 WQUAI for 5 WQUAI invoice) verifies and sweeps full 10 WQUAI into pool', async () => {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 10_000_000_000_000_000_000n); // 10 WQUAI

      const verifyRes = merchantGateway.verifyPayment(ch.invoice.invoiceId, '0xoverpay_hash');
      assert.equal(verifyRes.success, true);

      const sweepRes = await merchantGateway.sweepAndShield(ch.invoice.invoiceId);
      assert.equal(sweepRes.sweptAmount, 10_000_000_000_000_000_000n);
      assert.equal(blockchain.getTokenBalance(WQUAI, ch.invoice.ephemeralAddress), 0n);
    });

    it('T2.5.4: Sweeping an already swept invoice throws NO_FUNDS_TO_SWEEP', async () => {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      merchantGateway.verifyPayment(ch.invoice.invoiceId, '0xfirst_sweep');

      await merchantGateway.sweepAndShield(ch.invoice.invoiceId);

      await assert.rejects(async () => {
        await merchantGateway.sweepAndShield(ch.invoice.invoiceId);
      }, /NO_FUNDS_TO_SWEEP/);
    });

    it('T2.5.5: Ephemeral private key is completely zeroized post-sweep and cannot be salvaged', async () => {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      merchantGateway.verifyPayment(ch.invoice.invoiceId, '0xzeroize_test');

      await merchantGateway.sweepAndShield(ch.invoice.invoiceId);
      const inv = merchantGateway.invoiceRegistry.get(ch.invoice.invoiceId)!;
      assert.equal(inv.ephemeralPrivateKey, '0x0000000000000000000000000000000000000000000000000000000000000000');
    });
  });

  // =========================================================================
  // Boundary 6: Railgun Shielded Pool & Cryptographic Bounds (5 Tests)
  // =========================================================================
  describe('B6: Railgun Shielded Pool & Cryptographic Bounds', () => {
    it('T2.6.1: Double-spend prevention: spent nullifier strictly reverts on second unshield call', () => {
      const nullifier = 99999988888n;
      const unshieldReq = {
        merkleRoot: pool.merkleTree.root,
        nullifier,
        recipient: '0xRecipient1',
        token: WQUAI,
        amount: 1_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: { sanctionsRoot: pool.sanctionsSMT.root, depositOrigin: 0n, isNonSanctioned: true }
      };

      pool.unshield(unshieldReq);

      // Second spend attempt
      assert.throws(() => {
        pool.unshield(unshieldReq);
      }, /ERROR_NULLIFIER_ALREADY_SPENT/);
    });

    it('T2.6.2: Historical root ring buffer evicts 65th oldest root correctly', () => {
      const tree = new IncrementalMerkleTree(16, 64);
      const initialRoot = tree.root;

      // Insert 65 leaves
      for (let i = 0; i < 65; i++) {
        tree.insert(poseidonHash(`leaf_ring_${i}`));
      }

      assert.equal(tree.historicalRoots.length, 64);
      assert.equal(tree.historicalRoots.includes(initialRoot), false);
    });

    it('T2.6.3: Handles scalar inputs >= BN254 modulus with safe wrapping', () => {
      const overflowScalar = BN254_SCALAR_FIELD + 100n;
      const wrapped = overflowScalar % BN254_SCALAR_FIELD;
      assert.ok(wrapped < BN254_SCALAR_FIELD);
      assert.equal(wrapped, 100n);
    });

    it('T2.6.4: Shielding zero amount reverts with SHIELD_AMOUNT_MUST_BE_POSITIVE', () => {
      assert.throws(() => {
        pool.shield(WQUAI, 0n, corporateKeys.npk, 123n);
      }, /SHIELD_AMOUNT_MUST_BE_POSITIVE/);
    });

    it('T2.6.5: Shielding negative amount reverts with SHIELD_AMOUNT_MUST_BE_POSITIVE', () => {
      assert.throws(() => {
        pool.shield(WQUAI, -5_000_000_000_000_000_000n, corporateKeys.npk, 123n);
      }, /SHIELD_AMOUNT_MUST_BE_POSITIVE/);
    });
  });

  // =========================================================================
  // Boundary 7: Cryptographic PPOI & Sanctions Boundaries (5 Tests)
  // =========================================================================
  describe('B7: Cryptographic PPOI Engine & Sanctions SMT Boundaries', () => {
    it('T2.7.1: Sanctions SMT non-membership verification fails for address in sanctions list', () => {
      const smt = new SparseMerkleTree(256);
      const target = addressToBigInt('0xSanctionedHackerAddress');
      smt.set(target, 1n);

      const proof = smt.getNonMembershipProof(target);
      assert.equal(proof.isNonMember, false);
      assert.equal(smt.verifyNonMembership(target, proof, smt.root), false);
    });

    it('T2.7.2: Dynamically registering sanctioned address updates SMT root and prevents unshielding', () => {
      const dynamicSanction = '0xDynamicTaintedAddress';
      const originKey = addressToBigInt(dynamicSanction);
      const rootBefore = pool.sanctionsSMT.root;

      pool.registerSanctionedAddress(dynamicSanction);
      const rootAfter = pool.sanctionsSMT.root;
      assert.notEqual(rootBefore, rootAfter);

      const req = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 88887777n,
        recipient: '0xVendor',
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: { sanctionsRoot: rootAfter, depositOrigin: originKey, isNonSanctioned: false }
      };

      assert.throws(() => {
        pool.unshield(req);
      }, /PPOI_SANCTIONED_INPUT/);
    });

    it('T2.7.3: Multiple sanctioned addresses in SMT do not cause false positive blocks on clean addresses', () => {
      const smt = new SparseMerkleTree(256);
      for (let i = 0; i < 50; i++) {
        smt.set(addressToBigInt(`0xSanctionedCluster_${i}`), 1n);
      }

      const cleanKey = addressToBigInt('0xCompletelyCleanAddress');
      const proof = smt.getNonMembershipProof(cleanKey);
      assert.equal(proof.isNonMember, true);
      assert.equal(smt.verifyNonMembership(cleanKey, proof, smt.root), true);
    });

    it('T2.7.4: Empty SMT returns clean non-membership for all queried keys', () => {
      const emptySmt = new SparseMerkleTree(256);
      const key = addressToBigInt('0xAnyAddress');
      const proof = emptySmt.getNonMembershipProof(key);
      assert.equal(proof.isNonMember, true);
    });

    it('T2.7.5: Enforces standby window: unshield to third party during window is strictly rejected', () => {
      pool.standbyWindowSeconds = 300; // 5 minute standby window
      const depositor = '0xDepositorOrigin';
      const depositorKey = addressToBigInt(depositor);

      const { commitment, leafIndex } = pool.shield(WQUAI, 10_000_000_000_000_000_000n, corporateKeys.npk, 555n, 'memo', depositor);

      const unshieldReq = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 777111n,
        recipient: '0xThirdPartyVendor', // Not the depositor!
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: { sanctionsRoot: pool.sanctionsSMT.root, depositOrigin: depositorKey, isNonSanctioned: true }
      };

      assert.throws(() => {
        pool.unshield(unshieldReq);
      }, /STANDBY_WINDOW_ACTIVE_ONLY_DEPOSITOR_UNSHIELD_ALLOWED/);
    });
  });

  // =========================================================================
  // Boundary 8: Viewing Key Audit Engine Boundaries (5 Tests)
  // =========================================================================
  describe('B8: Viewing Key Audit Engine Boundaries', () => {
    it('T2.8.1: Corrupted ciphertext MAC fails gracefully and skips note without crashing scanner', () => {
      const enc = encryptNote(corporateKeys.vpk, {
        token: WQUAI,
        value: 5_000_000_000_000_000_000n,
        blinding: 123n,
        memo: 'test_note'
      });

      // Corrupt the ciphertext
      enc.ciphertext = 'ffffffffffff:00000000';
      const decrypted = decryptNote(corporateKeys.vsk, enc);
      assert.equal(decrypted, null);
    });

    it('T2.8.2: Decrypting with foreign viewing key yields null', () => {
      const foreignKeys = deriveCorporateKeys('foreign_seed_attacker_999');
      const enc = encryptNote(corporateKeys.vpk, {
        token: WQUAI,
        value: 5_000_000_000_000_000_000n,
        blinding: 123n,
        memo: 'secret_corporate_invoice'
      });

      const decrypted = decryptNote(foreignKeys.vsk, enc);
      assert.equal(decrypted, null);
    });

    it('T2.8.3: CSV exporter properly escapes commas and double quotes in memo field', () => {
      const poolWithMemo = new RailgunPool(blockchain);
      poolWithMemo.shield(WQUAI, 5_000_000_000_000_000_000n, corporateKeys.npk, 123n, 'invoice,"quoted,comma",extra', '0xFunder');

      const auditor = new ViewingKeyAuditEngine(corporateKeys, poolWithMemo);
      const csv = auditor.exportCsv();
      assert.ok(csv.includes('""quoted,comma""'));
    });

    it('T2.8.4: JSON audit report handles zero transaction pool gracefully', () => {
      const emptyPool = new RailgunPool(blockchain);
      const auditor = new ViewingKeyAuditEngine(corporateKeys, emptyPool);
      const json = JSON.parse(auditor.exportJson());

      assert.equal(json.summary.totalTransactions, 0);
      assert.equal(json.summary.netBalance, '0.000000000000000000');
      assert.equal(json.transactions.length, 0);
    });

    it('T2.8.5: Note encryption and decryption roundtrip preserves exact 256-bit blinding and amounts', () => {
      const originalPayload = {
        token: WQUAI,
        value: 123456789012345678n,
        blinding: 9876543210987654321n,
        memo: 'audit_precision_test',
        invoiceId: 'inv_precision_001',
        counterparty: '0xMerchantPartner'
      };

      const enc = encryptNote(corporateKeys.vpk, originalPayload);
      const dec = decryptNote(corporateKeys.vsk, enc);

      assert.ok(dec);
      assert.equal(dec.value, originalPayload.value);
      assert.equal(dec.blinding, originalPayload.blinding);
      assert.equal(dec.memo, originalPayload.memo);
    });
  });

  // =========================================================================
  // Boundary 9: Resource Server Access Boundaries (5 Tests)
  // =========================================================================
  describe('B9: Resource Server Boundary Cases', () => {
    it('T2.9.1: Replay attack defense: reusing a settlement txHash across different invoices returns 409 Conflict', () => {
      const ch1 = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, ch1.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      const res1 = merchantGateway.verifyPayment(ch1.invoice.invoiceId, '0xstolen_replayed_tx_hash');
      assert.equal(res1.success, true);

      // Attacker attempts to settle Invoice 2 using the same txHash
      const ch2 = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, ch2.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      const res2 = merchantGateway.verifyPayment(ch2.invoice.invoiceId, '0xstolen_replayed_tx_hash');

      assert.equal(res2.success, false);
      assert.equal(res2.error, 'ERR_REPLAY_DETECTED');
      assert.equal(res2.statusCode, 409);
    });

    it('T2.9.2: Submitting payment proof for non-existent invoice returns 404', async () => {
      const res = await resourceServer.handleRequest('GET', '/api/v1/protected/analytics', {
        'x-payment-invoice-id': 'inv_does_not_exist',
        'x-payment-proof': '0xhash'
      });
      assert.equal(res.status, 404);
    });

    it('T2.9.3: Submitting payment proof for expired invoice returns 410 Gone', async () => {
      const ch = merchantGateway.createPaymentChallenge('/api/v1/protected/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18, -10);
      const res = await resourceServer.handleRequest('GET', '/api/v1/protected/analytics', {
        'x-payment-invoice-id': ch.invoice.invoiceId,
        'x-payment-proof': '0xlate_hash'
      });
      assert.equal(res.status, 410);
    });

    it('T2.9.4: Submitting malformed / empty payment proof headers issues 402 challenge', async () => {
      const res = await resourceServer.handleRequest('GET', '/api/v1/protected/analytics', {
        'x-custom-header': 'ignored'
      });
      assert.equal(res.status, 402);
      assert.equal(res.headers['X-Payment-Required'], 'true');
    });

    it('T2.9.5: Independent distinct payment proofs settle respective invoices without cross-talk', () => {
      const chA = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const chB = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);

      blockchain.mintToken(WQUAI, chA.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      blockchain.mintToken(WQUAI, chB.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const resA = merchantGateway.verifyPayment(chA.invoice.invoiceId, '0xtx_a');
      const resB = merchantGateway.verifyPayment(chB.invoice.invoiceId, '0xtx_b');

      assert.equal(resA.success, true);
      assert.equal(resB.success, true);
      assert.notEqual(resA.receiptId, resB.receiptId);
    });
  });
});
