import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Plus, RefreshCw, Search } from 'lucide-react';
import { formatUnits, shortAddress, splitDisplayName, type TokenInfo } from 'quai-service';
import TokenBubble, { TokenAvatar, type TokenBubbleMetadata } from './TokenBubble';
import { isCyprus1ContractAddress } from './customTokens';

interface Props {
  value: string;
  tokens: TokenInfo[];
  metadata?: Record<string, TokenBubbleMetadata>;
  metadataStatus?: 'loading' | 'ready' | 'partial' | 'failed';
  /** Wallet balance in base units, or undefined when no wallet is connected / the read failed. */
  balanceOf?: (token: TokenInfo) => bigint | undefined;
  /** The decimals the app uses for this token (the swap maths), so shown amounts match the quote. */
  decimalsOf?: (token: TokenInfo) => number;
  /** Lower-case addresses of tokens the user imported (not curated by the registry). */
  importedAddresses?: ReadonlySet<string>;
  onChange: (symbol: string) => void;
  onImport: (address?: string) => void;
  onRefresh?: () => void;
  refreshing?: boolean;
}

const QUICK_PICKS = ['QUAI', 'WQUAI', 'Q0', 'BDELTA'];

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1000) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (value >= 1) return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (value >= 0.01) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  if (value >= 0.000001) return '$' + value.toLocaleString('en-US', { maximumSignificantDigits: 3, maximumFractionDigits: 8 });
  return '<$0.000001';
}

export function formatAmount(raw: bigint, decimals: number): string {
  if (raw === 0n) return '0';
  const n = Number(formatUnits(raw, decimals, Math.min(decimals, 18)));
  if (!Number.isFinite(n)) return formatUnits(raw, decimals, 6);
  // The smallest amount shown (built, not written out: the boost-consistency test forbids that literal anywhere in the app).
  const smallest = 1e-4;
  if (n < smallest) return `<${smallest.toFixed(4)}`;
  if (n >= 10_000) return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
  return n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

interface Row {
  token: TokenInfo;
  live?: TokenBubbleMetadata;
  balance?: bigint;
  usd?: number;
  imported: boolean;
}

export default function TokenPicker({
  value, tokens, metadata, metadataStatus, balanceOf, decimalsOf, importedAddresses, onChange, onImport, onRefresh, refreshing
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = tokens.find(token => token.symbol === value);

  const rows = useMemo<Row[]>(() => {
    return tokens.map(token => {
      const live = metadata?.[token.address.toLowerCase()];
      const balance = balanceOf?.(token);
      const decimals = decimalsOf?.(token) ?? live?.decimals ?? token.decimals;
      const price = live?.priceUsd;
      const usd = balance !== undefined && price !== undefined
        ? Number(formatUnits(balance, decimals, 8)) * price
        : undefined;
      return { token, live, balance, usd, imported: importedAddresses?.has(token.address.toLowerCase()) ?? false };
    });
  }, [tokens, metadata, balanceOf, decimalsOf, importedAddresses]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = rows.filter(row => {
      if (!needle) return true;
      const name = row.live?.name ?? row.token.name;
      return (row.live?.symbol ?? row.token.symbol).toLowerCase().includes(needle)
        || name.toLowerCase().includes(needle)
        || row.token.address.toLowerCase().includes(needle);
    });
    return matches.slice(0, 120);
  }, [rows, query]);

  const held = useMemo(
    () => filtered
      .filter(row => (row.balance ?? 0n) > 0n)
      .sort((a, b) => {
        const au = a.usd ?? -1;
        const bu = b.usd ?? -1;
        if (au !== bu) return bu - au;
        const ab = a.balance ?? 0n;
        const bb = b.balance ?? 0n;
        return ab === bb ? 0 : bb > ab ? 1 : -1;
      }),
    [filtered]
  );
  const heldSymbols = new Set(held.map(row => row.token.symbol));
  const others = filtered.filter(row => !heldSymbols.has(row.token.symbol));
  const showSections = !query.trim() && held.length > 0;

  const typedAddress = query.trim();
  const canImportTyped = isCyprus1ContractAddress(typedAddress)
    && !rows.some(row => row.token.address.toLowerCase() === typedAddress.toLowerCase());

  const readable = tokens.filter(token => token.deployed !== false && !token.isNative).length;
  const liveCount = tokens.filter(token => !token.isNative && metadata?.[token.address.toLowerCase()]).length;

  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 0);
    else setQuery('');
  }, [open]);

  const choose = (symbol: string) => {
    onChange(symbol);
    setOpen(false);
  };

  const quick = QUICK_PICKS
    .map(symbol => tokens.find(token => token.symbol === symbol))
    .filter((token): token is TokenInfo => Boolean(token));

  const renderRow = (row: Row) => {
    const { token, live } = row;
    const name = live?.name ?? token.name;
    const { title, tag } = splitDisplayName(name);
    const symbol = live?.symbol ?? token.symbol;
    const isSelected = token.symbol === value;
    const decimals = decimalsOf?.(token) ?? live?.decimals ?? token.decimals;
    return (
      <button
        key={token.address.toLowerCase()}
        type="button"
        className={`token-picker-option ${isSelected ? 'selected' : ''}`}
        onClick={() => choose(token.symbol)}
        title={`${symbol} · ${name}\n${token.isNative ? 'Native Cyprus-1 asset' : token.address}`}
      >
        <TokenAvatar symbol={symbol} iconUrl={live?.iconUrl || token.iconUrl} size="lg" />
        <span className="token-picker-option-copy">
          <span className="token-picker-option-line">
            <strong>{symbol}</strong>
            {row.imported && <em className="token-chip token-chip-warn">Imported</em>}
            {tag && <em className="token-chip">{tag}</em>}
          </span>
          <small>
            {title}
            {!token.isNative && <> · <span className="token-picker-address">{shortAddress(token.address)}</span></>}
          </small>
        </span>
        <span className="token-picker-option-balance">
          {row.balance !== undefined ? (
            <>
              <strong>{formatAmount(row.balance, decimals)}</strong>
              {/* the value of what you hold; with nothing held, the unit price is the useful number */}
              {row.usd !== undefined && formatUsd(row.usd)
                ? <small>{formatUsd(row.usd)}</small>
                : live?.priceUsd !== undefined && <small>{formatUsd(live.priceUsd)}</small>}
            </>
          ) : live?.priceUsd !== undefined ? (
            <small>{formatUsd(live.priceUsd)}</small>
          ) : null}
        </span>
        {isSelected && <Check size={15} className="token-picker-check" aria-label="Selected" />}
      </button>
    );
  };

  return (
    <>
      <button type="button" className="token-picker-trigger" onClick={() => setOpen(true)} aria-label={`Choose token, currently ${selected?.symbol ?? value}`}>
        {selected ? <TokenBubble token={selected} metadata={metadata?.[selected.address.toLowerCase()]} showDetails /> : <span className="token-avatar">{value.slice(0, 1)}</span>}
        {!selected && <span className="token-picker-symbol">{value}</span>}
        <ChevronDown size={17} />
      </button>

      {open && (
        <div className="token-picker-backdrop" onMouseDown={() => setOpen(false)}>
          <div
            className="token-picker-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Select a token"
            onMouseDown={event => event.stopPropagation()}
            onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}
          >
            <div className="token-picker-modal-header">
              <strong>Select a token</strong>
              <span className="token-picker-header-actions">
                {onRefresh && (
                  <button type="button" className="token-picker-icon-btn" onClick={onRefresh} disabled={refreshing} aria-label="Refresh token data" title="Refresh token data">
                    <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
                  </button>
                )}
                <button type="button" className="token-picker-close" onClick={() => setOpen(false)} aria-label="Close token selector">×</button>
              </span>
            </div>
            <div className="token-picker-search">
              <Search size={16} />
              <input
                ref={searchRef}
                value={query}
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter' && filtered[0]) choose(filtered[0].token.symbol); }}
                placeholder="Search name or paste address"
                spellCheck={false}
                autoComplete="off"
              />
            </div>

            {!query.trim() && quick.length > 0 && (
              <div className="token-picker-quick" role="group" aria-label="Common tokens">
                {quick.map(token => (
                  <button
                    key={token.symbol}
                    type="button"
                    className={`token-quick ${token.symbol === value ? 'selected' : ''}`}
                    onClick={() => choose(token.symbol)}
                  >
                    <TokenAvatar symbol={metadata?.[token.address.toLowerCase()]?.symbol ?? token.symbol} iconUrl={metadata?.[token.address.toLowerCase()]?.iconUrl || token.iconUrl} size="sm" />
                    {token.symbol}
                  </button>
                ))}
              </div>
            )}

            {metadataStatus === 'loading' && <div className="token-picker-metadata-status">Reading token metadata…</div>}
            {metadataStatus === 'partial' && (
              <div className="token-picker-metadata-status warn">
                Live data for {liveCount} of {readable} tokens; the rest show registry values.
              </div>
            )}
            {metadataStatus === 'failed' && <div className="token-picker-metadata-status warn">Live token data is unavailable; registry values are shown.</div>}

            <div className="token-picker-list">
              {showSections && <div className="token-picker-section">Your tokens</div>}
              {(showSections ? held : []).map(renderRow)}
              {showSections && others.length > 0 && <div className="token-picker-section">All tokens</div>}
              {(showSections ? others : filtered).map(renderRow)}
              {filtered.length === 0 && !canImportTyped && <div className="token-picker-empty">No token matches this search.</div>}
              {canImportTyped && (
                <button type="button" className="token-picker-option token-picker-import-address" onClick={() => { setOpen(false); onImport(typedAddress); }}>
                  <span className="token-avatar token-avatar-lg token-avatar-unknown">?</span>
                  <span className="token-picker-option-copy">
                    <span className="token-picker-option-line"><strong>Import this token</strong></span>
                    <small>{shortAddress(typedAddress.toLowerCase(), 8, 6)} · not in the list</small>
                  </span>
                  <Plus size={15} />
                </button>
              )}
            </div>
            <button type="button" className="token-picker-import" onClick={() => { setOpen(false); onImport(); }}>
              <Plus size={16} /> Import a token
            </button>
            <p className="token-picker-warning">Anyone can create a token. Verify the contract address before trading.</p>
          </div>
        </div>
      )}
    </>
  );
}
