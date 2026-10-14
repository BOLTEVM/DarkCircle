import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { DEPLOYMENTS, NETWORKS, RpcClient, type Deployment, type NetworkConfig, type NetworkName } from '@darkorder/core';
import { LOCAL_ENABLED, localDeployment, localNetwork, readStored, savedDeployment, writeStored } from '../lib/env.js';

interface NetworkState {
  network: NetworkConfig;
  networks: NetworkConfig[];
  setNetwork: (name: NetworkName) => void;
  rpc: RpcClient;
  /** null: the protocol is not deployed on this network, so the Halls run as a showcase. */
  deployment: Deployment | null;
  blockNumber: bigint | null;
  rpcError: string | null;
}

const Ctx = createContext<NetworkState | null>(null);
const STORE_KEY = 'darkorder.network';
const BLOCK_POLL_MS = 20_000;

function available(): NetworkConfig[] {
  return LOCAL_ENABLED ? [NETWORKS.mainnet, NETWORKS.orchard, localNetwork()] : [NETWORKS.mainnet, NETWORKS.orchard];
}

function initialNetwork(): NetworkName {
  const stored = readStored(STORE_KEY) as NetworkName | null;
  if (stored && available().some((n) => n.name === stored)) return stored;
  return 'mainnet';
}

export const NetworkProvider: React.FC<{ children: React.ReactNode; rpcFactory?: (n: NetworkConfig) => RpcClient }> = ({ children, rpcFactory }) => {
  const [name, setName] = useState<NetworkName>(initialNetwork);
  const network = useMemo(() => (name === 'local' ? localNetwork() : NETWORKS[name]), [name]);
  const rpc = useMemo(() => (rpcFactory ? rpcFactory(network) : new RpcClient(network)), [network, rpcFactory]);
  const deployment = useMemo(() => (name === 'local' ? localDeployment() : (DEPLOYMENTS[name] ?? savedDeployment(name))), [name]);
  const [blockNumber, setBlockNumber] = useState<bigint | null>(null);
  const [rpcError, setRpcError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBlockNumber(null);
    setRpcError(null);
    const poll = async () => {
      try {
        const n = await rpc.getBlockNumber();
        if (alive) {
          setBlockNumber(n);
          setRpcError(null);
        }
      } catch (e) {
        if (alive) setRpcError((e as Error).message);
      }
    };
    poll();
    const timer = setInterval(poll, BLOCK_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [rpc]);

  const value = useMemo<NetworkState>(
    () => ({
      network,
      networks: available(),
      setNetwork: (n) => {
        writeStored(STORE_KEY, n);
        setName(n);
      },
      rpc,
      deployment,
      blockNumber,
      rpcError,
    }),
    [network, rpc, deployment, blockNumber, rpcError]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export function useNetwork(): NetworkState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNetwork must be used inside NetworkProvider');
  return v;
}
