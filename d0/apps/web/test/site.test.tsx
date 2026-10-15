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

  it('shows guild metadata on the cards, not hex strings', async () => {
    render(<App />);
    // The charter text from the showcase profiles is what a visitor reads…
    expect(await screen.findByText(/Keepers of the crimson flame/)).toBeInTheDocument();
    expect(screen.getByText(/Five keys, three to turn/)).toBeInTheDocument();
    // …with the treasury alongside…
    expect(screen.getAllByText(/QUAI/).length).toBeGreaterThan(0);
    // …and no raw contract address anywhere on the frontpage.
    expect(screen.queryByText(/0x00[0-9a-f]{10,}/i)).not.toBeInTheDocument();
  });
});
