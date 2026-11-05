# QUAI Liquid Staking Pools — Implementation Plan

**Status:** Proposed  
**Target:** Quai Network, Cyprus-1  
**Repository scope:** `packages/contracts`, `packages/quai-service`, `apps/stats-app`

## 1. Product decision

Build a pooled QUAI yield vault that issues a transferable, non-rebasing receipt token, **stQUAI**. Add a native `stQUAI/WQUAI` Circleswap market so the receipt token remains liquid, and optionally incentivize that LP through the existing farm.

This is **not native consensus staking**. Quai uses proof-of-work, so there is no validator-delegation yield to wrap. The product must name and disclose its actual yield source before launch. Until a strategy is live, show an exchange rate and accrued yield of zero, never an estimated APY. Reference: [Quai Network, “Quainance is Now Live”](https://www.qu.ai/blog/quainance-is-now-live).

### v1 user flows

1. **Stake QUAI:** deposit native QUAI; the vault wraps it to WQUAI and mints stQUAI to the depositor.
2. **Hold or transfer stQUAI:** the stQUAI balance stays fixed; each share represents more QUAI when the strategy earns.
3. **Provide liquidity:** add stQUAI plus native QUAI/WQUAI to Circleswap and receive LP tokens.
4. **Exit through the protocol:** burn stQUAI into a withdrawal request, wait for the strategy-derived cooldown, then claim native QUAI.
5. **Exit through the market:** swap stQUAI through the AMM immediately at the market price, which may differ from the protocol redemption value.

v1 has one shared vault and one receipt token. Do not add lock-duration tiers or multiple strategies sharing stQUAI; different risk and liquidity terms require separately named vaults and receipt tokens.

## 2. Existing code to reuse

- `CircleswapRouter` already wraps native QUAI into WQUAI and supports the required swap and liquidity entry points.
- `apps/stats-app/src/PoolModal.tsx` already creates pairs and adds/removes native-QUAI liquidity.
- `packages/quai-service/src/liquidity.ts` already provides allowance reads, approval encoding, transaction preparation, and slippage helpers.
- `App.tsx` already verifies DEX code and refreshes reserves before swaps.
- `CircleswapMasterChef` can incentivize stQUAI/WQUAI LP without changing its principal/reward accounting.
- The existing deployment, artifact-export, code-integrity, Hardhat, Foundry, and Slither patterns should cover the new vault too.

Do not repurpose `CircleswapMasterChef` as the liquid-staking vault: it tracks principal and emissions, not a changing share-to-asset exchange rate or delayed redemption claims.

## 3. Contract architecture

### 3.1 New files

```text
packages/contracts/contracts/staking/StQuai.sol
packages/contracts/contracts/staking/QuaiLiquidStaking.sol
packages/contracts/contracts/staking/interfaces/IQuaiYieldStrategy.sol
packages/contracts/test/LiquidStaking.test.ts
packages/contracts/test/foundry/LiquidStakingFuzz.t.sol
packages/contracts/test/foundry/LiquidStakingInvariant.t.sol
```

### 3.2 `StQuai`

- Standard 18-decimal ERC-20 receipt token; no rebasing, transfer tax, blacklist, or owner minting.
- Immutable vault address; only that vault may mint or burn.
- Name and symbol are fixed at deployment.
- Ordinary transfers do not change the vault exchange rate or create claims.

### 3.3 `QuaiLiquidStaking`

Use WQUAI as the internal accounting asset and native QUAI only at the user boundary.

Core interface:

```solidity
function depositNative(uint256 minShares, uint256 deadline)
    external payable returns (uint256 shares);
function depositWquai(uint256 assets, uint256 minShares, uint256 deadline)
    external returns (uint256 shares);
function requestWithdrawal(uint256 shares, uint256 minAssets, address receiver)
    external returns (uint256 requestId, uint256 assets);
function processWithdrawals(uint256 maxRequests) external;
function claimWithdrawal(uint256 requestId) external returns (uint256 assets);
function previewDeposit(uint256 assets) external view returns (uint256 shares);
function previewRedeem(uint256 shares) external view returns (uint256 assets);
function totalManagedAssets() public view returns (uint256 assets);
```

Accounting:

```text
totalManagedAssets = idle WQUAI + strategy assets - outstanding claim liabilities
shares on deposit  = assets × share supply / total managed assets
assets on exit     = shares × total managed assets / share supply
```

Use full-precision `Math.mulDiv`, ERC-4626-style virtual offsets, and an initial locked seed to make first-depositor share inflation impractical. Define rounding in the vault’s favor and reject zero-share deposits and zero-asset redemptions.

Withdrawal requests:

- Burn the shares and fix the request’s asset amount at request time; require `assets >= minAssets`.
- Store `receiver`, `assets`, `claimableAt`, and `claimed` for each request.
- Add the assets to outstanding claim liabilities so later yield or loss does not revalue an already-fixed claim.
- Derive the cooldown from the selected strategy’s real exit time. Do not invent a fixed delay before that strategy is chosen.
- `processWithdrawals` pulls only what is needed from the strategy and prepares due claims; bound its work by `maxRequests`.
- `claimWithdrawal` unwraps WQUAI and sends native QUAI only to the recorded receiver. It must be non-reentrant and impossible to claim twice.
- If liquid funds are insufficient, the UI shows “processing/awaiting liquidity”; it must not imply that a claim has completed.

Native-asset safety:

- Accept native QUAI only through `depositNative` and WQUAI unwrapping; reject other direct transfers.
- Use the existing pinned WQUAI address and verify its code/decimals during deployment.
- WQUAI deposits require an exact-amount approval to the **vault**, not the AMM router.

### 3.4 Yield strategy boundary

```solidity
interface IQuaiYieldStrategy {
    function totalAssets() external view returns (uint256);
    function deposit(uint256 assets) external;
    function withdraw(uint256 assets) external returns (uint256 received);
}
```

The strategy reports WQUAI-denominated principal plus realized yield. The vault must tolerate negative performance; stQUAI is not a guaranteed 1:1 peg.

Before implementation, choose one launch strategy and document:

- Where yield comes from and why it is sustainable.
- Deposit/withdraw mechanics, lockup, fees, loss scenarios, and smart-contract dependencies.
- How `totalAssets` is calculated without manipulation or double counting.
- Whether harvested rewards are streamed over time to prevent deposit sandwiches around a large reward credit.

An idle-WQUAI adapter is useful for tests but is not a yield-producing launch strategy. Treasury incentives, if desired, should be a separately disclosed, time-bounded rewards stream rather than presented as protocol staking yield.

### 3.5 Administration and emergency behavior

- Prefer a non-upgradeable vault. If upgradeability is necessary, use the existing timelock pattern and append-only storage checks.
- Strategy migration, buffer targets, and any fee parameters require timelock governance and explicit bounds.
- Pause new deposits and new strategy allocations in an emergency; do not disable claims whose assets are already liquid.
- No admin function may seize user WQUAI, native QUAI, stQUAI, or pending claims.
- Keep any protocol fee explicit, capped, and included in the displayed net exchange rate. v1 can launch with zero fee.

## 4. Service and registry integration

### 4.1 New modules

```text
packages/quai-service/src/liquidStakingMath.ts
packages/quai-service/src/liquidStaking.ts
packages/quai-service/test/liquidStaking.test.ts
apps/stats-app/src/useLiquidStaking.ts
```

`liquidStakingMath.ts` contains deterministic BigInt-only conversions and withdrawal previews. Mirror contract rounding exactly and test parity against Solidity.

`liquidStaking.ts` provides:

- Vault metadata, total managed assets, stQUAI supply, exchange rate, strategy assets, idle buffer, and claim liabilities.
- Wallet QUAI/WQUAI/stQUAI balances and vault WQUAI allowance.
- Deposit, withdrawal-request, processing, and claim calldata encoders.
- Request enumeration/status for the connected wallet, backed by events plus current contract state.
- A snapshot type that carries the block number and distinguishes “zero” from “not available.”

Export these modules from `packages/quai-service/src/index.ts`.

### 4.2 Registry changes

Extend `registries/deployed.ts` and the deployment record renderer with:

```text
STQUAI
LIQUID_STAKING
LIQUID_STAKING_STRATEGY
```

Add stQUAI to `registries/tokens.ts` only after a real address exists; use `deployed: DEPLOYED.STQUAI !== null` so a placeholder is never queried.

Add `{ dex: 'CIRCLESWAP', tokens: ['STQUAI', 'WQUAI'] }` to candidate pools and let existing Circleswap discovery resolve the pair after creation. Add the LP to the farm registry only when its real pair address and intended allocation are known.

Price stQUAI for portfolio and vault displays as:

```text
stQUAI/QUAI protocol rate × QUAI/USD reference price
```

Do not use the stQUAI/WQUAI spot price as the canonical protocol redemption rate. Label AMM price, protocol rate, and any premium/discount separately.

## 5. Frontend plan

Add a **Liquid Staking** tab and `#staking` route in `App.tsx`, with a lazy-loaded `LiquidStakingPage.tsx` protected by `SectionBoundary`.

The page contains:

1. **Overview:** total QUAI managed, stQUAI supply, protocol stQUAI/QUAI rate, realized performance over a defined period, idle liquidity, pending claim liabilities, and named yield strategy.
2. **Stake:** native QUAI by default, optional WQUAI input, live stQUAI preview, minimum-shares control, deadline, balance check, and transaction status.
3. **Withdraw:** stQUAI input, fixed QUAI request preview, cooldown disclosure, request transaction, and a list of pending/ready/claimed requests.
4. **Liquidity:** stQUAI/WQUAI protocol rate versus AMM rate, pool reserves, price impact, and a button opening the existing liquidity modal.
5. **Risks and contracts:** strategy address, vault address, source of yield, cooldown, loss possibility, and the distinction between protocol redemption and an AMM sale.

Reuse `prepareContractCall` before every state-changing operation. Refresh the exchange rate and request status at signing time, not only when the page loads. Never display an APY from token emissions, AMM price movement, or an unlaunched strategy.

Optional after the core flow is stable: add the stQUAI/WQUAI LP to Farms with its own reward allocation and clearly separate farm APR from vault performance.

## 6. Unlimited AMM-router approvals

Implement **unlimited (`type(uint256).max`) token approvals for verified, configured AMM routers** in the existing swap and liquidity flows. This includes stQUAI approvals when users trade or pool it. Farm and vault approvals remain exact-amount.

### 6.1 Shared constant and helper

In `packages/quai-service/src/liquidity.ts` add:

```ts
export const MAX_UINT256 = (1n << 256n) - 1n;
```

Keep `encodeApprove(spender, amount)` unchanged for exact-amount consumers and ABI parity. Use `encodeApprove(router, MAX_UINT256)` at the three router-approval call sites:

- `apps/stats-app/src/App.tsx`: swap input approval.
- `apps/stats-app/src/PoolModal.tsx`: token A/token B add-liquidity approvals.
- `apps/stats-app/src/PoolModal.tsx`: LP-token remove-liquidity approval.

Retain the current `allowance < requiredAmount` check. A max allowance then covers later operations without another approval. Native QUAI operations need no ERC-20 approval.

For the existing permit-based router functions, pass `approveMax = true` only when the UI deliberately chooses the same unlimited-approval behavior.

### 6.2 Required safeguards

- Resolve routers only from `DEXES`/the generated Circleswap deployment record; never approve a router address typed by a user.
- Re-run the existing router/factory code-integrity check immediately before the first max approval, including add/remove liquidity, not only swaps.
- On integrity failure or unknown router code, block both approval and the parent operation.
- Wallet copy must say **“Approve unlimited [TOKEN] spending by [DEX] router”** and identify the router address.
- Explain that the approval persists after the transaction and can be revoked with `approve(router, 0)`. Add a small “Manage router approvals” action showing current allowances and offering revocation.
- Do not request approval when native QUAI is the input or when current allowance already covers the operation.
- Preserve fresh quotes, slippage limits, deadlines, recipient checks, and post-approval simulation; max approval is not a substitute for any of them.

**Risk accepted by this requirement:** a compromised approved token or upgraded/compromised router could spend the wallet’s present and future balance of that approved token until revocation. The approval does not expose unrelated tokens or native QUAI. The existing router timelock/permanence warnings become more important, not less.

## 7. Testing and acceptance criteria

### 7.1 Contract tests

Hardhat scenarios:

- First deposit, multiple depositors, stQUAI transfers, proportional appreciation, and realized losses.
- Native deposit and WQUAI deposit produce equivalent shares at the same rate.
- Zero amounts, dust, min-share/min-asset failures, expired deadlines, invalid receivers, and unauthorized mint/burn.
- Request → process → claim lifecycle, cooldown enforcement, double-claim rejection, and receiver-only payout.
- Claims retain their fixed value through later yield and loss.
- Strategy shortfall/withdrawal failure leaves accurate pending state and never pays principal twice.
- Pause, strategy migration, reentrancy attempts, and unexpected native transfers.

Foundry invariants:

```text
share liabilities + fixed claim liabilities are fully accounted for
no deposit/withdraw round trip creates assets from rounding
no user can claim the same assets twice
fixed claims do not dilute remaining shares
total managed assets never double-counts claim reserves
all native QUAI/WQUAI movements reconcile to the nearest specified rounding
```

Run the existing mutation-testing approach against conversion rounding, claim accounting, cooldown checks, and strategy valuation.

### 7.2 Service and UI tests

- Solidity/TypeScript conversion parity at dust, very large values, empty supply, and profit/loss boundaries.
- Max approval encoding equals `approve(router, 2^256 - 1)`.
- A max-approved wallet skips approval on later swaps, adds, and removals.
- Each of the three router flows requests max rather than the transaction amount when allowance is short.
- Unknown/changed router code blocks max approval.
- Farm and vault approvals remain exact-amount.
- Revocation sends zero allowance and subsequent actions request approval again.
- Pending withdrawals never appear claimable early; failed RPC reads never display as zero balances or zero liabilities.

### 7.3 Required checks

```bash
pnpm --filter contracts test
pnpm --filter contracts test:forge
pnpm --filter contracts test:forge:deep
pnpm --filter contracts slither
pnpm --filter contracts check:layout
pnpm --recursive build
```

Add live read-only probes for vault deployment, native deposit simulation, withdrawal simulation, and the stQUAI/WQUAI pair before broadcast. Complete an independent security audit before holding material third-party funds.

## 8. Deployment sequence

1. **Resolve the yield-source launch blocker** and set the withdrawal cooldown from its exit mechanics.
2. Deploy the strategy, vault, and stQUAI using a dry-run-first, resumable `liquidStakingFlow`; verify code, immutable addresses, ownership, and initial parameters from receipts and chain reads.
3. Seed the vault’s locked initial liquidity and verify the initial exchange rate.
4. Generate browser artifacts and deployment records; register stQUAI and the new contract addresses.
5. Create `stQUAI/WQUAI` on Circleswap through the existing pool flow. Seed a disclosed amount at the protocol rate; do not present the initial AMM price as independent validation of that rate.
6. Optionally add the LP to MasterChef with a deliberate allocation and funded rewards.
7. Enable the staking page in read-only mode, compare service reads with direct RPC, then enable deposits and withdrawals.
8. Monitor exchange-rate changes, idle liquidity, pending claims, strategy health, router governance queue, and approval-relevant upgrades.

## 9. Delivery milestones

| Milestone | Deliverable | Exit condition |
|---|---|---|
| M1 — Specification | Yield-source and withdrawal policy | Strategy, risks, cooldown, valuation, and loss behavior signed off |
| M2 — Contracts | stQUAI, vault, strategy adapter | Unit/fuzz/invariant suites pass; accounting invariants documented |
| M3 — Client | Service reads/encoders and staking page | Full stake/request/claim flow passes against a local Cyprus-1-compatible test deployment |
| M4 — AMM | stQUAI/WQUAI pool and max router approvals | Swap/add/remove tests pass; integrity and revocation safeguards pass |
| M5 — Deployment | Dry-run and resumable deployment tooling | Receipt verification, registry generation, and live read-only probes pass |
| M6 — Launch | Audit, seeded liquidity, monitoring | Audit issues resolved; no misleading APY; withdrawal liquidity and governance monitoring operational |

## 10. Explicit non-goals for v1

- No claim of native validator staking or protocol-guaranteed yield.
- No rebasing stQUAI or algorithmic 1:1 peg.
- No cross-shard vault accounting.
- No unlimited approvals for farms, the staking vault, or arbitrary user-supplied spenders.
- No automatic compounding into the AMM LP that would obscure the underlying stQUAI redemption rate.
