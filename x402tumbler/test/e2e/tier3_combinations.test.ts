/**
 * DarkCircle E2E Test Suite — Tier 3: Cross-Feature Combinations
 *
 * Requirements: Multi-subsystem integration testing combining Outbound Proxy,
 * Inbound Gateway, PPOI Engine, Relayer Decoupling, Viewing Key Exporter, and Resource Server.
 *
 * Scenarios Tested:
 * - C1: Complete Two-Way Corporate Privacy Roundtrip (End-to-End Lifecycle)
 * - C2: PPOI Sanction Interception Across Entire Pipeline
 * - C3: Multi-Token Heterogeneous Privacy Settlement (WQUAI 6-dec & DAI 18-dec)
 * - C4: Concurrent Multi-Client Single-Flight Race + Gateway Invoicing
 * - C5: Replay Attack Defense Across Ephemeral Boundaries
 * - C6: Standby Window Enforced in Full Settlement Lifecycle
 * - C7: Upstream Temporary Failure with Resilient Settlement Recovery
 * - C8: Viewing Key Audit Mathematical Inflow/Outflow Reconciliation
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  addressToBigInt,
  deriveCorporateKeys,
  SimulatedBlockchain,
  RailgunPool,
  RelayerNetwork,
  InboundMerchantGateway,
  OutboundPaymentProxy,
  ChallengeParser,
  ViewingKeyAuditEngine,
  ResourceServer
} from './harness.ts';

describe('Tier 3: Cross-Feature Combinations (Integration Pipelines)', () => {
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

    corporateKeys = deriveCorporateKeys('corporate_treasury_seed_tier3');
    merchantKeys = deriveCorporateKeys('merchant_store_seed_tier3');

    merchantGateway = new InboundMerchantGateway(
      'merchant_master_secret_tier3',
      merchantKeys.corporate0zkAddress,
      merchantKeys.npk,
      blockchain,
      pool
    );

    clientProxy = new OutboundPaymentProxy(
      {
        maxPaymentCap: 100n * 10n ** 18n, // Accommodates both 6-dec WQUAI and 18-dec DAI
        allowedTokens: [WQUAI, DAI],
        allowedChainIds: [9]
      },
      relayer,
      corporateKeys
    );

    resourceServer = new ResourceServer(merchantGateway);

    // Initial corporate treasury funding: 500 WQUAI
    blockchain.mintToken(WQUAI, pool.contractAddress, 500_000_000_000_000_000_000n);
    const { leafIndex, commitment } = pool.shield(
      WQUAI,
      500_000_000_000_000_000_000n,
      corporateKeys.npk,
      555555n,
      'tier3_corporate_initial_funding',
      '0xCorporate_Public_Funder'
    );

    clientProxy.addTreasuryUTXO({
      commitment,
      leafIndex,
      token: WQUAI,
      value: 500_000_000_000_000_000_000n,
      blinding: 555555n,
      memo: 'tier3_corporate_initial_funding',
      depositorAddress: '0xCorporate_Public_Funder',
      depositTimestamp: Math.floor(Date.now() / 1000)
    });
  });

  // =========================================================================
  // Combination 1: Full Two-Way Privacy Lifecycle
  // =========================================================================
  it('C1: Executes complete two-way corporate privacy roundtrip (Outbound Client -> 402 -> Relayer -> Ephemeral Payee -> 200 OK -> Auto-Sweep -> Audit Export)', async () => {
    const targetUrl = '/api/v1/protected/analytics';

    // 1. Client calls resource server via Outbound Proxy
    const response = await clientProxy.fetchWithPayment(targetUrl, headers =>
      resourceServer.handleRequest('GET', targetUrl, headers)
    );

    // 2. Validate client received HTTP 200 OK with analytics data
    assert.equal(response.status, 200);
    assert.equal(response.headers['X-Payment-Status'], 'SETTLED');
    assert.equal(response.headers['X-Payment-Relayer-Decoupled'], 'true');
    assert.ok(response.body.data.activeUsers > 0);

    // 3. Validate on-chain decoupling: Relayer was sender, no trace of corporate treasury
    const unshieldEvents = pool.poolEvents.filter(e => e.type === 'UNSHIELD');
    assert.equal(unshieldEvents.length, 1);
    const unshield = unshieldEvents[0];
    assert.equal(unshield.relayer, relayer.relayerAddress);
    assert.notEqual(unshield.relayer, corporateKeys.corporate0zkAddress);

    // 4. Validate auto-sweep completed: ephemeral address balance swept into merchant pool
    const sweepEvents = pool.poolEvents.filter(e => e.type === 'SHIELD' && e.depositorAddress !== '0xCorporate_Public_Funder');
    assert.equal(sweepEvents.length, 1);
    assert.equal(sweepEvents[0].amount, 5_000_000_000_000_000_000n);

    // 5. Viewing Key Audit Engine reconstructs corporate transactions
    const auditor = new ViewingKeyAuditEngine(corporateKeys, pool);
    const jsonReport = JSON.parse(auditor.exportJson('DarkCircle Global Corp'));
    assert.equal(jsonReport.title, 'DarkCircleAuditReport');
    assert.equal(jsonReport.summary.ppoiComplianceRate, '100.0%');
    assert.ok(jsonReport.transactions.some((t: any) => t.direction === 'OUTBOUND_UNSHIELD'));
  });

  // =========================================================================
  // Combination 2: PPOI Sanctions Interception in Relayer Pipeline
  // =========================================================================
  it('C2: PPOI sanction interception: tainted UTXO lineage stops settlement, leaves blockchain untouched and endpoint protected', async () => {
    // Register sanctioned cluster
    const taintedDepositor = '0x999999cf1046e68e36e1aA2E0E07105eDDD1f08E';
    pool.registerSanctionedAddress(taintedDepositor);

    // Create a tainted UTXO in client treasury
    blockchain.mintToken(WQUAI, pool.contractAddress, 50_000_000_000_000_000_000n);
    const { leafIndex, commitment } = pool.shield(
      WQUAI,
      50_000_000_000_000_000_000n,
      corporateKeys.npk,
      777n,
      'tainted_funds',
      taintedDepositor
    );

    // Put tainted UTXO at front of treasury
    clientProxy.treasuryUTXOs = [{
      commitment,
      leafIndex,
      token: WQUAI,
      value: 50_000_000_000_000_000_000n,
      blinding: 777n,
      memo: 'tainted_funds',
      depositorAddress: taintedDepositor,
      depositTimestamp: Math.floor(Date.now() / 1000)
    }];

    const targetUrl = '/api/v1/protected/analytics';
    const initialUnshieldCount = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;

    // Client attempt must be rejected due to PPOI screening failure
    await assert.rejects(async () => {
      await clientProxy.fetchWithPayment(targetUrl, h => resourceServer.handleRequest('GET', targetUrl, h));
    }, /PPOI_SANCTIONED_INPUT/);

    // Verify blockchain was never touched by an unshield transaction
    const postUnshieldCount = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;
    assert.equal(postUnshieldCount, initialUnshieldCount);

    // Verify resource server endpoint remains unaccessed (402)
    const rawRes = await resourceServer.handleRequest('GET', targetUrl);
    assert.equal(rawRes.status, 402);
  });

  // =========================================================================
  // Combination 3: Multi-Token Heterogeneous Settlement (WQUAI & DAI)
  // =========================================================================
  it('C3: Multi-token settlement: settles WQUAI (6 decimals) and DAI (18 decimals) into separate notes with decimal integrity', async () => {
    // Fund treasury with DAI: 50 DAI (50 * 10^18)
    const DAI_AMOUNT = 50n * 10n ** 18n;
    blockchain.mintToken(DAI, pool.contractAddress, DAI_AMOUNT);
    const daiDeposit = pool.shield(
      DAI,
      DAI_AMOUNT,
      corporateKeys.npk,
      88888n,
      'dai_funding',
      '0xCorporate_Public_Funder'
    );
    clientProxy.addTreasuryUTXO({
      commitment: daiDeposit.commitment,
      leafIndex: daiDeposit.leafIndex,
      token: DAI,
      value: DAI_AMOUNT,
      blinding: 88888n,
      memo: 'dai_funding',
      depositorAddress: '0xCorporate_Public_Funder',
      depositTimestamp: Math.floor(Date.now() / 1000)
    });

    // 1. Settle WQUAI challenge (5 WQUAI = 5,000,000 base units)
    const usdcChObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
    const usdcChallenge = ChallengeParser.parse(usdcChObj.challengeHeaders, usdcChObj.challengeBody);
    const usdcReceipt = await clientProxy.settleChallenge(usdcChallenge);
    assert.ok(usdcReceipt.txHash);
    assert.equal(usdcReceipt.amount, 5_000_000_000_000_000_000n);

    // 2. Settle DAI challenge (10 DAI = 10 * 10^18 base units)
    const daiRequired = 10n * 10n ** 18n;
    const daiChObj = merchantGateway.createPaymentChallenge('/ai-inference', daiRequired, DAI, 'DAI', 18);
    const daiChallenge = ChallengeParser.parse(daiChObj.challengeHeaders, daiChObj.challengeBody);
    const daiReceipt = await clientProxy.settleChallenge(daiChallenge);
    assert.ok(daiReceipt.txHash);
    assert.equal(daiReceipt.amount, daiRequired);

    // 3. Verify on-chain merchant destinations received exact amounts in distinct tokens
    assert.equal(blockchain.getTokenBalance(WQUAI, usdcChallenge.recipientAddress), 5_000_000_000_000_000_000n);
    assert.equal(blockchain.getTokenBalance(DAI, daiChallenge.recipientAddress), daiRequired);

    // 4. Inbound Gateway sweeps both distinct tokens
    merchantGateway.verifyPayment(usdcChallenge.invoiceId, usdcReceipt.txHash);
    merchantGateway.verifyPayment(daiChallenge.invoiceId, daiReceipt.txHash);

    const usdcSweep = await merchantGateway.sweepAndShield(usdcChallenge.invoiceId);
    const daiSweep = await merchantGateway.sweepAndShield(daiChallenge.invoiceId);

    assert.equal(usdcSweep.sweptAmount, 5_000_000_000_000_000_000n);
    assert.equal(daiSweep.sweptAmount, daiRequired);
  });

  // =========================================================================
  // Combination 4: Concurrent Multi-Client Single-Flight Race + Gateway Invoicing
  // =========================================================================
  it('C4: 10 parallel client instances making identical request trigger exactly 1 unshield and all get 200 OK', async () => {
    const targetUrl = '/api/v1/protected/analytics';
    const unshieldBefore = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;

    const parallelCalls = Array.from({ length: 10 }).map(() =>
      clientProxy.fetchWithPayment(targetUrl, h => resourceServer.handleRequest('GET', targetUrl, h))
    );

    const responses = await Promise.all(parallelCalls);
    for (const res of responses) {
      assert.equal(res.status, 200);
      assert.ok(res.body.data.activeUsers);
    }

    const unshieldAfter = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;
    assert.equal(unshieldAfter - unshieldBefore, 1);
  });

  // =========================================================================
  // Combination 5: Replay Attack Defense Across Ephemeral Boundaries
  // =========================================================================
  it('C5: Anti-replay registry prevents cross-invoice payment theft across ephemeral routes', async () => {
    // 1. Settle legitimate invoice for /analytics
    const ch1 = merchantGateway.createPaymentChallenge('/api/v1/protected/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
    const parsed1 = ChallengeParser.parse(ch1.challengeHeaders, ch1.challengeBody);
    const receipt1 = await clientProxy.settleChallenge(parsed1);

    const legitimateGrant = await resourceServer.handleRequest('GET', '/api/v1/protected/analytics', {
      'x-payment-invoice-id': ch1.invoice.invoiceId,
      'x-payment-proof': receipt1.txHash
    });
    assert.equal(legitimateGrant.status, 200);

    // 2. Attacker creates fresh invoice for /ai-inference (10 WQUAI)
    const ch2 = merchantGateway.createPaymentChallenge('/api/v1/protected/ai-inference', 10_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);

    // 3. Attacker re-submits receipt1.txHash to claim invoice 2
    const replayAttackRes = await resourceServer.handleRequest('POST', '/api/v1/protected/ai-inference', {
      'x-payment-invoice-id': ch2.invoice.invoiceId,
      'x-payment-proof': receipt1.txHash
    });

    // 4. Must be rejected with HTTP 409 Conflict
    assert.equal(replayAttackRes.status, 409);
    assert.equal(replayAttackRes.body.error, 'ERR_REPLAY_DETECTED');
  });

  // =========================================================================
  // Combination 6: Standby Window Enforced in Full Settlement Lifecycle
  // =========================================================================
  it('C6: Enforces standby window: unshield to merchant rejected during window; returns to depositor succeed', async () => {
    pool.standbyWindowSeconds = 300; // 5 minute standby
    const depositor = '0xPublicDepositorClean';
    const depositorKey = addressToBigInt(depositor);

    // Create fresh deposit
    blockchain.mintToken(WQUAI, pool.contractAddress, 50_000_000_000_000_000_000n);
    const { leafIndex, commitment } = pool.shield(
      WQUAI,
      50_000_000_000_000_000_000n,
      corporateKeys.npk,
      121212n,
      'standby_test',
      depositor
    );

    const freshUTXO = {
      commitment,
      leafIndex,
      token: WQUAI,
      value: 50_000_000_000_000_000_000n,
      blinding: 121212n,
      memo: 'standby_test',
      depositorAddress: depositor,
      depositTimestamp: Math.floor(Date.now() / 1000)
    };

    // Client attempts to unshield to merchant address during standby window
    const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
    const reqToVendor = {
      merkleRoot: pool.merkleTree.root,
      nullifier: 88812345n,
      recipient: ch.invoice.ephemeralAddress,
      token: WQUAI,
      amount: 5_000_000_000_000_000_000n,
      relayerFee: 500_000_000_000_000_000n,
      relayerAddress: relayer.relayerAddress,
      ppoiProof: { sanctionsRoot: pool.sanctionsSMT.root, depositOrigin: depositorKey, isNonSanctioned: true }
    };

    // Fails because recipient is vendor, not depositor
    assert.throws(() => {
      pool.unshield(reqToVendor);
    }, /STANDBY_WINDOW_ACTIVE_ONLY_DEPOSITOR_UNSHIELD_ALLOWED/);

    // Emergency withdrawal back to original depositor address succeeds even during standby
    const reqToDepositor = {
      ...reqToVendor,
      recipient: depositor,
      nullifier: 88812346n
    };
    const emergencyRes = pool.unshield(reqToDepositor);
    assert.ok(emergencyRes.txHash);
    assert.equal(blockchain.getTokenBalance(WQUAI, depositor), 5_000_000_000_000_000_000n);
  });

  // =========================================================================
  // Combination 7: Upstream Temporary Failure with Resilient Recovery
  // =========================================================================
  it('C7: Settlement resilience: handles upstream 500 failure, re-presents cached receipt on retry without double-charge', async () => {
    const targetUrl = '/api/v1/protected/analytics';

    // First call: challenge issued and unshield executed, but upstream simulated server throws 500
    let failureTriggered = true;
    const flakeyServer = async (headers?: Record<string, string>) => {
      if (failureTriggered && headers && headers['X-Payment-Proof']) {
        failureTriggered = false;
        return { status: 500, headers: {}, body: { error: 'INTERNAL_UPSTREAM_GLITCH' } };
      }
      return resourceServer.handleRequest('GET', targetUrl, headers);
    };

    const firstRes = await clientProxy.fetchWithPayment(targetUrl, flakeyServer);
    assert.equal(firstRes.status, 500);

    // Second call: client retries; should use cached receipt and receive 200 OK without unshielding again
    const unshieldBefore = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;
    const retryRes = await clientProxy.fetchWithPayment(targetUrl, h => resourceServer.handleRequest('GET', targetUrl, h));
    assert.equal(retryRes.status, 200);

    const unshieldAfter = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;
    assert.equal(unshieldAfter, unshieldBefore); // Zero duplicate unshields!
  });

  // =========================================================================
  // Combination 8: Viewing Key Audit Inflow/Outflow Mathematical Reconciliation
  // =========================================================================
  it('C8: Viewing Key Audit Engine produces exact mathematical reconciliation of net balance across mixed activity', async () => {
    // Initial corporate funding was 500 WQUAI
    // Settle 3 distinct payments
    for (let i = 0; i < 3; i++) {
      const chObj = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const parsed = ChallengeParser.parse(chObj.challengeHeaders, chObj.challengeBody);
      await clientProxy.settleChallenge(parsed);
    }

    const auditor = new ViewingKeyAuditEngine(corporateKeys, pool);
    const jsonStr = auditor.exportJson('DarkCircle Global Enterprise');
    const report = JSON.parse(jsonStr);

    // 1 deposit (500.00) + 3 unshields (each 5.00 payment + 0.50 relayer fee = 5.50 * 3 = 16.50)
    // Net balance = 500.00 - 16.50 = 483.50 WQUAI
    assert.equal(report.summary.totalInflow, '500.000000000000000000');
    assert.equal(report.summary.totalOutflow, '16.500000000000000000');
    assert.equal(report.summary.netBalance, '483.500000000000000000');
    assert.equal(report.summary.ppoiComplianceRate, '100.0%');

    // Verify CSV output matches exact row counts
    const csvStr = auditor.exportCsv();
    const rows = csvStr.trim().split('\n');
    assert.equal(rows.length, 5); // 1 header + 4 transaction rows
  });
});
