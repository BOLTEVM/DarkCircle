import { Interface } from 'ethers';

/**
 * ABIs of the SafeBuddy v2 contracts. They must match the compiled artifacts exactly;
 * packages/contracts/test/v2/core-integration.test.ts fails if they drift.
 */
export const VAULT_V2_ABI = [
  'constructor()',
  'error AlreadyApproved()',
  'error AlreadyInitialized()',
  'error CannotCancelApprovedTransaction()',
  'error DuplicateOwner(address owner)',
  'error ExecutionDelayTooLong()',
  'error ExpirationTooFar()',
  'error ExpirationTooSoon()',
  'error InsufficientBalance(uint256 balance, uint256 value)',
  'error InsufficientGas(uint256 available, uint256 required)',
  'error InvalidDestination()',
  'error InvalidGasLimit()',
  'error InvalidOwnerAddress(address owner)',
  'error InvalidPagination()',
  'error InvalidThreshold()',
  'error NotAnOwner()',
  'error NotApproved()',
  'error NotEnoughApprovals(uint256 approvals, uint256 required)',
  'error NotProposer()',
  'error OnlySelf()',
  'error OwnersRequired()',
  'error ReentrancyGuardReentrantCall()',
  'error SelfCallFailed(bytes returnData)',
  'error SelfCallValueNotAllowed()',
  'error TimelockNotElapsed(uint256 executableAfter)',
  'error TooManyOwners()',
  'error TransactionAlreadyCancelled()',
  'error TransactionAlreadyExecuted()',
  'error TransactionAlreadyExpired()',
  'error TransactionIsExpired()',
  'error TransactionNotExpired()',
  'error TransactionNotFound()',
  'error UnrecognizedSelfCall(bytes4 selector)',
  'event ApprovalRevoked(bytes32 indexed txHash, address indexed owner)',
  'event MinExecutionDelayChanged(uint32 oldDelay, uint32 newDelay)',
  'event OwnerAdded(address indexed owner)',
  'event OwnerRemoved(address indexed owner)',
  'event Received(address indexed sender, uint256 value)',
  'event ThresholdChanged(uint256 threshold)',
  'event ThresholdReached(bytes32 indexed txHash, uint64 approvedAt, uint64 executableAfter)',
  'event TransactionApproved(bytes32 indexed txHash, address indexed owner)',
  'event TransactionCancelled(bytes32 indexed txHash, address indexed canceller)',
  'event TransactionExecuted(bytes32 indexed txHash, address indexed executor)',
  'event TransactionExpired(bytes32 indexed txHash)',
  'event TransactionFailed(bytes32 indexed txHash, address indexed executor, bytes returnData)',
  'event TransactionProposed(bytes32 indexed txHash, address indexed proposer, address indexed to, uint256 value, bytes data, uint64 gasLimit, uint64 expiration, uint32 executionDelay)',
  'event VaultInitialized(address[] owners, uint256 threshold, uint32 minExecutionDelay)',
  'function MAX_EXECUTION_DELAY() view returns (uint32)',
  'function MAX_EXECUTION_WINDOW() view returns (uint64)',
  'function MAX_OWNERS() view returns (uint256)',
  'function MAX_RETURNDATA() view returns (uint256)',
  'function MAX_TX_GAS() view returns (uint64)',
  'function VERSION() view returns (string)',
  'function addOwner(address owner, uint256 newThreshold)',
  'function approveTransaction(bytes32 txHash)',
  'function cancelByConsensus(bytes32 txHash)',
  'function cancelTransaction(bytes32 txHash)',
  'function changeThreshold(uint256 newThreshold)',
  'function executeTransaction(bytes32 txHash) returns (bool ran)',
  'function expireTransaction(bytes32 txHash)',
  'function getApprovalCount(bytes32 txHash) view returns (uint256)',
  'function getApprovals(bytes32 txHash) view returns (address[] approvers)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function getTransaction(bytes32 txHash) view returns ((address to, uint64 gasLimit, uint32 executionDelay, uint256 value, address proposer, uint64 proposedAt, uint64 expiration, uint64 approvedAt, bool executed, bool failed, bool cancelled, bool expired, bytes data))',
  'function getTransactionCount() view returns (uint256)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint64 gasLimit, uint64 expiration, uint32 executionDelay, uint256 nonce_) view returns (bytes32)',
  'function getTransactionHashes(uint256 offset, uint256 limit) view returns (bytes32[] page)',
  'function hasApproved(bytes32 txHash, address owner) view returns (bool)',
  'function initialize(address[] owners_, uint256 threshold_, uint32 minExecutionDelay_)',
  'function isOwner(address) view returns (bool)',
  'function minExecutionDelay() view returns (uint32)',
  'function ownerEpoch(address) view returns (uint256)',
  'function proposeTransaction(address to, uint256 value, bytes data, uint64 gasLimit, uint64 expiration, uint32 requestedDelay) returns (bytes32 txHash)',
  'function removeOwner(address owner, uint256 newThreshold)',
  'function revokeApproval(bytes32 txHash)',
  'function setMinExecutionDelay(uint32 newDelay)',
  'function status(bytes32 txHash) view returns (uint8)',
  'function threshold() view returns (uint256)',
  'function txNonce() view returns (uint256)',
] as const;

export const VAULT_FACTORY_V2_ABI = [
  'constructor(address implementation_)',
  'error InvalidImplementation()',
  'event WalletCreated(address indexed wallet, address indexed creator, address[] owners, uint256 threshold, uint32 minExecutionDelay, bytes32 salt)',
  'function createWallet(address[] owners, uint256 threshold, uint32 minExecutionDelay, bytes32 salt) returns (address wallet)',
  'function implementation() view returns (address)',
  'function isWallet(address) view returns (bool)',
  'function predictWalletAddress(address creator, address[] owners, uint256 threshold, uint32 minExecutionDelay, bytes32 salt) view returns (address)',
  'function proxyCodeHash() view returns (bytes32)',
  'function walletCount() view returns (uint256)',
] as const;

export const VAULT_PROXY_V2_ABI = [
  'constructor(address implementation, bytes initData)',
  'error AddressEmptyCode(address target)',
  'error ERC1967InvalidImplementation(address implementation)',
  'error ERC1967NonPayable()',
  'error FailedCall()',
  'event Received(address indexed sender, uint256 value)',
  'event Upgraded(address indexed implementation)',
  'fallback() payable',
  'function getImplementation() view returns (address)',
  'receive() payable',
] as const;

export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
] as const;

/** The EIP-2612 surface. Most third-party Quai tokens (WQUAI, USDT) do not implement this. */
export const ERC20_PERMIT_ABI = [
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
] as const;

/** Mirrors AgentPermitBatcher.sol (packages/contracts/contracts/v2/AgentPermitBatcher.sol). */
export const AGENT_PERMIT_BATCHER_ABI = [
  'constructor(address vault_)',
  'error ZeroVault()',
  'error OnlyVault()',
  'error OnlySelf()',
  'event AgentSwept(address indexed token, address indexed agent, uint256 amount, bool ok)',
  'function vault() view returns (address)',
  'function batchPermitTransfer((address token, address agent, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)[] entries) returns (bool[] ok)',
  'function sweepOne((address token, address agent, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) e) returns (bool)',
] as const;

/**
 * Mirrors AgentPermit2Batcher.sol (packages/contracts/contracts/v2/AgentPermit2Batcher.sol) â€”
 * the Permit2 sibling of AgentPermitBatcher, for tokens without native ERC-2612.
 */
export const AGENT_PERMIT2_BATCHER_ABI = [
  'constructor(address vault_, address permit2_)',
  'error ZeroVault()',
  'error ZeroPermit2()',
  'error OnlyVault()',
  'error OnlySelf()',
  'event AgentSwept(address indexed token, address indexed agent, uint256 amount, bool ok)',
  'function vault() view returns (address)',
  'function permit2() view returns (address)',
  'function batchPermit2Transfer((address token, address agent, uint256 amount, uint256 nonce, uint256 deadline, bytes signature)[] entries) returns (bool[] ok)',
  'function sweepOne((address token, address agent, uint256 amount, uint256 nonce, uint256 deadline, bytes signature) e) returns (bool)',
] as const;

export const vaultInterface = new Interface(VAULT_V2_ABI);
export const factoryInterface = new Interface(VAULT_FACTORY_V2_ABI);
export const proxyInterface = new Interface(VAULT_PROXY_V2_ABI);
export const erc20Interface = new Interface(ERC20_ABI);
export const erc20PermitInterface = new Interface(ERC20_PERMIT_ABI);
export const agentPermitBatcherInterface = new Interface(AGENT_PERMIT_BATCHER_ABI);
export const agentPermit2BatcherInterface = new Interface(AGENT_PERMIT2_BATCHER_ABI);

/** Order matches SafeBuddyVault.TxStatus. */
export const TX_STATUSES = [
  'None',
  'Pending',
  'Timelocked',
  'Executable',
  'Executed',
  'Failed',
  'Cancelled',
  'Expired',
] as const;
export type TxStatusName = (typeof TX_STATUSES)[number];

/** The only self-calls the vault accepts (SafeBuddyVault._requireAdminSelector). */
export const ADMIN_FUNCTIONS = [
  'addOwner',
  'removeOwner',
  'changeThreshold',
  'setMinExecutionDelay',
  'cancelByConsensus',
] as const;
export type AdminFunction = (typeof ADMIN_FUNCTIONS)[number];

/** Mirrors the vault's constants (checked against the contract by the integration test). */
export const VAULT_LIMITS = {
  MAX_OWNERS: 20,
  MAX_EXECUTION_DELAY: 30 * 24 * 60 * 60,
  MAX_EXECUTION_WINDOW: 30 * 24 * 60 * 60,
  MAX_TX_GAS: 30_000_000n,
  VERSION: '2.0.0',
} as const;

/** ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1). */
export const ERC1967_IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
