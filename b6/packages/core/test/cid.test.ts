import { describe, expect, it } from 'vitest';
import { canonicalJson, ipfsCidV0 } from '../src/cid.js';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('ipfsCidV0', () => {
  // Vectors printed by `ipfs add --only-hash` (kubo, default chunker, CIDv0).
  it('matches IPFS for the empty file', () => {
    expect(ipfsCidV0(new Uint8Array())).toBe('QmbFMke1KXqnYyBBWxB74N4c5SBnJMVAiMNRcGu6x1AwQH');
  });

  it('matches IPFS for "hello world\\n"', () => {
    expect(ipfsCidV0(bytes('hello world\n'))).toBe('QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o');
  });

  it('is always 46 characters and starts with Qm', () => {
    const cid = ipfsCidV0(bytes('x'.repeat(5000)));
    expect(cid).toHaveLength(46);
    expect(cid.startsWith('Qm')).toBe(true);
  });

  it('refuses documents that IPFS would split into chunks', () => {
    expect(() => ipfsCidV0(new Uint8Array(262_145))).toThrow(/at most 262144/);
  });
});

describe('canonicalJson', () => {
  it('produces identical bytes regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: [2, { y: 2, z: 1 }] }, b: 1 }));
  });
});
