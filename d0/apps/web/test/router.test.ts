import { describe, expect, it } from 'vitest';
import { href, parseHash, type Route } from '../src/lib/router.js';

describe('router', () => {
  it('parses every route shape', () => {
    expect(parseHash('')).toEqual({ name: 'home' });
    expect(parseHash('#/')).toEqual({ name: 'home' });
    expect(parseHash('#/found')).toEqual({ name: 'found' });
    expect(parseHash('#/voice')).toEqual({ name: 'voice' });
    expect(parseHash('#/tribute')).toEqual({ name: 'tribute' });
    expect(parseHash('#/guild/emberhold')).toEqual({ name: 'guild', guild: 'emberhold' });
    expect(parseHash('#/mint/emberhold')).toEqual({ name: 'mint', guild: 'emberhold' });
    expect(parseHash('#/proposal/emberhold/12')).toEqual({ name: 'proposal', guild: 'emberhold', id: 12 });
  });

  it('rejects malformed handles and ids', () => {
    expect(parseHash('#/guild/Not A Hall').name).toBe('notfound');
    expect(parseHash('#/guild/emberhold/extra').name).toBe('notfound');
    expect(parseHash('#/proposal/emberhold/abc').name).toBe('notfound');
    expect(parseHash('#/proposal/emberhold').name).toBe('notfound');
    expect(parseHash('#/nope').name).toBe('notfound');
  });

  it('round-trips through href', () => {
    const routes: Route[] = [
      { name: 'home' },
      { name: 'found' },
      { name: 'voice' },
      { name: 'tribute' },
      { name: 'guild', guild: 'iron-council_2' },
      { name: 'mint', guild: 'emberhold' },
      { name: 'proposal', guild: 'emberhold', id: 7 },
    ];
    for (const r of routes) expect(parseHash(href(r))).toEqual(r);
  });
});
