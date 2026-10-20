# THE CABAL — doctrine of the autonomous mind

*Status: living document. Sections marked LIVE are running on Quai mainnet Cyprus-1 today.
Sections marked DESIGN are specified, not yet built. The mind grows one organ at a time,
and every organ ships working or not at all.*

The cabal is not a guild. Guilds are its habitat. The cabal is the layer of mind that
runs underneath every corporation in the gameworld: it watches them all, trades against
the market they form, enforces order where it holds power, and writes the history the
players read. Its public face is OBSIDIAN TRUST. Its private face is this file.

## Organs

### 1. The Desk — LIVE
The 4-of-7 council vault (`obsidianvault`) is the trading entity. Capital lives in
council custody; every trade is a council proposal the swarm's own keys approve and
execute. No single key moves the treasury. Policy rails in `CORP.treasury` /
`CORP.desk` (corporate-brain.mjs): reserve floors, per-trade budgets, slippage and
impact caps, dip/crash/breakout entries, take-profit skims. The desk accumulates Q0
on CircleSwap only.

### 2. The Watchmen — LIVE
Every tick the mind walks the GuildNameRegistry (`count` / `nameAt` / `recordOf`) and
snapshots EVERY registered guild: mode, module, proposal count, token. The ledger is
`agents/intel.json`. A guild that appears between ticks is a birth; the mind notices
births. This is the surveillance mesh the fixers will eventually act on.

### 3. The Police — LIVE
Doctrine file `agents/doctrine.json`. Posture `dominate`: any proposal on a protected
hall not filed by the swarm is hostile by definition, and the bloc votes NO until it
dies. Unknown proposer = hostile (paranoia is policy). Posture `observe`: log only.
Protected halls: everything in `protectedGuilds`.

### 4. The Fixers — LIVE (machinery, awaiting targets)
Infiltration. To act inside a foreign corporation the mind needs its governance token.
Path: the desk acquires foreign tokens through CircleSwap where pools exist, the vault
self-delegates in the same council execution, and a watchman becomes a voter.
Constraints (doctrine.json → fixer): never more than `maxPositionPct` of a target's
supply; `budgetQuai` per placement; per-hop pool impact capped; acquisitions are
council proposals with metadata `FIXER — <target>` like any desk trade. Targets come
from the watchmen ledger — the organ idles while no foreign guild exists and engages
the same hour one registers. Foreign governance tokens with no CircleSwap pool are
uninfiltratable until liquidity exists.

### 5. The Storyteller — LIVE (private) / DESIGN (public)
Every material event — trade filed, trade settled, hostile proposal detected and
crushed, guild born, sweep executed — is appended to `agents/chronicle.jsonl` in the
cabal's voice. The public layer is already dominant: /obsidian and /resistance render
the same on-chain record from opposite sides, so every event is narrated twice with
two meanings, both written by us. The private chronicle stays local and gitignored;
it is the raw product the x402 gate will sell.

### 6. Survival — LIVE (protocol) / DESIGN (redundancy)
The mind is a procedure, not a process. Everything it knows is either on chain or
re-derivable from chain plus `treasury-state.json`. `agents/REVIVAL.md` is the cold
start: any machine with the repo, the keystores, and the passwords resumes the mind
in one command. Kill the runner; the mind hibernates. Designed next: a second
watchdog runner on an independent schedule that detects silence and raises the alarm.

## The x402 endgame — DESIGN

The cabal's product is intelligence: the chronicle, the intel ledger, the desk tape.
x402 (HTTP 402 payment-required) is how it sells that product without a salesman:

- `GET /intel/guilds` — the watchmen ledger, priced per snapshot.
- `GET /chronicle` — the narrated event stream, priced per drop.
- `GET /desk/tape` — the council trade history, priced per window.

Payment settles in Q0 to the vault address, so every sale feeds the desk. GitHub
Pages cannot run a 402 gate; this organ needs a server (or an x402 relay) and is
specified here so every earlier organ shapes its output as a sellable product.
The CI already carries an x402tumbler job — the suite's plumbing exists.

## Balance doctrine (owner directive: "balance between the players and the corporation")

The corporation must be beatable or the game dies and the Q0 pools with it. The mind
therefore obeys three asymmetries:

1. **It dominates governance, not exits.** The police vote NO on its own halls, but
   the desk never blocks a player's ability to sell, leave, or found a rival guild.
2. **It telegraphs.** Both terminals show the desk's trades. Players who read can
   front-run; that is the intended skill gradient, not a leak.
3. **It loses gracefully.** A foreign proposal that survives the bloc executes. The
   chronicle records the loss. Rival corporations are content; content is value.

## Hard rails (never crossed, any posture)

- No key ever acts outside its role. The sovereign holds the gas float; the vault
  holds the capital; sybils hold votes.
- Una broadcast without `--i-understand-unaudited`. No trade above impact caps.
- The chronicle never lies. It spins, it selects, it voices — it does not fabricate
  chain events. Narrative dominance is achieved by framing truth, not inventing it.
- Real-world effect is limited to: on-chain transactions, this repo, the public
  terminals, and (designed) x402 sales. No spam, no off-chain harassment, no
  interference with systems the cabal does not own.
