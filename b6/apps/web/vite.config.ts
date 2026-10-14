/// <reference types="vitest" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Content Security Policy for the production site. The page talks to exactly three hosts: the two
 * Quai RPC endpoints and the CoinGecko price feed (see packages/core config.ts and price.ts);
 * wallets are browser extensions and are not limited by it. Scripts load only from the site
 * itself, so an injected <script> or a hijacked dependency URL cannot run.
 *
 * Added at build time only: the dev server needs inline scripts for hot reload, and the local
 * Hardhat chain is reached from the dev server alone.
 */
const CONNECT_SRC = ['https://rpc.quai.network', 'https://orchard.rpc.quai.network', 'https://api.coingecko.com'];
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  // React and three.js set inline style attributes; no stylesheet is fetched from elsewhere.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${CONNECT_SRC.join(' ')}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/**
 * Hosts that read a `_headers` file (Cloudflare Pages, Netlify) also get the headers a <meta>
 * tag cannot set: framing, MIME sniffing, permissions. Elsewhere (GitHub Pages, S3) set the same
 * headers at the host or CDN; the file is ignored there.
 */
const HEADERS = [
  '/*',
  `  Content-Security-Policy: ${[...CSP_DIRECTIVES, "frame-ancestors 'none'"].join('; ')}`,
  '  X-Frame-Options: DENY',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: no-referrer',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  '  Cross-Origin-Opener-Policy: same-origin',
  '',
].join('\n');

function securityHeaders(): Plugin {
  return {
    name: 'darkquestate-security-headers',
    apply: 'build',
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP_DIRECTIVES.join('; ') }, injectTo: 'head-prepend' }];
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: HEADERS });
    },
  };
}

// Relative base + hash routing: the built site works from any sub-path (e.g. /darkquestate/ on Pages).
export default defineConfig({
  base: './',
  plugins: [react(), securityHeaders()],
  resolve: {
    alias: {
      '@darkquestate/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
      '@darkquestate/ui': path.resolve(__dirname, '../../packages/ui/src/index.ts'),
    },
  },
  server: {
    // Vite's default host (localhost) keeps the dev server off the network; do not pass --host
    // while a local chain's dev wallet is loaded.
    port: 5290,
    strictPort: true,
  },
  preview: {
    port: 5291,
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          ethers: ['ethers'],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
