/**
 * DarkOrder voice agent: the command grammar.
 * Modeled on DarkCircle's agent grammar (src/agent/grammar.ts), retuned for governance.
 *
 * Turns what the user said (a speech transcript, or typed text) into ONE typed intent from a closed list, or a
 * refusal that says what was not understood. It is deliberately a grammar, not a language model: it runs
 * offline, needs no key, gives the same answer every time, and cannot be talked into an operation that is not
 * on the list. It never resolves which guild "emberhold" is; the planner does that against the on-chain
 * registry, and nothing here moves funds.
 *
 * Two hard rules, inherited from DarkCircle:
 *  - Voice never carries an address. Guilds are named by their hall handle; recipients and
 *    contracts are resolved from the on-chain registry, never from speech.
 *  - Tribute always names its asset ("pay 5 QUAI tribute to emberhold"): an amount is never
 *    assumed to be in some default token.
 */

import { normalizeNumbers, readDigitCode } from './numbers.js';

export type Intent =
  | { kind: 'halls' }
  | { kind: 'open-guild'; guild: string }
  | { kind: 'proposals'; guild?: string }
  | { kind: 'voting-power'; guild?: string }
  | { kind: 'steward' }
  | { kind: 'my-roles'; guild?: string }
  | { kind: 'vote'; choice: 'yes' | 'no' | 'abstain'; proposal: string }
  | { kind: 'approve'; proposal: string }
  | { kind: 'execute'; proposal: string }
  | { kind: 'tribute'; amount: string; asset: 'QUAI'; guild: string }
  | { kind: 'new-proposal' }
  | { kind: 'found' }
  | { kind: 'confirm'; code: string }
  | { kind: 'cancel' }
  | { kind: 'help' };

export type ParseResult =
  | { ok: true; intent: Intent; heard: string }
  | { ok: false; code: string; message: string; heard: string };

/** What the agent understands, phrased the way it is best said. Shown on "help" and after a failed parse. */
export const EXAMPLES = [
  'show the halls',
  'open emberhold',
  'what proposals are open',
  'what is my voting power',
  'vote yes on proposal 3',
  'execute proposal 2',
  'approve proposal 1',
  'pay 5 QUAI tribute to emberhold',
  'found a new guild',
  'open the steward’s desk',
  'what roles does my key hold',
  'confirm 4 1 7',
  'cancel',
];

const LEADING_FILLER = [
  ['hey'], ['hi'], ['ok'], ['okay'], ['agent'], ['dark', 'order'], ['darkorder'], ['please'], ['kindly'], ['just'],
  ['can', 'you'], ['could', 'you'], ['would', 'you'], ['will', 'you'], ['i', 'want', 'to'], ['i', 'would', 'like', 'to'],
  ['i', 'wanna'], ['go', 'ahead', 'and'], ['lets'], ['let', 'us'],
];
const TRAILING_FILLER = [['please'], ['thanks'], ['thank', 'you'], ['now'], ['for', 'me']];

function startsWithTokens(tokens: string[], phrase: string[], at = 0): boolean {
  return phrase.every((w, k) => tokens[at + k] === w);
}

function stripFiller(tokens: string[]): string[] {
  let t = [...tokens];
  for (let changed = true; changed && t.length; ) {
    changed = false;
    for (const f of LEADING_FILLER) {
      if (startsWithTokens(t, f) && t.length > f.length) {
        t = t.slice(f.length);
        changed = true;
      }
    }
  }
  for (let changed = true; changed && t.length; ) {
    changed = false;
    for (const f of TRAILING_FILLER) {
      if (t.length > f.length && startsWithTokens(t, f, t.length - f.length)) {
        t = t.slice(0, t.length - f.length);
        changed = true;
      }
    }
  }
  return t;
}

/** Lowercase words, punctuation removed (decimal points kept), digit/letter runs split ("proposal3" -> "proposal 3"). */
export function tokenize(text: string): string[] {
  const s = String(text)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\bwhat's\b/g, 'what is')
    .replace(/\bi'd\b/g, 'i would')
    .replace(/'/g, '')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/(\d)\.(?=\d)/g, '$1\u0000')
    .replace(/[$€£]/g, ' ')
    .replace(/[.!?,;:"()[\]{}<>@#*]/g, ' ')
    .replace(/\u0000/g, '.')
    .replace(/[-/]/g, ' ')
    .replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/([a-z])(\d)/g, '$1 $2');
  return s.split(/\s+/).filter(Boolean);
}

/** What the grammar matches against: filler removed, numbers as decimals. */
export function canonicalize(text: string): string {
  return normalizeNumbers(stripFiller(tokenize(text))).join(' ');
}

const NUM = '(\\d+(?:\\.\\d+)?)';
const fail = (code: string, message: string, heard: string): ParseResult => ({ ok: false, code, message, heard });

export function parseCommand(text: string): ParseResult {
  if (typeof text !== 'string' || text.trim() === '') return fail('EMPTY', 'Nothing was heard.', '');
  if (text.length > 300) return fail('TOO_LONG', 'That is too long for one command; say one thing at a time.', text.slice(0, 80));
  // Check the RAW text for an address: tokenize() splits digit/letter runs, which would shred
  // a hex address into unrecognizable pieces before any pattern could see it.
  if (/0x[0-9a-fA-F]{6,}/.test(text)) {
    return fail('NO_ADDRESSES_BY_VOICE', 'Voice never carries an address. Name a guild by its hall handle, for example "open emberhold".', text.slice(0, 80));
  }
  const heard = canonicalize(text);
  const ok = (intent: Intent): ParseResult => ({ ok: true, intent, heard });
  const m = (re: string) => new RegExp(`^${re}$`).exec(heard);
  let r: RegExpExecArray | null;

  // ---- conversation control
  const words = heard.split(' ');
  if (['confirm', 'approve', 'yes'].includes(words[0] ?? '')) {
    // "approve proposal 2" is an intent, not a confirmation code.
    if (words[0] === 'approve' && words[1] === 'proposal') {
      return ok({ kind: 'approve', proposal: words.slice(2).join(' ') });
    }
    const rest = words.slice(words[1] === 'confirm' ? 2 : 1);
    const code = readDigitCode(rest);
    if (code) return ok({ kind: 'confirm', code });
    return fail('CONFIRM_NEEDS_CODE', "Say the confirmation code shown with the plan, for example 'confirm 4 1 7'.", heard);
  }
  if (m('(cancel|stop|abort|never ?mind|no|forget (it|that|this))( (it|that|this))?')) return ok({ kind: 'cancel' });
  if (m('(help|commands|what can (you|i) (do|say)|what (are|is) (the|your) commands)')) return ok({ kind: 'help' });

  // ---- steward actions: the desk types what voice must not carry (an address, a charter).
  // Matched before the payment guard so "give root power to …" is not misread as a payment.
  if (m('(grant|revoke|give|take|hand)( the)?( a)?( new)? ?(root|execute|metadata|steward)? ?(power|role)s?( (to|from) .+)?')) {
    return ok({ kind: 'steward' });
  }

  // ---- things that belong to other suite apps: redirect, never act
  if (m('(send|pay|transfer|give) .* to .+') && !m('.*tribute.*')) {
    return fail(
      'NOT_A_PAYMENT_APP',
      'DarkOrder governs guilds; it never sends payments to spoken names. For x402 payments use the DarkCircle console. The only spend here is tribute to a guild treasury: "pay 5 QUAI tribute to emberhold".',
      heard
    );
  }
  if (m('(wrap|unwrap|swap|bridge|shield|deposit) .*')) {
    return fail('WRONG_HALL', 'That operation lives in another hall of the suite (Circleswap or DarkCircle). Here you govern guilds.', heard);
  }
  if (/0x[0-9a-f]{6,}/.test(heard)) {
    return fail('NO_ADDRESSES_BY_VOICE', 'Voice never carries an address. Name a guild by its hall handle, for example "open emberhold".', heard);
  }

  // ---- navigation and reading
  // The steward's desk and the roles query come first: "open the steward's desk" would
  // otherwise be read as "open the hall called stewards desk".
  if (m('(open|show|go to|take me to)( the)?( my| our| this)? stewards? desk')) return ok({ kind: 'steward' });
  if (m('(edit|rewrite|change|update|write)( the)?( my| our| this)?( guild| hall| guilds| halls)? ?(charter|metadata|profile|description)')) {
    return ok({ kind: 'steward' });
  }
  if (m('(change|upload|set|update)( the| a| an)?( new)?( my| our| this)?( guild| hall| guilds| halls)? ?(crest|avatar|icon|logo)')) return ok({ kind: 'steward' });
  if (m('(manage|assign|edit|change|update)( the)?( my| our| this)?( guild| hall| guilds| halls)? ?roles?')) return ok({ kind: 'steward' });
  if ((r = m('(what|which) roles? (do i|does my (key|wallet|address)) (hold|have)( (in|for|of) (.+))?'))) {
    const guild = cleanGuildName(r[7] ?? '');
    return ok(guild ? { kind: 'my-roles', guild } : { kind: 'my-roles' });
  }
  if ((r = m('do i (hold|have)( any)?( the)? (power|powers|a role|roles)( here| there)?( (in|for|of) (.+))?'))) {
    const guild = cleanGuildName(r[8] ?? '');
    return ok(guild ? { kind: 'my-roles', guild } : { kind: 'my-roles' });
  }
  if ((r = m('my roles?( (in|for|of) (.+))?'))) {
    const guild = cleanGuildName(r[3] ?? '');
    return ok(guild ? { kind: 'my-roles', guild } : { kind: 'my-roles' });
  }
  if (m('((show|list|open|go to)( me)?( the)? )?(halls|guilds|grand guild halls|directory)')) return ok({ kind: 'halls' });
  if ((r = m('(open|go to|enter|show|visit)( the)? (.+?)( hall| guild)?$'))) {
    return ok({ kind: 'open-guild', guild: cleanGuildName(r[3] ?? '') });
  }
  if ((r = m('(what |which )?(proposals?|motions?)( are| is)? (open|active|live|pending|up)( in| for| at)? ?(.*)'))) {
    const guild = cleanGuildName(r[6] ?? '');
    return ok(guild ? { kind: 'proposals', guild } : { kind: 'proposals' });
  }
  if ((r = m('((show|list)( me)?( the)? )?proposals?( (in|for|of) (.+))?'))) {
    const guild = cleanGuildName(r[6] ?? '');
    return ok(guild ? { kind: 'proposals', guild } : { kind: 'proposals' });
  }
  if ((r = m('(what is |show |check |tell me |get )?my (voting power|power|voice|stake)( (in|for|of) (.+))?'))) {
    const guild = cleanGuildName(r[5] ?? '');
    return ok(guild ? { kind: 'voting-power', guild } : { kind: 'voting-power' });
  }

  // ---- voting
  if ((r = m(`vote (yes|yea|aye|no|nay|abstain)( on)?( proposal| motion)? ${NUM}`))) {
    const word = r[1] ?? '';
    const choice = word === 'yes' || word === 'yea' || word === 'aye' ? 'yes' : word === 'abstain' ? 'abstain' : 'no';
    return ok({ kind: 'vote', choice, proposal: r[4] ?? '' });
  }
  if ((r = m(`(cast|cast my) (a )?(yes|no|abstain)( vote)?( on)?( proposal| motion)? ${NUM}`))) {
    return ok({ kind: 'vote', choice: (r[3] ?? 'yes') as 'yes' | 'no' | 'abstain', proposal: r[7] ?? '' });
  }
  if (m('vote .*')) return fail('VOTE_NOT_UNDERSTOOD', "Say for example 'vote yes on proposal 3'.", heard);

  // ---- council approvals and execution
  if ((r = m(`approve( proposal| motion)? ${NUM}`))) return ok({ kind: 'approve', proposal: r[2] ?? '' });
  if ((r = m(`(execute|enact|carry out|ratify)( proposal| motion)? ${NUM}`))) return ok({ kind: 'execute', proposal: r[3] ?? '' });

  // ---- tribute (the one spend; always native QUAI, always to a named hall)
  if ((r = m(`(pay|give|offer|send)? ?tribute of ${NUM} (quai|kwai) to (.+)`))) {
    return positive(r[2] ?? '', heard) ?? ok({ kind: 'tribute', amount: r[2] ?? '', asset: 'QUAI', guild: cleanGuildName(r[4] ?? '') });
  }
  if ((r = m(`(pay|give|offer) ${NUM} (quai|kwai)( in)? tribute to (.+)`))) {
    return positive(r[2] ?? '', heard) ?? ok({ kind: 'tribute', amount: r[2] ?? '', asset: 'QUAI', guild: cleanGuildName(r[5] ?? '') });
  }
  if (m('.*tribute.*')) return fail('TRIBUTE_NOT_UNDERSTOOD', "Say for example 'pay 5 QUAI tribute to emberhold'. Tribute is always in QUAI.", heard);

  // ---- creating
  if (m('(found|create|start|raise)( a)?( new)? (guild|hall|order)')) return ok({ kind: 'found' });
  if (m('(draft|create|make|start|new|propose)( a)?( new)? (proposal|motion)')) return ok({ kind: 'new-proposal' });

  return fail('NOT_UNDERSTOOD', `Not understood. Try: ${EXAMPLES.slice(0, 5).join('; ')}.`, heard);
}

function cleanGuildName(raw: string): string {
  return raw
    .replace(/^(the|my|of|in|for|at) /, '')
    .replace(/ (hall|guild)$/, '')
    .trim();
}

function positive(amount: string, heard: string): ParseResult | null {
  return /^0+(\.0+)?$/.test(amount) ? fail('AMOUNT_ZERO', 'The amount must be more than zero.', heard) : null;
}
