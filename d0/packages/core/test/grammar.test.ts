import { describe, expect, it } from 'vitest';
import { canonicalize, EXAMPLES, parseCommand, type Intent } from '../src/voice/grammar.js';

function intentOf(text: string): Intent {
  const r = parseCommand(text);
  if (!r.ok) throw new Error(`expected intent for "${text}", got refusal ${r.code}: ${r.message}`);
  return r.intent;
}

describe('voice grammar', () => {
  it('parses every published example', () => {
    for (const example of EXAMPLES) {
      const r = parseCommand(example);
      expect(r.ok, `"${example}" -> ${r.ok ? r.intent.kind : r.code}`).toBe(true);
    }
  });

  it('parses the examples to the expected intents', () => {
    expect(intentOf('show the halls')).toEqual({ kind: 'halls' });
    expect(intentOf('open emberhold')).toEqual({ kind: 'open-guild', guild: 'emberhold' });
    expect(intentOf('what proposals are open')).toEqual({ kind: 'proposals' });
    expect(intentOf('what is my voting power')).toEqual({ kind: 'voting-power' });
    expect(intentOf('vote yes on proposal 3')).toEqual({ kind: 'vote', choice: 'yes', proposal: '3' });
    expect(intentOf('execute proposal 2')).toEqual({ kind: 'execute', proposal: '2' });
    expect(intentOf('approve proposal 1')).toEqual({ kind: 'approve', proposal: '1' });
    expect(intentOf('pay 5 QUAI tribute to emberhold')).toEqual({
      kind: 'tribute',
      amount: '5',
      asset: 'QUAI',
      guild: 'emberhold',
    });
    expect(intentOf('found a new guild')).toEqual({ kind: 'found' });
    expect(intentOf('confirm 4 1 7')).toEqual({ kind: 'confirm', code: '417' });
    expect(intentOf('cancel')).toEqual({ kind: 'cancel' });
  });

  it('understands spoken numbers', () => {
    expect(intentOf('vote yes on proposal three')).toEqual({ kind: 'vote', choice: 'yes', proposal: '3' });
    expect(intentOf('execute proposal twenty one')).toEqual({ kind: 'execute', proposal: '21' });
    expect(intentOf('pay two and a half QUAI tribute to iron council')).toEqual({
      kind: 'tribute',
      amount: '2.5',
      asset: 'QUAI',
      guild: 'iron council',
    });
  });

  it('strips filler without changing the intent', () => {
    expect(intentOf('hey darkorder please could you open the iron council hall')).toEqual({
      kind: 'open-guild',
      guild: 'iron council',
    });
    expect(intentOf('okay, vote no on proposal 7, thanks')).toEqual({ kind: 'vote', choice: 'no', proposal: '7' });
  });

  it('treats "approve proposal N" as an approval, never as a confirmation', () => {
    const r = parseCommand('approve proposal 12');
    expect(r.ok && r.intent.kind).toBe('approve');
  });

  it('treats "yes" followed by digits as a confirmation code', () => {
    expect(intentOf('yes 4 1 7')).toEqual({ kind: 'confirm', code: '417' });
  });

  it('refuses payments to spoken names', () => {
    const r = parseCommand('send 5 quai to alice');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_A_PAYMENT_APP');
  });

  it('refuses operations that belong to other suite apps', () => {
    const r = parseCommand('wrap 10 quai into wquai');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('WRONG_HALL');
  });

  it('refuses addresses by voice', () => {
    const r = parseCommand('pay 5 quai tribute to 0x00112233445566778899aabbccddeeff00112233');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NO_ADDRESSES_BY_VOICE');
  });

  it('refuses zero tribute', () => {
    const r = parseCommand('pay 0 QUAI tribute to emberhold');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('AMOUNT_ZERO');
  });

  it('canonicalizes punctuation and thousands separators', () => {
    expect(canonicalize('Vote YES on Proposal #3!')).toBe('vote yes on proposal 3');
    expect(canonicalize('pay 1,250 quai tribute to emberhold')).toBe('pay 1250 quai tribute to emberhold');
  });
});
