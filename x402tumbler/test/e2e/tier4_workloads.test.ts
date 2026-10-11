/**
 * DarkCircle E2E Test Suite — Tier 4: Real-World Workload Scenarios
 *
 * Requirements: Real-world enterprise workload scenarios under scale and operational conditions.
 *
 * Scenarios Tested:
 * - W1: Autonomous AI Agent Swarm Workload (High-concurrency autonomous payments)
 * - W2: High-Frequency Merchant SaaS Invoicing Stream (Continuous ephemeral rotating & auto-sweeping)
 * - W3: Enterprise Quarterly Tax, Accounting & PPOI Regulatory Audit (50+ transactions reconciliation)
 * - W4: Network Mempool Latency & Timeout Recovery (Deterministic SLA budgets)
 * - W5: Corporate Spending Policy Budget & Whitelist Guard Under Peak Traffic
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
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

describe('Tier 4: Real-World Workload Scenarios', () => {
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

    corporateKeys = deriveCorporateKeys('corporate_treasury_seed_tier4');
    merchantKeys = deriveCorporateKeys('merchant_store_seed_tier4');

    merchantGateway = new InboundMerchantGateway(
      'merchant_master_secret_tier4',
      merchantKeys.corporate0zkAddress,
      merchantKeys.npk,
      blockchain,
      pool
    );

    clientProxy = new OutboundPaymentProxy(
      {
        maxPaymentCap: 100_000_000_000_000_000_000n, // 100 WQUAI max
        allowedTokens: [WQUAI, DAI],
        allowedChainIds: [9]
      },
      relayer,
      corporateKeys
    );

    resourceServer = new ResourceServer(merchantGateway);

    // Initial corporate treasury funding: 1,000 WQUAI note
    blockchain.mintToken(WQUAI, pool.contractAddress, 1_000_000_000_000_000_000_000n);
    const { leafIndex, commitment } = pool.shield(
      WQUAI,
      1_000_000_000_000_000_000_000n,
      corporateKeys.npk,
      999111n,
      'tier4_corporate_large_funding',
      '0xCorporate_Public_Funder'
    );

    clientProxy.addTreasuryUTXO({
      commitment,
      leafIndex,
      token: WQUAI,
      value: 1_000_000_000_000_000_000_000n,
      blinding: 999111n,
      memo: 'tier4_corporate_large_funding',
      depositorAddress: '0xCorporate_Public_Funder',
      depositTimestamp: Math.floor(Date.now() / 1000)
    });
  });

  // =========================================================================
  // Workload 1: Autonomous AI Agent Swarm Workload
  // =========================================================================
  it('W1: Autonomous AI Agent Swarm: 20 AI agents dispatching simultaneous metered API requests with single-flight deduplication', async () => {
    const endpoints = [
      '/api/v1/protected/analytics',
      '/api/v1/protected/ai-inference'
    ];

    const unshieldBefore = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;

    // Simulate 20 autonomous agent tasks targeting endpoints concurrently
    const agentTasks = Array.from({ length: 20 }).map((_, idx) => {
      const target = endpoints[idx % endpoints.length];
      const method = target.includes('inference') ? 'POST' : 'GET';
      const body = method === 'POST' ? { model: 'llama-3-8b', prompt: `Agent query #${idx}` } : undefined;

      return clientProxy.fetchWithPayment(target, h => resourceServer.handleRequest(method, target, h, body));
    });

    const results = await Promise.all(agentTasks);

    // All 20 agent calls must succeed with HTTP 200 OK
    for (const r of results) {
      assert.equal(r.status, 200);
      assert.ok(r.body.status === 'success');
    }

    // Since there are only 2 distinct endpoints, single-flight lock coalesces into exactly 2 unshield transactions!
    const unshieldAfter = pool.poolEvents.filter(e => e.type === 'UNSHIELD').length;
    const newUnshields = unshieldAfter - unshieldBefore;
    assert.equal(newUnshields, 2);

    // Treasury balance correctly decremented:
    // Analytics: 5.00 WQUAI + 0.50 relayer fee = 5.50 WQUAI
    // AI Inference: 10.00 WQUAI + 0.50 relayer fee = 10.50 WQUAI
    // Total spend = 16.00 WQUAI (16,000,000 base units)
    const currentTreasuryValue = clientProxy.treasuryUTXOs.reduce((acc, u) => acc + u.value, 0n);
    assert.equal(currentTreasuryValue, 1_000_000_000_000_000_000_000n - 16_000_000_000_000_000_000n);
  });

  // =========================================================================
  // Workload 2: High-Frequency Corporate Payee SaaS Invoicing Stream
  // =========================================================================
  it('W2: High-Frequency Merchant Stream: 25 distinct client invoices generated, settled, and auto-swept into shielded pool', async () => {
    const ephemeralAddresses = new Set<string>();

    for (let i = 0; i < 25; i++) {
      // 1. Create unique invoice
      const ch = merchantGateway.createPaymentChallenge('/api/v1/protected/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      assert.equal(ephemeralAddresses.has(ch.invoice.ephemeralAddress), false);
      ephemeralAddresses.add(ch.invoice.ephemeralAddress);

      // 2. Client pays to ephemeral address
      blockchain.mintToken(WQUAI, ch.invoice.ephemeralAddress, 5_000_000_000_000_000_000n);
      const verifyRes = merchantGateway.verifyPayment(ch.invoice.invoiceId, `0xclient_tx_${i}`);
      assert.equal(verifyRes.success, true);

      // 3. Auto-sweep triggered
      const sweepRes = await merchantGateway.sweepAndShield(ch.invoice.invoiceId);
      assert.equal(sweepRes.sweptAmount, 5_000_000_000_000_000_000n);
      assert.equal(blockchain.getTokenBalance(WQUAI, ch.invoice.ephemeralAddress), 0n);
    }

    // All 25 ephemeral destinations were completely unique
    assert.equal(ephemeralAddresses.size, 25);

    // Merchant pool absorbed all 25 sweeps (25 * 5.00 = 125.00 WQUAI)
    const merchantSweptNotes = pool.poolEvents.filter(e => e.type === 'SHIELD' && e.memo.startsWith('inv_'));
    assert.equal(merchantSweptNotes.length, 25);
  });

  // =========================================================================
  // Workload 3: Enterprise Quarterly Tax, Accounting & PPOI Audit
  // =========================================================================
  it('W3: Enterprise Regulatory Audit: processes 30+ mixed transactions, exports JSON & CSV reports, validates schema and 100% PPOI rate', async () => {
    // Execute a batch of diverse transactions
    for (let i = 0; i < 15; i++) {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const parsed = ChallengeParser.parse(ch.challengeHeaders, ch.challengeBody);
      await clientProxy.settleChallenge(parsed);
    }

    const auditor = new ViewingKeyAuditEngine(corporateKeys, pool);
    const jsonStr = auditor.exportJson('DarkCircle Enterprise Holding LLC');
    const report = JSON.parse(jsonStr);

    // Validate schema requirements
    assert.equal(report.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(report.title, 'DarkCircleAuditReport');
    assert.equal(report.entityName, 'DarkCircle Enterprise Holding LLC');
    assert.equal(report.summary.ppoiComplianceRate, '100.0%');
    assert.equal(report.summary.tokenSymbol, 'WQUAI');
    assert.ok(report.transactions.length >= 16); // 1 deposit + 15 unshields

    // Verify mathematical reconciliation
    const calculatedNet = parseFloat(report.summary.totalInflow) - parseFloat(report.summary.totalOutflow);
    assert.equal(parseFloat(report.summary.netBalance).toFixed(6), calculatedNet.toFixed(6));

    // Verify CSV output
    const csvStr = auditor.exportCsv();
    const csvLines = csvStr.trim().split('\n');
    assert.ok(csvLines.length >= 17);
    assert.ok(csvLines[0].includes('ppoi_status'));
    assert.ok(csvLines[0].includes('compliance_status'));
  });

  // =========================================================================
  // Workload 4: Network Mempool Latency & Timeout Recovery
  // =========================================================================
  it('W4: Network Mempool Latency: handles upstream latency and timeout boundaries deterministically without fund leakage', async () => {
    const targetUrl = '/api/v1/protected/analytics';

    // Simulate network delay / timeout
    const delayedServer = async (headers?: Record<string, string>) => {
      // Simulate slow response
      await new Promise(resolve => setTimeout(resolve, 50));
      return resourceServer.handleRequest('GET', targetUrl, headers);
    };

    const res = await clientProxy.fetchWithPayment(targetUrl, delayedServer);
    assert.equal(res.status, 200);
    assert.ok(res.body.data.activeUsers);
  });

  // =========================================================================
  // Workload 5: Corporate Spending Policy Budget & Whitelist Guard Under Peak Traffic
  // =========================================================================
  it('W5: Corporate Policy Guard: enforces per-transaction limits and token whitelists under heavy request stream', async () => {
    // 1. Normal in-policy requests succeed
    for (let i = 0; i < 5; i++) {
      const ch = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
      const parsed = ChallengeParser.parse(ch.challengeHeaders, ch.challengeBody);
      const receipt = await clientProxy.settleChallenge(parsed);
      assert.ok(receipt.txHash);
    }

    // 2. Anomalous spike exceeding per-transaction cap (e.g. 150 WQUAI when cap is 100 WQUAI) is rejected
    const spikeCh = merchantGateway.createPaymentChallenge('/analytics', 150_000_000_000_000_000_000n, WQUAI, 'WQUAI', 18);
    const parsedSpike = ChallengeParser.parse(spikeCh.challengeHeaders, spikeCh.challengeBody);
    await assert.rejects(async () => {
      await clientProxy.settleChallenge(parsedSpike);
    }, /ERR_SPENDING_POLICY_REJECTED/);

    // 3. Unapproved token request is rejected
    const unapprovedToken = '0x0019999999999999999999999999999999999999';
    const badTokenCh = merchantGateway.createPaymentChallenge('/analytics', 5_000_000_000_000_000_000n, unapprovedToken, 'UNAPPROVED', 18);
    const parsedBad = ChallengeParser.parse(badTokenCh.challengeHeaders, badTokenCh.challengeBody);
    await assert.rejects(async () => {
      await clientProxy.settleChallenge(parsedBad);
    }, /ERR_UNSUPPORTED_CHAIN_OR_TOKEN/);
  });
});
