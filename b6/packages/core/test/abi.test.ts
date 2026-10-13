import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Interface } from 'ethers';
import { describe, expect, it } from 'vitest';
import { BROKERAGE_ABI, DEED_ABI, brokerageInterface, deedInterface, explainRevert } from '../src/abi.js';

/**
 * The site's hand-written ABI must agree with what the compiler produced, fragment by fragment:
 * same selector, same input and output types, same mutability. Run `pnpm --filter
 * @darkquestate/contracts build` first (turbo does, since core depends on the contracts).
 */
function artifact(name: string): Interface {
  const file = fileURLToPath(new URL(`../../contracts/artifacts/contracts/${name}.sol/${name}.json`, import.meta.url));
  if (!existsSync(file)) throw new Error(`Missing ${file}: compile the contracts first.`);
  return new Interface(JSON.parse(readFileSync(file, 'utf8')).abi);
}

function checkAgainst(site: Interface, compiled: Interface, label: string) {
  site.forEachFunction((f) => {
    const real = compiled.getFunction(f.selector);
    expect(real, `${label}.${f.format()} is not in the compiled contract`).not.toBeNull();
    expect(real!.format('sighash')).toBe(f.format('sighash'));
    expect(real!.outputs.map((o) => o.format('sighash')), `${label}.${f.name} outputs`).toEqual(f.outputs.map((o) => o.format('sighash')));
    expect(real!.stateMutability, `${label}.${f.name} mutability`).toBe(f.stateMutability);
  });
  site.forEachError((e) => {
    expect(compiled.getError(e.selector), `${label} error ${e.format()} is not in the compiled contract`).not.toBeNull();
  });
}

describe('ABI drift', () => {
  it('QuestateDeed fragments match the artifact', () => {
    checkAgainst(deedInterface, artifact('QuestateDeed'), 'QuestateDeed');
    expect(DEED_ABI.length).toBeGreaterThan(20);
  });

  it('QuestateBrokerage fragments match the artifact', () => {
    checkAgainst(brokerageInterface, artifact('QuestateBrokerage'), 'QuestateBrokerage');
    expect(BROKERAGE_ABI.length).toBeGreaterThan(40);
  });

  it('every brokerage custom error has words for people', () => {
    const compiled = artifact('QuestateBrokerage');
    compiled.forEachError((e) => {
      const data = compiled.encodeErrorResult(e, e.inputs.map((i) => (i.baseType === 'address' ? '0x0000000000000000000000000000000000000001' : i.baseType === 'string' ? 'x' : 1)));
      const words = explainRevert('execution reverted', data);
      expect(words, e.name).not.toBe(e.name);
      expect(words, e.name).not.toBe('execution reverted');
    });
  });
});
