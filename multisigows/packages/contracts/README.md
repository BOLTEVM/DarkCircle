# @darksafe/contracts

DarkSafe v2 multi-signature vault contracts for Quai Network's Cyprus-1 zone. Not deployed
yet, and not independently audited.

## Contracts (`contracts/v2`)

- **DarkSafeVault**: an owner proposes a transaction (and thereby approves it), other owners
  approve on chain, and once quorum is reached and the timelock has passed, any owner executes
  it. Every transaction carries a required expiry. Removing an owner invalidates their
  approvals for good. A failed external call is final only when it was given its full committed
  gas, so an executor cannot burn an approved transaction by under-gassing it. There is no
  DELEGATECALL, no modules, no upgrade path and no admin key.
- **DarkSafeVaultProxy**: an ERC-1967 proxy with its own `receive()`, initialised in the same
  transaction that creates it. Every vault has identical runtime code, so clients recognise a
  genuine vault by its code hash.
- **DarkSafeVaultFactory**: CREATE2 factory with the creator folded into the salt, so nobody
  can take a salt someone else mined. `isWallet` is true only for vaults it created.
- **AgentPermitBatcher**: redeems a batch of off-chain ERC-2612 permits from independent agents
  and sweeps every authorized amount into one immutable, constructor-fixed vault in a single
  call. Only that vault may call it; one entry's bad signature, expired deadline, or insufficient
  balance fails only that entry (see the per-entry isolation tests in
  `test/foundry/AgentPermitBatcher.t.sol`). Not wired into any deployment script yet — it is
  `new`'d per vault when a sweep is actually needed.
- **AgentPermit2Batcher**: the same design as AgentPermitBatcher, but for tokens that don't
  implement ERC-2612 (most real Quai assets — WQUAI, USDT) via Uniswap Permit2's
  `SignatureTransfer` instead. Its `IPermit2SignatureTransfer` interface is transcribed from
  Permit2's public spec, not vendored source (none exists in this workspace) — see the
  contract's doc comment. `test/MockPermit2.sol` is a from-spec test double that proves the SDK's
  digest (`packages/core/src/vault/permit2.ts`) and this contract agree with each other; it does
  not prove agreement with the real deployed Permit2. Verify against Permit2's actual ABI before
  this is relied on for real funds.

Compiler: solc 0.8.24, optimizer 200 runs, `evmVersion: paris`. `opcode:check` proves there is
no PUSH0/TLOAD/TSTORE/MCOPY, and no DELEGATECALL/CALLCODE/SELFDESTRUCT in the vault.

## Two toolchains, one bytecode

Hardhat compiles the bytecode that is pinned (`packages/core/src/pinned.ts`) and deployed.
Foundry tests that same bytecode: `test/foundry/Base.sol` deploys it from `artifacts/`, and uses
Foundry's own compile only for ABIs and test helpers. So compile with Hardhat first.

```bash
pnpm compile                # hardhat compile + typechain
pnpm test                   # Hardhat: unit tests + stateful differential fuzz (JS model)
pnpm forge:test             # Foundry: fuzz (1,000 runs each) + invariant campaign
pnpm forge:diff             # Foundry <-> TypeScript agreement (build packages/core first)
pnpm forge:deep             # long campaign: 20k fuzz runs, 1,000 x 400 invariant calls
pnpm forge:lint             # forge lint, warnings are errors
pnpm forge:snapshot:check   # gas of key operations unchanged (.gas-snapshot)
pnpm opcode:check           # bytecode gate
pnpm coverage:check         # run last: it rewrites artifacts/ (recompile with --force after)
pnpm pin / pin:check        # regenerate / verify packages/core/src/pinned.ts
pnpm slither                # static analysis (needs slither on PATH; see below)
```

### Static analysis (Slither)

`slither.config.json` excludes `pragma`/`solc-version`/`naming-convention` (noise that fires on
OpenZeppelin's own files the moment anything imports them, not on this code) and anything under
`node_modules`/`lib/forge-std`. Every other finding is either fixed or suppressed at the exact
line with `// slither-disable-next-line <detector>` and a comment explaining why, the same
convention `forge:lint` already uses for `// forge-lint: disable-next-line(...)`. Where both
tools suppress the same statement, put `slither-disable-next-line` last, immediately above the
code, and use forge-lint's `disable-next-item` (not `disable-next-line`) above that — forge-lint's
`disable-next-line` only looks at the literal next line, so a `disable-next-line` sitting above
another comment silently suppresses nothing and fails `--report-unused-suppressions` instead.

Slither is a Python tool (`pip install slither-analyzer`), not an npm dependency, so `pnpm slither`
only works where it's on `PATH`. It runs against Foundry's build (both toolchains are configured
here); run `pnpm compile` first so Hardhat's artifacts are current too.

`lib/forge-std` is a git submodule (v1.16.2): clone with `--recurse-submodules`, or run
`git submodule update --init`.

### What the Foundry suites prove

- **Invariants** (`test/foundry/invariant`): a handler drives random proposals, approvals,
  revocations, cancellations, expiries, owner and threshold changes, deposits, time jumps and
  executions, some deliberately starved of gas. It records every execute and checks it
  against the rules at that moment: quorum of current owners, timelock elapsed, not expired,
  executor is an owner. Invariants: governance bounds, approvals only from current owners,
  `approvedAt` never changes once set, terminal states consistent with `status()`, exact
  balance accounting, and every transaction hash re-derivable from its stored fields and list
  position, which is what the app's verifier relies on.
- **Gas griefing**: for any gas an executor supplies, either the callee receives its full
  committed gas, or the execute reverts and the transaction stays approved. A recorded
  failure is only accepted if the callee also fails when called directly with exactly its
  committed gas. `test_gasBoundaryForwardsFullCommittedGas` finds the minimum gas at which an
  execute succeeds and shows the callee still gets everything at that point.
- **Factory**: prediction equals creation for any creator, salt and parameters; salts are
  bound to their creator; proxies deployed outside the factory are never `isWallet`.
- **Differential** (`test/foundry-differential`, via `scripts/ffi/core-oracle.mjs`): the
  TypeScript library the app ships agrees with the contracts on transaction hashes, vault
  address prediction and salt mining, the factory authenticity mask, and calldata decoding.
  That includes refusing to decode admin calldata with dirty padding, which the vault also
  refuses to execute.

Gas figures use Ethereum's schedule. Quai prices storage by state size, so on-chain gas limits
come from `packages/core/src/tx.ts`, never from `.gas-snapshot`.

## Deployment

```bash
pnpm keystore:new --out ~/keys/deployer.keystore.json   # new encrypted Cyprus-1 key; prints the address
pnpm deploy:testnet --from 0x00...                      # simulate (default); prints the worst-case cost
pnpm deploy:testnet --sign-only                         # sign with a throwaway key, send nothing
pnpm deploy:testnet --keystore key.json --broadcast     # deploy to Orchard
pnpm verification:export --network orchard              # standard-JSON inputs for explorer source verification
```

The key only ever comes from an encrypted keystore. A broadcast writes
`deployments/v2-<network>.json` and regenerates `pinned.ts` from it; review and commit both.
Mainnet broadcasts also need `--mainnet-audited <tag>`, and are refused unless:
- HEAD is that tag;
- the contracts and pins have no uncommitted changes;
- the artifacts match the pins.

## Soak test

`scripts/soak-v2.mjs` runs the whole lifecycle through the app's own transaction pipeline:
- create a vault and fund it;
- propose, approve, wait out the timelock, execute;
- check that a starved execute reverts;
- revoke, cancel, expire;
- threshold, owner and timelock changes, including the stale-approval check;
- cancel by consensus;
- the watcher and `darksafe-verify`.

After each step it asserts the vault's state and records estimated, limit and used gas.

```bash
pnpm local-chain &                                      # anvil run as Orchard behind a quai_* proxy
pnpm soak:local                                         # CI runs this on every push
pnpm soak:testnet --owners a.keystore.json,b.keystore.json,c.keystore.json   # Orchard; --resume after an interruption
```

Live-network reports (`deployments/soak-<network>-*.json`) are the evidence for the launch gates
in `docs/LAUNCH.md`; commit them.
