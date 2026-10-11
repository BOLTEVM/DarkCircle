import { getAddress } from 'ethers';
import { erc20Interface, vaultInterface, ADMIN_FUNCTIONS, AdminFunction } from './abi.js';

export type AdminCall =
  | { fn: 'addOwner'; owner: string; newThreshold: bigint }
  | { fn: 'removeOwner'; owner: string; newThreshold: bigint }
  | { fn: 'changeThreshold'; newThreshold: bigint }
  | { fn: 'setMinExecutionDelay'; newDelay: bigint }
  | { fn: 'cancelByConsensus'; txHash: string };

export type DecodedCall =
  | { kind: 'native-transfer'; to: string; value: bigint }
  | { kind: 'erc20-transfer'; token: string; recipient: string; amount: bigint; value: bigint }
  | { kind: 'erc20-approve'; token: string; spender: string; amount: bigint; unlimited: boolean; value: bigint }
  | { kind: 'admin'; call: AdminCall }
  /** A call to the vault itself that is not one of its admin functions (the vault refuses these). */
  | { kind: 'self-call-unknown'; selector: string; reason: string }
  | { kind: 'contract-call'; to: string; value: bigint; selector: string; dataBytes: number; note?: string };

const TRANSFER = erc20Interface.getFunction('transfer')!;
const APPROVE = erc20Interface.getFunction('approve')!;
/** At or above this an approval is treated as unlimited (2^255, as many wallets do). */
const UNLIMITED_APPROVAL = 1n << 255n;

function selectorOf(data: string): string {
  return data.length >= 10 ? data.slice(0, 10).toLowerCase() : data.toLowerCase();
}

/**
 * Decodes calldata only when it re-encodes to exactly the same bytes. Anything with trailing
 * bytes, dirty padding or a short payload is not decoded, so the review never shows a clean
 * interpretation of data that could be read differently by the callee.
 */
function decodeCanonical(iface: typeof vaultInterface, name: string, data: string): any[] | null {
  try {
    const args = iface.decodeFunctionData(name, data);
    const reencoded = iface.encodeFunctionData(name, args);
    return reencoded.toLowerCase() === data.toLowerCase() ? Array.from(args) : null;
  } catch {
    return null;
  }
}

function decodeAdmin(data: string): AdminCall | null {
  for (const fn of ADMIN_FUNCTIONS) {
    if (selectorOf(data) !== vaultInterface.getFunction(fn)!.selector) continue;
    const args = decodeCanonical(vaultInterface, fn, data);
    if (!args) return null;
    switch (fn as AdminFunction) {
      case 'addOwner':
        return { fn: 'addOwner', owner: getAddress(args[0]), newThreshold: BigInt(args[1]) };
      case 'removeOwner':
        return { fn: 'removeOwner', owner: getAddress(args[0]), newThreshold: BigInt(args[1]) };
      case 'changeThreshold':
        return { fn: 'changeThreshold', newThreshold: BigInt(args[0]) };
      case 'setMinExecutionDelay':
        return { fn: 'setMinExecutionDelay', newDelay: BigInt(args[0]) };
      case 'cancelByConsensus':
        return { fn: 'cancelByConsensus', txHash: String(args[0]).toLowerCase() };
    }
  }
  return null;
}

export function decodeVaultCall(tx: { vault: string; to: string; value: bigint; data: string }): DecodedCall {
  const data = tx.data || '0x';
  const to = getAddress(tx.to);
  const selector = selectorOf(data);

  if (to.toLowerCase() === tx.vault.toLowerCase()) {
    const call = decodeAdmin(data);
    if (call) return { kind: 'admin', call };
    const known = ADMIN_FUNCTIONS.some((fn) => vaultInterface.getFunction(fn)!.selector === selector);
    return {
      kind: 'self-call-unknown',
      selector,
      reason: known ? 'admin call with non-canonical encoding' : 'not an admin function of the vault',
    };
  }

  if (data === '0x') return { kind: 'native-transfer', to, value: tx.value };

  if (selector === TRANSFER.selector) {
    const args = decodeCanonical(erc20Interface, 'transfer', data);
    if (args) return { kind: 'erc20-transfer', token: to, recipient: getAddress(args[0]), amount: BigInt(args[1]), value: tx.value };
    return { kind: 'contract-call', to, value: tx.value, selector, dataBytes: (data.length - 2) / 2, note: 'looks like transfer() but is not canonically encoded' };
  }
  if (selector === APPROVE.selector) {
    const args = decodeCanonical(erc20Interface, 'approve', data);
    if (args) {
      const amount = BigInt(args[1]);
      return { kind: 'erc20-approve', token: to, spender: getAddress(args[0]), amount, unlimited: amount >= UNLIMITED_APPROVAL, value: tx.value };
    }
    return { kind: 'contract-call', to, value: tx.value, selector, dataBytes: (data.length - 2) / 2, note: 'looks like approve() but is not canonically encoded' };
  }
  return { kind: 'contract-call', to, value: tx.value, selector, dataBytes: (data.length - 2) / 2 };
}
