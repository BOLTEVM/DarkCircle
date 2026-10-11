import { describe, it, expect } from 'vitest';
import { AbiCoder, Wallet, getAddress, keccak256, recoverAddress, toUtf8Bytes } from 'ethers';
import {
  PERMIT2_DOMAIN_TYPEHASH,
  TOKEN_PERMISSIONS_TYPEHASH,
  PERMIT_TRANSFER_FROM_TYPEHASH,
  permit2DomainSeparator,
  permit2Digest,
  signAgentPermit2,
  buildPermit2BatchEntry,
  encodeBatchPermit2Transfer,
  parsePermit2AgentSweptLogs,
  agentPermit2BatcherInterface,
  Permit2Fields,
} from '../src/index.js';

const TOKEN = '0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5';
const PERMIT2 = '0x0060938367f4F711A467e2f562ECe51A7a7158f0';
const BATCHER = '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170';
const CHAIN_ID = 9;

const coder = AbiCoder.defaultAbiCoder();

describe('typehashes', () => {
  it('match the canonical Permit2 SignatureTransfer spec (also asserted in MockPermit2.sol)', () => {
    expect(PERMIT2_DOMAIN_TYPEHASH).toBe(keccak256(toUtf8Bytes('EIP712Domain(string name,uint256 chainId,address verifyingContract)')));
    expect(TOKEN_PERMISSIONS_TYPEHASH).toBe(keccak256(toUtf8Bytes('TokenPermissions(address token,uint256 amount)')));
    expect(PERMIT_TRANSFER_FROM_TYPEHASH).toBe(
      keccak256(
        toUtf8Bytes(
          'PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)'
        )
      )
    );
  });
});

describe('permit2DomainSeparator', () => {
  it('has no version field, unlike a typical EIP-712 domain', () => {
    // Computing it by hand with the 4-field (name, chainId, verifyingContract) typehash and
    // comparing against the function's own output is the whole point of this test: a
    // 5-field domain (with version) would use a different typehash and diverge here.
    const expected = keccak256(
      coder.encode(['bytes32', 'bytes32', 'uint256', 'address'], [PERMIT2_DOMAIN_TYPEHASH, keccak256(toUtf8Bytes('Permit2')), CHAIN_ID, PERMIT2])
    );
    expect(permit2DomainSeparator(PERMIT2, CHAIN_ID)).toBe(expected);
  });

  it('changes with the verifying contract address (different Permit2 deployments never collide)', () => {
    const other = '0x00deadbeefdeadbeefdeadbeefdeadbeefdeadbe';
    expect(permit2DomainSeparator(PERMIT2, CHAIN_ID)).not.toBe(permit2DomainSeparator(other, CHAIN_ID));
  });
});

describe('permit2Digest', () => {
  it('matches a hand-computed digest, and does not depend on `agent`/`owner` (only spender is hashed)', () => {
    const domainSeparator = permit2DomainSeparator(PERMIT2, CHAIN_ID);
    const f: Permit2Fields = { token: TOKEN, amount: 1000n, spender: BATCHER, nonce: 3n, deadline: 99999n };

    const tokenPermissionsHash = keccak256(coder.encode(['bytes32', 'address', 'uint256'], [TOKEN_PERMISSIONS_TYPEHASH, f.token, f.amount]));
    const structHash = keccak256(
      coder.encode(
        ['bytes32', 'bytes32', 'address', 'uint256', 'uint256'],
        [PERMIT_TRANSFER_FROM_TYPEHASH, tokenPermissionsHash, f.spender, f.nonce, f.deadline]
      )
    );
    const expected = keccak256('0x1901' + domainSeparator.slice(2) + structHash.slice(2));

    expect(permit2Digest(domainSeparator, f)).toBe(expected);
  });

  it('changes when the nonce changes', () => {
    const domainSeparator = permit2DomainSeparator(PERMIT2, CHAIN_ID);
    const base: Permit2Fields = { token: TOKEN, amount: 1000n, spender: BATCHER, nonce: 0n, deadline: 99999n };
    expect(permit2Digest(domainSeparator, base)).not.toBe(permit2Digest(domainSeparator, { ...base, nonce: 1n }));
  });

  it('changes when the spender changes (this is what pins a signature to one specific batcher)', () => {
    const domainSeparator = permit2DomainSeparator(PERMIT2, CHAIN_ID);
    const base: Permit2Fields = { token: TOKEN, amount: 1000n, spender: BATCHER, nonce: 0n, deadline: 99999n };
    const otherSpender = getAddress('0x00ab5801a7d398351b8be11c439e05c5b3259aec');
    expect(permit2Digest(domainSeparator, base)).not.toBe(permit2Digest(domainSeparator, { ...base, spender: otherSpender }));
  });
});

describe('signAgentPermit2', () => {
  it('produces a 65-byte signature that recovers to the signer over the exact digest signed', () => {
    const wallet = new Wallet('0x' + '42'.repeat(32));

    const signed = signAgentPermit2(wallet, PERMIT2, CHAIN_ID, { token: TOKEN, spender: BATCHER, amount: 250n, nonce: 7n, deadline: 123456789n });

    expect(signed.token).toBe(TOKEN);
    expect(signed.agent).toBe(getAddress(wallet.address));
    expect(signed.spender).toBe(BATCHER);
    expect(signed.amount).toBe(250n);
    expect(signed.nonce).toBe(7n);
    expect(signed.deadline).toBe(123456789n);
    expect(signed.signature.length).toBe(2 + 65 * 2); // 0x + 65 bytes

    const domainSeparator = permit2DomainSeparator(PERMIT2, CHAIN_ID);
    const digest = permit2Digest(domainSeparator, { token: signed.token, amount: signed.amount, spender: signed.spender, nonce: signed.nonce, deadline: signed.deadline });
    const r = '0x' + signed.signature.slice(2, 66);
    const s = '0x' + signed.signature.slice(66, 130);
    const v = parseInt(signed.signature.slice(130, 132), 16);
    const recovered = recoverAddress(digest, { v, r, s });
    expect(recovered).toBe(getAddress(wallet.address));
  });

  it('picks a random nonce when none is given, and different calls do not collide', () => {
    const wallet = new Wallet('0x' + '77'.repeat(32));
    const a = signAgentPermit2(wallet, PERMIT2, CHAIN_ID, { token: TOKEN, spender: BATCHER, amount: 1n, deadline: 1n });
    const b = signAgentPermit2(wallet, PERMIT2, CHAIN_ID, { token: TOKEN, spender: BATCHER, amount: 1n, deadline: 1n });
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe('buildPermit2BatchEntry', () => {
  it('drops spender (implicit) and keeps agent, matching the contract struct', () => {
    const signed = { token: TOKEN, amount: 42n, spender: BATCHER, nonce: 5n, deadline: 999n, agent: '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170', signature: '0x' + 'aa'.repeat(65) };
    expect(buildPermit2BatchEntry(signed)).toEqual({
      token: TOKEN,
      agent: signed.agent,
      amount: 42n,
      nonce: 5n,
      deadline: 999n,
      signature: signed.signature,
    });
  });
});

describe('encodeBatchPermit2Transfer', () => {
  it('round-trips through the batcher ABI', () => {
    const entries = [
      { token: TOKEN, agent: '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170', amount: 10n, nonce: 0n, deadline: 111n, signature: '0x' + '01'.repeat(65) },
      { token: TOKEN, agent: '0x006F028F539fe356F07bDF79ef42de524B51ce3E', amount: 20n, nonce: 1n, deadline: 222n, signature: '0x' + '02'.repeat(65) },
    ];
    const data = encodeBatchPermit2Transfer(entries);
    const decoded = agentPermit2BatcherInterface.decodeFunctionData('batchPermit2Transfer', data);
    const decodedEntries = decoded[0] as any[];
    expect(decodedEntries).toHaveLength(2);
    expect(getAddress(decodedEntries[0].agent)).toBe(getAddress(entries[0]!.agent));
    expect(decodedEntries[0].amount).toBe(10n);
    expect(decodedEntries[1].nonce).toBe(1n);
  });
});

describe('parsePermit2AgentSweptLogs', () => {
  it('decodes AgentSwept events and ignores logs from other addresses', () => {
    const agent = '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170';
    const fragment = agentPermit2BatcherInterface.getEvent('AgentSwept')!;
    const encoded = agentPermit2BatcherInterface.encodeEventLog(fragment, [TOKEN, agent, 55n, true]);

    const logs = [
      { address: BATCHER, topics: encoded.topics, data: encoded.data },
      { address: '0x00deadbeefdeadbeefdeadbeefdeadbeefdeadbe', topics: encoded.topics, data: encoded.data },
    ];

    const events = parsePermit2AgentSweptLogs(logs, BATCHER);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ token: getAddress(TOKEN), agent: getAddress(agent), amount: 55n, ok: true });
  });
});
