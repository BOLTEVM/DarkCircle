import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { App } from '../src/App.js';

describe('the deploy modal', () => {
  it('opens from the showcase banner and shows the launch checklist', async () => {
    render(<App />);
    const trigger = await screen.findByTestId('open-deploy-modal');
    fireEvent.click(trigger);

    const modal = await screen.findByTestId('deploy-modal');
    expect(screen.getByRole('heading', { name: 'Deploy DarkOrder' })).toBeInTheDocument();

    const checklist = within(modal).getByTestId('launch-checklist');
    expect(within(checklist).getByText(/Target network:/)).toBeInTheDocument();
    expect(within(checklist).getByText('No deployment is recorded for this network')).toBeInTheDocument();
    expect(within(checklist).getByText('Contract builds are present')).toBeInTheDocument();
    expect(within(checklist).getByText('Quai wallet connected')).toBeInTheDocument();

    // All four steps are listed before anything runs: three creations, then the wiring call.
    expect(within(modal).getByText(/GuildNameRegistry \(hall names\)/)).toBeInTheDocument();
    expect(within(modal).getByText(/TokenStackDeployer \(guild tokens\)/)).toBeInTheDocument();
    expect(within(modal).getByText(/GuildFactory \(founding\)/)).toBeInTheDocument();
    expect(within(modal).getByText(/registry\.wire\(factory\)/)).toBeInTheDocument();

    // Without a wallet the call to action is a connect button, never a deploy button.
    expect(within(modal).getByRole('button', { name: /Connect wallet/i })).toBeInTheDocument();
    expect(within(modal).queryByTestId('deploy-button')).not.toBeInTheDocument();
  });
});
