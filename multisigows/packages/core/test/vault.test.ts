import { describe, it, expect } from 'vitest';
import { AbiCoder, MaxUint256, getAddress, keccak256 } from 'ethers';
import {
  decodeVaultCall,
  describeRisk,
  highestRisk,
  vaultWillReject,
  confirmationChallenge,
  challengeSatisfied,
  summarizeCall,
  computeVaultTxHash,
  reviewDigest,
  formatDigest,
  mineVaultSalt,
  predictVaultAddress,
  isCyprus1QuaiAddress,
  maskImmutables,
  sanitizeText,
  chooseExpiration,
  estimatedChainNow,
  clockSkewIsSuspicious,
  validateDraft,
  readAcrossSources,
  SourceUnavailableError,
  UnknownVaultCodeError,
  transactionActions,
  parseVaultLogs,
  proposedHashFromLogs,
  walletCreatedFromLogs,
  readBlock,
  adminCalls,
  erc20TransferCall,
  vaultInterface,
  factoryInterface,
  erc20Interface,
  groupAddress,
  shortAddress,
  formatDuration,
  describeVaultRevert,
  RpcLike,
  VaultSnapshot,
  VaultTransaction,
} from '../src/index.js';

const VAULT = '0x0060938367f4F711A467e2f562ECe51A7a7158f0';
const OWNER_A = '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170';
const OWNER_B = '0x006F028F539fe356F07bDF79ef42de524B51ce3E';
const OWNER_C = '0x0012345678901234567890123456789012345678';
const QI_ADDRESS = '0x0080000000000000000000000000000000000001';
const TOKEN = '0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5';
const HASH = '0x' + 'ab'.repeat(32);

const snapshot: VaultSnapshot = {
  vault: VAULT,
  owners: [OWNER_A, OWNER_B, OWNER_C],
  threshold: 2,
  minExecutionDelay: 86_400,
  txNonce: 3,
  balance: 10n ** 18n,
};
const ctx = { vault: VAULT, owners: snapshot.owners, threshold: 2, minExecutionDelay: 86_400, balance: 10n ** 18n };

describe('decodeVaultCall', () => {
  it('recognises plain transfers and canonical ERC-20 calls', () => {
    expect(decodeVaultCall({ vault: VAULT, to: OWNER_A, value: 5n, data: '0x' })).toEqual({ kind: 'native-transfer', to: OWNER_A, value: 5n });
    const transfer = decodeVaultCall({ vault: VAULT, to: TOKEN, value: 0n, data: erc20TransferCall(OWNER_B, 42n) });
    expect(transfer).toEqual({ kind: 'erc20-transfer', token: TOKEN, recipient: OWNER_B, amount: 42n, value: 0n });
    const approve = decodeVaultCall({ vault: VAULT, to: TOKEN, value: 0n, data: erc20Interface.encodeFunctionData('approve', [OWNER_B, MaxUint256]) });
    expect(approve).toMatchObject({ kind: 'erc20-approve', spender: OWNER_B, unlimited: true });
  });

  it('refuses to show a clean decode of calldata with trailing bytes', () => {
    const d = decodeVaultCall({ vault: VAULT, to: TOKEN, value: 0n, data: erc20TransferCall(OWNER_B, 42n) + 'ff' });
    expect(d).toMatchObject({ kind: 'contract-call', note: expect.stringContaining('not canonically encoded') });
  });

  it('decodes admin self-calls, and flags non-canonical or unknown ones', () => {
    const add = decodeVaultCall({ vault: VAULT, to: VAULT, value: 0n, data: adminCalls.addOwner(OWNER_C, 3) });
    expect(add).toEqual({ kind: 'admin', call: { fn: 'addOwner', owner: getAddress(OWNER_C), newThreshold: 3n } });

    // Dirty upper bits in the address word: Solidity would revert, so it must not decode as a clean addOwner.
    const dirty = adminCalls.addOwner(OWNER_C, 3).replace(/^(0x.{8})000000000000000000000000/, '$1ffffffffffffffffffffffff');
    expect(decodeVaultCall({ vault: VAULT, to: VAULT, value: 0n, data: dirty })).toMatchObject({ kind: 'self-call-unknown', reason: 'admin call with non-canonical encoding' });
    expect(decodeVaultCall({ vault: VAULT, to: VAULT, value: 0n, data: vaultInterface.encodeFunctionData('approveTransaction', [HASH]) })).toMatchObject({
      kind: 'self-call-unknown',
      reason: 'not an admin function of the vault',
    });
  });

  it('treats any other selector as an unknown contract call', () => {
    expect(decodeVaultCall({ vault: VAULT, to: TOKEN, value: 1n, data: '0xdeadbeef00' })).toEqual({
      kind: 'contract-call',
      to: TOKEN,
      value: 1n,
      selector: '0xdeadbeef',
      dataBytes: 5,
    });
  });
});

describe('describeRisk', () => {
  const admin = (data: string) => decodeVaultCall({ vault: VAULT, to: VAULT, value: 0n, data });
  const codes = (flags: { code: string }[]) => flags.map((f) => f.code);

  it('marks every admin change critical and explains threshold drops', () => {
    const flags = describeRisk(admin(adminCalls.changeThreshold(1)), ctx);
    expect(highestRisk(flags)).toBe('critical');
    expect(codes(flags)).toEqual(expect.arrayContaining(['admin-change', 'threshold-decrease', 'single-signer']));
  });

  it('flags a removed timelock, an invalid threshold and an owner that can never sign', () => {
    expect(codes(describeRisk(admin(adminCalls.setMinExecutionDelay(0)), ctx))).toContain('delay-removed');
    expect(codes(describeRisk(admin(adminCalls.changeThreshold(4)), ctx))).toContain('invalid-threshold');
    expect(codes(describeRisk(admin(adminCalls.addOwner(QI_ADDRESS, 2)), ctx))).toContain('owner-not-quai-account');
    expect(codes(describeRisk(admin(adminCalls.removeOwner(OWNER_C, 2)), ctx))).toEqual(expect.arrayContaining(['owner-removal', 'all-must-sign']));
  });

  it('says the vault will reject exactly the admin changes the vault rejects', () => {
    const rejects = (data: string, extra: Partial<typeof ctx> & { cancellableTransactions?: Set<string> } = {}) =>
      vaultWillReject(describeRisk(admin(data), { ...ctx, ...extra }));
    expect(rejects(adminCalls.addOwner('0x0000000000000000000000000000000000000000', 2))).toBe(true);
    expect(rejects(adminCalls.addOwner('0x0000000000000000000000000000000000000001', 2))).toBe(true);
    expect(rejects(adminCalls.addOwner(VAULT, 2))).toBe(true);
    expect(rejects(adminCalls.addOwner('0x0100000000000000000000000000000000000001', 2))).toBe(true);
    expect(rejects(adminCalls.addOwner(OWNER_A, 2))).toBe(true);
    // A Qi-ledger owner is accepted by the vault (it only checks the zone) but can never sign.
    expect(rejects(adminCalls.addOwner(QI_ADDRESS, 2))).toBe(false);
    expect(codes(describeRisk(admin(adminCalls.addOwner(QI_ADDRESS, 2)), ctx))).toContain('owner-not-quai-account');
    expect(rejects(adminCalls.addOwner(getAddress('0x0012345678901234567890123456789012345679'), 2))).toBe(false);
    expect(rejects(adminCalls.cancelByConsensus(HASH), { cancellableTransactions: new Set() })).toBe(true);
    expect(rejects(adminCalls.cancelByConsensus(HASH), { cancellableTransactions: new Set([HASH]) })).toBe(false);
    expect(rejects(adminCalls.cancelByConsensus(HASH))).toBe(false);
  });

  it('does not claim the vault rejects a non-canonical admin call it might run', () => {
    const trailing = decodeVaultCall({ vault: VAULT, to: VAULT, value: 0n, data: adminCalls.changeThreshold(2) + 'ff' });
    expect(trailing).toMatchObject({ kind: 'self-call-unknown', reason: 'admin call with non-canonical encoding' });
    const flags = describeRisk(trailing, ctx);
    expect(codes(flags)).toContain('undecodable-admin-call');
    expect(vaultWillReject(flags)).toBe(false);
  });

  it('warns about first-time and contract recipients only when it knows', () => {
    const send = decodeVaultCall({ vault: VAULT, to: OWNER_A, value: 10n ** 17n, data: '0x' });
    expect(codes(describeRisk(send, ctx))).not.toContain('first-time-recipient');
    expect(codes(describeRisk(send, { ...ctx, knownRecipients: new Set<string>() }))).toContain('first-time-recipient');
    expect(codes(describeRisk(send, { ...ctx, knownRecipients: new Set([OWNER_A.toLowerCase()]) }))).not.toContain('first-time-recipient');
    expect(codes(describeRisk(send, { ...ctx, recipientIsContract: true }))).toContain('contract-recipient');
    const big = decodeVaultCall({ vault: VAULT, to: OWNER_A, value: 2n * 10n ** 18n, data: '0x' });
    expect(codes(describeRisk(big, ctx))).toContain('insufficient-balance');
  });

  it('flags unlimited approvals and undecodable calls as high', () => {
    const approve = decodeVaultCall({ vault: VAULT, to: TOKEN, value: 0n, data: erc20Interface.encodeFunctionData('approve', [OWNER_B, MaxUint256]) });
    expect(codes(describeRisk(approve, ctx))).toContain('unlimited-approval');
    const unknown = decodeVaultCall({ vault: VAULT, to: TOKEN, value: 0n, data: '0xdeadbeef' });
    expect(highestRisk(describeRisk(unknown, ctx))).toBe('high');
  });

  it('asks for a value taken from the change itself before an admin approval', () => {
    const c = confirmationChallenge(admin(adminCalls.removeOwner(OWNER_B, 2)))!;
    expect(c.expected).toBe(OWNER_B.slice(-6).toLowerCase());
    expect(challengeSatisfied(c, OWNER_B.slice(-6).toUpperCase())).toBe(true);
    expect(challengeSatisfied(c, 'nope')).toBe(false);
    expect(confirmationChallenge(decodeVaultCall({ vault: VAULT, to: OWNER_A, value: 1n, data: '0x' }))).toBeNull();
    expect(summarizeCall(admin(adminCalls.changeThreshold(3)))).toBe('Change threshold to 3');
  });
});

describe('hashes and digests', () => {
  const fields = { vault: VAULT, chainId: 15000, to: OWNER_A, value: 1n, data: '0x', gasLimit: 50_000n, expiration: 2_000_000_000, executionDelay: 3600, nonce: 0 };

  it('commits to every field', () => {
    const base = computeVaultTxHash(fields);
    for (const patch of [{ chainId: 9 }, { to: OWNER_B }, { value: 2n }, { data: '0x00' }, { gasLimit: 50_001n }, { expiration: 2_000_000_001 }, { executionDelay: 3601 }, { nonce: 1 }]) {
      expect(computeVaultTxHash({ ...fields, ...patch })).not.toBe(base);
    }
  });

  it('gives the same review digest for the same owner set in any order', () => {
    const a = reviewDigest({ txHash: HASH, owners: [OWNER_A, OWNER_B], threshold: 2, minExecutionDelay: 0 });
    const b = reviewDigest({ txHash: HASH, owners: [OWNER_B.toLowerCase(), OWNER_A], threshold: 2, minExecutionDelay: 0 });
    expect(a).toBe(b);
    expect(reviewDigest({ txHash: HASH, owners: [OWNER_A, OWNER_B], threshold: 1, minExecutionDelay: 0 })).not.toBe(a);
    expect(formatDigest(a)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });
});

describe('vault address mining', () => {
  const FACTORY = '0x0011111111111111111111111111111111111111';
  const IMPL = '0x0022222222222222222222222222222222222222';
  const params = { owners: [OWNER_A, OWNER_B], threshold: 2, minExecutionDelay: 3600 };

  it('finds a salt whose predicted address is a Cyprus-1 Quai account', () => {
    const mined = mineVaultSalt({ factory: FACTORY, implementation: IMPL, creator: OWNER_A, params, startSalt: new Uint8Array(32) });
    expect(isCyprus1QuaiAddress(mined.address)).toBe(true);
    expect(predictVaultAddress({ factory: FACTORY, implementation: IMPL, creator: OWNER_A, salt: mined.salt, params })).toBe(mined.address);
    // The same salt from another creator lands elsewhere: a mined salt cannot be squatted.
    expect(predictVaultAddress({ factory: FACTORY, implementation: IMPL, creator: OWNER_B, salt: mined.salt, params })).not.toBe(mined.address);
  });

  it('classifies Quai-ledger and Qi-ledger addresses', () => {
    expect(isCyprus1QuaiAddress(OWNER_A)).toBe(true);
    expect(isCyprus1QuaiAddress(QI_ADDRESS)).toBe(false);
    expect(isCyprus1QuaiAddress('0x0100000000000000000000000000000000000001')).toBe(false);
    expect(isCyprus1QuaiAddress('0x00')).toBe(false);
  });
});

describe('maskImmutables', () => {
  it('zeroes exactly the given byte ranges', () => {
    expect(maskImmutables('0xaabbccddeeff', [{ start: 1, length: 2 }, { start: 5, length: 1 }])).toBe('0xaa0000ddee00');
  });
});

describe('sanitizeText', () => {
  it('removes bidi overrides and zero-width characters and bounds the length', () => {
    expect(sanitizeText('US‮DT​')).toBe('USDT');
    expect(sanitizeText('a'.repeat(40), 10)).toBe('aaaaaaaaa…');
    expect(sanitizeText(42)).toBe('');
  });
});

describe('chain clock', () => {
  const clock = { chainTime: 1_000_000, blockNumber: 5n, localTime: 1_000_100, skew: 100 };

  it('anchors expiry on block time and enforces the vault window', () => {
    expect(chooseExpiration(clock, 3600)).toBe(1_000_000 + 3600 + 7 * 86_400);
    expect(() => chooseExpiration(clock, 0, 60)).toThrow(/between 1 hour and 30 days/);
    expect(() => chooseExpiration(clock, 31 * 86_400)).toThrow(/delay/);
  });

  it('advances chain time by elapsed local time and flags large skew', () => {
    expect(estimatedChainNow(clock, 1_000_160_000)).toBe(1_000_060);
    expect(clockSkewIsSuspicious(clock, 'mainnet')).toBe(false);
    expect(clockSkewIsSuspicious({ ...clock, skew: 3600 }, 'mainnet')).toBe(true);
    expect(clockSkewIsSuspicious({ ...clock, skew: 1200 }, 'testnet')).toBe(false);
  });
});

describe('validateDraft', () => {
  const now = 1_000_000;
  it('mirrors the vault rules for self-calls and expiry', () => {
    const selfDraft = { to: VAULT, value: 1n, data: adminCalls.changeThreshold(2), gasLimit: 5n, expiration: now + 7200, requestedDelay: 0 };
    expect(validateDraft(selfDraft, VAULT, 86_400, now)).toEqual(['Admin changes cannot carry value.', 'Admin changes must have a gas limit of 0.']);
    const ext = { to: OWNER_A, value: 1n, data: '0x', gasLimit: 50_000n, expiration: now + 86_400 + 60, requestedDelay: 0 };
    expect(validateDraft(ext, VAULT, 86_400, now)).toEqual(['The expiry must be at least 1 hour after the timelock ends.']);
    expect(validateDraft({ ...ext, expiration: now + 86_400 + 3600 }, VAULT, 86_400, now)).toEqual([]);
    expect(validateDraft({ ...ext, gasLimit: 0n, expiration: now + 32 * 86_400 }, VAULT, 86_400, now)).toHaveLength(2);
  });
});

function source(name: string, head: bigint | null, value: unknown | Error): { name: string; rpc: RpcLike; value: unknown } {
  return {
    name,
    value,
    rpc: {
      rawRequest: async (method: string) => {
        if (method !== 'quai_blockNumber') throw new Error('unexpected');
        if (head === null) throw new Error('down');
        return '0x' + head.toString(16);
      },
    },
  };
}

describe('readAcrossSources', () => {
  const run = (sources: ReturnType<typeof source>[], seen: bigint[] = []) =>
    readAcrossSources(sources, async (rpc, block) => {
      seen.push(block);
      const s = sources.find((x) => x.rpc === rpc)!;
      if (s.value instanceof Error) throw s.value;
      return s.value;
    });

  it('agrees when a second source returns the same value at the common block', async () => {
    const seen: bigint[] = [];
    const r = await run([source('rpc', 105n, { owners: ['0xAB'] }), source('wallet', 100n, { owners: ['0xab'] })], seen);
    expect(r.status).toBe('agreed');
    expect(r.block).toBe(100n);
    expect(seen).toEqual([100n, 100n]);
  });

  it('reports a disagreement, including a second source that says the code is not a vault', async () => {
    expect((await run([source('rpc', 10n, { t: 2 }), source('wallet', 10n, { t: 1 })])).status).toBe('disagreement');
    const r = await run([source('rpc', 10n, { t: 2 }), source('wallet', 10n, new UnknownVaultCodeError(VAULT, '0x01'))]);
    expect(r.status).toBe('disagreement');
  });

  it('falls back to single-source when the second source is down, lagging or cannot read', async () => {
    expect((await run([source('rpc', 10n, 1), source('wallet', null, 1)])).status).toBe('single-source');
    const lag = await run([source('rpc', 1000n, 1), source('wallet', 10n, 1)]);
    expect(lag.status).toBe('single-source');
    expect(lag.block).toBe(1000n);
    expect((await run([source('rpc', 10n, 1), source('wallet', 10n, new Error('method not found'))])).status).toBe('single-source');
  });

  it('fails when the primary source is down or far behind', async () => {
    await expect(run([source('rpc', null, 1), source('wallet', 10n, 1)])).rejects.toBeInstanceOf(SourceUnavailableError);
    await expect(run([source('rpc', 10n, 1), source('wallet', 1000n, 1)])).rejects.toBeInstanceOf(SourceUnavailableError);
  });
});

describe('transactionActions', () => {
  const tx: VaultTransaction = {
    hash: HASH,
    nonce: 0,
    to: OWNER_A,
    value: 1n,
    data: '0x',
    gasLimit: 50_000n,
    executionDelay: 3600,
    proposer: OWNER_A,
    proposedAt: 1000,
    expiration: 100_000,
    approvedAt: 0,
    executed: false,
    failed: false,
    cancelled: false,
    expired: false,
    status: 'Pending',
    approvals: [OWNER_A],
  };

  it('lets the proposer cancel before quorum, and others approve', () => {
    expect(transactionActions(tx, snapshot, OWNER_A, 2000)).toMatchObject({ canApprove: false, canRevoke: true, canCancel: true, canExecute: false });
    expect(transactionActions(tx, snapshot, OWNER_B, 2000)).toMatchObject({ canApprove: true, canCancel: false });
    expect(transactionActions(tx, snapshot, null, 2000).canApprove).toBe(false);
  });

  it('waits for the timelock after quorum and allows expiry afterwards', () => {
    const quorum = { ...tx, approvals: [OWNER_A, OWNER_B], approvedAt: 2000 };
    expect(transactionActions(quorum, snapshot, OWNER_B, 3000)).toMatchObject({ canExecute: false, canCancel: false, executableAfter: 5600 });
    expect(transactionActions(quorum, snapshot, OWNER_B, 5600).canExecute).toBe(true);
    expect(transactionActions(quorum, snapshot, OWNER_B, 100_001)).toMatchObject({ canExecute: false, canExpire: true });
  });

  it('asks to start the clock when quorum exists without approvedAt', () => {
    const lowered = { ...tx, approvals: [OWNER_A, OWNER_B] };
    expect(transactionActions(lowered, snapshot, OWNER_B, 3000)).toMatchObject({ needsClockStart: true, canExecute: false });
  });
});

describe('logs', () => {
  it('parses only the vault and factory events it expects', () => {
    const proposed = vaultInterface.encodeEventLog('TransactionProposed', [HASH, OWNER_A, OWNER_B, 1n, '0x', 50_000n, 99n, 0]);
    const logs = [
      { address: OWNER_C, ...proposed },
      { address: VAULT.toLowerCase(), ...proposed },
    ];
    expect(parseVaultLogs(logs, VAULT)).toHaveLength(1);
    expect(proposedHashFromLogs(logs, VAULT)).toBe(HASH);
    const created = factoryInterface.encodeEventLog('WalletCreated', [VAULT, OWNER_A, [OWNER_A, OWNER_B], 2n, 3600, HASH]);
    expect(walletCreatedFromLogs([{ address: OWNER_C, ...created }], OWNER_C)).toMatchObject({ wallet: VAULT, threshold: 2, minExecutionDelay: 3600 });
    expect(() => walletCreatedFromLogs([{ address: VAULT, ...created }], OWNER_C)).toThrow(/WalletCreated/);
  });

  it('names vault reverts', () => {
    const data = vaultInterface.encodeErrorResult('TimelockNotElapsed', [123n]);
    expect(describeVaultRevert(data)).toBe('TimelockNotElapsed(123)');
    expect(describeVaultRevert('0x')).toBeNull();
  });
});

describe('readBlock', () => {
  it('reads number and timestamp from the Quai work-object header', async () => {
    const rpc: RpcLike = {
      rawRequest: async () => ({ hash: '0x' + '11'.repeat(32), woHeader: { number: '0x10', timestamp: '0x64' }, header: { number: ['0x1', '0x2'] } }),
    };
    expect(await readBlock(rpc)).toEqual({ number: 16n, hash: '0x' + '11'.repeat(32), timestamp: 100 });
    const ethShaped: RpcLike = { rawRequest: async () => ({ hash: '0x' + '11'.repeat(32), number: '0x10', timestamp: '0x64' }) };
    await expect(readBlock(ethShaped)).rejects.toThrow(/Quai format/);
  });
});

describe('formatting', () => {
  it('never abbreviates an address below 10+8 characters', () => {
    expect(shortAddress(VAULT)).toBe('0x00609383…7a7158f0');
    expect(groupAddress(VAULT)).toBe('0x 0060 9383 67f4 F711 A467 e2f5 62EC e51A 7a71 58f0');
    expect(formatDuration(90_000)).toBe('1d 1h');
    expect(formatDuration(0)).toBe('0s');
  });
});

// Keep the ABI coder import honest: the reviewDigest encoding is a plain abi.encode.
describe('reviewDigest encoding', () => {
  it('is keccak256(abi.encode(txHash, sortedOwners, threshold, delay))', () => {
    const owners = [OWNER_A, OWNER_B].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
    const expected = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'address[]', 'uint256', 'uint32'], [HASH, owners, 2, 60]));
    expect(reviewDigest({ txHash: HASH, owners: [OWNER_B, OWNER_A], threshold: 2, minExecutionDelay: 60 })).toBe(expected);
  });
});

describe('assessVaultConfig', () => {
  it('grades weak setups down and explains why', async () => {
    const { assessVaultConfig, VAULT_PRESETS } = await import('../src/index.js');
    expect(assessVaultConfig(3, 2, 86_400).grade).toBe('A');
    expect(assessVaultConfig(3, 2, 3600).grade).toBe('B');
    expect(assessVaultConfig(3, 2, 0).grade).toBe('C');
    expect(assessVaultConfig(2, 2, 86_400).grade).toBe('C');
    expect(assessVaultConfig(3, 1, 86_400).grade).toBe('D');
    expect(assessVaultConfig(1, 1, 86_400).notes[0]).toMatch(/not a multisig/);
    for (const p of VAULT_PRESETS) expect(assessVaultConfig(p.owners, p.threshold, p.delaySeconds).grade).toBe('A');
  });
});

describe('readAcrossSources at a chosen block', () => {
  it('reads at that block and skips sources that have not reached it', async () => {
    const seen: bigint[] = [];
    const mk = (name: string, head: bigint) => ({
      name,
      rpc: { rawRequest: async () => '0x' + head.toString(16) } as RpcLike,
    });
    const sources = [mk('rpc', 120n), mk('wallet', 90n)];
    const r = await readAcrossSources(sources, async (_rpc, block) => {
      seen.push(block);
      return 1;
    }, { atBlock: 100n });
    expect(r.block).toBe(100n);
    expect(seen).toEqual([100n]);
    expect(r.status).toBe('single-source');
    expect(r.problems[0]).toMatch(/has not reached block 100/);
    await expect(readAcrossSources([mk('rpc', 50n)], async () => 1, { atBlock: 100n })).rejects.toThrow(/has not reached block 100/);
  });
});
