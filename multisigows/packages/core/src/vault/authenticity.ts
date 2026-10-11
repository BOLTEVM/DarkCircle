import { getAddress, keccak256 } from 'ethers';
import { PINNED_CONTRACTS, V2_DEPLOYMENTS, VaultDeploymentRecord } from '../pinned.js';
import { factoryInterface, ERC1967_IMPLEMENTATION_SLOT } from './abi.js';
import { isCyprus1QuaiAddress } from './create2.js';
import { BlockTag, RpcLike, callAt, codeAt, storageAt } from './rpc.js';
import { VaultSnapshot, VaultStateMismatchError, readVaultSnapshot } from './reader.js';

export interface VaultDeployment {
  chainId: number;
  factory: string;
  implementation: string;
  /** First block that can contain our contracts, when known (recorded deployments only). */
  factoryBlock: number | null;
  /** 'recorded' = from packages/contracts/deployments; 'override' = supplied at runtime and verified on chain. */
  source: 'recorded' | 'override';
}

export class NoDeploymentError extends Error {
  constructor(readonly chainId: number) {
    super(`SafeBuddy v2 has no recorded deployment on chain ${chainId}.`);
    this.name = 'NoDeploymentError';
  }
}

export class FactoryAuthenticityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactoryAuthenticityError';
  }
}

export class UnknownVaultCodeError extends Error {
  constructor(readonly address: string, readonly codeHash: string | null, detail?: string) {
    super(
      detail ??
        (codeHash === null
          ? `${address} has no contract code. It is not a vault.`
          : `${address} is a contract, but its code (hash ${codeHash}) is not a SafeBuddy v2 vault. ` +
            'Any contract can answer getOwners()/getThreshold() with made-up values, so it is not treated as a vault.')
    );
    this.name = 'UnknownVaultCodeError';
  }
}

/** Zeroes the byte ranges a contract's immutables occupy, so its code compares to the compiled template. */
export function maskImmutables(code: string, ranges: ReadonlyArray<{ start: number; length: number }>): string {
  let hex = code.replace(/^0x/, '').toLowerCase();
  for (const r of ranges) {
    const a = r.start * 2;
    const b = (r.start + r.length) * 2;
    if (b > hex.length) return '0x' + hex; // shorter than the template; the hash check fails anyway
    hex = hex.slice(0, a) + '0'.repeat(b - a) + hex.slice(b);
  }
  return '0x' + hex;
}

async function readFactory<T = any>(rpc: RpcLike, factory: string, fn: string, args: unknown[], tag: BlockTag): Promise<T> {
  const raw = await callAt(rpc, factory, factoryInterface.encodeFunctionData(fn, args), tag);
  return factoryInterface.decodeFunctionResult(fn, raw)[0] as T;
}

/**
 * Proves `factory` is a genuine SafeBuddyVaultFactory pointing at the genuine vault
 * implementation: its code equals the compiled template outside the immutable ranges, and
 * the immutables themselves (implementation, proxyCodeHash) match the pinned builds.
 */
export async function verifyFactory(rpc: RpcLike, factoryAddress: string, tag: BlockTag = 'latest'): Promise<{ factory: string; implementation: string }> {
  if (!isCyprus1QuaiAddress(factoryAddress)) throw new FactoryAuthenticityError(`${factoryAddress} is not a Cyprus-1 Quai address.`);
  const factory = getAddress(factoryAddress);
  const pin = PINNED_CONTRACTS.SafeBuddyVaultFactoryV2;
  const code = await codeAt(rpc, factory, tag);
  if (code === '0x') throw new FactoryAuthenticityError(`${factory} has no code; it is not the SafeBuddy factory.`);
  if ((code.length - 2) / 2 !== pin.runtimeBytes || keccak256(maskImmutables(code, pin.immutableRanges)) !== pin.runtimeCodeHash) {
    throw new FactoryAuthenticityError(`${factory} is not a SafeBuddy v2 factory: its code differs from the pinned build.`);
  }
  const [implementation, proxyCodeHash] = await Promise.all([
    readFactory<string>(rpc, factory, 'implementation', [], tag),
    readFactory<string>(rpc, factory, 'proxyCodeHash', [], tag),
  ]);
  if (proxyCodeHash !== PINNED_CONTRACTS.SafeBuddyVaultProxyV2.runtimeCodeHash) {
    throw new FactoryAuthenticityError(`Factory ${factory} deploys a proxy that is not the pinned SafeBuddyVaultProxy.`);
  }
  const implCode = await codeAt(rpc, implementation, tag);
  if (keccak256(implCode) !== PINNED_CONTRACTS.SafeBuddyVaultV2.runtimeCodeHash) {
    throw new FactoryAuthenticityError(`Factory ${factory} points at ${implementation}, which is not the pinned SafeBuddyVault implementation.`);
  }
  return { factory, implementation: getAddress(implementation) };
}

export function recordedDeployment(chainId: number): VaultDeploymentRecord | undefined {
  return V2_DEPLOYMENTS.find((d) => d.chainId === chainId);
}

/**
 * The factory and implementation to trust on `chainId`: the recorded deployment, or an
 * explicitly configured factory. Either way it is verified on chain before use.
 */
export async function resolveDeployment(rpc: RpcLike, chainId: number, overrideFactory?: string | null): Promise<VaultDeployment> {
  const recorded = recordedDeployment(chainId);
  const factoryAddress = overrideFactory?.trim() || recorded?.factory;
  if (!factoryAddress) throw new NoDeploymentError(chainId);
  const verified = await verifyFactory(rpc, factoryAddress);
  const isRecorded = recorded !== undefined && recorded.factory.toLowerCase() === verified.factory.toLowerCase();
  if (isRecorded && recorded!.implementation.toLowerCase() !== verified.implementation.toLowerCase()) {
    throw new FactoryAuthenticityError(`Recorded factory ${recorded!.factory} points at a different implementation than recorded.`);
  }
  return {
    chainId,
    factory: verified.factory,
    implementation: verified.implementation,
    factoryBlock: isRecorded ? recorded!.factoryBlock : null,
    source: isRecorded ? 'recorded' : 'override',
  };
}

export interface VerifiedVault {
  address: string;
  codeHash: string;
  deployment: VaultDeployment;
  snapshot: VaultSnapshot;
}

/**
 * Proves an address is a genuine SafeBuddy v2 vault before anything treats it as one:
 *  1. its code is exactly the pinned proxy,
 *  2. the proxy's ERC-1967 slot points at the deployment's implementation,
 *  3. the deployment's factory created it (isWallet), which also means it was initialised
 *     in the same transaction,
 * and only then reads owners, threshold, delay and balance.
 */
export async function assertVaultAuthentic(
  rpc: RpcLike,
  rawAddress: string,
  deployment: VaultDeployment,
  tag: BlockTag = 'latest'
): Promise<VerifiedVault> {
  if (!isCyprus1QuaiAddress(rawAddress)) throw new UnknownVaultCodeError(rawAddress, null, `${rawAddress} is not a Cyprus-1 Quai address.`);
  const address = getAddress(rawAddress);

  const code = await codeAt(rpc, address, tag);
  if (code === '0x') throw new UnknownVaultCodeError(address, null);
  const codeHash = keccak256(code);
  if (codeHash !== PINNED_CONTRACTS.SafeBuddyVaultProxyV2.runtimeCodeHash) throw new UnknownVaultCodeError(address, codeHash);

  const word = (await storageAt(rpc, address, ERC1967_IMPLEMENTATION_SLOT, tag)).replace(/^0x/, '').padStart(64, '0');
  const implementation = getAddress('0x' + word.slice(24));
  if (!/^0{24}$/.test(word.slice(0, 24)) || implementation.toLowerCase() !== deployment.implementation.toLowerCase()) {
    throw new UnknownVaultCodeError(address, codeHash, `${address} runs implementation ${implementation}, not the SafeBuddy implementation ${deployment.implementation}.`);
  }
  const created = await readFactory<boolean>(rpc, deployment.factory, 'isWallet', [address], tag);
  if (!created) {
    throw new UnknownVaultCodeError(address, codeHash, `${address} was not created by the SafeBuddy factory ${deployment.factory}.`);
  }

  const snapshot = await readVaultSnapshot(rpc, address, tag);
  return { address, codeHash, deployment, snapshot };
}

/**
 * After a creation, confirms the vault on chain is exactly what the user asked for. A
 * mismatch means the wrong thing was created and the address must not be saved.
 */
export function assertVaultMatchesParams(
  vault: VerifiedVault,
  expected: { owners: readonly string[]; threshold: number; minExecutionDelay: number }
): void {
  const norm = (list: readonly string[]) => list.map((a) => a.toLowerCase()).sort();
  const got = norm(vault.snapshot.owners);
  const want = norm(expected.owners);
  if (got.length !== want.length || got.some((a, i) => a !== want[i])) {
    throw new VaultStateMismatchError(`Vault ${vault.address} has owners [${vault.snapshot.owners.join(', ')}], expected [${expected.owners.join(', ')}].`);
  }
  if (vault.snapshot.threshold !== expected.threshold) {
    throw new VaultStateMismatchError(`Vault ${vault.address} has threshold ${vault.snapshot.threshold}, expected ${expected.threshold}.`);
  }
  if (vault.snapshot.minExecutionDelay !== expected.minExecutionDelay) {
    throw new VaultStateMismatchError(`Vault ${vault.address} has a ${vault.snapshot.minExecutionDelay}s delay, expected ${expected.minExecutionDelay}s.`);
  }
}
