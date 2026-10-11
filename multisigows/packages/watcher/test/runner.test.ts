import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig, saveState, loadState, webhookSink, emptyState } from '../src/index.js';

const VAULT = '0x0033333333333333333333333333333333333333';

describe('watcher config', () => {
  it('accepts a minimal config and checksums the vaults', () => {
    const c = validateConfig({ network: 'testnet', vaults: [VAULT], stateFile: 's.json' });
    expect(c.vaults[0]).toBe('0x0033333333333333333333333333333333333333');
  });

  it('lists every problem at once', () => {
    expect(() =>
      validateConfig({ network: 'devnet', vaults: ['0x1234'], stateFile: '', webhookUrl: 'http://example.com/hook', confirmations: 0, largeValueQuai: 'lots' })
    ).toThrow(/network[\s\S]*vaults\[0\][\s\S]*confirmations[\s\S]*stateFile[\s\S]*webhookUrl[\s\S]*largeValueQuai/);
  });
});

describe('watcher state file', () => {
  it('round-trips atomically and refuses a file from another chain', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbw-'));
    const file = path.join(dir, 'state.json');
    const state = { ...emptyState(15000), block: '10', blockHash: '0xab' };
    saveState(file, state);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(loadState(file, 15000)).toEqual(state);
    expect(() => loadState(file, 9)).toThrow(/belongs to chain 15000/);
  });
});

describe('webhook sink', () => {
  it('retries until the webhook accepts, and sends nothing for no alerts', async () => {
    const calls: any[] = [];
    let n = 0;
    const fakeFetch = (async (_url: string, init: any) => {
      calls.push(JSON.parse(init.body));
      return new Response('', { status: ++n < 2 ? 500 : 200 });
    }) as any;
    const sink = webhookSink('https://hooks.test/x', fakeFetch);
    await sink([]);
    expect(calls).toHaveLength(0);
    await sink([{ level: 'critical', kind: 'owner-added', vault: VAULT, block: '1', message: 'x'.repeat(900) }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].alerts[0].message).toHaveLength(500);
  }, 10_000);
});
