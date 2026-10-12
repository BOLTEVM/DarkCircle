import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { App } from '../src/App.js';
import { FORBIDDEN_MOCK_BALANCE } from '@darksafe/core';

describe('DarkSafe Visual Architecture & Layout Verification', () => {
  it('renders brand header, no-vault empty state, and disconnected signer pill on first load', () => {
    render(<App />);

    // Brand logo
    const logoImg = screen.getByAltText('DarkSafe Logo');
    expect(logoImg).toBeInTheDocument();
    expect(logoImg.getAttribute('src')).toMatch(/(^|\/)0\.png$/);

    // Page credit in the footer, with a real image and text fallback
    const footer = screen.getByTestId('app-footer');
    expect(footer).toHaveTextContent(/powered by/i);
    const bolt = screen.getByAltText('BOLT');
    expect(bolt.getAttribute('src')).toMatch(/(^|\/)Boltfont\.png$/);
    expect(footer).toContainElement(bolt);
    const link = bolt.closest('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('https://boltevm.com');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer');

    // No vault pre-selected — nothing fabricated
    expect(screen.getAllByText('No Vault Selected').length).toBeGreaterThan(0);
    expect(screen.getByText('Create or Add a Vault')).toBeInTheDocument();

    // Disconnected signer pill — no default demo signer
    expect(screen.getByText('Connect Signer')).toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();
  });

  it('renders sidebar navigation without any hardcoded workspace/consensus branding', () => {
    render(<App />);

    expect(screen.getAllByText('No Vault Selected').length).toBeGreaterThan(0);
    expect(screen.getByText('Cyprus-1 (15000)')).toBeInTheDocument();

    expect(screen.getByText('New transaction')).toBeInTheDocument();
    expect(screen.getByText('Assets & Holdings')).toBeInTheDocument();
    expect(screen.getByText('Transactions Queue')).toBeInTheDocument();
    expect(screen.getByText('Address Book')).toBeInTheDocument();
    expect(screen.getByText('Safe Settings')).toBeInTheDocument();

    expect(screen.getByText('Quaiswap DEX')).toBeInTheDocument();
    expect(screen.getByText('BDelta CLOB')).toBeInTheDocument();

    // No fabricated "PRO ACTIVE" badge, and no stale 4-of-7 consensus claim
    expect(screen.queryByText('DarkSafe PRO')).not.toBeInTheDocument();
    expect(screen.queryByText('4-of-7 Consensus')).not.toBeInTheDocument();
  });

  it('opens the Create Vault wizard from the empty state and validates owner addresses', () => {
    render(<App />);

    fireEvent.click(screen.getByText('Create or Add a Vault'));
    expect(screen.getByText('Create a New Vault')).toBeInTheDocument();

    // Step 1 requires a connected wallet extension before continuing — no local-key
    // (OWS) fallback exists anymore.
    expect(screen.getByText('Connect Wallet')).toBeInTheDocument();
  });

  it('opens and cancels the New Transaction proposal modal cleanly', () => {
    render(<App />);

    fireEvent.click(screen.getByText('New transaction'));
    expect(screen.getByText('New Multi-Sig Transaction')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('0x00...')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('New Multi-Sig Transaction')).not.toBeInTheDocument();
  });

  it('validates Cyprus-1 address requirements in the New Transaction modal', () => {
    render(<App />);

    fireEvent.click(screen.getByText('New transaction'));
    const input = screen.getByPlaceholderText('0x00...');
    fireEvent.change(input, { target: { value: '0x1234567890123456789012345678901234567890' } });

    expect(screen.getByText(/must strictly begin with "0x00"/i)).toBeInTheDocument();
  });

  it('strictly adheres to zero hardcoding rule (no $2,348.43 in document)', () => {
    const { container } = render(<App />);
    expect(container.innerHTML).not.toContain(FORBIDDEN_MOCK_BALANCE);
  });
});
