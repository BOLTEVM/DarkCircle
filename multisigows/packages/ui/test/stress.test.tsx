import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

import * as UiExports from '../src/index';
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

describe('Adversarial Stress Test Suite: @darksafe/ui', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  // =========================================================================
  // 1. Package Exports & API Surface Stress
  // =========================================================================
  describe('1. Package Exports & API Surface Stress', () => {
    it('exports all 11 required UI primitives and theme utilities', () => {
      const requiredExports = [
        'Button',
        'Modal',
        'Card',
        'Badge',
        'ThresholdBadge',
        'Input',
        'Table',
        'TableHeader',
        'TableBody',
        'TableRow',
        'TableHead',
        'TableCell',
        'TableEmpty',
        'SkeletonLoader',
        'ThresholdProgressBar',
        'AddressAvatar',
        'CopyButton',
        'Dropdown',
        'themeTokens',
        'cn',
        'formatAddress',
        'formatAmount',
        'formatCurrency',
      ];

      for (const exportName of requiredExports) {
        expect(
          (UiExports as Record<string, unknown>)[exportName],
          `Missing required export: ${exportName}`
        ).toBeDefined();
      }
    });

    it('validates themeTokens structure and immutable constants', () => {
      expect(themeTokens.colors.primary.DEFAULT).toBe('#10b981');
      expect(themeTokens.colors.surfaces.background).toBe('#0b0f17');
      expect(themeTokens.colors.surfaces.card).toBe('#121926');
      expect(themeTokens.radii.full).toBe('9999px');
      expect(themeTokens.typography.fontFamily.mono).toContain('JetBrains Mono');
    });

    it('stress-tests cn() helper with falsy, null, and conflicting Tailwind classes', () => {
      expect(cn()).toBe('');
      expect(cn('', null, undefined, false)).toBe('');
      expect(cn('p-4', false && 'p-8', null, 'p-2')).toBe('p-2');
      expect(cn('bg-red-500 bg-emerald-500 text-white')).toBe('bg-emerald-500 text-white');
      expect(cn(['px-4 py-2', ['text-sm font-bold', { 'border-slate-800': true }]])).toContain(
        'border-slate-800'
      );
    });

    it('stress-tests formatAddress() with edge-case and boundary inputs', () => {
      expect(formatAddress('')).toBe('');
      expect(formatAddress(null)).toBe('');
      expect(formatAddress(undefined)).toBe('');
      expect(formatAddress('0x')).toBe('0x');
      expect(formatAddress('0x00')).toBe('0x00');
      expect(formatAddress('0x0060d4bca03f88fdf2b8fa58f0')).toBe('0x0060...58f0');
      // Custom prefix/suffix lengths
      expect(formatAddress('0x0060d4bca03f88fdf2b8fa58f0', 8, 6)).toBe('0x0060d4...fa58f0');
      // String shorter than prefix + suffix
      expect(formatAddress('0x0060', 6, 4)).toBe('0x0060');
      // 1000 character address string
      const longAddr = '0x' + 'a'.repeat(998);
      const formatted = formatAddress(longAddr, 6, 4);
      expect(formatted).toBe('0xaaaa...aaaa');
      expect(formatted.length).toBe(13); // 6 + 3 + 4
    });

    it('stress-tests formatAmount() with extreme and invalid inputs', () => {
      expect(formatAmount(0)).toBe('0.00');
      expect(formatAmount('0')).toBe('0.00');
      // In JS toLocaleString, -0 evaluates with negative sign: -0.00
      expect(formatAmount(-0)).toBe('-0.00');
      expect(formatAmount(-1250.5)).toBe('-1,250.50');
      expect(formatAmount('')).toBe('0.00');
      expect(formatAmount('invalid')).toBe('0.00');
      expect(formatAmount(null as unknown as number)).toBe('0.00');
      expect(formatAmount(undefined as unknown as number)).toBe('0.00');
      expect(formatAmount(BigInt('1000000000000000000'))).toBe('1,000,000,000,000,000,000.00');
      expect(formatAmount(0.00001234, 8, 4)).toBe('0.00001234');
      expect(formatAmount(999999999.9999, 4, 2)).toBe('999,999,999.9999');
      expect(formatAmount(999999999.9999, 2, 2)).toBe('1,000,000,000.00');
    });

    it('stress-tests formatCurrency() with zero, negative, and extreme values', () => {
      expect(formatCurrency(0)).toBe('$0.00');
      expect(formatCurrency('0')).toBe('$0.00');
      expect(formatCurrency(-2348.43)).toBe('-$2,348.43');
      expect(formatCurrency(2348.43)).toBe('$2,348.43');
      expect(formatCurrency(1000000)).toBe('$1,000,000.00');
      expect(formatCurrency('not-a-number')).toBe('$0.00');
      expect(formatCurrency(1e9)).toBe('$1,000,000,000.00');
    });
  });

  // =========================================================================
  // 2. UI Component Edge Cases & Extreme Inputs
  // =========================================================================
  describe('2. UI Component Edge Cases & Extreme Inputs', () => {
    describe('Button', () => {
      it('handles rapid 100-click spam and respects disabled/loading state', () => {
        const handleClick = vi.fn();
        const { rerender } = render(<Button onClick={handleClick}>Click Me</Button>);
        const btn = screen.getByRole('button');

        // Active state: 10 clicks
        for (let i = 0; i < 10; i++) {
          fireEvent.click(btn);
        }
        expect(handleClick).toHaveBeenCalledTimes(10);

        // Disabled state: 50 clicks should NOT fire handler
        rerender(
          <Button disabled onClick={handleClick}>
            Click Me
          </Button>
        );
        for (let i = 0; i < 50; i++) {
          fireEvent.click(btn);
        }
        expect(handleClick).toHaveBeenCalledTimes(10);

        // Loading state: 50 clicks should NOT fire handler
        rerender(
          <Button isLoading onClick={handleClick}>
            Click Me
          </Button>
        );
        for (let i = 0; i < 50; i++) {
          fireEvent.click(btn);
        }
        expect(handleClick).toHaveBeenCalledTimes(10);
      });

      it('renders without children (empty button or icon-only)', () => {
        render(<Button size="icon" aria-label="Icon Only" />);
        expect(screen.getByRole('button', { name: /icon only/i })).toBeInTheDocument();
      });

      it('renders extremely long overflowing text without crashing', () => {
        const longText = 'A'.repeat(500);
        render(<Button>{longText}</Button>);
        expect(screen.getByRole('button')).toHaveTextContent(longText);
      });
    });

    describe('Modal', () => {
      it('handles rapid open/close toggle transitions cleanly', () => {
        const handleClose = vi.fn();
        const { rerender } = render(
          <Modal isOpen={false} onClose={handleClose} title="Toggle Modal">
            Body Content
          </Modal>
        );

        for (let i = 0; i < 10; i++) {
          rerender(
            <Modal isOpen={i % 2 === 1} onClose={handleClose} title="Toggle Modal">
              Iteration {i}
            </Modal>
          );
        }

        // When open, dialog is present and body overflow is hidden
        rerender(
          <Modal isOpen={true} onClose={handleClose} title="Toggle Modal">
            Open State
          </Modal>
        );
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(document.body.style.overflow).toBe('hidden');

        // When closed, body overflow is restored immediately
        rerender(
          <Modal isOpen={false} onClose={handleClose} title="Toggle Modal">
            Closed State
          </Modal>
        );
        expect(document.body.style.overflow).toBe('');
      });

      it('respects closeOnEsc=false and closeOnBackdropClick=false', () => {
        const handleClose = vi.fn();
        render(
          <Modal
            isOpen={true}
            onClose={handleClose}
            closeOnEsc={false}
            closeOnBackdropClick={false}
            title="Non-Closable by Backdrop/Esc"
          >
            Modal Content
          </Modal>
        );

        // Press Escape
        fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
        expect(handleClose).not.toHaveBeenCalled();

        // Backdrop click (the aria-hidden overlay)
        const backdrop = document.querySelector('.bg-black\\/80');
        if (backdrop) {
          fireEvent.click(backdrop);
        }
        expect(handleClose).not.toHaveBeenCalled();
      });
    });

    describe('Card', () => {
      it('renders gracefully with zero optional props', () => {
        render(<Card>Card Content</Card>);
        expect(screen.getByText('Card Content')).toBeInTheDocument();
      });

      it('handles all 4 variants and 4 padding configurations', () => {
        const variants = ['default', 'elevated', 'outlined', 'interactive'] as const;
        const paddings = ['none', 'sm', 'md', 'lg'] as const;

        for (const variant of variants) {
          for (const padding of paddings) {
            const { unmount } = render(
              <Card variant={variant} padding={padding} data-testid={`card-${variant}-${padding}`}>
                Content
              </Card>
            );
            expect(screen.getByTestId(`card-${variant}-${padding}`)).toBeInTheDocument();
            unmount();
          }
        }
      });
    });

    describe('Input', () => {
      it('handles empty strings, 10,000-char strings, and XSS payload strings safely', () => {
        const handleChange = vi.fn();
        const { rerender } = render(<Input value="" onChange={handleChange} />);
        const input = screen.getByRole('textbox') as HTMLInputElement;
        expect(input.value).toBe('');

        // 10,000 characters
        const hugeString = '0x00' + 'f'.repeat(9996);
        rerender(<Input isAddress value={hugeString} onChange={handleChange} />);
        expect(input.value.length).toBe(10000);

        // XSS attempt string
        const xss = '<script>alert("xss")</script><img src="x" onerror="alert(1)"/>';
        rerender(<Input value={xss} onChange={handleChange} />);
        expect(input.value).toBe(xss);
      });

      it('enforces Cyprus-1 zone prefix detection dynamically on input', () => {
        const { rerender } = render(
          <Input isAddress label="Recipient" value="0x12345678901234567890" readOnly />
        );
        expect(screen.getByText(/Notice: Cyprus-1 zone addresses must begin with 0x00/i)).toBeInTheDocument();

        // Valid Cyprus-1 address removes notice
        rerender(
          <Input isAddress label="Recipient" value="0x0060d4bca03f88fdf2b8fa58f0000000000000001" readOnly />
        );
        expect(screen.queryByText(/Notice: Cyprus-1 zone addresses must begin with 0x00/i)).not.toBeInTheDocument();

        // Very short prefix (< 4 chars) does not prematurely warn
        rerender(<Input isAddress label="Recipient" value="0x0" readOnly />);
        expect(screen.queryByText(/Notice: Cyprus-1 zone addresses must begin with 0x00/i)).not.toBeInTheDocument();
      });
    });

    describe('Badge & ThresholdBadge', () => {
      it('handles boundary numbers in ThresholdBadge (0/0, 100/100, threshold > total)', () => {
        const { rerender } = render(<ThresholdBadge threshold={0} totalOwners={0} />);
        expect(screen.getByText('0/0 Threshold')).toBeInTheDocument();

        rerender(<ThresholdBadge threshold={100} totalOwners={100} currentSigners={99} />);
        expect(screen.getByText('100/100 Threshold')).toBeInTheDocument();

        // Current signers satisfied
        rerender(<ThresholdBadge threshold={4} totalOwners={7} currentSigners={4} />);
        expect(screen.getByText('4/7 Threshold')).toBeInTheDocument();

        // Current signers exceeded (> threshold)
        rerender(<ThresholdBadge threshold={4} totalOwners={7} currentSigners={6} />);
        expect(screen.getByText('4/7 Threshold')).toBeInTheDocument();
      });
    });

    describe('Table', () => {
      it('renders 100 rows smoothly in tabular structure', () => {
        const rows = Array.from({ length: 100 }, (_, i) => ({
          id: `tx-${i}`,
          asset: `TOKEN-${i}`,
          amount: `${(i + 1) * 10}.00`,
        }));

        render(
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Asset</TableHead>
                <TableHead>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.asset}</TableCell>
                  <TableCell>{r.amount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        );

        expect(screen.getByText('TOKEN-0')).toBeInTheDocument();
        expect(screen.getByText('TOKEN-99')).toBeInTheDocument();
      });
    });

    describe('SkeletonLoader', () => {
      it('handles count=0, count=1, and count=20 safely', () => {
        const { rerender } = render(<SkeletonLoader count={0} data-testid="skel-0" />);
        // count 0 returns wrapper with 0 items
        expect(screen.getByRole('status')).toBeInTheDocument();

        rerender(<SkeletonLoader count={1} data-testid="skel-1" />);
        expect(screen.getByRole('status')).toBeInTheDocument();

        rerender(<SkeletonLoader count={20} data-testid="skel-20" />);
        const multi = screen.getByRole('status', { name: /loading multiple items/i });
        expect(multi.children.length).toBe(20);
      });
    });

    describe('Dropdown', () => {
      it('handles empty items array without crashing', () => {
        render(<Dropdown trigger={<button>Menu</button>} items={[]} />);
        fireEvent.click(screen.getByText('Menu'));
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });

      it('does not select or close when clicking disabled item', () => {
        const handleSelect = vi.fn();
        const items = [
          { id: '1', label: 'Disabled Option', disabled: true },
          { id: '2', label: 'Active Option' },
        ];
        render(
          <Dropdown
            trigger={<button>Trigger</button>}
            items={items}
            onSelect={handleSelect}
          />
        );

        fireEvent.click(screen.getByText('Trigger'));
        const disabledBtn = screen.getByText('Disabled Option').closest('button');
        expect(disabledBtn).toBeDisabled();

        fireEvent.click(disabledBtn!);
        expect(handleSelect).not.toHaveBeenCalled();
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
    });

    describe('CopyButton', () => {
      it('does not trigger clipboard copy when text is empty or button disabled', async () => {
        const writeText = vi.fn();
        Object.assign(navigator, { clipboard: { writeText } });

        render(<CopyButton text="" label="Copy Empty" />);
        fireEvent.click(screen.getByRole('button'));
        expect(writeText).not.toHaveBeenCalled();

        const { rerender } = render(
          <CopyButton disabled text="0x0060..." label="Copy Disabled" />
        );
        fireEvent.click(screen.getByRole('button', { name: /copy disabled/i }));
        expect(writeText).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // 3. AddressAvatar Stress: Valid 0x00... Cyprus-1 vs Arbitrary Inputs
  // =========================================================================
  describe('3. AddressAvatar Stress: Valid 0x00... Cyprus-1 vs Arbitrary Inputs', () => {
    it('renders emerald shard badge on valid 0x00 Cyprus-1 addresses', () => {
      const validCyprus1Addresses = [
        '0x0060d4bca03f88fdf2b8fa58f0000000000000001',
        '0x0000000000000000000000000000000000000000',
        '0x00a1b2c3d4e5f60718293a4b5c6d7e8f90123456',
        '0x0060D4bcA03F88FDf2B8fA58F000000000000001', // mixed case
      ];

      for (const addr of validCyprus1Addresses) {
        const { unmount } = render(<AddressAvatar address={addr} data-testid="cyprus1-avatar" />);
        const avatar = screen.getByTestId('cyprus1-avatar');
        expect(avatar).toBeInTheDocument();
        expect(avatar.querySelector('svg')).toBeInTheDocument();

        // Shard indicator badge MUST be present for Cyprus-1
        const badge = avatar.querySelector('span[title="Quai Network Cyprus-1 (0x00)"]');
        expect(badge, `Expected emerald Cyprus-1 badge for ${addr}`).not.toBeNull();
        expect(badge).toHaveClass('bg-emerald-500');
        unmount();
      }
    });

    it('does NOT render emerald shard badge on non-Cyprus-1 addresses', () => {
      const nonCyprus1Addresses = [
        '0x1234567890123456789012345678901234567890', // Ethereum address
        '0x0160d4bca03f88fdf2b8fa58f0000000000000001', // Cyprus-2 (0x01)
        '0x0260d4bca03f88fdf2b8fa58f0000000000000001', // Cyprus-3 (0x02)
        '0x9060d4bca03f88fdf2b8fa58f0',                 // Mockup address
        'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',   // Bitcoin address
      ];

      for (const addr of nonCyprus1Addresses) {
        const { unmount } = render(<AddressAvatar address={addr} data-testid="non-cyprus1" />);
        const avatar = screen.getByTestId('non-cyprus1');
        const badge = avatar.querySelector('span[title="Quai Network Cyprus-1 (0x00)"]');
        expect(badge, `Did not expect Cyprus-1 badge for ${addr}`).toBeNull();
        unmount();
      }
    });

    it('handles arbitrary, extreme, and malformed address strings without throwing', () => {
      const hostileInputs = [
        '',
        '   ',
        '!@#$%^&*()_+=-~`',
        'hello world',
        'not_an_address',
        '0x',
        '1234567890',
        '🚀🔥💎 DarkSafe',
        '<script>alert(1)</script>',
        'a'.repeat(5000), // 5000 characters
      ];

      for (const input of hostileInputs) {
        const { unmount } = render(<AddressAvatar address={input} data-testid="hostile-avatar" />);
        const el = screen.getByTestId('hostile-avatar');
        expect(el).toBeInTheDocument();
        expect(el.querySelector('svg')).toBeInTheDocument();
        unmount();
      }
    });

    it('suppresses badge when showBadge=false even for valid Cyprus-1 address', () => {
      render(
        <AddressAvatar
          address="0x0060d4bca03f88fdf2b8fa58f0000000000000001"
          showBadge={false}
          data-testid="no-badge-avatar"
        />
      );
      const avatar = screen.getByTestId('no-badge-avatar');
      const badge = avatar.querySelector('span[title="Quai Network Cyprus-1 (0x00)"]');
      expect(badge).toBeNull();
    });

    it('maintains visual determinism: identical address produces identical SVG identicon', () => {
      const addr = '0x0060d4bca03f88fdf2b8fa58f0000000000000001';
      const { unmount: u1 } = render(<AddressAvatar address={addr} data-testid="a1" />);
      const svg1 = screen.getByTestId('a1').querySelector('svg')?.innerHTML;
      u1();

      const { unmount: u2 } = render(<AddressAvatar address={addr} data-testid="a2" />);
      const svg2 = screen.getByTestId('a2').querySelector('svg')?.innerHTML;
      u2();

      expect(svg1).toBe(svg2);
    });

    it('rapidly re-renders 100 times with varied addresses without memory/DOM corruption', () => {
      const { rerender } = render(
        <AddressAvatar address="0x0011" data-testid="rapid-avatar" />
      );

      for (let i = 0; i < 100; i++) {
        const addr = i % 2 === 0 ? `0x00${i.toString(16).padStart(4, '0')}` : `0x11${i}`;
        rerender(<AddressAvatar address={addr} data-testid="rapid-avatar" />);
        const el = screen.getByTestId('rapid-avatar');
        expect(el.querySelector('svg')).toBeInTheDocument();
      }
    });
  });

  // =========================================================================
  // 4. ThresholdProgressBar Consensus Boundary Stress
  // =========================================================================
  describe('4. ThresholdProgressBar Consensus Boundary Stress', () => {
    it('tests 0% threshold state (0 / 4 signatures gathered)', () => {
      render(
        <ThresholdProgressBar
          current={0}
          threshold={4}
          total={7}
          showLabel
          showRatio
        />
      );
      expect(screen.getByText(/needs 4 more signatures/i)).toBeInTheDocument();
      expect(screen.getByText('(7 owners)')).toBeInTheDocument();
      const progressbar = screen.getByRole('progressbar');
      expect(progressbar).toHaveAttribute('aria-valuenow', '0');
      expect(progressbar).toHaveAttribute('aria-valuemax', '4');

      // Check fill bar percentage
      const fillBar = progressbar.querySelector('div.h-full');
      expect(fillBar).toHaveStyle({ width: '0%' });
      expect(fillBar).toHaveClass('from-amber-500');
    });

    it('tests 50% threshold state (2 / 4 signatures gathered)', () => {
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
      const progressbar = screen.getByRole('progressbar');
      expect(progressbar).toHaveAttribute('aria-valuenow', '2');

      const fillBar = progressbar.querySelector('div.h-full');
      expect(fillBar).toHaveStyle({ width: '50%' });
      expect(fillBar).toHaveClass('from-amber-500');
    });

    it('tests 100% threshold state (4 / 4 signatures gathered -> Ready to Execute)', () => {
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
      const progressbar = screen.getByRole('progressbar');
      expect(progressbar).toHaveAttribute('aria-valuenow', '4');

      const fillBar = progressbar.querySelector('div.h-full');
      expect(fillBar).toHaveStyle({ width: '100%' });
      expect(fillBar).toHaveClass('from-emerald-500');
    });

    it('tests >100% threshold state (6 / 4 signatures gathered -> clamped to 100%)', () => {
      render(
        <ThresholdProgressBar
          current={6}
          threshold={4}
          total={7}
          showLabel
          showRatio
        />
      );
      expect(screen.getByText(/ready to execute/i)).toBeInTheDocument();
      const progressbar = screen.getByRole('progressbar');
      expect(progressbar).toHaveAttribute('aria-valuenow', '6');

      const fillBar = progressbar.querySelector('div.h-full');
      // Must NOT overflow beyond 100%
      expect(fillBar).toHaveStyle({ width: '100%' });
      expect(fillBar).toHaveClass('from-emerald-500');
    });

    it('tests boundary and corner threshold configurations', () => {
      // Threshold 0 clamped to 1
      const { rerender } = render(
        <ThresholdProgressBar current={0} threshold={0} />
      );
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '1');

      // Negative current clamped to 0
      rerender(<ThresholdProgressBar current={-5} threshold={3} />);
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');

      // Threshold = 1 (single-sig multi-sig edge)
      rerender(<ThresholdProgressBar current={1} threshold={1} />);
      expect(screen.getByText(/ready to execute/i)).toBeInTheDocument();

      // Large threshold (> 10): checkpoint ticks should be skipped to prevent DOM flood
      rerender(<ThresholdProgressBar current={25} threshold={50} total={100} />);
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '50');
      const ticks = document.querySelectorAll('.bg-slate-900\\/60');
      expect(ticks.length).toBe(0); // skipped when threshold > 10
    });
  });
});
