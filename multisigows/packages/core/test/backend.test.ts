import { describe, it, expect } from 'vitest';
import { Interface, getAddress } from 'ethers';
import {
  safeBuddyBackend,
  quaiVaultBackend,
  multisigBackends,
  vaultInterface,
  quaiVaultInterface,
  computeVaultTxHash,
  bdeltaCalls,
  bdeltaVaultInterface,
  RpcLike,
} from '../src/index.js';

const VAULT = '0x0060938367f4F711A467e2f562ECe51A7a7158f0';
const TARGET = '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170';
const OWNER_A = '0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170';
const OWNER_B = '0x006F028F539fe356F07bDF79ef42de524B51ce3E';
const CHAIN_ID = 9;

/** Dispatches quai_call by selector against one Interface, decoding args and re-encoding the result. */
function selectorRpc(iface: Interface, handlers: Record<string, (args: any) => any[]>): RpcLike {
  return {
    rawRequest: async (method: string, params?: unknown[]) => {
      expect(method).toBe('quai_call');
      const call = (params as [{ data: string }, string])[0];
      const selector = call.data.slice(0, 10);
      for (const sig of Object.keys(handlers)) {
        const frag = iface.getFunction(sig);
        if (frag && frag.selector === selector) {
          return iface.encodeFunctionResult(frag, handlers[sig]!(iface.decodeFunctionData(frag, call.data)));
        }
      }
      throw new Error(`selectorRpc: no handler for selector ${selector}`);
    },
  };
}

describe('safeBuddyBackend', () => {
  const call = { to: TARGET, value: 0n, data: '0xdeadbeef' };

  it('requires gasLimit, expiration and requestedDelay to propose', () => {
    expect(() => safeBuddyBackend.encodePropose(call, {})).toThrow(/gasLimit/);
    expect(() => safeBuddyBackend.encodePropose(call, { gasLimit: 1n })).toThrow(/expiration/);
    expect(() => safeBuddyBackend.encodePropose(call, { gasLimit: 1n, expiration: 2 })).toThrow(/requestedDelay/);
  });

  it('encodes a proposal that round-trips through the vault ABI', () => {
    const data = safeBuddyBackend.encodePropose(call, { gasLimit: 90_000n, expiration: 123456, requestedDelay: 3600 });
    const decoded = vaultInterface.decodeFunctionData('proposeTransaction', data);
    expect(getAddress(decoded[0])).toBe(getAddress(TARGET));
    expect(decoded[3]).toBe(90_000n);
    expect(decoded[4]).toBe(123456n);
    expect(decoded[5]).toBe(3600n);
  });

  it('encodes approve/execute', () => {
    const hash = '0x' + 'ab'.repeat(32);
    expect(vaultInterface.decodeFunctionData('approveTransaction', safeBuddyBackend.encodeApprove(hash))[0]).toBe(hash);
    expect(vaultInterface.decodeFunctionData('executeTransaction', safeBuddyBackend.encodeExecute(hash))[0]).toBe(hash);
  });

  it('reads owners and threshold', async () => {
    const rpc = selectorRpc(vaultInterface, {
      'getOwners()': () => [[OWNER_A, OWNER_B]],
      'threshold()': () => [2n],
    });
    await expect(safeBuddyBackend.readOwners(rpc, VAULT)).resolves.toEqual([getAddress(OWNER_A), getAddress(OWNER_B)]);
    await expect(safeBuddyBackend.readThreshold(rpc, VAULT)).resolves.toBe(2n);
  });

  it('resolves the same hash computeVaultTxHash would, reading txNonce from the vault', async () => {
    const rpc = selectorRpc(vaultInterface, { 'txNonce()': () => [7n] });
    const opts = { gasLimit: 90_000n, expiration: 123456, requestedDelay: 3600 };
    const resolved = await safeBuddyBackend.resolveTxHash(rpc, VAULT, CHAIN_ID, call, opts);
    const expected = computeVaultTxHash({
      vault: VAULT,
      chainId: CHAIN_ID,
      to: call.to,
      value: call.value,
      data: call.data,
      gasLimit: opts.gasLimit,
      expiration: opts.expiration,
      executionDelay: opts.requestedDelay,
      nonce: 7n,
    });
    expect(resolved).toBe(expected);
  });
});

describe('quaiVaultBackend', () => {
  const call = { to: TARGET, value: 0n, data: '0xdeadbeef' };

  it('uses the 3-arg overload when no expiration is given', () => {
    const data = quaiVaultBackend.encodePropose(call, {});
    const frag = quaiVaultInterface.getFunction('proposeTransaction(address,uint256,bytes)')!;
    expect(data.slice(0, 10)).toBe(frag.selector);
    const decoded = quaiVaultInterface.decodeFunctionData(frag, data);
    expect(getAddress(decoded[0])).toBe(getAddress(TARGET));
  });

  it('uses the 5-arg overload with expiration/executionDelay when expiration is given', () => {
    const data = quaiVaultBackend.encodePropose(call, { expiration: 999, requestedDelay: 60 });
    const frag = quaiVaultInterface.getFunction('proposeTransaction(address,uint256,bytes,uint48,uint32)')!;
    expect(data.slice(0, 10)).toBe(frag.selector);
    const decoded = quaiVaultInterface.decodeFunctionData(frag, data);
    expect(decoded[3]).toBe(999n);
    expect(decoded[4]).toBe(60n);
  });

  it('defaults requestedDelay to 0 when only expiration is given', () => {
    const data = quaiVaultBackend.encodePropose(call, { expiration: 999 });
    const frag = quaiVaultInterface.getFunction('proposeTransaction(address,uint256,bytes,uint48,uint32)')!;
    const decoded = quaiVaultInterface.decodeFunctionData(frag, data);
    expect(decoded[4]).toBe(0n);
  });

  it('ignores gasLimit entirely (QuaiVault has no per-call gas commitment)', () => {
    const withGas = quaiVaultBackend.encodePropose(call, { gasLimit: 999_999n });
    const withoutGas = quaiVaultBackend.encodePropose(call, {});
    expect(withGas).toBe(withoutGas);
  });

  it('encodes approve/execute', () => {
    const hash = '0x' + 'cd'.repeat(32);
    expect(quaiVaultInterface.decodeFunctionData('approveTransaction', quaiVaultBackend.encodeApprove(hash))[0]).toBe(hash);
    expect(quaiVaultInterface.decodeFunctionData('executeTransaction', quaiVaultBackend.encodeExecute(hash))[0]).toBe(hash);
  });

  it('reads owners and threshold', async () => {
    const rpc = selectorRpc(quaiVaultInterface, {
      'getOwners()': () => [[OWNER_A, OWNER_B]],
      'threshold()': () => [3n],
    });
    await expect(quaiVaultBackend.readOwners(rpc, VAULT)).resolves.toEqual([getAddress(OWNER_A), getAddress(OWNER_B)]);
    await expect(quaiVaultBackend.readThreshold(rpc, VAULT)).resolves.toBe(3n);
  });

  it('resolves the hash from the vault\'s own getTransactionHash view, not a local computation', async () => {
    const oracleHash = '0x' + '11'.repeat(32);
    let sawNonceRead = false;
    const rpc = selectorRpc(quaiVaultInterface, {
      'nonce()': () => {
        sawNonceRead = true;
        return [4n];
      },
      'getTransactionHash(address,uint256,bytes,uint256)': (args) => {
        expect(args[3]).toBe(4n); // used the nonce it just read
        return [oracleHash];
      },
    });
    const resolved = await quaiVaultBackend.resolveTxHash(rpc, VAULT, CHAIN_ID, call, {});
    expect(sawNonceRead).toBe(true);
    expect(resolved).toBe(oracleHash);
  });
});

describe('multisigBackends', () => {
  it('maps both backend kinds', () => {
    expect(multisigBackends['safebuddy-v2']).toBe(safeBuddyBackend);
    expect(multisigBackends.quaivault).toBe(quaiVaultBackend);
  });
});

describe('bdeltaCalls', () => {
  it('encodes depositNative with no arguments', () => {
    const data = bdeltaCalls.depositNative();
    expect(data).toBe(bdeltaVaultInterface.getFunction('depositNative')!.selector);
  });

  it('encodes depositToken(token, amount)', () => {
    const data = bdeltaCalls.depositToken(TARGET, 500n);
    const decoded = bdeltaVaultInterface.decodeFunctionData('depositToken', data);
    expect(getAddress(decoded[0])).toBe(getAddress(TARGET));
    expect(decoded[1]).toBe(500n);
  });
});
