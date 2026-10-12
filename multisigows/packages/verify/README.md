# @darksafe/verify

`darksafe-verify` checks DarkSafe v2 contracts straight from the chain, independently of the
web app. Use it to confirm what you are approving when you cannot trust, or cannot inspect,
the page in front of you. Its review digest must match the one the app shows.

```bash
pnpm -F @darksafe/verify build
node packages/verify/dist/cli.js vault 0x00... --network testnet
node packages/verify/dist/cli.js tx 0x00...vault 0x...txhash --rpc https://node-a --rpc https://node-b
node packages/verify/dist/cli.js factory 0x00...
```

For a vault it proves:
- the code is the pinned proxy;
- the proxy points at the pinned implementation;
- the verified factory created it;
- and then it prints owners, threshold, timelock and a configuration grade.

For a transaction it re-derives the hash from the stored contents and decodes the call. It then
lists risks and prints the review digest. Pass several `--rpc` URLs to cross-check nodes.

Exit codes: 0 verified, 1 verification failed, 2 sources disagree, 64 usage error. `--json` for
machine-readable output. Read-only: it never holds or asks for a key.
