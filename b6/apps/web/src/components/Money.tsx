import React, { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { explorerAddressUrl, formatQuai, formatUsd, quaiToUsd, shortAddress } from '@darkquestate/core';
import { cx } from '@darkquestate/ui';
import { useUsdQuote } from '../state/PriceContext.js';
import { useNetwork } from '../state/NetworkContext.js';

/** A QUAI amount, with its dollar value underneath when a price is available. */
export const Quai: React.FC<{ wei: bigint; size?: 'sm' | 'md' | 'lg' | 'xl'; usd?: boolean; className?: string }> = ({ wei, size = 'md', usd = true, className }) => {
  const quote = useUsdQuote();
  const dollars = usd ? quaiToUsd(wei, quote?.usdPerQuai ?? null) : null;
  const sizes = { sm: 'text-sm', md: 'text-base', lg: 'text-2xl', xl: 'text-4xl' } as const;
  return (
    <span className={cx('inline-flex flex-col', className)}>
      <span className={cx('font-display tabular-nums text-bone', sizes[size])}>
        {formatQuai(wei, size === 'sm' ? 2 : 4)} <span className="text-[0.6em] tracking-widest text-gold">QUAI</span>
      </span>
      {dollars !== null && (
        <span className="text-xs text-bone-mute" title={`At ${quote!.usdPerQuai} USD per QUAI (${quote!.source}), for reference only`}>
          ≈ {formatUsd(dollars)}
        </span>
      )}
    </span>
  );
};

/** An address: shortened, copyable, linked to the explorer when the network has one. */
export const AddressTag: React.FC<{ address: string; label?: string; className?: string; sample?: boolean }> = ({ address, label, className, sample = false }) => {
  const { network } = useNetwork();
  const [copied, setCopied] = useState(false);
  const url = sample ? null : explorerAddressUrl(network, address);
  const copy = () => {
    navigator.clipboard?.writeText(address).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined
    );
  };
  return (
    <span className={cx('inline-flex items-center gap-1.5 font-mono text-xs text-bone-dim', className)} title={address}>
      {label && <span className="font-sans text-bone">{label}</span>}
      <span>{shortAddress(address)}</span>
      <button type="button" onClick={copy} className="rounded p-0.5 text-bone-mute hover:text-bone" aria-label="Copy address">
        {copied ? <Check className="h-3 w-3 text-emerald-300" /> : <Copy className="h-3 w-3" />}
      </button>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="rounded p-0.5 text-bone-mute hover:text-gold" aria-label="View on explorer">
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </span>
  );
};
