# DarkCircle security audit and remediation

Scope: everything under `src/`, `ui/`, `scripts/` and `bin/` as of 2026-09-21, read by hand, with each
finding reproduced (or its absence confirmed) against the code before it was fixed. Every fixed finding
has a regression test in `test/unit/hardening.test.ts` or `test/unit/api_checklist.test.ts` that fails if
the fix is removed.

## Verdict

**The code is not ready to guard real funds, and this audit does not change that.** It hardened what can
be hardened in this repository, and it made the remaining gap explicit. The shielded pool, relayer and
ledger are in-memory simulations: there is no deployed pool contract, no zero-knowledge circuit and no
verifier deployed anywhere (open items O-1 to O-3, updated below: a reference circuit, verifier and pool contract now exist and pass local end-to-end tests, but they are unaudited and use a development ceremony). Passing this audit means the simulation now enforces the statement a
real circuit must prove, and that the code around it (payment verification, spending policy, compliance
screening, CLI, API) no longer has the holes listed below. It does not mean the system is production
ready. Section "Open items" is the work between here and a release.

## Second assessment (2026-09-23)

A second, deeper pass over the circuit, the contracts and the application is in
[`docs/AUDIT_2026-09-23.md`](docs/AUDIT_2026-09-23.md). It found a **critical** circuit bug (a spending key and
the same key plus the subgroup order own the same note but derive different nullifiers, so every note could be
spent up to eight times; proven on the compiled contracts), two major x402 defects (a payment for one resource
unlocked another; expiry could strand a paid invoice's funds) and a note that a clock tick could make
unspendable, among others. Everything fixable in code is fixed, each with a regression test; the circuit, keys,
verifier and contracts were rebuilt. The verdict above still holds: the open items below remain.

After that pass: **881 tests, all passing** (615 before the first audit, 813 after it), `tsc --noEmit` clean.

The voice agent (README, "Voice agent") added 32 tests: **913 in all, passing**. It is outside this audit's scope: it is new, and unlike the rest of the console it prepares real-chain transactions (signed by the user's own wallet after a per-spend confirmation).

## Method

1. Read every trust boundary: pool, verifier, relayer, settlement coordinator, gateway, sweeper, resource
   server, crypto primitives, audit/keys, CLI, and the new API and UI.
2. For each, asked what an attacker who controls one input can make the code do.
3. Wrote the attack as a test first where possible, confirmed it succeeded on the old code, then fixed.
4. Re-ran the full suite (615 tests before this work, 813 now, all passing), `tsc --noEmit` (clean; the four old `fetch.preconnect` errors came from Bun's ambient types and went away once `tsconfig.json` pinned `types` to Node) and `pnpm verify:quai` against the live zone.

Three findings (A-07 timing, A-20 key leak, A-21 unverified claim) were found by running the system rather than reading it.

## Fixed findings

Severity is impact if this were deployed as-is: **Critical** loses funds or grants access for free,
**High** breaks a stated guarantee, **Medium** weakens defence in depth, **Low** is a correctness nit.

| ID | Sev | Finding | Fix | Test |
|---|---|---|---|---|
| A-01 | Critical | `verifySettlement` accepted a payment proof that does not exist on the ledger. An unknown transaction hash unlocked an invoice whenever the address held enough tokens; the caller-supplied `amountSent` was trusted; the standalone server accepted any proof. | Proof is a transaction hash judged by its receipt: success status, ERC-20 `Transfer` logs of the invoice token to the invoice address summing to at least the amount, N confirmations, replay-proof. Same rule for the in-memory ledger and a live Quai zone (`QuaiReceiptSource`, `verifyPaymentAsync`); fails closed with 503 when the chain is unreachable. `amountSent` is ignored. | `A-01` (6 tests) |
| A-02 | Critical | The pool trusted the caller. Any request with a valid root and a fresh nullifier withdrew any amount: no note membership, ownership, nullifier binding or value conservation was checked. | `unshieldVerifier.ts` checks the full statement (commitment, fixed-depth Merkle path, ownership, nullifier, value conservation with range bounds, change commitment, anti-front-running hash). Default pool mode is `verified`; the old behaviour survives only as an explicit `trusted-harness` mode that the UI, API and checklist flag as unsafe. | `A-02` (5 tests) |
| A-03 | High | Nullifiers were compared as strings, so the same nullifier written as decimal, hex, padded hex or `n + p` was a different "unspent" nullifier: a double spend. | Public inputs are canonical field elements (`Fp.canonical`, rejects `>= p`); the spent set is keyed by value. | `A-03` |
| A-04 | High | The sanctions origin of a spent note came from the request's own `depositOrigin`. A sanctioned depositor could claim a clean origin. | The origin is read from the pool's own deposit record for the note; a mismatching claim fails the PPOI lineage check; verified pools require the SMT proof. | `A-04` |
| A-05 | Critical | `shield()` was bookkeeping only. A note could be created for tokens the pool never received, then withdrawn against other users' balance. Re-shielding the same commitment overwrote its recorded origin (sanctions laundering). | Verified `shield()` pulls funds (balance and allowance) in the same call, rejects duplicate commitments, and change commitments equal to an existing note. `pool.solvency()` asserts custody covers every unspent note. | `A-05` (2), `solvency` |
| A-06 | High | Unshield was not atomic: a fee transfer that failed after the recipient was paid left the recipient paid and the nullifier unspent, so the request could be replayed. | Every failure condition is checked before any state changes; a compensating transfer covers the impossible case. | `A-06` |
| A-07 | High | The coordinator recorded its change note at "the last leaf". A deposit landing during the awaited broadcast gave the note the wrong index and made it unspendable. Separately, change notes got a fresh timestamp while the pool kept the parent's, failing PPOI (found only by test flakiness across a clock second). | The pool returns `changeLeafIndex`; change notes inherit the parent deposit lineage in both places. | `A-07` |
| A-08 | Medium | The pool accepted any string as recipient, relayer or depositor. | Verified pools require checksummed Cyprus-1 Quai-ledger addresses. | `A-08` |
| A-09 | Medium | `dailyBudgetCap` was declared and never enforced. | Enforced per token over a rolling 24 h, under the settlement mutex so concurrent requests cannot jointly overshoot. | `A-09` |
| A-10 | Medium | The client paid invoices that had expired or were about to. | `minInvoiceTtlSeconds` refuses before a note is spent. | `A-10` |
| A-11 | Low | A challenge's `maxFee` was ignored. | Refused when the relayer fee exceeds it. | `A-11` |
| A-12 | Medium | Direct unshield made the treasury the on-chain sender without any signal. | Refused unless `allowDirectUnshield` is set. | `A-12` |
| A-13 | High | Inbound sanctions screening checked the freshly generated ephemeral address, which can never be listed. It screened nobody. | The payer is read from the `Transfer` log and screened; it becomes the note's PPOI origin. | `A-13` |
| A-14 | High | Sweeping moved tokens, then shielded. A shield failure stranded funds in the pool with no note. | Shield first (nothing has moved), then move; verified pools pull against an allowance. | `A-14` |
| A-15 | High | `new ResourceServer()` silently used a gateway that accepts any proof of payment. | A gateway or an explicit `{ demo: true }` is required. | `A-15` |
| A-16 | Medium | Malformed credentials fell through to issuing a fresh invoice (and a key search). | Format-checked; malformed credentials are 400. | `A-16` |
| A-17 | Medium | Unauthenticated requests create invoices without bound. | Registry capped, expired invoices pruned first. | `A-17` |
| A-18 | Medium | A failed post-payment sweep was swallowed, and the server always claimed `X-Payment-Relayer-Decoupled: true`. | Failures surface as a header and a hook; the decoupling header is only sent when the payer on chain was the pool. | `A-18`, `end to end` |
| A-19 | High | CLI amount parsing read `--amount 5` as 5 base units but `--amount 5.0` as five tokens. | Amounts are token amounts; base units need a `u` suffix; excess precision and negatives are refused. | `A-19` |
| A-20 | High | `darkcircle invoice --json` printed the payee address's private key. | Redacted; the API returns explicit safe fields only. | `A-20`, API test |
| A-21 | Medium | `darkcircle sweep --json` reported `forwardSecrecyKeyZeroization: "CONFIRMED"` unconditionally: a security claim that was asserted, not checked. | Read back from the invoice registry after the sweep; reports `NOT_CONFIRMED` if the key is still present. | `WQI ... CLI reports the sweep method` |
| A-22 | Medium | `dailyBudgetCap` did not accumulate across commands. The CLI and the API build a fresh `SettlementCoordinator` for every payment, and the spend log lived inside it, so each payment saw an empty log and the cap could be exceeded by simply paying twice. (Found while building persistence, which needed the log to be owned by something durable.) | The log is a `SpendTracker` owned by the lane and passed to every coordinator; it is part of the persisted state. | `A-09b` (fails without the fix) |
| S-01 | Low | `PersistenceManager.status()` threw when the data directory vanished, exactly when an operator needs it to report the failure. (Found by the manager tests.) | The store lists an absent directory as empty; the failed save is remembered and shown. | `a failed save is remembered in status` |
| T-01 | Medium | snarkjs writes a broken proving key, without an error, when the powers of tau is too small for the circuit. (Found while sizing the ceremony: a 2^8 ptau for a 517-constraint circuit produced a file that failed later with "Missing section 1".) | The pipeline computes the required size the way snarkjs does, caches ptau files with a recorded digest, and verifies the finished proving key against the circuit and the ceremony. | `sizes the powers of tau the way snarkjs requires`, `runs every stage` |
| C-01 | Medium | `Fp.random()` reduced 256 random bits mod `p`, which is biased. | Rejection sampling. | `C-01` |
| C-02 | Medium | ECDH accepted any on-curve point; small-order points leak the secret scalar mod 8. The README claimed subgroup checks that did not exist. | `isInPrimeSubgroup` on both encrypt and decrypt. | `C-02` |
| C-03 | Medium | A public seed constant derived the default treasury keys, and any string was accepted as a seed. | `assertStrongSeed` at entry points, `generateSeed()`, published seeds refused. | `C-03` |
| W-01 | Medium | Only one asset could be live at a time (the UI's asset switch reset the simulation), so WQI had no pool of its own and a shared treasury could have mixed assets. | Each asset has its own isolated pool, relayer, gateway, treasury and journal on one ledger (`createMultiAssetEnvironment`); a pool accepts only its own token; the API routes by asset and by invoice owner. | `two pools on one ledger` (6), `WQUAI and WQI pools live at once` (9) |
| W-02 | Medium | WQI's gasless sweep was a label with no behaviour, and nothing checked that a permit signed here would be accepted by the deployed contract. | The sweep signs a real EIP-2612 permit with the payee key; the token verifies it exactly as the contract would; the permit domain is pinned to the live `DOMAIN_SEPARATOR` and re-verified by `pnpm verify:quai`. Forged and replayed permits are rejected and move nothing. | `WQI: EIP-2612 permit and the gasless sweep` (8) |
| U-01 | Medium | New local API and UI: DNS rebinding, cross-site calls, CSRF, script injection. | Loopback bind, Host and Origin checks, per-process session token, JSON only, 64 KiB cap, CSP `default-src 'none'`, text-node rendering only, server-side re-run of the checklist on every action. | `local API server` (9 tests) |

## Accepted, low risk

- `parseAmountToBaseUnits` truncates excess fractional digits in a *server-supplied* challenge. The client
  then underpays, the merchant answers 402, and nothing is lost. Existing tests assert the truncation.
- `zeroizeEphemeralKey` overwrites a JS string reference; the old string lingers until garbage collection.
  Forward secrecy therefore rests on the key being re-derivable only with the merchant master key, not on
  memory wiping.
- The simulation uses the wall clock for standby windows and deposit ages.

## Open items (not fixable in this repository)

These block a production release. The first three are the release.

| ID | Item |
|---|---|
| O-1 | **Reference circuit, verifier and pool contract exist; none is audited or deployed.** `circuits/unshield.circom` implements C1 to C7 of `unshieldVerifier.ts` (17,568 constraints since the 2026-09-23 key-range fix) and rejects, in tests, a wrong key, an aliased key (key + L), a tampered path, root, nullifier, amount, recipient, relayer, fee, change or leaf index, a zero amount, a 128-bit overflow and a note of another token. `contracts/DarkCirclePool.sol` derives each commitment from the funds it pulled in the same call and verifies the proof; on a local EVM its Poseidon, commitments and Merkle roots equal the simulation's, a real proof is accepted, and replays and every tampered call are refused. Still needed: an independent audit of circuit, verifier and contract, and a decision on the pool's governance (it has no owner, pause or upgrade path). |
| O-2 | **No real relayer.** Signing, gas funding in QUAI, fee market, nonce handling and the access-list transaction path (`QuaiRpcClient.prepareContractCall` exists and was exercised read-only). The simulated relayer can be taken offline by an operator; while it is, every payment and sweep refuses (`ERR_RELAYER_OFFLINE`, checklist item `SP-EX-04`). |
| O-3 | **Persistence exists for the simulation; production storage does not.** `src/persistence` writes encrypted (AES-256-GCM, scrypt), atomic, sequence-numbered snapshots of the whole environment including payee keys, recovers to the newest snapshot that authenticates and passes coherence checks, and refuses a restore under different keys. Still needed: the passphrase in a KMS instead of an environment variable, off-host encrypted backups, and a transaction-log model if snapshots stop being enough at real volume. |
| O-4 | Key custody: spending key in process memory; needs KMS/HSM and a viewing-key distribution process. |
| O-5 | Wallet integration for real signing (Pelagus/Blip inject `window.quai` and speak `quai_*`, not EIP-1193). The UI is simulation-only. |
| O-6 | Privacy is bounded by the anonymity set. With few notes, amounts and timing link deposits to withdrawals; the checklist warns, it cannot fix. PPOI list provider integration is also missing. |
| O-7 | No Quai-specific sanctions list; the bundled seed is Ethereum OFAC addresses used for bridge origins. |
| O-8 | Public-facing hardening: rate limiting, authentication and request logging in front of the resource server. The API server is loopback, single user. |
| O-9 | BabyJubjub arithmetic is BigInt double-and-add: variable time. Replace with an audited constant-time library before handling real keys. |
| O-10 | Reorg-aware payment watcher. The live receipt source needs at least 2 confirmations; ~25-block reorgs were seen on Orchard. |
| O-11 | Gas is not metered in the simulation except for the revert-burn rule. |
| O-13 | WQUAI has no permit, so its payee address needs QUAI for gas. The relayer top-up flow is not modelled, and it would itself put a relayer-to-payee transfer on chain; it needs a design (or a gasless WQUAI path) before release. WQI is unaffected. |
| O-14 | **Compliance (C8, PPOI) is not in the circuit or the contract.** The pool cannot refuse a note whose deposit origin is sanctioned; it needs its own proof and an on-chain list root. Until then the simulation enforces C8 and the contract does not. |
| O-15 | **The trusted setup is a development ceremony.** One contributor, this machine. Anyone who controlled its randomness could forge proofs. It needs a real multi-party ceremony (or a transparent proof system) with a published transcript; the pipeline labels its keys `productionSafe: false` and every deployment plan lists it as a gate. |
| O-16 | **Reference contract governance and economics.** No relayer registry or fee market (any address may relay); no way to pause or upgrade; fee-on-transfer tokens are refused. These are choices that need a decision, not defaults. |
| O-17 | **Nothing has run on Quai.** The contracts were exercised on a local EVM (`@ethereumjs/evm`, which includes the BN254 pairing precompile). Unverified on Quai: that the zone exposes precompiles 0x06 to 0x08, contract-address grinding into the right zone and ledger, access lists for a deployment, and creation gas (seen at roughly 2.5 times the estimate). The deployment plans list these; nothing is broadcast by this repository. |
| O-12 | `test/e2e/tier*.test.ts` exercise `test/e2e/harness.ts`, a parallel reimplementation, not `src/`. Coverage of `src/` is in the unit and hardening suites. |

The executable form of the release gates is `docs/SHIELDED_POOL_CHECKLIST.md` (Part A).

<!-- @admin:begin -->
## Admin console (development only)

The console (`src/admin`, `ui/admin`) is opt-in, redacted before release, and was reviewed as a privileged surface: it has its own credential (separate from the page's session token, printed only on the server terminal, 24+ characters), memory-only sessions with idle and absolute expiry, throttled sign-in with a doubling lockout that also refuses the right token during a lockout, typed confirmations for restore and wipe enforced on the server, and a hash-chained action log that is scrubbed of secrets and records refusals. It sits behind the same loopback, Host, Origin, session-token, JSON-only and CSP rules as the rest of the API. It never signs or broadcasts; Orchard and mainnet are plans, and mainnet is blocked outright by gates this repository cannot satisfy. Tests: `test/admin/`. `pnpm redact:admin --check` verifies nothing of it remains after redaction, and a test redacts a copy, type-checks it and runs suites against it.
<!-- @admin:end -->
