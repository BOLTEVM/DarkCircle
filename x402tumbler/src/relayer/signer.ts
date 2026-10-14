/**
 * DarkCircle production relayer: Quai transaction signer
 * File: src/relayer/signer.ts
 *
 * Signs Quai zone transactions in-process from an encrypted keystore. Quai account transactions
 * are NOT EIP-155 transactions: the wire form is RLP([chainId, nonce, gasPrice, gas, to, value,
 * data, accessList, yParity, r, s]) — the recovery id is the bare parity, there is no chain-id-mixed
 * v, and the access list is a first-class field. This matches the encoding used by the quais SDK.
 *
 * GATE (RELAYER_PLAN.md phase 4): the local tests can prove this encoder round-trips and signs
 * deterministically, but they cannot prove go-quai accepts it. Before the first Orchard broadcast,
 * a transaction signed here for fixed inputs MUST be compared byte-for-byte against a known-good
 * reference (quais SDK or the node's own signer). If they differ, stop and fix the encoder first.
 *
 * The key itself is policy-guarded by PermittedCallSigner: it will not sign anything whose `to` is
 * not the configured pool address or whose calldata does not start with the unshield selector.
 * That is the whole answer to "what may the relayer key do" (RELAYER_PLAN.md §3.1).
 */

import fs from "node:fs";
import { Wallet, encodeRlp, encryptKeystoreJson, hexlify, id as keccakId, keccak256, toBeArray, toBigInt, type BigNumberish, type BytesLike, type RlpStructuredData } from "ethers";
import type { PreparedQuaiTransaction, QuaiAccessListEntry } from "../quai/rpc.ts";
import { toQuaiChecksum } from "../quai/address.ts";
import { RelayerError } from "./types.ts";

// The four-byte selector of DarkCirclePool.unshield((uint256[2],uint256[2][2],uint256[2]),(uint256,uint256,uint256,address,uint256,address,uint256)).
export const UNSHIELD_SELECTOR =
  "0x" +
  keccakId(
    "unshield((uint256[2],uint256[2][2],uint256[2]),(uint256,uint256,uint256,address,uint256,address,uint256))"
  ).slice(2, 10);

/** A fully prepared transaction plus the two fields only the sender chooses. */
export interface SignableQuaiTransaction extends PreparedQuaiTransaction {
  nonce: number;
  gasPrice: bigint;
}

export interface QuaiTxSigner {
  readonly address: string;
  /** Returns the RLP-encoded signed transaction, ready for quai_sendRawTransaction. */
  sign(tx: SignableQuaiTransaction): Promise<string>;
}

/**
 * Hex string for one RLP field. Quai RPC hex strings are not guaranteed even-length ("0x0", gas
 * estimates like "0x1d4c0"), and RLP requires whole bytes — normalize everything through here.
 * Returned as a hex string (empty "0x" for zero) to keep the RLP tree type-simple.
 */
function fieldBytes(v: BigNumberish): string {
  if (typeof v === "string" && v.toLowerCase().startsWith("0x")) {
    const h = v.slice(2);
    return "0x" + (h.length % 2 ? "0" + h : h);
  }
  return hexlify(toBeArray(toBigInt(v)));
}

function accessListRlp(list: QuaiAccessListEntry[]): RlpStructuredData[] {
  return list.map((e) => [fieldBytes(toQuaiChecksum(e.address)), e.storageKeys.map(fieldBytes)]);
}

/** The exact unsigned-field order of a Quai transaction. */
function unsignedFields(tx: SignableQuaiTransaction): RlpStructuredData[] {
  return [
    fieldBytes(tx.chainId),
    fieldBytes(tx.nonce),
    fieldBytes(tx.gasPrice),
    fieldBytes(tx.gasLimit),
    fieldBytes(tx.to),
    fieldBytes(tx.value),
    fieldBytes(tx.data),
    accessListRlp(tx.accessList)
  ];
}

/**
 * RLP([chainId, nonce, gasPrice, gas, to, value, data, accessList, yParity, r, s]).
 * Exported for the phase-4 byte-comparison gate and for the fake node in tests.
 */
export function encodeSignedQuaiTransaction(tx: SignableQuaiTransaction, signature: { yParity: number; r: string; s: string }): string {
  return encodeRlp([...unsignedFields(tx), fieldBytes(signature.yParity), fieldBytes(signature.r), fieldBytes(signature.s)]);
}

export function encodeUnsignedQuaiTransaction(tx: SignableQuaiTransaction): string {
  return encodeRlp(unsignedFields(tx));
}

/** A signer backed by an ethers wallet (encrypted keystore or, in tests, a raw key). */
export class WalletQuaiSigner implements QuaiTxSigner {
  public readonly address: string;
  private readonly wallet: Wallet;

  private constructor(wallet: Wallet) {
    this.wallet = wallet;
    this.address = toQuaiChecksum(wallet.address);
  }

  /** Opens an encrypted JSON keystore. The passphrase must come from the environment, never a repo file. */
  public static async fromKeystoreFile(keystorePath: string, passphrase: string): Promise<WalletQuaiSigner> {
    const json = fs.readFileSync(keystorePath, "utf8");
    const wallet = await Wallet.fromEncryptedJson(json, passphrase);
    return new WalletQuaiSigner(new Wallet(wallet.privateKey));
  }

  /** Encrypts a fresh random key into `keystorePath` (scripts/relayer-key.ts). Returns the address. */
  public static async createKeystoreFile(keystorePath: string, passphrase: string): Promise<string> {
    const wallet = Wallet.createRandom();
    // Wallet.encrypt() accepts no scrypt options in this ethers version; the low-level helper does.
    const json = await encryptKeystoreJson(
      { address: wallet.address, privateKey: wallet.privateKey },
      passphrase,
      { scrypt: { N: 1 << 18, r: 8, p: 1 } }
    );
    fs.writeFileSync(keystorePath, json, { mode: 0o600 });
    return toQuaiChecksum(wallet.address);
  }

  /** Test/development helper: a signer from a raw private key, never used with real funds. */
  public static fromPrivateKey(privateKey: string): WalletQuaiSigner {
    return new WalletQuaiSigner(new Wallet(privateKey));
  }

  public async sign(tx: SignableQuaiTransaction): Promise<string> {
    const digest = keccak256(encodeUnsignedQuaiTransaction(tx));
    const sig = this.wallet.signingKey.sign(digest);
    return encodeSignedQuaiTransaction(tx, { yParity: sig.yParity, r: sig.r, s: sig.s });
  }
}

/**
 * The policy guard around any QuaiTxSigner. Signing is allowed only when the transaction goes to
 * the configured pool and carries the unshield selector; anything else is refused with
 * ERR_SIGNER_POLICY. This is defence in depth: even code that somehow reaches the signer cannot
 * move the funded key's QUAI anywhere else.
 */
export class PermittedCallSigner implements QuaiTxSigner {
  public readonly address: string;
  private readonly inner: QuaiTxSigner;
  private readonly poolAddress: string;
  private readonly permittedSelector: string;

  constructor(inner: QuaiTxSigner, poolAddress: string, permittedSelector: string = UNSHIELD_SELECTOR) {
    this.inner = inner;
    this.poolAddress = poolAddress;
    this.permittedSelector = permittedSelector;
    this.address = inner.address;
  }

  public async sign(tx: SignableQuaiTransaction): Promise<string> {
    if (toQuaiChecksum(tx.to).toLowerCase() !== toQuaiChecksum(this.poolAddress).toLowerCase()) {
      throw new RelayerError("ERR_SIGNER_POLICY", `refusing to sign a call to ${tx.to}`);
    }
    if (!tx.data.toLowerCase().startsWith(this.permittedSelector.toLowerCase())) {
      throw new RelayerError("ERR_SIGNER_POLICY", "refusing to sign calldata that is not an unshield call");
    }
    return this.inner.sign(tx);
  }
}
