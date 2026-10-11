# @safebuddy/watcher

`safebuddy-watch` monitors SafeBuddy v2 vaults and raises alerts as JSON lines on stdout, and as
POSTs to a webhook if configured.

At each poll it reads every vault's views at a confirmed block (head minus `confirmations`) and
compares them with the last poll. It does not scan event logs: on Orchard's public RPC those take
about 16 s per 100 blocks and time out at 500. The vault's transaction list is append-only and
every admin change is itself a transaction, so nothing that matters can happen between polls
unseen.

| Alert | Level |
|---|---|
| `owner-added`, `owner-removed` | critical |
| `threshold-changed`, `delay-changed` | critical when lowered, high when raised |
| `proposed` | from the risk rules: admin changes are critical; `largeValueQuai` raises to high |
| `threshold-reached` | critical for admin changes (they have no timelock), else high, with when it becomes executable |
| `executed`, `failed`, `cancelled`, `expired` | failed is high, the rest info |
| `reorg` | high: the last confirmed block changed hash |
| `sources-disagree`, `vault-unverifiable` | critical |
| `rpc-unavailable` | high, after three failed polls in a row |
| `heartbeat` | info, every `heartbeatMinutes`, so silence can be told apart from a dead watcher |

```bash
pnpm -F @safebuddy/watcher build
node packages/watcher/dist/cli.js --config watcher.json          # runs until stopped
node packages/watcher/dist/cli.js --config watcher.json --once   # one poll, e.g. from cron
```

Configuration is described in `watcher.example.json`:
- `webhookUrl` must be https; plain http is allowed only for localhost.
- The cursor is kept in `stateFile`, written atomically. It is refused if it belongs to another
  chain.
