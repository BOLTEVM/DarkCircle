/**
 * DarkCircle: Quai Network topology
 * File: src/quai/networks.ts
 *
 * Quai is a multi-chain network. Transactions and contract calls execute only on a *zone*
 * chain (the lowest shard), and a zone is selected by the RPC endpoint AND by the first byte of
 * every address that lives on it. Chain id is NOT the shard selector: it is 9 on every mainnet
 * zone and 15000 on every Orchard testnet zone.
 *
 * Verified against https://rpc.quai.network/cyprus1 (quai_chainId -> 0x9, quai_nodeLocation ->
 * ["0x0","0x0"]) and the quais SDK zone table.
 */

export const QUAI_MAINNET_CHAIN_ID = 9;
export const QUAI_ORCHARD_CHAIN_ID = 15000;

export type QuaiZoneName =
  | "cyprus1" | "cyprus2" | "cyprus3"
  | "paxos1" | "paxos2" | "paxos3"
  | "hydra1" | "hydra2" | "hydra3";

export interface QuaiZone {
  name: QuaiZoneName;
  title: string;
  /** Address prefix byte, lowercase hex without 0x (e.g. "00" for Cyprus-1). */
  byte: string;
  /** Numeric value of the prefix byte. */
  prefix: number;
  region: number;
  zone: number;
}

export const QUAI_ZONES: readonly QuaiZone[] = [
  { name: "cyprus1", title: "Cyprus One", byte: "00", prefix: 0x00, region: 0, zone: 0 },
  { name: "cyprus2", title: "Cyprus Two", byte: "01", prefix: 0x01, region: 0, zone: 1 },
  { name: "cyprus3", title: "Cyprus Three", byte: "02", prefix: 0x02, region: 0, zone: 2 },
  { name: "paxos1", title: "Paxos One", byte: "10", prefix: 0x10, region: 1, zone: 0 },
  { name: "paxos2", title: "Paxos Two", byte: "11", prefix: 0x11, region: 1, zone: 1 },
  { name: "paxos3", title: "Paxos Three", byte: "12", prefix: 0x12, region: 1, zone: 2 },
  { name: "hydra1", title: "Hydra One", byte: "20", prefix: 0x20, region: 2, zone: 0 },
  { name: "hydra2", title: "Hydra Two", byte: "21", prefix: 0x21, region: 2, zone: 1 },
  { name: "hydra3", title: "Hydra Three", byte: "22", prefix: 0x22, region: 2, zone: 2 }
];

export function getZone(nameOrByte: string): QuaiZone {
  const key = nameOrByte.trim().toLowerCase().replace(/^0x/, "").replace(/[\s_-]/g, "");
  const found = QUAI_ZONES.find((z) => z.name === key || z.byte === key);
  if (!found) {
    throw new Error(`ERR_QUAI_UNKNOWN_ZONE: '${nameOrByte}'`);
  }
  return found;
}

export interface QuaiNetwork {
  /** x402 network identifier advertised in challenges, e.g. "quai-cyprus1". */
  id: string;
  title: string;
  chainId: number;
  zone: QuaiZone;
  nativeSymbol: "QUAI";
  nativeDecimals: 18;
  /** Zone RPC endpoint. Contract calls are rejected on Prime and Region endpoints. */
  rpcUrl: string;
  explorerUrl: string;
  testnet: boolean;
}

function mainnet(zone: QuaiZone): QuaiNetwork {
  return {
    id: `quai-${zone.name}`,
    title: `Quai Network ${zone.title}`,
    chainId: QUAI_MAINNET_CHAIN_ID,
    zone,
    nativeSymbol: "QUAI",
    nativeDecimals: 18,
    rpcUrl: `https://rpc.quai.network/${zone.name}`,
    explorerUrl: "https://quaiscan.io",
    testnet: false
  };
}

function orchard(zone: QuaiZone): QuaiNetwork {
  return {
    id: `quai-orchard-${zone.name}`,
    title: `Quai Orchard Testnet ${zone.title}`,
    chainId: QUAI_ORCHARD_CHAIN_ID,
    zone,
    nativeSymbol: "QUAI",
    nativeDecimals: 18,
    rpcUrl: `https://orchard.rpc.quai.network/${zone.name}`,
    explorerUrl: "https://orchard.quaiscan.io",
    testnet: true
  };
}

export const QUAI_NETWORKS: readonly QuaiNetwork[] = [
  ...QUAI_ZONES.map(mainnet),
  ...QUAI_ZONES.map(orchard)
];

/** Default settlement network: Quai mainnet, Cyprus-1 (the zone where WQUAI and WQI are deployed). */
export const QUAI_CYPRUS1: QuaiNetwork = QUAI_NETWORKS.find((n) => n.id === "quai-cyprus1")!;
export const QUAI_ORCHARD_CYPRUS1: QuaiNetwork = QUAI_NETWORKS.find(
  (n) => n.id === "quai-orchard-cyprus1"
)!;
export const DEFAULT_QUAI_NETWORK: QuaiNetwork = QUAI_CYPRUS1;

/**
 * Resolves the network identifiers a 402 challenge may carry:
 *   "quai-cyprus1", "quai:cyprus1", "quai" (default zone), "quai-orchard-cyprus1",
 *   "quai:15000:cyprus1" and "eip155:9".
 * Returns undefined for anything that is not a Quai network (e.g. "ethereum", "base").
 */
export function resolveQuaiNetwork(id: string | undefined | null): QuaiNetwork | undefined {
  if (!id) return undefined;
  const raw = String(id).trim().toLowerCase();
  if (!raw) return undefined;
  if (raw === "quai" || raw === "quai-mainnet" || raw === "eip155:9") return DEFAULT_QUAI_NETWORK;
  if (raw === "quai-orchard" || raw === "quai-testnet" || raw === "eip155:15000") {
    return QUAI_ORCHARD_CYPRUS1;
  }
  const normalized = raw.replace(/^quai:(\d+):/, (_m, cid) =>
    Number(cid) === QUAI_ORCHARD_CHAIN_ID ? "quai-orchard-" : "quai-"
  ).replace(/^quai:/, "quai-");
  return QUAI_NETWORKS.find((n) => n.id === normalized);
}

/**
 * Checks a challenge's (network, chainId) pair against a configured network. A chain id alone
 * cannot identify a zone, so a mainnet challenge must also name its zone or use the bare "quai" id.
 */
export function challengeMatchesNetwork(
  network: QuaiNetwork,
  challenge: { network?: string; chainId?: number }
): boolean {
  if (challenge.chainId !== undefined && Number(challenge.chainId) !== network.chainId) return false;
  const resolved = resolveQuaiNetwork(challenge.network);
  if (!resolved) return false;
  return resolved.id === network.id;
}
