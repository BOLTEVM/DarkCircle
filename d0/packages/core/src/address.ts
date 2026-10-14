import { getAddress } from 'ethers';
import type { NetworkConfig } from './config.js';

/**
 * Cyprus-1 address rules.
 *
 * On Quai an address belongs to one zone: the first byte is (region << 4) | zone, so Cyprus-1
 * is 0x00. The second byte's top bit separates Quai accounts (below 0x80) from Qi UTXO
 * addresses (0x80 and up). Only a Cyprus-1 Quai account can call a Cyprus-1 contract, so a
 * guild founded anywhere else could never be reached: every address the site sends or names
 * is checked here first.
 */

export interface AddressCheck {
  ok: boolean;
  /** EIP-55 checksummed form; Quai nodes reject all-lowercase addresses. */
  address?: string;
  error?: string;
}

export function checkAddress(raw: unknown, rule: NetworkConfig['addressRule'] = 'cyprus1'): AddressCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'Address must be text.' };
  const trimmed = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { ok: false, error: 'Address must be 0x followed by 40 hexadecimal characters.' };
  }
  let checksummed: string;
  try {
    checksummed = getAddress(trimmed);
  } catch {
    return { ok: false, error: 'Address has an invalid checksum (check the mixed-case letters).' };
  }
  if (rule === 'cyprus1') {
    const zone = trimmed.slice(2, 4).toLowerCase();
    if (zone !== '00') {
      return { ok: false, error: `Address starts with 0x${zone}, so it belongs to another Quai zone. Cyprus-1 addresses start with 0x00.` };
    }
    if (parseInt(trimmed.slice(4, 6), 16) >= 0x80) {
      return { ok: false, error: 'This is a Qi (UTXO) address. Guilds and votes need a Quai account address.' };
    }
  }
  return { ok: true, address: checksummed };
}

export function requireAddress(raw: unknown, rule: NetworkConfig['addressRule'], what: string): string {
  const res = checkAddress(raw, rule);
  if (!res.ok || !res.address) throw new Error(`${what}: ${res.error}`);
  return res.address;
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function shortAddress(address: string, lead = 6, tail = 4): string {
  return address.length > lead + tail + 1 ? `${address.slice(0, lead)}…${address.slice(-tail)}` : address;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
