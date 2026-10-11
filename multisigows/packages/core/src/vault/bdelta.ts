import { Interface } from 'ethers';

/**
 * Calldata for BOLTDEXV2 (bdelta, a separate repo/product), so a multisig-approved proposal
 * can fund it â€” e.g. after AgentPermitBatcher sweeps agent-signed permits into the vault
 * (permit.ts), the owners can separately propose a deposit of that swept balance into bdelta.
 *
 * This mirrors exactly the two entry points `depositV2` uses in
 * bdelta/apps/web/src/services/vaultV2.ts (`depositNative()` for native QUAI,
 * `depositToken(address,uint256)` for an already-approved ERC-20) rather than taking a
 * cross-repo dependency on bdelta's full vault ABI. An ERC-20 deposit still needs a prior
 * `approve(bdeltaVault, amount)` from the same address making the deposit â€” encode that with
 * `erc20Interface.encodeFunctionData('approve', [bdeltaVault, amount])` from ./abi.js and
 * propose it first (or in the same MultiSend batch, where the backend supports one).
 */
const BDELTA_VAULT_V2_ABI = ['function depositNative() payable', 'function depositToken(address token, uint256 amount)'] as const;

export const bdeltaVaultInterface = new Interface(BDELTA_VAULT_V2_ABI);

export const bdeltaCalls = {
  depositNative: (): string => bdeltaVaultInterface.encodeFunctionData('depositNative'),
  depositToken: (token: string, amount: bigint): string => bdeltaVaultInterface.encodeFunctionData('depositToken', [token, amount]),
};
