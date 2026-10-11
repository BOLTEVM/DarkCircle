import { AbiCoder, concat, keccak256, toUtf8Bytes } from 'ethers';
import { agentPermit2BatcherInterface } from './abi.js';
import type { AgentSweptEvent, DigestSigner, RawSignature } from './permit.js';

/**
 * Off-chain Uniswap Permit2 (`ISignatureTransfer`) authorizations for
 * AgentPermit2Batcher.sol â€” the sibling of permit.ts for tokens without native ERC-2612
 * (most real Quai assets: WQUAI, USDT). See that contract's doc comment for the full design.
 *
 * Permit2 itself is not vendored anywhere in this workspace and this session has no network
 * access to fetch it, so the type strings and domain construction below are transcribed from
 * Uniswap's widely-published, stable SignatureTransfer spec, not verified against a locally-held
 * copy of the real contract â€” unlike permit.ts, which reads everything it needs (including the
 * domain separator) live from the token itself. Cross-check against the genuine deployed
 * Permit2 ABI before this is relied on for real funds; packages/contracts/contracts/test/
 * MockPermit2.sol exists only to test AgentPermit2Batcher's own logic against this same
 * understanding of the spec, not to prove it.
 *
 * Two real on-chain prerequisites neither this module nor the contract can skip:
 *  - Permit2 must actually be deployed on the target chain (no canonical cross-chain address
 *    applies to Quai's Cyprus-1 shard the way it does on ordinary EVM chains).
 *  - Each agent must send one ordinary `token.approve(permit2, amount)` once, before any of its
 *    Permit2 signatures can move that token.
 *
 * Two details that are easy to get wrong and worth stating explicitly:
 *  - Permit2's EIP-712 domain has no `version` field (unlike ERC-2612's, which usually does).
 *  - The signed digest commits to `spender` as whoever calls `permitTransferFrom` (msg.sender),
 *    not as a field of the on-chain struct the caller passes â€” so `spender` must still be given
 *    explicitly here to build the correct digest, even though it never appears in `BatchEntry`.
 */

const coder = AbiCoder.defaultAbiCoder();

export const PERMIT2_DOMAIN_TYPEHASH = keccak256(toUtf8Bytes('EIP712Domain(string name,uint256 chainId,address verifyingContract)'));
export const TOKEN_PERMISSIONS_TYPEHASH = keccak256(toUtf8Bytes('TokenPermissions(address token,uint256 amount)'));
export const PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
  toUtf8Bytes('PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)')
);

export function permit2DomainSeparator(permit2Address: string, chainId: number | bigint): string {
  return keccak256(
    coder.encode(['bytes32', 'bytes32', 'uint256', 'address'], [PERMIT2_DOMAIN_TYPEHASH, keccak256(toUtf8Bytes('Permit2')), chainId, permit2Address])
  );
}

export interface Permit2Fields {
  token: string;
  amount: bigint;
  spender: string;
  nonce: bigint;
  deadline: bigint;
}

/** The EIP-712 digest Permit2's SignatureTransfer recovers a signer from. */
export function permit2Digest(domainSeparator: string, f: Permit2Fields): string {
  const tokenPermissionsHash = keccak256(coder.encode(['bytes32', 'address', 'uint256'], [TOKEN_PERMISSIONS_TYPEHASH, f.token, f.amount]));
  const structHash = keccak256(
    coder.encode(
      ['bytes32', 'bytes32', 'address', 'uint256', 'uint256'],
      [PERMIT_TRANSFER_FROM_TYPEHASH, tokenPermissionsHash, f.spender, f.nonce, f.deadline]
    )
  );
  return keccak256(concat(['0x1901', domainSeparator, structHash]));
}

/** Packs (v, r, s) into the single 65-byte signature Permit2 expects. */
export function packPermit2Signature(sig: RawSignature): string {
  return concat([sig.r, sig.s, '0x' + sig.v.toString(16).padStart(2, '0')]);
}

/** A random 32-byte value, suitable as a Permit2 "unordered nonce" (any unused value works). */
export function randomPermit2Nonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n;
}

export interface SignedPermit2 extends Permit2Fields {
  /** The signer (Permit2's `owner` param) â€” separate from `spender`, and not part of the digest. */
  agent: string;
  signature: string;
}

/**
 * Signs a Permit2 authorization letting `spender` (the AgentPermit2Batcher deployment) pull up
 * to `amount` of `token` from the signer's own balance. Unlike signAgentPermit in permit.ts,
 * this never reads chain state itself (Permit2's domain separator is derived purely from its
 * address and the chain id, and its nonce is caller-chosen, not sequential) â€” callers should
 * still check `token.allowance(agent, permit2)` on chain before relying on a signature working.
 */
export function signAgentPermit2(
  signer: DigestSigner,
  permit2Address: string,
  chainId: number | bigint,
  params: { token: string; spender: string; amount: bigint; nonce?: bigint; deadline: bigint }
): SignedPermit2 {
  const domainSeparator = permit2DomainSeparator(permit2Address, chainId);
  const fields: Permit2Fields = {
    token: params.token,
    amount: params.amount,
    spender: params.spender,
    nonce: params.nonce ?? randomPermit2Nonce(),
    deadline: params.deadline,
  };
  const digest = permit2Digest(domainSeparator, fields);
  const signature = packPermit2Signature(signer.signingKey.sign(digest));
  return { ...fields, agent: signer.address, signature };
}

/** AgentPermit2Batcher.BatchEntry, in the field order the contract expects. */
export interface Permit2BatchEntry {
  token: string;
  agent: string;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
  signature: string;
}

/** A signed permit is exactly one batch entry; `spender` (always the batcher) is implicit. */
export function buildPermit2BatchEntry(signed: SignedPermit2): Permit2BatchEntry {
  return { token: signed.token, agent: signed.agent, amount: signed.amount, nonce: signed.nonce, deadline: signed.deadline, signature: signed.signature };
}

/** Calldata for AgentPermit2Batcher.batchPermit2Transfer, to propose via a MultisigBackend. */
export function encodeBatchPermit2Transfer(entries: readonly Permit2BatchEntry[]): string {
  return agentPermit2BatcherInterface.encodeFunctionData('batchPermit2Transfer', [
    entries.map((e) => [e.token, e.agent, e.amount, e.nonce, e.deadline, e.signature]),
  ]);
}

/** Decodes AgentSwept events from a batch's receipt (AgentPermit2Batcher shares the event shape with AgentPermitBatcher's AgentSweptEvent from permit.ts). */
export function parsePermit2AgentSweptLogs(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  batcher: string
): AgentSweptEvent[] {
  const out: AgentSweptEvent[] = [];
  for (const log of logs) {
    if (typeof log?.address !== 'string' || log.address.toLowerCase() !== batcher.toLowerCase()) continue;
    try {
      const parsed = agentPermit2BatcherInterface.parseLog({ topics: [...log.topics], data: log.data });
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
