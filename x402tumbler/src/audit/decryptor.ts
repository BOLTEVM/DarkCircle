import crypto from "node:crypto";
import {
  BABYJUBJUB_L,
  GENERATOR,
  isInPrimeSubgroup,
  mod,
  scalarMult
} from "../crypto/babyjubjub.ts";
import type { Point } from "../types/crypto.ts";
import type {
  DecryptedNotePayload,
  EncryptedNotePayload
} from "../types/audit.ts";

export type { DecryptedNotePayload, EncryptedNotePayload };

/**
 * Encrypts a note payload to the recipient's viewing public key (vpk)
 * using ECDH on BabyJubjub + HKDF-SHA256 + ChaCha20-Poly1305 AEAD.
 */
export function encryptNotePayload(
  recipientVpk: Point,
  payload: DecryptedNotePayload
): EncryptedNotePayload {
  if (!isInPrimeSubgroup(recipientVpk)) {
    throw new Error("ERR_NOTE_RECIPIENT_KEY_INVALID: viewing public key is not a prime-order curve point");
  }
  // 1. Generate ephemeral key pair
  const ephPrivBytes = crypto.randomBytes(32);
  const ephPriv = mod(BigInt("0x" + ephPrivBytes.toString("hex")), BABYJUBJUB_L);
  const ephPub = scalarMult(ephPriv, GENERATOR);

  // 2. ECDH Shared Secret: S = ephPriv * recipientVpk
  const sharedPoint = scalarMult(ephPriv, recipientVpk);
  const sharedXHex = sharedPoint[0].toString(16).padStart(64, "0");

  // 3. Derive symmetric key via HKDF
  const encKeyBuffer = crypto.hkdfSync(
    "sha256",
    Buffer.from(sharedXHex, "hex"),
    Buffer.from("DarkCircle-Note-v1"),
    Buffer.from("NoteEncryptionKey"),
    32
  );
  const encKey = Buffer.from(encKeyBuffer);

  // 4. ChaCha20-Poly1305 AEAD Encryption
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("chacha20-poly1305", encKey, nonce, { authTagLength: 16 });
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ephemeralPubKey: [ephPub[0].toString(16), ephPub[1].toString(16)],
    nonce: nonce.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    authTag: authTag.toString("hex")
  };
}

/**
 * Decrypts a note payload using the auditor's viewing private key (vsk).
 * Returns null if the note was encrypted for a different key, corrupted, or tampered.
 */
export function decryptNotePayload(
  vsk: bigint,
  encrypted: EncryptedNotePayload
): DecryptedNotePayload | null {
  try {
    const ephPub: Point = [
      BigInt("0x" + encrypted.ephemeralPubKey[0]),
      BigInt("0x" + encrypted.ephemeralPubKey[1])
    ];

    // Reject small-order and off-subgroup points: they make the ECDH secret take at most 8 values.
    if (!isInPrimeSubgroup(ephPub)) return null;

    const sharedPoint = scalarMult(vsk, ephPub);
    const sharedXHex = sharedPoint[0].toString(16).padStart(64, "0");

    const encKeyBuffer = crypto.hkdfSync(
      "sha256",
      Buffer.from(sharedXHex, "hex"),
      Buffer.from("DarkCircle-Note-v1"),
      Buffer.from("NoteEncryptionKey"),
      32
    );
    const encKey = Buffer.from(encKeyBuffer);

    const nonce = Buffer.from(encrypted.nonce, "hex");
    const ciphertext = Buffer.from(encrypted.ciphertext, "hex");
    const authTag = Buffer.from(encrypted.authTag, "hex");

    const decipher = crypto.createDecipheriv("chacha20-poly1305", encKey, nonce, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    return JSON.parse(plaintext.toString("utf8")) as DecryptedNotePayload;
  } catch {
    return null; // Note not intended for this viewing key or authentication failed
  }
}

export interface DiscoveredNote {
  commitment: string;
  txHash: string;
  blockNumber: number;
  payload: DecryptedNotePayload;
}

/**
 * Scans a stream of encrypted note payloads and recovers notes belonging to the viewing key.
 */
export class TransactionDiscoveryScanner {
  public readonly vsk: bigint;

  constructor(vsk: bigint) {
    this.vsk = vsk;
  }

  public scan(
    records: Array<{
      commitment: string;
      txHash: string;
      blockNumber: number;
      encrypted: EncryptedNotePayload;
    }>
  ): DiscoveredNote[] {
    const discovered: DiscoveredNote[] = [];
    for (const record of records) {
      const decrypted = decryptNotePayload(this.vsk, record.encrypted);
      if (decrypted) {
        discovered.push({
          commitment: record.commitment,
          txHash: record.txHash,
          blockNumber: record.blockNumber,
          payload: decrypted
        });
      }
    }
    return discovered;
  }
}
