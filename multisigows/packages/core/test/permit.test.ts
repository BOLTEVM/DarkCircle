import { describe, it, expect } from 'vitest';
import { AbiCoder, Wallet, getAddress, keccak256, recoverAddress, toUtf8Bytes } from 'ethers';
import {
  PERMIT_TYPEHASH,
  readPermitState,
  permitDigest,
  signAgentPermit,
  buildBatchEntry,
  encodeBatchPermitTransfer,
  parseAgentSweptLogs,
  agentPermitBatcherInterface,
  erc20PermitInterface,
  RpcLike,
  PermitState,
} from '../src/index.js';

const TOKEN = '0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5';
const BATCHER = '0x0060938367f4F711A467e2f562ECe51A7a7158f0';
const DOMAIN_SEPARATOR = '0x' + '11'.repeat(32);

const coder = AbiCoder.defaultAbiCoder();

/** A minimal RpcLike that answers DOMAIN_SEPARATOR()/nonces(owner) exactly like a token contract. */
function tokenRpc(domainSeparator: string, nonce: bigint): RpcLike {
  return {
    rawRequest: async (method: string, params?: unknown[]) => {
      expect(method).toBe('quai_call');
      const call = (params as [{ data: string }, string])[0];
      const selector = call.data.slice(0, 10);
      if (selector === erc20PermitInterface.getFunction('DOMAIN_SEPARATOR')!.selector) {
        return erc20PermitInterface.encodeFunctionResult('DOMAIN_SEPARATOR', [domainSeparator]);
      }
      if (selector === erc20PermitInterface.getFunction('nonces')!.selector) {
        return erc20PermitInterface.encodeFunctionResult('nonces', [nonce]);
      }
      throw new Error(`unexpected selector ${selector}`);
    },
  };
}

describe('readPermitState', () => {
  it('decodes the domain separator and nonce for the given owner', async () => {
    const owner = '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170';
    const state = await readPermitState(tokenRpc(DOMAIN_SEPARATOR, 7n), TOKEN, owner);
    expect(state).toEqual({ domainSeparator: DOMAIN_SEPARATOR, nonce: 7n });
  });
});

describe('permitDigest', () => {
  it('matches a hand-computed EIP-712 digest', () => {
    const state: PermitState = { domainSeparator: DOMAIN_SEPARATOR, nonce: 3n };
    const f = { owner: '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170', spender: BATCHER, value: 1000n, deadline: 99999n };

    const structHash = keccak256(
      coder.encode(['bytes32', 'address', 'address', 'uint256', 'uint256', 'uint256'], [PERMIT_TYPEHASH, f.owner, f.spender, f.value, state.nonce, f.deadline])
    );
    const expected = keccak256('0x1901' + DOMAIN_SEPARATOR.slice(2) + structHash.slice(2));

    expect(permitDigest(state, f)).toBe(expected);
  });

  it('changes when the nonce changes, so a spent permit cannot be replayed at the next nonce', () => {
    const f = { owner: '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170', spender: BATCHER, value: 1000n, deadline: 99999n };
    const d0 = permitDigest({ domainSeparator: DOMAIN_SEPARATOR, nonce: 0n }, f);
    const d1 = permitDigest({ domainSeparator: DOMAIN_SEPARATOR, nonce: 1n }, f);
    expect(d0).not.toBe(d1);
  });
});

describe('PERMIT_TYPEHASH', () => {
  it('is the canonical EIP-2612 typehash', () => {
    expect(PERMIT_TYPEHASH).toBe(keccak256(toUtf8Bytes('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)')));
  });
});

describe('signAgentPermit', () => {
  it('produces a signature that recovers to the signer over the exact digest it read', async () => {
    const wallet = new Wallet('0x' + '42'.repeat(32));
    const rpc = tokenRpc(DOMAIN_SEPARATOR, 5n);

    const signed = await signAgentPermit(rpc, wallet, { token: TOKEN, spender: BATCHER, value: 250n, deadline: 123456789n });

    expect(signed.token).toBe(TOKEN);
    expect(signed.owner).toBe(getAddress(wallet.address));
    expect(signed.spender).toBe(BATCHER);
    expect(signed.value).toBe(250n);
    expect(signed.deadline).toBe(123456789n);

    const digest = permitDigest({ domainSeparator: DOMAIN_SEPARATOR, nonce: 5n }, { owner: signed.owner, spender: signed.spender, value: signed.value, deadline: signed.deadline });
    const recovered = recoverAddress(digest, { v: signed.v, r: signed.r, s: signed.s });
    expect(recovered).toBe(getAddress(wallet.address));
  });

  it('a different signer over the same params recovers to a different address', async () => {
    const walletA = new Wallet('0x' + '11'.repeat(32));
    const walletB = new Wallet('0x' + '22'.repeat(32));
    const rpc = tokenRpc(DOMAIN_SEPARATOR, 0n);

    const signedA = await signAgentPermit(rpc, walletA, { token: TOKEN, spender: BATCHER, value: 1n, deadline: 1n });
    expect(signedA.owner).not.toBe(getAddress(walletB.address));
  });
});

describe('buildBatchEntry', () => {
  it('maps a signed permit onto the contract field order, with spender dropped as implicit', () => {
    const signed = { token: TOKEN, owner: '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170', spender: BATCHER, value: 42n, deadline: 999n, v: 27, r: '0x' + 'aa'.repeat(32), s: '0x' + 'bb'.repeat(32) };
    expect(buildBatchEntry(signed)).toEqual({
      token: TOKEN,
      agent: signed.owner,
      amount: 42n,
      deadline: 999n,
      v: 27,
      r: signed.r,
      s: signed.s,
    });
  });
});

describe('encodeBatchPermitTransfer', () => {
  it('round-trips through the batcher ABI', () => {
    const entries = [
      { token: TOKEN, agent: '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170', amount: 10n, deadline: 111n, v: 27, r: '0x' + '01'.repeat(32), s: '0x' + '02'.repeat(32) },
      { token: TOKEN, agent: '0x006F028F539fe356F07bDF79ef42de524B51ce3E', amount: 20n, deadline: 222n, v: 28, r: '0x' + '03'.repeat(32), s: '0x' + '04'.repeat(32) },
    ];
    const data = encodeBatchPermitTransfer(entries);
    const decoded = agentPermitBatcherInterface.decodeFunctionData('batchPermitTransfer', data);
    const decodedEntries = decoded[0] as any[];
    expect(decodedEntries).toHaveLength(2);
    expect(getAddress(decodedEntries[0].token)).toBe(getAddress(TOKEN));
    expect(getAddress(decodedEntries[0].agent)).toBe(getAddress(entries[0]!.agent));
    expect(decodedEntries[0].amount).toBe(10n);
    expect(decodedEntries[1].amount).toBe(20n);
  });
});

describe('parseAgentSweptLogs', () => {
  it('decodes AgentSwept events and ignores logs from other addresses', () => {
    const agent = '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170';
    const fragment = agentPermitBatcherInterface.getEvent('AgentSwept')!;
    const encoded = agentPermitBatcherInterface.encodeEventLog(fragment, [TOKEN, agent, 55n, true]);

    const logs = [
      { address: BATCHER, topics: encoded.topics, data: encoded.data },
      { address: '0x00deadbeefdeadbeefdeadbeefdeadbeefdeadbe', topics: encoded.topics, data: encoded.data },
    ];

    const events = parseAgentSweptLogs(logs, BATCHER);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ token: getAddress(TOKEN), agent: getAddress(agent), amount: 55n, ok: true });
  });

  it('returns nothing for a batcher address with no matching logs', () => {
    expect(parseAgentSweptLogs([], BATCHER)).toEqual([]);
  });
});
