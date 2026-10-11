import { AbiCoder, concat, keccak256, toUtf8Bytes } from 'ethers';
import { agentPermitBatcherInterface, erc20PermitInterface } from './abi.js';
import { RpcLike, callAt } from './rpc.js';

/**
 * Off-chain ERC-2612 permits for AgentPermitBatcher.sol (packages/contracts/contracts/v2/
 * AgentPermitBatcher.sol): an agent signs authorization for a token it holds without paying gas
 * or sending a transaction, and the vault later redeems a batch of these in one call. See that
 * contract's doc comment for the full design.
 *
 * The digest is built from the token's own on-chain `DOMAIN_SEPARATOR()` rather than a
 * reconstructed {name, version, chainId, verifyingContract} domain: OpenZeppelin's ERC20Permit
 * lets a token customise its EIP-712 version string, and re-deriving it here would be guessing.
 * Reading the separator directly is what the contract itself checks against, so it can never
 * disagree with what actually verifies on chain.
 */

const coder = AbiCoder.defaultAbiCoder();

/** keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)") */
export const PERMIT_TYPEHASH = keccak256(toUtf8Bytes('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));

export interface PermitState {
  domainSeparator: string;
  nonce: bigint;
}

/** Reads what a fresh permit for `owner` on `token` must commit to. */
export async function readPermitState(rpc: RpcLike, token: string, owner: string): Promise<PermitState> {
  const [sepRaw, nonceRaw] = await Promise.all([
    callAt(rpc, token, erc20PermitInterface.encodeFunctionData('DOMAIN_SEPARATOR')),
    callAt(rpc, token, erc20PermitInterface.encodeFunctionData('nonces', [owner])),
  ]);
  const domainSeparator = erc20PermitInterface.decodeFunctionResult('DOMAIN_SEPARATOR', sepRaw)[0] as string;
  const nonce = erc20PermitInterface.decodeFunctionResult('nonces', nonceRaw)[0] as bigint;
  return { domainSeparator, nonce };
}

export interface PermitFields {
  owner: string;
  spender: string;
  value: bigint;
  deadline: bigint;
}

/** The EIP-712 digest the token's `permit()` recovers a signer from. */
export function permitDigest(state: Pick<PermitState, 'domainSeparator' | 'nonce'>, f: PermitFields): string {
  const structHash = keccak256(
    coder.encode(
      ['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256'],
      [PERMIT_TYPEHASH, f.owner, f.spender, f.value, state.nonce, f.deadline]
    )
  );
  return keccak256(concat(['0x1901', state.domainSeparator, structHash]));
}

export interface RawSignature {
  v: number;
  r: string;
  s: string;
}

/**
 * The smallest signing surface this module needs. `ethers.Wallet`/`ethers.BaseWallet`
 * satisfy it (via `.signingKey`); an agent process holding a raw private key is the expected
 * caller, not a browser wallet extension — see the module doc comment on why this signs the
 * digest directly instead of going through `eth_signTypedData_v4`.
 */
export interface DigestSigner {
  address: string;
  signingKey: { sign(digest: string): RawSignature };
}

export interface SignedPermit extends PermitFields {
  token: string;
  v: number;
  r: string;
  s: string;
}

/**
 * Reads the token's current domain/nonce and signs a permit letting `spender` (the
 * batcher) move up to `value` of `token` out of the signer's own balance.
 */
export async function signAgentPermit(
  rpc: RpcLike,
  signer: DigestSigner,
  params: { token: string; spender: string; value: bigint; deadline: bigint }
): Promise<SignedPermit> {
  const state = await readPermitState(rpc, params.token, signer.address);
  const fields: PermitFields = { owner: signer.address, spender: params.spender, value: params.value, deadline: params.deadline };
  const digest = permitDigest(state, fields);
  const sig = signer.signingKey.sign(digest);
  return { token: params.token, ...fields, v: sig.v, r: sig.r, s: sig.s };
}

/** AgentPermitBatcher.BatchEntry, in the field order the contract expects. */
export interface BatchEntry {
  token: string;
  agent: string;
  amount: bigint;
  deadline: bigint;
  v: number;
  r: string;
  s: string;
}

/** A signed permit is exactly one batch entry; `spender` (always the batcher) is implicit. */
export function buildBatchEntry(signed: SignedPermit): BatchEntry {
  return { token: signed.token, agent: signed.owner, amount: signed.value, deadline: signed.deadline, v: signed.v, r: signed.r, s: signed.s };
}

/** Calldata for AgentPermitBatcher.batchPermitTransfer, to propose via `vaultCalls.propose`. */
export function encodeBatchPermitTransfer(entries: readonly BatchEntry[]): string {
  return agentPermitBatcherInterface.encodeFunctionData('batchPermitTransfer', [
    entries.map((e) => [e.token, e.agent, e.amount, e.deadline, e.v, e.r, e.s]),
  ]);
}

/** Decodes AgentSwept events from a batch's receipt, in the order the batcher emitted them. */
export interface AgentSweptEvent {
  token: string;
  agent: string;
  amount: bigint;
  ok: boolean;
}

export function parseAgentSweptLogs(logs: readonly { address: string; topics: readonly string[]; data: string }[], batcher: string): AgentSweptEvent[] {
  const out: AgentSweptEvent[] = [];
  for (const log of logs) {
    if (typeof log?.address !== 'string' || log.address.toLowerCase() !== batcher.toLowerCase()) continue;
    try {
      const parsed = agentPermitBatcherInterface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'AgentSwept') {
        out.push({
          token: String(parsed.args.token),
          agent: String(parsed.args.agent),
          amount: BigInt(parsed.args.amount),
          ok: Boolean(parsed.args.ok),
        });
      }
    } catch {
      // not the batcher's event
    }
  }
  return out;
}
