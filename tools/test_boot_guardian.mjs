#!/usr/bin/env node
// test_boot_guardian.mjs -- behavioural test for the boot-guardian script inside index.html
// (no dependencies; a tiny DOM stub stands in for the browser).
//
//   node tools/test_boot_guardian.mjs [path/to/index.html]
//
// The guardian is the net under the 3D module: it must land every module failure path (no module
// support, no import maps, stalled scene download, dead GPU init) on a working 2D portal, and it
// must stay out of the way when the module boots fine. These cases pin that contract.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || join(here, '..', 'index.html');
const html = readFileSync(file, 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const code = blocks.find((c) => c.includes('Boot guardian'));
if (!code) { console.error('boot guardian script not found in ' + file); process.exit(1); }

// --- a minimal DOM: just enough for the guardian ----------------------------------------------
class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.id = '';
    this.className = '';
    this.textContent = '';
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.listeners = {};
  }
  get classList() {
    const el = this;
    const set = () => new Set(el.className.split(/\s+/).filter(Boolean));
    const save = (s) => { el.className = [...s].join(' '); };
    return {
      add(...ns) { const s = set(); ns.forEach((n) => s.add(n)); save(s); },
      remove(...ns) { const s = set(); ns.forEach((n) => s.delete(n)); save(s); },
      contains(n) { return set().has(n); },
      toggle(n, force) { const s = set(); const on = force === undefined ? !s.has(n) : !!force; on ? s.add(n) : s.delete(n); save(s); return on; },
    };
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  dispatch(t, e = {}) { e.target ||= this; e.preventDefault ||= (() => {}); (this.listeners[t] || []).forEach((f) => f(e)); }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  querySelectorAll(sel) { return queryAll(this, sel); }
}
function matchSimple(el, part) {
  if (part.startsWith('.')) return el.classList.contains(part.slice(1));
  if (part.startsWith('#')) return el.id === part.slice(1);
  return el.tagName === part.toUpperCase();
}
function descendants(el, out = []) {
  for (const c of el.children) { out.push(c); descendants(c, out); }
  return out;
}
function queryAll(root, sel) {
  const parts = sel.trim().split(/\s+/);
  let current = [root];
  for (const part of parts) {
    const next = [];
    for (const base of current) for (const d of descendants(base)) if (matchSimple(d, part)) next.push(d);
    current = next;
  }
  return current;
}

// Builds the page exactly as index.html ships it: six station cards, arrows, dots box, boot line.
function makePage({ boot = 'pending', bootText = 'Loading the 3D scene', moduleWired = false } = {}) {
  const root = new El('html');
  const body = new El('body');
  root.appendChild(body);
  const byId = {};
  const reg = (el, id) => { el.id = id; byId[id] = el; return el; };

  const stations = reg(new El('div'), 'portal-stations');
  const cards = [];
  const apps = ['darkcircle', 'circleswap', 'darksafe', 'darkquestate', 'darkorder', 'darkstarrail'];
  const hrefs = ['./x402tumbler/', './q0/', './multisigows/', './darkquestate/', './darkorder/', './bai/'];
  apps.forEach((app, i) => {
    const card = new El('a');
    card.className = 'station-card station-' + app;
    card.setAttribute('href', hrefs[i]);
    card.setAttribute('data-app', app);
    const title = new El('div');
    title.className = 'station-title';
    title.textContent = 'App ' + app;
    card.appendChild(title);
    stations.appendChild(card);
    cards.push(card);
  });
  if (moduleWired) stations.classList.add('carousel-on');   // the module got there first
  body.appendChild(stations);

  const dots = reg(new El('div'), 'carousel-dots');
  body.appendChild(dots);
  const prev = reg(new El('button'), 'carousel-prev');
  const next = reg(new El('button'), 'carousel-next');
  body.appendChild(prev); body.appendChild(next);
  const tel = reg(new El('div'), 'telemetry');
  tel.textContent = 'Drag to look around';
  body.appendChild(tel);
  const bar = new El('footer'); bar.className = 'bottom-bar';
  const keys = new El('div'); keys.className = 'keys'; keys.textContent = 'Drag to look around';
  bar.appendChild(keys); body.appendChild(bar);

  let bootEl = null;
  if (boot !== 'removed') {
    bootEl = reg(new El('div'), 'boot');
    bootEl.className = 'boot' + (boot === 'done' ? ' done' : '');
    bootEl.textContent = bootText;
    body.appendChild(bootEl);
  }

  const winListeners = {};
  const window = {
    location: { href: '' },
    addEventListener(t, fn) { (winListeners[t] ||= []).push(fn); },
  };
  const timers = [];
  const setTimeoutFake = (fn) => { timers.push(fn); return timers.length; };
  function runTimers(max = 10) {
    let n = 0;
    while (timers.length && n++ < max) timers.shift()();
    return n;
  }
  const document = {
    documentElement: root,
    body,
    getElementById: (id) => byId[id] || null,
    querySelector: (sel) => queryAll(root, sel)[0] || null,
    querySelectorAll: (sel) => queryAll(root, sel),
    createElement(tag) {
      const el = new El(tag);
      if (tag === 'script' && env.moduleCapable) el.noModule = false;   // property presence is the feature test
      return el;
    },
  };
  const env = { moduleCapable: true };   // referenced by createElement above; set before run()
  return { root, body, stations, cards, dots, prev, next, tel, keys, window, document, timers, runTimers, winListeners, env };
}

function runGuardian(page, { moduleCapable = true, importmap = null } = {}) {
  page.env.moduleCapable = moduleCapable;
  const HTMLScriptElement = importmap === null ? undefined : { supports: (t) => (t === 'importmap' ? importmap : true) };
  new Function('window', 'document', 'HTMLScriptElement', 'setTimeout', code)
    (page.window, page.document, HTMLScriptElement, page.setTimeoutFake = (fn) => { page.timers.push(fn); });
}

let failed = 0;
function check(name, cond) {
  if (!cond) failed++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name);
}

// 1. No module support at all: immediate fallback, portal fully wired by the guardian
{
  const p = makePage();
  runGuardian(p, { moduleCapable: false });
  check('no-module: no-webgl set immediately', p.root.classList.contains('no-webgl'));
  check('no-module: carousel wired', p.stations.classList.contains('carousel-on'));
  check('no-module: first card in front', p.cards[0].classList.contains('is-front'));
  check('no-module: only first card in front', p.cards.filter((c) => c.classList.contains('is-front')).length === 1);
  check('no-module: six dots built', p.dots.children.length === 6);
  check('no-module: first dot active', p.dots.children[0].classList.contains('active'));
  check('no-module: dot aria-label from card title', p.dots.children[5].getAttribute('aria-label') === 'App darkstarrail');
  check('no-module: telemetry switched to 2D text', /arrows to browse/.test(p.tel.textContent));
  check('no-module: no watchdog armed (returned early)', p.timers.length === 0);

  p.next.dispatch('click');
  check('no-module: next arrow moves the front card', p.cards[1].classList.contains('is-front') && !p.cards[0].classList.contains('is-front'));
  p.prev.dispatch('click'); p.prev.dispatch('click');
  check('no-module: prev arrow wraps around to the last card', p.cards[5].classList.contains('is-front'));
  p.dots.children[2].dispatch('click');
  check('no-module: dot click jumps to its card', p.cards[2].classList.contains('is-front'));

  const key = (k, target) => (p.winListeners.keydown || []).forEach((f) => f({ key: k, target: target || p.body, preventDefault() {} }));
  key('ArrowRight');
  check('no-module: ArrowRight spins', p.cards[3].classList.contains('is-front'));
  key('Enter');
  check('no-module: Enter opens the front card', p.window.location.href === './darkquestate/');
  key('6');
  check('no-module: digit 6 opens Dark Star Rail', p.window.location.href === './bai/');
  key('9');
  check('no-module: out-of-range digit ignored', p.window.location.href === './bai/');
}

// 2. Import maps unsupported: loader hidden at once, but wiring left to the module
{
  const p = makePage();
  runGuardian(p, { moduleCapable: true, importmap: false });
  check('no-importmap: no-webgl set immediately', p.root.classList.contains('no-webgl'));
  check('no-importmap: guardian did not wire (module will)', !p.stations.classList.contains('carousel-on') && p.dots.children.length === 0);
  p.runTimers();
  check('no-importmap: watchdog stays out once no-webgl is set', !p.stations.classList.contains('carousel-on') && p.tel.textContent === 'Drag to look around');
}

// 3. Healthy module path: boot retired in time, watchdog must do nothing
{
  const p = makePage({ boot: 'done', moduleWired: true });
  runGuardian(p, { moduleCapable: true, importmap: true });
  p.runTimers();
  check('healthy: no-webgl untouched', !p.root.classList.contains('no-webgl'));
  check('healthy: guardian did not wire over the module', p.dots.children.length === 0);
}

// 4. Boot element already removed (3D live): watchdog must do nothing
{
  const p = makePage({ boot: 'removed', moduleWired: true });
  runGuardian(p, { moduleCapable: true, importmap: true });
  p.runTimers();
  check('boot-gone: no fallback', !p.root.classList.contains('no-webgl'));
}

// 5. Hung boot (stalled GPU init, no progress ever reported): watchdog forces the 2D portal
{
  const p = makePage({ moduleWired: true });
  runGuardian(p, { moduleCapable: true, importmap: true });
  p.runTimers();
  check('hung: no-webgl forced by the watchdog', p.root.classList.contains('no-webgl'));
  check('hung: module wiring kept (no duplicate dots)', p.dots.children.length === 0 && p.stations.classList.contains('carousel-on'));
  check('hung: telemetry switched to 2D text', /arrows to browse/.test(p.tel.textContent));
}

// 6. Module died before wiring (parse/eval failure): watchdog wires the whole 2D portal
{
  const p = makePage();
  runGuardian(p, { moduleCapable: true, importmap: true });
  p.runTimers();
  check('dead-module: fallback after watchdog delay', p.root.classList.contains('no-webgl'));
  check('dead-module: guardian wired the carousel', p.stations.classList.contains('carousel-on') && p.dots.children.length === 6);
}

// 7. Slow download reporting progress: given extra time, then still bounded
{
  const p = makePage({ bootText: 'Loading the 3D scene 40%', moduleWired: true });
  runGuardian(p, { moduleCapable: true, importmap: true });
  p.timers.shift()();   // first check: sees progress, re-arms
  check('progress: first check re-arms', !p.root.classList.contains('no-webgl') && p.timers.length === 1);
  p.timers.shift()();   // second check: still progress, re-arms once more
  check('progress: second check re-arms', !p.root.classList.contains('no-webgl') && p.timers.length === 1);
  p.timers.shift()();   // third check: out of patience
  check('progress: third check falls back', p.root.classList.contains('no-webgl'));
}

// 8. Activation is one-shot even if the watchdog fires twice
{
  const p = makePage();
  runGuardian(p, { moduleCapable: true, importmap: true });
  p.runTimers();
  const dotsAfterFirst = p.dots.children.length;
  p.runTimers();
  check('one-shot: repeated timers do not re-wire', p.dots.children.length === dotsAfterFirst);
}

console.log(failed ? `\nFAIL ${failed}` : '\nPASS');
process.exit(failed ? 1 : 0);
