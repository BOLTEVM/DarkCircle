import { describe, it, expect } from 'vitest';
import {
  ORCHARD_CHAIN_ID,
  MAINNET_CHAIN_ID,
  TESTNET_CONFIG,
  MAINNET_CONFIG,
  CANONICAL_CYPRUS1_POOLS,
  CYPRUS1_TOKENS,
  CANONICAL_CYPRUS1_CONTRACTS,
  isSupportedNetwork,
  getNetworkConfig
} from '../src/config.js';

describe('@safebuddy/core: config module', () => {
  it('defines correct chain IDs', () => {
    expect(ORCHARD_CHAIN_ID).toBe(15000);
    expect(MAINNET_CHAIN_ID).toBe(9);
  });

  it('configures Quai Orchard Testnet with strict Cyprus-1 zone RPC', () => {
    expect(TESTNET_CONFIG.name).toBe('testnet');
    expect(TESTNET_CONFIG.chainId).toBe(15000);
    expect(TESTNET_CONFIG.rpcUrl).toBe('https://orchard.rpc.quai.network/cyprus1');
    expect(TESTNET_CONFIG.zone).toBe('cyprus1');
    expect(TESTNET_CONFIG.nativeCurrency.symbol).toBe('QUAI');
    expect(TESTNET_CONFIG.nativeCurrency.decimals).toBe(18);
  });

  it('configures Quai Mainnet with strict Cyprus-1 zone RPC', () => {
    expect(MAINNET_CONFIG.name).toBe('mainnet');
    expect(MAINNET_CONFIG.chainId).toBe(9);
    expect(MAINNET_CONFIG.rpcUrl).toBe('https://rpc.quai.network/cyprus1');
    expect(MAINNET_CONFIG.zone).toBe('cyprus1');
    expect(MAINNET_CONFIG.nativeCurrency.symbol).toBe('QUAI');
  });

  it('exports canonical Cyprus-1 DEX pair addresses and tokens', () => {
    expect(CANONICAL_CYPRUS1_POOLS.usdt_wquai).toBe('0x0021f5cc862eBb0252Ba209266f2FAbbC7592E83');
    expect(CANONICAL_CYPRUS1_POOLS.wqi_wquai).toBe('0x00602F12EA0491F02865aa6C418815319e2A645B');

    expect(CYPRUS1_TOKENS.WQUAI.address).toBe('0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB');
    expect(CYPRUS1_TOKENS.WQI.address).toBe('0x002b2596ecf05c93a31ff916e8b456df6c77c750');
    expect(CYPRUS1_TOKENS.USDT.address).toBe('0x0049F7cbCa3556C2DfaE62Aafa7015F99de1b8f5');
    expect(CYPRUS1_TOKENS.USDT.decimals).toBe(6);

    expect(CANONICAL_CYPRUS1_CONTRACTS.factories.quaiswap).toBe('0x0006112e89ee10615273ed72fe035cc068bc57a9');
  });

  it('resolves networks via getNetworkConfig and validates supported networks', () => {
    expect(isSupportedNetwork('testnet')).toBe(true);
    expect(isSupportedNetwork('orchard')).toBe(true);
    expect(isSupportedNetwork('mainnet')).toBe(true);
    expect(isSupportedNetwork('sepolia')).toBe(false);

    expect(getNetworkConfig('testnet').chainId).toBe(15000);
    expect(getNetworkConfig('orchard').chainId).toBe(15000);
    expect(getNetworkConfig(15000).chainId).toBe(15000);
    expect(getNetworkConfig('mainnet').chainId).toBe(9);
    expect(getNetworkConfig(9).chainId).toBe(9);

    expect(() => getNetworkConfig('unknown_net')).toThrow('Unsupported network');
  });
});
