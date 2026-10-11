import { describe, it, expect } from 'vitest';
import jsQR from 'jsqr';
import { randomBytes } from 'node:crypto';
import { encodeQr, QrMatrix } from '../src/lib/qrcode.js';

function decode(qr: QrMatrix): string | null {
  const scale = 4;
  const quiet = 4;
  const width = (qr.size + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (!qr.dark[y]![x]) continue;
      for (let py = 0; py < scale; py++) {
        for (let px = 0; px < scale; px++) {
          const offset = (((y + quiet) * scale + py) * width + (x + quiet) * scale + px) * 4;
          pixels[offset] = 0;
          pixels[offset + 1] = 0;
          pixels[offset + 2] = 0;
        }
      }
    }
  }
  return jsQR(pixels, width, width, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

describe('encodeQr', () => {
  it('round-trips a Cyprus-1 vault address through an independent decoder', () => {
    const address = '0x0060938367f4F711A467e2f562ECe51A7a7158f0';
    const qr = encodeQr(address);
    expect(qr.version).toBe(3);
    expect(qr.size).toBe(29);
    expect(decode(qr)).toBe(address);
  });

  it('round-trips 200 random addresses exactly', () => {
    for (let i = 0; i < 200; i++) {
      const address = '0x00' + randomBytes(19).toString('hex');
      expect(decode(encodeQr(address))).toBe(address);
    }
  });

  it('round-trips every supported version (1-6), including multi-block interleaving', () => {
    for (const length of [1, 14, 26, 42, 62, 84, 106]) {
      const text = 'A'.repeat(length);
      const qr = encodeQr(text);
      expect(decode(qr)).toBe(text);
    }
  });

  it('refuses payloads beyond version 6 instead of emitting a broken code', () => {
    expect(() => encodeQr('x'.repeat(107))).toThrow(/too long/);
  });
});
