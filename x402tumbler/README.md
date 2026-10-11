# DarkCircle

> **x402 payment privacy for Quai Network: shielded-pool settlement in WQUAI and WQI, with Private Proof of Innocence (PPOI) compliance.**

DarkCircle lets autonomous agents and enterprise services pay and receive HTTP 402 payments on **Quai Network (Cyprus-1, chain id 9)** in **Wrapped Quai (WQUAI)** and **Wrapped Qi (WQI)** without linking the corporate treasury to the counterparty on-chain, while keeping sanctions screening and a read-only viewing-key audit trail.

## What is real and what is simulated

Read this before relying on it. The security audit is in [`AUDIT.md`](AUDIT.md); the release gates are in [`docs/SHIELDED_POOL_CHECKLIST.md`](docs/SHIELDED_POOL_CHECKLIST.md).

| Layer | Status |
|---|---|
| Quai network rules (zones, chain ids, address zone/ledger validation, checksums, access lists) | **Real**, checked against `rpc.quai.network/cyprus1` |
| WQUAI / WQI registry (addresses, decimals, capabilities, WQI's EIP-2612 domain) | **Real**: read back from Cyprus-1; `pnpm verify:quai` re-checks them live |
| Quai JSON-RPC client, access-list transaction preparation, on-chain payment verifier | **Real code**, read/prepare only. It never signs or broadcasts |
| x402 protocol, spending policy, gateway, ephemeral payees, audit engine, CLI, checklist, local API and UI | **Real code** running against the simulated ledger below |
| Blockchain, token contracts, shielded pools and relayer | **In-memory simulation.** Nothing is deployed on Quai. The simulated pool checks the *statement* a circuit must prove, from a witness that includes the spending key, so it enforces the constraints but is not zero-knowledge |
| Voice agent (the **Voice agent** page) | **Real Quai.** Spoken or typed commands become real Cyprus-1 (or Orchard) transactions that *your* wallet (Pelagus or Blip) signs after you confirm each one. It only uses public, non-shielded operations; see [Voice agent](#voice-agent-real-quai) |
| Groth16 circuit and pool contract | **Reference implementations, unaudited.** `circuits/unshield.circom` proves constraints C1 to C7 of that statement; `contracts/DarkCirclePool.sol` verifies it on chain. Both have been compiled and driven end to end on a local EVM with a real proof, and the on-chain hashes, commitments and Merkle roots equal the simulation's. They use a single-contributor development ceremony, do not enforce compliance (C8, PPOI) and are deployed nowhere |

So: everything up to the chain boundary is Quai-correct and testable; the pools themselves are a model. The one exception is the voice agent, which acts on the real chain through your own wallet. Do not point this at real funds until the open items in `AUDIT.md` (O-1, O-2 and O-14 to O-17) are closed.

## Two pools, both live

WQUAI and WQI each have their **own shielded pool**, relayer, merchant gateway, treasury notes and accounting journal, on one shared ledger. A WQUAI note can never be spent from the WQI pool, custody and anonymity sets are per asset, and a journal never sums the two.

| | WQUAI `0x006C3e2A…DBB` | WQI `0x002b2596…c77c750` |
|---|---|---|
| Pool | `0x000be6cd…DF3C` | `0x005e9784…6c2d` |
| Obtain | wraps native QUAI (`deposit()` / `withdraw()`) | issued by its own contract; no wrap |
| EIP-2612 permit | no | **yes** |
| Sweeping a payee address | needs the relayer to fund QUAI gas | **gasless**: the payee key signs a permit, the relayer submits it |
| Decimals | 18 | 18 |

WQI's permit domain (`name "Wrapped Qi"`, `version "1"`, chain 9, the WQI address) hashes to the deployed contract's `DOMAIN_SEPARATOR` `0xd2b1836a…fdc0`; a test pins the value and `verify:quai` re-reads it live, so a signature the simulation accepts is one the real contract will accept.

## Quai specifics built in

- **Chain and zone.** Mainnet is chain id `9` on all nine zones; the zone is chosen by the RPC endpoint *and* the address's first byte (Cyprus-1 = `0x00`). Orchard testnet is `15000`. Contract calls only work on a zone endpoint; the client checks `quai_chainId` and `quai_nodeLocation` first.
- **Addresses.** A payee must be a checksummed, in-zone, **Quai-ledger** address (top bit of byte 1 clear); a Qi-ledger (UTXO) address cannot hold an ERC-20. Anything else is rejected before a shielded note is spent.
- **Ephemeral payees.** Per-invoice keys are HMAC-seeded then ground by point-stepping until the address lands in Cyprus-1 on the Quai ledger (about 500 steps, roughly 0.1 s).
- **Assets by address.** Identity is by address, never symbol: Quai has unrelated tokens that share names (a second "USDT", for one). A challenge that states the wrong decimals for a registered token is rejected.
- **Access lists.** On Quai a multi-contract transaction without an access list reverts and burns its **entire** gas limit. The relayer attaches `[pool, token]`; `QuaiRpcClient.prepareContractCall` attaches `quai_createAccessList` output and refuses to return a transaction the node says would fail; the simulated ledger reproduces the burn.
- **Payment proof.** A payment is accepted only when a confirmed receipt shows `Transfer` logs of the invoice token to the invoice address for at least the invoiced amount. The same rule runs against the in-memory ledger and a live zone (`QuaiReceiptSource`).
- **x402 network id.** Challenges advertise `network="quai-cyprus1"` and `chainId="9"`.

## Quick start

```bash
pnpm test                       # full suite
pnpm lint                       # tsc --noEmit
pnpm verify:quai                # live, read-only check of Cyprus-1, WQUAI, WQI and WQI's permit domain
pnpm ui                         # operator console on http://127.0.0.1:5180 (simulation), dark by default
pnpm voice:setup                # shows which speech model the voice agent needs, and from where; downloads nothing
pnpm voice:setup -- --yes       # downloads it once (base.en, about 145 MB), after which speech never leaves this machine

# durable, encrypted state (the passphrase is read from the environment, never from a flag)
DARKCIRCLE_STORE_PASSPHRASE='twelve or more characters' pnpm ui --data-dir ./.darkcircle-data
```

<!-- @admin:begin -->
Development only (removed before release, see [Admin console](#admin-console-development-only)):

```bash
pnpm ui --admin                 # also serves the admin console; the token is printed on this terminal
pnpm test:admin                 # the admin console's own tests
pnpm redact:admin --dry-run     # what the release redaction would delete and edit
```
<!-- @admin:end -->

### CLI

```bash
node bin/darkcircle.ts shield --amount 10                         # deposit into the pool
node bin/darkcircle.ts invoice --amount 2.5                       # x402 invoice with a single-use payee
node bin/darkcircle.ts pay --recipient 0x003793E8b9DF52434EB58327453cA84528FBe18d --amount 1.25
node bin/darkcircle.ts sweep --invoice <id>
node bin/darkcircle.ts audit --format json
node bin/darkcircle.ts checklist unshield --address 0x003793E8b9DF52434EB58327453cA84528FBe18d --amount 5
DARKCIRCLE_ASSET=WQI node bin/darkcircle.ts pay --recipient 0x003793E8b9DF52434EB58327453cA84528FBe18d --amount 1.25
```

`--token` takes `wquai`, `wqi` or a registered address. **Amounts are token amounts**: `5` and `5.0` both mean five tokens; base units need a `u` suffix (`5000000000000000000u`); more fractional digits than the token has is an error. (An earlier version read `5` as five base units.) The CLI runs one asset per process (`DARKCIRCLE_ASSET`, default WQUAI); the UI runs both.

### Operator console (modals)

`pnpm ui` serves a local console. It is **dark by default** and has a light theme behind the sun/moon button in the top bar; the choice is remembered in the browser (and the page stays usable when storage is blocked). A sidebar switches between **Overview**, **Notes & events**, **Invoices** and **Journal**, and a chip in the top bar shows whether state is being saved. The overview has a **pools overview** (WQUAI pool and WQI pool side by side; click one to make it the asset shown below) and modals for **Shield**, **Send** (unshield), **Receive** (invoice), **Sweep**, **Audit export** and a stand-alone **Checklist**. Each modal is three steps: details with a live pre-flight checklist, review, result. A failing blocking check disables the button; warnings need an explicit acknowledgement; and the server re-runs the same checklist on every action, so the page cannot skip a gate. Nothing in it is real: a banner says so, and the trust chips turn red if any component is in `trusted-harness` mode.

The server binds to loopback only, checks `Host` and `Origin`, requires a per-process session token, caps bodies at 64 KiB, and serves a CSP that forbids inline script and third-party origins. It never returns keys.

### Checklist

[`docs/SHIELDED_POOL_CHECKLIST.md`](docs/SHIELDED_POOL_CHECKLIST.md) has two parts: **Part A** release gates (what must be true before real funds; not yet satisfied) and **Part B** per-transaction checklists whose `SP-*` items are executable (`darkcircle checklist <kind>`, and the UI panel). A test fails if the document and the code disagree about which ids exist.

## Voice agent (real Quai)

The **Voice agent** page (sidebar, marked LIVE) lets you tell your x402 agent what to do, out loud or typed, and it prepares the on-chain operation for your wallet to sign. Unlike the rest of the console it is **not a simulation**: the transactions are real and so is the money. A red banner says so whenever the page is open.

**What you can say**

| Say | It does |
|---|---|
| "what's my balance", "how much WQI do I have" | Reads QUAI, WQUAI and WQI balances of your connected wallet. Answers at once; nothing to confirm |
| "wrap 5 QUAI", "unwrap 2.5 WQUAI" | Calls WQUAI's `deposit()` / `withdraw()` |
| "send 10 WQUAI to Acme", "pay Acme 3 WQI", "send 1 QUAI to Acme" | Transfers to a **saved contact**, never to a spoken address |
| "buy the analytics report" | Fetches a **saved paid service**, reads its x402 challenge, pays the invoice from your wallet and then collects the resource with the payment proof |
| "confirm 4 1 7", "cancel" | Confirms or drops the pending plan |
| "help", "contacts", "services" | Lists what it knows |

Numbers can be spoken ("two and a half", "twelve point five"); filler such as "hey agent, could you please" is ignored. The grammar is deterministic and runs offline: there is no language model guessing what you meant. Anything outside it is refused with a reason and an example, and a name that is close to a contact (but not exact) is offered as a suggestion, never picked for you.

**Every spend is confirmed by you**

1. The agent builds a **plan**: the exact transaction(s), with an access list from `quai_createAccessList` and a gas limit from the node's estimate plus 20%. It refuses before you see anything if the node says the call would fail, if your balance cannot cover the amount plus the maximum fee, if the amount exceeds your limits, or if a contact's address is outside Cyprus-1 or on the Qi ledger.
2. It reads the plan back and shows a **3-digit code**. Confirm by clicking, or by saying the code ("confirm four one seven"). A plan expires after 3 minutes, and only the wallet and chain that asked for it can confirm it.
3. Your **wallet** opens with the transaction. The agent holds no keys and never signs; it cannot spend without your wallet's own approval.
4. The agent reads the **receipt** and checks it against the plan (sender, contract, the `Transfer` log's recipient and amount, the native value) before marking it done. Only verified spends count towards your limits.

Spending limits are per asset, per action (default 25) and per day (default 100), and are set on the page. Contacts and services are checked on the server: contact addresses must be checksummed Cyprus-1 Quai-ledger addresses, service URLs must be http(s) without credentials and name the token they are paid in plus a maximum price. A paid service's invoice is refused if it asks for another network, another token, more than your maximum, or expires in under 3 minutes.

**Speech stays on this machine by default.** Recordings are uploaded to the local server, written to a private temporary file, transcribed by [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (Whisper `base.en` by default) in a local Python worker, and deleted. The worker loads the model with `local_files_only=True`, so it never downloads anything on its own; install the model once with `pnpm voice:setup -- --yes` (needs `python -m pip install faster-whisper`; `DARKCIRCLE_PYTHON`, `DARKCIRCLE_VOICE_MODEL` and `DARKCIRCLE_VOICE_MODEL_DIR` override the defaults). Your browser's own speech recognition is offered as an option, but in Chrome it sends the recording to Google, and the page asks before using it. Spoken replies use only voices installed on your device.

With `--data-dir`, contacts, services, limits and the activity log are saved in the same encrypted store as the rest of the state (`<data-dir>/agent`); without it they last until the server stops.

**Not available by voice (yet):** shielding into the DarkCircle pools and private (shielded) payments are refused, because the pools are not deployed and real deposits must not go into a contract that cannot yet pay them out. They become voice commands once the pool contract is deployed and withdrawal proving is wired to it. The Qi (UTXO) ledger is not supported. The operations above are ordinary public Quai transactions, linked to your address like any other.

## Layout

```text
src/
  quai/          networks, address rules + key grinding, WQUAI/WQI registry, RPC client, payment verifier
  sim/           in-memory Quai zone ledger, ERC-20 (WQUAI/WQI, permit), shielded pool, unshield verifier, relayer
  proxy/         outbound 402 interceptor, challenge parser, settlement coordinator, spending policy
  gateway/       inbound merchant gateway, ephemeral payees, invoice registry, sweeper (permit or allowance), payment evidence
  ppoi/          sanctions registry (SMT), PPOI engine and validator
  audit/         viewing-key hierarchy, note decryption, double-entry journal (one asset each), JSON/CSV export
  crypto/        BN254 field, Poseidon, Merkle trees, BabyJubjub (with subgroup checks), notes
  checklist/     executable pre-flight checks for shield / send / receive / sweep / audit
  persistence/   tagged JSON codec, AES-256-GCM/scrypt snapshot store, environment snapshots with verified restore, autosave manager
  actions/       shield (deposit) action shared by the CLI and the UI
  agent/         voice agent: command grammar and spoken numbers, contacts/services/limits book, transaction planner, plan lifecycle, routes
  voice/         local speech-to-text (a persistent faster-whisper worker)
  api/           local loopback API behind the UI
  cli/           darkcircle balance | invoice | pay | sweep | audit | shield | checklist
ui/              index.html, theme.js, app.css, app.js, agent.js (voice agent), wallet.js (Pelagus/Blip bridge); no build step, no dependencies
circuits/        unshield.circom, the reference Groth16 circuit (constraints C1 to C7)
contracts/       DarkCirclePool.sol (reference pool), DevToken.sol (local-EVM tests only)
scripts/         verify-quai.ts (live check), serve-ui.ts, whisper_worker.py and whisper_setup.py (voice)
docs/            SHIELDED_POOL_CHECKLIST.md
build/           generated: compiled circuit, keys, contract artifacts, manifest (not committed)
test/            unit, e2e and adversarial suites (see AUDIT.md for the regression suite)
```

## Durable state

Without persistence the simulation lives in memory and is gone when the process stops. With `--data-dir` (and `DARKCIRCLE_STORE_PASSPHRASE`) the server keeps encrypted snapshots on disk:

- **What is saved:** both pools (trees, spent nullifiers, notes), the ledger, invoices **including the single-use payee private keys**, treasury notes with their blinding factors, the journals, the spend log, relayer settings. **Not saved:** the corporate spending key and the merchant master key; they are re-derived from configuration, and a snapshot records fingerprints of them so a restore under a different seed is refused (its notes would be unspendable).
- **How:** AES-256-GCM, key from the passphrase through scrypt (N = 2^17). One file per snapshot with a fresh random IV; AAD binds the store id, sequence number and timestamp. Writes are atomic (temp file, fsync, rename) and never overwrite; the newest five are kept.
- **Recovery** takes the newest snapshot that authenticates **and** passes coherence checks (Merkle root rebuilt from the leaves, every treasury note at its leaf, pool solvency, journal reconciliation, token supply equals the sum of balances). It restores into a fresh environment and only swaps it in if everything holds; a damaged newest snapshot falls back to the previous one and says so. A key, network or asset mismatch refuses to start rather than starting empty over someone else's store.
- **Autosave** runs a moment after every state-changing action; a failed save is shown in the top bar and never breaks the request that caused it.

The passphrase is used once to derive the key and is not kept or logged. If it is lost the snapshots cannot be read. Production needs it held in a KMS and off-host, encrypted backups (`AUDIT.md` O-3).

<!-- @admin:begin -->
## Admin console (development only)

`pnpm ui --admin` adds an **Admin** button that opens a console for the things the ordinary UI never touches: durable state, the relayer, and the pipeline that builds the circuit, verifier and pool contract. It has its own credential, an audit log of every action, and **is redacted before a production release** (`pnpm redact:admin`, then `--check`). Details, the security model and what each modal does are in [`docs/ADMIN_CONSOLE.md`](docs/ADMIN_CONSOLE.md). It never signs or broadcasts to a real network; deployment to Orchard or mainnet is a plan for a person to carry out.
<!-- @admin:end -->

## Trust modes

The pool and the payment gateway each run in one of two modes. **`verified`** (the default) checks the unshield statement and reads payment receipts. **`trusted-harness`** is the pre-audit behaviour, where components believe their callers; it exists only so the older adversarial suites keep exercising their scenarios, is never a safe configuration, and is reported as a failing blocker by the checklist and a red chip in the UI. `new ResourceServer()` now requires a gateway or an explicit `{ demo: true }`.

## Known limits

- The pools, relayer and ledger are simulations (see above). Gas is not metered except for the Quai revert-burn rule. WQUAI sweeps assume the relayer funds payee gas; that top-up flow is not modelled.
- The reference circuit and contract are unaudited, their trusted setup is a single-contributor development ceremony, compliance (PPOI, C8) is not enforced on chain, and their behaviour on Quai itself (zone-address deployment, access lists, gas, the pairing precompile) has not been exercised, only on a local EVM.
- Persistence saves the whole simulated environment, keys included, under a passphrase-derived key. It is not a KMS-backed production store.
- The `test/e2e/tier*.test.ts` suites exercise `test/e2e/harness.ts`, a self-contained reference implementation, not `src/`. End-to-end coverage of `src/` is in the unit and hardening suites.
- No Quai-specific sanctions list is bundled. The seed is Ethereum OFAC addresses, screened as bridge deposit origins; load your provider's list at startup.
- The voice agent understands English commands from a fixed grammar only. Microphone capture and the real Whisper model are exercised by hand, not by the test suite (which uses a worker that speaks the same protocol). On Orchard only QUAI balances and QUAI sends work: no WQUAI or WQI is registered there, so wrapping, token sends and paid services are refused with `ASSET_NOT_ON_NETWORK`.
- Orchard has no registered WQUAI/WQI deployment here; register one with `QuaiTokenRegistry.register` once you have verified it on chain.

## License

MIT License. Copyright (c) 2026 DarkCircle Enterprise Network.
