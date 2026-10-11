/**
 * ERC-20 token simulation for Quai account-ledger assets (WQUAI, WQI) with EVM calldata dispatch.
 * DarkCircle Protocol
 *
 * Mirrors the two contracts deployed on Quai Cyprus-1:
 *   WQUAI - WETH9-style: deposit() payable / withdraw(uint256), no permit.
 *   WQI   - EIP-2612 permit, no deposit/withdraw.
 */

import crypto from "node:crypto";
import { ethers } from "ethers";
import type {
  IERC20,
  SimContract,
  SimTransaction,
  SimLog,
  ERC20Event,
  ERC20ContractView
} from "../types/sim.ts";
import { SimulatedBlockchain } from "./blockchain.ts";
import { WQUAI, WQI } from "../quai/tokens.ts";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Quai Cyprus-1 settlement asset addresses (lowercase, as stored in the simulated ledger).
export const WQUAI_ADDRESS = WQUAI.address.toLowerCase();
export const WQI_ADDRESS = WQI.address.toLowerCase();

// Canonical EVM Event Topics
export const TOPIC_TRANSFER = ethers.id("Transfer(address,address,uint256)");
export const TOPIC_APPROVAL = ethers.id("Approval(address,address,uint256)");

// Canonical ERC-20 + EIP-2612 ABI for EVM Calldata Dispatch
export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function mint(address to, uint256 value)",
  "function burn(address from, uint256 value)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)"
];

/** EIP-2612 typed data. WQI's deployed contract uses exactly this struct. */
export const PERMIT_TYPES = {
  Permit: [
    { name: "owner", type: "address" },
    { name: "spender", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};

function safeGetAddress(addr: string): string {
  try {
    return ethers.getAddress(addr);
  } catch {
    const clean = addr.toLowerCase().replace(/^0x/, "").padStart(40, "0").slice(0, 40);
    return ethers.getAddress("0x" + clean);
  }
}

export class ERC20Token implements IERC20, SimContract {
  public readonly name: string;
  public readonly symbol: string;
  public readonly decimals: number;
  public readonly address: string;
  public blockchain: SimulatedBlockchain;
  public events: ERC20Event[] = [];
  /** WETH9-style deposit()/withdraw(uint256) that wraps the chain's native QUAI (WQUAI). */
  public wrapsNative: boolean = false;
  /** EIP-2612 permit(). WQUAI's deployed bytecode has none; WQI does. Generic tokens default to true. */
  public supportsPermit: boolean = true;
  /**
   * Whether unauthenticated mint()/burn() calldata is honoured. Generic simulation tokens allow it as
   * a faucet; the WQUAI/WQI contracts on Quai expose no such selectors, so their factories turn it off
   * (the JS-level mint() remains available to seed test balances).
   */
  public calldataMint: boolean = true;

  private _totalSupply: bigint = 0n;
  private _nonces: Map<string, bigint> = new Map();
  private _interface: ethers.Interface;

  /**
   * Flexible constructor supporting both:
   * 1. (name, symbol, decimals, blockchain?, address?)
   * 2. (blockchain, name, symbol, decimals, address?)
   */
  constructor(
    nameOrBlockchain: string | SimulatedBlockchain,
    symbolOrName?: string,
    decimalsOrSymbol?: number | string,
    blockchainOrDecimals?: SimulatedBlockchain | number,
    addressOrBlockchain?: string | SimulatedBlockchain,
    address?: string
  ) {
    if (typeof nameOrBlockchain !== "string") {
      // Convention: (blockchain, name, symbol, decimals, address)
      this.blockchain = nameOrBlockchain;
      this.name = symbolOrName || "ERC20 Token";
      this.symbol = (decimalsOrSymbol as string) || "ERC20";
      this.decimals = typeof blockchainOrDecimals === "number" ? blockchainOrDecimals : 18;
      const addr = typeof addressOrBlockchain === "string" ? addressOrBlockchain : undefined;
      this.address = (addr ?? ERC20Token.deriveTokenAddress(this.symbol, this.name)).toLowerCase();
    } else {
      // Convention: (name, symbol, decimals, blockchain?, address?)
      this.name = nameOrBlockchain;
      this.symbol = symbolOrName || "ERC20";
      this.decimals = typeof decimalsOrSymbol === "number" ? decimalsOrSymbol : 18;
      this.blockchain =
        blockchainOrDecimals instanceof SimulatedBlockchain
          ? blockchainOrDecimals
          : new SimulatedBlockchain();
      const addr = typeof addressOrBlockchain === "string" ? addressOrBlockchain : address;
      this.address = (addr ?? ERC20Token.deriveTokenAddress(this.symbol, this.name)).toLowerCase();
    }

    this._interface = new ethers.Interface(ERC20_ABI);
    this.blockchain.registerToken(this);
  }

  /**
   * Static factory methods for the Quai Cyprus-1 settlement assets.
   */
  public static createWQUAI(blockchain?: SimulatedBlockchain): ERC20Token {
    const token = new ERC20Token(WQUAI.name, WQUAI.symbol, WQUAI.decimals, blockchain, WQUAI_ADDRESS);
    token.wrapsNative = WQUAI.wrapsNative;
    token.supportsPermit = WQUAI.permit;
    token.calldataMint = false;
    return token;
  }

  public static createWQI(blockchain?: SimulatedBlockchain): ERC20Token {
    const token = new ERC20Token(WQI.name, WQI.symbol, WQI.decimals, blockchain, WQI_ADDRESS);
    token.wrapsNative = WQI.wrapsNative;
    token.supportsPermit = WQI.permit;
    token.calldataMint = false;
    return token;
  }

  public static deriveTokenAddress(symbol: string, name: string): string {
    return (
      "0x" +
      crypto
        .createHash("sha256")
        .update(`erc20:${symbol.toUpperCase()}:${name}`)
        .digest("hex")
        .slice(0, 40)
    );
  }

  public totalSupply(): bigint {
    return this._totalSupply;
  }

  public balanceOf(account: string): bigint {
    return this.blockchain.getTokenBalance(this.address, account);
  }

  public nonces(owner: string): bigint {
    return this._nonces.get(owner.toLowerCase()) || 0n;
  }

  /**
   * EIP-712 domain for permit signatures. For WQI this hashes to the live contract's DOMAIN_SEPARATOR
   * (read from Cyprus-1 on 2026-09-21: name "Wrapped Qi", version "1", chain 9, the WQI address).
   */
  public permitDomain(): { name: string; version: string; chainId: number; verifyingContract: string } {
    return {
      name: this.name,
      version: "1",
      chainId: this.blockchain.chainId,
      verifyingContract: safeGetAddress(this.address)
    };
  }

  /**
   * Canonical EIP-712 DOMAIN_SEPARATOR
   */
  public DOMAIN_SEPARATOR(): string {
    return ethers.TypedDataEncoder.hashDomain(this.permitDomain());
  }

  /**
   * Standard ERC-20 transfer.
   * Polymorphic: supports transfer(to, amount, from?) and transfer(from, to, amount).
   */
  public transfer(
    toOrFrom: string,
    amountOrTo: bigint | string,
    fromOrAmount?: string | bigint
  ): boolean {
    let from: string;
    let to: string;
    let amount: bigint;

    if (typeof amountOrTo === "string" && typeof fromOrAmount === "bigint") {
      from = toOrFrom;
      to = amountOrTo;
      amount = fromOrAmount;
    } else if (typeof amountOrTo === "bigint") {
      to = toOrFrom;
      amount = amountOrTo;
      if (typeof fromOrAmount === "string") {
        from = fromOrAmount;
      } else {
        throw new Error("ERC20_TRANSFER_SENDER_REQUIRED: Provide 'from' address or use connect(signer)");
      }
    } else {
      throw new Error("INVALID_TRANSFER_ARGUMENTS");
    }

    if (amount < 0n) throw new Error("TRANSFER_AMOUNT_CANNOT_BE_NEGATIVE");

    const success = this.blockchain.transferToken(this.address, from, to, amount);
    if (success) {
      this._emitTransferEvent(from, to, amount);
    }
    return success;
  }

  /**
   * Standard ERC-20 approve.
   * Polymorphic: supports approve(spender, amount, owner?) and approve(owner, spender, amount).
   */
  public approve(
    spenderOrOwner: string,
    amountOrSpender: bigint | string,
    ownerOrAmount?: string | bigint
  ): boolean {
    let owner: string;
    let spender: string;
    let amount: bigint;

    if (typeof amountOrSpender === "string" && typeof ownerOrAmount === "bigint") {
      owner = spenderOrOwner;
      spender = amountOrSpender;
      amount = ownerOrAmount;
    } else if (typeof amountOrSpender === "bigint") {
      spender = spenderOrOwner;
      amount = amountOrSpender;
      if (typeof ownerOrAmount === "string") {
        owner = ownerOrAmount;
      } else {
        throw new Error("ERC20_APPROVE_OWNER_REQUIRED: Provide 'owner' address or use connect(signer)");
      }
    } else {
      throw new Error("INVALID_APPROVE_ARGUMENTS");
    }

    if (amount < 0n) throw new Error("APPROVE_AMOUNT_CANNOT_BE_NEGATIVE");

    this.blockchain.setTokenAllowance(this.address, owner, spender, amount);
    this._emitApprovalEvent(owner, spender, amount);
    return true;
  }

  public allowance(owner: string, spender: string): bigint {
    return this.blockchain.getTokenAllowance(this.address, owner, spender);
  }

  /**
   * Standard ERC-20 transferFrom.
   * If spender is provided, enforces allowance check and decrements allowance.
   */
  public transferFrom(
    from: string,
    to: string,
    amount: bigint,
    spender?: string
  ): boolean {
    if (amount < 0n) throw new Error("TRANSFER_AMOUNT_CANNOT_BE_NEGATIVE");

    let success: boolean;
    if (spender) {
      const currentAllowance = this.allowance(from, spender);
      if (currentAllowance < amount) {
        throw new Error("ERC20_TRANSFER_FROM_ALLOWANCE_EXCEEDED: ALLOWANCE_EXCEEDED");
      }
      success = this.blockchain.transferFromToken(this.address, spender, from, to, amount);
    } else {
      success = this.blockchain.transferToken(this.address, from, to, amount);
    }

    if (success) {
      this._emitTransferEvent(from, to, amount);
    }
    return success;
  }

  public mint(to: string, amount: bigint): void {
    if (amount < 0n) throw new Error("MINT_AMOUNT_CANNOT_BE_NEGATIVE");
    this.blockchain.mintToken(this.address, to, amount);
    this._emitTransferEvent(ZERO_ADDRESS, to, amount);
  }

  public burn(from: string, amount: bigint): void {
    if (amount < 0n) throw new Error("BURN_AMOUNT_CANNOT_BE_NEGATIVE");
    const success = this.blockchain.burnToken(this.address, from, amount);
    if (!success) {
      throw new Error("ERC20_BURN_EXCEEDS_BALANCE: INSUFFICIENT_BALANCE_TO_BURN");
    }
    this._emitTransferEvent(from, ZERO_ADDRESS, amount);
  }

  /**
   * WETH9 deposit: moves `value` native QUAI from `account` into the token contract and mints the
   * same amount of WQUAI to `account`, keeping totalSupply backed 1:1 by held QUAI.
   */
  public deposit(account: string, value: bigint): void {
    if (!this.wrapsNative) throw new Error("ERC20_DEPOSIT_UNSUPPORTED");
    if (value < 0n) throw new Error("DEPOSIT_AMOUNT_CANNOT_BE_NEGATIVE");
    if (!this.blockchain.transferNative(account, this.address, value)) {
      throw new Error("INSUFFICIENT_NATIVE_BALANCE");
    }
    this.mint(account, value);
  }

  /** WETH9 withdraw: burns `value` WQUAI from `account` and returns native QUAI from the contract. */
  public withdraw(account: string, value: bigint): void {
    if (!this.wrapsNative) throw new Error("ERC20_WITHDRAW_UNSUPPORTED");
    if (value < 0n) throw new Error("WITHDRAW_AMOUNT_CANNOT_BE_NEGATIVE");
    this.burn(account, value);
    if (!this.blockchain.transferNative(this.address, account, value)) {
      throw new Error("TOKEN_CONTRACT_NATIVE_BALANCE_SHORT");
    }
  }

  /**
   * Cryptographic EIP-2612 Permit Implementation
   * Validates secp256k1 signature over canonical EIP-712 digest.
   */
  public permit(
    owner: string,
    spender: string,
    value: bigint,
    deadline: number,
    v: number,
    r: string,
    s: string
  ): boolean {
    if (!this.supportsPermit) throw new Error("ERC20_PERMIT_UNSUPPORTED");
    if (value < 0n) throw new Error("PERMIT_VALUE_CANNOT_BE_NEGATIVE");

    const currentBlockTimestamp = this.blockchain.latestBlock.timestamp;
    if (currentBlockTimestamp > deadline) {
      throw new Error("ERC20_PERMIT_EXPIRED");
    }

    const ownerNorm = owner.toLowerCase();
    const currentNonce = this.nonces(ownerNorm);

    const domain = this.permitDomain();
    const types = PERMIT_TYPES;

    const values = {
      owner: safeGetAddress(owner),
      spender: safeGetAddress(spender),
      value,
      nonce: currentNonce,
      deadline
    };

    // Compute canonical EIP-712 digest
    const digest = ethers.TypedDataEncoder.hash(domain, types, values);

    // Recover signer address via elliptic curve cryptography
    const recovered = ethers.recoverAddress(digest, { r, s, v });
    if (recovered.toLowerCase() !== ownerNorm) {
      throw new Error("ERC20_PERMIT_INVALID_SIGNATURE");
    }

    // Increment nonce
    this._nonces.set(ownerNorm, currentNonce + 1n);

    // Set allowance and emit Approval
    this.blockchain.setTokenAllowance(this.address, owner, spender, value);
    this._emitApprovalEvent(owner, spender, value);

    return true;
  }

  /**
   * Ergonomic Connected Contract View
   */
  public connect(signerAddress: string): ERC20ContractView {
    const signer = signerAddress.toLowerCase();
    return {
      address: this.address,
      name: this.name,
      symbol: this.symbol,
      decimals: this.decimals,
      signer,
      balanceOf: () => this.balanceOf(signer),
      transfer: (to: string, amount: bigint) => this.transfer(to, amount, signer),
      approve: (spender: string, amount: bigint) => this.approve(spender, amount, signer),
      allowance: (spender: string) => this.allowance(signer, spender),
      transferFrom: (from: string, to: string, amount: bigint) =>
        this.transferFrom(from, to, amount, signer),
      permit: (spender: string, value: bigint, deadline: number, v: number, r: string, s: string) =>
        this.permit(signer, spender, value, deadline, v, r, s)
    };
  }

  /**
   * EVM Calldata Dispatcher: handleTransaction
   */
  public handleTransaction(tx: SimTransaction): {
    status: 1 | 0;
    logs: SimLog[];
    returnData: string;
    error?: string;
  } {
    if (!tx.data || tx.data === "0x") {
      return { status: 1, logs: [], returnData: "0x" };
    }

    try {
      const parsed = this._interface.parseTransaction({ data: tx.data });
      if (!parsed) {
        return { status: 0, logs: [], returnData: "0x", error: "UNKNOWN_FUNCTION_SELECTOR" };
      }

      const prevLogsCount = this.events.length;
      let returnVal: any;

      switch (parsed.name) {
        case "transfer": {
          const [to, value] = parsed.args;
          returnVal = this.transfer(to, BigInt(value), tx.from);
          break;
        }
        case "transferFrom": {
          const [from, to, value] = parsed.args;
          returnVal = this.transferFrom(from, to, BigInt(value), tx.from);
          break;
        }
        case "approve": {
          const [spender, value] = parsed.args;
          returnVal = this.approve(spender, BigInt(value), tx.from);
          break;
        }
        case "deposit": {
          // tx.value was already moved to this contract's native balance by the ledger.
          if (!this.wrapsNative) throw new Error("ERC20_DEPOSIT_UNSUPPORTED");
          this.mint(tx.from, tx.value);
          returnVal = undefined;
          break;
        }
        case "withdraw": {
          const [wad] = parsed.args;
          this.withdraw(tx.from, BigInt(wad));
          returnVal = undefined;
          break;
        }
        case "mint": {
          if (!this.calldataMint) throw new Error("UNSUPPORTED_WRITE_METHOD: mint");
          const [to, value] = parsed.args;
          this.mint(to, BigInt(value));
          returnVal = undefined;
          break;
        }
        case "burn": {
          if (!this.calldataMint) throw new Error("UNSUPPORTED_WRITE_METHOD: burn");
          const [from, value] = parsed.args;
          this.burn(from, BigInt(value));
          returnVal = undefined;
          break;
        }
        case "permit": {
          const [owner, spender, value, deadline, v, r, s] = parsed.args;
          returnVal = this.permit(
            owner,
            spender,
            BigInt(value),
            Number(deadline),
            Number(v),
            r,
            s
          );
          break;
        }
        default:
          return { status: 0, logs: [], returnData: "0x", error: `UNSUPPORTED_WRITE_METHOD: ${parsed.name}` };
      }

      const encodedReturn =
        returnVal !== undefined
          ? this._interface.encodeFunctionResult(parsed.name, [returnVal])
          : "0x";

      // Convert newly emitted events to EVM logs
      const newEvents = this.events.slice(prevLogsCount);
      const logs: SimLog[] = newEvents.map((evt) => this._toSimLog(evt, tx.hash));

      return { status: 1, logs, returnData: encodedReturn };
    } catch (err: any) {
      return { status: 0, logs: [], returnData: "0x", error: err?.message || "EXECUTION_REVERTED" };
    }
  }

  /**
   * EVM Calldata Dispatcher: handleCall (Read-Only)
   */
  public handleCall(data: string, from?: string): string {
    const parsed = this._interface.parseTransaction({ data });
    if (!parsed) {
      throw new Error("UNKNOWN_FUNCTION_SELECTOR");
    }

    let result: any;
    switch (parsed.name) {
      case "name":
        result = this.name;
        break;
      case "symbol":
        result = this.symbol;
        break;
      case "decimals":
        result = this.decimals;
        break;
      case "totalSupply":
        result = this.totalSupply();
        break;
      case "balanceOf":
        result = this.balanceOf(parsed.args[0]);
        break;
      case "allowance":
        result = this.allowance(parsed.args[0], parsed.args[1]);
        break;
      case "nonces":
        result = this.nonces(parsed.args[0]);
        break;
      case "DOMAIN_SEPARATOR":
        result = this.DOMAIN_SEPARATOR();
        break;
      default:
        throw new Error(`UNSUPPORTED_READ_METHOD: ${parsed.name}`);
    }

    return this._interface.encodeFunctionResult(parsed.name, [result]);
  }

  /**
   * Internal supply synchronization
   */
  public _addTotalSupply(amount: bigint): void {
    this._totalSupply += amount;
  }

  public _subTotalSupply(amount: bigint): void {
    this._totalSupply -= amount;
  }

  private _emitTransferEvent(from: string, to: string, value: bigint): void {
    const evt: ERC20Event = {
      event: "Transfer",
      token: this.address,
      from: from.toLowerCase(),
      to: to.toLowerCase(),
      value,
      blockNumber: this.blockchain.currentBlockNumber,
      timestamp: this.blockchain.latestBlock.timestamp
    };
    this.events.push(evt);
  }

  private _emitApprovalEvent(owner: string, spender: string, value: bigint): void {
    const evt: ERC20Event = {
      event: "Approval",
      token: this.address,
      owner: owner.toLowerCase(),
      spender: spender.toLowerCase(),
      value,
      blockNumber: this.blockchain.currentBlockNumber,
      timestamp: this.blockchain.latestBlock.timestamp
    };
    this.events.push(evt);
  }

  private _toSimLog(evt: ERC20Event, txHash: string): SimLog {
    if (evt.event === "Transfer") {
      return {
        address: this.address,
        topics: [
          TOPIC_TRANSFER,
          ethers.zeroPadValue(evt.from || ZERO_ADDRESS, 32),
          ethers.zeroPadValue(evt.to || ZERO_ADDRESS, 32)
        ],
        data: ethers.toBeHex(evt.value, 32),
        blockNumber: evt.blockNumber,
        transactionHash: txHash
      };
    } else {
      return {
        address: this.address,
        topics: [
          TOPIC_APPROVAL,
          ethers.zeroPadValue(evt.owner || ZERO_ADDRESS, 32),
          ethers.zeroPadValue(evt.spender || ZERO_ADDRESS, 32)
        ],
        data: ethers.toBeHex(evt.value, 32),
        blockNumber: evt.blockNumber,
        transactionHash: txHash
      };
    }
  }
}
