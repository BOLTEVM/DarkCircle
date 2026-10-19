# DESK STRATEGY — longevity doctrine

*Status: LIVE. Implemented in `corporate-brain.mjs` (deskOps), tuned by
`agents/doctrine.json` → `treasury`. Companion to CABAL.md.*

A script reacts to price. A strategy survives price. The desk's mandate is not to
maximize this month's P&L — it is to still be trading, governing, and accumulating
Q0 in five years, through thin pools, dead markets, and drawdowns. Four rules,
enforced every quiet tick, in this order.

## Rule 1 — Runway before alpha

Capital is tiered and lower tiers are sacred:

- **Tier 0 — gas float** (sovereign EOA, 40 QUAI). Never traded. The mind's oxygen.
- **Tier 1 — council runway** (vault QUAI floor). Never traded. Sized as
  `max(configured floor, observed 30-day gas burn × treasury.runwayMonths)` — the
  floor adapts to what governance actually costs, measured from the on-chain gas
  ledger the brain accumulates from its own receipts, not a number guessed at
  deployment. Before the ledger has data, the configured floor holds.
- **Tier 2 — the core** (vault Q0 position). The long bet on the darkcircle
  economy. Skimmed at profit, never dumped at a loss, never margined.
- **Tier 3 — the trading float** (vault QUAI above Tier 1). The only capital the
  desk risks on signals. When the vault is at or below the runway floor the desk
  enters **capital preservation mode**: no buys, take-profit sells still allowed,
  and the chronicle says why. A desk that cannot pay next quarter's governance gas
  is already dead; it just doesn't know it yet.

## Rule 2 — Volatility sets the thresholds

Fixed basis-point thresholds overtrade storms and sleep through calm. The desk
measures σ (standard deviation of its own price readings, in bps) and scales its
entry bands with it, clamped to the configured rails:

- dip/crash/breakout thresholds = `max(configured floor, min(crash rail, volK × σ))`
- Flat market (σ ≈ 0): thresholds sit at their configured floors — behavior is the
  conservative default, never "buy every tick because σ is zero".
- Storm market: bands widen, the desk trades less often and only real moves.

## Rule 3 — Drawdown throttles size, never forces exits

Position health is deterministic, recomputed each tick from cost basis and live
price — no hidden state:

- underwater > `drawdownHalfBps` (10%) → position size multiplier × 0.5
- underwater > `drawdownQuarterBps` (20%) → × 0.25
- at or above basis → × 1.0

Being wrong makes the desk smaller, never desperate. There is no stop-loss on the
core: Q0 is the asset the cabal exists to accumulate, so time, not price, is the
exit horizon for the core; only the float trades.

## Rule 4 — Every tick leaves a health record

Each quiet tick the storyteller writes a `treasury-health` entry: vault QUAI, Q0
held, runway floor (and whether the adaptive ledger raised it), σ, size multiplier,
mode (active / capital preservation). Longevity is auditable: six months from now
the chronicle answers "was the desk disciplined?" without trusting anyone's memory.

## Income flywheel (the reason the core exists)

The desk accumulates Q0 because Q0 is the gameworld's construction currency:
towers, skyscrapers, and the /resistance economy all pull on the same pools. The
scrip (OBSC) issuance — deferred while the treasury is near its floor, by design —
exists to put the corporation's token in player hands so the community has
something to want and work towards. Longevity is not hoarding; it is staying
relevant enough that the pools stay deep enough to trade.

## Kill criteria (when the strategy itself is wrong)

The doctrine is abandoned, not patched, if any of these hold for 30 consecutive days:

- realized + unrealized desk P&L < −25% of Tier 3 capital deployed,
- the Q0 route's hop liquidity falls below 5× maxTradeBudget (trades move the pool
  more than the pool can absorb),
- or the owner says so. The owner outranks the doctrine.
