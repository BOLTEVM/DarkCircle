import type { Deployment } from './brokerage.js';
import type { NetworkName } from './config.js';

/**
 * Where Dark Questate's contracts are deployed. Written by
 * `packages/contracts/scripts/deploy-quai.mjs --broadcast` after it has verified the code on
 * chain; edit by hand only to remove an entry.
 *
 * Neither network has a deployment yet, so the site runs as a showcase: sample listings,
 * clearly labelled, with every transaction disabled.
 */
export const DEPLOYMENTS: Record<Exclude<NetworkName, 'local'>, Deployment | null> = {
  mainnet: null,
  orchard: null,
};
