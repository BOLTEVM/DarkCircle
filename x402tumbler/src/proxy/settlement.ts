/**
 * DarkCircle: Outbound Private Payment Proxy - Relayer Settlement Coordinator
 * File: src/proxy/settlement.ts
 *
 * Enforces spending policy and sanctions screening, manages sequential UTXO spending mutex,
 * derives nullifiers and change commitments, constructs PPOI non-membership proofs and
 * anti-frontrunning hashes, and dispatches unshield transactions through RelayerNetwork
 * ensuring complete on-chain graph decoupling (tx.sender == relayerAddress).
 */

import { getAddress } from "ethers";
import { Fp } from "../crypto/field.ts";
import { poseidon3, poseidon4 } from "../crypto/poseidon.ts";
import { computePublicInputsHash } from "../crypto/unshield.ts";
import { addressToBigInt } from "../sim/railgunContract.ts";
import { assertQuaiPaymentAddress } from "../quai/address.ts";
import { DEFAULT_QUAI_NETWORK, resolveQuaiNetwork, type QuaiNetwork } from "../quai/networks.ts";
import { SpendTracker } from "./spendTracker.ts";
import type { ShieldedUTXO, UnshieldRequest } from "../types/sim.ts";
import type { UnshieldWitness } from "../sim/unshieldVerifier.ts";
import type { RelayerNetwork } from "../sim/relayerNetwork.ts";
import type { PPOIEngine } from "../ppoi/ppoiEngine.ts";
import type { SanctionsRegistry } from "../ppoi/sanctionsList.ts";

function safeEthersAddress(addr: string): string {
  try {
    return getAddress(addr);
  } catch {
    const clean = addr.toLowerCase().replace(/^0x/, "").padStart(40, "0").slice(-40);
    return getAddress("0x" + clean);
  }
}

export interface SpendingPolicy {
  maxPaymentCap: bigint;
  allowedTokens: string[];
  allowedChainIds: number[];
  /**
   * Maximum total payment amount per token (base units, fees excluded) in any rolling 24 hours.
   * Enforced under the settlement mutex so concurrent requests cannot jointly overshoot it.
   */
  dailyBudgetCap?: bigint;
  /**
   * Refuse to pay an invoice that has expired or expires within this many seconds: the merchant
   * rejects a late payment with 410 and the shielded note is already spent. Unset = not checked.
   */
  minInvoiceTtlSeconds?: number;
  /**
   * A direct unshield is sent by the treasury operator, not a relayer, so it links the treasury to the
   * payee on-chain and defeats the purpose of the pool. Refused unless explicitly allowed.
   */
  allowDirectUnshield?: boolean;
  screenRecipients?: boolean;
  /** Quai network payments settle on. Defaults to Cyprus-1; decides the zone recipients must be in. */
  quaiNetwork?: QuaiNetwork;
  /**
   * Require the payee to be a checksum-valid, Quai-ledger address inside the network's zone
   * (default true). A wrong-zone recipient is rejected by the zone node, so catching it here avoids
   * spending a shielded note and relayer fee on a payment that cannot land.
   */
  enforceQuaiAddresses?: boolean;
}

export interface SettlementReceipt {
  cacheKey: string;
  invoiceId: string;
  txHash: string;
  blockNumber: number;
  relayerAddress: string;
  amount: bigint;
  token: string;
  recipient: string;
  expiresAt: number;
  settledAt: number;
}

export interface PaymentProofHeaders {
  Authorization: string;
  "X-Payment-Invoice-Id": string;
  "X-Payment-Proof": string;
  "X-Payment-Relayer": string;
}

export interface SettlementCoordinatorConfig {
  spendingPolicy: SpendingPolicy;
  relayer: RelayerNetwork;
  corporateKeys: {
    ssk: bigint;
    spk: bigint;
    vsk: bigint;
    vpk: bigint;
    npk: bigint;
    corporate0zkAddress: string;
  };
  ppoiEngine?: PPOIEngine;
  sanctionsRegistry?: SanctionsRegistry;
  preferDirectUnshield?: boolean; // Default: false (enforces Relayer broadcast for privacy decoupling)
  treasuryUTXOs?: ShieldedUTXO[];
  /**
   * Rolling spend log behind `dailyBudgetCap`. Pass the lane's tracker so the cap accumulates across
   * commands; a coordinator built without one starts from zero (fine for a one-shot test).
   */
  spendTracker?: SpendTracker;
}

/**
 * SettlementCoordinator manages the complete private unshield payment lifecycle.
 */
export class SettlementCoordinator {
  public spendingPolicy: SpendingPolicy;
  public relayer: RelayerNetwork;
  public corporateKeys: SettlementCoordinatorConfig["corporateKeys"];
  public ppoiEngine?: PPOIEngine;
  public sanctionsRegistry?: SanctionsRegistry;
  public treasuryUTXOs: ShieldedUTXO[] = [];
  public preferDirectUnshield: boolean;

  private settlementMutex: Promise<void> = Promise.resolve();
  public readonly spendTracker: SpendTracker;

  constructor(config: SettlementCoordinatorConfig) {
    if (config.preferDirectUnshield && config.spendingPolicy.allowDirectUnshield !== true) {
      throw new Error(
        "ERR_DIRECT_UNSHIELD_NOT_ALLOWED: a direct unshield is sent by the treasury operator and links it to the payee; set spendingPolicy.allowDirectUnshield to accept that"
      );
    }
    this.spendingPolicy = config.spendingPolicy;
    this.relayer = config.relayer;
    this.corporateKeys = config.corporateKeys;
    this.ppoiEngine = config.ppoiEngine;
    this.sanctionsRegistry = config.sanctionsRegistry;
    this.preferDirectUnshield = config.preferDirectUnshield ?? false;
    this.spendTracker = config.spendTracker ?? new SpendTracker();
    if (config.treasuryUTXOs && Array.isArray(config.treasuryUTXOs)) {
      this.treasuryUTXOs = [...config.treasuryUTXOs];
    }
  }

  /**
   * Registers a shielded UTXO note into the local treasury note set.
   */
  public addTreasuryUTXO(utxo: ShieldedUTXO): void {
    this.treasuryUTXOs.push(utxo);
  }

  /**
   * Enforces spending limits, allowed tokens/chains, and payee sanctions screening.
   */
  public validatePolicy(challenge: {
    amount: bigint;
    tokenAddress: string;
    chainId: number;
    network?: string;
    recipientAddress?: string;
    expiresAt?: number;
  }): void {
    if (challenge.amount <= 0n) {
      throw new Error("ERR_SPENDING_POLICY_REJECTED_AMOUNT_INVALID");
    }
    if (challenge.amount > this.spendingPolicy.maxPaymentCap) {
      throw new Error("ERR_SPENDING_POLICY_REJECTED_AMOUNT_EXCEEDS_CAP");
    }

    const tokenAllowed = this.spendingPolicy.allowedTokens.some(
      (t) => t.toLowerCase() === challenge.tokenAddress.toLowerCase()
    );
    if (!tokenAllowed) {
      throw new Error("ERR_UNSUPPORTED_CHAIN_OR_TOKEN");
    }

    if (!this.spendingPolicy.allowedChainIds.includes(challenge.chainId)) {
      throw new Error("ERR_UNSUPPORTED_CHAIN_OR_TOKEN");
    }

    const minTtl = this.spendingPolicy.minInvoiceTtlSeconds;
    if (minTtl !== undefined && challenge.expiresAt !== undefined && challenge.expiresAt > 0) {
      const remaining = challenge.expiresAt - Math.floor(Date.now() / 1000);
      if (remaining < minTtl) {
        throw new Error(`ERR_INVOICE_EXPIRED_OR_EXPIRING: ${remaining}s left, policy requires at least ${minTtl}s`);
      }
    }

    // A chain id alone cannot name a Quai zone, so the advertised network must resolve to ours.
    const quaiNetwork = this.spendingPolicy.quaiNetwork ?? DEFAULT_QUAI_NETWORK;
    if (challenge.network !== undefined) {
      const advertised = resolveQuaiNetwork(challenge.network);
      if (!advertised || advertised.id !== quaiNetwork.id || advertised.chainId !== challenge.chainId) {
        throw new Error("ERR_UNSUPPORTED_CHAIN_OR_TOKEN");
      }
    }

    if (this.spendingPolicy.screenRecipients !== false && challenge.recipientAddress) {
      const recipient = challenge.recipientAddress;
      const isSanctioned =
        (this.sanctionsRegistry && this.sanctionsRegistry.isSanctioned(recipient)) ||
        (this.ppoiEngine && this.ppoiEngine.getRegistry().isSanctioned(recipient)) ||
        (this.relayer &&
          this.relayer.pool &&
          this.relayer.pool.sanctionsSMT &&
          this.relayer.pool.sanctionsSMT.get(addressToBigInt(recipient)) !== 0n);

      if (isSanctioned) {
        throw new Error("ERR_PAYEE_SANCTIONED");
      }
    }

    // Sanctions screening runs first: a sanctioned payee is refused as such whatever chain it names.
    if (this.spendingPolicy.enforceQuaiAddresses !== false && challenge.recipientAddress) {
      try {
        assertQuaiPaymentAddress(challenge.recipientAddress, quaiNetwork);
      } catch (err) {
        throw new Error(`ERR_QUAI_RECIPIENT_INVALID: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Executes the full settlement lifecycle:
   * Policy check -> Mutex lock -> Note selection -> Nullifier derivation ->
   * PPOI proof generation -> Anti-frontrunning binding -> Relayer broadcast ->
   * Local note state update -> Proof formatting.
   */
  public async settleChallenge(challenge: {
    invoiceId: string;
    amount: bigint;
    tokenAddress: string;
    chainId: number;
    network?: string;
    recipientAddress: string;
    expiresAt: number;
    maxFee?: bigint;
    targetResource?: string;
  }): Promise<{ receipt: SettlementReceipt; headers: PaymentProofHeaders }> {
    this.validatePolicy(challenge);

    // Sequentialize concurrent unshield calls to prevent UTXO note race conditions
    const prevLock = this.settlementMutex;
    let releaseLock: () => void = () => {};
    this.settlementMutex = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await prevLock;
    try {
      const relayerFee = this.preferDirectUnshield ? 0n : this.relayer.minimumFee;
      const totalRequired = challenge.amount + relayerFee;

      if (challenge.maxFee !== undefined && relayerFee > challenge.maxFee) {
        throw new Error("ERR_RELAYER_FEE_EXCEEDS_MAX_FEE");
      }
      this.assertWithinDailyBudget(challenge.tokenAddress, challenge.amount);

      // 1. Select suitable treasury UTXO note
      const utxoIndex = this.treasuryUTXOs.findIndex((u) => u.value >= totalRequired);
      if (utxoIndex === -1) {
        throw new Error("ERR_INSUFFICIENT_TREASURY_FUNDS");
      }
      const utxo = this.treasuryUTXOs[utxoIndex];

      // 2. Compute nullifier: Poseidon3(ssk, commitment, leafIndex)
      const nullifier = poseidon3(
        Fp.mod(this.corporateKeys.ssk),
        utxo.commitment,
        BigInt(utxo.leafIndex)
      );

      // 3. Prepare change note commitment if remainder exists
      const remainder = utxo.value - totalRequired;
      let changeCommitment: bigint | undefined;
      let changeBlinding: bigint | undefined;
      if (remainder > 0n) {
        changeBlinding = Fp.random();
        const tokenBigInt = BigInt(getAddress(challenge.tokenAddress));
        changeCommitment = poseidon4(
          this.corporateKeys.npk,
          tokenBigInt,
          remainder,
          changeBlinding
        );
      }

      // 4. Generate PPOI non-membership proof & sanctions verification
      const depositOrigin = utxo.depositorAddress || "0x0000000000000000000000000000000000000000";
      const depositOriginKey = addressToBigInt(depositOrigin);

      // Check SMT directly on pool
      const isSanctionedInPoolSMT = this.relayer.pool.sanctionsSMT.get(depositOriginKey) !== 0n;
      if (isSanctionedInPoolSMT) {
        throw new Error("PPOI_SANCTIONED_INPUT");
      }

      let ppoiProofPayload: any;
      if (this.ppoiEngine) {
        let isSanctioned = false;
        try {
          isSanctioned = this.ppoiEngine.getRegistry().isSanctioned(depositOrigin);
        } catch {
          isSanctioned = this.ppoiEngine.getRegistry().isSanctioned(depositOriginKey);
        }
        if (isSanctioned) {
          throw new Error("PPOI_SANCTIONED_INPUT");
        }
        const fullProof = this.ppoiEngine.generateProofOfInnocence(
          depositOrigin,
          utxo.depositTimestamp
        );
        ppoiProofPayload = {
          sanctionsRoot: fullProof.sanctionsRoot,
          depositOrigin: fullProof.depositOrigin,
          isNonSanctioned: true,
          smtProof: fullProof.smtProof,
          depositTimestamp: utxo.depositTimestamp
        };
      } else {
        ppoiProofPayload = {
          sanctionsRoot: this.relayer.pool.sanctionsSMT.root,
          depositOrigin,
          isNonSanctioned: true,
          depositTimestamp: utxo.depositTimestamp
        };
      }

      // 5. Anti-frontrunning binding hash
      const merkleRoot = this.relayer.pool.merkleTree.root;
      const relayerAddress = this.preferDirectUnshield
        ? "0x0000000000000000000000000000000000000000"
        : this.relayer.relayerAddress;

      const safeRecipient = safeEthersAddress(challenge.recipientAddress);
      const safeToken = safeEthersAddress(challenge.tokenAddress);
      const safeRelayer = safeEthersAddress(relayerAddress);

      const publicInputsHash = computePublicInputsHash({
        recipient: safeRecipient,
        token: safeToken,
        amount: challenge.amount,
        relayerAddress: safeRelayer,
        relayerFee,
        merkleRoot: Fp.toHex(merkleRoot)
      });

      // 5b. Witness for the pool's statement check (the private inputs a SNARK prover would hold)
      const pool = this.relayer.pool;
      let witness: UnshieldWitness | undefined;
      try {
        witness = {
          inputNote: {
            npk: utxo.npk ?? this.corporateKeys.npk,
            token: safeToken,
            value: utxo.value,
            rho: utxo.rho ?? utxo.blinding
          },
          leafIndex: utxo.leafIndex,
          siblings: pool.merkleTree.generateProof(utxo.leafIndex).siblings,
          spendingKey: this.corporateKeys.ssk,
          viewingPublicKeyX: this.corporateKeys.vpk,
          changeNote:
            changeCommitment !== undefined && changeBlinding !== undefined
              ? { npk: this.corporateKeys.npk, token: safeToken, value: remainder, rho: changeBlinding }
              : undefined
        };
      } catch (err) {
        // A verified pool cannot accept a request without a witness; a trusted harness ignores it.
        if (pool.verified) throw err;
      }

      // 6. Build UnshieldRequest payload
      const unshieldReq: UnshieldRequest = {
        witness,
        merkleRoot,
        nullifier,
        recipient: challenge.recipientAddress,
        token: challenge.tokenAddress,
        amount: challenge.amount,
        relayerFee,
        relayerAddress,
        changeCommitment,
        publicInputsHash,
        ppoiProof: ppoiProofPayload
      };

      // 7. Dispatch on-chain
      let txHash: string;
      let blockNumber: number;
      let effectiveRelayer: string;
      let changeLeafIndex: number | undefined;

      if (this.preferDirectUnshield) {
        const directRes = this.relayer.pool.unshield(unshieldReq);
        txHash = directRes.txHash;
        blockNumber = directRes.blockNumber;
        changeLeafIndex = directRes.changeLeafIndex;
        effectiveRelayer = "0xDirectUnshield";
      } else {
        const relayerRes = await this.relayer.broadcastUnshield(unshieldReq);
        txHash = relayerRes.txHash;
        blockNumber = relayerRes.blockNumber;
        changeLeafIndex = relayerRes.changeLeafIndex;
        effectiveRelayer = relayerRes.relayerAddress;
      }

      // 8. Update local treasury notes
      this.treasuryUTXOs.splice(utxoIndex, 1);
      if (remainder > 0n && changeCommitment && changeBlinding) {
        this.treasuryUTXOs.push({
          commitment: changeCommitment,
          // The pool reports where it inserted the change note. Reading "the last leaf" instead is wrong
          // whenever another deposit lands between the unshield and this line.
          leafIndex: changeLeafIndex ?? this.relayer.pool.merkleTree.leaves.length - 1,
          npk: this.corporateKeys.npk,
          rho: changeBlinding,
          token: challenge.tokenAddress.toLowerCase(),
          value: remainder,
          blinding: changeBlinding,
          memo: "change_note",
          depositorAddress: utxo.depositorAddress,
          // Lineage, not wall clock: a change note is the same money as the deposit it came from, so it
          // keeps that deposit's PPOI timestamp (the pool records it the same way).
          depositTimestamp: utxo.depositTimestamp
        });
      }

      this.recordSpend(challenge.tokenAddress, challenge.amount);

      const receipt: SettlementReceipt = {
        cacheKey: challenge.targetResource || challenge.invoiceId,
        invoiceId: challenge.invoiceId,
        txHash,
        blockNumber,
        relayerAddress: effectiveRelayer,
        amount: challenge.amount,
        token: challenge.tokenAddress,
        recipient: challenge.recipientAddress,
        expiresAt: challenge.expiresAt,
        settledAt: Math.floor(Date.now() / 1000)
      };

      const headers: PaymentProofHeaders = {
        Authorization: `x402 invoice="${challenge.invoiceId}", proof="${txHash}", relayer="${effectiveRelayer}"`,
        "X-Payment-Invoice-Id": challenge.invoiceId,
        "X-Payment-Proof": txHash,
        "X-Payment-Relayer": effectiveRelayer
      };

      return { receipt, headers };
    } finally {
      releaseLock();
    }
  }

  private assertWithinDailyBudget(token: string, amount: bigint): void {
    this.spendTracker.assertWithin(this.spendingPolicy.dailyBudgetCap, token, amount);
  }

  private recordSpend(token: string, amount: bigint): void {
    this.spendTracker.record(token, amount);
  }

  /** Total paid per token in the rolling 24-hour window (for status displays). */
  public spentLast24h(token: string): bigint {
    return this.spendTracker.spent(token);
  }

  /**
   * Helper formatting Bearer token representation.
   */
  public static formatBearerToken(
    invoiceId: string,
    txHash: string,
    relayerAddress?: string
  ): string {
    const payload = JSON.stringify({ invoiceId, proof: txHash, relayer: relayerAddress });
    return `Bearer ${Buffer.from(payload).toString("base64")}`;
  }
}
