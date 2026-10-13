<div align="center">

<img src="apps/web/public/0.png" alt="" width="120" />

# Dark Questate

**A real estate brokerage on Quai Network.** Title-verified properties as EIP-6065 deeds, listings through licensed brokers, offers held in escrow on Cyprus-1, and closings that move the deed and the money in one transaction.

<br />

![Quai Network](https://img.shields.io/badge/Quai-Cyprus--1_%C2%B7_chain_9-ff3b30?style=for-the-badge&labelColor=0a0e16)
![Status](https://img.shields.io/badge/status-pre--release-f59e0b?style=for-the-badge&labelColor=0a0e16)
![Audit](https://img.shields.io/badge/audit-none_yet-9ca3af?style=for-the-badge&labelColor=0a0e16)

</div>

---

## Where it stands

| | |
|---|---|
| **Contracts** | `QuestateDeed` (EIP-6065 registry) and `QuestateBrokerage` (listings, offers, escrow, commissions). 36 Hardhat tests. **Not deployed** on Orchard or mainnet. **No independent audit.** |
| **Site** | Reads Cyprus-1 directly and signs only through the visitor's own Pelagus or Blip wallet. With no deployment on the selected network it runs as a **showcase**: invented sample listings, labelled as such on every card and page, with every transaction switched off. |
| **Verified end to end** | On a local Hardhat chain, through the real UI: offer → accept → withdraw proceeds → relist (approve + list) → registrar mint from an intake file → duplicate mint refused before sending. Same paths are covered by an automated end-to-end test over JSON-RPC. |

> Treat everything here as pre-release. Do not point it at funds or titles you cannot afford to lose.

---

## How a sale works

1. **Title verified.** The owner prepares a deed request on the Sell page. It validates the parcel boundary (RFC 7946), hashes the operating agreement (keccak256; the text never leaves the page) and builds the metadata document with its real IPFS CIDv0. The registrar checks the recorded deed and identity off chain, loads the file in the Registrar console and mints.
2. **Listed with a broker.** The holder lists through a registered broker. The desk takes custody of the deed while it is listed, and the broker's commission (at most 10%) is fixed at listing time.
3. **Offers in escrow.** Buyers pay the asking price or make an offer. An offer is a deposit the buyer can withdraw at any time until the seller accepts it, also while the desk is paused and after the listing ends.
4. **Closing in one transaction.** Acceptance sends the deed to the buyer and credits the seller and broker, who withdraw their proceeds themselves. A buyer fixes the largest lien they accept: if the registrar records a larger one, or forecloses, before closing, the closing fails and the deposit stays withdrawable.

### Who can do what

| Role | Can | Cannot |
|---|---|---|
| Registrar (owner of `QuestateDeed`) | Mint deeds, record a lien or credit, foreclose | Move anyone's deed, touch any coin |
| Operator (owner of `QuestateBrokerage`) | Register or deactivate brokers, pause new business, cancel a listing (the deed goes back to its seller) | Reach offer deposits, credited proceeds or listed deeds |
| Deed holder | List, reprice, cancel, accept offers, appoint a property manager | Change the debt record (in b6 the holder could clear their own lien) |
| Buyer | Buy, offer, withdraw an unaccepted offer at any time | Be charged a lien above the one they accepted |

---

## What changed from b6

The folder used to hold "B6", an EIP-6065 tokenization demo. Dark Questate keeps its good ideas (EIP-6065 deeds, GeoJSON parcels, the 2D/3D parcel views) and replaces the rest:

- **The UI was a simulation presented as live.** Seeded parcels lived in React state, "minting" produced `Math.random()` token ids and transaction hashes, escrow showed "Funded and Settled!" without a transaction, and the header said `LIVE`. Every number on the new site comes from the chain, or is a sample and says so.
- **The signer was a random in-browser key** with three hard-coded "accounts". One of them, `0x003B4b96…eEef8`, is the Q0/WQUAI Quaiswap pool, shown as "Cyprus-1 Primary Admin". The site now signs only through Pelagus/Blip and never holds a key.
- **IPFS pinning printed a made-up CID** and uploaded nothing. Metadata now gets its real CIDv0 (checked against `ipfs add --only-hash` vectors), and nothing claims it was uploaded.
- **Contract flaws:** the holder (or a manager they appointed) could erase their own lien; a buyer's escrow deposit could be stranded with no refund path if the seller walked away or moved the deed; the vault paid out non-cash "NAV" from depositors' cash and never held the property; `payPropertyDebt` locked payments in the wrapper. The fractional vault was removed rather than patched.
- **Quai facts:** Cyprus-1 mainnet was configured as chain 15000 (that is Orchard; mainnet is 9), and deployment went through Hardhat, which cannot build Quai transactions.

The original tree is not in git history (the folder was untracked); a tarball of it was kept in the session scratchpad when the refactor started.

---

## Repository layout

```
b6/
├── packages/
│   ├── contracts/   @darkquestate/contracts  Solidity 0.8.24 (paris), OpenZeppelin 5.2
│   │   ├── contracts/QuestateDeed.sol        EIP-6065 + ERC-721 Enumerable deed registry
│   │   ├── contracts/QuestateBrokerage.sol   listings, escrowed offers, closings, pull payouts
│   │   ├── test/                             36 tests incl. reentrancy and hostile counterparties
│   │   └── scripts/deploy-quai.mjs           simulate / sign-only / keystore broadcast to Quai
│   ├── core/        @darkquestate/core       SDK: RPC, Quai tx pipeline, reads, calldata, intake, CID
│   └── ui/          @darkquestate/ui         design system, parcel site plan (SVG), 3D massing (three.js)
├── apps/web/        @darkquestate/web        the site (React 18 + Vite + Tailwind, hash routes)
└── scripts/
    ├── local-market.mjs                      Hardhat chain + deploy + seeded market for development
    └── integrity.mjs                         static gate (legacy strings, chain ids, dev code in bundle)
```

---

## Build, test, run

Node 22+ and pnpm 10.

```bash
pnpm install
pnpm build          # contracts, core, ui, web (turbo)
pnpm test           # 36 contract + 66 core (incl. live-chain e2e) + 10 web tests
pnpm integrity
pnpm dev            # http://localhost:5290 (showcase unless deployments.ts has an entry)
```

**Against a real chain locally.** `pnpm local:market` starts a Hardhat node on port 8645, deploys both contracts, seeds six listings (one sold, one with a lien, open offers on two) and writes `apps/web/.env.localchain.local`. Then `pnpm dev:local` serves the site against it with a dev wallet: pick any of the node's accounts in the header to act as registrar (#0), broker (#1–2), seller (#3–8) or buyer (#9–11). The dev wallet exists only in that mode; `pnpm integrity` checks it is absent from production builds.

---

## Deploying to Quai

The deploy script never takes a raw private key. It signs from an encrypted keystore, grinds both contracts into Cyprus-1, simulates each creation, sizes gas from runtime bytes (not from `quai_estimateGas`), waits for confirmations, verifies the registry's code hash and both owners on chain, then records the addresses in `packages/core/src/deployments.ts`.

```bash
cd packages/contracts
node scripts/deploy-quai.mjs --network orchard --from 0x00<your address>   # simulate, costs nothing
node scripts/keystore-new.mjs keystores/deployer.keystore.json               # fund the printed address
node scripts/deploy-quai.mjs --network orchard --keystore keystores/deployer.keystore.json --broadcast
```

Optional `--registrar` and `--operator` hand the two roles to other Cyprus-1 addresses. A mainnet broadcast also requires `--i-understand-unaudited`. Simulated on 2026-10-13: worst case ~0.03 QUAI on Orchard and ~1,283 QUAI on mainnet at that day's gas price (limits are generous; unused gas is refunded). After deploying, register at least one broker in the Registrar console, then rebuild and redeploy the site.

---

## Known limitations

- **No audit.** The contracts have unit, adversarial and end-to-end tests. That is not an independent audit.
- **Not wired into the DarkCircle portal or Pages deploy.** The site builds with a relative base and hash routes, so it can be served from any sub-path, but `tools/assemble_site.sh` and the workflow do not include it yet.
- **Metadata hosting.** The site computes each deed's metadata CID; publishing the document (IPFS or Arweave) so the CID resolves is the registrar's step.
- **Listing reads are unindexed.** The site reads the newest 60 listings by id. A larger desk will want an indexer.
- **Native QUAI only.** Prices, deposits and payouts are in QUAI; dollar figures are CoinGecko estimates for display and never used on chain.
- **Legal effect.** A deed token mirrors a title verified off chain. What it conveys depends on the owning entity's operating agreement and local law.

---

<div align="center">

<sub>Built on **Quai Network** (Cyprus-1, chain id 9) &nbsp;·&nbsp; part of the **DarkCircle** suite</sub>

<a href="https://boltevm.com"><sub>Powered by</sub> <img src="apps/web/public/Boltfont.png" alt="BOLT" height="18" /></a>

</div>
