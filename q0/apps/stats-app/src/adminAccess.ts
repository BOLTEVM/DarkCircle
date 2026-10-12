// Who may see the Deploy tab. Pure functions, no imports, so they run under plain `node --test`.
//
// This decides what the interface SHOWS. It is not access control: the Deploy tools only hold public contract bytecode,
// and everything they do needs a signature from the connected wallet, which the contracts themselves check. Hiding the
// tab keeps the public from being offered controls that are not theirs.

/** A Cyprus-1 address: 20 bytes, starting 0x00. */
const ADDRESS = /^0x00[0-9a-fA-F]{38}$/;

/**
 * Administrator addresses from a build-time list (VITE_ADMIN_ADDRESSES: comma, space or semicolon separated). Anything that
 * is not a Cyprus-1 address is dropped rather than half-trusted; a typo can only make the list shorter.
 */
export function parseAdminList(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(s => ADDRESS.test(s))
    .map(s => s.toLowerCase());
}

/**
 * Is `wallet` an administrator? True when it is one of the farm's on-chain owners (read from the contract, so it follows an
 * ownership transfer) or is on the build-time list. No wallet connected means not an administrator.
 */
export function isAdministrator(wallet: string | null | undefined, onChainOwners: ReadonlyArray<string | null | undefined>, listed: readonly string[]): boolean {
  if (!wallet || !ADDRESS.test(wallet)) return false;
  const w = wallet.toLowerCase();
  if (listed.includes(w)) return true;
  return onChainOwners.some(o => typeof o === 'string' && o.toLowerCase() === w);
}

/**
 * The Deploy tab is offered to an administrator, and to nobody else, with one exception: a development build on this
 * machine against a network where nothing is deployed yet. There is no owner to check at that point, and that is the one
 * moment the page is needed to create one. A production build never takes the exception.
 */
export function deployTabVisible(input: { isAdmin: boolean; production: boolean; onThisMachine: boolean; anythingDeployed: boolean }): boolean {
  if (input.isAdmin) return true;
  return !input.production && input.onThisMachine && !input.anythingDeployed;
}
