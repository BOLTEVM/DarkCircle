/**
 * Minimal QR Code encoder (ISO/IEC 18004): byte mode, error-correction level M,
 * versions 1-6 (up to 106 bytes). Kept in-app so the receive address is never sent
 * to a third party, and so no dependency sits between the vault address and the
 * pixels a payer scans. Correctness is proven by a round-trip decode test.
 */

// [ecCodewordsPerBlock, numBlocks, dataCodewordsPerBlock] for level M, versions 1-6.
const EC_M: ReadonlyArray<readonly [number, number, number]> = [
  [10, 1, 16],
  [16, 1, 28],
  [26, 1, 44],
  [18, 2, 32],
  [24, 2, 43],
  [16, 4, 27],
];
const ALIGNMENT_CENTERS: ReadonlyArray<readonly number[]> = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];
const REMAINDER_BITS = [0, 7, 7, 7, 7, 7];
const EC_LEVEL_M_BITS = 0b00;

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j]! ^= poly[j]!;
      next[j + 1]! ^= gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i]! ^= gfMul(gen[i + 1]!, factor);
  }
  return rem;
}

function buildCodewords(bytes: Uint8Array, version: number): number[] {
  const [ecLen, numBlocks, dataPerBlock] = EC_M[version - 1]!;
  const dataCapacity = numBlocks * dataPerBlock;

  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCapacity * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    data.push(byte);
  }
  for (let pad = 0xec; data.length < dataCapacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let b = 0; b < numBlocks; b++) {
    const block = data.slice(b * dataPerBlock, (b + 1) * dataPerBlock);
    blocks.push(block);
    ecBlocks.push(rsRemainder(block, ecLen));
  }

  const out: number[] = [];
  for (let i = 0; i < dataPerBlock; i++) for (const block of blocks) out.push(block[i]!);
  for (let i = 0; i < ecLen; i++) for (const block of ecBlocks) out.push(block[i]!);
  return out;
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function formatBits(mask: number): number {
  const data = (EC_LEVEL_M_BITS << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

class Matrix {
  readonly size: number;
  readonly dark: boolean[][];
  readonly isFunction: boolean[][];

  constructor(version: number) {
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  setFunction(x: number, y: number, isDark: boolean): void {
    this.dark[y]![x] = isDark;
    this.isFunction[y]![x] = true;
  }
}

function drawFunctionPatterns(m: Matrix, version: number): void {
  const { size } = m;
  for (let i = 0; i < size; i++) {
    m.setFunction(6, i, i % 2 === 0);
    m.setFunction(i, 6, i % 2 === 0);
  }

  const drawFinder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        m.setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);

  const centers = ALIGNMENT_CENTERS[version - 1]!;
  const last = centers.length - 1;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          m.setFunction(centers[i]! + dx, centers[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  drawFormat(m, 0);
}

function drawFormat(m: Matrix, mask: number): void {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const { size } = m;

  for (let i = 0; i <= 5; i++) m.setFunction(8, i, bit(i));
  m.setFunction(8, 7, bit(6));
  m.setFunction(8, 8, bit(7));
  m.setFunction(7, 8, bit(8));
  for (let i = 9; i < 15; i++) m.setFunction(14 - i, 8, bit(i));

  for (let i = 0; i < 8; i++) m.setFunction(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) m.setFunction(8, size - 15 + i, bit(i));
  m.setFunction(8, size - 8, true);
}

function drawCodewords(m: Matrix, codewords: number[], remainderBits: number): void {
  const bits: number[] = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  for (let i = 0; i < remainderBits; i++) bits.push(0);

  const { size } = m;
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!m.isFunction[y]![x] && index < bits.length) {
          m.dark[y]![x] = bits[index] === 1;
          index++;
        }
      }
    }
  }
}

function applyMask(m: Matrix, mask: number): void {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (!m.isFunction[y]![x] && maskBit(mask, x, y)) m.dark[y]![x] = !m.dark[y]![x];
    }
  }
}

/** Penalty rules 1, 2 and 4 of the spec (rule 3 omitted; any mask still decodes). */
function penalty(m: Matrix): number {
  const { size, dark } = m;
  let score = 0;
  for (let y = 0; y < size; y++) {
    for (const horizontal of [true, false]) {
      let runColor = false;
      let runLength = 0;
      for (let i = 0; i < size; i++) {
        const cell = horizontal ? dark[y]![i]! : dark[i]![y]!;
        if (i > 0 && cell === runColor) {
          runLength++;
        } else {
          if (runLength >= 5) score += 3 + (runLength - 5);
          runColor = cell;
          runLength = 1;
        }
      }
      if (runLength >= 5) score += 3 + (runLength - 5);
    }
  }
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = dark[y]![x];
      if (c === dark[y]![x + 1] && c === dark[y + 1]![x] && c === dark[y + 1]![x + 1]) score += 3;
    }
  }
  let darkCount = 0;
  for (const row of dark) for (const cell of row) if (cell) darkCount++;
  const total = size * size;
  score += Math.floor(Math.abs(darkCount * 20 - total * 10) / total) * 10;
  return score;
}

export interface QrMatrix {
  size: number;
  version: number;
  /** dark[y][x] */
  dark: boolean[][];
}

export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = EC_M.findIndex(([, blocks, perBlock]) => {
    const capacityBits = blocks * perBlock * 8;
    return 4 + 8 + bytes.length * 8 <= capacityBits;
  }) + 1;
  if (version === 0) {
    throw new Error(`QR payload too long: ${bytes.length} bytes (max 106).`);
  }

  const codewords = buildCodewords(bytes, version);
  let best: Matrix | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = new Matrix(version);
    drawFunctionPatterns(m, version);
    drawCodewords(m, codewords, REMAINDER_BITS[version - 1]!);
    applyMask(m, mask);
    drawFormat(m, mask);
    const score = penalty(m);
    if (score < bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return { size: best!.size, version, dark: best!.dark };
}
