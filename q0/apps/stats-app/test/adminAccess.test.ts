// Who may see the Deploy tab. Run: node --test q0/apps/stats-app/test/adminAccess.test.ts  (Node 22.18+/24 strips the types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployTabVisible, isAdministrator, parseAdminList } from '../src/adminAccess.ts';

const OWNER = '0x005c0faa361AE7c4A473343EF24bAe4d1379E638';
const OTHER = '0x0061bAC19852dfA0c4AF18d65FCaa9A585e14B86';
const SIGNER = '0x00591827868F2989Bb34DbCf71Ff5c48574d4D25';

test('the farm owner is an administrator, whatever the case of the address', () => {
  assert.equal(isAdministrator(OWNER, [OWNER.toLowerCase()], []), true);
  assert.equal(isAdministrator(OWNER.toLowerCase(), [OWNER], []), true);
});

test('another wallet is not an administrator', () => {
  assert.equal(isAdministrator(OTHER, [OWNER], []), false);
});

test('no wallet, or one that is not a Cyprus-1 address, is never an administrator', () => {
  assert.equal(isAdministrator(null, [OWNER], [OWNER.toLowerCase()]), false);
  assert.equal(isAdministrator(undefined, [OWNER], []), false);
  assert.equal(isAdministrator('', [OWNER], []), false);
  assert.equal(isAdministrator('0x1234', ['0x1234'], ['0x1234']), false);
  // a valid-looking address on another shard does not count even if it matches an entry
  const elsewhere = '0x11' + 'a'.repeat(38);
  assert.equal(isAdministrator(elsewhere, [elsewhere], [elsewhere]), false);
});

test('an unreadable owner grants nothing', () => {
  assert.equal(isAdministrator(OWNER, [], []), false);
  assert.equal(isAdministrator(OWNER, [null, undefined], []), false);
});

test('the build-time list adds administrators (a multisig signer) without touching the chain', () => {
  const listed = parseAdminList(`${SIGNER}, ${OTHER.toLowerCase()}`);
  assert.equal(isAdministrator(SIGNER, [OWNER], listed), true);
  assert.equal(isAdministrator(OTHER, [OWNER], listed), true);
  assert.equal(isAdministrator('0x00' + '9'.repeat(38), [OWNER], listed), false);
});

test('parseAdminList keeps only valid Cyprus-1 addresses and lower-cases them', () => {
  const raw = `  ${OWNER} ; nonsense,0x1234 ${SIGNER}\n${'0x11' + 'a'.repeat(38)}`;
  assert.deepEqual(parseAdminList(raw), [OWNER.toLowerCase(), SIGNER.toLowerCase()]);
  assert.deepEqual(parseAdminList(undefined), []);
  assert.deepEqual(parseAdminList(''), []);
  assert.deepEqual(parseAdminList(42), []);
});

test('the Deploy tab: an administrator sees it, the public does not', () => {
  const base = { production: true, onThisMachine: false, anythingDeployed: true };
  assert.equal(deployTabVisible({ ...base, isAdmin: true }), true);
  assert.equal(deployTabVisible({ ...base, isAdmin: false }), false);
});

test('the Deploy tab is never open to the public in a production build, deployed or not', () => {
  for (const anythingDeployed of [true, false]) {
    for (const onThisMachine of [true, false]) {
      assert.equal(deployTabVisible({ isAdmin: false, production: true, onThisMachine, anythingDeployed }), false);
    }
  }
});

test('a development build gives the public no Deploy tab once something is deployed', () => {
  assert.equal(deployTabVisible({ isAdmin: false, production: false, onThisMachine: true, anythingDeployed: true }), false);
});

test('the one exception: a development build on this machine with nothing deployed yet (no owner exists to check)', () => {
  assert.equal(deployTabVisible({ isAdmin: false, production: false, onThisMachine: true, anythingDeployed: false }), true);
  // a non-production build served to someone else is still not this machine
  assert.equal(deployTabVisible({ isAdmin: false, production: false, onThisMachine: false, anythingDeployed: false }), false);
});
