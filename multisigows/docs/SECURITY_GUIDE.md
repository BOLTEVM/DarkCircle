# Using a DarkSafe vault safely

For vault owners. DarkSafe v2 is **unaudited beta**. Until the audit closes and this notice is
removed, keep amounts small.

## 1. Choose the configuration

| Setup | Approvals needed | Timelock | Why |
|---|---|---|---|
| Personal | 2 of 3 keys on separate devices | 24 h or more | One lost or stolen key is survivable |
| Team | 3 of 5 people | 48 h | No single person, and no two, can move funds |
| Treasury | at least half of the owners, and more than 2 | 3–7 days | Time to notice and cancel |

- **Avoid 1-of-N.** Any single key then moves everything; the app grades it D.
- **Avoid N-of-N.** One lost key then locks the vault for good.
- **Don't run without a timelock.** It is your only window to react to a compromised key.
- **Admin changes have no timelock.** Adding or removing owners, and changing the threshold or
  timelock, runs as soon as quorum approves, so honest owners can react quickly. It also means a
  compromised quorum can act immediately. That is why the threshold matters more than anything
  else.

## 2. Keep keys independent

- **One key per person and device,** in a Quai wallet. A hardware wallet is best where Pelagus
  supports it. Never share a seed phrase between owners, and never keep two owners' keys on one
  machine.
- **Owners must be Cyprus-1 Quai accounts** (addresses starting `0x00`, on the Quai ledger). The
  app refuses Qi-ledger addresses: they can never approve anything.
- **Back up each key separately,** and test the backup before funding the vault.

## 3. Before you approve or execute anything

1. **Read the review screen, not the wallet popup.** The wallet only shows
   `approveTransaction(0x…)`. The review screen shows the destination in full, the exact amount,
   the calldata, and what it decodes to.
2. **Check the destination character by character** against your address book, or a source you
   trust. A "first-time recipient" flag means this vault has never paid that address. Treat it as
   a reason to stop and check.
3. **Compare the review digest** (four groups, e.g. `274A-3728-87BD-A772`) with another owner over
   a separate channel.
4. **For anything large, check it independently as well:**
   `node packages/verify/dist/cli.js tx <vault> <txHash> --rpc <a node you trust>`. The digest it
   prints must match.
5. **Stop if anything is off.** That includes:
   - a red "sources disagree" notice;
   - a "could not verify" notice;
   - an admin change you did not expect;
   - an unlimited token approval;
   - a call DarkSafe cannot decode.

   Do not approve, and tell the other owners. Look first: the review offers "Revoke my approval"
   only if you have already approved.

## 4. Watch the vault

Run `darksafe-watch` (see `packages/watcher/README.md`) with a webhook into a channel the owners
read. It alerts on:
- every proposal, with admin changes and large transfers as critical or high;
- quorum being reached, with when the transaction becomes executable;
- owner, threshold and timelock changes;
- reorgs, and sources disagreeing.

A missing heartbeat means the watcher is down. The timelock is only useful if someone is
watching during it.

## 5. Deposits

- **Test first.** Use Orchard, or a small amount, and make one full round trip (propose,
  approve, execute) before depositing more.
- **Copy the vault address from the app,** and check it in groups of four. Scan the QR code the
  app generates itself.
- **Some exchanges cannot pay into the vault.** They send with a fixed 21,000 gas limit, and the
  vault's `receive()` needs a little more. Send a small test amount first.

## 6. What DarkSafe cannot protect you from

- A quorum of owners (or their keys) acting against the vault.
- Approving something you did not read.
- A compromised computer that shows you a different screen *and* a different CLI output. Use a
  second device, or ask another owner, for large transfers.

If something goes wrong, follow `docs/INCIDENT_RUNBOOK.md`.
