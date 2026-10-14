import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { getAddress } from 'ethers';
import { adminCalls, vaultCalls, vaultInterface } from '@darksafe/core';
import { fakeQuaiNode, fakePelagus, FakeVault } from './fakeQuaiNode.js';

// Both networks now have recorded deployments; one test needs "nothing deployed" to exercise the missing-deployment UI.
vi.mock('@darksafe/core', async (importOriginal) => {
  const real = await importOriginal<typeof import('@darksafe/core')>();
  return {
    ...real,
    resolveDeployment: (...args: Parameters<typeof real.resolveDeployment>) =>
      (globalThis as any).__noDeployment ? Promise.reject(new real.NoDeploymentError(args[1])) : real.resolveDeployment(...args),
  };
});

const FACTORY = getAddress('0x0011111111111111111111111111111111111111');
const IMPL = getAddress('0x0022222222222222222222222222222222222222');
const VAULT = getAddress('0x0033333333333333333333333333333333333333');
const A = getAddress('0x0044444444444444444444444444444444444444');
const B = getAddress('0x0055555555555555555555555555555555555555');
const C = getAddress('0x0066666666666666666666666666666666666666');
const TS = 1_790_000_000;
const CHAIN = 15000;

function vault(overrides: Partial<FakeVault> = {}): FakeVault {
  return { address: VAULT, owners: [A, B, C], threshold: 2, minExecutionDelay: 86_400, balance: 10n ** 18n, txs: [], ...overrides };
}

function adminProposal() {
  return {
    to: VAULT,
    value: 0n,
    data: adminCalls.changeThreshold(1),
    gasLimit: 0n,
    expiration: TS + 7 * 86_400,
    executionDelay: 0,
    proposer: A,
    proposedAt: TS - 100,
    approvedAt: 0,
    approvals: [A],
  };
}

function rememberVault() {
  window.localStorage.setItem('darksafe.vaults.v2', JSON.stringify([{ address: VAULT, chainId: CHAIN, addedAt: 1, factory: FACTORY }]));
}

async function renderApp() {
  const { App } = await import('../src/App.js');
  return render(<App />);
}

async function connectWallet() {
  fireEvent.click(screen.getByText('Connect Signer'));
  fireEvent.click(screen.getByText('Connect Extension'));
  await waitFor(() => expect(screen.queryByText('Connect Signer')).toBeNull());
}

afterEach(() => {
  delete (globalThis as any).__noDeployment;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete (window as any).pelagus;
});

describe('opening a vault', () => {
  it('opens a genuine factory vault and shows its verified state', async () => {
    vi.stubEnv('VITE_V2_FACTORY_ADDRESS', FACTORY);
    const node = fakeQuaiNode({ chainId: CHAIN, factory: FACTORY, implementation: IMPL, vaults: [vault()], timestamp: TS });
    vi.stubGlobal('fetch', node.fetch);
    await renderApp();

    fireEvent.click(screen.getByText('No Vault Selected', { selector: 'div' }));
    fireEvent.change(screen.getByPlaceholderText('0x00...'), { target: { value: VAULT } });
    const add = screen.getByText('Add').closest('button') as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);

    const panel = await screen.findByTestId('security-panel');
    await waitFor(() => expect(within(panel).getByTestId('verification-status').textContent).toMatch(/one source only/));
    expect(panel.textContent).toContain('2 of 3');
    expect(panel.textContent).toContain('1d');
    expect(JSON.parse(window.localStorage.getItem('darksafe.vaults.v2')!)[0]).toMatchObject({ address: VAULT, factory: FACTORY });
  });

  it('refuses a proxy the factory did not create and offers no override', async () => {
    vi.stubEnv('VITE_V2_FACTORY_ADDRESS', FACTORY);
    const node = fakeQuaiNode({ chainId: CHAIN, factory: FACTORY, implementation: IMPL, vaults: [vault({ registered: false })], timestamp: TS });
    vi.stubGlobal('fetch', node.fetch);
    await renderApp();

    fireEvent.click(screen.getByText('No Vault Selected', { selector: 'div' }));
    fireEvent.change(screen.getByPlaceholderText('0x00...'), { target: { value: VAULT } });
    const add = screen.getByText('Add').closest('button') as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);

    const warning = await screen.findByTestId('unknown-code-warning');
    expect(warning.textContent).toMatch(/was not created by the DarkSafe factory/);
    expect(screen.queryByText(/Add unverified contract anyway/)).toBeNull();
    expect(window.localStorage.getItem('darksafe.vaults.v2')).toBeNull();
  });

  it('explains that vaults cannot be created where DarkSafe v2 is not deployed', async () => {
    (globalThis as any).__noDeployment = true;
    const node = fakeQuaiNode({ chainId: CHAIN, factory: FACTORY, implementation: IMPL, vaults: [], timestamp: TS });
    vi.stubGlobal('fetch', node.fetch);
    await renderApp();
    expect((await screen.findByTestId('deployment-missing-banner')).textContent).toMatch(/not deployed on Orchard yet/);
    fireEvent.click(screen.getByText('Create or Add a Vault'));
    expect(screen.getByTestId('deployment-missing').textContent).toMatch(/not deployed/);
  });
});

describe('reviewing a transaction', () => {
  it('shows an admin change as critical, requires the typed value, and approves on chain', async () => {
    vi.stubEnv('VITE_V2_FACTORY_ADDRESS', FACTORY);
    vi.stubEnv('VITE_TX_CONFIRMATIONS', '1');
    const v = vault({ txs: [adminProposal()] });
    const node = fakeQuaiNode({ chainId: CHAIN, factory: FACTORY, implementation: IMPL, vaults: [v], timestamp: TS });
    const hash = node.hashOf(v, 0);
    const wallet = fakePelagus(B, node, (tx) => {
      const call = vaultInterface.parseTransaction({ data: tx.data })!;
      expect(call.name).toBe('approveTransaction');
      v.txs[0]!.approvals.push(B);
      v.txs[0]!.approvedAt = TS;
      return { hash: '0x' + 'cd'.repeat(32), logs: [{ address: VAULT, ...vaultInterface.encodeEventLog('TransactionApproved', [hash, B]) }] };
    });
    (window as any).pelagus = wallet.provider;
    vi.stubGlobal('fetch', node.fetch);
    rememberVault();
    await renderApp();
    await connectWallet();

    const queue = await screen.findByTestId('tx-queue');
    fireEvent.click(within(queue).getByText('Review'));
    expect((await screen.findByTestId('critical-banner')).textContent).toMatch(/Change threshold to 1/);
    await waitFor(() => expect(screen.getByTestId('review-agreement').textContent).toMatch(/2 independent sources agree/));
    expect(screen.getByTestId('risk-flags').textContent).toMatch(/Lowers the approvals needed from 2 to 1/);

    const approve = (await screen.findByTestId('action-approve')) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('challenge-input'), { target: { value: '1' } });
    await waitFor(() => expect(approve.disabled).toBe(false));
    fireEvent.click(approve);

    expect((await screen.findByTestId('action-result', {}, { timeout: 10_000 })).textContent).toMatch(/Approved/);
    expect(wallet.sent).toHaveLength(1);
    expect(wallet.sent[0]).toMatchObject({ from: B, to: VAULT, data: vaultCalls.approve(hash) });
    expect(wallet.sent[0].gasLimit).toMatch(/^0x[0-9a-f]+$/);
    expect(wallet.sent[0].accessList).toEqual([]);
  });

  it('refuses a transaction whose stored contents do not match its hash', async () => {
    vi.stubEnv('VITE_V2_FACTORY_ADDRESS', FACTORY);
    const v = vault({ txs: [adminProposal()] });
    const node = fakeQuaiNode({
      chainId: CHAIN,
      factory: FACTORY,
      implementation: IMPL,
      vaults: [v],
      timestamp: TS,
      tamperData: { vault: VAULT, index: 0, data: adminCalls.changeThreshold(2) },
    });
    vi.stubGlobal('fetch', node.fetch);
    rememberVault();
    await renderApp();

    const queue = await screen.findByTestId('tx-queue');
    fireEvent.click(within(queue).getByText('Review'));
    expect((await screen.findByTestId('review-error')).textContent).toMatch(/does not match its own contents/);
    expect(screen.queryByTestId('action-approve')).toBeNull();
  });

  it('blocks every action when the wallet node disagrees with the app RPC', async () => {
    vi.stubEnv('VITE_V2_FACTORY_ADDRESS', FACTORY);
    const node = fakeQuaiNode({ chainId: CHAIN, factory: FACTORY, implementation: IMPL, vaults: [vault({ txs: [adminProposal()] })], timestamp: TS });
    const liar = fakeQuaiNode({ chainId: CHAIN, factory: FACTORY, implementation: IMPL, vaults: [vault({ threshold: 1, txs: [adminProposal()] })], timestamp: TS });
    (window as any).pelagus = fakePelagus(B, liar).provider;
    vi.stubGlobal('fetch', node.fetch);
    rememberVault();
    await renderApp();
    await connectWallet();

    const panel = await screen.findByTestId('security-panel');
    await waitFor(() => expect(within(panel).getByTestId('verification-status').textContent).toMatch(/Sources disagree/));
    expect(screen.getByTestId('vault-state-error').textContent).toMatch(/disagree/);

    fireEvent.click(within(await screen.findByTestId('tx-queue')).getByText('Review'));
    await waitFor(() => expect(screen.getByTestId('review-agreement').textContent).toMatch(/Sources disagree/));
    fireEvent.change(screen.getByTestId('challenge-input'), { target: { value: '1' } });
    expect((screen.getByTestId('action-approve') as HTMLButtonElement).disabled).toBe(true);
  });
});
