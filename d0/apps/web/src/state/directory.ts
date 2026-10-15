import { useCallback, useEffect, useState } from 'react';
import { SHOWCASE_GUILDS, listGuilds, readGuildSummary, showcaseSummary, type GuildSummary } from '@darkorder/core';
import { useNetwork } from './NetworkContext.js';
import { CHAIN_CHANGED_EVENT } from './TxContext.js';

export type DirectoryMode = 'loading' | 'chain' | 'showcase' | 'error';

export interface DirectoryState {
  mode: DirectoryMode;
  /** Guilds with their on-chain metadata and treasury. While `enriching` the metadata may
   *  still be empty; cards render the record and fill in the profile when it lands. */
  guilds: GuildSummary[];
  enriching: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * The hall directory: every guild in the on-chain registry, or the labelled showcase set when
 * the protocol is not deployed on the selected network. The registry page arrives first so the
 * halls render immediately; each guild's metadata and treasury fill in right behind it.
 */
export function useGuildDirectory(): DirectoryState {
  const { rpc, deployment } = useNetwork();
  const [state, setState] = useState<Omit<DirectoryState, 'refresh'>>({ mode: 'loading', guilds: [], enriching: false, error: null });
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const onChange = () => refresh();
    window.addEventListener(CHAIN_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CHAIN_CHANGED_EVENT, onChange);
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    if (!deployment) {
      setState({ mode: 'showcase', guilds: SHOWCASE_GUILDS.map(showcaseSummary), enriching: false, error: null });
      return;
    }
    setState((s) => ({ ...s, mode: 'loading', enriching: false, error: null }));
    (async () => {
      try {
        // The registry page renders the halls immediately; each guild's metadata and
        // treasury fill in behind it.
        const records = await listGuilds(rpc, deployment.registry);
        if (!alive) return;
        setState({
          mode: 'chain',
          guilds: records.map((r) => ({ ...r, metadata: '', treasury: 0n })),
          enriching: true,
          error: null,
        });
        const guilds = await Promise.all(records.map((r) => readGuildSummary(rpc, r)));
        if (alive) setState({ mode: 'chain', guilds, enriching: false, error: null });
      } catch (e) {
        if (alive) setState({ mode: 'error', guilds: [], enriching: false, error: (e as Error).message });
      }
    })();
    return () => {
      alive = false;
    };
  }, [rpc, deployment, nonce]);

  return { ...state, refresh };
}
