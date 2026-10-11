/**
 * DarkCircle: Enterprise-grade x402 Tumbler for Corporate Privacy
 * Main Library Entrypoint
 */

// Types
export * from "./types/crypto.ts";
export * from "./types/railgun.ts";
export * from "./types/ppoi.ts";
export * from "./types/smt.ts";
export * from "./types/audit.ts";
export * from "./types/x402.ts";
export type { UnshieldRequest } from "./types/railgun.ts";

// Cryptographic Core
export * from "./crypto/field.ts";
export * from "./crypto/poseidon.ts";
export * from "./crypto/merkleTree.ts";
export * from "./crypto/smt.ts";
export * from "./crypto/babyjubjub.ts";
export * from "./crypto/note.ts";
export * from "./crypto/unshield.ts";

// PPOI Engine & Sanctions SMT
export * from "./ppoi/sanctionsList.ts";
export * from "./ppoi/ppoiEngine.ts";
export * from "./ppoi/ppoiValidator.ts";

// Viewing-Key Audit Engine & Accounting
export * from "./audit/keys.ts";
export * from "./audit/decryptor.ts";
export * from "./audit/accounting.ts";
export * from "./audit/exporter.ts";

// Blockchain Simulation & Production Contracts (Production Grade)
export * from "./types/sim.ts";
export * from "./sim/blockchain.ts";
export * from "./sim/erc20Token.ts";
export * from "./sim/railgunContract.ts";
export * from "./sim/relayerNetwork.ts";

// Resource Server
export * from "./server/resourceServer.ts";

// Outbound Private Payment Proxy (Milestone 3)
export * from "./proxy/index.ts";

// Inbound Merchant Privacy Gateway (Milestone 4)
export * from "./gateway/index.ts";

// Shielded-transaction pre-flight checklist
export * from "./checklist/shieldedTx.ts";

// Client Subsystem (Milestone 5)
export * from "./client/index.ts";

// DarkCircle CLI Subsystem (Milestone 5)
export * from "./cli/index.ts";

