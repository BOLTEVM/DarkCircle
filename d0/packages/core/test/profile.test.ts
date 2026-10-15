import { describe, expect, it } from 'vitest';
import {
  GUILD,
  GUILD_ROLES,
  PROFILE_LIMITS,
  PROFILE_MARKER,
  VOTING,
  avatarFileToDataUri,
  buildGuildProfile,
  encodeCreateVotingProposal,
  encodeGrant,
  encodeRevoke,
  encodeSetMetadata,
  isAcceptableAvatar,
  parseGuildProfile,
} from '../src/index.js';

const PNG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

describe('guild profile metadata', () => {
  it('keeps plain text plain: what halls stored before still reads as a description', () => {
    const p = parseGuildProfile('Keepers of the crimson flame.');
    expect(p.description).toBe('Keepers of the crimson flame.');
    expect(p.avatar).toBeNull();
    expect(p.links).toEqual([]);
  });

  it('builds plain text when there is nothing but a description', () => {
    expect(buildGuildProfile({ description: 'A quiet order.', avatar: null, links: [] })).toBe('A quiet order.');
  });

  it('round-trips a full profile through the marker form', () => {
    const profile = {
      description: 'Five keys, three to turn.',
      avatar: PNG_DATA,
      links: [{ label: 'Charter', url: 'https://boltevm.com/charter' }],
    };
    const stored = buildGuildProfile(profile);
    expect(stored.startsWith(PROFILE_MARKER)).toBe(true);
    expect(parseGuildProfile(stored)).toEqual(profile);
  });

  it('never throws on garbage: bad JSON after the marker degrades to text', () => {
    const p = parseGuildProfile(`${PROFILE_MARKER}{not json`);
    expect(p.description).toBe('{not json');
    expect(p.avatar).toBeNull();
  });

  it('drops avatars that are not raster data URIs or https/ipfs pointers', () => {
    expect(isAcceptableAvatar(PNG_DATA)).toBe(true);
    expect(isAcceptableAvatar('https://boltevm.com/crest.png')).toBe(true);
    expect(isAcceptableAvatar('ipfs://bafybeigd/crest.png')).toBe(true);
    expect(isAcceptableAvatar('javascript:alert(1)')).toBe(false);
    expect(isAcceptableAvatar('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isAcceptableAvatar('data:text/html;base64,PGI+')).toBe(false);
    const stored = PROFILE_MARKER + JSON.stringify({ description: 'x', avatar: 'javascript:alert(1)' });
    expect(parseGuildProfile(stored).avatar).toBeNull();
  });

  it('drops links with unsafe URLs and caps the count', () => {
    const links = [
      { label: 'ok', url: 'https://boltevm.com' },
      { label: 'bad', url: 'ftp://nope' },
      { label: 'b', url: 'https://b' },
      { label: 'c', url: 'https://c' },
      { label: 'd', url: 'https://d' },
      { label: 'e', url: 'https://e' },
    ];
    const stored = PROFILE_MARKER + JSON.stringify({ description: 'x', links });
    const p = parseGuildProfile(stored);
    expect(p.links).toHaveLength(PROFILE_LIMITS.links);
    expect(p.links.every((l) => l.url.startsWith('https://'))).toBe(true);
  });

  it('trims the description to the display cap', () => {
    const stored = PROFILE_MARKER + JSON.stringify({ description: 'x'.repeat(PROFILE_LIMITS.description + 100) });
    expect(parseGuildProfile(stored).description).toHaveLength(PROFILE_LIMITS.description);
    expect(buildGuildProfile({ description: 'y'.repeat(PROFILE_LIMITS.description + 100), avatar: null, links: [] })).toHaveLength(PROFILE_LIMITS.description);
  });

  it('reads an uploaded crest and refuses oversized or non-raster files', () => {
    const png = avatarFileToDataUri('crest.png', 'image/png', new Uint8Array([137, 80, 78, 71]));
    expect(png).toBe('data:image/png;base64,iVBORw==');
    expect(() => avatarFileToDataUri('crest.svg', 'image/svg+xml', new Uint8Array([60]))).toThrow(/PNG, JPEG, GIF or WebP/);
    expect(() => avatarFileToDataUri('big.png', 'image/png', new Uint8Array(PROFILE_LIMITS.avatarBytes + 1))).toThrow(/must be 24 KB or smaller/);
  });
});

describe('role and metadata calldata', () => {
  const WHO = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

  it('encodes setMetadata so the guild interface reads it back', () => {
    const data = encodeSetMetadata('A new charter.');
    const tx = GUILD.parseTransaction({ data });
    expect(tx?.name).toBe('setMetadata');
    expect(tx?.args[0]).toBe('A new charter.');
  });

  it('encodes grant and revoke with the on-chain role ids', () => {
    const g = GUILD.parseTransaction({ data: encodeGrant(GUILD_ROLES.SET_METADATA, WHO) });
    expect(g?.name).toBe('grant');
    expect(g?.args[0]).toBe(GUILD_ROLES.SET_METADATA);
    expect(String(g?.args[1]).toLowerCase()).toBe(WHO.toLowerCase());
    const r = GUILD.parseTransaction({ data: encodeRevoke(GUILD_ROLES.EXECUTE, WHO) });
    expect(r?.name).toBe('revoke');
    expect(r?.args[0]).toBe(GUILD_ROLES.EXECUTE);
  });

  it('encodes a proposal carrying a steward action, decodable by the voting module', () => {
    const action = { to: WHO, value: 0n, data: encodeSetMetadata('A new charter.') };
    const data = encodeCreateVotingProposal('Rewrite the charter', [action]);
    const tx = VOTING.parseTransaction({ data });
    expect(tx?.name).toBe('createProposal');
    expect(tx?.args[0]).toBe('Rewrite the charter');
    const actions = tx?.args[1] as Array<{ to: string; value: bigint; data: string }>;
    expect(actions).toHaveLength(1);
    expect(String(actions[0]!.to).toLowerCase()).toBe(WHO.toLowerCase());
    expect(actions[0]!.data).toBe(action.data);
  });

  it('keeps the role ids stable: keccak of the contract constants', () => {
    // Pinned against the Solidity constants in Guild.sol.
    expect(GUILD_ROLES.ROOT).toBe('0x79e553c6f53701daa99614646285e66adb98ff0fcc1ef165dd2718e5c873bee6');
    expect(GUILD_ROLES.EXECUTE).toBe('0xcebf517aa4440d1d125e0355aae64401211d0848a23c02cc5d29a14822580ba4');
    expect(GUILD_ROLES.SET_METADATA).toBe('0x15d6474b6601106b7b2c08d7366116467aae69a7837f4f0c06ba1c8ca2cef4ed');
  });
});
