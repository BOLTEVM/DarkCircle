# DarkCircle: End-to-End Test Infrastructure & Specification (`TEST_INFRA.md`)

**Project Name**: DarkCircle  
**Document Version**: 1.0.0-PROD-TEST  
**Author**: Lead Test Writer (`test_writer_e2e_1`)  
**Target Environment**: Node.js v24.11.1+ (TypeScript Strip-Types / Vitest / Node Test Runner), Windows / Linux CI  
**Status**: Authoritative Test Infrastructure Specification  

---

## 1. Opaque-Box, Requirement-Driven Test Philosophy

DarkCircle is an enterprise-grade privacy suite enabling autonomous AI agents and enterprise backends to settle and receive HTTP 402 payments with zero-knowledge anonymity and compliant Private Proof of Innocence (PPOI).

The DarkCircle testing infrastructure adheres to an **opaque-box, requirement-driven testing philosophy**:
1. **Public Contracts & Behavioral Verification**: Tests evaluate the system strictly through its documented public APIs, wire formats, HTTP status codes, cryptographic proofs, and blockchain transaction receipts. Internal class hierarchies and private helpers are not tested directly.
2. **Resilience to Implementation Evolution**: Whether zero-knowledge operations are performed via native WASM, Circom Groth16, or pure TypeScript algebraic field simulation, the test assertions remain authoritative and invariant.
3. **Zero Facade / High Integrity**: No test case uses synthetic return constants that bypass underlying validation. Merkle trees, SMT non-membership proofs, Poseidon note commitments, nullifiers, ephemeral keys, and HTTP 402 challenges are genuinely computed and cryptographically verified.
4. **Adversarial Verification**: Edge cases, boundary violations, malicious replay attacks, front-running attempts, and sanctions contamination are tested with negative assertions ensuring immediate transaction rejection.

---

## 2. 4-Tier Test Methodology

The DarkCircle E2E test track is structured across four progressive, comprehensive tiers:

```text
+-------------------------------------------------------------------------------+
|                    DARKCIRCLE 4-TIER TEST ARCHITECTURE                        |
+-------------------------------------------------------------------------------+
                                        |
  +-------------------------------------+-------------------------------------+
  |                                     |                                     |
  v                                     v                                     v
+-------------------------------+ +-------------------------------+ +-------------------------------+
|   Tier 1: Feature Coverage    | |   Tier 2: Boundary & Corner   | |  Tier 3: Cross-Feature Comb.  |
|   - >= 5 test cases / feature | |   - >= 5 edge cases / feature | |  - Multi-subsystem pipelines  |
|   - Happy paths & contracts   | |   - Malformed data & overflows| |  - End-to-end payment loop   |
|   - Wire & protocol standards | |   - Replay & sanction defenses| |  - Heterogeneous multi-token  |
+-------------------------------+ +-------------------------------+ +-------------------------------+
                                        |
                                        v
                        +-------------------------------+
                        |   Tier 4: Workload Scenarios  |
                        |   - AI Agent Swarm workloads  |
                        |   - High-throughput merchants |
                        |   - Enterprise Tax / PPOI audits|
                        |   - Network latency & recovery|
                        +-------------------------------+
```

### Tier 1: Feature Coverage (Primary Path & Functional Verification)
Every core feature defined in `PROJECT.md` is covered by at least **5 distinct test cases**:
- **Feature 1: HTTP 402 Interception & Challenge Parsing**:
  1. Intercepts HTTP 402 on protected endpoints.
  2. Parses RFC 7807 JSON problem details challenge.
  3. Parses RFC 7235 `WWW-Authenticate: x402 ...` header challenge.
  4. Parses custom `X-Payment-*` headers fallback.
  5. Extracts token address, amount, recipient, chain ID, and invoice ID correctly.
- **Feature 2: Relayer Unshield Settlement & On-Chain Graph Decoupling**:
  1. Generates unshield proof from shielded note UTXO.
  2. Broadcasts unshield transaction via independent Relayer.
  3. Asserts on-chain `tx.sender === relayerAddress`.
  4. Asserts zero trace of corporate master treasury in transaction data.
  5. Confirms vendor receives exact invoice token amount.
- **Feature 3: Payment Receipt Caching & Deduplication**:
  1. Stores settled payment receipt in cache indexed by canonical cache key.
  2. Satisfies repeat requests to same paywalled resource from cache without re-paying.
  3. Coalesces concurrent in-flight requests using single-flight locking (1 unshield for N requests).
  4. Respects invoice/lease expiration TTL.
  5. Evicts or ignores invalid/expired cache entries.
- **Feature 4: Inbound Merchant Privacy Gateway & Ephemeral Address Derivation**:
  1. Issues HTTP 402 challenge for unprotected incoming requests.
  2. Generates cryptographically unique ephemeral address per invoice.
  3. Ensures no address reuse across distinct invoices.
  4. Formats RFC 7235 and RFC 7807 headers on challenge response.
  5. Registers invoice in active invoice registry with configurable TTL.
- **Feature 5: Inbound Payment Tracking, Balance Sweeping & Shielding**:
  1. Detects on-chain token settlement to ephemeral destination.
  2. Validates transfer amount, recipient address, and token contract.
  3. Marks invoice status as `SETTLED`.
  4. Automatically sweeps ephemeral balance into corporate Railgun pool.
  5. Creates encrypted 0zk shielded note for merchant treasury and marks invoice `SWEPT`.
- **Feature 6: Railgun Shielded Pool Engine (Poseidon, UTXO, Nullifier)**:
  1. Computes hiding note commitment using Poseidon BN254 scalar field arithmetic.
  2. Inserts note commitments into Incremental Merkle Tree (depth 16).
  3. Derives deterministic nullifier using spending private key, commitment, and leaf index.
  4. Rejects double-spend attempts if nullifier is already registered.
  5. Maintains ring buffer of historical Merkle roots (last 64 roots).
- **Feature 7: Cryptographic PPOI Engine & Sanctions SMT Screening**:
  1. Initializes Sparse Merkle Tree (SMT) with OFAC/illicit cluster sanctions data.
  2. Generates zero-knowledge non-membership proof for uncontaminated deposit origins.
  3. Verifies non-membership proof against active sanctions root.
  4. Rejects unshield transactions originating from sanctioned deposit addresses.
  5. Enforces standby maturation window before arbitrary unshielding.
- **Feature 8: Corporate Viewing-Key Derivation, Decryption & Audit Exporters**:
  1. Derives master spending key (`ssk`), public key (`spk`), viewing key (`vsk`), and viewing public key (`vpk`).
  2. Encrypts note payloads using ECDH shared secret + authenticated encryption.
  3. Scans blockchain event logs and successfully decrypts all notes belonging to corporate treasury.
  4. Exports structured `audit_report.json` conforming to enterprise schema.
  5. Exports ERP-compatible `audit_report.csv` with ISO-8601 timestamps and decimal balances.
- **Feature 9: Resource Server & Access Grant Enforcement**:
  1. Protects `/api/v1/protected/analytics` requiring 5.00 USDC.
  2. Protects `/api/v1/protected/ai-inference` requiring 10.00 USDC.
  3. Rejects requests without payment proof (`HTTP 402`).
  4. Grants access and returns `HTTP 200 OK` when valid payment proof is supplied.
  5. Emits `X-Payment-Receipt-Id` and `X-Payment-Status: SETTLED` headers.

---

### Tier 2: Boundary & Corner Cases (Negative, Overflow & Stress)
Every feature is tested against at least **5 boundary and adversarial corner conditions**:
- **B1. Empty / Corrupted Challenge Wire Formats**: Missing headers, malformed JSON, unsupported payment schemes, non-numeric amount fields, invalid chain IDs.
- **B2. Cryptographic Field Overflows & Scalar Bounds**: Amounts $\ge p$ (BN254 field modulus), scalar blinding overflows, negative amounts, zero amount unshield attempts.
- **B3. Relayer Front-Running & Fee Underpayment**: Relayer address substitution in ZK public inputs ($h_{tx}$ binding mismatch), fees below relayer minimum quote, gas starvation.
- **B4. Nullifier Double-Spend Prevention**: Re-submitting identical unshield payload, re-submitting spent nullifier across different recipients, concurrent double-spend race condition.
- **B5. Invoice Lifecycle & Expiration Boundaries**: Payments arriving 1 millisecond after `expiresAt`, zero-second TTL, sweeping late payments into pool without granting expired access, payment tracker polling past timeout.
- **B6. Underpayment & Overpayment Discrepancies**: Payer depositing partial amount (e.g. 3 USDC for 5 USDC invoice -> rejected with `ERR_UNDERPAYMENT`), payer overpaying (e.g. 10 USDC -> access granted and entire 10 USDC swept into shielded pool).
- **B7. Replay Attack Immunity**: Attacker copying confirmed `txHash` from Invoice A to claim Invoice B, or claiming different API routes using identical receipt -> rejected with `ERR_REPLAY_DETECTED` (`HTTP 409 Conflict`).
- **B8. Historical Root Buffer Boundary**: Submitting unshield proof built against Merkle root evicted from 64-block ring buffer -> rejected with `EXPIRED_MERKLE_ROOT`.
- **B9. Unauthorized Auditor Viewing Key**: External party viewing key decrypts 0 notes; corrupted ciphertext skips safely without crashing scanner.
- **B10. Ephemeral Address Key Zeroization**: Memory zeroization and key purge verification after sweep completion to prevent post-settlement exposure.

---

### Tier 3: Cross-Feature Combinations (Integration Pipelines)
Evaluates multi-subsystem end-to-end interactions:
1. **Full Two-Way Privacy Roundtrip**:
   - Outbound AI Agent makes request -> receives 402 challenge.
   - PPOI Engine validates clean ancestry.
   - Relayer unshields tokens to ephemeral merchant address (treasury decoupled).
   - Inbound Gateway detects deposit, marks invoice settled, and serves upstream resource (200 OK).
   - Auto-Sweeper sweeps ephemeral balance into merchant 0zk shielded pool.
   - Internal Corporate Auditor runs viewing-key audit engine, reconstructing both the outbound payment and the merchant inbound sweep with exact balance reconciliation.
2. **PPOI Sanctions Interception in Relayer Pipeline**:
   - Tainted deposit lineage triggers PPOI non-membership failure; Relayer refuses broadcast; Client proxy aborts; Upstream resource remains unaccessed.
3. **Multi-Token Heterogeneous Privacy Settlement**:
   - Simultaneous settlements across USDC (6 decimals), DAI (18 decimals), and WBTC (8 decimals) through independent ephemeral addresses, validating decimal normalization in audit sheets.
4. **Cross-Invoice Replay Collision Resistance**:
   - Multiple parallel clients attempt to reuse identical payment receipts across different endpoints; Anti-replay registry stops every reuse attempt.
5. **Standby Grace Period Enforcement**:
   - Direct deposit tested under 60-second standby window: arbitrary unshield to third-party vendor reverts, while emergency return to depositor succeeds.

---

### Tier 4: Real-World Workload Scenarios (Enterprise Scale)
Simulates realistic enterprise operational conditions:
1. **Autonomous AI Agent Swarm Workload**:
   - 20 autonomous AI agents concurrently querying paywalled analytics and AI inference endpoints.
   - Single-flight lock coalesces redundant payments; receipt cache satisfies duplicate calls; treasury balance decrements by exact expected sum.
2. **High-Frequency Merchant SaaS Invoicing**:
   - Payee gateway generates 50 distinct ephemeral invoices for rapid customer purchases.
   - Ephemeral addresses maintain 100% collision-free uniqueness.
   - Auto-sweeper processes sweeps in batches; on-chain surveillance observes only disconnected ephemeral addresses and Railgun deposits.
3. **Comprehensive Quarterly Regulatory & Tax Audit**:
   - Viewing Key Audit Engine scans 100+ mixed transactions (deposits, unshield payouts, relayer fees, inbound sweeps).
   - Generates `audit_report.json` and `audit_report.csv`.
   - Validates JSON against JSON Schema draft 2020-12 and verifies 100% PPOI compliance rate.
4. **Network Mempool Latency & Timeout Recovery**:
   - Simulates delayed block confirmations and mempool congestion.
   - Verifies proxy timeout budgets, exponential backoff, and graceful error reporting without freezing calling applications.
5. **Corporate Spending Policy Budget & Whitelist Guard**:
   - Enforces daily volume budgets, max per-transaction limits, and token whitelists under heavy request volume.

---

## 3. Test Runner Architecture & Execution

The test suite runs using Node.js v24 native test runner (`node:test`, `node:assert/strict`) with native TypeScript support, or via Vitest.

### Test Execution Commands

```powershell
# Run the complete E2E Test Suite (Tiers 1-4)
node --test test/e2e/*.test.ts

# Run individual tiers
node --test test/e2e/tier1_features.test.ts
node --test test/e2e/tier2_boundaries.test.ts
node --test test/e2e/tier3_combinations.test.ts
node --test test/e2e/tier4_workloads.test.ts

# Standard project test command (when package.json script is invoked)
npm test
```

### Self-Contained Test Harness (`test/e2e/harness.ts`)
To eliminate external binary dependencies (such as local Anvil or Docker) and prevent port conflicts in automated CI/CD environments, the test harness provides:
- **`SimulatedBlockchain`**: In-memory EVM state ledger supporting ERC-20 token transfers and block event emissions.
- **`RailgunPool`**: BN254 Poseidon note commitment tree, nullifier registry, and root ring buffer.
- **`RelayerNetwork`**: Off-chain relayer node that broadcasts unshield transactions from an independent relayer address, verifying gas fee payment and graph decoupling.
- **`InboundMerchantGateway`**: Complete implementation of RFC 7235 / RFC 7807 challenge generation, ephemeral address derivation, invoice tracking, and auto-sweeping.
- **`OutboundPaymentProxy`**: 402 interceptor, challenge parser, spending policy validator, PPOI verifier, single-flight receipt cache, and request re-executor.
- **`ViewingKeyAuditEngine`**: BabyJubjub note decryption and JSON/CSV compliance report generation.
- **`ResourceServer`**: Realistic protected API routes (`/api/v1/protected/analytics`, `/api/v1/protected/ai-inference`).
