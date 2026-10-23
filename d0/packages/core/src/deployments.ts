import type { NetworkName } from './config.js';

/**
 * Where the DarkOrder protocol (GuildNameRegistry + GuildFactory) is deployed. Written by
 * `packages/contracts/scripts/deploy-quai.mjs --broadcast` after it has verified the code on
 * chain; edit by hand only to remove an entry.
 *
 * Mainnet has been deployed (Cyprus-1, 2026-10-18; see packages/contracts/deployments/mainnet.json
 * and the quaiscan-verifiable manifest in the suite's jsonverifiers/), so the site reads the
 * real halls there. Orchard has no deployment yet: on Orchard the site runs as a showcase —
 * sample content, clearly labelled, with every transaction disabled.
 */
export interface Deployment {
  factory: string;
  registry: string;
  fromBlock?: number;
  /**
   * QNNS (Quai Name Service / quaidomains.com) registry address used to resolve .quai
   * profiles for guild founders. null until the suite pins a verified address; the UI
   * deep-links to quaidomains.com either way.
   */
  qnsRegistry?: string | null;
}

export const DEPLOYMENTS: Record<Exclude<NetworkName, 'local'>, Deployment | null> = {
  mainnet: {
    factory: '0x00701eF6Ef13c1950a78eF763C463B490dc10dBB',
    registry: '0x001bB186Bb7f1Fe7249d72848E4C2dC06c28764F',
    fromBlock: 10672507,
  },
  orchard: null,
};
