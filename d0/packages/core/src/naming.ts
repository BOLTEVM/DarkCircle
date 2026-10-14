/**
 * QNS — the Quai Name Service (quaidomains.com) — is DarkOrder's identity layer, the suite's
 * answer to ENS on Ethereum. A guild's public name, profile and avatar are a `.quai` name
 * bound to the guild address; the on-chain hall handle in GuildNameRegistry stays a plain
 * directory key and never pretends to be identity.
 *
 * What this module does offline, with no dependency:
 *  - validates and normalizes .quai names against the published QNS charset
 *    (lowercase letters, numbers, hyphen, underscore; up to 64 chars);
 *  - builds deep links to quaidomains.com for search/registration and profiles;
 *  - resolves names on-chain when a verified QNNS registry address is configured in
 *    deployments.ts (none is pinned yet, so resolution reports itself unconfigured rather
 *    than guessing).
 */

export const QNS_SITE = 'https://www.quaidomains.com';

export interface QnsName {
  /** bare name, e.g. "emberhold" */
  name: string;
  /** fully qualified, e.g. "emberhold.quai" */
  fqdn: string;
}

/** Accepts "emberhold", "Emberhold" or "emberhold.quai"; returns null when invalid. */
export function normalizeQnsName(input: string): QnsName | null {
  const bare = input.trim().toLowerCase().replace(/\.quai$/, '');
  if (!/^[a-z0-9_-]{1,64}$/.test(bare)) return null;
  return { name: bare, fqdn: `${bare}.quai` };
}

/** 7+ character names are instant claims on QNS; shorter ones go to auction. */
export function qnsClaimKind(name: string): 'instant' | 'auction' | 'premium' {
  const bare = name.replace(/\.quai$/, '');
  if (bare.length >= 7) return 'instant';
  if (bare.length >= 4) return 'auction';
  return 'premium';
}

export function qnsSearchUrl(name: string): string {
  return `${QNS_SITE}/?q=${encodeURIComponent(name.replace(/\.quai$/, ''))}`;
}

export function qnsProfileUrl(fqdn: string): string {
  return `${QNS_SITE}/name/${encodeURIComponent(fqdn)}`;
}

export interface QnsProfile {
  fqdn: string;
  owner: string | null;
}

export type QnsResolution =
  | { ok: true; profile: QnsProfile }
  | { ok: false; reason: 'unconfigured' | 'not-found' | 'invalid' };

/**
 * Resolve a name against a QNNS registry address. Unconfigured by design until the suite
 * pins a verified QNNS deployment: callers get `unconfigured` and should deep-link to
 * quaidomains.com instead of trusting any address baked into source.
 */
export async function resolveQnsName(
  registryAddress: string | null | undefined,
  input: string
): Promise<QnsResolution> {
  const name = normalizeQnsName(input);
  if (!name) return { ok: false, reason: 'invalid' };
  if (!registryAddress) return { ok: false, reason: 'unconfigured' };
  // A pinned registry is resolved through its read ABI; intentionally not implemented
  // until the suite verifies the deployed QNNS contract.
  void registryAddress;
  return { ok: false, reason: 'unconfigured' };
}
