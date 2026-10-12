<p align="center">
  <img src="0.png" alt="DarkSafe logo" width="120" />
</p>

<h1 align="center">DarkSafe</h1>

<p align="center">
  Browser-based multi-signature vault dashboard for Quai Network's Cyprus-1 execution shard.
</p>

---

## Overview

**DarkSafe** is a Safe{Wallet}-style multi-signature dashboard for Quai Network. It unites:

- **On-chain multi-sig contracts (v2)** — `DarkSafeVault`: owners propose, approve and execute
  on chain, with a required expiry, a native timelock and no DELEGATECALL. Vaults are ERC-1967
  proxies created by `DarkSafeVaultFactory`.
- **A Quai Cyprus-1 core SDK** (`@darksafe/core`) — address validation, Quai JSON-RPC and the
  transaction pipeline, plus the v2 vault library. That library covers hashing, vault-address
  mining, calldata decoding, risk rules, authenticity checks, reads compared across sources, and
  transaction verification.
- **A live on-chain dashboard** — no seeded, hardcoded, or fabricated data anywhere. Every
  balance, owner list, threshold, and transaction queue is read from the chain or a real wallet
  extension; the UI shows an honest empty state until a vault is created or added.
- **Extension-only signing** — every transaction is sent through a connected Quai wallet
  (Pelagus, Blip). Approvals are on-chain transactions, so nothing is signed off chain, and no
  signer is bundled in the app.
- **Independent tools** — `darksafe-verify` (`packages/verify`) checks a vault or transaction
  outside the app. `darksafe-watch` (`packages/watcher`) alerts on governance changes,
  proposals, quorum and reorgs.

---

## Monorepo layout

Managed with **pnpm workspaces** and **Turborepo**:

```
multisigows/
├── 0.png                   # Brand logo
├── package.json            # Root Turborepo scripts
├── pnpm-workspace.yaml
├── turbo.json               # build → test/dev task pipeline
├── tsconfig.base.json        # Shared strict TypeScript config
├── packages/
│   ├── contracts/            # @darksafe/contracts — Hardhat, Solidity, Cyprus-1 deploy scripts
│   ├── core/                 # @darksafe/core — addresses, RPC, tx pipeline, v2 vault library
│   ├── ui/                   # @darksafe/ui — shared UI primitives & theme tokens
│   ├── verify/               # @darksafe/verify — darksafe-verify CLI (read-only)
│   └── watcher/              # @darksafe/watcher — darksafe-watch monitor
└── apps/
    └── web/                  # @darksafe/web — React 18 + Vite + Tailwind dashboard
```

---

## Vault creation

The "Create Vault" wizard (connect → owners → security → review) creates a vault through the
DarkSafe v2 factory. It:
1. mines a CREATE2 salt so the address lands in Cyprus-1 on the Quai ledger;
2. checks that address against the factory's own `predictWalletAddress`;
3. simulates the creation, sends it, and waits for confirmations;
4. requires the `WalletCreated` event to name the predicted address;
5. verifies the new vault on chain (code, implementation, factory registration, owners,
   threshold, timelock) before saving it.

"Add existing vault" accepts only vaults the verified factory created. The factory address comes
from `packages/contracts/deployments` via `pinned.ts`, or from `VITE_V2_FACTORY_ADDRESS`. It is
checked on chain against the pinned build before the app uses it.

Every propose, approve and execute goes through a review screen. The screen:
- decodes the call and lists risks;
- shows full addresses, exact amounts and raw calldata, and a typed confirmation for admin
  changes;
- re-derives the transaction hash from its stored contents;
- compares vault and transaction state across the app's RPC, an optional second RPC and the
  wallet's own node. A disagreement blocks every write.

---

## Security status

- **The vault contracts have not had an independent audit.** The app shows a beta banner, and
  mainnet vault creation is off unless a build sets `VITE_ALLOW_MAINNET_VAULTS=true`. The road
  to mainnet is gated step by step in `docs/LAUNCH.md`.
- **Security documents:**
  - `SECURITY.md` for reporting a vulnerability;
  - `docs/THREAT_MODEL.md`, covering threats, defences, evidence and residual risks;
  - `docs/SECURITY_GUIDE.md`, for owners;
  - `docs/INCIDENT_RUNBOOK.md`;
  - `docs/AUDIT_SCOPE.md`, the package for the independent audit.
- **v2 contracts** (`packages/contracts/contracts/v2`): on-chain approvals, required expiry,
  native timelock, epoch-invalidated approvals, no DELEGATECALL, no modules, no upgrade path.
  The app runs on v2 only (v1 was removed). v2 is not deployed yet, so until a factory is
  recorded or configured the app explains that vaults cannot be created or opened. Deploy with
  `pnpm -F @darksafe/contracts deploy:testnet` (simulates by default; `--sign-only`, or
  `--keystore <file> --broadcast` to send). Mainnet broadcasts also require `--mainnet-audited`.
- The app only treats an address as a vault if its code is the pinned proxy, it points at the
  pinned implementation, and the verified factory created it (`packages/core/src/pinned.ts`).
  Regenerate after any contract change with `pnpm -F @darksafe/contracts pin`; CI fails if it
  is stale.
- Security headers live in `apps/web/vercel.json` (mirrored in `nginx.conf.example`, and a
  test keeps them in sync).

Contract checks (see `packages/contracts/README.md`): Hardhat `test` (unit + stateful fuzz;
widen with `FUZZ_SEEDS=1,2,3 FUZZ_STEPS=300`); Foundry `forge:test` (fuzz + invariant campaign
on the shipped bytecode), `forge:diff` (the TypeScript core agrees with the contracts),
`forge:lint`, `forge:snapshot:check`; `opcode:check`; `coverage:check` (run it last: coverage
rewrites `artifacts/`); `pin:check`. Clone with `--recurse-submodules` (forge-std).

---

## Getting started

### Prerequisites
- Node.js >= 20 (24 recommended)
- pnpm >= 9 (10.29.3 recommended)

### Install
```bash
pnpm install
```

### Build
```bash
# Compiles contracts, builds all packages, then the web app
pnpm build
```

### Test
```bash
pnpm test
```

### Develop
```bash
# Compiles/builds workspace dependencies first, then starts the dashboard dev server
pnpm dev
```

To point the dashboard at a specific network or RPC endpoint, set at build/dev time in
`apps/web`:
```bash
VITE_QUAI_NETWORK=mainnet|testnet   # default: testnet (Orchard)
VITE_QUAI_RPC_URL=<override>        # default: the profile's canonical rpcUrl
VITE_V2_FACTORY_ADDRESS=0x00...     # optional: a factory to use instead of the recorded one (verified on chain)
VITE_QUAI_SECONDARY_RPC_URL=<url>   # optional: a second RPC to cross-check vault state against
```

---

## Quality bar

- **Strict TypeScript** across all packages (`strict`, `noImplicitAny`, `strictNullChecks`, …).
- **No hardcoded balances or demo state** — enforced in tests via `assertZeroHardcoding` /
  `FORBIDDEN_MOCK_BALANCE` in `@darksafe/core`.
- **No bundled signing keys** — every signature comes from a connected wallet extension.
