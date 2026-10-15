import { describe, expect, it } from 'vitest';
import { immutableWord, runtimeMatchesBuild } from '../src/codecheck.js';

// A runtime that reads one immutable: PUSH32 <word> at byte 3, then STOP-ish filler.
const ZERO = '00'.repeat(32);
const DEPLOYER = '0x0012ab34cd56ef7890ab12cd34ef567890ab12cd';
const OTHER = '0x0034000000000000000000000000000000000001';
const build = `0x6080${'7f'}${ZERO}5060${'7f'}${ZERO}00`;
const withWord = (w: string) => `0x6080${'7f'}${w}5060${'7f'}${w}00`;

describe('runtimeMatchesBuild', () => {
  it('compares exactly when the contract has no immutables', () => {
    expect(runtimeMatchesBuild('0x6080604052', '0x6080604052')).toBe(true);
    expect(runtimeMatchesBuild('0x6080604052', '0x6080604053')).toBe(false);
    expect(runtimeMatchesBuild('0x', '0x')).toBe(false);
  });

  it('accepts the build with its immutable filled in, which a plain hash comparison rejects', () => {
    const onchain = withWord(immutableWord(DEPLOYER));
    expect(onchain).not.toBe(build);
    expect(runtimeMatchesBuild(onchain, build, [DEPLOYER])).toBe(true);
  });

  it('rejects an immutable holding anything but the expected value', () => {
    expect(runtimeMatchesBuild(withWord(immutableWord(OTHER)), build, [DEPLOYER])).toBe(false);
  });

  it('rejects any change outside an immutable slot', () => {
    const onchain = withWord(immutableWord(DEPLOYER)).replace(/00$/, 'ff');
    expect(runtimeMatchesBuild(onchain, build, [DEPLOYER])).toBe(false);
    expect(runtimeMatchesBuild(withWord(immutableWord(DEPLOYER)) + '00', build, [DEPLOYER])).toBe(false);
  });

  it('rejects unfilled placeholders when an immutable is expected', () => {
    expect(runtimeMatchesBuild(build, build, [DEPLOYER])).toBe(false);
  });

  it('refuses input that is not hex bytes', () => {
    expect(() => runtimeMatchesBuild('0x123', build, [DEPLOYER])).toThrow();
    expect(() => immutableWord('0x' + '11'.repeat(33))).toThrow();
  });
});
