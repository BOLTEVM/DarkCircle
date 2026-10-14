/**
 * Does the code on chain match the build?
 *
 * A compiler build leaves 32 zero bytes wherever the runtime code reads an `immutable`, and the
 * constructor fills them in at deployment. QuestateBrokerage has one (`deed`), so its code on
 * chain never hashes like the artifact's `deployedBytecode`: comparing the two hashes directly
 * rejects every genuine deployment. This compares byte for byte instead, accepting a difference
 * only where the build has a zeroed 32-byte word and the chain has one of the expected immutable
 * values in that exact word.
 */

const WORD_HEX = 64;
const ZERO_WORD = '0'.repeat(WORD_HEX);

function bareHex(hex: string, what: string): string {
  if (typeof hex !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(hex)) throw new Error(`${what} is not 0x-prefixed hex bytes.`);
  return hex.slice(2).toLowerCase();
}

/** An address or bytes32 as the 32-byte word the EVM stores for an immutable. */
export function immutableWord(value: string): string {
  const h = bareHex(value, 'An immutable value');
  if (h.length === 0 || h.length > WORD_HEX) throw new Error('An immutable value must be 1 to 32 bytes.');
  return h.padStart(WORD_HEX, '0');
}

/**
 * True when `onchain` is `buildRuntime` with every immutable slot holding one of `immutables`.
 * With no immutables listed it is an exact comparison. When immutables are listed, at least one
 * slot must have been filled, so a build whose placeholders went missing cannot pass.
 */
export function runtimeMatchesBuild(onchain: string, buildRuntime: string, immutables: string[] = []): boolean {
  const chain = bareHex(onchain, 'The on-chain code');
  const build = bareHex(buildRuntime, 'The build runtime');
  if (chain.length === 0 || chain.length !== build.length) return false;
  if (immutables.length === 0) return chain === build;

  const words = new Set(immutables.map(immutableWord));
  let filled = 0;
  let i = 0;
  while (i < chain.length) {
    if (chain[i] === build[i]) {
      i++;
      continue;
    }
    // A difference must sit inside a zeroed word of the build that the chain fills with an
    // expected value. Find the word: it starts at the last byte boundary from which a whole
    // zero word in the build covers position i.
    let matched = false;
    const earliest = Math.max(0, i - (WORD_HEX - 1));
    for (let start = i - (i % 2); start >= earliest; start -= 2) {
      if (start + WORD_HEX > build.length) continue;
      if (build.slice(start, start + WORD_HEX) !== ZERO_WORD) continue;
      if (!words.has(chain.slice(start, start + WORD_HEX))) continue;
      // The bytes of this word before position i must already have matched (they are zeros in
      // both, because the padded value starts with zeros); continue after the word.
      matched = true;
      filled++;
      i = start + WORD_HEX;
      break;
    }
    if (!matched) return false;
  }
  return filled > 0;
}
