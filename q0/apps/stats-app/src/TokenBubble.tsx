import { useEffect, useState } from 'react';
import { resolveIconUrl, splitDisplayName, type TokenInfo, type TokenMetadata } from 'quai-service';
import { cachedThumb, rememberThumb } from './tokenIcons';

export interface TokenBubbleMetadata extends TokenMetadata {
  iconUrl?: string;
  website?: string;
  description?: string;
  holders?: number;
  priceUsd?: number;
  /** True when `decimals` was read from the contract (false: registry value). */
  decimalsVerified?: boolean;
}

interface Props {
  token: TokenInfo;
  metadata?: TokenBubbleMetadata;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  showDetails?: boolean;
}

const avatarHues = [350, 195, 265, 155, 38, 330];

/** A stable colour per symbol, shown behind the letter until (or instead of) a real logo. */
function avatarBackground(symbol: string): string {
  let hash = 0;
  for (const char of symbol) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const hue = avatarHues[hash % avatarHues.length];
  return `linear-gradient(135deg, hsl(${hue} 78% 58%), hsl(${(hue + 40) % 360} 70% 42%))`;
}

/**
 * Circular token logo. The logo URL is resolved against the explorer (it arrives as "/token-icons/…"),
 * restricted to https, loaded lazily, and remembered as a small thumbnail after the first load.
 * Every failure path falls back to the coloured letter.
 */
export function TokenAvatar({ symbol, iconUrl, size = 'md' }: { symbol: string; iconUrl?: string; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const resolved = resolveIconUrl(iconUrl);
  const initial = () => (resolved ? cachedThumb(resolved) ?? resolved : undefined);
  const [src, setSrc] = useState<string | undefined>(initial);
  const [cors, setCors] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc(initial());
    setCors(true);
    setFailed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  return (
    <span className={`token-avatar token-avatar-${size}`} style={{ background: avatarBackground(symbol) }}>
      <span className="token-avatar-fallback" aria-hidden="true">{symbol.slice(0, 1).toUpperCase()}</span>
      {src && !failed && (
        <img
          key={`${src.slice(0, 64)}|${cors}`}
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          // CORS mode is what lets us draw the loaded image to a canvas for the thumbnail; a host without
          // CORS headers gets one retry without it, then the letter.
          crossOrigin={cors && !src.startsWith('data:') ? 'anonymous' : undefined}
          onLoad={event => {
            if (resolved && !src.startsWith('data:') && cors) rememberThumb(resolved, event.currentTarget);
          }}
          onError={() => {
            if (cors && !src.startsWith('data:')) setCors(false);
            else setFailed(true);
          }}
        />
      )}
    </span>
  );
}

export default function TokenBubble({ token, metadata, size = 'md', showDetails = false }: Props) {
  const symbol = metadata?.symbol || token.symbol;
  const name = metadata?.name || token.name;
  const decimals = metadata?.decimals ?? token.decimals;
  const contract = token.isNative ? 'Native Cyprus-1 asset' : token.address;
  const title = `${symbol} · ${name}\n${decimals} decimals\n${contract}`;
  const display = splitDisplayName(name);

  return (
    <span className={`token-bubble token-bubble-${size}`} title={title} aria-label={title}>
      <TokenAvatar symbol={symbol} iconUrl={metadata?.iconUrl || token.iconUrl} size={size} />
      {showDetails && (
        <span className="token-bubble-copy">
          <strong>{symbol}</strong>
          <small>{display.title}</small>
        </span>
      )}
    </span>
  );
}
