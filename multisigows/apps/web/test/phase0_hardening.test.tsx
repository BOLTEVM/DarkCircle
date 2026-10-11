import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MAINNET_CONFIG, TESTNET_CONFIG } from '@safebuddy/core';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete (window as any).pelagus;
  delete (window as any).ethereum;
});

describe('network config', () => {
  it('blocks mainnet vaults unless the build explicitly opts in', async () => {
    const { isVaultCreationAllowed } = await import('../src/config/network.js');
    expect(isVaultCreationAllowed(TESTNET_CONFIG)).toBe(true);
    expect(isVaultCreationAllowed(MAINNET_CONFIG)).toBe(false);
    vi.stubEnv('VITE_ALLOW_MAINNET_VAULTS', 'true');
    expect(isVaultCreationAllowed(MAINNET_CONFIG)).toBe(true);
  });

  it('defaults to deeper confirmation on reorg-prone Orchard and honours a valid override only', async () => {
    const { requiredConfirmations } = await import('../src/config/network.js');
    expect(requiredConfirmations(MAINNET_CONFIG)).toBe(3);
    expect(requiredConfirmations(TESTNET_CONFIG)).toBe(6);
    vi.stubEnv('VITE_TX_CONFIRMATIONS', '12');
    expect(requiredConfirmations(TESTNET_CONFIG)).toBe(12);
    vi.stubEnv('VITE_TX_CONFIRMATIONS', '0');
    expect(requiredConfirmations(TESTNET_CONFIG)).toBe(6);
  });
});

describe('app shell', () => {
  it('always shows the unaudited-beta banner', async () => {
    const { App } = await import('../src/App.js');
    render(<App />);
    expect(screen.getByTestId('beta-banner').textContent).toMatch(/not had an independent security audit/);
  });

  it('refuses mainnet vault creation in a default build', async () => {
    vi.stubEnv('VITE_QUAI_NETWORK', 'mainnet');
    const { App } = await import('../src/App.js');
    render(<App />);
    fireEvent.click(screen.getByText('Create or Add a Vault'));
    expect(screen.getByTestId('mainnet-gate').textContent).toMatch(/not yet enabled on Quai mainnet/);
    expect((screen.getByText('Continue').closest('button') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('adding an existing vault', () => {
  it('rejects a contract whose code is not a pinned SafeBuddy vault and offers no override', async () => {
    const { fakeQuaiNode } = await import('./fakeQuaiNode.js');
    const factory = '0x0011111111111111111111111111111111111111';
    const impostor = '0x0060938367f4F711A467e2f562ECe51A7a7158f0';
    vi.stubEnv('VITE_V2_FACTORY_ADDRESS', factory);
    const node = fakeQuaiNode({
      chainId: TESTNET_CONFIG.chainId,
      factory,
      implementation: '0x0022222222222222222222222222222222222222',
      vaults: [],
      codes: { [impostor.toLowerCase()]: '0x6001600155' },
    });
    vi.stubGlobal('fetch', node.fetch);
    const { App } = await import('../src/App.js');
    render(<App />);

    fireEvent.click(screen.getByText('No Vault Selected', { selector: 'div' }));
    fireEvent.change(screen.getByPlaceholderText('0x00...'), { target: { value: impostor } });
    const add = screen.getByText('Add').closest('button') as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);

    const warning = await screen.findByTestId('unknown-code-warning');
    expect(warning.textContent).toMatch(/Not a recognised SafeBuddy vault/);
    expect(screen.queryByText(/Add unverified contract anyway/)).toBeNull();
    expect(window.localStorage.getItem('safebuddy.vaults.v2')).toBeNull();
  });
});

describe('wallet connection', () => {
  it('ignores a generic window.ethereum wallet that cannot sign Quai transactions', async () => {
    (window as any).ethereum = { request: vi.fn() };
    const { App } = await import('../src/App.js');
    render(<App />);
    fireEvent.click(screen.getByText('Connect Signer'));
    expect(screen.getByText('No Browser Wallet Detected')).toBeTruthy();
    fireEvent.click(screen.getByText('Connect Extension'));
    await waitFor(() => expect(screen.getByText(/No Quai wallet found/)).toBeTruthy());
    expect((window as any).ethereum.request).not.toHaveBeenCalled();
  });

  it('refuses a Pelagus account outside Cyprus-1', async () => {
    (window as any).pelagus = {
      request: async ({ method }: { method: string }) => {
        if (method === 'quai_requestAccounts') return ['0x1234567890123456789012345678901234567890'];
        if (method === 'quai_chainId') return '0x3a98';
        return null;
      },
    };
    const { App } = await import('../src/App.js');
    render(<App />);
    fireEvent.click(screen.getByText('Connect Signer'));
    fireEvent.click(screen.getByText('Connect Extension'));
    await waitFor(() => expect(screen.getByText(/is not a Cyprus-1/)).toBeTruthy());
    expect(screen.getByText('Connect Signer')).toBeTruthy();
  });

  it('flags a wallet on the wrong chain in the header', async () => {
    (window as any).pelagus = {
      request: async ({ method }: { method: string }) => {
        if (method === 'quai_requestAccounts') return ['0x00233CAb6b0aAF8757f4AD2Ab4F4C5d8697F6170'];
        if (method === 'quai_chainId') return '0x9';
        return null;
      },
    };
    const { App } = await import('../src/App.js');
    render(<App />);
    fireEvent.click(screen.getByText('Connect Signer'));
    fireEvent.click(screen.getByText('Connect Extension'));
    const badge = await screen.findByTestId('network-badge');
    expect(badge.textContent).toMatch(/Wrong network \(wallet: 9\)/);
  });
});
