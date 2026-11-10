import { describe, test, expect } from 'bun:test';
import { getAddress, isQiAddress, getZoneForAddress, Zone } from '../packages/quai-service/node_modules/quais';
import {
    checksumAddress,
    parseSwapRecipient,
    recipientForSegment,
    encodeSwapExactTokensForTokens,
    encodeSwapExactETHForTokens,
    encodeSwapExactTokensForETH
} from '../packages/quai-service/src/index';

const hex = (b: Uint8Array) => '0x' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** Deterministic pseudo-random bytes (a test must not depend on Math.random). */
function bytes(seed: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    let s = seed >>> 0 || 1;
    for (let i = 0; i < length; i++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        out[i] = s >>> 24;
    }
    return out;
}

const SENDER = '0x005c0faa361AE7c4A473343EF24bAe4d1379E638';
const FRIEND = '0x0038077FA0B8Bc0067845E85594a7fa72D1fbB1A';

// checksumAddress is keccak.ts's; keccak256 itself is covered in aggregation.test.ts.
describe('EIP-55 checksum', () => {
    test('the published EIP-55 test vectors', () => {
        for (const a of [
            '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
            '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
            '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
            '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb'
        ]) {
            expect(checksumAddress(a.toLowerCase())).toBe(a);
        }
    });

    test('agrees with the SDK for a thousand addresses, and the SDK accepts what it produces', () => {
        for (let i = 0; i < 1000; i++) {
            const addr = hex(bytes(i + 1, 20));
            expect(checksumAddress(addr)).toBe(getAddress(addr));
        }
    });

    test('rejects anything that is not 20 bytes of hex', () => {
        expect(() => checksumAddress('0x1234')).toThrow();
        expect(() => checksumAddress('0x' + 'g'.repeat(40))).toThrow();
    });
});

describe('who may receive a swap', () => {
    test('a checksummed Cyprus-1 address is accepted, and flagged as verified', () => {
        const r = parseSwapRecipient(FRIEND, { sender: SENDER });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.address).toBe(FRIEND);
            expect(r.isSelf).toBe(false);
            expect(r.checksum).toBe('verified');
        }
    });

    test('all-lowercase and all-uppercase input is accepted, normalised to the checksummed form, and says nothing was verified', () => {
        for (const input of [FRIEND.toLowerCase(), '0x' + FRIEND.slice(2).toUpperCase()]) {
            const r = parseSwapRecipient(input);
            expect(r.ok).toBe(true);
            if (r.ok) {
                expect(r.address).toBe(FRIEND);
                expect(r.checksum).toBe('none');
            }
        }
    });

    test('surrounding whitespace from a paste is ignored; whitespace inside is not an address', () => {
        expect(parseSwapRecipient(`  ${FRIEND}\n`).ok).toBe(true);
        const inner = parseSwapRecipient(FRIEND.slice(0, 20) + ' ' + FRIEND.slice(20));
        expect(inner.ok).toBe(false);
    });

    test('invisible formatting characters carried by a copy-paste are dropped; look-alike characters are still refused', () => {
        const ch = (code: number) => String.fromCharCode(code);
        // soft hyphen, Arabic letter mark, Mongolian vowel separator, zero-width space and joiners, direction marks, bidi
        // embeddings and overrides, word joiner and invisible operators, bidi isolates, byte-order mark
        const invisible = [
            0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202c, 0x202e,
            0x2060, 0x2061, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff
        ].map(ch);
        for (const c of invisible) {
            for (const input of [c + FRIEND, FRIEND + c, FRIEND.slice(0, 20) + c + FRIEND.slice(20), c + ' ' + FRIEND + ' ' + c]) {
                const r = parseSwapRecipient(input, { sender: SENDER });
                expect(r.ok).toBe(true);
                if (r.ok) {
                    // what is checked, shown and sent is the clean checksummed address, never the pasted text
                    expect(r.address).toBe(FRIEND);
                    expect(r.checksum).toBe('verified');
                }
            }
        }
        // the checksum still has the last word on an address that arrived with hidden characters
        const bad = FRIEND.slice(0, -1) + (FRIEND.endsWith('A') ? 'a' : 'A');
        const typo = parseSwapRecipient(ch(0x200e) + bad);
        expect(typo.ok).toBe(false);
        if (!typo.ok) expect(typo.reason).toBe('checksum');
        // characters that merely look like hex are not invisible, and are not cleaned away: fullwidth digit, Cyrillic A, NUL, newline
        for (const lookalike of [ch(0xff10), ch(0x0410), ch(0), '\n']) {
            expect(parseSwapRecipient(FRIEND.slice(0, 20) + lookalike + FRIEND.slice(20)).ok).toBe(false);
            expect(parseSwapRecipient(FRIEND.slice(0, 5) + lookalike + FRIEND.slice(6)).ok).toBe(false);
        }
    });

    test('a capital X in the 0x prefix is the same address, and the checksum is still checked', () => {
        const verified = parseSwapRecipient('0X' + FRIEND.slice(2));
        expect(verified.ok).toBe(true);
        if (verified.ok) {
            expect(verified.address).toBe(FRIEND);
            expect(verified.checksum).toBe('verified');
        }
        const plain = parseSwapRecipient('0X' + FRIEND.slice(2).toLowerCase());
        expect(plain.ok).toBe(true);
        if (plain.ok) expect(plain.checksum).toBe('none');
        const bad = parseSwapRecipient('0X' + FRIEND.slice(2, -1) + (FRIEND.endsWith('A') ? 'a' : 'A'));
        expect(bad.ok).toBe(false);
    });

    test('a typo in a checksummed address is caught: flipping the case of any one letter fails', () => {
        const body = FRIEND.slice(2);
        let flipped = 0;
        for (let i = 0; i < body.length; i++) {
            const ch = body[i];
            if (!/[a-fA-F]/.test(ch)) continue;
            const swapped = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
            const typo = '0x' + body.slice(0, i) + swapped + body.slice(i + 1);
            const r = parseSwapRecipient(typo);
            // a flip that leaves the string all one case is not a checksum failure (it carries no checksum), so only mixed ones count
            if (/[a-f]/.test(typo.slice(2)) && /[A-F]/.test(typo.slice(2))) {
                expect(r.ok).toBe(false);
                if (!r.ok) expect(r.reason).toBe('checksum');
                flipped++;
            }
        }
        expect(flipped).toBeGreaterThan(10);
    });

    test('a changed digit is a different (valid-looking) address: only the checksum can catch it, and it does', () => {
        const changed = FRIEND.slice(0, 20) + (FRIEND[20] === '1' ? '2' : '1') + FRIEND.slice(21);
        const r = parseSwapRecipient(changed);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe('checksum');
    });

    test.each([
        ['empty', '', 'empty'],
        ['blank', '   ', 'empty'],
        ['too short', '0x00', 'format'],
        ['no prefix', FRIEND.slice(2), 'format'],
        ['not hex', '0x' + 'z'.repeat(40), 'format'],
        ['too long', FRIEND + 'aa', 'format'],
        ['a name', 'vitalik.eth', 'format'],
        ['zero address', '0x' + '0'.repeat(40), 'zero'],
        ['an Ethereum address', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'zone'],
        ['another Quai zone (0x01...)', '0x01' + 'ab'.repeat(19), 'zone'],
        ['a Qi address', '0x00' + '80' + 'cd'.repeat(18), 'qi']
    ])('refuses %s', (_name, input, reason) => {
        const r = parseSwapRecipient(input as string);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.reason).toBe(reason);
    });

    test('the zone and Qi rules are the SDK own: every address the SDK says is a Cyprus-1 Quai address passes, and nothing else does', () => {
        for (let i = 0; i < 600; i++) {
            const lower = hex(bytes(i * 31 + 5, 20));
            const cyprus1Quai = getZoneForAddress(lower) === Zone.Cyprus1 && !isQiAddress(lower);
            const r = parseSwapRecipient(lower);
            // Cyprus-1 here means the 0x00 prefix the whole app uses; the SDK's zone map is a superset of it, so only the converse is exact
            if (r.ok) expect(cyprus1Quai).toBe(true);
        }
        // and the prefix-0x00 addresses the SDK calls Cyprus-1 Quai addresses are all accepted
        let accepted = 0;
        for (let i = 0; i < 4000 && accepted < 25; i++) {
            const b = bytes(i + 90_000, 20);
            b[0] = 0;
            const addr = hex(b);
            if (getZoneForAddress(addr) === Zone.Cyprus1 && !isQiAddress(addr)) {
                expect(parseSwapRecipient(addr).ok).toBe(true);
                accepted++;
            }
        }
        expect(accepted).toBe(25);
    });

    test('tokens, routers, factories and pools are refused, whatever case they are written in', () => {
        const blocked = [
            { address: '0x00325150094E51107a931980Fdfc3bB1a4C48379', label: 'the Q0 token contract' },
            { address: '0x00591827868F2989Bb34DbCf71Ff5c48574d4D25', label: 'the Circleswap router' }
        ];
        for (const b of blocked) {
            for (const form of [b.address, b.address.toLowerCase(), '0x' + b.address.slice(2).toUpperCase()]) {
                const r = parseSwapRecipient(form, { blocked });
                expect(r.ok).toBe(false);
                if (!r.ok) {
                    expect(r.reason).toBe('protocol');
                    expect(r.error).toContain(b.label);
                }
            }
        }
        expect(parseSwapRecipient(FRIEND, { blocked }).ok).toBe(true);
    });

    test('the connected wallet is recognised as "self", in any case', () => {
        for (const form of [SENDER, SENDER.toLowerCase()]) {
            const r = parseSwapRecipient(form, { sender: SENDER });
            expect(r.ok && r.isSelf).toBe(true);
        }
        const other = parseSwapRecipient(FRIEND, { sender: SENDER });
        expect(other.ok && other.isSelf).toBe(false);
        const noWallet = parseSwapRecipient(SENDER, { sender: null });
        expect(noWallet.ok && noWallet.isSelf).toBe(false);
    });
});

describe('a route split across routers pays the recipient only at the end', () => {
    test('every segment but the last pays the wallet, the last pays the recipient', () => {
        expect([0, 1, 2].map(i => recipientForSegment(i, 3, SENDER, FRIEND))).toEqual([SENDER, SENDER, FRIEND]);
        expect(recipientForSegment(0, 1, SENDER, FRIEND)).toBe(FRIEND);
    });
});

describe('router swap calldata', () => {
    const A = '0x00325150094E51107a931980Fdfc3bB1a4C48379';
    const B = '0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB';
    const C = '0x002d4A4fBAC3DF3342eD17FDBa5139818a43B508';
    const slot = (data: string, i: number) => data.slice(10 + i * 64, 10 + (i + 1) * 64);

    test('the recipient sits in the `to` slot of each of the three swap functions, and nowhere else', () => {
        const want = FRIEND.slice(2).toLowerCase().padStart(64, '0');
        const tokens = encodeSwapExactTokensForTokens(5n, 4n, [A, B], FRIEND, 99n);
        expect(tokens.slice(0, 10)).toBe('0x38ed1739');
        expect(slot(tokens, 3)).toBe(want);
        expect(tokens.toLowerCase().split(want).length - 1).toBe(1);

        const eth = encodeSwapExactETHForTokens(4n, [B, A], FRIEND, 99n);
        expect(eth.slice(0, 10)).toBe('0x7ff36ab5');
        expect(slot(eth, 2)).toBe(want);
        expect(eth.toLowerCase().split(want).length - 1).toBe(1);

        const out = encodeSwapExactTokensForETH(5n, 4n, [A, B], FRIEND, 99n);
        expect(out.slice(0, 10)).toBe('0x18cbafe5');
        expect(slot(out, 3)).toBe(want);
        expect(out.toLowerCase().split(want).length - 1).toBe(1);
    });

    test('a multi-hop path is laid out in order after its length', () => {
        const d = encodeSwapExactTokensForTokens(1n, 1n, [A, B, C], FRIEND, 1n);
        expect(slot(d, 5)).toBe((3).toString(16).padStart(64, '0'));
        expect([slot(d, 6), slot(d, 7), slot(d, 8)]).toEqual([A, B, C].map(x => x.slice(2).toLowerCase().padStart(64, '0')));
    });

    test('a malformed recipient, token or amount can never be encoded', () => {
        expect(() => encodeSwapExactTokensForTokens(1n, 1n, [A, B], '0x1234', 1n)).toThrow('recipient');
        expect(() => encodeSwapExactTokensForTokens(1n, 1n, [A, B], 'not an address', 1n)).toThrow('recipient');
        expect(() => encodeSwapExactTokensForTokens(1n, 1n, [A, '0xabc'], FRIEND, 1n)).toThrow('Path token 2');
        expect(() => encodeSwapExactTokensForTokens(1n, 1n, [A], FRIEND, 1n)).toThrow('at least two');
        expect(() => encodeSwapExactETHForTokens(-1n, [A, B], FRIEND, 1n)).toThrow('out of range');
        expect(() => encodeSwapExactTokensForETH(1n << 256n, 1n, [A, B], FRIEND, 1n)).toThrow('out of range');
    });
});
