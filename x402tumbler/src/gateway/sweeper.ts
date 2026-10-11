/**
 * DarkCircle Protocol: Inbound Merchant Privacy Gateway
 * Automated Balance Sweeper & Inbound Shielding Pipeline
 *
 * Sweeps settled token balances from single-use ephemeral addresses directly into
 * the corporate Railgun Shielded Pool, converting public on-chain payments into
 * private 0zk note commitments. Enforces key zeroization for forward secrecy.
 */

import crypto from "node:crypto";
import { Wallet } from "ethers";
import { PERMIT_TYPES } from "../sim/erc20Token.ts";
import { Fp } from "../crypto/field.ts";
import { encryptNotePayload } from "../audit/decryptor.ts";
import type { DecryptedNotePayload, EncryptedNotePayload } from "../types/audit.ts";
import type { Point } from "../types/crypto.ts";
import type { ShieldedUTXO } from "../types/sim.ts";
import { ZEROIZED_PRIVATE_KEY } from "./ephemeral.ts";
import { SIM_RELAYER_ADDRESS } from "../sim/defaults.ts";
import { defaultQuaiTokenRegistry } from "../quai/tokens.ts";
import type { InvoiceRegistry } from "./invoiceRegistry.ts";
import type {
  InvoiceRecord,
  SweepResult,
  SweepReceipt,
  BatchSweepSummary,
  SweeperConfig,
  SweeperMode,
  GasSponsorshipMode,
  ISweepPool
} from "./types.ts";

export class SweeperWorker {
  public registry: InvoiceRegistry;
  public pool: ISweepPool;
  public corporateNpk: bigint;
  public corporate0zkAddress: string;
  public corporateVpk?: Point;
  public blockchain?: any;
  public relayer?: any;
  public journal?: any;
  public treasuryLedger: ShieldedUTXO[] = [];
  public sanctionsRegistry?: { isSanctioned(address: string): boolean };
  public mode: SweeperMode;
  public gasSponsorshipMode: GasSponsorshipMode;
  public minSweepThreshold: bigint;
  public batchIntervalMs: number;
  public maxBatchSize: number;
  public sweepFeeUnits: bigint;

  private batchTimer: NodeJS.Timeout | null = null;
  private activeSweepLocks: Set<string> = new Set();

  constructor(config: SweeperConfig) {
    this.registry = config.registry;
    this.pool = config.pool;
    this.corporateNpk = config.corporateNpk;
    this.corporate0zkAddress =
      config.corporate0zkAddress || "0zk1q_corporate_default_treasury";
    this.corporateVpk = config.corporateVpk;
    this.blockchain = config.blockchain || (this.pool as any)?.blockchain;
    this.relayer = config.relayer;
    this.journal = config.journal;
    if (config.treasuryLedger) {
      this.treasuryLedger = config.treasuryLedger;
    }
    this.sanctionsRegistry = config.sanctionsRegistry;
    this.mode = config.mode || "REALTIME";
    this.gasSponsorshipMode = config.gasSponsorshipMode || "DIRECT_SIMULATION";
    this.minSweepThreshold = config.minSweepThreshold ?? 1n;
    this.batchIntervalMs = config.batchIntervalMs || 5000;
    this.maxBatchSize = config.maxBatchSize || 25;
    this.sweepFeeUnits = config.sweepFeeUnits ?? 0n;

    if (this.mode === "BATCH") {
      this.startBatchDaemon();
    }
  }

  /**
   * Sweeps token balance from the invoice's ephemeral address and shields it into Railgun.
   */
  public async sweepAndShield(
    invoiceId: string,
    customBlinding?: bigint
  ): Promise<SweepReceipt> {
    // Concurrency lock per invoice
    if (this.activeSweepLocks.has(invoiceId)) {
      throw new Error(`SWEEP_IN_PROGRESS: Invoice ${invoiceId} is currently being swept`);
    }
    this.activeSweepLocks.add(invoiceId);

    try {
      const invoice = this.registry.get(invoiceId);
      if (!invoice) {
        throw new Error("INVOICE_NOT_FOUND");
      }

      if (invoice.status === "SWEPT") {
        throw new Error("ALREADY_SWEPT");
      }

      if (
        !invoice.ephemeralPrivateKey ||
        invoice.ephemeralPrivateKey === ZEROIZED_PRIVATE_KEY
      ) {
        throw new Error("EPHEMERAL_KEY_ZEROIZED: Ephemeral private key is unavailable");
      }

      const blockchain = this.blockchain || this.registry.blockchain;
      if (!blockchain) {
        throw new Error("BLOCKCHAIN_LEDGER_UNAVAILABLE");
      }

      // The relayer submits the permit and pays for the sweep; an offline relayer must leave the funds where
      // they are (the invoice stays SETTLED and can be swept once it is back).
      if (this.relayer && this.relayer.online === false) {
        throw new Error(`ERR_RELAYER_OFFLINE: ${this.relayer.offlineReason ?? "the relayer was taken offline by an operator"}`);
      }

      // A fresh ephemeral address holds no QUAI for gas. Gasless sweeping is only possible through
      // EIP-2612 permit, which WQI has and WQUAI does not; WQUAI sweeps need the relayer to fund gas.
      if (this.gasSponsorshipMode === "PERMIT_SPONSORED") {
        const known = defaultQuaiTokenRegistry.getByAddress(invoice.tokenAddress);
        if (known && !known.permit) {
          throw new Error(
            `ERR_QUAI_PERMIT_UNSUPPORTED: ${known.symbol} has no permit(); use RELAYER_BROADCAST so the relayer funds sweep gas in QUAI`
          );
        }
      }

      const balance = blockchain.getTokenBalance(
        invoice.tokenAddress,
        invoice.ephemeralAddress
      );

      if (balance <= 0n || balance < this.minSweepThreshold) {
        throw new Error("NO_FUNDS_TO_SWEEP");
      }

      // Inbound sanctions screening. The ephemeral address is fresh and can never be listed, so the
      // screen that means something is the PAYER, read from the Transfer log at verification.
      const origin = invoice.payerAddress ?? invoice.ephemeralAddress;
      if (
        this.sanctionsRegistry &&
        (this.sanctionsRegistry.isSanctioned(origin) || this.sanctionsRegistry.isSanctioned(invoice.ephemeralAddress))
      ) {
        throw new Error("SANCTIONED_DEPOSIT_DETECTED: Refusing to shield funds from sanctioned address");
      }

      // Fee deduction
      const feeAmount = this.sweepFeeUnits < balance ? this.sweepFeeUnits : 0n;
      const netSweptAmount = balance - feeAmount;

      const poolAddress = this.pool.contractAddress;
      const relayerAddress =
        this.relayer?.relayerAddress || SIM_RELAYER_ADDRESS;

      // The blinding factor hides the note's value and owner inside its commitment: a full, uniform field
      // element (rejection-sampled, see Fp.random), not 128 bits.
      const blinding = customBlinding !== undefined ? Fp.mod(customBlinding) : Fp.random();
      const shieldMemo = invoice.invoiceId;

      // Order matters for atomicity: shield first (it can still throw, for example on a full tree, and
      // nothing has moved yet), then move tokens. A verified pool pulls the net amount itself against an
      // allowance the ephemeral address grants; a trusted-harness pool only does bookkeeping, so the
      // tokens are moved here as before.
      const pullsFunds = this.pool.verified === true;
      let sweepMethod: "permit" | "allowance" | "bookkeeping" = pullsFunds ? "allowance" : "bookkeeping";
      const tokenContract = typeof blockchain.getToken === "function" ? blockchain.getToken(invoice.tokenAddress) : undefined;
      if (pullsFunds && this.gasSponsorshipMode === "PERMIT_SPONSORED" && tokenContract?.supportsPermit) {
        // Gasless sweep (WQI): the payee key signs an EIP-2612 permit for exactly the net amount and the
        // relayer submits it, so the fresh address never has to hold QUAI. The signature is checked by the
        // token exactly as the deployed contract checks it (same domain), and a bad one throws before
        // anything has moved.
        const owner = invoice.ephemeralAddress;
        const deadline = blockchain.latestBlock.timestamp + 600;
        const values = {
          owner,
          spender: poolAddress,
          value: netSweptAmount,
          nonce: tokenContract.nonces(owner),
          deadline
        };
        const signature = await new Wallet(invoice.ephemeralPrivateKey).signTypedData(
          tokenContract.permitDomain(),
          PERMIT_TYPES,
          values
        );
        const r = "0x" + signature.slice(2, 66);
        const sv = "0x" + signature.slice(66, 130);
        const v = parseInt(signature.slice(130, 132), 16);
        tokenContract.permit(owner, poolAddress, netSweptAmount, deadline, v, r, sv);
        sweepMethod = "permit";
      } else if (pullsFunds && typeof blockchain.setTokenAllowance === "function") {
        blockchain.setTokenAllowance(invoice.tokenAddress, invoice.ephemeralAddress, poolAddress, netSweptAmount);
      }
      const shieldResult = this.pool.shield(
        invoice.tokenAddress,
        netSweptAmount,
        this.corporateNpk,
        blinding,
        shieldMemo,
        invoice.ephemeralAddress,
        origin
      );
      if (typeof blockchain.transferToken === "function") {
        if (!pullsFunds) {
          blockchain.transferToken(invoice.tokenAddress, invoice.ephemeralAddress, poolAddress, netSweptAmount);
        }
        if (feeAmount > 0n) {
          blockchain.transferToken(invoice.tokenAddress, invoice.ephemeralAddress, relayerAddress, feeAmount);
        }
      }

      const blockNumber = blockchain.currentBlockNumber ?? 1001;
      const sweepTxHash = "0x" + crypto.randomBytes(32).toString("hex");

      // Record in corporate treasury Shielded UTXO ledger
      const utxo: ShieldedUTXO = {
        commitment: shieldResult.commitment,
        leafIndex: shieldResult.leafIndex,
        token: invoice.tokenAddress.toLowerCase(),
        value: netSweptAmount,
        blinding,
        rho: blinding,
        npk: this.corporateNpk,
        memo: shieldMemo,
        depositorAddress: origin.toLowerCase(),
        // the pool's own record (PPOI binds to it); re-reading the clock here could land a second later
        depositTimestamp: shieldResult.depositTimestamp ?? Math.floor(Date.now() / 1000)
      };
      this.treasuryLedger.push(utxo);

      // Construct viewing key decrypted note payload for accounting
      const notePayload: DecryptedNotePayload = {
        version: 1,
        token: invoice.tokenAddress.toLowerCase(),
        value: netSweptAmount.toString(),
        blinding: Fp.toHex(blinding),
        npk: Fp.toHex(this.corporateNpk),
        direction: "INBOUND_SWEEP",
        counterparty: invoice.ephemeralAddress,
        invoiceId: invoice.invoiceId,
        memo: `Inbound x402 Payment: ${invoice.invoiceId}`,
        timestamp: Math.floor(Date.now() / 1000)
      };

      let encryptedNote: EncryptedNotePayload | undefined;
      if (this.corporateVpk) {
        encryptedNote = encryptNotePayload(this.corporateVpk, notePayload);
      }

      // Double-entry accounting recording if attached
      if (this.journal && typeof this.journal.recordInbound === "function") {
        this.journal.recordInbound(
          sweepTxHash,
          blockNumber,
          Fp.toHex(shieldResult.commitment),
          notePayload
        );
      }

      // Transition invoice to SWEPT and zeroize ephemeral key
      this.registry.markSwept(invoiceId, sweepTxHash);

      const receipt: SweepReceipt = {
        sweepMethod,
        invoiceId,
        sweepTxHash,
        blockNumber,
        tokenAddress: invoice.tokenAddress.toLowerCase(),
        grossAmount: balance,
        feeAmount,
        sweptAmount: netSweptAmount,
        shieldedCommitment: shieldResult.commitment,
        leafIndex: shieldResult.leafIndex,
        treeRoot: (shieldResult as any).treeRoot || (shieldResult as any).root,
        ephemeralAddress: invoice.ephemeralAddress,
        relayerAddress,
        timestamp: Math.floor(Date.now() / 1000),
        status: "confirmed",
        note: notePayload,
        encryptedNote
      };

      return receipt;
    } finally {
      this.activeSweepLocks.delete(invoiceId);
    }
  }

  /**
   * Executes batch sweeping across eligible settled invoices.
   */
  public async sweepBatch(maxBatchSize?: number): Promise<BatchSweepSummary> {
    const startTime = Date.now();
    const limit = maxBatchSize || this.maxBatchSize;
    const receipts: SweepReceipt[] = [];
    const errors: Array<{ invoiceId: string; error: string }> = [];
    let totalSweptAmount = 0n;

    const eligibleInvoices: InvoiceRecord[] = [];
    const blockchain = this.blockchain || this.registry.blockchain;

    for (const invoice of this.registry.values()) {
      if (invoice.status === "SWEPT") continue;
      if (
        !invoice.ephemeralPrivateKey ||
        invoice.ephemeralPrivateKey === ZEROIZED_PRIVATE_KEY
      ) {
        continue;
      }

      const bal = blockchain ? blockchain.getTokenBalance(invoice.tokenAddress, invoice.ephemeralAddress) : 0n;
      if (bal >= this.minSweepThreshold) {
        eligibleInvoices.push(invoice);
        if (eligibleInvoices.length >= limit) break;
      }
    }

    for (const invoice of eligibleInvoices) {
      try {
        const receipt = await this.sweepAndShield(invoice.invoiceId);
        receipts.push(receipt);
        totalSweptAmount += receipt.sweptAmount;
      } catch (err: any) {
        errors.push({
          invoiceId: invoice.invoiceId,
          error: err?.message || String(err)
        });
      }
    }

    return {
      totalProcessed: eligibleInvoices.length,
      successfulSweeps: receipts.length,
      failedSweeps: errors.length,
      totalSweptAmount,
      receipts,
      errors,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * Starts background interval daemon for periodic batch sweeping.
   */
  public startBatchDaemon(intervalMs?: number): void {
    if (this.batchTimer) return;
    const interval = intervalMs || this.batchIntervalMs;
    this.batchTimer = setInterval(async () => {
      try {
        await this.sweepBatch();
      } catch {
        // Suppress background errors in daemon
      }
    }, interval);
  }

  /**
   * Stops background interval daemon.
   */
  public stopBatchDaemon(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
  }

  /**
   * Returns list of invoices currently eligible for sweeping.
   */
  public getEligibleInvoices(): InvoiceRecord[] {
    const blockchain = this.blockchain || this.registry.blockchain;
    const list: InvoiceRecord[] = [];
    for (const invoice of this.registry.values()) {
      if (invoice.status === "SWEPT") continue;
      if (!invoice.ephemeralPrivateKey || invoice.ephemeralPrivateKey === ZEROIZED_PRIVATE_KEY) continue;
      const bal = blockchain ? blockchain.getTokenBalance(invoice.tokenAddress, invoice.ephemeralAddress) : 0n;
      if (bal >= this.minSweepThreshold) {
        list.push(invoice);
      }
    }
    return list;
  }
}
