import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

afterEach(() => cleanup());

// Mainnet carries a recorded deployment these days, which would flip the App out of showcase
// mode and into live RPC reads. Tests pin the network picker to Orchard (no recorded
// deployment) so the site renders its deterministic showcase content.
beforeEach(() => {
  window.localStorage.setItem('darkorder.network', 'orchard');
});
