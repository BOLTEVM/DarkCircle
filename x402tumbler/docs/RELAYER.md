# Relayer operator runbook

The production relayer (`src/relayer/`, design record in `docs/RELAYER_PLAN.md`) is a separate
process that broadcasts `DarkCirclePool.unshield` calls from its own funded key. One process per
pool; WQUAI and WQI never share a relayer.

**Status: built and tested against a scripted Quai node. Not yet validated on a live network.**
Before the first Orchard broadcast, the signed-transaction wire format must be compared byte-for-byte
against a quais-SDK-signed reference (the phase-4 gate in `docs/RELAYER_PLAN.md`). Do not skip this.

## 1. Setup

```bash
# 1. Create the encrypted keystore (outside the repository). The passphrase never appears in argv.
RELAYER_PASSPHRASE='...' pnpm relayer:key --out /secure/path/relayer-keystore.json

# 2. Fund the printed address with QUAI for gas (start with ~5 QUAI on Orchard).

# 3. Configure the environment (see §2) and start:
pnpm relayer
```

## 2. Environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `RELAYER_POOL_ADDRESS` | yes | — | The pool this relayer serves (the only contract its key may call) |
| `RELAYER_TOKEN_ADDRESS` | yes | — | The pool's token (WQUAI or WQI) |
| `RELAYER_KEYSTORE_PATH` | yes | — | Encrypted keystore file |
| `RELAYER_KEYSTORE_PASSPHRASE` | yes | — | Keystore passphrase (env only, never a flag) |
| `RELAYER_AUTH_TOKEN` | yes | — | Bearer token for the HTTP API |
| `RELAYER_STATE_PATH` | no | `relayer-state.json` | Durable store (nonces + per-nullifier records) |
| `RELAYER_NETWORK` | no | `quai-cyprus1` | e.g. `quai-orchard-cyprus1` for the rehearsal |
| `RELAYER_MIN_FEE` | no | `500000000000000000` (0.5 units) | Published minimum fee, base units |
| `RELAYER_UNSHIELD_GAS_ESTIMATE` | no | `400000` | Gas baseline used in the quote |
| `RELAYER_GAS_HEADROOM_PERCENT` | no | `150` (×2.5) | Gas-cost multiplier in the quote |
| `RELAYER_QUOTE_VALIDITY_BLOCKS` | no | `12` | Quote validity window |
| `RELAYER_GAS_FLOOR` | no | `1000000000000000000` (1 QUAI) | At/below this gas balance the relayer takes itself offline |
| `RELAYER_CONFIRMATIONS` | no | `2` | Confirmations before `confirmed` (≥ 2 always) |
| `RELAYER_MAX_ATTEMPTS` | no | `3` | Resend attempts per nullifier |
| `RELAYER_TX_TIMEOUT_BLOCKS` | no | `64` | No receipt within this → `dropped` |
| `RELAYER_PORT` | no | `4790` | Loopback HTTP port |

## 3. API (loopback only, bearer token)

```bash
H="Authorization: Bearer $RELAYER_AUTH_TOKEN"

curl -s -H "$H" -X POST localhost:4790/quote \
  -d '{"token":"0x…WQI…"}'
# → { relayer, feeToken, estimatedFeeUnits, expiresAtBlock, gasPrice, quoteBlock }
# The client binds EXACTLY estimatedFeeUnits (or more) as `fee` when proving.

curl -s -H "$H" -X POST localhost:4790/relay \
  -d '{"token":"0x…","proof":{"a":["1","2"],"b":[["3","4"],["5","6"]],"c":["7","8"]},"payment":{"root":"0x…","nullifier":"0x…","changeCommitment":"0x…","recipient":"0x…","amount":"5000000000000000000","relayer":"0x…","fee":"500000000000000000"}}'

curl -s -H "$H" localhost:4790/status/0x<nullifier>
curl -s -H "$H" localhost:4790/health
```

Every refusal is a named error (`ERR_RELAYER_OFFLINE`, `ERR_RELAYER_GAS_FLOOR`,
`TOKEN_POOL_MISMATCH`, `RELAYER_ADDRESS_MISMATCH`, `FEE_BELOW_QUOTE`, `NULLIFIER_ALREADY_SPENT`,
`UNKNOWN_ROOT`, `RELAY_SIMULATION_FAILED`, …) — clients can branch on the name.

## 4. Operating procedures

### The relayer is stuck (a pending relay will not confirm)

1. `GET /status/:nullifier` — the `lastError` and `status` say which of four states it is in:
   - `pending` — waiting for confirmations; if it exceeds `RELAYER_TX_TIMEOUT_BLOCKS` it becomes
     `dropped`.
   - `dropped` — the RPC never produced a receipt. The nonce was consumed on some nodes but the tx
     is gone; the durable nonce hint was resynced at start, so a re-POSTed `/relay` picks the next
     free nonce. Safe: the nullifier check runs first.
   - `reverted` — the tx landed and reverted (the whole gas limit was burned). The nullifier is NOT
     spent; investigate why the on-chain call reverted, then re-POST `/relay` to retry.
   - `reorged` — the receipt disappeared (a reorg or a lying RPC). If the nullifier is spent on
     chain, the same transaction will re-land; just wait. If it is unspent, re-POST the same
     `/relay` body; it re-checks the chain and resends with a fresh nonce. This is the only resend
     path — the relayer never resends on its own.
2. A relay never sends a second transaction for a nullifier on its own. Two transactions for one
   nullifier can only happen if the state file was deleted — restore it from backup.
3. If the zone is genuinely down: leave the process running; it reconciles on start, and `sync`
   catches up once the RPC answers again.

### Stranded ephemeral funds

A relay pays `recipient` even when `recipient` is a one-off address whose key later lives only in an
invoice record. If funds are stranded:

1. Find the receiving address in the relay record (`GET /status/:nullifier` → `recipient`) or in
   the pool's `Unshield` event for the transaction.
2. Recover with the key that owns the address (the invoice/payee key — the relayer key cannot move
   them: the policy guard refuses to sign anything but `unshield` to the pool).
3. The relayer itself only ever holds fee income and gas QUAI; sweep fee income periodically to
   cold storage by sending from the key *outside* this process (the guard is in-process).

### Gas floor tripped (`ERR_RELAYER_GAS_FLOOR`)

The relayer refuses everything until its balance is above `RELAYER_GAS_FLOOR` again. Top up the
relayer key from the treasury. The refusal happens before anything is attempted, so no request is
lost — clients see a named 503 and retry.

### Taking the relayer offline (SP-EX-04)

Restart it with the operator switch: there is no in-process console in v1, so stop the process.
A stopped relayer refuses by absence; nothing in-flight is stranded (see "stuck"). To refuse new
requests while keeping confirmations tracked, stop the HTTP listener but leave `sync` running —
or simply stop the whole process and rely on reconcile-on-start.

### Key rotation

1. Generate a new keystore (`pnpm relayer:key --out …`), fund it with QUAI.
2. Stop the relayer, point `RELAYER_KEYSTORE_PATH` at the new file, keep the same `RELAYER_STATE_PATH`.
3. Start. The new key's address differs, so new quotes name it; in-flight relays finished under the
   old key remain correct (their fee was paid to the old key). Delete the old keystore once the
   state file has no in-flight records naming it.

## 5. What the relayer will never do

- Sign anything except `unshield` to the configured pool (policy guard, `src/relayer/signer.ts`).
- Resend a nullifier on its own after a reorg — resend is always a fresh, re-checked `/relay`.
- Log or store notes, spending keys, viewing keys or witness data. The state file and logs carry
  only public fields (nullifiers, hashes, fees, addresses).

## 6. The Orchard rehearsal (phase 4, checklist T-06)

`scripts/relayer-rehearsal.ts` drives the whole phase-4 sequence. Nothing is broadcast until the
wire-format gate has passed.

```bash
export RELAYER_NETWORK=quai-orchard-cyprus1
export RELAYER_POOL_ADDRESS=0x006Fc574dAAd3733b53c2EfC5Eaa505E991a5203
export RELAYER_TOKEN_ADDRESS=<the pool's token, read it from the pool's token() view>
export RELAYER_KEYSTORE_PATH=/secure/path/relayer-keystore.json
export RELAYER_KEYSTORE_PASSPHRASE='...'
export REHEARSAL_OPERATOR_KEY='0x...'   # the operator's shield wallet, funded with WQI + QUAI

# Step 1 — the gate, nothing else:
node scripts/relayer-rehearsal.ts gate
# → prints the gate vector and our signature; aborts without a reference

# Step 2 — sign the gate vector with the SAME relayer key using the quais SDK (or the node's own
# signer), then:
node scripts/relayer-rehearsal.ts gate --gate-reference 0x<quais-signed>
# → PASS GATE-1 means the encoder is byte-identical to the reference. If it FAILS, stop and fix
#   src/relayer/signer.ts before anything else.

# Step 3 — the full sequence (gate runs again first):
node scripts/relayer-rehearsal.ts full --amount 1
```

`full` verifies the pool on chain, rebuilds the Merkle tree from the pool's Shield events, quotes
the fee over the relayer's real HTTP API, shields `amount + fee` from the operator's wallet, proves
an unshield to a fresh unfunded recipient with snarkjs, relays it, waits for two confirmations, and
checks on chain that: the nullifier is spent, `nextIndex` advanced by two (spend + change note),
the recipient was paid exactly, and the relayer was paid exactly the quoted fee. It then runs the
failure cases — relayer offline, fee below quote, a proof naming a different relayer — and asserts
each refuses with its named error while the relayer's on-chain nonce moves by exactly one. Every
step is a `PASS/FAIL <id>` line; the whole run lands in `rehearsal-<zone>-<ts>.json`.

Notes:
- The proving step needs the build artifacts (`build/circuit/unshield_js/unshield.wasm`,
  `build/keys/unshield_final.zkey`); produce them with the admin pipeline first.
- The relayer runs in-process during the rehearsal — same code, same guard, same store semantics —
  so the script can exercise the operator off switch. Gas is real; use a small `--amount`.
- A failed run still writes its partial record; a re-run is safe (fresh recipient and note each
  time; the one thing that must not be reused is the same nullifier, which the script never does).
