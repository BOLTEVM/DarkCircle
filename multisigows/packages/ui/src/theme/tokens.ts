import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Utility function to merge Tailwind CSS class names with conflict resolution.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Safe{Wallet} canonical dark theme color tokens and design system constants.
 * Combines deep obsidian/slate backgrounds with high-contrast emerald accents.
 */
export const themeTokens = {
  colors: {
    // Brand & Primary Accents (Safe Emerald)
    primary: {
      DEFAULT: '#10b981', // emerald-500
      hover: '#059669',   // emerald-600
      light: '#34d399',   // emerald-400
      dark: '#047857',    // emerald-700
      subtle: 'rgba(16, 185, 129, 0.12)',
      glow: 'rgba(16, 185, 129, 0.25)',
      ring: 'rgba(16, 185, 129, 0.4)',
    },
    // Backgrounds & Surfaces (Obsidian & Deep Slate)
    surfaces: {
      background: '#0b0f17',       // Root body canvas
      sidebar: '#080b11',          // Left sidebar panel
      card: '#121926',             // Standard surface container (slate-900)
      cardElevated: '#162032',     // Elevated modal / floating panel
      cardHover: '#1a253a',        // Interactive hover surface
      input: '#0d131f',            // Input field background
      tableHeader: '#0d131f',      // Table header background
      tableRowHover: 'rgba(26, 37, 58, 0.4)',
    },
    // Borders & Dividers
    borders: {
      subtle: '#1e293b',   // slate-800
      default: '#263449',  // slate-700/800
      hover: '#334155',    // slate-700
      active: '#10b981',   // emerald border for selected/active
      danger: '#f43f5e',   // rose-500
    },
    // Typography & Content Colors
    text: {
      primary: '#f8fafc',    // slate-50 (high contrast)
      secondary: '#94a3b8',  // slate-400 (supporting text)
      muted: '#64748b',      // slate-500 (labels, captions)
      inverse: '#0b0f17',    // for badges/buttons with light background
      emerald: '#34d399',    // emerald-400
      amber: '#fbbf24',      // amber-400
      rose: '#fb7185',       // rose-400
    },
    // Status Badges & Alerts
    status: {
      success: {
        bg: 'rgba(16, 185, 129, 0.15)',
        text: '#34d399',
        border: 'rgba(16, 185, 129, 0.3)',
      },
      warning: {
        bg: 'rgba(245, 158, 11, 0.15)',
        text: '#fbbf24',
        border: 'rgba(245, 158, 11, 0.3)',
      },
      danger: {
        bg: 'rgba(244, 63, 94, 0.15)',
        text: '#fb7185',
        border: 'rgba(244, 63, 94, 0.3)',
      },
      info: {
        bg: 'rgba(6, 182, 212, 0.15)',
        text: '#38bdf8',
        border: 'rgba(6, 182, 212, 0.3)',
      },
      neutral: {
        bg: 'rgba(100, 116, 139, 0.15)',
        text: '#94a3b8',
        border: 'rgba(100, 116, 139, 0.3)',
      },
    },
  },
  shadows: {
    card: '0 4px 20px -2px rgba(0, 0, 0, 0.5)',
    cardHover: '0 8px 30px -4px rgba(0, 0, 0, 0.65)',
    modal: '0 25px 50px -12px rgba(0, 0, 0, 0.75)',
    emeraldGlow: '0 0 15px rgba(16, 185, 129, 0.35)',
    dropdown: '0 10px 25px -5px rgba(0, 0, 0, 0.6), 0 8px 10px -6px rgba(0, 0, 0, 0.6)',
  },
  radii: {
    sm: '0.375rem', // 6px
    md: '0.5rem',   // 8px
    lg: '0.75rem',  // 12px
    xl: '1rem',     // 16px
    full: '9999px',
  },
  typography: {
    fontFamily: {
      sans: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      mono: "'JetBrains Mono', 'Fira Code', Menlo, monospace",
    },
  },
} as const;

/**
 * Format a hexadecimal address for compact UI display (e.g. 0x0060...58f0)
 */
export function formatAddress(address?: string | null, prefixLen = 6, suffixLen = 4): string {
  if (!address) return '';
  if (address.length <= prefixLen + suffixLen) return address;
  return `${address.slice(0, prefixLen)}...${address.slice(-suffixLen)}`;
}

/**
 * Format a numeric balance with standard decimal precision.
 */
export function formatAmount(
  value: number | string | bigint,
  maxDecimals = 4,
  minDecimals = 2
): string {
  if (value === undefined || value === null || value === '') return '0.00';
  const num = typeof value === 'bigint' ? Number(value) : Number(value);
  if (isNaN(num)) return '0.00';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: maxDecimals,
  });
}

/**
 * Format a fiat currency value (e.g. $1,250.00).
 */
export function formatCurrency(value: number | string, currency = 'USD'): string {
  const num = Number(value);
  if (isNaN(num)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(num);
}
