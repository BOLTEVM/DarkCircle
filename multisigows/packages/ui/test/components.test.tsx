import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  themeTokens,
  cn,
  formatAddress,
  formatAmount,
  formatCurrency,
} from '../src/theme/tokens';
import { Button } from '../src/components/Button';
import { Modal } from '../src/components/Modal';
import { Card } from '../src/components/Card';
import { Badge, ThresholdBadge } from '../src/components/Badge';
import { Input } from '../src/components/Input';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
  TableEmpty,
} from '../src/components/Table';
import { SkeletonLoader } from '../src/components/SkeletonLoader';
import { ThresholdProgressBar } from '../src/components/ThresholdProgressBar';
import { AddressAvatar } from '../src/components/AddressAvatar';
import { CopyButton } from '../src/components/CopyButton';
import { Dropdown } from '../src/components/Dropdown';

describe('@darksafe/ui Theme & Helpers', () => {
  it('exports valid Safe{Wallet} theme tokens', () => {
    expect(themeTokens.colors.primary.DEFAULT).toBe('#10b981');
    expect(themeTokens.colors.surfaces.background).toBe('#0b0f17');
    expect(themeTokens.colors.surfaces.card).toBe('#121926');
    expect(themeTokens.colors.status.success.text).toBe('#34d399');
  });

  it('merges Tailwind classes with conflict resolution using cn()', () => {
    const result = cn('p-2 text-white', 'p-4', 'text-slate-200');
    expect(result).toBe('p-4 text-slate-200');
  });

  it('formats hex addresses correctly with formatAddress()', () => {
    const addr = '0x0060d4bca03f88fdf2b8fa58f0';
    expect(formatAddress(addr, 6, 4)).toBe('0x0060...58f0');
    expect(formatAddress('')).toBe('');
    expect(formatAddress(null)).toBe('');
  });

  it('formats token amounts with formatAmount()', () => {
    expect(formatAmount(1250.5, 4, 4)).toBe('1,250.5000');
    expect(formatAmount(1250.5, 4, 2)).toBe('1,250.50');
    expect(formatAmount('847.83', 2, 2)).toBe('847.83');
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(BigInt(100))).toBe('100.00');
  });

  it('formats fiat currencies with formatCurrency()', () => {
    expect(formatCurrency(2348.43)).toBe('$2,348.43');
    expect(formatCurrency('0')).toBe('$0.00');
  });
});

describe('Button Primitive', () => {
  it('renders button with children and responds to click', () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Submit Transaction</Button>);
    const btn = screen.getByRole('button', { name: /submit transaction/i });
    expect(btn).toBeInTheDocument();
    fireEvent.click(btn);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('disables button and displays loader when isLoading is true', () => {
    const handleClick = vi.fn();
    render(
      <Button isLoading onClick={handleClick}>
        Sign SafeTx
      </Button>
    );
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(btn);
    expect(handleClick).not.toHaveBeenCalled();
  });

  it('renders left and right icons properly', () => {
    render(
      <Button
        leftIcon={<span data-testid="left-icon">L</span>}
        rightIcon={<span data-testid="right-icon">R</span>}
      >
        Action
      </Button>
    );
    expect(screen.getByTestId('left-icon')).toBeInTheDocument();
    expect(screen.getByTestId('right-icon')).toBeInTheDocument();
  });
});

describe('Modal Primitive', () => {
  it('renders when isOpen is true and hides when false', () => {
    const { rerender } = render(
      <Modal isOpen={false} onClose={vi.fn()} title="Test Modal">
        Modal Content
      </Modal>
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(
      <Modal isOpen={true} onClose={vi.fn()} title="Test Modal">
        Modal Content
      </Modal>
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Test Modal')).toBeInTheDocument();
    expect(screen.getByText('Modal Content')).toBeInTheDocument();
  });

  it('calls onClose when close button is clicked', () => {
    const handleClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={handleClose} title="Closeable Modal">
        Body
      </Modal>
    );
    const closeBtn = screen.getByLabelText(/close dialog/i);
    fireEvent.click(closeBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});

describe('Card Primitive', () => {
  it('renders title, subtitle, headerAction and body', () => {
    render(
      <Card
        title="Dynamic Total Balance"
        subtitle="Quai Network Cyprus-1"
        headerAction={<button>Action</button>}
        footer={<span>Footer Details</span>}
      >
        <p>Card Body Content</p>
      </Card>
    );
    expect(screen.getByText('Dynamic Total Balance')).toBeInTheDocument();
    expect(screen.getByText('Quai Network Cyprus-1')).toBeInTheDocument();
    expect(screen.getByText('Action')).toBeInTheDocument();
    expect(screen.getByText('Card Body Content')).toBeInTheDocument();
    expect(screen.getByText('Footer Details')).toBeInTheDocument();
  });
});

describe('Badge & ThresholdBadge Primitives', () => {
  it('renders standard Badge with status variant', () => {
    render(
      <Badge variant="success" showDot>
        Active Signer
      </Badge>
    );
    expect(screen.getByText('Active Signer')).toBeInTheDocument();
  });

  it('renders ThresholdBadge with m/n ratio', () => {
    render(<ThresholdBadge threshold={4} totalOwners={7} currentSigners={4} />);
    expect(screen.getByText('4/7 Threshold')).toBeInTheDocument();
  });
});

describe('Input Primitive', () => {
  it('renders input with label and helper text', () => {
    render(
      <Input
        label="Destination Address"
        helperText="Enter Cyprus-1 recipient address"
        placeholder="0x00..."
      />
    );
    expect(screen.getByLabelText('Destination Address')).toBeInTheDocument();
    expect(screen.getByText('Enter Cyprus-1 recipient address')).toBeInTheDocument();
  });

  it('displays error text when provided', () => {
    render(
      <Input
        label="Amount"
        value="100"
        onChange={vi.fn()}
        error="Insufficient QUAI balance"
      />
    );
    expect(screen.getByText('Insufficient QUAI balance')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('indicates Cyprus-1 requirements when isAddress is true', () => {
    render(<Input label="Safe Address" isAddress placeholder="0x00..." />);
    expect(screen.getByText('Cyprus-1 (0x00)')).toBeInTheDocument();
  });
});

describe('Table Primitives', () => {
  it('renders tabular layout cleanly', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Asset</TableHead>
            <TableHead>Balance</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>QUAI</TableCell>
            <TableCell>1,250.50</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );
    expect(screen.getByText('Asset')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
    expect(screen.getByText('QUAI')).toBeInTheDocument();
    expect(screen.getByText('1,250.50')).toBeInTheDocument();
  });

  it('renders TableEmpty state when no rows are present', () => {
    render(
      <Table>
        <TableBody>
          <TableEmpty colSpan={2} message="No pending transactions found" />
        </TableBody>
      </Table>
    );
    expect(screen.getByText('No pending transactions found')).toBeInTheDocument();
  });
});

describe('SkeletonLoader Primitive', () => {
  it('renders loading placeholder with pulse animation', () => {
    render(<SkeletonLoader variant="card" data-testid="skeleton" />);
    const el = screen.getByTestId('skeleton');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('role', 'status');
    expect(el).toHaveClass('animate-pulse');
  });

  it('renders multiple skeleton items when count > 1', () => {
    render(<SkeletonLoader variant="text" count={3} />);
    const group = screen.getByRole('status', { name: /loading multiple items/i });
    expect(group.children.length).toBe(3);
  });
});

describe('ThresholdProgressBar Primitive', () => {
  it('renders ratio, progress bar, and amber status when pending', () => {
    render(
      <ThresholdProgressBar
        current={2}
        threshold={4}
        total={7}
        showLabel
        showRatio
      />
    );
    expect(screen.getByText(/needs 2 more signatures/i)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '4');
  });

  it('renders emerald status and ready state when threshold is satisfied', () => {
    render(
      <ThresholdProgressBar
        current={4}
        threshold={4}
        total={7}
        showLabel
        showRatio
      />
    );
    expect(screen.getByText(/ready to execute/i)).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4');
  });
});

describe('AddressAvatar Primitive', () => {
  it('renders deterministic SVG avatar for Cyprus-1 address', () => {
    render(
      <AddressAvatar
        address="0x0060d4bca03f88fdf2b8fa58f0000000000000001"
        size="md"
        data-testid="avatar"
      />
    );
    const avatar = screen.getByTestId('avatar');
    expect(avatar).toBeInTheDocument();
    expect(avatar.querySelector('svg')).toBeInTheDocument();
  });

  it('handles empty address gracefully', () => {
    render(<AddressAvatar address="" data-testid="empty-avatar" />);
    expect(screen.getByTestId('empty-avatar')).toBeInTheDocument();
  });
});

describe('CopyButton Primitive', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('copies text and toggles to copied state upon click', async () => {
    render(
      <CopyButton
        text="0x0060d4bca03f88fdf2b8fa58f0"
        label="Copy Address"
        copiedLabel="Copied!"
      />
    );
    const btn = screen.getByRole('button', { name: /copy address/i });
    fireEvent.click(btn);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('0x0060d4bca03f88fdf2b8fa58f0');

    await waitFor(() => {
      expect(screen.getByText('Copied!')).toBeInTheDocument();
    });
  });
});

describe('Dropdown Primitive', () => {
  it('opens menu on click and handles item selection', async () => {
    const handleSelect = vi.fn();
    const items = [
      { id: '1', label: 'BOLTEVM_MCS Safe' },
      { id: '2', label: 'Secondary Safe' },
    ];

    render(
      <Dropdown
        trigger={<button>Select Safe</button>}
        items={items}
        onSelect={handleSelect}
      />
    );

    // Initial state: menu closed
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    // Click trigger to open
    fireEvent.click(screen.getByText('Select Safe'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByText('BOLTEVM_MCS Safe')).toBeInTheDocument();

    // Click item
    fireEvent.click(screen.getByText('BOLTEVM_MCS Safe'));
    expect(handleSelect).toHaveBeenCalledWith('1');

    // Menu should close
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });
});
