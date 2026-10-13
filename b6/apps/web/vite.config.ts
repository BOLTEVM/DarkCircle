/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Relative base + hash routing: the built site works from any sub-path (e.g. /darkquestate/ on Pages).
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@darkquestate/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
      '@darkquestate/ui': path.resolve(__dirname, '../../packages/ui/src/index.ts'),
    },
  },
  server: {
    port: 5290,
    strictPort: true,
  },
  preview: {
    port: 5291,
  },
  build: {
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
