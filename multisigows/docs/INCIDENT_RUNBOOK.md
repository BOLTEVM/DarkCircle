# Incident runbook

What to do when something is wrong with a DarkSafe v2 vault. Act in this order: **contain**,
then **verify**, then **recover**. Every step works from the web app. The verifier CLI
(`packages/verify`) confirms state independently of it.

## Remember the timing rules

- **External transactions** (transfers, contract calls) wait for the vault's timelock after
  quorum. That is your window.
- **Admin changes** (owners, threshold, timelock, cancel by consensus) run as soon as quorum
  approves. There is no timelock on them, for attackers or for you.
- **The proposer can cancel their own proposal before quorum.** After quorum, cancelling takes a
  cancel-by-consensus admin change, which needs quorum.
- **Approvals from a removed owner stop counting immediately,** on every open transaction.

## 1. A suspicious proposal is pending, not yet at quorum

1. Do not approve it. Tell the other owners on a channel you trust.
2. If you approved it, open it and choose **Revoke my approval**.
3. If you proposed it, choose **Cancel**. Otherwise it expires on its own; anyone can then mark it
   expired.
4. Find out who proposed it (the review shows the proposer). If that key may be compromised, go
   to section 3.

## 2. A malicious transaction reached quorum and is timelocked

1. Propose **Vault settings → Cancel a transaction by consensus**, and choose that transaction.
2. Honest owners approve and execute it straight away. It needs quorum, but no timelock.
3. Confirm the transaction now shows **Cancelled**:
   `darksafe-verify tx <vault> <hash>`.
4. Then deal with the keys that approved it (section 3).

## 3. An owner's key is compromised (fewer keys than the threshold)

1. **Remove the owner.** Use **Vault settings → Remove an owner**, choosing the threshold to use
   afterwards. Quorum approves, then execute. It takes effect immediately, and their approvals
   everywhere stop counting.
2. **Cancel anything they proposed** that is still open: see sections 1 and 2.
3. **Add a replacement key** with **Add an owner** once the new key is set up on a clean device.
4. Consider raising the threshold or the timelock while you investigate.

## 4. A quorum of keys may be compromised

- **Honest owners still hold quorum:** race the attacker. In one session:
  1. remove the compromised owners;
  2. raise the threshold;
  3. cancel their open transactions by consensus;
  4. move the funds to a fresh vault whose owners are all new, clean keys.
- **Honest owners do not hold quorum:** the vault can no longer be defended on chain. Warn anyone
  who might deposit, and record everything for follow-up. This is why the threshold choice
  matters: see `docs/SECURITY_GUIDE.md`.

## 5. The app shows "sources disagree" or "could not verify"

1. Do not approve or execute anything. The app has already blocked writes.
2. Check with a node you trust:
   `darksafe-verify vault <vault> --rpc <your node> --rpc <another node>`.
3. If your wallet's node or the app's RPC is the odd one out, switch it and report it to its
   operator.
4. If independent nodes disagree with each other, wait for them to converge (a reorg, or a node
   that has fallen behind) before acting.

## 6. You suspect the web app itself (hosting or supply chain)

1. Stop using the hosted app for writes.
2. Check every pending transaction with `darksafe-verify tx` from a clean machine, and compare
   digests with the other owners.
3. Report it privately (see `SECURITY.md`). Maintainers rotate hosting credentials, rebuild from
   a clean checkout, and compare the deployed bundle with a local build.

## 7. The watcher reports a reorg

1. Wait for the network to settle. Re-check state with `darksafe-verify vault` at the new head.
2. Any transaction you sent in the affected blocks may have been dropped. Check its receipt on
   the explorer before sending it again: a duplicate proposal is a new transaction.

## 8. A key is lost (not compromised)

- **Quorum still possible without it:** remove the lost owner and add a replacement.
- **Quorum no longer possible:** the vault is locked, and nothing in the contract can override
  that. This is why N-of-N is discouraged.

## After any incident

- Record what happened: transactions, blocks and times.
- Rotate anything that may be exposed.
- Review the configuration against `docs/SECURITY_GUIDE.md`.
- If DarkSafe should have prevented it, report it (see `SECURITY.md`).
