# Admin console (development only)

This document, `src/admin/`, `ui/admin/`, `test/admin/` and every block fenced with `@admin:begin` /
`@admin:end` are **removed before a production release**. Nothing in the shielded-pool, gateway, checklist
or persistence code depends on them.

The console is where an operator turns on things the ordinary UI never touches: durable state, the relayer,
the pipeline that builds the circuit, verifier and pool contract, and a wallet-signed deployment of those
contracts. The server **never holds a key, signs or broadcasts**: the operator's own wallet (Pelagus or Blip)
signs every deployment in its own confirmation screen, and the server only builds, simulates and verifies.

## Turning it on

```bash
pnpm ui --admin                       # the token is printed once, on this terminal
DARKCIRCLE_ADMIN_TOKEN='24+ characters' pnpm ui --admin      # or supply your own
```

Without `--admin` (or `DARKCIRCLE_ADMIN=1`) the routes, the button and the assets do not exist: `/api/admin/*`
answers 404 like any unknown path, the page never requests the console's script, and nothing about it is in
the served HTML. A configured token shorter than 24 characters is refused at start-up.

Click **Admin** in the top bar and sign in with the token.

## Security model

| Concern | What the console does |
|---|---|
| Who may use it | Whoever holds the admin token. It is separate from the page's per-process session token, which anyone who loads the page has. |
| The token | Generated at start (or from `DARKCIRCLE_ADMIN_TOKEN`), printed only on the server's terminal, compared in constant time, never sent to a page, header or response, never written to the audit log. |
| Sessions | A random 256-bit id kept in server memory and in the tab's JavaScript memory only (no cookie, no `localStorage`, no URL): closing the tab ends it. 30 minutes idle, 8 hours absolute, at most 8 at once. Sent as `X-DarkCircle-Admin`. |
| Brute force | Five failures lock sign-in; the lockout doubles each time (1 min up to 15 min). The right token is refused during a lockout, so a lockout cannot be probed for the answer. |
| The API's own rules | Every admin route also needs the ordinary session token, loopback `Host`, same-origin `Origin`, JSON bodies, the 64 KiB cap and the strict CSP. A cross-site page cannot even attempt a login. |
| Destructive actions | Restore needs `RESTORE`; deleting the store needs `WIPE <store id>`; forgetting a recorded deployment needs `FORGET <address>`; mainnet calldata needs the risk gates acknowledged. All are checked **on the server**, not just by the button. |
| Accountability | Every action, allowed or refused, is appended to a hash-chained log (`.darkcircle-admin/audit.log`). Editing or deleting a line breaks the chain from that point and the console says where. Details are scrubbed of anything shaped like a key or passphrase before they are written. |
| Secrets in transit | The store passphrase is sent once to enable persistence and is not retained. The self-test's witness (which contains the simulation's spending key) goes to its child process over stdin, never to disk. |

## What each part does

**Overview.** Persistence state, relayer state and gas, whether the audit chain is intact, and the state of
every pipeline stage.

**Environment.** What is actually installed (Node, pnpm, circom2, circomlib, snarkjs, circomlibjs, solc, the
local EVM, the source files, writable directories), read from disk, with what the pipeline can therefore do.

**Persistence.** Enables encrypted snapshots (see the README's *Durable state*): directory, passphrase, then
save now, verify the running state (12 coherence checks), scan the store (authenticates every snapshot and says
which recovery would use), restore a chosen snapshot, disable (keeps the files), or delete the store. Enabling
over a directory that already holds snapshots asks whether to restore the newest or keep the running state.

**Relayer.** Per pool: take it offline with a reason, bring it back, set the fee floor and the low-gas alert.
While a relayer is offline, payments and sweeps for that pool refuse before anything is attempted (checklist
item `SP-EX-04`) and a settled invoice stays `SETTLED` with its funds on the payee address. This is the
simulated relayer; a production relayer does not exist (`AUDIT.md` O-2).

**Circuits & contracts.** Six stages, each in its own child process, with live output and a manifest of
SHA-256 hashes (`build/manifest.json`):

| Stage | Does | Notes |
|---|---|---|
| `circuit.compile` | circom compiles `circuits/unshield.circom` to an r1cs and a WASM witness generator | 17,568 constraints, 9 public inputs |
| `circuit.setup` | powers of tau (2^15, cached in `build/ptau`) and a Groth16 setup, then checks the proving key against the circuit and the ceremony | first run about 6 minutes, then under a minute. **Development ceremony: one contributor.** |
| `verifier.export` | renders `Groth16Verifier.sol` from the proving key | |
| `contracts.compile` | solc 0.8.37 (pinned; evm `paris`, optimizer 200) for the pool, dev token and verifier; Poseidon hashers from circomlibjs, whose runtime code is derived by running their creation code in a local EVM; records a **runtime** hash for every contract and, for the pool, where its four immutables sit | |
| `circuit.selftest` | proves an unshield of a **real note from the live simulated pool**, verifies it, requires every public signal to equal what the simulation derives, and requires a tampered signal, a wrong spending key and an **aliased key** (key + L: same note, second nullifier) to be rejected | reads, never spends |
| `evm.local` | deploys hashers, verifier, dev token and pool into an in-process EVM and runs a shield and two proven unshields (the second spends the change note) with real proofs, then tries to break it: tampered calls, the aliased key, the pool's own guards, a dependency without code, and a byte-for-byte comparison of every deployed contract with what the on-chain check expects | 17 on-chain checks |

A stage can only run when the stages it needs are current. A stage is **stale** when a file it was built from
changed afterwards (edit `circuits/unshield.circom` and everything downstream says so), **failed** when its
last run failed, and a stage that is cancelled leaves its previous record untouched.

**Deploy plan.** *Local EVM* is real execution of the exact bytecode on a local chain. *Orchard* and
*mainnet* produce a **plan**: the ordered steps, the bytecode hashes to expect, the token addresses each pool
binds to, what an operator must do, and every gate with its verdict. `broadcast` is always `false`.

| Gate | Orchard | Mainnet |
|---|---|---|
| G-01 to G-04: built, compiled, self-test passed, local EVM passed | blocks | blocks |
| G-05 the trusted setup is production-grade | warns | **blocks** |
| G-06 an independent audit exists | warns | **blocks** |
| G-07 compliance (C8) is enforced on chain | warns | **blocks** |
| G-08 a production relayer exists | warns | **blocks** |
| G-09 WQUAI and WQI are registered for the network | blocks | blocks |

Today G-05 to G-08 cannot pass inside this repository, so a mainnet plan is always blocked, and an Orchard
plan is blocked by G-09 until a verified WQUAI/WQI deployment is registered there.

**Audit log.** The action log described above.

## Deploying to a real network (wallet-signed)

Under the plan, **Connect your wallet** starts a deployment that the operator's own wallet signs. The server
never sees a key and never sends a transaction; every step below is enforced on the server, not just in the
page.

1. **Preflight** checks the zone endpoint, that the deployer is a Cyprus-1 Quai-ledger account and not a
   contract, prices every step it can already build from a live simulation (the pool stays size-based until
   its dependencies are recorded), and checks that the balance covers the expected cost and the largest
   single step's whole gas limit (a node only accepts a transaction whose sender can pay its full limit). On **mainnet** the request must
   acknowledge gates G-05 to G-08 by name first (`MAINNET_RISK_NOT_ACKNOWLEDGED` otherwise).
2. **Prepare**, per contract, right before the wallet opens: the server rebuilds the creation calldata and
   **simulates it on the zone** (`quai_createAccessList`, then `quai_estimateGas` with that list). A step the node
   says would revert is refused. The access list goes to the wallet: the pool's constructor calls its hasher,
   and on Quai a multi-contract transaction without a list reverts and burns its whole gas limit. The gas limit
   is the larger of 1,250 gas per runtime byte and **3x the live estimate** (creation has been charged about
   2.5x the estimate on Cyprus-1), capped below the block gas limit; a step whose cap leaves less than 2.5x is
   refused rather than sent to run out of gas.
3. The page re-reads the wallet's **network and selected account** immediately before asking it to sign, and
   refuses if either changed since preflight (every Quai zone shares a chain id, so only the account shows a
   zone switch).
4. **Receipt**: the address is read off the receipt, never predicted. Before anything is recorded the server
   checks that the receipt is a successful contract creation sent by the claimed deployer, that the address is
   in the right zone and ledger, and that the deployed code hashes to **exactly** what the build predicts. For
   the pool that is the compiled code with its immutables (token, verifier, hashers) filled in from the
   recorded dependencies, so the check also proves what the pool is bound to. Which contract a step deploys
   follows from its key alone.
5. **Verify bindings** reads the pool's token, verifier, hashers and empty-tree root back from the chain.

Deploy order: PoseidonT3, PoseidonT5, Groth16Verifier, then one DarkCirclePool per asset. At the gas price of
2026-09-23 (about 35,000 gwei) the whole set, both pools included, is expected to cost roughly 1,300 to 1,650
QUAI, most of it the two circomlibjs hashers; preflight and each prepare step show the live figure. What a local EVM cannot show, and nothing here has yet exercised on Quai: the zone's
pairing precompile and real creation gas (`AUDIT.md` O-17). The mainnet gates G-05 to G-08 still describe
real, unmet risks; acknowledging them does not remove them.

## Redacting before release

```bash
pnpm redact:admin --dry-run          # list what would be deleted and edited
pnpm redact:admin --root ../copy --yes    # try it on a copy first
pnpm redact:admin --yes              # in place; deletes files, not undoable (this tree is not under git)
pnpm redact:admin --check            # exit 1 if any trace remains (use --keep-tool to keep the script)
```

It deletes `src/admin`, `ui/admin`, `test/admin` and this file, strips every fenced block from the API
server, the UI shell, the start-up script, the README and `AUDIT.md`, removes the admin scripts from
`package.json`, and deletes itself unless `--keep-tool` is given. `test/admin/redaction.test.ts` redacts a
temporary copy of the tree, type-checks it, runs suites against it and asserts that no trace remains,
including in the documentation.

What **stays** after redaction, because production needs it: the persistence layer, the relayer's off switch
and gas alert with checklist item `SP-EX-04`, the shared spend tracker, the dark/light UI, and the source of
`circuits/` and `contracts/` (so a release can be built and audited reproducibly). The tooling that compiles
them and runs the ceremony is development tooling and goes with the console; a release builds and deploys
them through its own controlled process.
