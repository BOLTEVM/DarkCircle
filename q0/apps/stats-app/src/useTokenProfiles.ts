import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createTokenMetadataService,
  MARKET_TTL_MS,
  type TokenInfo,
  type TokenMetadataService,
  type TokenProfile
} from 'quai-service';
import type { TokenBubbleMetadata } from './TokenBubble';

export type ProfileStatus = 'loading' | 'ready' | 'partial' | 'failed';

// One service for the whole page: it owns the in-memory and localStorage cache.
let shared: TokenMetadataService | null = null;
export function tokenMetadataService(): TokenMetadataService {
  if (!shared) shared = createTokenMetadataService();
  return shared;
}

/**
 * Live profiles for a token catalogue.
 *  - Cached profiles are returned synchronously on first render (no flash of registry-only data).
 *  - The chain is read in one batch and the explorer enriches it; results stream in per token.
 *  - A failed source never wipes what is already known, and a retry happens on its own schedule.
 */
export function useTokenProfiles(tokens: TokenInfo[]) {
  const service = tokenMetadataService();
  const addresses = useMemo(
    () => tokens.filter(t => t.deployed !== false && !t.isNative).map(t => t.address.toLowerCase()),
    [tokens]
  );
  const key = addresses.join(',');
  const [profiles, setProfiles] = useState<Record<string, TokenProfile>>(() => service.peekAll(addresses));
  const [status, setStatus] = useState<ProfileStatus>(() =>
    addresses.length === 0 || Object.keys(service.peekAll(addresses)).length > 0 ? 'ready' : 'loading'
  );
  const [refreshing, setRefreshing] = useState(false);
  const runRef = useRef<(force: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setProfiles(service.peekAll(addresses));

    const run = async (force: boolean) => {
      if (addresses.length === 0) { setStatus('ready'); return; }
      setRefreshing(true);
      try {
        const result = await service.load(addresses, {
          signal: controller.signal,
          force,
          onProfile: profile => {
            if (live) setProfiles(prev => ({ ...prev, [profile.address]: profile }));
          }
        });
        if (!live) return;
        setProfiles({ ...result.profiles });
        const known = Object.keys(result.profiles).length;
        setStatus(known === 0 ? 'failed' : result.failed.length === 0 ? 'ready' : 'partial');
      } finally {
        if (live) setRefreshing(false);
      }
    };
    runRef.current = run;
    void run(false);

    // load() does nothing until a source is stale, so this only costs a request when prices are old
    const timer = setInterval(() => { if (!document.hidden) void run(false); }, MARKET_TTL_MS);
    return () => {
      live = false;
      controller.abort();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refresh = useCallback(() => runRef.current(true), []);
  return { profiles, status, refreshing, refresh };
}

/**
 * Merge registry + live profile into what the UI components need.
 * Decimals fall back to the registry value when the chain read failed (the swap maths uses the registry).
 */
export function toBubbleMetadata(token: TokenInfo, profile: TokenProfile | undefined): TokenBubbleMetadata | undefined {
  if (!profile) return undefined;
  return {
    address: token.address,
    name: profile.name ?? token.name,
    symbol: profile.symbol ?? token.symbol,
    decimals: profile.decimals ?? token.decimals,
    totalSupply: profile.totalSupply ?? '0',
    iconUrl: profile.iconUrl ?? token.iconUrl,
    website: profile.website,
    description: profile.description ?? token.description,
    holders: profile.holders,
    priceUsd: profile.priceUsd,
    decimalsVerified: profile.decimals !== undefined
  };
}
