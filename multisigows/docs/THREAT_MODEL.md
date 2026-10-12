# DarkSafe v2 threat model

What DarkSafe defends against, how, which test proves it, and what is left over. Paths are
relative to the repository root; `I1`–`I14` are the invariants in the security plan, listed
in `docs/AUDIT_SCOPE.md`.

## Assets

- **Funds** held by vaults: QUAI and tokens.
- **Governance state:** owners, threshold, timelock, and the approvals on each transaction.
- **The integrity of what an owner approves.** An owner approves a transaction hash. That hash
  must commit to exactly the call the owner reviewed.
- **Owner keys.** These are held in the owners' wallets, never by DarkSafe.

## Actors and trust

| Actor | Trusted with | Not trusted with |
|---|---|---|
| A quorum of owners | Everything the vault can do (by design) | — |
| A single owner, or fewer than the threshold | Proposing, approving, revoking | Moving funds or changing governance alone |
| Anyone else | Expiring overdue transactions, sending funds in | Everything else |
| The RPC node the app uses | Nothing on its own | State it reports, unless another source agrees |
| The web host / CDN | Serving the app | The app's integrity: the CLI verifier gives an independent view |
| Wallet extension | Signing what it shows | Showing what the call does: it only shows `approveTransaction(hash)` |
| Contracts the vault calls | Their own behaviour | Re-entering the vault, draining gas, flooding returndata |
| Block producers | Ordering and timestamps (± seconds) | Anything else |

## Threats

| # | Threat | Defence | Evidence |
|---|---|---|---|
| T1 | **Blind signing / swapped UI** (the Bybit pattern): the page shows one call while another is approved | On-chain approval of a content hash. The review screen re-derives that hash from the stored fields and shows every field in full. `darksafe-verify` prints the same review digest from any node. There is a timelock, and the watcher alerts on proposals and on quorum | `invariant_everyHashRederivesFromStoredFields`; the tamper test in `apps/web/test/v2_vault.test.tsx`; the lying-node tests in `packages/contracts/test/v2/core-integration.test.ts` and `tools-integration.test.ts` |
| T2 | **Fake vault** (deposits into an attacker's contract that reports convincing owners) | A vault must run the pinned proxy code, point at the pinned implementation, and have been created by the verified factory (`isWallet`). There is no "add anyway" override | `core-integration.test.ts` (a stray proxy with identical code is refused); `DarkSafeVaultFactory.t.sol` |
| T3 | **Fake or poisoned factory** | The factory's code must equal the compiled template once its immutable byte ranges are masked; `implementation()` must run the pinned vault code; `proxyCodeHash()` must equal the pinned proxy hash | `testFuzz_factoryMaskAgreesWithPin` (differential; a single flipped byte is caught); `core-integration.test.ts` (a factory pointing at a token is refused) |
| T4 | **Gas griefing** (execute with just enough gas that the call fails and the approved transaction is burnt) | Before the call, the vault requires `gasLimit × 64/63 + 100k` and marks the transaction executed. A starved execute reverts instead of failing | `testFuzz_starvedExecuteNeverBurnsTheTransaction`, `test_gasBoundaryForwardsFullCommittedGas`, handler checks in the invariant campaign, the soak's starved-execute simulation |
| T5 | **Storage takeover via DELEGATECALL / upgrade** | The vault has no DELEGATECALL, CALLCODE or SELFDESTRUCT. There are no modules, no upgrade function and no admin key | `scripts/check-opcodes.js` (CI); `test_proxyHasNoUpgradeOrReinitialisePath` |
| T6 | **A compromised owner below the threshold** | Can only propose and approve. Proposals expire, at most 30 days after their timelock ends. Approvals can be revoked. The proposer can cancel before quorum, and a quorum can cancel by consensus afterwards. The watcher alerts on every proposal | `invariant_noUnsafeExecution`; the cancel and revoke tests |
| T7 | **A compromised quorum** | Nothing on chain stops it: admin changes run as soon as quorum approves. Mitigations are choosing the threshold, the watcher, and `docs/INCIDENT_RUNBOOK.md`. Phase 5 considers a delay on admin changes that a minority can veto | Residual (see below) |
| T8 | **Stale approvals from removed owners** | Removing an owner bumps their epoch, so their approvals stop counting, even if they are re-added later | `invariant_approvalsOnlyFromCurrentOwners`, `testFuzz_removedOwnersApprovalsNeverCountAgain`, the soak's admin-and-epochs step |
| T9 | **Re-entrancy from the called contract** | `executeTransaction` is `nonReentrant` and sets `executed` before the call. Admin changes are self-calls and cannot nest | The `ReentrantAttacker` test; invariant handler checks |
| T10 | **Returndata bomb** | At most 256 bytes of returndata are copied | The `ReturnBomb` test |
| T11 | **Timestamp manipulation** | Timelocks and expiries are hours to days, against seconds of skew. The app anchors expiry on the latest block's timestamp and warns when the user's clock is off | `packages/core/src/vault/clock.ts` tests |
| T12 | **Reorgs** | Writes wait for 6 confirmations on Orchard and 3 on mainnet, and re-read the block hash. The watcher reads at a confirmed depth and alerts when its last block changes hash | `waitForConfirmations` tests; `tools-integration.test.ts` (reorg alert) |
| T13 | **A lying or stale RPC** | Owners, threshold, delay and transaction contents are compared at one block across the app's RPC, an optional second RPC and the wallet's own node. A disagreement blocks every write | `readAcrossSources` tests; the web disagreement test |
| T14 | **Replay on another chain or vault; wrong network** | The hash commits to `block.chainid` and the vault address. The wallet's chain and account are re-checked before every write | Hash differential tests; `phase0_hardening.test.tsx` |
| T15 | **Look-alike and poisoned addresses** | Addresses are shown in full in groups of four and never shortened below 10+8 characters. Recipients the vault has not paid before, and that are not in the address book, are flagged. Qi-ledger owners and recipients are flagged | `vault.test.ts` risk and format tests |
| T16 | **Front-end supply chain / compromised host** | A strict CSP with no third-party scripts, fonts or images, and the QR code generated locally. CI uses SHA-pinned actions, a frozen lockfile, `--ignore-scripts`, CodeQL and `pnpm audit`. For anything that matters, use the independent CLI check | `security_headers.test.ts`; `qrcode.test.ts` |
| T17 | **Tampered browser storage** | Only the vault list and address-book labels are stored, both schema-validated. A vault is re-verified on chain every time it is shown | `SafeContext.tsx` guards; the web tests |
| T18 | **Misleading token metadata** | Symbols are sanitised (no bidi or zero-width characters) and raw amounts are always shown next to them | `sanitizeText` tests |
| T19 | **Undecodable or ambiguous calldata** | Calldata is only decoded when it re-encodes to identical bytes. Otherwise it is flagged, and admin calls then need a typed confirmation | `testFuzz_dirtyAdminCalldataRejectedByBoth`; decode tests |
| T20 | **Losing keys / lockout** | The creation grade warns about "every owner must sign". Admin changes can replace owners while quorum remains | `assessVaultConfig` tests |

## Residual risks

1. **A compromised quorum can do anything, immediately, through admin changes.** Pick a
   threshold that an attacker must compromise several independent people to reach, and run the
   watcher.
2. **The wallet still shows only `approveTransaction(hash)`.** Owners who skip the review, or
   who never compare digests, can still be misled by a malicious page. The CLI and the
   digest are the defence.
3. **If every source is the same provider, a consistent lie is not detected.** Run
   `darksafe-verify` against a node you control, or configure an independent
   `VITE_QUAI_SECONDARY_RPC_URL`.
4. **Quai's gas schedule differs from Ethereum's.** Storage cost scales with state size. The gas
   margins are proven with Ethereum's gas costs in Foundry, and the Orchard soak measures them on
   Quai. A starved execute only ever reverts: the transaction stays approved. But on Quai a
   reverted transaction is charged its whole gas limit.
5. **Plain transfers into a vault run the proxy's `receive()`**, which emits an event. A sender
   with a hard 21,000 gas limit (some exchanges) fails. The 2,300-gas stipend of
   `transfer()`/`send()` works (`test_plainTransferWithStipendReachesVault`).
6. **The contract does not check the Qi-ledger bit for owners.** The app refuses Qi-ledger
   owners; other clients might not.
7. **Unaudited.** This model is the authors' own. `docs/AUDIT_SCOPE.md` sets up the independent
   review that gates mainnet.
