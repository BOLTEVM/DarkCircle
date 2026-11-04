import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

afterEach(() => cleanup());

// Mainnet and Orchard both carry recorded deployments these days, which would flip the App out
// of showcase mode and into live RPC reads. Tests drop the Orchard record and pin the network
// picker to Orchard, so the site renders its deterministic showcase content.
vi.mock('@darkorder/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@darkorder/core')>();
  return { ...core, DEPLOYMENTS: { ...core.DEPLOYMENTS, orchard: null } };
});

beforeEach(() => {
  window.localStorage.setItem('darkorder.network', 'orchard');
});
