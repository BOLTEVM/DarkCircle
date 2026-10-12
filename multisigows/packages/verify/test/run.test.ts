import { describe, it, expect } from 'vitest';
import { runVerify, EXIT } from '../src/run.js';

function capture() {
  const lines: string[] = [];
  return { lines, deps: { makeRpc: () => ({ rawRequest: async () => '0x3a98' }) as any, write: (l: string) => lines.push(l) } };
}

describe('darksafe-verify argument handling', () => {
  it('prints usage for --help and exits 0', async () => {
    const c = capture();
    expect(await runVerify(['--help'], c.deps)).toBe(EXIT.OK);
    expect(c.lines.join('\n')).toMatch(/Usage:/);
  });

  it('rejects unknown commands, wrong arity and bad options with exit 64', async () => {
    for (const argv of [[], ['nope'], ['tx', '0x00'], ['vault'], ['vault', '0x00', '--rpc'], ['vault', '0x00', '--network', 'devnet'], ['vault', '0x00', '--chain-id', '5']]) {
      const c = capture();
      expect(await runVerify(argv, c.deps)).toBe(EXIT.USAGE);
    }
  });

  it('refuses a node on a different chain before reading anything else', async () => {
    const lines: string[] = [];
    const code = await runVerify(['vault', '0x0033333333333333333333333333333333333333'], {
      makeRpc: () => ({ rawRequest: async (m: string) => (m === 'quai_chainId' ? '0x9' : '0x') }) as any,
      write: (l) => lines.push(l),
    });
    expect(code).toBe(EXIT.FAILED);
    expect(lines.join('\n')).toMatch(/is on chain 9, not 15000/);
  });
});
