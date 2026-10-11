/**
 * DarkCircle: Enterprise-grade x402 Tumbler for Corporate Privacy
 * Relayer Network & Broadcaster Service Simulation (Quai zone)
 *
 * Implements:
 * - Decoupled transaction broadcast on behalf of corporate spenders
 * - Minimum fee quotes and verification (FEE_BELOW_MINIMUM)
 * - Anti-frontrunning address binding (RELAYER_ADDRESS_MISMATCH_FRONT_RUNNING_DETECTED)
 * - Cryptographic public inputs hash verification (ANTI_FRONT_RUNNING_HASH_MISMATCH)
 * - On-chain transaction logging with msg.sender == relayerAddress
 * - Quai access list (pool + token) attached to every broadcast: a multi-contract transaction sent
 *   without one reverts and burns its entire gas limit on Quai
 */

import { getAddress } from "ethers";
import { Fp } from "../crypto/field.ts";
import { computePublicInputsHash } from "../crypto/unshield.ts";
import { RailgunPool, type RailgunSmartWallet } from "./railgunContract.ts";
import type { SimulatedBlockchain } from "./blockchain.ts";
import type { QuaiAccessListEntry } from "../quai/rpc.ts";
import type {
  UnshieldRequest,
  RelayerQuote,
  RelayerBroadcastResult
} from "../types/sim.ts";

function safeEthersAddress(addr: string): string {
  try {
    return getAddress(addr);
  } catch {
    const clean = addr.toLowerCase().replace(/^0x/, "").padStart(40, "0").slice(0, 40);
    return getAddress("0x" + clean);
  }
}

/**
 * Relayer Network Broadcaster Service.
 */
export class RelayerNetwork {
  public relayerAddress: string = "0xRelayer_Broadcaster_Enterprise";
  public minimumFee: bigint = 5n * 10n ** 17n; // 0.5 WQUAI (18-decimal base units); covers zone gas at QUAI's price
  public pool: RailgunSmartWallet;
  /**
   * Whether the relayer accepts work. An operator can take it offline (maintenance, an incident, low gas);
   * every broadcast and every sweep then refuses with ERR_RELAYER_OFFLINE and nothing is changed.
   */
  public online: boolean = true;
  public offlineReason?: string;
  /** Native QUAI balance below which the checklist warns that a broadcast may fail. */
  public minGasBalance: bigint = 10n ** 18n;

  constructor(
    pool: RailgunSmartWallet,
    relayerAddressOrOptions?: string | { relayerAddress?: string; minimumFee?: bigint },
    minimumFee?: bigint
  ) {
    this.pool = pool;

    if (typeof relayerAddressOrOptions === "string") {
      this.relayerAddress = relayerAddressOrOptions;
      if (minimumFee !== undefined) this.minimumFee = minimumFee;
    } else if (relayerAddressOrOptions && typeof relayerAddressOrOptions === "object") {
      if (relayerAddressOrOptions.relayerAddress) {
        this.relayerAddress = relayerAddressOrOptions.relayerAddress;
      }
      if (relayerAddressOrOptions.minimumFee !== undefined) {
        this.minimumFee = relayerAddressOrOptions.minimumFee;
      }
    }
  }

  /**
   * Returns a fee quote for relaying an unshield payment in the specified token.
   */
  public getQuote(token: string): RelayerQuote {
    return {
      relayerAddress: this.relayerAddress,
      feeToken: token,
      estimatedFeeUnits: this.minimumFee
    };
  }

  /**
   * Sets the relayer's minimum fee threshold.
   */
  public setMinimumFee(fee: bigint): void {
    if (fee < 0n) {
      throw new Error("MINIMUM_FEE_MUST_BE_NON_NEGATIVE");
    }
    this.minimumFee = fee;
  }

  /** Takes the relayer online or offline. The reason is shown to whoever hits the refusal. */
  public setOnline(online: boolean, reason?: string): void {
    this.online = online;
    this.offlineReason = online ? undefined : reason?.trim() || undefined;
  }

  /** Throws ERR_RELAYER_OFFLINE while the relayer is offline. */
  public assertOnline(): void {
    if (!this.online) {
      throw new Error(`ERR_RELAYER_OFFLINE: ${this.offlineReason ?? "the relayer was taken offline by an operator"}`);
    }
  }

  public setMinGasBalance(amount: bigint): void {
    if (amount < 0n) throw new Error("MIN_GAS_BALANCE_MUST_BE_NON_NEGATIVE");
    this.minGasBalance = amount;
  }

  /**
   * Sets the relayer's broadcaster address.
   */
  public setRelayerAddress(addr: string): void {
    this.relayerAddress = addr.trim();
  }

  /**
   * Access list for an unshield broadcast. Mirrors what quai_createAccessList returns for a call that
   * touches the pool and moves a token: one entry per contract.
   */
  public buildAccessList(token: string): QuaiAccessListEntry[] {
    const chain = this.pool.blockchain as { createAccessList?: SimulatedBlockchain["createAccessList"] };
    if (typeof chain.createAccessList === "function") {
      return chain.createAccessList(this.pool.contractAddress, [token]);
    }
    return [
      { address: this.pool.contractAddress.toLowerCase(), storageKeys: [] },
      { address: token.toLowerCase(), storageKeys: [] }
    ];
  }

  /**
   * Broadcasts an unshield transaction to the Shielded Pool on behalf of the client.
   * Ensures front-running binding and records the transaction on-chain as msg.sender == relayerAddress.
   */
  public async broadcastUnshield(req: UnshieldRequest): Promise<RelayerBroadcastResult> {
    // 0. An offline relayer accepts nothing
    this.assertOnline();

    // 1. Fee sufficiency check
    if (req.relayerFee < this.minimumFee) {
      throw new Error("FEE_BELOW_MINIMUM");
    }

    // 2. Anti-frontrunning binding check (relayer address mismatch)
    if (req.relayerAddress.toLowerCase() !== this.relayerAddress.toLowerCase()) {
      throw new Error("RELAYER_ADDRESS_MISMATCH_FRONT_RUNNING_DETECTED");
    }

    // 3. Cryptographic anti-front-running public inputs verification (if present)
    if (req.publicInputsHash) {
      let expectedHash = "";
      try {
        const rootHex =
          typeof req.merkleRoot === "bigint"
            ? Fp.toHex(req.merkleRoot)
            : req.merkleRoot.toString().startsWith("0x")
            ? req.merkleRoot.toString()
            : "0x" + BigInt(req.merkleRoot).toString(16);

        expectedHash = computePublicInputsHash({
          recipient: safeEthersAddress(req.recipient),
          token: safeEthersAddress(req.token),
          amount: req.amount,
          relayerAddress: safeEthersAddress(this.relayerAddress),
          relayerFee: req.relayerFee,
          merkleRoot: rootHex
        });
      } catch {
        expectedHash = "0xinvalid";
      }

      if (expectedHash.toLowerCase() !== req.publicInputsHash.toLowerCase()) {
        throw new Error("ANTI_FRONT_RUNNING_HASH_MISMATCH");
      }
    }

    // 4. Build the Quai access list the broadcast must carry (pool contract + token contract)
    const accessList = this.buildAccessList(req.token);

    // 5. Dispatch unshield through the pool. The pool records the transaction (sender = this relayer,
    //    with the access list it carried) and its Transfer logs.
    const result = this.pool.unshield(req, { sender: this.relayerAddress, accessList });

    return {
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      changeLeafIndex: result.changeLeafIndex,
      relayerAddress: this.relayerAddress,
      status: "confirmed"
    };
  }
}
