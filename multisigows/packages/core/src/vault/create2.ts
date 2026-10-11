import { AbiCoder, concat, getAddress, getBytes, getCreate2Address, keccak256, solidityPacked } from 'ethers';
import { VAULT_PROXY_CREATION_CODE } from '../pinned.js';
import { vaultInterface } from './abi.js';

const coder = AbiCoder.defaultAbiCoder();

export interface VaultParams {
  owners: readonly string[];
  threshold: number;
  minExecutionDelay: number;
}

/** True for a Cyprus-1 address on the Quai (account) ledger: first byte 0x00, second byte < 0x80. */
export function isCyprus1QuaiAddress(address: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return false;
  return address.slice(2, 4) === '00' && parseInt(address.slice(4, 6), 16) < 0x80;
}

export function vaultInitData(p: VaultParams): string {
  return vaultInterface.encodeFunctionData('initialize', [p.owners, p.threshold, p.minExecutionDelay]);
}

/** keccak256 of the proxy init code the factory deploys for these parameters. */
export function vaultInitCodeHash(implementation: string, p: VaultParams): string {
  const args = coder.encode(['address', 'bytes'], [implementation, vaultInitData(p)]);
  return keccak256(concat([VAULT_PROXY_CREATION_CODE, args]));
}

/** The factory folds the caller into the salt: keccak256(abi.encodePacked(creator, salt)). */
export function factorySalt(creator: string, salt: string): string {
  return keccak256(solidityPacked(['address', 'bytes32'], [creator, salt]));
}

/** Mirrors SafeBuddyVaultFactory.predictWalletAddress. */
export function predictVaultAddress(args: {
  factory: string;
  implementation: string;
  creator: string;
  salt: string;
  params: VaultParams;
}): string {
  return getCreate2Address(args.factory, factorySalt(args.creator, args.salt), vaultInitCodeHash(args.implementation, args.params));
}

export interface MinedSalt {
  salt: string;
  address: string;
  attempts: number;
}

export class SaltMiningError extends Error {
  constructor(attempts: number) {
    super(`No Cyprus-1 vault address found in ${attempts} attempts. This is astronomically unlikely; retry.`);
    this.name = 'SaltMiningError';
  }
}

function randomSalt(): Uint8Array {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Finds a salt whose CREATE2 address lands in Cyprus-1 on the Quai ledger (about 1 in 512).
 * Starts from a random salt and counts up in its last 8 bytes. With the default cap the
 * chance of giving up is below 1e-40.
 */
export function mineVaultSalt(args: {
  factory: string;
  implementation: string;
  creator: string;
  params: VaultParams;
  maxAttempts?: number;
  /** Fixed starting salt, for tests. */
  startSalt?: Uint8Array;
}): MinedSalt {
  const maxAttempts = args.maxAttempts ?? 50_000;
  const creator = getBytes(getAddress(args.creator));
  const factory = getBytes(getAddress(args.factory));
  const initCodeHash = getBytes(vaultInitCodeHash(args.implementation, args.params));

  const salt = args.startSalt ? Uint8Array.from(args.startSalt) : randomSalt();
  if (salt.length !== 32) throw new Error('startSalt must be 32 bytes');
  const saltInput = new Uint8Array(52);
  saltInput.set(creator, 0);
  const addrInput = new Uint8Array(85);
  addrInput[0] = 0xff;
  addrInput.set(factory, 1);
  addrInput.set(initCodeHash, 53);
  const view = new DataView(salt.buffer, salt.byteOffset, 32);
  const base = view.getBigUint64(24);

  for (let i = 0; i < maxAttempts; i++) {
    view.setBigUint64(24, BigInt.asUintN(64, base + BigInt(i)));
    saltInput.set(salt, 20);
    addrInput.set(getBytes(keccak256(saltInput)), 21);
    const hash = keccak256(addrInput);
    // Address = last 20 bytes of the hash; its first byte is hex chars 26-27.
    if (hash.slice(26, 28) === '00' && parseInt(hash.slice(28, 30), 16) < 0x80) {
      return { salt: '0x' + Array.from(salt, (b) => b.toString(16).padStart(2, '0')).join(''), address: getAddress('0x' + hash.slice(26)), attempts: i + 1 };
    }
  }
  throw new SaltMiningError(maxAttempts);
}
