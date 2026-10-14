/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Relative base + hash routing: the built site works from any sub-path (e.g. /d0/ on Pages).
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@darkorder/core': path.resolve(__dirname, '../../packages/core/src/index.ts'),
    },
  },
  server: {
    port: 5300,
    strictPort: true,
  },
  preview: {
    port: 5301,
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
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
