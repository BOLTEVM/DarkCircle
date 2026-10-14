# Production relayer plan

Status: **phases 1–3 implemented in `src/relayer/`** (2026-10-13): chain layer, safety/operations layer,
loopback HTTP API, unit and adversarial tests against a scripted Quai transport. Phase 4 (Orchard
rehearsal with the operator's wallet) and phase 5 (mainnet) are **not** started. Written 2026-10-13,
after the Orchard rehearsal of the WQI pool.

Closes `AUDIT.md` O-2 (no real relayer), and in doing so most of O-13 (WQUAI sweep gas) and O-10 (reorg-aware
confirmation). It does **not** close the mainnet release gates for the ceremony, the audit or PPOI.

## 1. Why it matters

`DarkCirclePool.unshield` is permissionless: any address may submit a proof, and the proof binds `recipient`,
`amount`, `relayer` and `fee`. Without a relayer a holder can still withdraw, by sending the transaction
themselves with `relayer = 0` and `fee = 0`. What is lost:

| Without a relayer | Consequence |
|---|---|
| The unshield's sender is the holder's own gas account | That account must hold QUAI, which links it to whatever funded it. With a small anonymity set (O-6) this is the main way a withdrawal is tied to a deposit. |
| Notes are WQUAI or WQI, gas is QUAI | A fresh recipient with no QUAI cannot withdraw alone. WQI sweeps are gasless only through an EIP-2612 permit that someone must submit; WQUAI has no gasless path (O-13). |
| The x402 settlement path assumes a relayer | The resource server settles by having one broadcast the unshield. Today that relayer is the in-process simulation, so paid services do not run on chain. |
| Nobody handles Quai's transaction rules | Access list on every call, creation-style gas headroom, zone-only RPC, no `r/s/v`, and reorgs of about 25 blocks seen on Orchard. |

A relayer does not make the pool safe. It removes a privacy leak and enables the payment flow.

## 2. What is in scope, and what is not

In scope: a separate process that accepts a proof and a payment request, simulates it, sends it from its own
funded account, waits for confirmation, and returns the receipt; its fee quote; its operations.

Out of scope: the trusted setup (G-05), the independent audit (G-06), PPOI enforcement on chain (G-07), custody
of user spending keys (O-4), and the legal position of operating a relayer for a shielded pool (checklist A5).
That last one is a decision for the operator and counsel, not a build task.

Constraints that already hold and must keep holding:

- The proof binds the relayer's address, so a relayer cannot be swapped after proving and cannot steal a fee.
- The relayer never sees a spending key or a viewing key; the request carries a proof and public fields only.
- Direct unshield from the treasury stays disabled (`allowDirectUnshield` false).
- The operator off switch (`SP-EX-04`) keeps working: offline means every relayed payment refuses before anything
  is attempted.

## 3. Design decisions (phase 1 — settled 2026-10-13)

1. **Key custody.** Encrypted JSON keystore (scrypt via ethers) at a path outside the repository; the
   passphrase comes from an environment variable only, never from a file, flag or log. The process
   decrypts it once at start and keeps the private key in memory. The signing key is wrapped in a
   policy guard (`PermittedCallSigner`, `src/relayer/signer.ts`) that refuses to sign anything whose
   `to` is not the configured pool address or whose calldata does not start with the `unshield`
   selector: the key can do exactly one thing. A KMS/HSM signer can be dropped in behind the same
   `QuaiTxSigner` interface later without touching the relayer.
2. **Fee model.** Per-asset published minimum fee (`RELAYER_MIN_FEE`, base units) plus a gas-cost
   component: `max(minFee, estimateGas × gasPrice × headroom)` with `headroom = 2.5` (Orchard
   observed 0.43x–2.47x of the simulator). A quote is honoured for `RELAYER_QUOTE_VALIDITY_BLOCKS`
   (default 12) blocks. The binding rule is enforced at relay time: a request whose `fee` is below
   the *current* quote is refused (`FEE_BELOW_QUOTE`) — the proof binds the fee, so the relayer can
   never be asked for more than was quoted. Inside the validity window the relayer absorbs a bounded
   shortfall when gas moves (that is what the headroom is for); outside it the client re-proves.
3. **Funding and alerts.** QUAI gas comes from the operator's treasury, topped up manually in v1.
   Floor `RELAYER_GAS_FLOOR` (default 1 QUAI): at or below the floor the relayer takes *itself*
   offline with the named reason `ERR_RELAYER_GAS_FLOOR` and logs an alert line; every request then
   refuses before anything is attempted. Alerting is log-only in v1.
4. **Topology.** Single-operator v1, stated plainly. It is a liveness and censorship point; the
   self-submit path (`relayer = 0`, `fee = 0`) stays available as the fallback at a privacy cost.
   A registry is out of scope for the pool contract by design.
5. **Interface.** Loopback-only HTTP (`127.0.0.1`): `POST /quote`, `POST /relay`,
   `GET /status/:nullifier`, `GET /health`. Bearer-token auth (`RELAYER_AUTH_TOKEN`), token-bucket
   rate limit, loopback Host/Origin checks and a 64 KiB body cap, all mirroring `src/api/server.ts`.
   Facing anything beyond localhost requires a reviewed change (O-8).
6. **Assets.** One relayer process per pool, configured with exactly one pool address and one token;
   a request naming any other token is refused (`TOKEN_POOL_MISMATCH`). WQUAI and WQI never share a
   relayer, matching the pool rule.

### Threat model (phase 1 deliverable)

| Threat | Defence |
|---|---|
| Relayer key theft | Encrypted keystore, passphrase from env only, key in memory only; the policy guard means a stolen *in-process* signer still cannot sign anything but `unshield` to the one pool. The funded key is the rotation target (runbook, `docs/RELAYER.md`). |
| Malicious client proof | The relayer never sees secrets, so a bad proof costs it nothing: every relay is simulated on the zone first (`quai_createAccessList` + `quai_estimateGas`); a step that would revert is refused (`RELAY_SIMULATION_FAILED`) because a revert burns the gas limit. Nullifier-spent, unknown-root, and fee/relayer mismatches are refused by name before any gas is spent. |
| Front-running by another relayer | Impossible to redirect: the proof binds `relayer`, `fee`, `recipient`, `amount` and `root`; a request naming a different relayer is refused (`RELAYER_ADDRESS_MISMATCH`) and a tampered payment fails the pool's own binding check on chain. |
| Gas spike between quote and relay | Quote headroom (2.5x); binding floor enforced at relay time; bounded shortfall absorbed inside the 12-block validity window; the operator can take the relayer offline when relaying is unprofitable. |
| RPC lying or lagging | Zone identity is asserted (`quai_chainId` + `quai_nodeLocation`) before any work; confirmations require ≥ `RELAYER_CONFIRMATIONS` (default 2) and a receipt whose block is still canonical — a receipt that disappears or a block number ahead of the head is treated as a reorg/stale-RPC event, the request goes back to pending, and the chain state is re-read before any resend. |
| Relayer online but censoring | Not preventable in a single-operator v1; it is a stated limitation. The self-submit fallback remains, and every refuse is a named error so clients can detect it. |
| Key reuse across pools | The policy guard pins `to` to the configured pool; the operator runs one process per pool (decision 6). |

## 4. Phases

### Phase 1: design (no code) — DONE
Section 3 above is the written record; operator sign-off is required before phase 5 (mainnet), same
as every other gate.

### Phase 2: chain layer — DONE (`src/relayer/`)
Built on `QuaiRpcClient.prepareContractCall`, which produces the access-list path.
- A nonce manager (`NonceManager`, `src/relayer/relayer.ts`) with a durable record in the relay store:
  a restart re-initialises from `max(persisted hint, on-chain pending count)` and never reuses or skips.
- Idempotency per nullifier: a retried request returns the original transaction instead of sending a
  second (`RelayStore`, `src/relayer/store.ts`).
- Confirmation tracking with ≥ 2 confirmations and reorg handling (O-10): a reorged-out unshield goes
  back to pending, the chain is re-checked (`nullifierSpent`) before any resend, and the resend uses a
  fresh nonce with an attempt cap.
- Exit met: `test/unit/relayer.test.ts` against a scripted Quai transport (no network).

### Phase 3: safety and operations — DONE (`src/relayer/`)
- Every unshield is simulated on the zone before sending (`quai_createAccessList`, then
  `quai_estimateGas`); a step that would revert is refused (`RELAY_SIMULATION_FAILED`), because a
  revert burns the gas limit.
- A proof whose nullifier is already spent (`NULLIFIER_ALREADY_SPENT`), whose root is not in the pool's
  history (`UNKNOWN_ROOT`), or whose `relayer` or `fee` do not match this relayer's quote
  (`RELAYER_ADDRESS_MISMATCH` / `FEE_BELOW_QUOTE`) is refused. The signer itself is policy-guarded: it
  will not sign anything but `unshield` to the configured pool.
- Rate limiting, request logging that never contains notes, keys or witness data, a gas floor that
  takes the relayer offline by itself, and a runbook (`docs/RELAYER.md`) for a stuck transaction and
  stranded ephemeral funds.
- Reconcile on start: the relayer reads the chain for every in-flight nullifier and refuses new work
  (`ERR_RELAYER_RECONCILING`) until reconciliation has finished.
- Exit met: `test/adversarial/relayer_adversarial.test.ts` — replayed proof, wrong relayer address,
  stale root, fee below quote, double submit, RPC returning stale state and a reorg: all refuse or
  recover with a named error.

### Phase 4: Orchard rehearsal
- **Gate before any broadcast:** the signed-transaction wire format in `KeystoreQuaiSigner`
  (`src/relayer/signer.ts`) must be compared against a known-good reference — a transaction signed
  for the same inputs by the quais SDK or the node — and found byte-identical. If it differs, phase 4
  stops there and the encoder is fixed first. This is the one thing the local tests cannot prove.
  `scripts/relayer-rehearsal.ts gate --gate-reference 0x…` performs exactly this comparison and
  nothing else; `full` refuses to start until it has passed.
- Run against the WQI pool already deployed on Orchard
  (`0x006Fc574dAAd3733b53c2EfC5Eaa505E991a5203`). `scripts/relayer-rehearsal.ts full` drives the
  whole sequence with real transactions and records every hash (see docs/RELAYER.md §6): shield a
  small amount from the operator's wallet, prove, relay the unshield over the relayer's real HTTP
  API to a **fresh, unfunded** address, confirm the nullifier and `nextIndex`, confirm the relayer
  received exactly the quoted fee — then run the failure cases on chain: relayer offline, fee below
  quote, a proof naming a different relayer.
- Exit: the sequence above recorded with transaction hashes (rehearsal-<ts>.json). This also
  satisfies launch checklist T-06.

### Phase 5: mainnet, only after the rest of the gates
Mainnet use waits on G-05 to G-08 like everything else. The relayer is the last of the four that this
repository can close by itself. Deploy it with a small gas balance first, relay one unshield, and only then
announce a fee.

## 5. Acceptance criteria

- A holder can unshield to an address that has never held QUAI, and the pool's on-chain caller is the relayer.
- The same request sent twice results in one transaction.
- A killed and restarted relayer finishes or reconciles every in-flight unshield with no duplicate and no loss.
- Taking it offline refuses new requests with a named error and does not strand an in-flight one.
- No log, response or file contains a spending key, viewing key, note or blinding factor.
- `pnpm test` and `pnpm lint` pass, and the checklist document and code stay in step (`SP-EX-*`).

## 6. Risks that remain after it is built

- A single relayer can censor or go down; self-submitting stays available as the fallback, at a privacy cost.
- The anonymity set is bounded by real usage (O-6); a relayer does not enlarge it.
- Fees, gas and the zone's behaviour change; creation and call costs on Quai have been observed at 0.43x to
  2.47x of the simulator, so quotes need headroom and a review cadence.
- It adds an operator who holds a funded hot key. That key is the thing to protect and to rotate.
