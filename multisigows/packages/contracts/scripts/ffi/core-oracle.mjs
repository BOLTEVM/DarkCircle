#!/usr/bin/env node
/**
 * Answers questions with the TypeScript library the app ships (@darksafe/core), so the
 * Foundry differential suite (test/foundry/differential) can check it against the contracts.
 * Prints one ABI-encoded hex string; forge's vm.ffi decodes it to bytes.
 *
 *   txhash  <vault> <chainId> <to> <value> <data> <gasLimit> <expiration> <delay> <nonce>
 *   predict <factory> <implementation> <creator> <salt> <owners,csv> <threshold> <delay>
 *   mine    <factory> <implementation> <creator> <owners,csv> <threshold> <delay> <startSalt>
 *   mask    <runtimeCode>
 *   decode  <vault> <to> <value> <data>
 *   validate <vault> <minDelay> <chainTime> <to> <value> <data> <gasLimit> <expiration> <requestedDelay>
 *   adminrisk <vault> <owners,csv> <threshold> <minDelay> <data>
 */
import { AbiCoder, getBytes, keccak256 } from 'ethers';
import {
  computeVaultTxHash,
  predictVaultAddress,
  mineVaultSalt,
  maskImmutables,
  decodeVaultCall,
  describeRisk,
  vaultWillReject,
  validateDraft,
  PINNED_CONTRACTS,
} from '@darksafe/core';

const coder = AbiCoder.defaultAbiCoder();
const [cmd, ...a] = process.argv.slice(2);
const params = (csv, t, d) => ({ owners: csv ? csv.split(',') : [], threshold: Number(t), minExecutionDelay: Number(d) });

const KIND = {
  'native-transfer': 0,
  'erc20-transfer': 1,
  'erc20-approve': 2,
  addOwner: 3,
  removeOwner: 4,
  changeThreshold: 5,
  setMinExecutionDelay: 6,
  cancelByConsensus: 7,
  'self-call-unknown': 8,
  'contract-call': 9,
};

function out(types, values) {
  process.stdout.write(coder.encode(types, values));
}

switch (cmd) {
  case 'txhash':
    process.stdout.write(
      computeVaultTxHash({
        vault: a[0],
        chainId: BigInt(a[1]),
        to: a[2],
        value: BigInt(a[3]),
        data: a[4],
        gasLimit: BigInt(a[5]),
        expiration: BigInt(a[6]),
        executionDelay: Number(a[7]),
        nonce: BigInt(a[8]),
      })
    );
    break;
  case 'predict':
    out(['address'], [predictVaultAddress({ factory: a[0], implementation: a[1], creator: a[2], salt: a[3], params: params(a[4], a[5], a[6]) })]);
    break;
  case 'mine': {
    const mined = mineVaultSalt({ factory: a[0], implementation: a[1], creator: a[2], params: params(a[3], a[4], a[5]), startSalt: getBytes(a[6]) });
    out(['bytes32', 'address'], [mined.salt, mined.address]);
    break;
  }
  case 'mask': {
    const pin = PINNED_CONTRACTS.DarkSafeVaultFactoryV2;
    const hash = keccak256(maskImmutables(a[0], pin.immutableRanges));
    out(['bytes32', 'bool'], [hash, hash === pin.runtimeCodeHash && (a[0].length - 2) / 2 === pin.runtimeBytes]);
    break;
  }
  case 'decode': {
    const d = decodeVaultCall({ vault: a[0], to: a[1], value: BigInt(a[2]), data: a[3] });
    const zero = '0x' + '00'.repeat(20);
    let kind = KIND[d.kind];
    let addr = zero;
    let n = 0n;
    let h = '0x' + '00'.repeat(32);
    if (d.kind === 'native-transfer') [addr, n] = [d.to, d.value];
    else if (d.kind === 'erc20-transfer') [addr, n] = [d.recipient, d.amount];
    else if (d.kind === 'erc20-approve') [addr, n] = [d.spender, d.amount];
    else if (d.kind === 'admin') {
      const c = d.call;
      kind = KIND[c.fn];
      if (c.fn === 'addOwner' || c.fn === 'removeOwner') [addr, n] = [c.owner, c.newThreshold];
      else if (c.fn === 'changeThreshold') n = c.newThreshold;
      else if (c.fn === 'setMinExecutionDelay') n = c.newDelay;
      else h = c.txHash;
    } else if (d.kind === 'contract-call') [addr, n] = [d.to, d.value];
    out(['uint8', 'address', 'uint256', 'bytes32'], [kind, addr, n, h]);
    break;
  }
  case 'validate': {
    const draft = { to: a[3], value: BigInt(a[4]), data: a[5], gasLimit: BigInt(a[6]), expiration: Number(a[7]), requestedDelay: Number(a[8]) };
    out(['bool'], [validateDraft(draft, a[0], Number(a[1]), Number(a[2])).length === 0]);
    break;
  }
  case 'adminrisk': {
    const decoded = decodeVaultCall({ vault: a[0], to: a[0], value: 0n, data: a[4] });
    const ctx = { vault: a[0], owners: a[1].split(','), threshold: Number(a[2]), minExecutionDelay: Number(a[3]) };
    out(['bool'], [vaultWillReject(describeRisk(decoded, ctx))]);
    break;
  }
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(2);
}
