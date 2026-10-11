/**
 * Makes text read from chain (token names and symbols) safe to show next to amounts:
 * strips control characters, bidirectional overrides and zero-width characters, which can
 * make one string render as another, and bounds the length.
 */
// C0/C1 controls, bidi embeddings/overrides/isolates, marks, zero-width, word joiner, BOM.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

export function sanitizeText(input: unknown, maxLength = 32): string {
  if (typeof input !== 'string') return '';
  const cleaned = input.normalize('NFKC').replace(UNSAFE, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(cleaned);
  return chars.length > maxLength ? chars.slice(0, maxLength - 1).join('') + '…' : cleaned;
}
