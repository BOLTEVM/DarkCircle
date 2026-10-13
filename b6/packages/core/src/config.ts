/**
 * Networks Dark Questate runs on. Everything lives in the Cyprus-1 zone of Quai.
 *
 * Verified facts (see the DarkCircle suite notes): mainnet answers `quai_chainId` with 0x9 on
 * every shard, Orchard testnet is chain 15000, contract calls only work on a zone endpoint,
 * and Cyprus-1 account addresses start with 0x00 with a second byte below 0x80 (0x80 and up
 * are Qi UTXO addresses, which cannot hold a deed or call a contract).
 */

export type NetworkName = 'mainnet' | 'orchard' | 'local';

export interface NetworkConfig {
  name: NetworkName;
  label: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string | null;
  /** JSON-RPC namespace the node speaks. Quai nodes speak quai_*; a Hardhat dev node speaks eth_*. */
  rpcNamespace: 'quai' | 'eth';
  /** 'cyprus1' enforces the zone prefix on every address; 'any' is for the local dev chain only. */
  addressRule: 'cyprus1' | 'any';
  /** Receipt depth the site waits for before calling a transaction final. */
  confirmations: number;
  currency: { symbol: string; decimals: number };
  isTestnet: boolean;
}

export const MAINNET: NetworkConfig = {
  name: 'mainnet',
  label: 'Quai Mainnet · Cyprus-1',
  chainId: 9,
  rpcUrl: 'https://rpc.quai.network/cyprus1',
  explorerUrl: 'https://quaiscan.io',
  rpcNamespace: 'quai',
  addressRule: 'cyprus1',
  confirmations: 3,
  currency: { symbol: 'QUAI', decimals: 18 },
  isTestnet: false,
};

export const ORCHARD: NetworkConfig = {
  name: 'orchard',
  label: 'Orchard Testnet · Cyprus-1',
  chainId: 15000,
  rpcUrl: 'https://orchard.rpc.quai.network/cyprus1',
  explorerUrl: 'https://orchard.quaiscan.io',
  rpcNamespace: 'quai',
  addressRule: 'cyprus1',
  // Orchard nodes have been seen ~30 blocks apart and reorging 25 deep.
  confirmations: 6,
  currency: { symbol: 'QUAI', decimals: 18 },
  isTestnet: true,
};

/** A Hardhat node on this machine. The web app offers it only in dev builds that opt in. */
export const LOCAL: NetworkConfig = {
  name: 'local',
  label: 'Local Hardhat node',
  chainId: 31337,
  rpcUrl: 'http://127.0.0.1:8545',
  explorerUrl: null,
  rpcNamespace: 'eth',
  addressRule: 'any',
  confirmations: 1,
  currency: { symbol: 'QUAI', decimals: 18 },
  isTestnet: true,
};

export const NETWORKS: Record<NetworkName, NetworkConfig> = { mainnet: MAINNET, orchard: ORCHARD, local: LOCAL };

export function getNetwork(name: NetworkName): NetworkConfig {
  return NETWORKS[name];
}

export function explorerTxUrl(network: NetworkConfig, hash: string): string | null {
  return network.explorerUrl ? `${network.explorerUrl}/tx/${hash}` : null;
}

export function explorerAddressUrl(network: NetworkConfig, address: string): string | null {
  return network.explorerUrl ? `${network.explorerUrl}/address/${address}` : null;
}
