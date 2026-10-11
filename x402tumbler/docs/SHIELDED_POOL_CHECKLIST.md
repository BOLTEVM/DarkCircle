# Shielded pool transaction checklist

Two checklists live here. **Part A** decides whether the system may hold real value at all: a release
gate, done once and re-done on every change to the pool, circuits, relayer or keys. **Part B** is the
per-transaction checklist an operator (or the UI) runs before every shield, payment, invoice, sweep or
audit export. Part B is executable: `darkcircle checklist <kind>` and the modals in the UI run the same
checks, and every action re-runs them on the server, so a UI cannot skip a gate. The item ids (`SP-*`)
are the ids the code emits, and a test fails if this document and the code drift apart.

Status of this codebase against Part A: **Part A is not satisfied** (see `AUDIT.md`, open items O-1 to
O-13). Part B is fully implemented against the simulation.

Legend: **block** = a failing check stops the transaction; **warn** = needs explicit acknowledgement;
**info** = shown for context.

---

## Part A: release gates (before any real funds)

Nothing below is optional. Tick only with evidence: a report, a transaction hash, a review sign-off.

### A1. Pool contract and proofs
- [ ] A pool contract is deployed on Quai Cyprus-1 (chain id 9) at a recorded address; bytecode hash matches the audited build. *Status: `contracts/DarkCirclePool.sol` exists and its deployed-bytecode hash is recorded at build time; it is unaudited and deployed nowhere (O-1, O-17).*
- [ ] The unshield circuit implements constraints C1 to C8 of `src/sim/unshieldVerifier.ts` exactly (commitment, Merkle path of fixed depth, ownership with the spending key restricted to `[0, L)` so each note has exactly one nullifier, nullifier, value conservation with range bounds, change commitment, public-inputs hash, origin from the pool's record). *Status: `circuits/unshield.circom` implements C1 to C7 and is tested against the simulation; C8 (PPOI) is missing (AUDIT.md O-14).*
- [ ] The spending key is a private input of the circuit and is never sent to a relayer or the pool.
- [ ] The verifier contract matches the circuit's verification key; the trusted setup (or transparent alternative) is documented and its transcript published. *Status: the keys come from a single-contributor development ceremony and are marked `productionSafe: false` (O-15).*
- [ ] Nullifiers and roots are rejected unless canonical field elements (`< p`); the contract has a test for `n` versus `n + p`.
- [ ] `shield()` pulls funds atomically; a note cannot exist without custody. Solvency (`pool balance >= sum of unspent notes`) is checked by an invariant test on the contract.
- [ ] Unshield is atomic: any failure reverts all effects.
- [ ] An independent security audit of contract, circuit and verifier is complete, with all high and critical findings closed.
- [ ] Upgrade and pause authority is defined, minimal, time-locked, and documented.

### A2. Quai specifics and per-asset pools
- [ ] Every transaction the relayer sends carries an access list from `quai_createAccessList` and a gas limit from `quai_estimateGas` plus a small buffer (a multi-contract transaction without one reverts and burns its whole gas limit).
- [ ] Signing does not use `ethers` block reads with full transactions (Quai transactions carry no `r/s/v`); the client uses zone-only RPC, checksummed addresses, and asserts chain 9 and the zone location.
- [ ] Tokens are identified by address (WQUAI `0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB`, WQI `0x002b2596EcF05C93a31ff916E8b456DF6C77c750`); `pnpm verify:quai` passes against the production RPC on the release day.
- [ ] Payment verification runs against a live zone (`QuaiReceiptSource`) with at least 2 confirmations and a reorg-aware watcher.
- [ ] WQUAI and WQI each have their own deployed pool (separate addresses, trees and custody); each pool accepts only its own token, and no code path mixes their notes or journals.
- [ ] WQI permit sweeps are exercised on chain: the deployed `DOMAIN_SEPARATOR` matches the registry (`verify:quai` prints `permitDomain=ok`), and a permit signed by the payee key is accepted by the contract when submitted by the relayer.
- [ ] WQUAI sweeps have a decided gas strategy (O-13): relayer top-up with its on-chain link accepted, or another approach.

### A3. Relayer and operations
- [ ] The relayer signs and broadcasts real transactions; its QUAI gas balance is monitored with an alert threshold. *Status: the simulated relayer has a configurable gas alert (`SP-EX-02`) and an operator off switch (`SP-EX-04`); a real relayer does not exist (O-2).*
- [ ] Direct unshield stays disabled (`allowDirectUnshield` false): the treasury is never the on-chain sender.
- [ ] Rate limiting, authentication and request logging front the resource server. Logs contain no keys, notes or blinding factors.
- [ ] Sweep failures alert (`ResourceServer.onSweepError`); a runbook covers stranded ephemeral funds.

### A4. Keys and data
- [ ] The spending key lives in a KMS or HSM, not process memory. Seeds come from `generateSeed()` or a hardware source; `assertStrongSeed` is enforced at every entry point. No published seed is used.
- [ ] The viewing key is issued to auditors through a documented, revocable process. Exports are produced with the viewing key only.
- [ ] Notes, invoices, ephemeral keys and the journal are persisted in an encrypted store with backup and a tested recovery scan (losing the invoice registry must not strand funds). *Status: implemented for the simulation in `src/persistence` (encrypted, atomic, verified recovery); production needs the passphrase in a KMS and off-host backups (O-3).*
- [ ] BabyJubjub arithmetic is replaced with an audited constant-time implementation.

### A5. Compliance
- [ ] A sanctions list source for Quai and for bridge origins is chosen, loaded at startup, refreshed on a schedule, and its provenance recorded.
- [ ] A PPOI list provider is integrated; the pool checks its root, not only the local registry.
- [ ] Legal review of operating a shielded pool in the target jurisdictions is complete and on file.
- [ ] Minimum anonymity set and withdrawal policies are documented; operators are told the warnings in B (SP-PV-*) are not cosmetic.

### A6. Release hygiene
- [ ] `pnpm test`, `pnpm lint` and `pnpm verify:quai` pass on the release commit, installed from the committed `pnpm-lock.yaml` with `pnpm install --frozen-lockfile`.
- [ ] No component runs in `trusted-harness` mode (`SP-ENV-02` passes on the production context).
- [ ] The word "simulation" no longer appears in the UI banner, because it is no longer true, and the banner has been replaced on purpose.

---

## Part B: per-transaction checklists

WQUAI and WQI are separate pools. A transaction is checked, and runs, against the pool of its own asset: a WQUAI note is never counted toward, or spent from, the WQI pool. In the UI the asset is the modal's *Asset* field (it defaults to the pool currently shown); the server routes invoice-scoped actions (sweep) by the invoice's owner and refuses a request that names a different asset.

Run automatically by the UI's pre-flight panel and by `darkcircle checklist <kind> [options]`
(exit 0 = nothing blocks, 1 = blocked). Every transaction also runs the **common** checks first.

### B0. Common (all kinds)

| ID | Check | Result if it fails |
|---|---|---|
| SP-ENV-01 | Ledger and pool are on the same Quai network and chain id, zone prefix known | block |
| SP-ENV-02 | Pool **and** payment gateway are `verified`, not `trusted-harness` | block |
| SP-ENV-03 | Simulation notice: in-memory ledger, no real funds, no deployed pool | warn (always, in this build) |
| SP-ENV-04 | Tree capacity: not full; warn at 90 % | block / warn |
| SP-FN-03 | Pool solvency: custody covers every unspent note | block |

### B1. Shield (deposit)  `darkcircle shield` / Shield modal

| ID | Check | Result if it fails |
|---|---|---|
| SP-IN-01 | Asset is a registered Quai asset and allowed by policy (identified by address, never by symbol) | block |
| SP-IN-02 | Amount is a positive decimal within the note range, no excess precision | block |
| SP-IN-03 | Depositor is a checksummed Cyprus-1 Quai-ledger address | block |
| SP-FN-02 | Depositor holds the tokens (or, with wrap, SP-FN-06 native QUAI covers amount plus gas) | block |
| SP-FN-06 | Wrap native QUAI: only WQUAI wraps (WQI is issued by its own contract and has no `deposit()`); native balance covers it | block |
| SP-FN-05 | Custody: the pool pulls the funds in the same call | info |
| SP-CP-01 | Depositor is not on the sanctions list (it becomes the note's PPOI origin) | block |
| SP-PV-01..03 | Anonymity set, relayer-only broadcast, amount fingerprint | warn |
| SP-EX-01..04 | Access list, relayer gas, confirmations, relayer online (informational for a shield: the depositor sends it) | pass / warn / info |

### B2. Send payment (unshield)  `darkcircle pay` / Send modal

| ID | Check | Result if it fails |
|---|---|---|
| SP-IN-01, SP-IN-02 | As B1 | block |
| SP-IN-03 | Recipient is a checksummed, in-zone, Quai-ledger address (a wrong-zone address is rejected by the node; a Qi-ledger address cannot hold ERC-20) | block |
| SP-IN-04 | Recipient is external: not the operating wallet, the pool or the relayer | warn |
| SP-CP-01 | Recipient is not on the sanctions list | block |
| SP-CP-04 | Within the per-payment cap | block |
| SP-CP-05 | A daily budget cap is configured | warn |
| SP-FN-01 | One shielded note covers amount plus relayer fee; shows the note spent and the change created | block |
| SP-FN-04 | Relayer fee is at most 1 % of the payment | warn |
| SP-CP-02 | The spent note's recorded origin is clean and a non-membership proof can be produced (PPOI) | block |
| SP-CP-03 | Standby window: within it, a note can only return to its depositor | block |
| SP-PV-01 | Anonymity set of at least 20 unspent notes | warn |
| SP-PV-02 | Broadcast by the relayer; the treasury is never the sender | pass / warn |
| SP-PV-03 | No recent deposit of exactly this amount | warn |
| SP-PV-04 | Note is not younger than 10 minutes (timing correlation) | warn |
| SP-EX-01 | Access list `[pool, token]` attached | pass |
| SP-EX-02 | Relayer holds at least 1 QUAI for gas | warn |
| SP-EX-03 | Confirmations the merchant will require | info |
| SP-EX-04 | The relayer is online (an operator can take it offline; it broadcasts every payment) | block |

### B3. Receive payment (invoice)  `darkcircle invoice` / Receive modal

| ID | Check | Result if it fails |
|---|---|---|
| SP-IN-01, SP-IN-02 | As B1 | block |
| SP-RC-01 | A fresh single-use payee address is derived in Cyprus-1 on the Quai ledger, with a real key | pass |
| SP-RC-02 | A payment is accepted only when a confirmed receipt shows the transfer (token, payee, amount) | pass |
| SP-RC-03 | Sweep gas: WQI is swept gaslessly (the payee key signs an EIP-2612 permit, the relayer submits it); WQUAI needs the relayer to fund QUAI gas | pass / warn |
| SP-RC-04 | Invoice lifetime (customers paying after expiry are refused with 410) | info |

### B4. Sweep to pool  `darkcircle sweep` / Sweep modal

| ID | Check | Result if it fails |
|---|---|---|
| SP-SW-01 | The invoice exists and is `SETTLED` | block |
| SP-SW-02 | The ephemeral address holds funds to sweep | block |
| SP-SW-03 | The payer was identified from the `Transfer` log (screening a fresh address screens nobody) | warn |
| SP-CP-01 | The payer is not on the sanctions list; if it is, the sweep is refused and funds stay put | block |
| SP-SW-04 | The ephemeral key is present (it is zeroized after the sweep) | block |
| SP-PV-*, SP-EX-* | As B2, including SP-EX-04: an offline relayer cannot submit the sweep | warn / info / block |

### B5. Audit export  `darkcircle audit` / Audit export modal

| ID | Check | Result if it fails |
|---|---|---|
| SP-AU-01 | The journal reconciles: running balance equals the sum of unspent notes | block |
| SP-AU-02 | The export uses the read-only viewing key; the spending key is not used or included | pass |
| SP-AU-03 | One asset per report; export each asset separately | info |

---

## Part C: when a check fails or something looks wrong

1. **Blocked by SP-ENV-02:** stop. A component is in `trusted-harness` mode. Do not override; fix the wiring.
2. **SP-FN-03 fails (insolvent):** halt all shields and payments. The pool owes more than it holds. Preserve state, reconcile against the journal, and treat it as an incident.
3. **SP-CP-01 or SP-CP-02 fails on a note already in the pool:** do not attempt to route around it. The note cannot be unshielded to third parties; escalate to compliance.
4. **A sweep fails after payment:** the customer already has access. The funds are on the ephemeral address; the response carries `X-Payment-Sweep: deferred; reason=...` and `onSweepError` fires. Re-run the sweep after fixing the cause (gas, screening, capacity); do not delete the invoice.
5. **A payment is `ERR_PAYMENT_UNCONFIRMED`:** retry after more blocks; do not lower the confirmation requirement to make it pass.
6. **Reconciliation fails (SP-AU-01):** do not export. Find the entry whose running balance diverges from the note set.
7. **The server restarted or crashed with persistence on:** it restores the newest snapshot that authenticates and passes the coherence checks, and reports any newer snapshot it had to skip. If it refuses to start (`ERR_RESTORE_IDENTITY`, `ERR_RESTORE_NETWORK`), the store belongs to other keys or another network: do not delete it and do not point a fresh server at it; fix the configuration. If every snapshot fails, the store is intact but unreadable to this build: preserve the directory and escalate.
8. **The relayer is offline (SP-EX-04):** payments and sweeps refuse and change nothing; a settled invoice stays `SETTLED` with its funds on the payee address and can be swept once the relayer is back. Do not remove the payee key or the invoice.

## Part D: id index

`SP-ENV-01..04`, `SP-IN-01..04`, `SP-FN-01..06`, `SP-CP-01..05`, `SP-PV-01..04`, `SP-EX-01..04`,
`SP-RC-01..04`, `SP-SW-01..04`, `SP-AU-01..03`.
