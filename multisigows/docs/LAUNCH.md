# Launch gates

DarkSafe v2 reaches mainnet only through these gates, in order. Each one names who does it and
how we know it is done. Status as of 2026-09-28.

| # | Gate | Who | Status |
|---|---|---|---|
| G1 | v2 contracts, core library, app, verifier and watcher built and tested (unit, fuzz, invariants, TypeScript-vs-Solidity differential, local end-to-end soak) | Maintainers | **Done** |
| G2 | Deploy the implementation and factory to Orchard from an encrypted keystore; commit `deployments/v2-orchard.json` and the regenerated `pinned.ts` | Deployer | Open |
| G3 | Orchard soak passes with three funded owner keystores; commit the report `deployments/soak-orchard-*.json` and review the used/estimate gas ratios | Maintainers | Open (needs G2) |
| G4 | Verify the source of the implementation and factory on the Orchard explorer (`pnpm -F @darksafe/contracts verification:export --network orchard`) | Maintainers | Open (needs G2) |
| G5 | Private vulnerability reporting enabled on GitHub (Settings → Code security) so `SECURITY.md` works | Repository admin | Open |
| G6 | Tag the audit candidate (`v2.0.0-rc.1`) and hand over `docs/AUDIT_SCOPE.md` | Maintainers | Open (auditor to be chosen) |
| G7 | Independent audit complete; every finding fixed or accepted in writing; final tag `v2.0.0` | Auditor + maintainers | Open |
| G8 | Bug bounty terms published in `SECURITY.md` | Maintainers | Open |
| G9 | Mainnet deploy from the `v2.0.0` checkout (`deploy:mainnet --keystore <file> --broadcast --mainnet-audited v2.0.0`), ideally from a hardware-backed key; verify the source on the explorer; commit the record | Deployer | Open (needs G7) |
| G10 | Dogfood on mainnet with the team's own vault and small amounts for an agreed period, with `darksafe-watch` alerting | Maintainers | Open (needs G9) |
| G11 | Build the public app with `VITE_ALLOW_MAINNET_VAULTS=true` and remove the beta wording | Maintainers | Open (needs G8, G10) |

## Running G2 and G3

Both steps need Orchard QUAI from the faucet. The script never reads a key from an environment
variable or a flag.

```bash
cd packages/contracts
pnpm keystore:new --out ~/keys/deployer.keystore.json              # prints the address to fund
pnpm deploy:testnet --from <deployer address>                      # simulate (no key needed)
pnpm deploy:testnet --keystore ~/keys/deployer.keystore.json --broadcast
git add deployments/v2-orchard.json ../core/src/pinned.ts             # review, then commit

for n in a b c; do pnpm keystore:new --out ~/keys/soak-$n.keystore.json; done   # fund each
pnpm soak:testnet --owners ~/keys/soak-a.keystore.json,~/keys/soak-b.keystore.json,~/keys/soak-c.keystore.json
# Orchard blocks can be many minutes apart; if it stops, rerun the same command with --resume.
```

Budget:
- **Deploy:** about 18 M gas worst case (limits are sized at 1,250 gas per runtime byte: 14.3 M
  for the implementation, 3.9 M for the factory). Actual use is lower. The simulate command prints
  the worst case at the current gas price.
- **Soak:** about 31 transactions of 40k–400k gas each, plus the 0.02 QUAI it moves through the
  vault.

Once G2 is committed, the app finds the factory by itself; no `VITE_V2_FACTORY_ADDRESS` is
needed.
