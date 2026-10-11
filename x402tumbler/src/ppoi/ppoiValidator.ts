import { PPOIEngine } from "./ppoiEngine.ts";
import type { UnshieldValidationRequest } from "../types/ppoi.ts";

/**
 * Unshield Compliance Gate used by Relayer and Shielded Pool
 * Validates roots, lineage, quarantine status, and standby window.
 */
export class PPOIValidator {
  private readonly ppoiEngine: PPOIEngine;

  constructor(ppoiEngine: PPOIEngine) {
    this.ppoiEngine = ppoiEngine;
  }

  public validateUnshield(req: UnshieldValidationRequest): { success: boolean; errorCode?: string } {
    // 1. Quarantined note check
    if (this.ppoiEngine.isQuarantined(req.depositOrigin)) {
      return { success: false, errorCode: "POISONED_INPUT_QUARANTINED" };
    }

    // 2. Lineage binding: request deposit origin must match PPOI proof origin
    if (req.depositOrigin.toLowerCase() !== req.ppoiProof.depositOrigin.toLowerCase()) {
      return { success: false, errorCode: "PPOI_ORIGIN_MISMATCH" };
    }

    // 3. Direct sanctions check on actual deposit origin
    if (this.ppoiEngine.getRegistry().isSanctioned(req.depositOrigin)) {
      return { success: false, errorCode: "PPOI_SANCTIONED_INPUT" };
    }

    // 4. Timestamp lineage binding (if proof includes depositTimestamp)
    if (
      req.ppoiProof.depositTimestamp !== undefined &&
      req.ppoiProof.depositTimestamp !== req.depositTimestamp
    ) {
      return { success: false, errorCode: "PPOI_TIMESTAMP_MISMATCH" };
    }

    // 5. PPOI compliance verification (with authoritative depositTimestamp)
    const result = this.ppoiEngine.verifyProofOfInnocence(
      req.ppoiProof,
      req.recipient,
      req.depositTimestamp
    );
    if (!result.isValid) {
      return { success: false, errorCode: result.reason || "PPOI_COMPLIANCE_FAILED" };
    }

    return { success: true };
  }
}
