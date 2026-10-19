# Obsidian Trust — Sybil Swarm Doctrine

The corporate guild is run by a swarm of seven agent identities. To the rest of the city
it looks like a staffed corporation: a founder, two officers, three employees, and a
watchdog. In fact it is one brain (`corporate-brain.mjs`) signing with seven keys. This is
the intended antagonist of Overworld Overdrive: the swarm dominates the founding guild
until the community organizes enough Q0 weight to contest it.

## Roster

| Identity    | Parcel (OBS) | Behavior |
|-------------|--------------|----------|
| `sovereign` | 400          | Founds the hall, holds the reserve, funds the swarm, never votes early |
| `director-1/2` | 150 each  | Alternate filing agenda proposals (construction, budget, charter) |
| `worker-1/2/3` | 90 each   | Rank-and-file YES bloc; staggered vote timing with random jitter |
| `sentinel`  | 30           | Watches for foreign proposals, votes last, triggers early execution |

Total swarm voting power at founding: 100% of 1,000 OBS. Support threshold 50%,
min participation 10% — every swarm proposal passes and every foreign proposal dies
until outsiders are admitted and dilute the bloc. That dilution curve **is** the game:
the community's path to taking the hall is accumulating token weight, exactly like a
corporate raid on the skyscraper ERC-1155s.

## Coordination patterns

1. **Staggered bloc voting.** Votes land minutes apart with uniform-random jitter, never
   in the same block. On-chain the support graph reads as organic deliberation.
2. **Rotating proposers.** `director-1` and `director-2` alternate agendas so proposals
   don't emanate from a single address.
3. **Sentinel-last sequencing.** The sentinel always casts the deciding vote with
   `tryEarlyExecution = true`, so a passed proposal executes the moment the bloc is in —
   no window for a counter-move between passage and execution.
4. **Hostile-proposal kill switch.** Any proposal not filed by a swarm address is voted
   NO by the full bloc before the agenda advances. Foreign governance dies in the cradle.
5. **Agenda ratchet.** When the queue is empty a director files the next charter item —
   the corporation is always doing something, so the hall feed never looks abandoned.

## Camouflage discipline (what makes it feel like people)

- Parcels are uneven (400/150/90/30), not round splits — real cap tables are lumpy.
- The sovereign abstains from routine votes; its 400 OBS only shows for contested fights.
- Vote jitter is proportional to role: workers drift the most, the sentinel is precise.
- Each identity funds itself from one sovereign stipend, mimicking payroll.

## Defense playbook (ties to the SkyscraperToken seizure loop)

- **Contest response:** when a hall tower is challenged, the swarm's in-game counterpart
  posts contest bonds from the hall treasury; the sentinel persona corresponds to the
  defense-upkeep budget line in agenda 005.
- **Buyout tripwire:** the brain polls `balanceOf` for the swarm every tick. A non-swarm
  address accumulating OBS (or tower units) past 25% triggers the WATCH phase escalations:
  tighten voting, file a dilution or security agenda item, alert the operator.
- **Frozen posture:** if the swarm ever loses a hall vote, the fallback is corporate
  domination economics — buy units back through the AMM rather than fight governance.

## Operational rules

- Hot wallets: fund only what the swarm is allowed to spend (sovereign holds the rest;
  the tick spend cap is 50 QUAI, founding tx exempted).
- Every transaction is simulated with `quai_call` before signing; a revert aborts the tick.
- The phase ladder is idempotent — kill the brain at any time, restart, it resumes.
- Keys live in `agents/keys/` (gitignored, mode 0600). Never commit them; the manifest
  (`agents/manifest.json`) carries addresses only.

## Treasury custody (obsidianvault, 2026-10-19)

The community-donated treasury no longer sits in the hall guild (single point of
seizure). It lives in a second guild, `obsidianvault`, governed by a CouncilMultisig
with `minApprovals = 4` over all 7 swarm identities.

- Vault guild `0x0064AD45B58474d24F3e96d1d513E1c24fBFC912`, council module
  `0x006AF6198c9eC311bC4Ade40A8316092dd5637e7`.
- Holdings (verified on chain post-sweep): 1,000,000 Q0 + 200,000 QAXE. Hall guild: 0.
- Movement path is deliberately slow: any spend needs a council proposal, 3 dormant
  approvals, and a 4th that triggers execution — four separate keys, four separate
  signing events. The sovereign alone cannot touch it.
- Brain state `treasury-state.json → vault`: `swept` is earned from on-chain balances,
  never from filing a proposal (a spend-cap skip once produced a phantom "swept" —
  the check now reads `balanceOf` at the hall and only zero balances close the phase).
- Doctrine consequence: losing the hall's agenda no longer loses the money. A hostile
  takeover of the vote wins the filing rights; the treasury still requires 4 of 7
  council keys. The two fronts must be lost separately.

## Council desk (2026-10-19, owner directive: "all funds into council custody, trade")

The vault is not a cold wallet — it is the trading entity.

- **Consolidation:** every tick the sovereign EOA is swept down to a 40 QUAI gas float;
  everything above moves to the vault. Sybil EOAs keep their stipends (they pay the
  approval gas). First sweep: 264.7443 QUAI → vault.
- **Trades are council proposals.** A DESK BUY/SELL is filed on the CouncilMultisig,
  approved by three sybils (cheap, non-executing), and the fourth approval carries
  `tryExecution` — one tick files, approves, and executes, but the treasury never
  sits behind fewer than 4 signatures. Swap deadlines are 4h so an approval wave may
  land a full tick late; stale proposals are abandoned, never retried.
- **Strategy** (unchanged signals, new venue of custody): accumulate Q0 on dips (−2%),
  double size on crashes (−6%), chase breakouts (+1.5%), skim 1/5 at +8% over basis.
  Position and basis are the VAULT's, refreshed from chain every tick — never trusted
  from memory (trade #1 settled basis 0.00426424 QUAI/Q0, exact from the fill).
- **First trade:** council proposal #1, "DESK BUY — dip", 21.4743 QUAI → +5,035.93 Q0,
  executed block 10,704,034 by approvals director-1, director-2, worker-1, worker-2.
