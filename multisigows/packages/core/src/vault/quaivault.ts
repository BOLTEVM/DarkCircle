import { Interface } from 'ethers';

/**
 * QuaiVault (github.com/Quai-Vault) is a separate multisig product on Quai Cyprus-1, not this
 * workspace's DarkSafeVault. Its own core `QuaiVault.sol` source is not vendored anywhere this
 * workspace can read, so this ABI is not derived from source the way DarkSafeVault's is â€” it is
 * transcribed function-by-function from the official SDK's typed contract wrapper
 * (`quai-vault/quaivault-sdk`, `src/chain/vault-contract.ts`: every `.read()`/`.write()` call
 * there names the exact Solidity signature it invokes), cross-checked against
 * `src/config/networks.ts`'s pinned mainnet addresses. Treat it as "what the SDK itself calls",
 * not as independently audited: verify against the live deployed bytecode/explorer ABI before
 * this is used for a real proposal.
 *
 * Deliberately partial: only the read/write surface AgentPermitBatcherBackend (backend.ts) needs
 * to propose, approve and execute a call through a QuaiVault instance. Module management
 * (IAvatar/execTransactionFromModule), EIP-1271, and social recovery are out of scope here.
 */
export const QUAI_VAULT_ABI = [
  'function getOwners() view returns (address[])',
  'function isOwner(address owner) view returns (bool)',
  'function threshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function minExecutionDelay() view returns (uint256)',
  // Confirmed callable as a plain view, so a proposal's hash is read from the vault itself
  // rather than reconstructed client-side against an unverified hashing formula.
  'function getTransactionHash(address to, uint256 value, bytes data, uint256 nonce) view returns (bytes32)',
  'function hasApproved(bytes32 txHash, address owner) view returns (bool)',
  // Two real overloads (vault-contract.ts: proposeTransactionSimple / proposeTransactionFull).
  // Their Solidity return value is not decoded anywhere here; the hash always comes from the
  // getTransactionHash view above instead, so it does not matter whether this signature's
  // declared return type is exact.
  'function proposeTransaction(address to, uint256 value, bytes data)',
  'function proposeTransaction(address to, uint256 value, bytes data, uint48 expiration, uint32 executionDelay)',
  'function approveTransaction(bytes32 txHash)',
  'function executeTransaction(bytes32 txHash)',
  'function approveAndExecute(bytes32 txHash)',
  'function revokeApproval(bytes32 txHash)',
] as const;

export const quaiVaultInterface = new Interface(QUAI_VAULT_ABI);

/** The SDK's own pinned addresses (src/config/networks.ts), for reference/testing only. */
export const QUAI_VAULT_NETWORKS = {
  mainnet: {
    chainId: 9,
    factory: '0x003613aC5FFd45bFF7B2F0210DA2fF660908c488',
    implementation: '0x0038E6d84412A10CdcE41b0f62A05350023f1fb6',
  },
  testnet: {
    chainId: 15000,
    factory: '0x002d1305D597c157bB975967FA2e5337674b0E5F',
    implementation: '0x004E539Cf477A5Cb456A56023f083cD91Bc4934e',
  },
} as const;
