import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Search, ShieldCheck } from 'lucide-react';
import { readChainFields, readExplorerFields, shortAddress, splitDisplayName, type TokenInfo } from 'quai-service';
import { Field, Modal, Notice, input, smallBtn } from './ui';
import { TokenAvatar } from './TokenBubble';
import { formatUsd } from './TokenPicker';
import { normalizeContractAddress } from './customTokens';

interface Props {
  /** A contract address typed into the token picker; looked up as soon as the dialog opens. */
  initialAddress?: string;
  onClose: () => void;
  onImported: (token: TokenInfo) => void;
}

interface Preview {
  token: TokenInfo;
  iconUrl?: string;
  holders?: number;
  priceUsd?: number;
  /** false: the explorer answered and has never heard of this contract (new, or not a real token).
   *  undefined: the explorer could not be reached, which says nothing about the token. */
  explorerKnown?: boolean;
}

export default function ImportTokenModal({ initialAddress, onClose, onImported }: Props) {
  const [address, setAddress] = useState(initialAddress ?? '');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef(0);

  const lookup = async (raw: string = address) => {
    const mine = ++attempt.current;
    setError(null);
    setPreview(null);
    let normalized: string;
    try {
      normalized = normalizeContractAddress(raw);
    } catch (e: any) {
      setError(e.message);
      return;
    }
    setLoading(true);
    try {
      // The contract answers for itself; the explorer is only asked what it knows about it. A failure of
      // the explorer is not a reason to refuse a token the chain can describe.
      const [chain, explorer] = await Promise.all([
        readChainFields([normalized]),
        readExplorerFields(normalized).catch(() => undefined)
      ]);
      if (mine !== attempt.current) return;
      const fields = chain[normalized];
      if (!fields?.symbol) throw new Error('This contract did not return an ERC-20 symbol.');
      // decimals() unreadable used to decode as 0 here and be accepted; that mis-scales every amount.
      if (fields.decimals === undefined) throw new Error('The token did not report valid decimals (0 to 36).');
      const symbol = fields.symbol.trim().toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9._-]{0,15}$/.test(symbol)) throw new Error('The token symbol contains unsupported characters.');
      setPreview({
        token: {
          symbol,
          name: fields.name?.trim() || symbol,
          decimals: fields.decimals,
          address: normalized,
          deployed: true,
          description: 'Imported from Cyprus-1'
        },
        iconUrl: explorer?.iconUrl,
        holders: explorer?.holders,
        priceUsd: explorer?.priceUsd,
        explorerKnown: explorer === undefined ? undefined : explorer !== null
      });
    } catch (e: any) {
      if (mine === attempt.current) setError(e?.message || 'Could not read ERC-20 metadata from Cyprus-1.');
    } finally {
      if (mine === attempt.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (initialAddress) void lookup(initialAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const metadata = preview?.token ?? null;
  const display = metadata ? splitDisplayName(metadata.name) : null;

  return (
    <Modal title="Import token" icon={<ShieldCheck size={18} style={{ color: 'var(--accent-neon)' }} />} onClose={onClose} maxWidth={470}>
      <Notice tone="warn">
        <strong>Import with care.</strong> Anyone can deploy a token with a familiar name or ticker. Only trade a contract you have verified.
      </Notice>
      <Field label="Token contract" hint="Cyprus-1 addresses begin with 0x00.">
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <input style={{ ...input, flex: 1, fontFamily: 'monospace' }} value={address} onChange={event => setAddress(event.target.value)} placeholder="0x00…" onKeyDown={event => { if (event.key === 'Enter') void lookup(); }} />
          <button type="button" style={smallBtn} onClick={() => void lookup()} disabled={loading || !address.trim()}>
            <Search size={14} /> {loading ? 'Reading…' : 'Read'}
          </button>
        </div>
      </Field>
      {error && <Notice tone="danger"><AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} />{error}</Notice>}
      {preview && metadata && display && (
        <>
          <div className="import-token-preview">
            <TokenAvatar symbol={metadata.symbol} iconUrl={preview.iconUrl} size="lg" />
            <div style={{ minWidth: 0 }}>
              <strong>{metadata.symbol}</strong>
              <div title={metadata.name}>{display.title}{display.tag && <em className="token-chip" style={{ marginLeft: '0.4rem' }}>{display.tag}</em>}</div>
              <small>{metadata.decimals} decimals · {shortAddress(metadata.address, 10, 8)}</small>
              {(preview.holders !== undefined || preview.priceUsd !== undefined) && (
                <small style={{ display: 'block' }}>
                  {preview.holders !== undefined && <>{preview.holders.toLocaleString('en-US')} holder{preview.holders === 1 ? '' : 's'}</>}
                  {preview.holders !== undefined && preview.priceUsd !== undefined && ' · '}
                  {preview.priceUsd !== undefined && formatUsd(preview.priceUsd)}
                </small>
              )}
            </div>
            <CheckCircle2 size={18} style={{ color: 'var(--success)', marginLeft: 'auto', flex: 'none' }} />
          </div>
          {preview.explorerKnown === false && (
            <Notice tone="warn">
              <AlertTriangle size={14} style={{ verticalAlign: 'middle', marginRight: '0.35rem' }} />
              The explorer has no record of this contract. It may be brand new or not a real token: confirm the address with the project before importing.
            </Notice>
          )}
        </>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
        <button type="button" style={smallBtn} onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!metadata} onClick={() => metadata && onImported(metadata)}>Import token</button>
      </div>
    </Modal>
  );
}
