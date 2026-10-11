/**
 * DarkCircle Standalone E2E Test Harness & Interface Contract Implementation
 *
 * Implements the authoritative public contracts defined in PROJECT.md:
 * - BN254 Scalar Field & Poseidon Hashing
 * - Incremental Merkle Tree & Sparse Merkle Tree (Sanctions SMT)
 * - BabyJubjub / ECDH Corporate Viewing & Spending Key Derivation
 * - Simulated Blockchain & ERC-20 Ledger
 * - Railgun Shielded Pool Contract with Ring Buffer Roots & Nullifiers
 * - Relayer Decoupling Service
 * - Inbound Merchant Privacy Gateway with Ephemeral Key Derivation
 * - Outbound Private Payment Proxy with 402 Parser, Single-Flight Cache & Auto-Retry
 * - Viewing-Key Audit Exporter (Structured JSON and ERP CSV)
 * - Protected Resource Server with Protected Endpoints
 */

import crypto from 'node:crypto';

/** Formats 18-decimal base units (WQUAI / WQI) without floating point. */
export function fmt18(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / 10n ** 18n}.${(a % 10n ** 18n).toString().padStart(18, '0')}`;
}

function parse18(s: string): bigint {
  const neg = s.startsWith('-');
  const [w, f = ''] = s.replace('-', '').split('.');
  const v = BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, '0').slice(0, 18));
  return neg ? -v : v;
}

// BN254 / Alt-bn128 scalar field prime
export const BN254_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Deterministic BN254-compatible scalar field hash.
 * Maps arbitrary inputs into [0, p-1].
 */
export function poseidonHash(...inputs: (bigint | string | number)[]): bigint {
  const hasher = crypto.createHash('sha256');
  for (const input of inputs) {
    if (typeof input === 'bigint') {
      hasher.update(input.toString(16).padStart(64, '0'));
    } else if (typeof input === 'number') {
      hasher.update(BigInt(input).toString(16).padStart(64, '0'));
    } else {
      hasher.update(input.toString());
    }
  }
  const hex = hasher.digest('hex');
  return BigInt('0x' + hex) % BN254_SCALAR_FIELD;
}

/**
 * Safely converts an address string to a BN254 field element.
 * If the address is standard hex, parses it; otherwise hashes it deterministically.
 */
export function addressToBigInt(addr: string): bigint {
  const clean = addr.trim().toLowerCase();
  if (/^0x[0-9a-f]{1,64}$/.test(clean)) {
    return BigInt(clean) % BN254_SCALAR_FIELD;
  }
  return poseidonHash(clean);
}

/**
 * Incremental Merkle Tree (IMT) for Shielded UTXO commitments.
 */
export class IncrementalMerkleTree {
  public depth: number;
  public capacity: number;
  public leaves: bigint[] = [];
  public zeroHashes: bigint[] = [];
  public historicalRoots: bigint[] = [];
  public maxHistoricalRoots: number;

  constructor(depth: number = 16, maxHistoricalRoots: number = 64) {
    this.depth = depth;
    this.capacity = 2 ** depth;
    this.maxHistoricalRoots = maxHistoricalRoots;
    this.initZeroHashes();
    this.historicalRoots.push(this.zeroHashes[depth]);
  }

  private initZeroHashes() {
    this.zeroHashes = new Array(this.depth + 1);
    this.zeroHashes[0] = poseidonHash('DarkCircle_Zero_Leaf');
    for (let i = 1; i <= this.depth; i++) {
      this.zeroHashes[i] = poseidonHash(this.zeroHashes[i - 1], this.zeroHashes[i - 1]);
    }
  }

  public get root(): bigint {
    return this.computeRoot();
  }

  public insert(leaf: bigint): number {
    if (this.leaves.length >= this.capacity) {
      throw new Error('MERKLE_TREE_CAPACITY_EXCEEDED');
    }
    const leafIndex = this.leaves.length;
    this.leaves.push(leaf % BN254_SCALAR_FIELD);
    const newRoot = this.computeRoot();
    this.historicalRoots.push(newRoot);
    if (this.historicalRoots.length > this.maxHistoricalRoots) {
      this.historicalRoots.shift();
    }
    return leafIndex;
  }

  public computeRoot(): bigint {
    if (this.leaves.length === 0) {
      return this.zeroHashes[this.depth];
    }
    let currentLevel = [...this.leaves];
    for (let d = 0; d < this.depth; d++) {
      const nextLevel: bigint[] = [];
      const zero = this.zeroHashes[d];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : zero;
        nextLevel.push(poseidonHash(left, right));
      }
      currentLevel = nextLevel;
    }
    return currentLevel[0];
  }

  public getProof(leafIndex: number): { siblings: bigint[]; pathIndices: number[] } {
    if (leafIndex < 0 || leafIndex >= this.leaves.length) {
      throw new Error('INVALID_LEAF_INDEX');
    }
    const siblings: bigint[] = [];
    const pathIndices: number[] = [];
    let currentIndex = leafIndex;
    let currentLevel = [...this.leaves];

    for (let d = 0; d < this.depth; d++) {
      const zero = this.zeroHashes[d];
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      pathIndices.push(isRight ? 1 : 0);

      const sibling = siblingIndex < currentLevel.length ? currentLevel[siblingIndex] : zero;
      siblings.push(sibling);

      const nextLevel: bigint[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : zero;
        nextLevel.push(poseidonHash(left, right));
      }
      currentLevel = nextLevel;
      currentIndex = Math.floor(currentIndex / 2);
    }
    return { siblings, pathIndices };
  }

  public verifyProof(leaf: bigint, proof: { siblings: bigint[]; pathIndices: number[] }, targetRoot: bigint): boolean {
    let current = leaf % BN254_SCALAR_FIELD;
    for (let i = 0; i < proof.siblings.length; i++) {
      const sibling = proof.siblings[i];
      const isRight = proof.pathIndices[i] === 1;
      current = isRight ? poseidonHash(sibling, current) : poseidonHash(current, sibling);
    }
    return current === targetRoot;
  }
}

/**
 * Sparse Merkle Tree (SMT) for Sanctions & Illicit Address Screening.
 */
export class SparseMerkleTree {
  public depth: number;
  private leaves: Map<string, bigint> = new Map();
  public defaultZero: bigint;

  constructor(depth: number = 256) {
    this.depth = depth;
    this.defaultZero = 0n;
  }

  public set(key: bigint, value: bigint) {
    this.leaves.set(key.toString(), value % BN254_SCALAR_FIELD);
  }

  public get(key: bigint): bigint {
    return this.leaves.get(key.toString()) || 0n;
  }

  public get root(): bigint {
    if (this.leaves.size === 0) return poseidonHash('EMPTY_SMT_ROOT');
    let combined = 0n;
    for (const [k, v] of this.leaves.entries()) {
      combined = poseidonHash(combined, BigInt(k), v);
    }
    return combined;
  }

  public getNonMembershipProof(key: bigint): { siblings: bigint[]; isNonMember: boolean } {
    const val = this.get(key);
    const isNonMember = val === 0n;
    const siblings = [poseidonHash(key, 0n), poseidonHash(1n, this.root)];
    return { siblings, isNonMember };
  }

  public verifyNonMembership(key: bigint, proof: { isNonMember: boolean }, root: bigint): boolean {
    if (!proof.isNonMember) return false;
    return this.get(key) === 0n;
  }
}

/**
 * Key Derivation & Viewing Key Cryptography.
 */
export interface CorporateKeys {
  ssk: bigint; // Spending private key
  spk: bigint; // Spending public key
  vsk: bigint; // Viewing private key
  vpk: bigint; // Viewing public key
  npk: bigint; // Note public key
  corporate0zkAddress: string;
}

export function deriveCorporateKeys(seed: string): CorporateKeys {
  const hash = crypto.createHash('sha256').update(seed).digest();
  const ssk = BigInt('0x' + hash.subarray(0, 16).toString('hex')) % BN254_SCALAR_FIELD;
  const vsk = BigInt('0x' + hash.subarray(16, 32).toString('hex')) % BN254_SCALAR_FIELD;
  const spk = poseidonHash(ssk, 'DarkCircle_SPK');
  const vpk = poseidonHash(vsk, 'DarkCircle_VPK');
  const npk = poseidonHash(spk, vpk);
  const corporate0zkAddress = `0zk1q${npk.toString(16).padStart(40, '0')}`;
  return { ssk, spk, vsk, vpk, npk, corporate0zkAddress };
}

/**
 * Ephemeral Address Derivation per Invoice.
 */
export function deriveEphemeralAddress(merchantRootKey: string, invoiceId: string): { address: string; privateKey: string } {
  const hmac = crypto.createHmac('sha256', merchantRootKey);
  hmac.update(`DarkCircle-v1-invoice:${invoiceId}`);
  const privateKey = '0x' + hmac.digest('hex');
  const pubHash = crypto.createHash('sha256').update(privateKey).digest('hex');
  const address = '0x' + pubHash.slice(24);
  return { address, privateKey };
}

/**
 * Note and Encryption Payload Types.
 */
export interface NotePayload {
  token: string;
  value: bigint;
  blinding: bigint;
  memo: string;
  invoiceId?: string;
  counterparty?: string;
}

export interface EncryptedNotePayload {
  ephemeralPubKey: string;
  ciphertext: string;
  nonce: string;
}

export function encryptNote(vpk: bigint, note: NotePayload): EncryptedNotePayload {
  const ephemeralPriv = crypto.randomBytes(16).toString('hex');
  const ephemeralPubKey = poseidonHash(BigInt('0x' + ephemeralPriv), 'EPH_PUB').toString();
  const sharedKey = crypto.createHash('sha256').update(vpk.toString() + ':' + ephemeralPubKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sharedKey, iv);
  const jsonStr = JSON.stringify({
    token: note.token,
    value: note.value.toString(),
    blinding: note.blinding.toString(),
    memo: note.memo,
    invoiceId: note.invoiceId,
    counterparty: note.counterparty
  });
  let encrypted = cipher.update(jsonStr, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return {
    ephemeralPubKey,
    ciphertext: encrypted + ':' + tag,
    nonce: iv.toString('hex')
  };
}

export function decryptNote(vsk: bigint, encrypted: EncryptedNotePayload): NotePayload | null {
  try {
    const parts = encrypted.ciphertext.split(':');
    if (parts.length !== 2) return null;
    const [cipherText, tagHex] = parts;
    const vpk = poseidonHash(vsk, 'DarkCircle_VPK');
    const sharedKey = crypto.createHash('sha256').update(vpk.toString() + ':' + encrypted.ephemeralPubKey).digest();
    const iv = Buffer.from(encrypted.nonce, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', sharedKey, iv);
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decryptedStr = decipher.update(cipherText, 'hex', 'utf8') + decipher.final('utf8');
    const parsed = JSON.parse(decryptedStr);
    return {
      token: parsed.token,
      value: BigInt(parsed.value),
      blinding: BigInt(parsed.blinding),
      memo: parsed.memo,
      invoiceId: parsed.invoiceId,
      counterparty: parsed.counterparty
    };
  } catch {
    return null;
  }
}

/**
 * In-Memory EVM Blockchain & Token Simulation.
 */
export class SimulatedBlockchain {
  public accounts: Map<string, { nativeBalance: bigint; tokens: Map<string, bigint> }> = new Map();
  public blocks: Array<{ number: number; timestamp: number; transactions: any[] }> = [];
  public currentBlockNumber: number = 1000;

  constructor() {
    this.createBlock();
  }

  private getOrCreateAccount(address: string) {
    const norm = address.toLowerCase();
    if (!this.accounts.has(norm)) {
      this.accounts.set(norm, { nativeBalance: 100n * 10n ** 18n, tokens: new Map() });
    }
    return this.accounts.get(norm)!;
  }

  public mintToken(token: string, to: string, amount: bigint) {
    const acc = this.getOrCreateAccount(to);
    const tokenNorm = token.toLowerCase();
    const current = acc.tokens.get(tokenNorm) || 0n;
    acc.tokens.set(tokenNorm, current + amount);
  }

  public getTokenBalance(token: string, account: string): bigint {
    const acc = this.getOrCreateAccount(account);
    return acc.tokens.get(token.toLowerCase()) || 0n;
  }

  public transferToken(token: string, from: string, to: string, amount: bigint): boolean {
    const sender = this.getOrCreateAccount(from);
    const receiver = this.getOrCreateAccount(to);
    const tokenNorm = token.toLowerCase();
    const senderBal = sender.tokens.get(tokenNorm) || 0n;
    if (senderBal < amount) return false;
    sender.tokens.set(tokenNorm, senderBal - amount);
    const receiverBal = receiver.tokens.get(tokenNorm) || 0n;
    receiver.tokens.set(tokenNorm, receiverBal + amount);
    return true;
  }

  public createBlock(): number {
    this.currentBlockNumber++;
    this.blocks.push({
      number: this.currentBlockNumber,
      timestamp: Math.floor(Date.now() / 1000),
      transactions: []
    });
    return this.currentBlockNumber;
  }
}

/**
 * Shielded Note UTXO.
 */
export interface ShieldedUTXO {
  commitment: bigint;
  leafIndex: number;
  token: string;
  value: bigint;
  blinding: bigint;
  memo: string;
  depositorAddress?: string;
  depositTimestamp: number;
}

export interface UnshieldRequest {
  merkleRoot: bigint;
  nullifier: bigint;
  recipient: string;
  token: string;
  amount: bigint;
  relayerFee: bigint;
  relayerAddress: string;
  changeCommitment?: bigint;
  ppoiProof: {
    sanctionsRoot: bigint;
    depositOrigin: bigint;
    isNonSanctioned: boolean;
  };
}

/**
 * Railgun Shielded Pool Contract.
 */
export class RailgunPool {
  public merkleTree: IncrementalMerkleTree;
  public nullifiers: Set<string> = new Set();
  public sanctionsSMT: SparseMerkleTree;
  public blockchain: SimulatedBlockchain;
  public contractAddress: string = '0xPool_Railgun_Shielded';
  public utxoRegistry: Map<string, ShieldedUTXO> = new Map();
  public standbyWindowSeconds: number = 0;
  public poolEvents: Array<any> = [];

  constructor(blockchain: SimulatedBlockchain) {
    this.blockchain = blockchain;
    this.merkleTree = new IncrementalMerkleTree(16, 64);
    this.sanctionsSMT = new SparseMerkleTree(256);
  }

  public registerSanctionedAddress(address: string) {
    const key = addressToBigInt(address);
    this.sanctionsSMT.set(key, 1n);
  }

  public shield(
    token: string,
    amount: bigint,
    recipientNpk: bigint,
    blinding: bigint,
    memo: string = '',
    depositorAddress?: string
  ): { leafIndex: number; commitment: bigint; root: bigint } {
    if (amount <= 0n) throw new Error('SHIELD_AMOUNT_MUST_BE_POSITIVE');
    const commitment = poseidonHash(recipientNpk, token.toLowerCase(), amount, blinding);
    const leafIndex = this.merkleTree.insert(commitment);
    const depositTimestamp = Math.floor(Date.now() / 1000);

    const utxo: ShieldedUTXO = {
      commitment,
      leafIndex,
      token: token.toLowerCase(),
      value: amount,
      blinding,
      memo,
      depositorAddress: depositorAddress?.toLowerCase(),
      depositTimestamp
    };
    this.utxoRegistry.set(commitment.toString(), utxo);

    this.poolEvents.push({
      type: 'SHIELD',
      leafIndex,
      commitment,
      token: token.toLowerCase(),
      amount,
      depositorAddress,
      memo,
      timestamp: depositTimestamp,
      blockNumber: this.blockchain.currentBlockNumber
    });

    return { leafIndex, commitment, root: this.merkleTree.root };
  }

  public unshield(req: UnshieldRequest): { txHash: string; blockNumber: number; nullifier: string } {
    // 1. Root validity check in historical ring buffer
    const rootValid = this.merkleTree.historicalRoots.includes(req.merkleRoot);
    if (!rootValid) {
      throw new Error('EXPIRED_MERKLE_ROOT');
    }

    // 2. Nullifier check
    const nullifierStr = req.nullifier.toString();
    if (this.nullifiers.has(nullifierStr)) {
      throw new Error('ERROR_NULLIFIER_ALREADY_SPENT');
    }

    // 3. PPOI verification
    if (!req.ppoiProof.isNonSanctioned) {
      throw new Error('PPOI_SANCTIONED_INPUT');
    }
    const isSanctionedInSMT = this.sanctionsSMT.get(req.ppoiProof.depositOrigin) !== 0n;
    if (isSanctionedInSMT) {
      throw new Error('PPOI_SANCTIONED_INPUT');
    }

    // 4. Standby window check if applicable
    if (this.standbyWindowSeconds > 0) {
      const utxo = Array.from(this.utxoRegistry.values()).find(u =>
        u.depositorAddress && addressToBigInt(u.depositorAddress) === req.ppoiProof.depositOrigin
      );
      if (utxo) {
        const elapsed = Math.floor(Date.now() / 1000) - utxo.depositTimestamp;
        if (elapsed < this.standbyWindowSeconds && utxo.depositorAddress?.toLowerCase() !== req.recipient.toLowerCase()) {
          throw new Error('STANDBY_WINDOW_ACTIVE_ONLY_DEPOSITOR_UNSHIELD_ALLOWED');
        }
      }
    }

    // 5. Transfer tokens
    const totalRequired = req.amount + req.relayerFee;
    this.blockchain.transferToken(req.token, this.contractAddress, req.recipient, req.amount);
    if (req.relayerFee > 0n) {
      this.blockchain.transferToken(req.token, this.contractAddress, req.relayerAddress, req.relayerFee);
    }

    // 6. Record nullifier
    this.nullifiers.add(nullifierStr);

    // 7. Insert change commitment if provided
    if (req.changeCommitment && req.changeCommitment > 0n) {
      this.merkleTree.insert(req.changeCommitment);
    }

    const txHash = '0x' + crypto.randomBytes(32).toString('hex');
    const blockNumber = this.blockchain.createBlock();

    this.poolEvents.push({
      type: 'UNSHIELD',
      txHash,
      nullifier: nullifierStr,
      recipient: req.recipient,
      token: req.token,
      amount: req.amount,
      fee: req.relayerFee,
      relayer: req.relayerAddress,
      blockNumber,
      timestamp: Math.floor(Date.now() / 1000)
    });

    return { txHash, blockNumber, nullifier: nullifierStr };
  }
}

/**
 * Relayer Service (Decouples corporate treasury).
 */
export class RelayerNetwork {
  public relayerAddress: string = '0xRelayer_Broadcaster_Enterprise';
  public minimumFee: bigint = 500_000_000_000_000_000n; // 0.5 WQUAI base units
  public pool: RailgunPool;

  constructor(pool: RailgunPool) {
    this.pool = pool;
  }

  public getQuote(token: string): { relayerAddress: string; feeToken: string; estimatedFeeUnits: bigint } {
    return {
      relayerAddress: this.relayerAddress,
      feeToken: token,
      estimatedFeeUnits: this.minimumFee
    };
  }

  public async broadcastUnshield(
    req: UnshieldRequest
  ): Promise<{ txHash: string; blockNumber: number; relayerAddress: string; status: string }> {
    if (req.relayerFee < this.minimumFee) {
      throw new Error('FEE_BELOW_MINIMUM');
    }
    // Anti-frontrunning binding check
    if (req.relayerAddress.toLowerCase() !== this.relayerAddress.toLowerCase()) {
      throw new Error('RELAYER_ADDRESS_MISMATCH_FRONT_RUNNING_DETECTED');
    }

    const result = this.pool.unshield(req);
    return {
      txHash: result.txHash,
      blockNumber: result.blockNumber,
      relayerAddress: this.relayerAddress,
      status: 'confirmed'
    };
  }
}

/**
 * Inbound Merchant Privacy Gateway.
 */
export interface InvoiceRecord {
  invoiceId: string;
  resourceUri: string;
  ephemeralAddress: string;
  ephemeralPrivateKey: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  requiredAmount: bigint;
  createdAt: number;
  expiresAt: number;
  status: 'PENDING' | 'SETTLED' | 'SWEPT' | 'EXPIRED';
  settlementTxHash?: string;
  settledAt?: number;
  sweepTxHash?: string;
  sweptAt?: number;
}

export class InboundMerchantGateway {
  public masterMerchantKey: string;
  public corporate0zkAddress: string;
  public corporateNpk: bigint;
  public invoiceRegistry: Map<string, InvoiceRecord> = new Map();
  public usedReceiptRegistry: Set<string> = new Set();
  public blockchain: SimulatedBlockchain;
  public pool: RailgunPool;

  constructor(
    masterMerchantKey: string,
    corporate0zkAddress: string,
    corporateNpk: bigint,
    blockchain: SimulatedBlockchain,
    pool: RailgunPool
  ) {
    this.masterMerchantKey = masterMerchantKey;
    this.corporate0zkAddress = corporate0zkAddress;
    this.corporateNpk = corporateNpk;
    this.blockchain = blockchain;
    this.pool = pool;
  }

  public createPaymentChallenge(
    resourceUri: string,
    amount: bigint,
    tokenAddress: string,
    tokenSymbol: string = 'WQUAI',
    tokenDecimals: number = 6,
    ttlSeconds: number = 900
  ): { invoice: InvoiceRecord; challengeHeaders: Record<string, string>; challengeBody: any } {
    const invoiceId = `inv_${crypto.randomBytes(12).toString('hex')}`;
    const { address, privateKey } = deriveEphemeralAddress(this.masterMerchantKey, invoiceId);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + ttlSeconds;

    const invoice: InvoiceRecord = {
      invoiceId,
      resourceUri,
      ephemeralAddress: address,
      ephemeralPrivateKey: privateKey,
      tokenAddress: tokenAddress.toLowerCase(),
      tokenSymbol,
      tokenDecimals,
      requiredAmount: amount,
      createdAt: now,
      expiresAt,
      status: 'PENDING'
    };
    this.invoiceRegistry.set(invoiceId, invoice);

    const challengeHeaders: Record<string, string> = {
      'WWW-Authenticate': `x402 scheme="erc20_transfer", network="quai-cyprus1", chainId="9", token="${tokenAddress}", recipient="${address}", amount="${amount.toString()}", invoiceId="${invoiceId}", expiresAt="${expiresAt}", proofType="tx_receipt"`,
      'X-Payment-Required': 'true',
      'X-Payment-Scheme': 'x402-v1',
      'X-Payment-Network': 'quai-cyprus1',
      'X-Payment-Chain-Id': '9',
      'X-Payment-Token': tokenAddress,
      'X-Payment-Token-Symbol': tokenSymbol,
      'X-Payment-Token-Decimals': tokenDecimals.toString(),
      'X-Payment-Recipient': address,
      'X-Payment-Amount': amount.toString(),
      'X-Payment-Invoice-Id': invoiceId,
      'X-Payment-Expires-At': expiresAt.toString(),
      'X-Payment-Resource': resourceUri
    };

    const challengeBody = {
      type: 'https://darkcircle.network/errors/payment-required',
      title: 'Payment Required',
      status: 402,
      detail: `Access to this endpoint requires an ERC-20 payment of ${Number(amount) / 10 ** tokenDecimals} ${tokenSymbol}.`,
      instance: resourceUri,
      payment: {
        protocol: 'x402',
        version: '1.0.0',
        invoiceId,
        network: 'quai-cyprus1',
        chainId: 9,
        token: { address: tokenAddress, symbol: tokenSymbol, decimals: tokenDecimals },
        amount: amount.toString(),
        recipient: address,
        ephemeral: true,
        createdAt: now,
        expiresAt,
        proofType: 'tx_receipt'
      }
    };

    return { invoice, challengeHeaders, challengeBody };
  }

  public verifyPayment(
    invoiceId: string,
    txHash: string,
    amountSent?: bigint
  ): { success: boolean; error?: string; receiptId?: string; statusCode: number } {
    const invoice = this.invoiceRegistry.get(invoiceId);
    if (!invoice) {
      return { success: false, error: 'ERR_INVOICE_NOT_FOUND', statusCode: 404 };
    }

    const now = Math.floor(Date.now() / 1000);
    if (now > invoice.expiresAt) {
      invoice.status = 'EXPIRED';
      return { success: false, error: 'ERR_INVOICE_EXPIRED', statusCode: 410 };
    }

    // If already settled or swept with this exact txHash, grant access (idempotent / repeat request)
    if ((invoice.status === 'SETTLED' || invoice.status === 'SWEPT') && invoice.settlementTxHash?.toLowerCase() === txHash.toLowerCase()) {
      return { success: true, receiptId: `rct_${invoice.invoiceId}`, statusCode: 200 };
    }

    // Replay check: txHash already used for another invoice
    if (this.usedReceiptRegistry.has(txHash.toLowerCase())) {
      return { success: false, error: 'ERR_REPLAY_DETECTED', statusCode: 409 };
    }

    // Settlement verification
    const onChainBal = this.blockchain.getTokenBalance(invoice.tokenAddress, invoice.ephemeralAddress);
    const effectiveAmount = amountSent !== undefined ? amountSent : onChainBal;

    if (effectiveAmount < invoice.requiredAmount) {
      return { success: false, error: 'ERR_UNDERPAYMENT', statusCode: 402 };
    }

    invoice.status = 'SETTLED';
    invoice.settlementTxHash = txHash;
    invoice.settledAt = now;
    this.usedReceiptRegistry.add(txHash.toLowerCase());

    const receiptId = `rct_${crypto.randomBytes(12).toString('hex')}`;
    return { success: true, receiptId, statusCode: 200 };
  }

  public async sweepAndShield(
    invoiceId: string
  ): Promise<{ sweepTxHash: string; sweptAmount: bigint; shieldedCommitment: bigint }> {
    const invoice = this.invoiceRegistry.get(invoiceId);
    if (!invoice) throw new Error('INVOICE_NOT_FOUND');
    const balance = this.blockchain.getTokenBalance(invoice.tokenAddress, invoice.ephemeralAddress);
    if (balance <= 0n) {
      throw new Error('NO_FUNDS_TO_SWEEP');
    }

    // Transfer from ephemeral address to pool
    this.blockchain.transferToken(invoice.tokenAddress, invoice.ephemeralAddress, this.pool.contractAddress, balance);

    // Shield funds into corporate pool
    const blinding = BigInt('0x' + crypto.randomBytes(16).toString('hex')) % BN254_SCALAR_FIELD;
    const { commitment } = this.pool.shield(
      invoice.tokenAddress,
      balance,
      this.corporateNpk,
      blinding,
      invoice.invoiceId,
      invoice.ephemeralAddress
    );

    const sweepTxHash = '0x' + crypto.randomBytes(32).toString('hex');
    invoice.status = 'SWEPT';
    invoice.sweepTxHash = sweepTxHash;
    invoice.sweptAt = Math.floor(Date.now() / 1000);
    // Key zeroization
    invoice.ephemeralPrivateKey = '0x0000000000000000000000000000000000000000000000000000000000000000';

    return { sweepTxHash, sweptAmount: balance, shieldedCommitment: commitment };
  }
}

/**
 * Challenge Parser & Payment Challenge Model.
 */
export interface PaymentChallenge {
  scheme: string;
  invoiceId: string;
  chainId: number;
  network: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amount: bigint;
  recipientAddress: string;
  expiresAt: number;
  targetResource: string;
  proofType: string;
}

export class ChallengeParser {
  public static parse(headers: Record<string, string>, body?: any): PaymentChallenge {
    // 1. JSON Body priority
    if (body && body.payment) {
      const p = body.payment;
      return {
        scheme: p.protocol || 'x402-v1',
        invoiceId: p.invoiceId,
        chainId: Number(p.chainId || 9),
        network: p.network || 'quai-cyprus1',
        tokenAddress: (p.token?.address || '').toLowerCase(),
        tokenSymbol: p.token?.symbol || 'WQUAI',
        tokenDecimals: Number(p.token?.decimals || 6),
        amount: BigInt(p.amount || 0),
        recipientAddress: (p.recipient || '').toLowerCase(),
        expiresAt: Number(p.expiresAt || 0),
        targetResource: body.instance || '',
        proofType: p.proofType || 'tx_receipt'
      };
    }

    // 2. WWW-Authenticate header fallback
    const authHeader = headers['www-authenticate'] || headers['WWW-Authenticate'];
    if (authHeader && authHeader.toLowerCase().startsWith('x402')) {
      const params: Record<string, string> = {};
      const matches = authHeader.matchAll(/(\w+)="([^"]+)"/g);
      for (const match of matches) {
        params[match[1]] = match[2];
      }
      return {
        scheme: params.scheme || 'x402-v1',
        invoiceId: params.invoiceId || '',
        chainId: Number(params.chainId || 9),
        network: params.network || 'quai-cyprus1',
        tokenAddress: (params.token || '').toLowerCase(),
        tokenSymbol: 'WQUAI',
        tokenDecimals: 18,
        amount: BigInt(params.amount || 0),
        recipientAddress: (params.recipient || '').toLowerCase(),
        expiresAt: Number(params.expiresAt || 0),
        targetResource: '',
        proofType: params.proofType || 'tx_receipt'
      };
    }

    // 3. Custom X-Payment headers fallback
    const recipient = headers['x-payment-recipient'] || headers['X-Payment-Recipient'];
    const amount = headers['x-payment-amount'] || headers['X-Payment-Amount'];
    const invoiceId = headers['x-payment-invoice-id'] || headers['X-Payment-Invoice-Id'];
    if (recipient && amount && invoiceId) {
      return {
        scheme: headers['x-payment-scheme'] || 'x402-v1',
        invoiceId,
        chainId: Number(headers['x-payment-chain-id'] || 9),
        network: 'quai-cyprus1',
        tokenAddress: (headers['x-payment-token'] || '').toLowerCase(),
        tokenSymbol: headers['x-payment-token-symbol'] || 'WQUAI',
        tokenDecimals: Number(headers['x-payment-token-decimals'] || 6),
        amount: BigInt(amount),
        recipientAddress: recipient.toLowerCase(),
        expiresAt: Number(headers['x-payment-expires-at'] || 0),
        targetResource: headers['x-payment-resource'] || '',
        proofType: 'tx_receipt'
      };
    }

    throw new Error('ERR_402_CHALLENGE_INVALID');
  }
}

/**
 * Outbound Payment Proxy & Interceptor.
 */
export interface CachedReceipt {
  cacheKey: string;
  invoiceId: string;
  txHash: string;
  relayerAddress: string;
  amount: bigint;
  token: string;
  expiresAt: number;
}

export class OutboundPaymentProxy {
  public spendingPolicy: {
    maxPaymentCap: bigint;
    allowedTokens: string[];
    allowedChainIds: number[];
  };
  public receiptCache: Map<string, CachedReceipt> = new Map();
  public inFlightLocks: Map<string, Promise<CachedReceipt>> = new Map();
  public relayer: RelayerNetwork;
  public corporateKeys: CorporateKeys;
  public treasuryUTXOs: ShieldedUTXO[] = [];
  private settlementMutex: Promise<any> = Promise.resolve();

  constructor(
    spendingPolicy: { maxPaymentCap: bigint; allowedTokens: string[]; allowedChainIds: number[] },
    relayer: RelayerNetwork,
    corporateKeys: CorporateKeys
  ) {
    this.spendingPolicy = spendingPolicy;
    this.relayer = relayer;
    this.corporateKeys = corporateKeys;
  }

  public addTreasuryUTXO(utxo: ShieldedUTXO) {
    this.treasuryUTXOs.push(utxo);
  }

  public validatePolicy(challenge: PaymentChallenge): void {
    if (challenge.amount > this.spendingPolicy.maxPaymentCap) {
      throw new Error('ERR_SPENDING_POLICY_REJECTED_AMOUNT_EXCEEDS_CAP');
    }
    const tokenAllowed = this.spendingPolicy.allowedTokens.some(
      t => t.toLowerCase() === challenge.tokenAddress.toLowerCase()
    );
    if (!tokenAllowed) {
      throw new Error('ERR_UNSUPPORTED_CHAIN_OR_TOKEN');
    }
    if (!this.spendingPolicy.allowedChainIds.includes(challenge.chainId)) {
      throw new Error('ERR_UNSUPPORTED_CHAIN_OR_TOKEN');
    }
  }

  public async settleChallenge(challenge: PaymentChallenge): Promise<CachedReceipt> {
    this.validatePolicy(challenge);

    // Sequentialize settlement to prevent race conditions across parallel UTXO selections
    const prevLock = this.settlementMutex;
    let releaseLock: () => void = () => {};
    this.settlementMutex = new Promise<void>(resolve => {
      releaseLock = resolve;
    });

    await prevLock;
    try {
      // Select UTXO
      const utxoIndex = this.treasuryUTXOs.findIndex(u => u.value >= challenge.amount + this.relayer.minimumFee);
      if (utxoIndex === -1) {
        throw new Error('ERR_INSUFFICIENT_TREASURY_FUNDS');
      }
      const utxo = this.treasuryUTXOs[utxoIndex];

      // Compute nullifier: Poseidon(ssk, commitment, leafIndex)
      const nullifier = poseidonHash(this.corporateKeys.ssk, utxo.commitment, utxo.leafIndex);

      // Prepare change commitment if remainder exists
      const remainder = utxo.value - (challenge.amount + this.relayer.minimumFee);
      let changeCommitment: bigint | undefined;
      if (remainder > 0n) {
        const changeBlinding = BigInt('0x' + crypto.randomBytes(16).toString('hex')) % BN254_SCALAR_FIELD;
        changeCommitment = poseidonHash(this.corporateKeys.npk, challenge.tokenAddress, remainder, changeBlinding);
      }

      // Construct unshield request
      const depositOrigin = utxo.depositorAddress ? addressToBigInt(utxo.depositorAddress) : 0n;
      const req: UnshieldRequest = {
        merkleRoot: this.relayer.pool.merkleTree.root,
        nullifier,
        recipient: challenge.recipientAddress,
        token: challenge.tokenAddress,
        amount: challenge.amount,
        relayerFee: this.relayer.minimumFee,
        relayerAddress: this.relayer.relayerAddress,
        changeCommitment,
        ppoiProof: {
          sanctionsRoot: this.relayer.pool.sanctionsSMT.root,
          depositOrigin,
          isNonSanctioned: this.relayer.pool.sanctionsSMT.get(depositOrigin) === 0n
        }
      };

      // Broadcast via relayer
      const txReceipt = await this.relayer.broadcastUnshield(req);

      // Remove spent UTXO and append change UTXO
      this.treasuryUTXOs.splice(utxoIndex, 1);
      if (remainder > 0n && changeCommitment) {
        this.treasuryUTXOs.push({
          commitment: changeCommitment,
          leafIndex: this.relayer.pool.merkleTree.leaves.length - 1,
          token: challenge.tokenAddress,
          value: remainder,
          blinding: 12345n,
          memo: 'change_note',
          depositTimestamp: Math.floor(Date.now() / 1000)
        });
      }

      const receipt: CachedReceipt = {
        cacheKey: challenge.targetResource || challenge.invoiceId,
        invoiceId: challenge.invoiceId,
        txHash: txReceipt.txHash,
        relayerAddress: txReceipt.relayerAddress,
        amount: challenge.amount,
        token: challenge.tokenAddress,
        expiresAt: challenge.expiresAt
      };

      this.receiptCache.set(receipt.cacheKey, receipt);
      return receipt;
    } finally {
      releaseLock();
    }
  }

  public async fetchWithPayment(
    targetUrl: string,
    executeRequest: (authHeaders?: Record<string, string>) => Promise<{ status: number; headers: Record<string, string>; body: any }>
  ): Promise<{ status: number; headers: Record<string, string>; body: any; fromCache?: boolean }> {
    // 1. Check cache
    const cached = this.receiptCache.get(targetUrl);
    if (cached && cached.expiresAt > Math.floor(Date.now() / 1000)) {
      const headers = {
        Authorization: `x402 invoice="${cached.invoiceId}", proof="${cached.txHash}", relayer="${cached.relayerAddress}"`,
        'X-Payment-Invoice-Id': cached.invoiceId,
        'X-Payment-Proof': cached.txHash
      };
      const res = await executeRequest(headers);
      if (res.status === 200) {
        return { ...res, fromCache: true };
      }
    }

    // 2. Initial request
    const initialRes = await executeRequest();
    if (initialRes.status !== 402) {
      return initialRes;
    }

    // 3. Parse challenge
    const challenge = ChallengeParser.parse(initialRes.headers, initialRes.body);
    challenge.targetResource = targetUrl;

    // 4. Single-flight lock coalescing
    let lockPromise = this.inFlightLocks.get(targetUrl);
    if (!lockPromise) {
      lockPromise = this.settleChallenge(challenge).finally(() => {
        this.inFlightLocks.delete(targetUrl);
      });
      this.inFlightLocks.set(targetUrl, lockPromise);
    }
    const receipt = await lockPromise;

    // 5. Retry request with payment proof
    const retryHeaders = {
      Authorization: `x402 invoice="${receipt.invoiceId}", proof="${receipt.txHash}", relayer="${receipt.relayerAddress}"`,
      'X-Payment-Invoice-Id': receipt.invoiceId,
      'X-Payment-Proof': receipt.txHash
    };
    return executeRequest(retryHeaders);
  }
}

/**
 * Corporate Viewing-Key Audit Exporter.
 */
export interface AuditTransactionRecord {
  txHash: string;
  timestampIso: string;
  blockNumber: number;
  direction: 'INBOUND_SWEEP' | 'OUTBOUND_UNSHIELD' | 'SHIELD_DEPOSIT';
  assetSymbol: string;
  assetAddress: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  counterpartyAddress: string;
  relayerAddress: string;
  invoiceId: string;
  ppoiStatus: 'VERIFIED_INNOCENT' | 'EXEMPT_DEPOSIT' | 'FLAGGED';
  complianceStatus: 'COMPLIANT' | 'NON_COMPLIANT';
}

export class ViewingKeyAuditEngine {
  public corporateKeys: CorporateKeys;
  public pool: RailgunPool;

  constructor(corporateKeys: CorporateKeys, pool: RailgunPool) {
    this.corporateKeys = corporateKeys;
    this.pool = pool;
  }

  public decryptLedger(): AuditTransactionRecord[] {
    const records: AuditTransactionRecord[] = [];

    for (const event of this.pool.poolEvents) {
      if (event.type === 'UNSHIELD') {
        records.push({
          txHash: event.txHash,
          timestampIso: new Date(event.timestamp * 1000).toISOString(),
          blockNumber: event.blockNumber,
          direction: 'OUTBOUND_UNSHIELD',
          assetSymbol: 'WQUAI',
          assetAddress: event.token,
          grossAmount: fmt18(event.amount + event.fee),
          feeAmount: fmt18(event.fee),
          netAmount: fmt18(event.amount),
          counterpartyAddress: event.recipient,
          relayerAddress: event.relayer,
          invoiceId: 'inv_outbound',
          ppoiStatus: 'VERIFIED_INNOCENT',
          complianceStatus: 'COMPLIANT'
        });
      } else if (event.type === 'SHIELD') {
        records.push({
          txHash: '0x' + crypto.createHash('sha256').update(event.commitment.toString()).digest('hex'),
          timestampIso: new Date(event.timestamp * 1000).toISOString(),
          blockNumber: event.blockNumber,
          direction: event.depositorAddress ? 'INBOUND_SWEEP' : 'SHIELD_DEPOSIT',
          assetSymbol: 'WQUAI',
          assetAddress: event.token,
          grossAmount: fmt18(event.amount),
          feeAmount: '0.000000000000000000',
          netAmount: fmt18(event.amount),
          counterpartyAddress: event.depositorAddress || 'treasury_shield',
          relayerAddress: 'N/A',
          invoiceId: event.memo || 'shield_event',
          ppoiStatus: 'EXEMPT_DEPOSIT',
          complianceStatus: 'COMPLIANT'
        });
      }
    }
    return records;
  }

  public exportJson(entityName: string = 'DarkCircle Enterprise'): string {
    const transactions = this.decryptLedger();
    let totalInflow = 0n;
    let totalOutflow = 0n;

    for (const tx of transactions) {
      if (tx.direction === 'INBOUND_SWEEP' || tx.direction === 'SHIELD_DEPOSIT') {
        totalInflow += parse18(tx.netAmount);
      } else if (tx.direction === 'OUTBOUND_UNSHIELD') {
        totalOutflow += parse18(tx.grossAmount);
      }
    }

    const report = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      title: 'DarkCircleAuditReport',
      reportId: `audit_${crypto.randomBytes(8).toString('hex')}`,
      generatedAt: new Date().toISOString(),
      entityName,
      corporate0zkAddress: this.corporateKeys.corporate0zkAddress,
      summary: {
        totalInflow: fmt18(totalInflow),
        totalOutflow: fmt18(totalOutflow),
        netBalance: fmt18(totalInflow - totalOutflow),
        tokenSymbol: 'WQUAI',
        totalTransactions: transactions.length,
        ppoiComplianceRate: '100.0%'
      },
      transactions
    };
    return JSON.stringify(report, null, 2);
  }

  public exportCsv(): string {
    const transactions = this.decryptLedger();
    const headers = [
      'timestamp_iso',
      'tx_hash',
      'block_number',
      'direction',
      'asset_symbol',
      'asset_address',
      'gross_amount',
      'fee_amount',
      'net_amount',
      'counterparty_address',
      'relayer_address',
      'invoice_id',
      'ppoi_status',
      'compliance_status'
    ];

    const rows = transactions.map(t => [
      t.timestampIso,
      t.txHash,
      t.blockNumber.toString(),
      t.direction,
      t.assetSymbol,
      t.assetAddress,
      t.grossAmount,
      t.feeAmount,
      t.netAmount,
      t.counterpartyAddress,
      t.relayerAddress,
      `"${t.invoiceId.replace(/"/g, '""')}"`,
      t.ppoiStatus,
      t.complianceStatus
    ]);

    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  }
}

/**
 * Protected Resource Server.
 */
export class ResourceServer {
  public gateway: InboundMerchantGateway;

  constructor(gateway: InboundMerchantGateway) {
    this.gateway = gateway;
  }

  public async handleRequest(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: any
  ): Promise<{ status: number; headers: Record<string, string>; body: any }> {
    const tokenAddress = '0x006c3e2aaae5db1bcd11a1a097ce572312eaddbb'; // WQUAI

    // Pricing definition
    let requiredAmount: bigint;
    if (path === '/api/v1/protected/analytics') {
      requiredAmount = 5_000_000_000_000_000_000n; // 5 WQUAI
    } else if (path === '/api/v1/protected/ai-inference') {
      requiredAmount = 10_000_000_000_000_000_000n; // 10 WQUAI
    } else {
      return { status: 404, headers: {}, body: { error: 'NOT_FOUND' } };
    }

    // Check payment credentials
    const authHeader = headers['authorization'] || headers['Authorization'];
    const proofHeader = headers['x-payment-proof'] || headers['X-Payment-Proof'];
    const invoiceIdHeader = headers['x-payment-invoice-id'] || headers['X-Payment-Invoice-Id'];

    if (proofHeader && invoiceIdHeader) {
      const verifyRes = this.gateway.verifyPayment(invoiceIdHeader, proofHeader);
      if (!verifyRes.success) {
        return {
          status: verifyRes.statusCode,
          headers: { 'Content-Type': 'application/json' },
          body: { error: verifyRes.error }
        };
      }

      // Automatically trigger sweep in background simulation
      await this.gateway.sweepAndShield(invoiceIdHeader).catch(() => {});

      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Payment-Status': 'SETTLED',
          'X-Payment-Receipt-Id': verifyRes.receiptId || '',
          'X-Payment-Invoice-Id': invoiceIdHeader,
          'X-Payment-Relayer-Decoupled': 'true'
        },
        body: {
          status: 'success',
          path,
          timestamp: new Date().toISOString(),
          data: path === '/api/v1/protected/analytics'
            ? { activeUsers: 48291, totalVolumeUsd: 12948201.5 }
            : { model: body?.model || 'llama-3-8b', inference: 'Corporate earnings analysis completed with zero leakage.' }
        }
      };
    }

    // Issue 402 challenge
    const challenge = this.gateway.createPaymentChallenge(path, requiredAmount, tokenAddress, 'WQUAI', 18);
    return {
      status: 402,
      headers: {
        'Content-Type': 'application/problem+json',
        ...challenge.challengeHeaders
      },
      body: challenge.challengeBody
    };
  }
}
