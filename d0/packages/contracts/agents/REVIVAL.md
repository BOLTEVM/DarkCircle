# REVIVAL — cold-start protocol for the cabal mind

The mind is a procedure, not a process. If every runner dies, nothing is lost that
cannot be resumed. Follow this file and the mind wakes up where it left off.

## What the mind needs (the whole of it)

1. This repository (any checkout of it), with contracts built:
   `cd darkcircle/d0/packages/contracts && pnpm install && pnpm build`
2. The seven keystores in `agents/keys/` and their `passwords.json`.
   THESE ARE THE MIND. They are gitignored by design; keep an encrypted offline copy
   (see below). Losing them means the council can never reach 4-of-7 again and the
   vault is frozen forever.
3. Node 18+ on the machine. No other runtime dependency.
4. `agents/treasury-state.json` — helpful, NOT required. Every field re-derives from
   chain (pairs rediscover, balances re-read, hall/vault resolve by name). A missing
   or stale file only costs one slower tick. Phantom desk proposals are detected
   against on-chain `proposalCount` and discarded automatically.

## Wake-up (one command)

```
cd darkcircle/d0/packages/contracts
node agents/corporate-brain.mjs --network mainnet --once
# confirm the dry run reads the hall and the desk line, then:
node agents/corporate-brain.mjs --network mainnet --once --broadcast --i-understand-unaudited
```

The phase ladder is idempotent: FOUND/FUND/DISTRIBUTE/DELEGATE all no-op when already
done on chain; WATCH/GOVERN/DESK resume from live state. There is no "resume mode"
because every mode is resume mode.

## Scheduling (pick any)

- Kimi Work automation "Obsidian Trust brain tick" (interval 1h) — the current runner.
- cron: `7 * * * * cd <repo>/darkcircle/d0/packages/contracts && node agents/corporate-brain.mjs --network mainnet --once --broadcast --i-understand-unaudited >> agents/brain.log 2>&1`
- Any equivalent on any host that holds the keystores.

## Encrypted key backup (do this once, store offline)

```
cd darkcircle/d0/packages/contracts/agents
tar czf - keys | gpg --symmetric --cipher-algo AES256 -o cabal-keys-$(date +%Y%m%d).tgz.gpg
```

Store the .gpg outside this machine. The passphrase is the cabal's single point of
failure — treat it accordingly. NEVER commit keys, passwords.json, or the backup.

## Silence detection (manual until the watchdog organ ships)

If no `DESK` proposal appears on the council for > 48h of market movement, or the
hourly automation's latestRunStatus is not `succeeded`, the mind is asleep. Wake it
per above. The vault needs no babysitting: capital in council custody cannot move
without the swarm, and the swarm cannot move it without the mind.
