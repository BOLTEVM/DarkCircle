import React, { useState } from 'react';
import { AlertTriangle, ChevronDown, Info, Menu, Wallet, X } from 'lucide-react';
import { sameAddress, shortAddress, type NetworkName } from '@darkorder/core';
import { ASSET_BASE } from '../lib/env.js';
import { href, type Route } from '../lib/router.js';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { BrandLockup, PoweredByBolt } from './Brand.js';
import { Button, cx } from './primitives.js';

const NAV: { route: Route; label: string; match: Route['name'][] }[] = [
  { route: { name: 'home' }, label: 'Halls', match: ['home', 'guild', 'proposal', 'mint'] },
  { route: { name: 'found' }, label: 'Found a Guild', match: ['found'] },
  { route: { name: 'voice' }, label: 'Voice Agent', match: ['voice'] },
  { route: { name: 'tribute' }, label: 'Tribute · x402', match: ['tribute'] },
];

const NetworkSelect: React.FC = () => {
  const { network, networks, setNetwork } = useNetwork();
  return (
    <label className="relative inline-flex items-center">
      <span className="sr-only">Network</span>
      <select
        value={network.name}
        onChange={(e) => setNetwork(e.target.value as NetworkName)}
        className="h-9 appearance-none rounded-lg border border-line bg-ink-deep pl-3 pr-8 text-xs text-bone-dim hover:border-line-strong focus:border-gold/60 focus:outline-none"
      >
        {networks.map((n) => (
          <option key={n.name} value={n.name}>
            {n.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-bone-mute" aria-hidden />
    </label>
  );
};

const WalletButton: React.FC = () => {
  const { wallet, address, connect, disconnect, connecting, onExpectedChain, dev } = useWallet();
  if (dev) {
    return (
      <label className="relative inline-flex items-center">
        <span className="sr-only">Dev account</span>
        <select
          value={dev.accounts.find((a) => sameAddress(a, address)) ?? ''}
          onChange={(e) => dev.select(e.target.value)}
          className="h-9 max-w-[8.5rem] appearance-none rounded-lg border border-amber-400/40 bg-amber-400/10 pl-3 pr-8 font-mono text-xs text-amber-200 focus:outline-none sm:max-w-[11rem]"
        >
          <option value="" disabled>
            Dev account…
          </option>
          {dev.accounts.map((a, i) => (
            <option key={a} value={a}>
              #{i} {shortAddress(a)}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-amber-200" aria-hidden />
      </label>
    );
  }
  if (address) {
    return (
      <button
        onClick={disconnect}
        title="Disconnect"
        className={cx(
          'inline-flex h-9 items-center gap-2 rounded-lg border px-2.5 font-mono text-xs sm:px-3',
          onExpectedChain ? 'border-line bg-ink-deep text-bone-dim hover:border-line-strong' : 'border-amber-400/40 bg-amber-400/10 text-amber-200'
        )}
      >
        <span className={cx('h-1.5 w-1.5 rounded-full', onExpectedChain ? 'bg-emerald-400' : 'bg-amber-400')} aria-hidden />
        {shortAddress(address)}
      </button>
    );
  }
  return (
    <Button size="sm" onClick={connect} loading={connecting} className="h-9" title={wallet ? `Connect ${wallet.name}` : 'Install Pelagus to connect'}>
      <Wallet className="h-3.5 w-3.5" aria-hidden />
      Connect<span className="hidden sm:inline">{wallet ? '' : ' wallet'}</span>
    </Button>
  );
};

export const Header: React.FC<{ route: Route }> = ({ route }) => {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-ink/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 lg:px-8">
        <a href={href({ name: 'home' })} aria-label="DarkOrder home" className="shrink-0">
          <BrandLockup assetBase={ASSET_BASE} size="sm" className="sm:hidden" />
          <BrandLockup assetBase={ASSET_BASE} className="hidden sm:inline-flex" />
        </a>
        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {NAV.map((n) => {
            const active = n.match.includes(route.name);
            return (
              <a
                key={n.label}
                href={href(n.route)}
                aria-current={active ? 'page' : undefined}
                className={cx('rounded-md px-3 py-2 text-sm transition-colors', active ? 'text-gold' : 'text-bone-dim hover:text-bone')}
              >
                {n.label}
              </a>
            );
          })}
        </nav>
        <div className="flex min-w-0 items-center gap-2">
          <div className="hidden sm:block">
            <NetworkSelect />
          </div>
          <WalletButton />
          <button className="shrink-0 rounded-md p-1.5 text-bone-dim hover:text-bone md:hidden" onClick={() => setOpen((o) => !o)} aria-label="Menu" aria-expanded={open}>
            {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </div>
      {open && (
        <div className="border-t border-line px-4 pb-4 md:hidden">
          <nav className="flex flex-col py-2" aria-label="Main">
            {NAV.map((n) => (
              <a key={n.label} href={href(n.route)} onClick={() => setOpen(false)} className="rounded-md px-2 py-2.5 text-sm text-bone-dim hover:text-bone">
                {n.label}
              </a>
            ))}
          </nav>
          <NetworkSelect />
        </div>
      )}
    </header>
  );
};

/** Site-wide truths a visitor must not miss: showcase mode, a dead RPC, a wallet on the wrong chain. */
export const StatusBanner: React.FC = () => {
  const { network, rpcError, deployment } = useNetwork();
  const { address, chainId, onExpectedChain, addressProblem, wallet } = useWallet();
  const items: { tone: 'gold' | 'warn' | 'danger'; icon: React.ReactNode; text: React.ReactNode }[] = [];

  if (!deployment) {
    items.push({
      tone: 'gold',
      icon: <Info className="h-4 w-4" />,
      text: (
        <>
          <strong className="font-semibold">Showcase.</strong> The DarkOrder protocol is not deployed on {network.label} yet. The halls below are invented
          samples and every transaction is switched off.
        </>
      ),
    });
  }
  if (rpcError) {
    items.push({ tone: 'warn', icon: <AlertTriangle className="h-4 w-4" />, text: <>The {network.label} RPC is not answering ({rpcError}). Data may be stale.</> });
  }
  if (address && addressProblem) items.push({ tone: 'danger', icon: <AlertTriangle className="h-4 w-4" />, text: addressProblem });
  if (address && chainId !== null && !onExpectedChain) {
    items.push({
      tone: 'warn',
      icon: <AlertTriangle className="h-4 w-4" />,
      text: `${wallet?.name ?? 'Your wallet'} is on chain ${chainId}; this page is set to ${network.label} (chain ${network.chainId}). Switch one of them before sending anything.`,
    });
  }
  if (!items.length) return null;
  const tones = {
    gold: 'border-gold/25 bg-gold/[0.06] text-gold-pale',
    warn: 'border-amber-400/25 bg-amber-400/[0.07] text-amber-100',
    danger: 'border-rose-400/25 bg-rose-400/[0.07] text-rose-100',
  } as const;
  return (
    <div className="border-b border-line">
      {items.map((it, i) => (
        <div key={i} className={cx('border-b px-4 py-2.5 text-sm last:border-b-0', tones[it.tone])} role={it.tone === 'danger' ? 'alert' : 'status'}>
          <div className="mx-auto flex max-w-7xl items-start gap-2.5 lg:px-4">
            <span className="mt-0.5 shrink-0">{it.icon}</span>
            <span className="leading-relaxed">{it.text}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

export const Footer: React.FC = () => {
  const { network, blockNumber } = useNetwork();
  return (
    <footer className="mt-20 border-t border-line bg-ink-deep">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 md:grid-cols-[1.4fr_1fr_1fr] lg:px-8">
        <div className="space-y-4">
          <BrandLockup assetBase={ASSET_BASE} size="sm" />
          <p className="max-w-md text-xs leading-relaxed text-bone-mute">
            DarkOrder is governance machinery, not a company or a court. A guild's power is exactly what its contracts enforce on Cyprus-1 — nothing more is
            promised. Identity names point at quaidomains.com (QNS); the contracts have not had an independent security audit.
          </p>
        </div>
        <div className="space-y-2 text-sm">
          <div className="text-[11px] uppercase tracking-[0.16em] text-bone-mute">The Order</div>
          {NAV.map((n) => (
            <a key={n.label} href={href(n.route)} className="block text-bone-dim hover:text-gold">
              {n.label}
            </a>
          ))}
        </div>
        <div className="space-y-2 text-sm">
          <div className="text-[11px] uppercase tracking-[0.16em] text-bone-mute">Chain</div>
          <div className="text-bone-dim">{network.label}</div>
          <div className="font-mono text-xs text-bone-mute">
            chain {network.chainId} · {blockNumber !== null ? `block #${blockNumber.toLocaleString('en-US')}` : 'connecting…'}
          </div>
          <a href="https://www.quaidomains.com" target="_blank" rel="noopener noreferrer" className="block text-bone-dim hover:text-gold">
            QNS · quaidomains.com
          </a>
        </div>
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 py-5 text-[11px] text-bone-mute sm:flex-row lg:px-8">
          <span>© {new Date().getFullYear()} DarkOrder · DarkCircle suite</span>
          <PoweredByBolt assetBase={ASSET_BASE} />
        </div>
      </div>
    </footer>
  );
};
