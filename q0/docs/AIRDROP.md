# Q0 + QAXE airdrop to Quainance BDELTA stakers

**The pot:** 2,100,000 Q0 and 210,000 QAXE, shared by everyone with at least 1,000 BDELTA staked on Quainance, in proportion
to their stake. An LP burner counts 1.5x.

Nothing here has been deployed or sent. Every step that moves tokens is the administrator's, from the admin wallet.

## What "staked on Quainance" means here

Quainance has no single-token BDELTA staking. BDELTA reaches it as liquidity in the BDELTA/WQUAI pool
(`0x006524c3…7209`, liquidity token QNCE-V2), and that liquidity is staked in Quainance's **gaugeV2**
(`0x004A1FE8…6df6`). A wallet's stake is the BDELTA its liquidity tokens represent:

    stake = (liquidity tokens in the wallet + liquidity tokens staked in the gauge) / pool supply x BDELTA in the pool

An **LP burner** is an account that sent liquidity tokens to the zero or dead address (read from the pair's Transfer logs),
plus the creator of the pool for what the launcher burned at launch (`poolSummary.initialBurnedLiquidity`).

Read literally, the rule is: *staked* BDELTA decides the 1,000 threshold and the share; *burning* earns the 1.5x. Burned
liquidity is no longer staked, so by default it does **not** count as stake. If the project wants burned liquidity to count
too, take the snapshot with `--count-burned` (or tick the box in the dashboard). Decide this once, before the real snapshot.

## Taking the snapshot

* **Scheduled:** `.github/workflows/airdrop-snapshot.yml` runs on **21 October 2026 at 12:00 UTC** by itself (GitHub may
  start it a little late), tests the arithmetic first, takes the snapshot, and keeps `snapshot-<block>.json`,
  `distribution-<root>.json` and the log as a downloadable artifact for 90 days. The plan is also written to the run page.
* **By hand, any time:** Actions tab > "Airdrop snapshot" > Run workflow (options: count burned liquidity, exclude accounts,
  stamp the claim contract's address).
* **From a terminal:** `bun run q0/scripts/airdrop-snapshot.ts` (`--snapshot file.json` re-plans a saved snapshot without
  reading the chain; `--exclude 0x…` is repeatable; `--out dir`).
* **From the dashboard:** Farms > Admin > Airdrop > "Read the chain". It runs in the background with a progress count.

The snapshot is read-only: no key, no signature, no transaction.

## What to check before publishing

1. The plan table: who is eligible, who is a burner, each share. Exclude accounts that should not take part
   (the team's own wallets, protocol contracts).
2. Warnings: *contract holders* (a contract other than the gauge holds liquidity: whoever is behind it is not counted) and
   *unattributed* (the gauge holds liquidity that no found account owns: a staker may be missing).
3. The log history is `complete` (it reached the pair's first mint). A partial history can only miss a burner.
4. `auditDistribution` reports no problems (the dashboard and the script both run it).

## Distribution, deposit, claim

1. **Deploy** `CircleswapAirdrop` (`q0/packages/contracts/contracts/CircleswapAirdrop.sol`) with the owner, Q0 and QAXE. The
   contract is tested (20 Hardhat tests) and has not been audited by anyone outside the project.
2. **Deposit** the totals in the file (`totalA` Q0, `totalB` QAXE: the pot minus rounding dust) to the contract with ordinary
   token transfers (the dashboard has a button for each).
3. **Publish** `distribution-<root>.json` (host it; put a copy at `q0/apps/stats-app/public/airdrop/distribution.json` for
   the claim page). It lists every account, amount and proof.
4. **Set the root** once: `setMerkleRoot(root, totalA, totalB, deadline)`. The contract refuses unless it already holds the
   totals, refuses a window shorter than 14 days, and can never be re-pointed. Check the file against the root first: a
   wrong root is the one mistake nothing can undo.
5. **People claim** with `claim(index, account, amountA, amountB, proof)` from the claim card on the Farms page (anyone may
   submit for anyone; the tokens go to the account).
6. **Sweep** after the deadline returns what was not claimed. The owner cannot touch the two tokens before then.

## Limits, said plainly

* The single-token pools are gated to wallets with 1,000 BDELTA on Quainance **on this page only**. The farm contract is
  immutable and accepts deposits from anyone; a gate on the contract itself would need a new contract.
* The stake is a snapshot at one block. Liquidity moved in or out afterwards does not change an allocation.
* If Quainance deploys a new staking contract, the snapshot must be pointed at it (`snapshotPool` finds a gauge that answers
  `getPoolId(pair)`; a different design needs a reader written for it).
