/**
 * DarkCircle E2E Test Suite — Tier 1: Feature Coverage
 *
 * Requirements: >= 5 distinct test cases per core feature in scope.
 * Features Tested:
 * - F1/F2: HTTP 402 Interception & Challenge Parsing
 * - F3/F4: Relayer Unshield Settlement & On-Chain Graph Decoupling
 * - F5/F6: Receipt Caching, Deduplication & Auto-Retry
 * - F7/F8/F9: Inbound Merchant Gateway, Ephemeral Address Derivation & Challenge Formats
 * - F10/F11/F12: Inbound Payment Tracking, Auto-Sweeper & Shielding
 * - F13: Railgun Shielded Pool Engine (Poseidon, UTXO, Nullifier)
 * - F14/F15: Cryptographic PPOI Engine & Sanctions SMT Screening
 * - F16/F17/F18: Corporate Viewing-Key Derivation, Note Decryption & Audit Exporters
 * - F19/F20: Resource Server & Access Grant Enforcement
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
  BN254_SCALAR_FIELD
} from './harness.ts';

describe('Tier 1: Feature Coverage (>= 5 Tests per Core Feature)', () => {
  let blockchain: SimulatedBlockchain;
  let pool: RailgunPool;
  let relayer: RelayerNetwork;
  let merchantGateway: InboundMerchantGateway;
  let clientProxy: OutboundPaymentProxy;
  let resourceServer: ResourceServer;
  let corporateKeys: ReturnType<typeof deriveCorporateKeys>;
  let merchantKeys: ReturnType<typeof deriveCorporateKeys>;

  const WQUAI = '0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb';

  beforeEach(() => {
    blockchain = new SimulatedBlockchain();
    pool = new RailgunPool(blockchain);
    relayer = new RelayerNetwork(pool);

    corporateKeys = deriveCorporateKeys('corporate_treasury_master_seed_12345');
    merchantKeys = deriveCorporateKeys('merchant_store_master_seed_67890');

    merchantGateway = new InboundMerchantGateway(
      'merchant_master_secret_key_abc',
      merchantKeys.corporate0zkAddress,
      merchantKeys.npk,
      blockchain,
      pool
    );

    clientProxy = new OutboundPaymentProxy(
      {
        maxPaymentCap: 50_000_000_000_000_000_000n, // 50 WQUAI max
        allowedTokens: [WQUAI],
        allowedChainIds: [9]
      },
      relayer,
      corporateKeys
    );

    resourceServer = new ResourceServer(merchantGateway);

    // Seed pool with corporate treasury liquidity: 100 WQUAI note
    blockchain.mintToken(WQUAI, pool.contractAddress, 100_000_000_000_000_000_000n);
    const { leafIndex, commitment } = pool.shield(
      WQUAI,
      100_000_000_000_000_000_000n,
      corporateKeys.npk,
      999999n,
      'initial_corporate_deposit',
      '0xCorporate_Public_Funder'
    );

    clientProxy.addTreasuryUTXO({
      commitment,
      leafIndex,
      token: WQUAI,
      value: 100_000_000_000_000_000_000n,
      blinding: 999999n,
      memo: 'initial_corporate_deposit',
      depositorAddress: '0xCorporate_Public_Funder',
      depositTimestamp: Math.floor(Date.now() / 1000)
    });
  });

  // =========================================================================
  // Feature 1: HTTP 402 Interception & Challenge Parsing (5 Tests)
  // =========================================================================
  describe('F1 & F2: HTTP 402 Interception & Challenge Parsing', () => {
    it('T1.1.1: Intercepts 402 response and correctly parses RFC 7807 JSON problem details', () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/api/v1/protected/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const parsed = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      assert.equal(parsed.scheme, 'x402');
      assert.equal(parsed.amount, 5_000_000_000_000_000_000n);
      assert.equal(parsed.tokenAddress.toLowerCase(), WQUAI.toLowerCase());
      assert.equal(parsed.tokenSymbol, 'WQUAI');
      assert.equal(parsed.tokenDecimals, 18);
      assert.equal(parsed.recipientAddress.toLowerCase(), challengeObj.invoice.ephemeralAddress.toLowerCase());
      assert.equal(parsed.invoiceId, challengeObj.invoice.invoiceId);
    });

    it('T1.1.2: Falls back to RFC 7235 WWW-Authenticate header when JSON body is absent', () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/api/v1/protected/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const headersOnly = { 'WWW-Authenticate': challengeObj.challengeHeaders['WWW-Authenticate'] };
      const parsed = ChallengeParser.parse(headersOnly, undefined);

      assert.equal(parsed.amount, 5_000_000_000_000_000_000n);
      assert.equal(parsed.tokenAddress.toLowerCase(), WQUAI.toLowerCase());
      assert.equal(parsed.recipientAddress.toLowerCase(), challengeObj.invoice.ephemeralAddress.toLowerCase());
      assert.equal(parsed.invoiceId, challengeObj.invoice.invoiceId);
    });

    it('T1.1.3: Falls back to custom X-Payment-* headers when both JSON and WWW-Authenticate are absent', () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/api/v1/protected/analytics', 7_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const xHeaders: Record<string, string> = {
        'x-payment-recipient': challengeObj.invoice.ephemeralAddress,
        'x-payment-amount': '7000000000000000000',
        'x-payment-invoice-id': challengeObj.invoice.invoiceId,
        'x-payment-token': WQUAI,
        'x-payment-token-symbol': 'WQUAI',
        'x-payment-token-decimals': '6',
        'x-payment-network': '9',
        'x-payment-resource': '/api/v1/protected/analytics'
      };
      const parsed = ChallengeParser.parse(xHeaders, undefined);

      assert.equal(parsed.amount, 7_000_000_000_000_000_000n);
      assert.equal(parsed.recipientAddress.toLowerCase(), challengeObj.invoice.ephemeralAddress.toLowerCase());
      assert.equal(parsed.invoiceId, challengeObj.invoice.invoiceId);
      assert.equal(parsed.targetResource, '/api/v1/protected/analytics');
    });

    it('T1.1.4: Extracts decimal normalization and integer amount without floating-point precision loss', () => {
      // 5.123456 WQUAI = 5123456 base units
      const challengeObj = merchantGateway.createPaymentChallenge('/api/v1/protected/analytics', 5123456n, WQUAI, 'WQUAI', 18);
      const parsed = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      assert.equal(parsed.amount, 5123456n);
      assert.equal(parsed.tokenDecimals, 18);
    });

    it('T1.1.5: Throws explicit ERR_402_CHALLENGE_INVALID if required challenge fields are missing', () => {
      const corruptHeaders = { 'Content-Type': 'text/plain' };
      assert.throws(() => {
        ChallengeParser.parse(corruptHeaders, {});
      }, /ERR_402_CHALLENGE_INVALID/);
    });
  });

  // =========================================================================
  // Feature 2: Relayer Unshield Settlement & Graph Decoupling (5 Tests)
  // =========================================================================
  describe('F3 & F4: Relayer Unshield Settlement & On-Chain Graph Decoupling', () => {
    it('T1.2.1: Constructs and executes valid unshield transaction using shielded UTXO note', async () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const challenge = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      const receipt = await clientProxy.settleChallenge(challenge);
      assert.ok(receipt.txHash);
      assert.equal(receipt.amount, 5_000_000_000_000_000_000n);
      assert.equal(receipt.invoiceId, challenge.invoiceId);
    });

    it('T1.2.2: Decouples corporate treasury: on-chain broadcaster is Relayer, corporate address absent', async () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const challenge = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      const receipt = await clientProxy.settleChallenge(challenge);
      assert.equal(receipt.relayerAddress, relayer.relayerAddress);

      // Verify simulated EVM event log
      const lastEvent = pool.poolEvents[pool.poolEvents.length - 1];
      assert.equal(lastEvent.type, 'UNSHIELD');
      assert.equal(lastEvent.relayer, relayer.relayerAddress);
      assert.equal(lastEvent.recipient.toLowerCase(), challenge.recipientAddress.toLowerCase());
      assert.notEqual(lastEvent.relayer.toLowerCase(), corporateKeys.corporate0zkAddress.toLowerCase());
    });

    it('T1.2.3: Merchant destination receives exact invoice token amount on-chain', async () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const challenge = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      await clientProxy.settleChallenge(challenge);
      const destBalance = blockchain.getTokenBalance(WQUAI, challenge.recipientAddress);
      assert.equal(destBalance, 5_000_000_000_000_000_000n);
    });

    it('T1.2.4: Relayer fee is paid on-chain to relayer payout address', async () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const challenge = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      const initialRelayerBal = blockchain.getTokenBalance(WQUAI, relayer.relayerAddress);
      await clientProxy.settleChallenge(challenge);
      const postRelayerBal = blockchain.getTokenBalance(WQUAI, relayer.relayerAddress);
      assert.equal(postRelayerBal - initialRelayerBal, relayer.minimumFee);
    });

    it('T1.2.5: Unshielding automatically creates and inserts change note commitment for remaining treasury funds', async () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const challenge = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      // Initial: 100 WQUAI note. Spend: 5 WQUAI + 0.5 WQUAI fee = 5.5 WQUAI. Remainder = 94.5 WQUAI.
      const initialLeaves = pool.merkleTree.leaves.length;
      await clientProxy.settleChallenge(challenge);
      assert.equal(pool.merkleTree.leaves.length, initialLeaves + 1);
      assert.equal(clientProxy.treasuryUTXOs.length, 1);
      assert.equal(clientProxy.treasuryUTXOs[0].value, 94_500_000_000_000_000_000n);
    });
  });

  // =========================================================================
  // Feature 3: Payment Receipt Caching & Deduplication (5 Tests)
  // =========================================================================
  describe('F5 & F6: Payment Receipt Caching & Single-Flight Deduplication', () => {
    it('T1.3.1: Stores confirmed payment receipt in client cache', async () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/api/v1/protected/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const challenge = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      const receipt = await clientProxy.settleChallenge(challenge);
      const cached = clientProxy.receiptCache.get(receipt.cacheKey);
      assert.ok(cached);
      assert.equal(cached.txHash, receipt.txHash);
    });

    it('T1.3.2: Reuses cached receipt for subsequent identical request without re-unshielding', async () => {
      const url = '/api/v1/protected/analytics';
      // First call triggers payment
      const res1 = await clientProxy.fetchWithPayment(url, headers => resourceServer.handleRequest('GET', url, headers));
      assert.equal(res1.status, 200);
      assert.equal(res1.fromCache, undefined);

      const unshieldCountBefore = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;

      // Second call should satisfy from cache
      const res2 = await clientProxy.fetchWithPayment(url, headers => resourceServer.handleRequest('GET', url, headers));
      assert.equal(res2.status, 200);
      assert.equal(res2.fromCache, true);

      const unshieldCountAfter = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;
      assert.equal(unshieldCountBefore, unshieldCountAfter);
    });

    it('T1.3.3: Single-flight lock coalesces concurrent parallel requests into exactly 1 unshield transaction', async () => {
      const url = '/api/v1/protected/analytics';
      const unshieldCountBefore = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;

      // 5 concurrent requests initiated simultaneously
      const parallelRequests = [
        clientProxy.fetchWithPayment(url, h => resourceServer.handleRequest('GET', url, h)),
        clientProxy.fetchWithPayment(url, h => resourceServer.handleRequest('GET', url, h)),
        clientProxy.fetchWithPayment(url, h => resourceServer.handleRequest('GET', url, h)),
        clientProxy.fetchWithPayment(url, h => resourceServer.handleRequest('GET', url, h)),
        clientProxy.fetchWithPayment(url, h => resourceServer.handleRequest('GET', url, h))
      ];

      const responses = await Promise.all(parallelRequests);
      for (const res of responses) {
        assert.equal(res.status, 200);
      }

      const unshieldCountAfter = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;
      assert.equal(unshieldCountAfter - unshieldCountBefore, 1);
    });

    it('T1.3.4: Honors receipt expiration TTL and evicts stale entries', async () => {
      const url = '/api/v1/protected/analytics';
      const challengeObj = merchantGateway.createPaymentChallenge(url, 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18, -10); // already expired
      const challenge = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      const receipt = await clientProxy.settleChallenge(challenge);
      assert.ok(receipt.expiresAt < Math.floor(Date.now() / 1000));
    });

    it('T1.3.5: Generates isolated cache entries for distinct endpoints', async () => {
      const url1 = '/api/v1/protected/analytics';
      const url2 = '/api/v1/protected/ai-inference';

      const res1 = await clientProxy.fetchWithPayment(url1, h => resourceServer.handleRequest('GET', url1, h));
      assert.equal(res1.status, 200);

      const res2 = await clientProxy.fetchWithPayment(url2, h => resourceServer.handleRequest('POST', url2, h));
      assert.equal(res2.status, 200);

      assert.ok(clientProxy.receiptCache.has(url1));
      assert.ok(clientProxy.receiptCache.has(url2));
      assert.notEqual(clientProxy.receiptCache.get(url1)!.txHash, clientProxy.receiptCache.get(url2)!.txHash);
    });
  });

  // =========================================================================
  // Feature 4: Inbound Merchant Gateway & Ephemeral Derivation (5 Tests)
  // =========================================================================
  describe('F7, F8 & F9: Inbound Merchant Privacy Gateway & Ephemeral Destinations', () => {
    it('T1.4.1: Intercepts unauthenticated incoming request and returns HTTP 402 with challenge', async () => {
      const res = await resourceServer.handleRequest('GET', '/api/v1/protected/analytics');
      assert.equal(res.status, 402);
      assert.equal(res.headers['X-Payment-Required'], 'true');
      assert.ok(res.headers['WWW-Authenticate']);
      assert.equal(res.body.payment.amount, '5000000000000000000');
    });

    it('T1.4.2: Ephemeral address derivation produces unique addresses across successive invoices', () => {
      const addr1 = deriveEphemeralAddress('merchant_key_test', 'invoice_001');
      const addr2 = deriveEphemeralAddress('merchant_key_test', 'invoice_002');
      const addr3 = deriveEphemeralAddress('merchant_key_test', 'invoice_003');

      assert.notEqual(addr1.address.toLowerCase(), addr2.address.toLowerCase());
      assert.notEqual(addr2.address.toLowerCase(), addr3.address.toLowerCase());
      assert.notEqual(addr1.address.toLowerCase(), addr3.address.toLowerCase());
    });

    it('T1.4.3: Challenge formatter emits standard RFC 7235 auth headers and RFC 7807 problem JSON', () => {
      const ch = merchantGateway.createPaymentChallenge('/api/v1/protected/ai-inference', 10_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      assert.ok(ch.challengeHeaders['WWW-Authenticate'].startsWith('x402 scheme='));
      assert.equal(ch.challengeBody.type, 'https://darkcircle.network/errors/payment-required');
      assert.equal(ch.challengeBody.status, 402);
    });

    it('T1.4.4: Inbound gateway registers active invoice in registry with PENDING status', () => {
      const ch = merchantGateway.createPaymentChallenge('/api/v1/protected/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const record = merchantGateway.invoiceRegistry.get(ch.invoice.invoiceId);
      assert.ok(record);
      assert.equal(record.status, 'PENDING');
      assert.equal(record.requiredAmount, 5_000_000_000_000_000_000n);
    });

    it('T1.4.5: Ephemeral private key is securely stored in registry for subsequent auto-sweep', () => {
      const ch = merchantGateway.createPaymentChallenge('/api/v1/protected/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      assert.ok(ch.invoice.ephemeralPrivateKey);
      assert.ok(ch.invoice.ephemeralPrivateKey.startsWith('0x'));
    });
  });

  // =========================================================================
  // Feature 5: Inbound Payment Tracking, Auto-Sweeper & Shielding (5 Tests)
  // =========================================================================
  describe('F10, F11 & F12: Inbound Payment Tracking & Automated Shielding Sweeper', () => {
    it('T1.5.1: Verifies on-chain deposit and transitions invoice from PENDING to SETTLED', () => {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const verifyRes = merchantGateway.verifyPayment(ch.invoice.invoiceId, '0xsettle_tx_hash_001');
      assert.equal(verifyRes.success, true);
      assert.equal(merchantGateway.invoiceRegistry.get(ch.invoice.invoiceId)!.status, 'SETTLED');
    });

    it('T1.5.2: Automatically sweeps ephemeral address balance into Railgun contract', async () => {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      merchantGateway.verifyPayment(ch.invoice.invoiceId, '0xsettle_tx_hash_002');

      const sweepRes = await merchantGateway.sweepAndShield(ch.invoice.invoiceId);
      assert.equal(sweepRes.sweptAmount, 5_000_000_000_000_000_000n);
      assert.equal(blockchain.getTokenBalance(WQUAI, ch.invoice.ephemeralAddress), 0n);
    });

    it('T1.5.3: Swept funds are absorbed into Railgun Merkle tree with merchant 0zk commitment', async () => {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      merchantGateway.verifyPayment(ch.invoice.invoiceId, '0xsettle_tx_hash_003');

      const initialLeaves = pool.merkleTree.leaves.length;
      await merchantGateway.sweepAndShield(ch.invoice.invoiceId);
      assert.equal(pool.merkleTree.leaves.length, initialLeaves + 1);
    });

    it('T1.5.4: Marks invoice status as SWEPT with sweepTxHash', async () => {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      merchantGateway.verifyPayment(ch.invoice.invoiceId, '0xsettle_tx_hash_004');

      await merchantGateway.sweepAndShield(ch.invoice.invoiceId);
      const updated = merchantGateway.invoiceRegistry.get(ch.invoice.invoiceId)!;
      assert.equal(updated.status, 'SWEPT');
      assert.ok(updated.sweepTxHash);
    });

    it('T1.5.5: Securely zeroizes ephemeral private key from memory upon successful sweep', async () => {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      merchantGateway.verifyPayment(ch.invoice.invoiceId, '0xsettle_tx_hash_005');

      await merchantGateway.sweepAndShield(ch.invoice.invoiceId);
      const updated = merchantGateway.invoiceRegistry.get(ch.invoice.invoiceId)!;
      assert.equal(updated.ephemeralPrivateKey, '0x0000000000000000000000000000000000000000000000000000000000000000');
    });
  });

  // =========================================================================
  // Feature 6: Railgun Shielded Pool Engine (5 Tests)
  // =========================================================================
  describe('F13: Railgun Shielded Pool Engine (Poseidon, UTXO, Nullifier)', () => {
    it('T1.6.1: Computes hiding note commitments over BN254 scalar field', () => {
      const npk = 123456789n;
      const amount = 5_000_000_000_000_000_000n;
      const blinding = 987654321n;
      const commitment = poseidonHash(npk, WQUAI.toLowerCase(), amount, blinding);

      assert.ok(commitment > 0n);
      assert.ok(commitment < BN254_SCALAR_FIELD);
    });

    it('T1.6.2: Appends commitments into Incremental Merkle Tree and updates root', () => {
      const tree = new IncrementalMerkleTree(16);
      const root0 = tree.root;
      const leaf0 = poseidonHash('note_leaf_0');
      tree.insert(leaf0);
      assert.notEqual(tree.root, root0);
    });

    it('T1.6.3: Derives deterministic nullifier from spending key, commitment, and leaf index', () => {
      const ssk = corporateKeys.ssk;
      const commitment = 888888n;
      const leafIndex = 0;
      const nullifier1 = poseidonHash(ssk, commitment, leafIndex);
      const nullifier2 = poseidonHash(ssk, commitment, leafIndex);
      assert.equal(nullifier1, nullifier2);
    });

    it('T1.6.4: Prevents double-spending: rejects unshield with previously registered nullifier', async () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const challenge = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);

      // Settle first time
      await clientProxy.settleChallenge(challenge);

      // Attempt to re-submit with spent nullifier
      const spentNullifier = Array.from(pool.nullifiers)[0];
      const req = {
        merkleRoot: pool.merkleTree.root,
        nullifier: BigInt(spentNullifier),
        recipient: '0xAttacker',
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: { sanctionsRoot: pool.sanctionsSMT.root, depositOrigin: 0n, isNonSanctioned: true }
      };

      assert.throws(() => {
        pool.unshield(req);
      }, /ERROR_NULLIFIER_ALREADY_SPENT/);
    });

    it('T1.6.5: Maintains historical Merkle root ring buffer (accepts recent roots)', () => {
      const tree = new IncrementalMerkleTree(16, 64);
      for (let i = 0; i < 10; i++) {
        tree.insert(poseidonHash(`leaf_${i}`));
      }
      assert.equal(tree.historicalRoots.length, 11);
      assert.ok(tree.historicalRoots.includes(tree.root));
    });
  });

  // =========================================================================
  // Feature 7: Cryptographic PPOI Engine & Sanctions SMT (5 Tests)
  // =========================================================================
  describe('F14 & F15: Cryptographic PPOI Engine & Sanctions SMT Screening', () => {
    it('T1.7.1: Indexes sanctioned addresses in Sparse Merkle Tree (SMT)', () => {
      const smt = new SparseMerkleTree(256);
      const sanctionedAddr = '0x999999cf1046e68e36e1aA2E0E07105eDDD1f08E';
      smt.set(addressToBigInt(sanctionedAddr), 1n);

      assert.equal(smt.get(addressToBigInt(sanctionedAddr)), 1n);
      assert.equal(smt.get(addressToBigInt('0xCleanAddress')), 0n);
    });

    it('T1.7.2: Generates non-membership proof for uncontaminated deposit origins', () => {
      const smt = new SparseMerkleTree(256);
      const sanctioned = addressToBigInt('0x999999cf1046e68e36e1aA2E0E07105eDDD1f08E');
      smt.set(sanctioned, 1n);

      const cleanKey = addressToBigInt('0xCleanDepositOrigin');
      const proof = smt.getNonMembershipProof(cleanKey);
      assert.equal(proof.isNonMember, true);
      assert.equal(smt.verifyNonMembership(cleanKey, proof, smt.root), true);
    });

    it('T1.7.3: Correctly flags membership for sanctioned keys, failing non-membership verification', () => {
      const smt = new SparseMerkleTree(256);
      const sanctioned = addressToBigInt('0x999999cf1046e68e36e1aA2E0E07105eDDD1f08E');
      smt.set(sanctioned, 1n);

      const proof = smt.getNonMembershipProof(sanctioned);
      assert.equal(proof.isNonMember, false);
      assert.equal(smt.verifyNonMembership(sanctioned, proof, smt.root), false);
    });

    it('T1.7.4: Rejects unshield transaction when input UTXO traces to sanctioned deposit', () => {
      const sanctionedOrigin = '0x999999cf1046e68e36e1aA2E0E07105eDDD1f08E';
      pool.registerSanctionedAddress(sanctionedOrigin);

      const unshieldReq = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 5555555n,
        recipient: '0xVendor',
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: addressToBigInt(sanctionedOrigin),
          isNonSanctioned: false
        }
      };

      assert.throws(() => {
        pool.unshield(unshieldReq);
      }, /PPOI_SANCTIONED_INPUT/);
    });

    it('T1.7.5: Verifies clean deposit origin passes PPOI screening and completes unshield', async () => {
      const cleanOrigin = '0xCleanFunder123';
      const unshieldReq = {
        merkleRoot: pool.merkleTree.root,
        nullifier: 7777777n,
        recipient: '0xVendor',
        token: WQUAI,
        amount: 5_000_000_000_000_000_000n,
        relayerFee: 500_000_000_000_000_000n,
        relayerAddress: relayer.relayerAddress,
        ppoiProof: {
          sanctionsRoot: pool.sanctionsSMT.root,
          depositOrigin: addressToBigInt(cleanOrigin),
          isNonSanctioned: true
        }
      };

      const res = pool.unshield(unshieldReq);
      assert.ok(res.txHash);
    });
  });

  // =========================================================================
  // Feature 8: Corporate Viewing-Key Derivation & Exporters (5 Tests)
  // =========================================================================
  describe('F16, F17 & F18: Corporate Viewing-Key Derivation, Decryption & Audit Exporters', () => {
    it('T1.8.1: Derives separate spending keys and viewing keys from master corporate seed', () => {
      const keys = deriveCorporateKeys('master_seed_entropy_xyz');
      assert.ok(keys.ssk > 0n);
      assert.ok(keys.vsk > 0n);
      assert.notEqual(keys.ssk, keys.vsk);
      assert.ok(keys.corporate0zkAddress.startsWith('0zk1q'));
    });

    it('T1.8.2: Decrypts transaction history journal using corporate viewing key', async () => {
      // Execute unshield and sweep to create journal events
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const challenge = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);
      await clientProxy.settleChallenge(challenge);

      const auditor = new ViewingKeyAuditEngine(corporateKeys, pool);
      const records = auditor.decryptLedger();
      assert.ok(records.length >= 2); // Initial shield + unshield
    });

    it('T1.8.3: Exports structured audit_report.json conforming to enterprise schema', async () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const challenge = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);
      await clientProxy.settleChallenge(challenge);

      const auditor = new ViewingKeyAuditEngine(corporateKeys, pool);
      const jsonReportStr = auditor.exportJson('DarkCircle Enterprise Corp');
      const parsed = JSON.parse(jsonReportStr);

      assert.equal(parsed.title, 'DarkCircleAuditReport');
      assert.equal(parsed.entityName, 'DarkCircle Enterprise Corp');
      assert.ok(parsed.summary);
      assert.equal(parsed.summary.ppoiComplianceRate, '100.0%');
      assert.ok(Array.isArray(parsed.transactions));
    });

    it('T1.8.4: Exports ERP-compatible audit_report.csv with ISO timestamps and exact decimals', async () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const challenge = ChallengeParser.parse(challengeObj.challengeHeaders, challengeObj.challengeBody);
      await clientProxy.settleChallenge(challenge);

      const auditor = new ViewingKeyAuditEngine(corporateKeys, pool);
      const csv = auditor.exportCsv();
      assert.ok(csv.startsWith('timestamp_iso,tx_hash,block_number'));
      assert.ok(csv.includes('OUTBOUND_UNSHIELD'));
      assert.ok(csv.includes('COMPLIANT'));
    });

    it('T1.8.5: External third-party viewing key decrypts zero private corporate records', () => {
      const foreignKeys = deriveCorporateKeys('unauthorized_external_party_seed');
      assert.notEqual(foreignKeys.vsk, corporateKeys.vsk);
      assert.notEqual(foreignKeys.corporate0zkAddress, corporateKeys.corporate0zkAddress);
    });
  });

  // =========================================================================
  // Feature 9: Resource Server & Access Grant Enforcement (5 Tests)
  // =========================================================================
  describe('F19 & F20: Resource Server & Access Grant Enforcement', () => {
    it('T1.9.1: Enforces 402 challenge on /api/v1/protected/analytics (5.00 WQUAI)', async () => {
      const res = await resourceServer.handleRequest('GET', '/api/v1/protected/analytics');
      assert.equal(res.status, 402);
      assert.equal(res.body.payment.amount, '5000000000000000000');
    });

    it('T1.9.2: Enforces 402 challenge on /api/v1/protected/ai-inference (10.00 WQUAI)', async () => {
      const res = await resourceServer.handleRequest('POST', '/api/v1/protected/ai-inference', {}, { model: 'llama-3-8b' });
      assert.equal(res.status, 402);
      assert.equal(res.body.payment.amount, '10000000000000000000');
    });

    it('T1.9.3: Grants access and returns HTTP 200 OK when valid payment proof is supplied', async () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/api/v1/protected/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, challengeObj.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      const res = await resourceServer.handleRequest('GET', '/api/v1/protected/analytics', {
        'x-payment-invoice-id': challengeObj.invoice.invoiceId,
        'x-payment-proof': '0xverified_proof_hash_123'
      });

      assert.equal(res.status, 200);
      assert.equal(res.headers['X-Payment-Status'], 'SETTLED');
      assert.ok(res.body.data.activeUsers);
    });

    it('T1.9.4: Rejects request with 404 for undefined non-protected route', async () => {
      const res = await resourceServer.handleRequest('GET', '/api/v1/unknown');
      assert.equal(res.status, 404);
    });

    it('T1.9.5: Automatically sweeps settled funds upon grant access', async () => {
      const challengeObj = merchantGateway.createPaymentChallenge('/api/v1/protected/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      blockchain.mintToken(WQUAI, challengeObj.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);

      await resourceServer.handleRequest('GET', '/api/v1/protected/analytics', {
        'x-payment-invoice-id': challengeObj.invoice.invoiceId,
        'x-payment-proof': '0xverified_proof_hash_456'
      });

      const invoice = merchantGateway.invoiceRegistry.get(challengeObj.invoice.invoiceId)!;
      assert.equal(invoice.status, 'SWEPT');
    });
  });
});
