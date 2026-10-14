/**
 * DarkOrder voice agent: spoken numbers.
 * Ported from DarkCircle's agent (src/agent/numbers.ts): same suite, same rules.
 *
 * Speech-to-text writes amounts either as digits ("5", "2.5") or as words ("five", "two point five", "two and a
 * half", "one hundred and twenty"). This turns each spoken number into an exact decimal STRING, never a float,
 * because the result becomes a token amount. Words that do not form one well-shaped number ("four one seven")
 * are not added up: the run stops, so the grammar then fails to parse instead of acting on a different amount.
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const BIG: Record<string, bigint> = { thousand: 1_000n, million: 1_000_000n };
/** Words that name one digit, after "point" or in a code ("point oh five", "confirm four one seven"). */
const DIGIT_WORDS: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
const FRACTIONS: Record<string, string> = { half: "5", quarter: "25" };

const isUnit = (w: string | undefined) => w !== undefined && w in UNITS;
const isTens = (w: string | undefined) => w !== undefined && w in TENS;
const isWordStart = (w: string | undefined) => isUnit(w) || isTens(w);
const isInt = (w: string | undefined) => w !== undefined && /^\d+$/.test(w);
const isDecimal = (w: string | undefined) => w !== undefined && /^\d+\.\d+$/.test(w);
const isOneDigit = (w: string | undefined): w is string => w !== undefined && (w in DIGIT_WORDS || /^\d$/.test(w));

type Last = "none" | "unit" | "tens" | "hundred" | "big";

/** Reads an integer starting at `i`. Returns the value and the index after it, or null. */
function readInteger(tokens: string[], i: number): { value: bigint; next: number } | null {
  let total = 0n;
  let current = 0n;
  let last: Last = "none";
  let j = i;
  let read = false;
  while (j < tokens.length) {
    const w = tokens[j];
    if (w === undefined) break;
    if (isInt(w) && last === "none") {
      current = BigInt(w); // "5 hundred", "2 thousand"
      last = "unit";
    } else if (isUnit(w)) {
      const unit = UNITS[w];
      if (unit === undefined) break;
      const v = BigInt(unit);
      const ok = last === "none" || last === "hundred" || last === "big" || (last === "tens" && v >= 1n && v <= 9n);
      if (!ok) break;
      current += v;
      last = "unit";
    } else if (isTens(w)) {
      const tens = TENS[w];
      if (tens === undefined) break;
      if (!(last === "none" || last === "hundred" || last === "big")) break;
      current += BigInt(tens);
      last = "tens";
    } else if (w === "hundred") {
      if (last === "hundred" || last === "big" || current >= 100n) break;
      current = (current === 0n ? 1n : current) * 100n;
      last = "hundred";
    } else if (w in BIG) {
      const mult = BIG[w];
      if (mult === undefined || last === "big") break;
      total += (current === 0n ? 1n : current) * mult;
      current = 0n;
      last = "big";
    } else if (w === "and" && (last === "hundred" || last === "big") && isWordStart(tokens[j + 1])) {
      j++; // "one hundred and five": the "and" belongs to the number
      continue;
    } else break;
    read = true;
    j++;
  }
  return read ? { value: total + current, next: j } : null;
}

/** Reads one number at `i`: digits, words, a decimal part or a half. */
function readNumber(tokens: string[], i: number): { text: string; next: number } | null {
  const t = tokens[i];
  if (t === undefined) return null;
  if (isDecimal(t)) return { text: t, next: i + 1 };
  // "half", "a half" (as in "half a QUAI")
  if (t === "half" || (t === "a" && tokens[i + 1] === "half")) {
    let next = i + (t === "half" ? 1 : 2);
    if (tokens[next] === "a" || tokens[next] === "an") next++;
    return { text: "0.5", next };
  }
  // "point five" with no integer part
  if (t === "point" && isOneDigit(tokens[i + 1])) return readFraction(tokens, i + 1, 0n);
  if (!(isInt(t) || isWordStart(t))) return null;
  const int = readInteger(tokens, i);
  if (!int) return null;
  if (tokens[int.next] === "point" && isOneDigit(tokens[int.next + 1])) return readFraction(tokens, int.next + 1, int.value);
  const fracWord = tokens[int.next + 2];
  if (tokens[int.next] === "and" && tokens[int.next + 1] === "a" && fracWord !== undefined && fracWord in FRACTIONS) {
    return { text: `${int.value}.${FRACTIONS[fracWord] ?? ""}`, next: int.next + 3 };
  }
  return { text: int.value.toString(), next: int.next };
}

function readFraction(tokens: string[], i: number, integer: bigint): { text: string; next: number } {
  let digits = "";
  let j = i;
  for (;;) {
    const w = tokens[j];
    if (!isOneDigit(w)) break;
    digits += (w in DIGIT_WORDS ? DIGIT_WORDS[w] : w) ?? "";
    j++;
  }
  return { text: `${integer}.${digits}`, next: j };
}

/**
 * Replaces every spoken number in `tokens` with its decimal string: "two and a half" -> "2.5", "point five"
 * -> "0.5", "1 thousand" -> "1000", "five" -> "5". Anything else is passed through unchanged.
 */
export function normalizeNumbers(input: string[]): string[] {
  // "a hundred", "a thousand": the article is the number one
  const tokens = input.map((w, i) => (w === "a" && (input[i + 1] === "hundred" || (input[i + 1] ?? "") in BIG) ? "one" : w));
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const n = readNumber(tokens, i);
    if (n) {
      out.push(n.text);
      i = n.next;
    } else {
      const t = tokens[i];
      if (t === undefined) break;
      out.push(t);
      i++;
    }
  }
  return out;
}

/** Collects a spoken digit code ("4 1 7", "four one seven", "417") into "417"; null if anything else is in it. */
export function readDigitCode(tokens: string[]): string | null {
  let code = "";
  for (const t of tokens) {
    if (/^\d+$/.test(t)) code += t;
    else if (t in DIGIT_WORDS) code += DIGIT_WORDS[t] ?? "";
    else if (t === "code" || t === "number") continue;
    else return null;
  }
  return code || null;
}
