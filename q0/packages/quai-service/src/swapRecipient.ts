// "Receive to another wallet": who may receive the output of a swap, and how a route's hops are addressed when they do.
//
// A swap normally pays its output to the wallet that signs it. The routers (Circleswap's, and the Uniswap-V2-style routers of
// Quaiswap and Quainance) all take an explicit `to`, so sending the output elsewhere is only a matter of putting a different
// address in that one slot. What matters is that the address is safe to put there: a mistyped, wrong-zone, Qi or burn address, or
// a token or router contract, would swallow the output with no way to get it back. Everything here is pure and has no network or
// SDK dependency (the checksum uses keccak.ts), so it can run in the main bundle.

import { checksumAddress } from './keccak';

export type RecipientProblem = 'empty' | 'format' | 'zone' | 'qi' | 'zero' | 'checksum' | 'protocol';

export type RecipientCheck =
    | {
          ok: true;
          /** EIP-55 checksummed. */
          address: string;
          /** The connected wallet itself: the swap behaves exactly as an ordinary one. */
          isSelf: boolean;
          /** 'verified' when mixed-case input matched its checksum; 'none' when the input carried no checksum to verify. */
          checksum: 'verified' | 'none';
      }
    | { ok: false; reason: RecipientProblem; error: string };

export interface RecipientContext {
    /** The connected wallet, if any. */
    sender?: string | null;
    /** Addresses that would swallow the output: token contracts, routers, factories, pools. */
    blocked?: { address: string; label: string }[];
}

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Invisible formatting characters that ride along when an address is copied from a chat app, web page or PDF: the soft hyphen
 * (U+00AD), the Arabic letter mark (U+061C), the Mongolian vowel separator (U+180E), zero-width space, joiners and direction marks
 * (U+200B-U+200F), bidi embeddings and overrides (U+202A-U+202E), the word joiner and invisible operators (U+2060-U+2064), bidi
 * isolates (U+2066-U+2069) and the byte-order mark (U+FEFF). `String.prototype.trim` strips only the last of these, so a perfectly
 * good address would be refused with an error that contradicts what the user can see. They are removed before validation, never
 * after: the address that is checked, shown for confirmation and put in the transaction is the cleaned, checksummed one. Written
 * with code points so the source stays plain ASCII.
 */
const INVISIBLE = new RegExp(
    '[' + [[0x00ad, 0x00ad], [0x061c, 0x061c], [0x180e, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]]
        .map(([a, b]) => String.fromCharCode(a) + '-' + String.fromCharCode(b)).join('') + ']',
    'g'
);

/**
 * Decides whether `input` is a safe place to send a swap's output.
 *
 * Refused outright: anything that is not a full 20-byte address; an address outside Cyprus-1 (this app only moves assets on
 * Cyprus-1, whose addresses start 0x00); a Qi (UTXO) address, which cannot hold ERC-20 tokens; the zero address; a mixed-case
 * address whose EIP-55 checksum is wrong (a typo); and any contract in `blocked` (a token, router, factory or pool: tokens sent to
 * those are lost). A contract that is not on that list is allowed, and the caller is expected to warn about it.
 */
export function parseSwapRecipient(input: string, ctx: RecipientContext = {}): RecipientCheck {
    // A capital X in the prefix is the same address (0X...); everything else about the input is checked as typed.
    const raw = input.replace(INVISIBLE, '').trim().replace(/^0X/, '0x');
    if (!raw) return { ok: false, reason: 'empty', error: 'Enter the wallet address that should receive the assets.' };
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) {
        return { ok: false, reason: 'format', error: 'That is not a wallet address: it must be 0x followed by 40 hexadecimal characters.' };
    }
    const lower = raw.toLowerCase();
    if (lower === ZERO) return { ok: false, reason: 'zero', error: 'The zero address is a burn address: anything sent there is destroyed.' };
    if (!lower.startsWith('0x00')) {
        return { ok: false, reason: 'zone', error: 'That is not a Cyprus-1 address (it must start with 0x00). Assets cannot be received at an address in another zone.' };
    }
    if ((parseInt(lower.slice(4, 6), 16) & 0x80) === 0x80) {
        return { ok: false, reason: 'qi', error: 'That is a Qi (UTXO) address. It cannot receive tokens: use a Quai address.' };
    }
    const body = raw.slice(2);
    const mixed = /[a-f]/.test(body) && /[A-F]/.test(body);
    const checksummed = checksumAddress(lower);
    if (mixed && checksummed !== raw) {
        return { ok: false, reason: 'checksum', error: 'The address has a typo: its upper/lower-case checksum does not match. Check it, or paste it again from where you copied it.' };
    }
    const hit = ctx.blocked?.find(b => b.address.toLowerCase() === lower);
    if (hit) return { ok: false, reason: 'protocol', error: `That is ${hit.label}, not a wallet. Anything sent to it would be lost.` };
    return { ok: true, address: checksummed, isSelf: !!ctx.sender && ctx.sender.toLowerCase() === lower, checksum: mixed ? 'verified' : 'none' };
}

/**
 * Where hop `segmentIndex` of a route that is split across routers should send its output. Every segment but the last pays the
 * connected wallet, because the next segment spends from it; only the last pays the recipient.
 */
export function recipientForSegment(segmentIndex: number, segmentCount: number, sender: string, recipient: string): string {
    return segmentIndex === segmentCount - 1 ? recipient : sender;
}
