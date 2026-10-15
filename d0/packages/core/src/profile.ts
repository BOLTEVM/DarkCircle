/**
 * Guild profile metadata: the structured form of a guild's on-chain `metadata` string.
 *
 * The contract stores one string. It stays backward compatible:
 *  - Plain text remains valid and renders as the description alone.
 *  - The structured form is a one-line marker followed by JSON:
 *
 *        darkorder:profile:1\n{"description":"…","avatar":"data:image/png;base64,…","links":[…]}
 *
 * The marker keeps raw user text from ever being misread as a profile, and the version lets
 * a future schema extend it. Parsing never throws: garbage in, best-effort profile out.
 */

export const PROFILE_MARKER = 'darkorder:profile:1\n';

/** Display caps. The chain accepts any string; these keep a hall page readable and the
 *  transaction small (a revert on Quai costs the whole gas limit, so payloads stay lean). */
export const PROFILE_LIMITS = {
  description: 480,
  avatarBytes: 24 * 1024,
  avatarUrl: 200,
  links: 4,
  linkLabel: 24,
} as const;

export interface GuildLink {
  label: string;
  url: string;
}

export interface GuildProfile {
  description: string;
  /** A data: URI (uploaded crest) or an https:// / ipfs:// pointer. Null: the mode icon shows. */
  avatar: string | null;
  links: GuildLink[];
}

export const EMPTY_PROFILE: GuildProfile = { description: '', avatar: null, links: [] };

const AVATAR_DATA_RE = /^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i;
const AVATAR_URL_RE = /^(https:\/\/|ipfs:\/\/)\S+$/;

/** True for an avatar pointer the hall page will render; everything else is dropped. */
export function isAcceptableAvatar(avatar: string): boolean {
  if (AVATAR_DATA_RE.test(avatar)) return avatar.length <= PROFILE_LIMITS.avatarBytes * 2; // base64 is ~4/3 the bytes
  return avatar.length <= PROFILE_LIMITS.avatarUrl && AVATAR_URL_RE.test(avatar);
}

export function isAcceptableLinkUrl(url: string): boolean {
  return /^(https:\/\/|ipfs:\/\/)\S+$/.test(url) && url.length <= 200;
}

function cleanLink(raw: unknown): GuildLink | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { label, url } = raw as Record<string, unknown>;
  if (typeof url !== 'string' || !isAcceptableLinkUrl(url)) return null;
  return { label: typeof label === 'string' && label.trim() ? label.trim().slice(0, PROFILE_LIMITS.linkLabel) : url.replace(/^(https:\/\/|ipfs:\/\/)/, '').slice(0, PROFILE_LIMITS.linkLabel), url };
}

/** Parses the on-chain string into a profile. Never throws; unknown shapes degrade to text. */
export function parseGuildProfile(metadata: string): GuildProfile {
  if (!metadata) return { ...EMPTY_PROFILE };
  if (!metadata.startsWith(PROFILE_MARKER)) return { ...EMPTY_PROFILE, description: metadata };
  try {
    const raw = JSON.parse(metadata.slice(PROFILE_MARKER.length)) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null) return { ...EMPTY_PROFILE, description: metadata };
    const description = typeof raw.description === 'string' ? raw.description.slice(0, PROFILE_LIMITS.description) : '';
    const avatar = typeof raw.avatar === 'string' && isAcceptableAvatar(raw.avatar) ? raw.avatar : null;
    const links = Array.isArray(raw.links) ? raw.links.map(cleanLink).filter((l): l is GuildLink => l !== null).slice(0, PROFILE_LIMITS.links) : [];
    return { description, avatar, links };
  } catch {
    // The marker lied. Show the body as text rather than nothing.
    return { ...EMPTY_PROFILE, description: metadata.slice(PROFILE_MARKER.length) || metadata };
  }
}

/**
 * Serializes a profile for the chain. A profile that is only a description stays plain text —
 * byte-for-byte what halls have always stored — so existing tooling keeps working.
 */
export function buildGuildProfile(profile: GuildProfile): string {
  const description = profile.description.trim().slice(0, PROFILE_LIMITS.description);
  const avatar = profile.avatar && isAcceptableAvatar(profile.avatar) ? profile.avatar : null;
  const links = profile.links.filter((l) => isAcceptableLinkUrl(l.url)).slice(0, PROFILE_LIMITS.links).map((l) => ({
    label: l.label.trim().slice(0, PROFILE_LIMITS.linkLabel) || l.url.slice(0, PROFILE_LIMITS.linkLabel),
    url: l.url,
  }));
  if (!avatar && links.length === 0) return description;
  const body: Record<string, unknown> = { description };
  if (avatar) body.avatar = avatar;
  if (links.length > 0) body.links = links;
  return PROFILE_MARKER + JSON.stringify(body);
}

/**
 * Reads an uploaded crest file into a data URI. Raster formats only — an SVG served from a
 * data: URI in <img> cannot script, but raster keeps the render path uniform everywhere.
 */
export function avatarFileToDataUri(fileName: string, mime: string, bytes: Uint8Array): string {
  const type = mime.toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) {
    throw new Error(`"${fileName}" is ${mime || 'unknown'}; crests are PNG, JPEG, GIF or WebP.`);
  }
  if (bytes.length > PROFILE_LIMITS.avatarBytes) {
    throw new Error(`"${fileName}" is ${Math.ceil(bytes.length / 1024)} KB; a crest must be ${PROFILE_LIMITS.avatarBytes / 1024} KB or smaller so it fits one transaction.`);
  }
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:${type};base64,${btoa(bin)}`;
}
