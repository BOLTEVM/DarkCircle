import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const webRoot = path.resolve(__dirname, '..');
const vercel = JSON.parse(readFileSync(path.join(webRoot, 'vercel.json'), 'utf8'));
const nginx = readFileSync(path.join(webRoot, 'nginx.conf.example'), 'utf8');
const indexHtml = readFileSync(path.join(webRoot, 'index.html'), 'utf8');

const globalHeaders: Record<string, string> = Object.fromEntries(
  vercel.headers
    .find((h: { source: string }) => h.source === '/(.*)')
    .headers.map((h: { key: string; value: string }) => [h.key, h.value])
);

function cspDirectives(csp: string): Record<string, string[]> {
  return Object.fromEntries(
    csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name!, values];
      })
  );
}

describe('security headers (vercel.json)', () => {
  const csp = cspDirectives(globalHeaders['Content-Security-Policy']!);

  it('forbids framing, plugins, base-tag hijack and form posts', () => {
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    expect(csp['base-uri']).toEqual(["'none'"]);
    expect(csp['form-action']).toEqual(["'none'"]);
    expect(globalHeaders['X-Frame-Options']).toBe('DENY');
  });

  it('allows scripts and styles only from the app origin', () => {
    expect(csp['script-src']).toEqual(["'self'"]);
    expect(csp['style-src']).toEqual(["'self'"]);
    for (const directive of Object.values(csp)) {
      expect(directive).not.toContain("'unsafe-inline'");
      expect(directive).not.toContain("'unsafe-eval'");
    }
  });

  it('lets the page talk only to the Quai Cyprus-1 RPC hosts', () => {
    expect(csp['connect-src']).toEqual([
      "'self'",
      'https://rpc.quai.network',
      'https://orchard.rpc.quai.network',
    ]);
    const all = Object.values(csp).flat().join(' ');
    expect(all).not.toMatch(/\*/);
    expect(all).not.toContain('qrserver');
  });

  it('sets HSTS, nosniff, no-referrer and cross-origin isolation headers', () => {
    expect(globalHeaders['Strict-Transport-Security']).toMatch(/max-age=63072000/);
    expect(globalHeaders['X-Content-Type-Options']).toBe('nosniff');
    expect(globalHeaders['Referrer-Policy']).toBe('no-referrer');
    expect(globalHeaders['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(globalHeaders['Permissions-Policy']).toContain('camera=()');
  });
});

describe('nginx.conf.example stays in sync with vercel.json', () => {
  it('uses the identical CSP in every block that sets one', () => {
    const csps = [...nginx.matchAll(/add_header Content-Security-Policy "([^"]+)"/g)].map((m) => m[1]);
    expect(csps.length).toBeGreaterThanOrEqual(3);
    for (const value of csps) expect(value).toBe(globalHeaders['Content-Security-Policy']);
  });

  it('repeats frame and sniffing protection in every block', () => {
    expect([...nginx.matchAll(/X-Frame-Options "DENY"/g)].length).toBe(3);
    expect([...nginx.matchAll(/X-Content-Type-Options "nosniff"/g)].length).toBe(3);
  });
});

describe('index.html', () => {
  it('loads no third-party resources and has no inline script', () => {
    expect(indexHtml).not.toMatch(/fonts\.googleapis|fonts\.gstatic|qrserver/);
    const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    for (const [, attrs, body] of scripts) {
      expect(attrs).toMatch(/src=/);
      expect(body!.trim()).toBe('');
    }
  });
});
