# DarkOrder · Grand Guild Halls

Guild governance for the DarkCircle suite, on **Quai Network (Cyprus-1)**. Found a guild in one
transaction, govern it by checkpointed token vote or council multisig, speak your intent to a
deterministic voice agent, and pay or charge **x402** tribute. Identity names point at
**QNS — quaidomains.com**, the suite's answer to ENS.

## Layout

```
apps/web                Vite + React + Tailwind site (the Grand Guild Halls)
packages/contracts      Solidity: Guild, GovernanceToken, MajorityVoting, CouncilMultisig,
                        GuildNameRegistry, GuildFactory, TokenStackDeployer (+ Hardhat tests)
packages/core           @darkorder/core: networks, Cyprus-1 addresses, RPC, the simulate-first
                        transaction pipeline, guild readers/encoders, x402 challenges,
                        the voice grammar + planner
scripts/integrity.mjs   static gate (required files, chain ids, legacy-name scan, bundle scan)
```

## Commands

```
pnpm install
pnpm build          # contracts compile, core + web type-check and build
pnpm test           # hardhat tests + vitest (core incl. a live-chain suite + web)
pnpm integrity      # static gate
pnpm dev            # the site on http://localhost:5300
pnpm rehearse:local # deploy to a local Hardhat node, found two halls, walk the steward
                    # paths (proposal-granted role, direct charter rewrite, tribute) and
                    # assert the readback; keeps the chain up for `pnpm dev:local`
                    # (--smoke runs the assertions and stops the chain)
```

**Against the rehearsal chain locally.** `pnpm rehearse:local` starts a Hardhat node on port
8646, deploys the protocol, founds `crimsonvigil` (token) and `ashencouncil` (council) with
structured charters, and writes `apps/web/.env.localchain.local`. Then `pnpm dev:local` serves
the site with the local network and a dev wallet in the network picker: account 0 is the
founder, 1 the steward the hall voted in, 2–3 council members. The dev wallet exists only in
that mode; `pnpm integrity` checks it is absent from production builds.

## Contract assurance

Foundry runs alongside Hardhat. Hardhat compiles the bytecode that ships; the Foundry suites
(`packages/contracts/test/foundry/`) deploy that exact bytecode from `artifacts/` and use
Foundry's own compile only for test helpers.

```
cd packages/contracts
pnpm exec hardhat compile   # artifacts first: the suites deploy them
forge test                  # 43 fuzz properties x 1000 runs + 3 invariant campaigns
forge test --profile deep   # long campaign: 20000-run fuzz, 1000x400 invariants
forge lint --deny warnings  # contract lint; by-design lints carry reasons in foundry.toml
pnpm lint:slither           # static analysis (needs slither on PATH; CI fails on medium+)
```

Slither's remaining findings are the informational/low trio a governance system has by design
(timestamp windows in minutes-to-days, the low-level call inside the all-or-nothing batch,
events emitted after settled state); CI fails the gate on medium or higher.

The fuzz suites pin the registry charset (the QNS rule), the permission wall, all-or-nothing
batch execution, exact treasury movements, the vote tallies, the threshold arithmetic against
an independent mirror (including the strict early-execution inequality at exact equality), and
the founding rite leaving the factory with no role. The invariant campaigns drive random
sequences of grants, tributes, proposals, votes, approvals, executions and time warps, and
assert treasury accounting, tally integrity against ghost tallies, quorum at execution, and
the membership wall. `script/AnvilSmoke.s.sol` deploys the whole protocol to a live anvil
node and founds both hall modes as the EVM-level dry run of the Quai deploy.

## The protocol

- **Guild** — the treasury and the permissions. Everything it does goes through `execute`,
  which only a holder of `EXECUTE_ROLE` may call. `payTribute(invoiceId)` receives native QUAI
  and emits `TributeReceived` — the on-chain x402 receipt.
- **GovernanceToken** — ERC-20 + Votes checkpoints. The guild owns it, so minting is a
  governance act. Balances count only once delegated.
- **MajorityVoting** — token-hall module. Thresholds are snapshotted per proposal; one vote per
  address; early execution when yes beats the whole supply.
- **CouncilMultisig** — council-hall module. Fixed members, N-of-M approvals, approval can
  carry try-execution.
- **GuildFactory + GuildNameRegistry** — the Founding Rite: one transaction deploys and wires
  everything, mints the founder's power, registers the handle, and leaves the factory with
  nothing. **TokenStackDeployer** exists because EIP-170 caps bytecode at 24 KiB: the token
  stack deploys from its own contract so both stay under the cap.

## Guild profiles and the steward's desk

A guild's on-chain `metadata` string is its charter. Plain text is valid and reads as the
description; the structured form is a one-line marker plus JSON
(`darkorder:profile:1\n{"description","avatar","links"}`) — schema and limits live in
`packages/core/src/profile.ts`. Crests are raster data URIs (PNG/JPEG/GIF/WebP, ≤ 24 KB so
they fit one transaction) or https/ipfs pointers; link URLs are https/ipfs only, so the hall
page never renders a `javascript:` payload. The frontpage directory cards show the crest,
charter text, links and treasury — never raw hex.

Each hall page carries the steward's desk: a connected key holding `SET_METADATA_ROLE` rewrites
the charter directly, a key holding `ROOT_ROLE` grants and revokes roles, and anyone can route
either change through a proposal instead — the proposal executes as the guild itself, which
holds every permission. The War Room decodes `setMetadata` / `grant` / `revoke` proposal
actions into plain language before a vote.

## Quai specifics (learned on Cyprus-1)

- Contract calls only work on a zone endpoint; everything here is Cyprus-1 (`0x00…`, second
  byte below `0x80`). The address rule is enforced in `packages/core/src/address.ts`.
- A reverted transaction burns its whole gas limit, so every transaction is simulated
  (`quai_call`), gas-estimated, and access-listed before the wallet is asked to sign
  (`packages/core/src/tx.ts`).
- Deploys grind a CREATE salt until the predicted address lands in-zone. Deploy with
  `packages/contracts/scripts/deploy-quai.mjs` — it signs from an encrypted keystore only and
  verifies code hashes on chain before writing `packages/core/src/deployments.ts`.
- Hardhat cannot build Quai transactions; the Hardhat network here is for tests only.

## Voice agent

`packages/core/src/voice` is a grammar, not a language model: a closed intent list, the same
answer every time, offline. Hard rules: voice never carries an address (checked before
tokenization, which would shred hex), it never sends payments to spoken names, and tribute
always names its asset. Planned actions get a spoken 3-digit confirmation code with a 3-minute
TTL. The web page asks before opening the microphone (cloud transcription), and the typed
command line is always first-class.

The steward's desk is voice-reachable too: "open the steward's desk", "edit the charter" or
"grant metadata power to …" all walk to the desk of the current hall — crest, charter and the
target address are typed or uploaded there, never spoken — and "what roles does my key hold"
reads the connected key's powers from the chain and speaks them.

## x402

`packages/core/src/x402/challenge.ts` parses DarkCircle-compatible challenges (RFC 7807 body →
`WWW-Authenticate` → `X-Payment-*`) and adds the native `quai_native_tribute` scheme: the
recipient is the guild contract and the body carries `payTribute(invoiceId)` calldata, so paying
the invoice writes the invoice id into the guild's event log. Token decimals are validated
against the known-token registry (`tokens.ts`); a challenge that misstates them is rejected.

## Status

Neither mainnet nor Orchard has a deployment yet (`deployments.ts` is null on both), so the
site runs as a **showcase**: sample guilds, clearly labelled, every transaction switched off.
