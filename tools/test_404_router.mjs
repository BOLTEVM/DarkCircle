#!/usr/bin/env node
// test_404_router.mjs -- behavioural test for the redirect script inside 404.html (no dependencies).
//
//   node tools/test_404_router.mjs [path/to/404.html]
//
// It also runs the subdomain router at the top of index.html, which must agree with 404.html.
//
// The suite is served from a domain root or, on GitHub project pages, from /<repo>/.
// The first version of 404.html hard-coded absolute /q0/ style targets, which sent project-pages
// visitors out of the site; these cases pin the prefix handling.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || join(here, '..', '404.html');
const html = readFileSync(file, 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function run(host, path, search = '', hash = '') {
  let dest = null;
  const window = { location: { hostname: host, pathname: path, search, hash, replace: (u) => { dest = u; } } };
  new Function('window', code)(window);
  return dest;
}

const cases = [
  // GitHub project pages: the /DarkCircle/ prefix must survive every redirect
  ['boltevm.github.io', '/DarkCircle/nope', '', '', '/DarkCircle/'],
  ['boltevm.github.io', '/DarkCircle/q0/deep/link', '?a=1', '#x', '/DarkCircle/q0/?a=1#x'],
  ['boltevm.github.io', '/DarkCircle/multisigows/vault/3', '', '', '/DarkCircle/multisigows/'],
  ['boltevm.github.io', '/DarkCircle/darkcircle/zzz', '', '', '/DarkCircle/x402tumbler/'],
  // user/org pages or custom domain at the root
  ['boltevm.github.io', '/q0/foo', '', '', '/q0/'],
  ['example.com', '/zzz', '', '', '/'],
  ['example.com', '/circleswap/x', '', '', '/q0/'],
  // subdomain routing
  ['q0.example.com', '/anything', '', '', '/q0/'],
  ['safe.example.com', '/anything', '', '', '/multisigows/'],
  ['tumbler.example.com', '/anything', '', '', '/x402tumbler/'],
  // Dark Questate: one folder (darkquestate/), questate/ is a path alias. The site uses hash routes,
  // so the hash must survive, and the app folders must not be mistaken for the repo prefix.
  ['boltevm.github.io', '/DarkCircle/darkquestate/listing/7', '', '#/listing/7', '/DarkCircle/darkquestate/#/listing/7'],
  ['boltevm.github.io', '/DarkCircle/questate/x', '', '', '/DarkCircle/darkquestate/'],
  ['boltevm.github.io', '/darkquestate/x', '', '', '/darkquestate/'],
  ['boltevm.github.io', '/questate/x', '', '', '/darkquestate/'],
  ['example.com', '/questate/sell', '?a=1', '#/sell', '/darkquestate/?a=1#/sell'],
  ['questate.example.com', '/anything', '', '', '/darkquestate/'],
  ['darkquestate.example.com', '/anything', '', '', '/darkquestate/'],
  ['realestate.example.com', '/anything', '?x=1', '', '/darkquestate/?x=1'],
  ['boltevm-questate-preview.example.com', '/anything', '', '', '/darkquestate/'],
];

let failed = 0;
for (const [host, path, search, hash, want] of cases) {
  const got = run(host, path, search, hash);
  const ok = got === want;
  if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + host + path + ' -> ' + got + (ok ? '' : '   (want ' + want + ')'));
}

// index.html carries its own copy of the subdomain rules (it runs before the portal paints);
// it must send every app's subdomains to the same folder as 404.html does.
const portal = readFileSync(join(here, '..', 'index.html'), 'utf8');
const portalCode = portal.match(/<script>([\s\S]*?)<\/script>/)[1];
function runPortal(host, path) {
  let dest = null;
  const window = { location: { hostname: host, pathname: path, search: '', hash: '', replace: (u) => { dest = u; } } };
  new Function('window', portalCode)(window);
  return dest;
}
const portalCases = [
  ['q0.example.com', '/', './q0/'],
  ['safe.example.com', '/', './multisigows/'],
  ['tumbler.example.com', '/', './x402tumbler/'],
  ['questate.example.com', '/', './darkquestate/'],
  ['darkquestate.example.com', '/index.html', './darkquestate/'],
  ['realestate.example.com', '/', './darkquestate/'],
  ['example.com', '/', null],
];
for (const [host, path, want] of portalCases) {
  const got = runPortal(host, path);
  const ok = got === want;
  if (!ok) failed++;
  console.log((ok ? 'ok   ' : 'FAIL ') + 'index.html ' + host + path + ' -> ' + got + (ok ? '' : '   (want ' + want + ')'));
}

const total = cases.length + portalCases.length;
console.log(failed ? `\nFAIL ${failed}/${total}` : `\nPASS ${total}/${total}`);
process.exit(failed ? 1 : 0);
