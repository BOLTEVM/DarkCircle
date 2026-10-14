import type { NetworkName } from './config.js';

/**
 * Where the DarkOrder protocol (GuildNameRegistry + GuildFactory) is deployed. Written by
 * `packages/contracts/scripts/deploy-quai.mjs --broadcast` after it has verified the code on
 * chain; edit by hand only to remove an entry.
 *
 * Neither network has a deployment yet, so the site runs as a showcase: sample guilds,
 * clearly labelled, with every transaction disabled.
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
  mainnet: null,
  orchard: null,
};
