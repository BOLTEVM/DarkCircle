import { SanctionsRegistry } from "./sanctionsList.ts";
import type { PPOIProof, PPOIVerificationResult } from "../types/ppoi.ts";

/**
 * Private Proof of Innocence (PPOI) Engine
 * Generates and verifies cryptographic non-membership proofs against sanctions SMT.
 */
export class PPOIEngine {
  private readonly registry: SanctionsRegistry;
  private readonly standbyPeriodMs: number;
  private readonly quarantinedNotes: Set<string>;

  constructor(registry: SanctionsRegistry, standbyPeriodMs: number = 5000) {
    this.registry = registry;
    this.standbyPeriodMs = standbyPeriodMs;
    this.quarantinedNotes = new Set<string>();
  }

  public getRegistry(): SanctionsRegistry {
    return this.registry;
  }

  /**
   * Generates a cryptographic non-membership proof proving depositOrigin is NOT sanctioned.
   */
  public generateProofOfInnocence(depositOrigin: string, depositTimestamp: number): PPOIProof {
    const clean = this.registry.normalizeAddress(depositOrigin);
    if (this.registry.isSanctioned(clean)) {
      throw new Error(`PPOI_SANCTIONED_INPUT: Cannot generate proof of innocence for sanctioned origin ${clean}`);
    }

    const key = this.registry.addressToKey(clean);
    const smt = this.registry.getTree();
    const rawProof = smt.createProof(key);

    if (!rawProof.isNonMembership || rawProof.value !== 0n) {
      throw new Error(`PPOI_INTERNAL_ERROR: Key ${clean} has non-zero value in sanctions tree`);
    }

    const now = Date.now();
    const isMature = now >= depositTimestamp + this.standbyPeriodMs;

    return {
      sanctionsRoot: "0x" + rawProof.root.toString(16),
      depositOrigin: clean,
      key: "0x" + key.toString(16),
      smtProof: {
        root: "0x" + rawProof.root.toString(16),
        key: "0x" + key.toString(16),
        value: "0x" + rawProof.value.toString(16),
        siblings: rawProof.siblings.map(s => "0x" + s.toString(16)),
        isNonMembership: rawProof.isNonMembership,
      },
      depositTimestamp,
      proofTimestamp: now,
      standbyWindowElapsed: isMature,
    };
  }

  /**
   * Verifies a PPOIProof against the sanctions tree and compliance rules.
   */
  public verifyProofOfInnocence(
    proof: PPOIProof,
    recipientAddress?: string,
    depositTimestamp?: number,
    currentTime: number = Date.now()
  ): PPOIVerificationResult {
    // 1. Root check & Root binding
    const rootKnown = this.registry.isKnownRoot(proof.sanctionsRoot);
    if (!rootKnown) {
      return {
        isValid: false,
        isSanctioned: false,
        isRootKnown: false,
        isMature: false,
        reason: "PPOI_INVALID_ROOT"
      };
    }

    try {
      if (BigInt(proof.smtProof.root) !== BigInt(proof.sanctionsRoot)) {
        return {
          isValid: false,
          isSanctioned: false,
          isRootKnown: true,
          isMature: false,
          reason: "PPOI_ROOT_MISMATCH"
        };
      }
    } catch {
      return {
        isValid: false,
        isSanctioned: false,
        isRootKnown: false,
        isMature: false,
        reason: "PPOI_INVALID_ROOT"
      };
    }

    // 2. Key binding & Origin validation
    let expectedKey: bigint;
    try {
      expectedKey = this.registry.addressToKey(proof.depositOrigin);
    } catch {
      return {
        isValid: false,
        isSanctioned: false,
        isRootKnown: true,
        isMature: false,
        reason: "PPOI_INVALID_ORIGIN_FORMAT"
      };
    }

    try {
      if (BigInt(proof.smtProof.key) !== expectedKey) {
        return {
          isValid: false,
          isSanctioned: false,
          isRootKnown: true,
          isMature: false,
          reason: "PPOI_KEY_MISMATCH"
        };
      }
      if (proof.key && BigInt(proof.key) !== expectedKey) {
        return {
          isValid: false,
          isSanctioned: false,
          isRootKnown: true,
          isMature: false,
          reason: "PPOI_KEY_MISMATCH"
        };
      }
    } catch {
      return {
        isValid: false,
        isSanctioned: false,
        isRootKnown: true,
        isMature: false,
        reason: "PPOI_KEY_MISMATCH"
      };
    }

    // 3. Active sanctions check
    if (this.registry.isSanctioned(proof.depositOrigin)) {
      return {
        isValid: false,
        isSanctioned: true,
        isRootKnown: true,
        isMature: false,
        reason: "PPOI_SANCTIONED_INPUT"
      };
    }

    // 4. Cryptographic SMT non-membership verification
    const smt = this.registry.getTree();
    const parsedProof = {
      root: BigInt(proof.smtProof.root),
      key: BigInt(proof.smtProof.key),
      value: BigInt(proof.smtProof.value),
      siblings: proof.smtProof.siblings.map(s => BigInt(s)),
      isNonMembership: proof.smtProof.isNonMembership,
    };

    if (parsedProof.value !== 0n || !parsedProof.isNonMembership) {
      return {
        isValid: false,
        isSanctioned: false,
        isRootKnown: true,
        isMature: false,
        reason: "PPOI_NON_MEMBERSHIP_ASSERTION_FAILED"
      };
    }

    const cryptographicValid = smt.verifyProof(parsedProof);
    if (!cryptographicValid) {
      return {
        isValid: false,
        isSanctioned: false,
        isRootKnown: true,
        isMature: false,
        reason: "PPOI_VERIFICATION_FAILED"
      };
    }

    // 5. Standby window verification (Server-side elapsed time computation)
    const effectiveDepositTimestamp =
      depositTimestamp !== undefined
        ? depositTimestamp
        : proof.depositTimestamp !== undefined
        ? proof.depositTimestamp
        : proof.proofTimestamp;

    const elapsed = currentTime - effectiveDepositTimestamp;
    const isMature = elapsed >= this.standbyPeriodMs;

    if (!isMature && recipientAddress) {
      let cleanRecipient: string;
      try {
        cleanRecipient = this.registry.normalizeAddress(recipientAddress);
      } catch {
        cleanRecipient = recipientAddress.trim().toLowerCase();
      }
      if (cleanRecipient !== proof.depositOrigin.toLowerCase()) {
        return {
          isValid: false,
          isSanctioned: false,
          isRootKnown: true,
          isMature: false,
          reason: "ERROR_STANDBY_WINDOW_ACTIVE"
        };
      }
    }

    return {
      isValid: true,
      isSanctioned: false,
      isRootKnown: true,
      isMature
    };
  }

  public quarantinePoisonedDeposit(commitmentOrAddress: string, reason?: string): void {
    this.quarantinedNotes.add(commitmentOrAddress.toLowerCase());
  }

  public isQuarantined(commitmentOrAddress: string): boolean {
    return this.quarantinedNotes.has(commitmentOrAddress.toLowerCase());
  }
}
