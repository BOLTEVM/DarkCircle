/**
 * Quai Network Configuration Profiles for SafeBuddy
 * Supports Quai Orchard Testnet (Chain ID 15000) and Quai Mainnet (Chain ID 9)
 * targeting the Cyprus-1 execution shard (0x00 prefix).
 */

export const ORCHARD_CHAIN_ID = 15000;
export const MAINNET_CHAIN_ID = 9;

export type NetworkName = 'mainnet' | 'testnet';

export interface TokenConfig {
  address?: string;
  symbol: string;
  decimals: number;
  name: string;
}

export interface QuaiContractsConfig {
  bdeltaDex: string;
  wquai: string;
  q0: string;
  boss?: string;
  wqi: string;
  usdt: string;
  pools: {
    usdt_wquai: string;
    wqi_wquai: string;
    q0_wquai: string;
    q0_boss: string;
  };
  factories: {
    quaiswap: string;
    quainance: string;
  };
}

export interface QuaiNetworkConfig {
  name: NetworkName;
  chainId: number;
  chainIdHex: string;
  zone: string;
  location: [string, string];
  rpcUrl: string;
  regionRpcUrl?: string;
  primeRpcUrl?: string;
  explorerUrl: string;
  explorerApiUrl?: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  contracts: QuaiContractsConfig;
}

/**
 * Known Cyprus-1 DEX Pair Addresses on Quai Network.
 */
export const CANONICAL_CYPRUS1_POOLS = {
  usdt_wquai: '0x0021f5cc862eBb0252Ba209266f2FAbbC7592E83',
  wqi_wquai: '0x00602F12EA0491F02865aa6C418815319e2A645B',
  q0_wquai: '0x003B4b96bF0793EB1D53B79f8c38746A298eEef8',
  q0_boss: '0x0036c1A5e62597438cC204F8613c15211D4b7787',
} as const;

/**
 * Canonical Cyprus-1 Tokens.
 */
export const CYPRUS1_TOKENS = {
  QUAI: {
    symbol: 'QUAI',
    decimals: 18,
    name: 'Native Quai'
  },
  WQUAI: {
    address: '0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB',
    symbol: 'WQUAI',
    decimals: 18,
    name: 'Wrapped Quai'
  },
  WQI: {
    address: '0x002b2596ecf05c93a31ff916e8b456df6c77c750',
    symbol: 'WQI',
    decimals: 18,
    name: 'Wrapped Qi'
  },
  USDT: {
    address: '0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5',
    symbol: 'USDT',
    decimals: 6,
    name: 'Tether USD'
  },
  QI: {
    symbol: 'QI',
    decimals: 18,
    name: 'Qi Energy'
  }
} as const;

export const CANONICAL_CYPRUS1_CONTRACTS: QuaiContractsConfig = {
  bdeltaDex: '0x00037b82Ae94B3ea19f1DBDb6D6c0Bb35875F867',
  wquai: CYPRUS1_TOKENS.WQUAI.address!,
  q0: '0x00325150094E51107a931980Fdfc3bB1a4C48379',
  boss: '0x004afdb66677d177b759356d2367aea3a79fe58b',
  wqi: CYPRUS1_TOKENS.WQI.address!,
  usdt: CYPRUS1_TOKENS.USDT.address!,
  pools: {
    usdt_wquai: CANONICAL_CYPRUS1_POOLS.usdt_wquai,
    wqi_wquai: CANONICAL_CYPRUS1_POOLS.wqi_wquai,
    q0_wquai: CANONICAL_CYPRUS1_POOLS.q0_wquai,
    q0_boss: CANONICAL_CYPRUS1_POOLS.q0_boss,
  },
  factories: {
    quaiswap: '0x0006112e89ee10615273ed72fe035cc068bc57a9',
    quainance: '0x0018a110b6ca369dcf5ab062c72f049e93b9ede2',
  },
};

/**
 * Quai Orchard Testnet (Chain ID 15000, 0x3a98) Configuration Profile.
 * Targeting Orchard Cyprus-1 execution shard.
 */
export const TESTNET_CONFIG: QuaiNetworkConfig = {
  name: 'testnet',
  chainId: ORCHARD_CHAIN_ID,
  chainIdHex: '0x3a98',
  zone: 'cyprus1',
  location: ['0x0', '0x0'],
  rpcUrl: 'https://orchard.rpc.quai.network/cyprus1',
  regionRpcUrl: 'https://orchard.rpc.quai.network/cyprus',
  primeRpcUrl: 'https://orchard.rpc.quai.network/prime',
  explorerUrl: 'https://orchard.quaiscan.io',
  explorerApiUrl: 'https://orchard.quaiscan.io/api/v2',
  nativeCurrency: {
    name: 'Quai',
    symbol: 'QUAI',
    decimals: 18,
  },
  contracts: CANONICAL_CYPRUS1_CONTRACTS,
};

/**
 * Quai Mainnet (Chain ID 9, 0x9) Configuration Profile.
 * Targeting Mainnet Cyprus-1 execution shard.
 */
export const MAINNET_CONFIG: QuaiNetworkConfig = {
  name: 'mainnet',
  chainId: MAINNET_CHAIN_ID,
  chainIdHex: '0x9',
  zone: 'cyprus1',
  location: ['0x0', '0x0'],
  rpcUrl: 'https://rpc.quai.network/cyprus1',
  regionRpcUrl: 'https://rpc.quai.network/cyprus',
  primeRpcUrl: 'https://rpc.quai.network/prime',
  explorerUrl: 'https://quaiscan.io',
  explorerApiUrl: 'https://quaiscan.io/api/v2',
  nativeCurrency: {
    name: 'Quai',
    symbol: 'QUAI',
    decimals: 18,
  },
  contracts: CANONICAL_CYPRUS1_CONTRACTS,
};

export const NETWORKS: Record<NetworkName, QuaiNetworkConfig> = {
  mainnet: MAINNET_CONFIG,
  testnet: TESTNET_CONFIG,
};

/**
 * Checks if network name is supported.
 */
export function isSupportedNetwork(network: string): network is NetworkName {
  const normalized = (network || '').trim().toLowerCase();
  return normalized === 'mainnet' || normalized === 'testnet' || normalized === 'orchard';
}

/**
 * Retrieves network configuration profile by name or Chain ID.
 */
export function getNetworkConfig(network: NetworkName | 'orchard' | string | number): QuaiNetworkConfig {
  const str = String(network).trim().toLowerCase();
  if (str === 'mainnet' || str === '9' || str === '0x9') {
    return MAINNET_CONFIG;
  }
  if (str === 'testnet' || str === 'orchard' || str === '15000' || str === '0x3a98') {
    return TESTNET_CONFIG;
  }
  throw new Error(`Unsupported network "${network}". Supported networks are "testnet" (Chain ID 15000) and "mainnet" (Chain ID 9).`);
}
