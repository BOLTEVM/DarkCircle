# DarkSafe v2 audit package

Everything an independent auditor needs. Mainnet is gated on this audit closing:
- `VITE_ALLOW_MAINNET_VAULTS` stays off;
- `deploy-v2.mjs` refuses mainnet unless HEAD is the audited git tag and the tree matches it.

## Commit under review

Freeze a commit, tag it and push the tag:
```bash
git tag -a v2.0.0-rc.1 -m "DarkSafe v2 audit candidate"
git push origin v2.0.0-rc.1
```
Everything below refers to that tag. Findings get fixed on follow-up commits, which are reviewed
as a diff against the tag. The final audited commit gets its own tag, `v2.0.0`; that is the
value `--mainnet-audited` takes.

## Scope

| Part | Files | Lines |
|---|---|---|
| **Contracts (primary)** | `packages/contracts/contracts/v2/DarkSafeVault.sol`, `DarkSafeVaultProxy.sol`, `DarkSafeVaultFactory.sol` | ~690 |
| Pre-signing verification | `packages/core/src/vault/*` (hash, decode, risk, reader, authenticity, multisource, verifier, clock, actions, create2), `packages/core/src/tx.ts`, `packages/core/src/pinned.ts` | ~2,150 |
| Signing flows | `apps/web/src/components/modals/TransactionReviewModal.tsx`, `CreateVaultModal.tsx`, `apps/web/src/context/SafeContext.tsx`, `WalletContext.tsx`, `apps/web/src/lib/drafts.ts`, `apps/web/vercel.json` | ~1,850 |
| Tools | `packages/verify/src`, `packages/watcher/src` | ~670 |
| Deployment | `packages/contracts/scripts/deploy-v2.mjs`, `pin-bytecode.js`, `check-opcodes.js` | — |

Out of scope:
- OpenZeppelin 5.2.0 (used: `ERC1967Proxy`, `ERC1967Utils`, `ReentrancyGuard`);
- test contracts under `contracts/test`;
- the dashboard's price oracle and market views;
- the UI kit;
- Quai node software and wallet extensions.

Also out of scope: any contract not listed above that appears in `contracts/`, for example work
in progress on permit batchers.

## Architecture in brief

- **Lifecycle.** Owners propose (which also approves), approve, and execute on chain.
  Transactions are identified by
  `keccak256(abi.encode(vault, chainid, to, value, keccak256(data), gasLimit, expiration, delay, nonce))`,
  where `nonce` is the transaction's position in the vault's append-only list.
- **Expiry and timelock.**
  - Expiry is required, and must fall within 30 days after the timelock ends.
  - The timelock is `max(vault floor, requested)`, is fixed per transaction, and starts once, when
    quorum is first reached (`approvedAt`).
  - Admin changes are self-calls to a fixed set of five selectors, with no value and no timelock.
    If one fails, the whole execute reverts.
- **External calls.** The vault requires `gasLimit·64/63 + 100k` gas before the call, and marks
  the transaction executed first. A failed call is final only when the callee was given its full
  committed gas.
- **Vaults and the factory.**
  - Vaults are ERC-1967 proxies with their own `receive()`, initialised in the proxy constructor.
    They are not upgradeable, and the vault has no DELEGATECALL.
  - The factory creates vaults with CREATE2, folding `msg.sender` into the salt. Only vaults it
    created are `isWallet`.
- **Quai specifics.**
  - Addresses must start `0x00` (Cyprus-1), with the Qi-ledger bit clear.
  - A reverted transaction is charged its whole gas limit.
  - Contract calls carry an access list.
  - Storage gas scales with state size.
  - Everything is compiled for `paris`.

## Invariants and where they are tested

| ID | Invariant | Tests |
|---|---|---|
| I1 | No DELEGATECALL, CALLCODE or SELFDESTRUCT; no modules | `scripts/check-opcodes.js`; the bytecode test in `test/v2/DarkSafeVault.test.ts` |
| I2 | An external call runs only with a quorum of currently valid approvals, the timelock elapsed and before expiry; the caller is an owner | Foundry `invariant_noUnsafeExecution`; Hardhat unit tests; the stateful JS-model fuzz |
| I3 | `approvedAt` is set once and never cleared | `invariant_approvedAtNeverChanges`; the revoke tests |
| I4 | A removed owner's approvals never count again, even after re-adding | `invariant_approvalsOnlyFromCurrentOwners`, `testFuzz_removedOwnersApprovalsNeverCountAgain`, soak step `admin-and-epochs` |
| I5 | Self-calls are limited to 5 admin selectors, run immediately, and revert on failure | `testFuzz_selfCallsAreRestrictedToAdminSelectors`; `invariant_terminalStatesConsistent` |
| I6 | Gas: a failure is final only with the full committed gas; otherwise the execute reverts | `testFuzz_starvedExecuteNeverBurnsTheTransaction`, `test_gasBoundaryForwardsFullCommittedGas`; the soak's starved simulation |
| I7 | The proposer can cancel only before `approvedAt`; after that, only cancel-by-consensus | Handler checks; the cancel tests |
| I8 | Expiry is required, later than now + delay, and at most 30 days after that | `testFuzz_expiryWindowIsEnforced` |
| I9 | 1 ≤ threshold ≤ owners ≤ 20; owners are unique, non-zero, not the sentinel, not the vault, and start `0x00` | `invariant_governanceBounds`; factory fuzz |
| I10 | `nonReentrant`; `executed` is set before the call | `ReentrantAttacker` test |
| I11 | Timelock ≤ 30 days at creation and on change | Unit tests; handler (proposes 31 days) |
| I12 | Enumeration views are complete, and every hash re-derives from its stored fields and position | `invariant_everyHashRederivesFromStoredFields` |
| I13 | No upgrade, admin or pause key | `test_proxyHasNoUpgradeOrReinitialisePath` |
| I14 | The factory pins `implementation` and `proxyCodeHash`; only `createWallet` sets `isWallet` | `test_isWalletOnlyForFactoryCreatedVaults`; `testFuzz_predictionMatchesCreation` |

The TypeScript library the app ships is checked against the contracts by
`test/foundry-differential/CoreDifferential.t.sol`. It covers:
- hashes;
- address prediction and salt mining;
- the factory authenticity mask;
- calldata decoding;
- draft validation;
- "the vault will reject this" predictions.

## Reproducing everything

```bash
git clone --recurse-submodules https://github.com/BOLTEVM/DarkCircle && cd DarkCircle/multisigows
git checkout v2.0.0-rc.1
pnpm install --frozen-lockfile --ignore-scripts
pnpm build                                      # compiles contracts (the pinned bytecode) and all packages
pnpm -F @darksafe/contracts pin:check          # pinned.ts matches the artifacts
pnpm -F @darksafe/contracts test               # Hardhat: unit, stateful fuzz, core/verify/watcher integration
pnpm -F @darksafe/contracts forge:test         # Foundry fuzz + invariants on the shipped bytecode
pnpm -F @darksafe/contracts forge:diff         # TypeScript <-> Solidity agreement (ffi)
pnpm -F @darksafe/contracts forge:deep         # long campaign (20k fuzz runs, 1000 x 400 invariant calls)
pnpm -F @darksafe/contracts opcode:check
pnpm -F @darksafe/contracts coverage:check     # run last: rewrites artifacts/
pnpm test                                       # every package's unit tests
```

End to end against a local chain run as Orchard:
```bash
pnpm -F @darksafe/contracts local-chain        # anvil + quai proxy, deploys v2, seeds a vault
pnpm -F @darksafe/contracts soak:local         # full lifecycle through the app's own pipeline
```

## Known issues and accepted findings

- **Foundry lint findings that are accepted, each suppressed inline with its reason:**
  - events emitted after the external call: the outcome is only known then;
  - reverting inside the owner-validation loop: the whole set is rejected;
  - the factory's zero check: covered by the code-length check;
  - `encodePacked` on the CREATE2 init code;
  - `uint64(block.timestamp)` casts.

  `block-timestamp` is excluded project-wide.
- **Admin changes skip the timelock by design,** so owners can react quickly. A compromised
  quorum can therefore act immediately.
- **The contract checks the Cyprus-1 zone byte of owners but not the Qi-ledger bit.** The client
  enforces it.
- **The gas margins are proven with Ethereum's gas costs.** Quai's storage pricing differs; see
  the Orchard soak report in `packages/contracts/deployments/soak-orchard-*.json`.
- **Plain transfers into a vault need more than 21,000 gas,** because `receive()` emits an event.
- **No independent review has happened yet.** The findings and fixes so far are recorded in the
  git history and in `docs/THREAT_MODEL.md`.

## Questions for the auditor

1. Is `gasLimit·64/63 + 40k + 60k` a sufficient margin, given that Quai storage costs scale with
   state size? The CALL itself costs up to about 36.6k (value transfer to a fresh account).
2. Can anything other than the vault's own admin selectors reach `onlySelf` functions, including
   through the proxy's fallback?
3. Are there call patterns where marking `executed` before the gas check changes observable
   behaviour, beyond the revert?
4. Does the client's verification (`verifyVaultTransaction`, `assertVaultAuthentic`,
   `verifyFactory`) fail closed in every case that matters? Could a malicious RPC make it accept
   a non-genuine vault or transaction?
5. Is the CREATE2 salt binding (creator folded into the salt) enough against front-running a
   vault creation?
