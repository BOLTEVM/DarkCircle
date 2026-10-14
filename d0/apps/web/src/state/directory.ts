import { useCallback, useEffect, useState } from 'react';
import { SHOWCASE_GUILDS, listGuilds, type GuildRecord } from '@darkorder/core';
import { useNetwork } from './NetworkContext.js';
import { CHAIN_CHANGED_EVENT } from './TxContext.js';

export type DirectoryMode = 'loading' | 'chain' | 'showcase' | 'error';

export interface DirectoryState {
  mode: DirectoryMode;
  guilds: GuildRecord[];
  error: string | null;
  refresh: () => void;
}

/**
 * The hall directory: every guild in the on-chain registry, or the labelled showcase set when
 * the protocol is not deployed on the selected network.
 */
export function useGuildDirectory(): DirectoryState {
  const { rpc, deployment } = useNetwork();
  const [state, setState] = useState<Omit<DirectoryState, 'refresh'>>({ mode: 'loading', guilds: [], error: null });
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
      setState({ mode: 'showcase', guilds: SHOWCASE_GUILDS, error: null });
      return;
    }
    setState((s) => ({ ...s, mode: 'loading', error: null }));
    listGuilds(rpc, deployment.registry)
      .then((guilds) => {
        if (alive) setState({ mode: 'chain', guilds, error: null });
      })
      .catch((e) => {
        if (alive) setState({ mode: 'error', guilds: [], error: (e as Error).message });
      });
    return () => {
      alive = false;
    };
  }, [rpc, deployment, nonce]);

  return { ...state, refresh };
}
