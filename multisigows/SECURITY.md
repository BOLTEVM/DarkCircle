# Security policy

## Status

SafeBuddy v2 has **not had an independent security audit**. Mainnet vault creation stays off in
every default build (`VITE_ALLOW_MAINNET_VAULTS`), and the mainnet deploy script refuses to run
from anything but the audited git tag. Treat every deployment as beta. Do not hold funds in it
that you cannot afford to lose.

| Component | Supported |
|---|---|
| v2 contracts (`packages/contracts/contracts/v2`), core vault library, web app, `safebuddy-verify`, `safebuddy-watch` | Yes |
| v1 (`SafeBuddy.sol`, removed) | No; never deployed with funds |

## Reporting a vulnerability

Report privately through GitHub: on this repository, open **Security → Report a vulnerability**.
Please do not open a public issue, pull request or discussion for a suspected vulnerability.

Include:
- the component and commit;
- what an attacker can do and under which conditions;
- steps or a test that reproduces it: a Foundry or Hardhat test in `packages/contracts`, or a
  local chain from `scripts/local-quai-chain.mjs`, is ideal.

What to expect:
- acknowledgement within 3 business days;
- an assessment within 10 business days;
- coordinated disclosure once a fix is available, and within 90 days of the report unless we
  agree otherwise;
- credit in the advisory unless you prefer to stay anonymous.

## Scope

In scope:
- the v2 contracts;
- the pre-signing verification logic in `packages/core/src/vault` (hashing, decoding, risk
  rules, authenticity and multi-source checks) and the transaction pipeline in
  `packages/core/src/tx.ts`;
- the web app's review, creation and wallet flows, and its security headers;
- the verifier and watcher tools.

Out of scope:
- bugs in Quai nodes, the public RPC endpoints or wallet extensions (report those to their
  maintainers; tell us if SafeBuddy should defend against them);
- attacks that need a quorum of a vault's own owners to act maliciously, which is by design;
- denial of service against public infrastructure;
- social engineering of maintainers or users;
- findings that depend only on outdated browsers.

## Safe harbour

We will not pursue good-faith research that:
- uses Orchard, a local chain or your own vaults;
- does not touch other people's vaults or funds;
- avoids privacy violations and service disruption;
- gives us reasonable time to fix before disclosure.

## Bug bounty

There is no bounty programme yet. One will be announced in this file before mainnet vault
creation is enabled.

See `docs/THREAT_MODEL.md` for what SafeBuddy defends against, and `docs/SECURITY_GUIDE.md`
for how owners should use it.
