// keccak256 with no dependencies, so the browser bundle can check on-chain code without loading the quais SDK.
//
// This is the original Keccak padding (0x01), the one Ethereum and Quai use, NOT the standardised SHA3-256 (0x06): the
// two give different digests for the same input. The test suite compares this against quais' keccak256 on inputs of
// every length around the block boundary.
//
// Lanes are kept as pairs of 32-bit halves in Uint32Arrays: BigInt lanes would make hashing the ~20 KB of a router's
// code take seconds on a phone.

const RATE = 136; // bytes per block for a 256-bit digest (1600 - 2 * 256) / 8

// Round constants, generated with the specification's LFSR (rc(t) = x^t mod x^8 + x^6 + x^5 + x^4 + 1) rather than typed.
function roundConstants(): { lo: Uint32Array; hi: Uint32Array } {
    const lo = new Uint32Array(24);
    const hi = new Uint32Array(24);
    let r = 1;
    for (let round = 0; round < 24; round++) {
        let value = 0n;
        for (let j = 0; j < 7; j++) {
            if (r & 1) value |= 1n << BigInt((1 << j) - 1);
            r = r & 0x80 ? ((r << 1) ^ 0x71) & 0xff : (r << 1) & 0xff;
        }
        lo[round] = Number(value & 0xffffffffn);
        hi[round] = Number((value >> 32n) & 0xffffffffn);
    }
    return { lo, hi };
}

const RC = roundConstants();
// Rotation offsets and the lane permutation of the combined rho + pi step, in the order they are applied.
const ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

function permute(s: Uint32Array): void {
    const bcLo = new Uint32Array(5);
    const bcHi = new Uint32Array(5);
    for (let round = 0; round < 24; round++) {
        // theta
        for (let i = 0; i < 5; i++) {
            bcLo[i] = s[2 * i] ^ s[2 * (i + 5)] ^ s[2 * (i + 10)] ^ s[2 * (i + 15)] ^ s[2 * (i + 20)];
            bcHi[i] = s[2 * i + 1] ^ s[2 * (i + 5) + 1] ^ s[2 * (i + 10) + 1] ^ s[2 * (i + 15) + 1] ^ s[2 * (i + 20) + 1];
        }
        for (let i = 0; i < 5; i++) {
            const a = (i + 1) % 5;
            const b = (i + 4) % 5;
            // rotl64(bc[a], 1)
            const rLo = (bcLo[a] << 1) | (bcHi[a] >>> 31);
            const rHi = (bcHi[a] << 1) | (bcLo[a] >>> 31);
            const tLo = bcLo[b] ^ rLo;
            const tHi = bcHi[b] ^ rHi;
            for (let j = 0; j < 25; j += 5) {
                s[2 * (j + i)] ^= tLo;
                s[2 * (j + i) + 1] ^= tHi;
            }
        }
        // rho + pi
        let tLo = s[2];
        let tHi = s[3];
        for (let i = 0; i < 24; i++) {
            const j = PILN[i];
            const n = ROTC[i];
            const oLo = s[2 * j];
            const oHi = s[2 * j + 1];
            let nLo: number;
            let nHi: number;
            if (n === 32) {
                nLo = tHi;
                nHi = tLo;
            } else if (n < 32) {
                nLo = (tLo << n) | (tHi >>> (32 - n));
                nHi = (tHi << n) | (tLo >>> (32 - n));
            } else {
                const m = n - 32;
                nLo = (tHi << m) | (tLo >>> (32 - m));
                nHi = (tLo << m) | (tHi >>> (32 - m));
            }
            s[2 * j] = nLo;
            s[2 * j + 1] = nHi;
            tLo = oLo;
            tHi = oHi;
        }
        // chi
        for (let j = 0; j < 25; j += 5) {
            for (let i = 0; i < 5; i++) {
                bcLo[i] = s[2 * (j + i)];
                bcHi[i] = s[2 * (j + i) + 1];
            }
            for (let i = 0; i < 5; i++) {
                s[2 * (j + i)] ^= ~bcLo[(i + 1) % 5] & bcLo[(i + 2) % 5];
                s[2 * (j + i) + 1] ^= ~bcHi[(i + 1) % 5] & bcHi[(i + 2) % 5];
            }
        }
        // iota
        s[0] ^= RC.lo[round];
        s[1] ^= RC.hi[round];
    }
}

/** keccak256 of raw bytes, as a lower-case 0x-prefixed hex string. */
export function keccak256Bytes(input: Uint8Array): string {
    const state = new Uint32Array(50);
    const xorByte = (position: number, value: number) => {
        // little-endian bytes into 32-bit halves of consecutive lanes
        state[position >> 2] ^= value << ((position & 3) * 8);
    };
    let offset = 0;
    while (input.length - offset >= RATE) {
        for (let i = 0; i < RATE; i++) xorByte(i, input[offset + i]);
        permute(state);
        offset += RATE;
    }
    const rest = input.length - offset;
    for (let i = 0; i < rest; i++) xorByte(i, input[offset + i]);
    xorByte(rest, 0x01);
    xorByte(RATE - 1, 0x80);
    permute(state);

    let out = '';
    for (let i = 0; i < 32; i++) out += ((state[i >> 2] >>> ((i & 3) * 8)) & 0xff).toString(16).padStart(2, '0');
    return '0x' + out;
}

/** keccak256 of a 0x-prefixed hex string (an even number of hex digits), the form `quai_getCode` returns. */
export function keccak256Hex(hex: string): string {
    if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error('keccak256Hex needs 0x-prefixed hex with whole bytes.');
    const length = (hex.length - 2) / 2;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
    return keccak256Bytes(bytes);
}

/**
 * The EIP-55 mixed-case form of an address. `quai_getCode` refuses an address whose case is not its checksum (even
 * all-lower-case), while `quai_call` does not care, so code reads need this.
 */
export function checksumAddress(address: string): string {
    if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Not an address: ${String(address).slice(0, 46)}`);
    const lower = address.slice(2).toLowerCase();
    const hash = keccak256Bytes(new TextEncoder().encode(lower)).slice(2);
    let out = '0x';
    for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
    return out;
}
