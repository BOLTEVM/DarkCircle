import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../src/App.js';

describe('the site', () => {
  it('renders the Halls in showcase mode without a wallet or RPC', async () => {
    render(<App />);
    expect(await screen.findByText('The Grand Guild Halls')).toBeInTheDocument();
    expect(screen.getAllByText(/Showcase/i).length).toBeGreaterThan(0);
    expect(screen.getByText('emberhold')).toBeInTheDocument();
    expect(screen.getByText('ironcouncil')).toBeInTheDocument();
  });
});
