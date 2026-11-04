import type { NetworkName } from './config.js';

/**
 * Where the DarkOrder protocol (GuildNameRegistry + GuildFactory) is deployed. Written by
 * `packages/contracts/scripts/deploy-quai.mjs --broadcast` after it has verified the code on
 * chain; the script rewrites each network's entry between its `<deployments:…>` markers, so keep
 * every entry on one line between them and edit by hand only to remove an entry.
 *
 * Versions: the contracts are immutable, so a new protocol version is a new registry and factory.
 * `version` says which ABI a deployment speaks. Halls founded on an earlier version live on in its
 * registry: the deploy script moves the replaced deployment into `legacy`, and the site keeps
 * listing those halls (labelled "v1") and lets their members keep proposing, voting, approving
 * and executing there — moving a v1 treasury to its v2 hall is itself a v1 proposal.
 *
 * Mainnet runs v2 (v1 from 2026-10-18 kept as legacy; see packages/contracts/deployments/mainnet.json,
 * mainnet.v1.json and the quaiscan-verifiable manifest in the suite's jsonverifiers/). Orchard runs v2
 * (deployments/orchard.json). A network with no entry runs as a showcase — sample content, clearly
 * labelled, every transaction disabled.
 */
export type ProtocolVersion = 1 | 2;

/** The version founding targets once deployed. */
export const LATEST_PROTOCOL_VERSION: ProtocolVersion = 2;

export interface Deployment {
  version: ProtocolVersion;
  factory: string;
  registry: string;
  fromBlock?: number;
  /**
   * QNNS (Quai Name Service / quaidomains.com) registry address used to resolve .quai
   * profiles for guild founders. null until the suite pins a verified address; the UI
   * deep-links to quaidomains.com either way.
   */
  qnsRegistry?: string | null;
  /** Earlier protocol versions on this network, newest first; their halls stay readable and actionable. */
  legacy?: Deployment[];
}

export const DEPLOYMENTS: Record<Exclude<NetworkName, 'local'>, Deployment | null> = {
  // <deployments:mainnet>
  mainnet: { version: 2, factory: '0x00697eEed627A9aa62Cc2cD7422ccf5FE2ce9695', registry: '0x0068e6884ed9D396193B718aBF43458A355EE473', fromBlock: 10973806, legacy: [{ version: 1, factory: '0x00701eF6Ef13c1950a78eF763C463B490dc10dBB', registry: '0x001bB186Bb7f1Fe7249d72848E4C2dC06c28764F', fromBlock: 10672507 }] },
  // </deployments:mainnet>
  // <deployments:orchard>
  orchard: { version: 2, factory: '0x003791B7F5e4dC4b578d26CBe6422994dB0f6bF3', registry: '0x0070FDb76eb5Dd74cd7CdDeFFe56820792B1CCaE', fromBlock: 8088297, legacy: [] },
  // </deployments:orchard>
};

/** One registry the site reads, with what it needs to know about it. */
export interface RegistrySource {
  version: ProtocolVersion;
  registry: string;
  factory: string;
  fromBlock?: number;
  /** true for an earlier version kept readable after an upgrade. */
  legacy: boolean;
}

/** Every registry a deployment spans: the current one first, then each legacy one. */
export function registrySources(deployment: Deployment): RegistrySource[] {
  const current: RegistrySource = {
    version: deployment.version,
    registry: deployment.registry,
    factory: deployment.factory,
    fromBlock: deployment.fromBlock,
    legacy: false,
  };
  const older = (deployment.legacy ?? []).map<RegistrySource>((d) => ({
    version: d.version,
    registry: d.registry,
    factory: d.factory,
    fromBlock: d.fromBlock,
    legacy: true,
  }));
  return [current, ...older];
}
