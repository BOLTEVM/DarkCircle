import { describe, expect, it } from 'vitest';
import {
  buildTributeChallenge,
  ChallengeError,
  ChallengeParser,
  NATIVE_QUAI,
  parseAmountToBaseUnits,
  registryTokenLookup,
  validateChallenge,
} from '../src/x402/challenge.js';
import { encodeTribute, newInvoiceId } from '../src/guilds.js';
import { MAINNET, ORCHARD } from '../src/config.js';
import { WQUAI } from '../src/tokens.js';

const TREASURY = '0x00112233445566778899aabbccddeeff00112233';

function sampleChallenge() {
  return buildTributeChallenge({
    network: MAINNET,
    guildName: 'emberhold',
    treasury: TREASURY,
    amount: 5_000_000_000_000_000_000n,
    invoiceId: newInvoiceId(),
    resourceUri: 'https://gate.example.com/emberhold/chronicle',
    createdAt: 1_800_000_000,
    expiresAt: 1_800_000_600,
    memo: 'Chronicle access, one epoch',
  });
}

describe('x402 challenges', () => {
  it('round-trips a tribute challenge through the RFC 7807 body (tier 1)', () => {
    const { headers, body } = sampleChallenge();
    const parsed = ChallengeParser.parse(headers, body, { tokenLookup: registryTokenLookup('mainnet') });
    expect(parsed.scheme).toBe('quai_native_tribute');
    expect(parsed.chainId).toBe(9);
    expect(parsed.network).toBe('quai-cyprus1');
    expect(parsed.tokenAddress).toBe(NATIVE_QUAI);
    expect(parsed.tokenSymbol).toBe('QUAI');
    expect(parsed.tokenDecimals).toBe(18);
    expect(parsed.amount).toBe(5_000_000_000_000_000_000n);
    expect(parsed.recipientAddress).toBe(TREASURY);
    expect(parsed.expiresAt).toBe(1_800_000_600);
    expect(parsed.targetResource).toBe('https://gate.example.com/emberhold/chronicle');
    expect(parsed.callData).toBe(body.payment.callData);
    expect(parsed.callData).toBe(encodeTribute(body.payment.invoiceId));
  });

  it('parses the WWW-Authenticate header alone (tier 2)', () => {
    const { headers, body } = sampleChallenge();
    const parsed = ChallengeParser.parse(
      { 'WWW-Authenticate': headers['WWW-Authenticate'] },
      undefined,
      { tokenLookup: registryTokenLookup('mainnet') }
    );
    expect(parsed.scheme).toBe('quai_native_tribute');
    expect(parsed.invoiceId).toBe(body.payment.invoiceId);
    expect(parsed.amount).toBe(5_000_000_000_000_000_000n);
    expect(parsed.recipientAddress).toBe(TREASURY);
    expect(parsed.callData).toBe(body.payment.callData);
  });

  it('parses X-Payment-* headers alone (tier 3)', () => {
    const { headers, body } = sampleChallenge();
    const xOnly: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase().startsWith('x-payment')) xOnly[k] = v;
    const parsed = ChallengeParser.parse(xOnly, undefined, { tokenLookup: registryTokenLookup('mainnet') });
    expect(parsed.invoiceId).toBe(body.payment.invoiceId);
    expect(parsed.chainId).toBe(9);
    expect(parsed.amount).toBe(5_000_000_000_000_000_000n);
  });

  it('rejects a challenge that misstates a registered token’s decimals', () => {
    const body = {
      payment: {
        recipient: TREASURY,
        invoiceId: 'inv-1',
        amount: '1000000',
        token: { address: WQUAI.address, symbol: 'WQUAI', decimals: 6 },
        network: 'quai-cyprus1',
        expiresAt: 0,
      },
    };
    expect(() => ChallengeParser.parse({}, body, { tokenLookup: registryTokenLookup('mainnet') })).toThrow(ChallengeError);
  });

  it('rejects challenges with no recognizable payment fields', () => {
    expect(() => ChallengeParser.parse({}, { hello: 'world' })).toThrow(ChallengeError);
    expect(() => ChallengeParser.parse(undefined, undefined)).toThrow(ChallengeError);
  });

  it('parses decimal amount strings without floats', () => {
    // Integer strings are already base units; decimal strings are token amounts.
    expect(parseAmountToBaseUnits('5', 18)).toBe(5n);
    expect(parseAmountToBaseUnits('5.0', 18)).toBe(5_000_000_000_000_000_000n);
    expect(parseAmountToBaseUnits('0.5', 18)).toBe(500_000_000_000_000_000n);
    expect(parseAmountToBaseUnits('2.5', 18)).toBe(2_500_000_000_000_000_000n);
    expect(parseAmountToBaseUnits(5_000_000_000_000_000_000n, 18)).toBe(5_000_000_000_000_000_000n);
    expect(() => parseAmountToBaseUnits('0', 18)).toThrow(ChallengeError);
    expect(() => parseAmountToBaseUnits('abc', 18)).toThrow(ChallengeError);
    expect(() => parseAmountToBaseUnits(-1, 18)).toThrow(ChallengeError);
  });

  it('validates a challenge against the wallet’s network', () => {
    const { headers, body } = sampleChallenge();
    const parsed = ChallengeParser.parse(headers, body, { tokenLookup: registryTokenLookup('mainnet') });
    expect(validateChallenge(parsed, MAINNET, 1_800_000_100)).toEqual([]);
    expect(validateChallenge(parsed, ORCHARD, 1_800_000_100).join(' ')).toMatch(/chain 9/);
    expect(validateChallenge(parsed, MAINNET, 1_800_000_601).join(' ')).toMatch(/expired/);
  });

  it('formats proof headers and detects 402 responses', () => {
    const proof = ChallengeParser.formatPaymentProofHeaders('inv-9', '0xabc123');
    expect(proof['Authorization']).toBe('x402 invoice="inv-9", proof="0xabc123"');
    expect(proof['X-Payment-Proof']).toBe('0xabc123');
    expect(ChallengeParser.formatAuthorizationHeader('inv-9', '0xabc123', '0x00ff')).toContain('relayer="0x00ff"');
    expect(ChallengeParser.isPaymentRequired(402)).toBe(true);
    expect(ChallengeParser.isPaymentRequired(200, { 'X-Payment-Required': 'true' })).toBe(true);
    expect(ChallengeParser.isPaymentRequired(200, { 'WWW-Authenticate': 'x402 scheme="erc20_transfer"' })).toBe(true);
    expect(ChallengeParser.isPaymentRequired(200, {})).toBe(false);
  });

  it('normalizeHeaders accepts fetch Headers, arrays and plain objects', () => {
    const h = new Headers({ 'X-Payment-Required': 'true' });
    expect(ChallengeParser.normalizeHeaders(h)['x-payment-required']).toBe('true');
    expect(ChallengeParser.normalizeHeaders([['X-Payment-Required', 'true']])['x-payment-required']).toBe('true');
    expect(ChallengeParser.normalizeHeaders({ 'X-Payment-Required': ['true'] })['x-payment-required']).toBe('true');
  });
});
