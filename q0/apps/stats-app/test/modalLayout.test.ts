// Why this exists: on a Galaxy S10e inside a wallet's in-app browser the liquidity form collapsed to a 30px strip and the
// token list showed a blurred page and no sheet, because both were sized in viewport units (`max-height: 95vh`,
// `height: 88dvh`) and that WebView resolves those units to ~0 while its fixed overlay is the real full screen.
// These checks keep every dialog on the one shell (ModalShell) and keep viewport units out of it.
// Run: node --test q0/apps/stats-app/test/modalLayout.test.ts  (Node 22.18+/24 strips the types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (name: string) => readFileSync(join(SRC, name), 'utf8');

/** Source with comments removed, so a sentence explaining the bug does not trip the check for the bug. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
}

const VIEWPORT_UNIT = /(?:^|[^a-zA-Z0-9_-])[0-9]*\.?[0-9]+(?:vh|dvh|svh|lvh|vmin|vmax)\b/;

const DIALOG_SOURCES = [
  'ModalShell.tsx',
  'ui.tsx',
  'PoolModal.tsx',
  'TokenPicker.tsx',
  'DeployModals.tsx',
  'FarmActionModal.tsx',
  'ImportTokenModal.tsx',
  'ArtworkModal.tsx',
  'GovernanceModal.tsx',
  'PairDetailModal.tsx'
];

test('the shell stylesheet uses no viewport units', () => {
  assert.equal(VIEWPORT_UNIT.test(code(read('modal.css'))), false);
});

test('the token list rules in index.css use no viewport units', () => {
  const css = code(read('index.css'));
  const from = css.indexOf('.token-picker-modal');
  const to = css.indexOf('.swap-usd {');
  assert.ok(from >= 0 && to > from, 'token list block not found');
  assert.equal(VIEWPORT_UNIT.test(css.slice(from, to)), false);
});

test('no dialog component sizes anything in viewport units', () => {
  for (const file of DIALOG_SOURCES) {
    assert.equal(VIEWPORT_UNIT.test(code(read(file))), false, `${file} uses a viewport unit`);
  }
});

test('no dialog draws its own fixed overlay: they all go through ModalShell', () => {
  for (const file of DIALOG_SOURCES.filter(f => f !== 'ModalShell.tsx')) {
    assert.equal(/position:\s*['"]fixed['"]/.test(code(read(file))), false, `${file} positions its own fixed overlay`);
  }
  assert.match(read('ModalShell.tsx'), /createPortal\([\s\S]*document\.body/);
});

test('the overlay is a fixed box with all four offsets and the panel is bounded by it, with a floor', () => {
  const css = code(read('modal.css'));
  const backdrop = /\.cs-backdrop\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(backdrop, /position:\s*fixed/);
  for (const side of ['top', 'right', 'bottom', 'left']) assert.match(backdrop, new RegExp(`${side}:\\s*0`), `${side}: 0`);
  assert.match(backdrop, /overflow-y:\s*auto/);
  assert.match(backdrop, /overscroll-behavior:\s*contain/);

  const modal = /\.cs-modal\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(modal, /max-height:\s*100%/);
  assert.match(modal, /min-height:\s*[0-9.]+rem/);
  assert.match(modal, /margin:\s*auto/);

  // the page behind does not scroll while a dialog is open
  assert.match(css, /html\.cs-modal-open[^{]*\{[^}]*overflow:\s*hidden/);
});

test('the phone sheet is a share of the overlay, not of the viewport', () => {
  const css = code(read('modal.css'));
  const sheet = /@media \(max-width:\s*560px\)[\s\S]*?\.cs-modal--sheet\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.match(sheet, /height:\s*88%/);
  assert.match(sheet, /min-height:\s*[0-9.]+rem/);
});

test('touch: 16px fields, 44px targets, no tap delay', () => {
  const css = code(read('modal.css'));
  assert.match(css, /@media \(pointer:\s*coarse\)[\s\S]*font-size:\s*max\(16px/);
  assert.match(css, /\.cs-modal-close\s*\{[^}]*width:\s*44px;[^}]*height:\s*44px/);
  assert.match(css, /touch-action:\s*manipulation/);
});

test('the DEX picker offers Circleswap, Quaiswap and Quainance only', () => {
  const pool = code(read('PoolModal.tsx'));
  assert.match(pool, /const POOL_DEXES: DexId\[\] = \['CIRCLESWAP', 'QUAISWAP', 'QUAINANCE'\];/);
  assert.equal(/Object\.values\(DEXES\)/.test(pool), false, 'the select must not iterate every DEX (it holds the Quainance curves)');
  assert.match(pool, /POOL_DEXES\.map\(/);
});

test('the token list marks tokens found in pools as unverified', () => {
  const picker = read('TokenPicker.tsx');
  assert.match(picker, /discovered/);
  assert.match(picker, /<em className="token-chip token-chip-warn"[^>]*>Unverified<\/em>/);
});

test('token list rows are at least 44px tall', () => {
  const css = read('index.css');
  const option = /\.token-picker-option\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  const min = /min-height:\s*([0-9.]+)px/.exec(option)?.[1];
  assert.ok(min && Number(min) >= 44, `token-picker-option min-height is ${min}`);
});
