import { formatUnits } from 'ethers';
import { VAULT_LIMITS } from './abi.js';
import { AdminCall, DecodedCall } from './decode.js';
import { isCyprus1QuaiAddress } from './create2.js';
import { formatDuration, shortAddress } from './format.js';

export type RiskLevel = 'critical' | 'high' | 'medium' | 'info';

export interface RiskFlag {
  level: RiskLevel;
  code: string;
  message: string;
}

export interface RiskContext {
  vault: string;
  owners: readonly string[];
  threshold: number;
  minExecutionDelay: number;
  /** The vault's native balance, when known. */
  balance?: bigint;
  /**
   * Lower-case addresses this vault has already sent to, or that the user saved in their
   * address book. When omitted, first-time-recipient checks are skipped.
   */
  knownRecipients?: ReadonlySet<string>;
  /** Whether the address receiving funds has contract code; null or omitted = unknown. */
  recipientIsContract?: boolean | null;
  /**
   * Lower-case hashes of transactions cancelByConsensus could still cancel (proposed, not
   * executed, not cancelled). When omitted, cancel targets are not checked.
   */
  cancellableTransactions?: ReadonlySet<string>;
}

export interface TokenInfo {
  symbol: string;
  decimals: number;
}

const ORDER: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, info: 3 };

export function highestRisk(flags: readonly RiskFlag[]): RiskLevel | null {
  return flags.reduce<RiskLevel | null>((acc, f) => (acc === null || ORDER[f.level] < ORDER[acc] ? f.level : acc), null);
}

/**
 * Flags meaning the vault itself will refuse the change when it executes. Kept in step with
 * the contract by the Foundry differential suite (testFuzz_riskPredictsAdminRejection).
 */
export const VAULT_REJECTION_CODES: ReadonlySet<string> = new Set([
  'invalid-threshold',
  'invalid-owner',
  'duplicate-owner',
  'not-an-owner',
  'too-many-owners',
  'invalid-delay',
  'cancel-target-not-open',
  'unknown-self-call',
]);

export function vaultWillReject(flags: readonly RiskFlag[]): boolean {
  return flags.some((f) => VAULT_REJECTION_CODES.has(f.code));
}

function isOwner(ctx: RiskContext, address: string): boolean {
  return ctx.owners.some((o) => o.toLowerCase() === address.toLowerCase());
}

function thresholdFlags(newThreshold: bigint, ownerCount: number, ctx: RiskContext): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (newThreshold < 1n || newThreshold > BigInt(ownerCount)) {
    flags.push({ level: 'critical', code: 'invalid-threshold', message: `A threshold of ${newThreshold} with ${ownerCount} owners is invalid; the vault will reject this.` });
    return flags;
  }
  const t = Number(newThreshold);
  if (t < ctx.threshold) {
    flags.push({ level: 'critical', code: 'threshold-decrease', message: `Lowers the approvals needed from ${ctx.threshold} to ${t}.` });
  }
  if (t === 1 && ownerCount > 1) {
    flags.push({ level: 'critical', code: 'single-signer', message: 'After this, any single owner can move every asset alone.' });
  }
  if (t === ownerCount && ownerCount > 1) {
    flags.push({ level: 'medium', code: 'all-must-sign', message: 'After this, every owner must approve; losing any one key locks the vault.' });
  }
  return flags;
}

function adminFlags(call: AdminCall, ctx: RiskContext): RiskFlag[] {
  const flags: RiskFlag[] = [
    {
      level: 'critical',
      code: 'admin-change',
      message: 'Changes how this vault is governed. Admin changes skip the timelock: they run as soon as quorum approves.',
    },
  ];
  switch (call.fn) {
    case 'addOwner': {
      const o = call.owner.toLowerCase();
      // Mirrors SafeBuddyVault._validateNewOwner.
      if (BigInt(o) <= 1n || o === ctx.vault.toLowerCase() || o.slice(2, 4) !== '00') {
        flags.push({ level: 'critical', code: 'invalid-owner', message: `${call.owner} cannot be an owner; the vault will reject this.` });
      } else if (!isCyprus1QuaiAddress(call.owner)) {
        flags.push({ level: 'critical', code: 'owner-not-quai-account', message: `${call.owner} is a Qi-ledger address, so it can never approve anything.` });
      }
      if (isOwner(ctx, call.owner)) flags.push({ level: 'critical', code: 'duplicate-owner', message: `${call.owner} is already an owner; the vault will reject this.` });
      if (ctx.owners.length >= VAULT_LIMITS.MAX_OWNERS) flags.push({ level: 'critical', code: 'too-many-owners', message: `The vault already has the maximum of ${VAULT_LIMITS.MAX_OWNERS} owners.` });
      flags.push(...thresholdFlags(call.newThreshold, ctx.owners.length + 1, ctx));
      break;
    }
    case 'removeOwner': {
      if (!isOwner(ctx, call.owner)) flags.push({ level: 'critical', code: 'not-an-owner', message: `${call.owner} is not an owner; the vault will reject this.` });
      flags.push({ level: 'high', code: 'owner-removal', message: `Removes ${call.owner}. Their approvals on every open transaction stop counting immediately.` });
      flags.push(...thresholdFlags(call.newThreshold, ctx.owners.length - 1, ctx));
      break;
    }
    case 'changeThreshold': {
      const f = thresholdFlags(call.newThreshold, ctx.owners.length, ctx);
      flags.push(...f);
      if (call.newThreshold > BigInt(ctx.threshold) && !f.some((x) => x.code === 'invalid-threshold')) {
        flags.push({ level: 'info', code: 'threshold-increase', message: `Raises the approvals needed from ${ctx.threshold} to ${call.newThreshold}.` });
      }
      break;
    }
    case 'setMinExecutionDelay': {
      if (call.newDelay > BigInt(VAULT_LIMITS.MAX_EXECUTION_DELAY)) {
        flags.push({ level: 'critical', code: 'invalid-delay', message: 'Delays above 30 days are invalid; the vault will reject this.' });
      } else if (call.newDelay === 0n && ctx.minExecutionDelay > 0) {
        flags.push({ level: 'critical', code: 'delay-removed', message: 'Removes the timelock: new transactions can run the moment quorum approves, with no time to react.' });
      } else if (call.newDelay < BigInt(ctx.minExecutionDelay)) {
        flags.push({
          level: 'critical',
          code: 'delay-decrease',
          message: `Shortens the review window from ${formatDuration(ctx.minExecutionDelay)} to ${formatDuration(Number(call.newDelay))}.`,
        });
      } else {
        flags.push({ level: 'info', code: 'delay-increase', message: 'Applies to transactions proposed after it runs; open ones keep their delay.' });
      }
      break;
    }
    case 'cancelByConsensus':
      flags.push({ level: 'high', code: 'cancel-by-consensus', message: `Permanently cancels transaction ${call.txHash}.` });
      if (ctx.cancellableTransactions && !ctx.cancellableTransactions.has(call.txHash.toLowerCase())) {
        flags.push({ level: 'critical', code: 'cancel-target-not-open', message: 'That transaction does not exist or is already executed or cancelled; the vault will reject this.' });
      }
      break;
  }
  return flags;
}

function recipientFlags(recipient: string, ctx: RiskContext): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (!isCyprus1QuaiAddress(recipient)) {
    flags.push({ level: 'critical', code: 'recipient-not-quai-account', message: `${recipient} is not a Cyprus-1 Quai account address; funds sent there may be unrecoverable.` });
  }
  if (recipient.toLowerCase() === ctx.vault.toLowerCase()) {
    flags.push({ level: 'info', code: 'recipient-is-vault', message: 'The recipient is this vault itself.' });
  } else if (ctx.knownRecipients && !ctx.knownRecipients.has(recipient.toLowerCase())) {
    flags.push({
      level: 'high',
      code: 'first-time-recipient',
      message: `This vault has never sent to ${shortAddress(recipient)} and it is not in your address book. Check every character.`,
    });
  }
  if (ctx.recipientIsContract === true) {
    flags.push({ level: 'high', code: 'contract-recipient', message: `${shortAddress(recipient)} is a contract. Make sure it is meant to receive these funds.` });
  }
  return flags;
}

export function describeRisk(decoded: DecodedCall, ctx: RiskContext): RiskFlag[] {
  const flags: RiskFlag[] = [];
  switch (decoded.kind) {
    case 'admin':
      flags.push(...adminFlags(decoded.call, ctx));
      break;
    case 'self-call-unknown':
      flags.push(
        decoded.reason === 'not an admin function of the vault'
          ? { level: 'critical', code: 'unknown-self-call', message: 'A call to the vault itself that is not one of its admin functions; the vault will reject this.' }
          : {
              level: 'critical',
              code: 'undecodable-admin-call',
              message: 'An admin call whose encoding is not canonical. The vault may reject it, or run it with arguments other than any clean reading shows.',
            }
      );
      break;
    case 'native-transfer':
      flags.push(...recipientFlags(decoded.to, ctx));
      if (decoded.value === 0n) flags.push({ level: 'medium', code: 'empty-call', message: 'Sends nothing and calls nothing. Is this intended?' });
      if (ctx.balance !== undefined && decoded.value > ctx.balance) {
        flags.push({ level: 'medium', code: 'insufficient-balance', message: 'The vault does not hold this much QUAI right now; execution will fail until it does.' });
      } else if (ctx.balance !== undefined && ctx.balance > 0n && decoded.value * 2n > ctx.balance) {
        flags.push({ level: 'medium', code: 'large-share', message: "Moves more than half of the vault's QUAI." });
      }
      break;
    case 'erc20-transfer':
      flags.push(...recipientFlags(decoded.recipient, ctx));
      if (decoded.recipient.toLowerCase() === decoded.token.toLowerCase()) {
        flags.push({ level: 'high', code: 'transfer-to-token', message: 'Sends tokens to the token contract itself, where they are usually lost.' });
      }
      if (decoded.value > 0n) flags.push({ level: 'high', code: 'value-with-token-call', message: 'Also sends QUAI to the token contract.' });
      break;
    case 'erc20-approve':
      flags.push(
        decoded.unlimited
          ? { level: 'high', code: 'unlimited-approval', message: `Lets ${shortAddress(decoded.spender)} spend all of this token the vault ever holds.` }
          : { level: 'medium', code: 'approval', message: `Lets ${shortAddress(decoded.spender)} spend this token from the vault.` }
      );
      if (ctx.knownRecipients && !ctx.knownRecipients.has(decoded.spender.toLowerCase())) {
        flags.push({ level: 'high', code: 'first-time-spender', message: `This vault has never dealt with ${shortAddress(decoded.spender)}.` });
      }
      if (decoded.value > 0n) flags.push({ level: 'high', code: 'value-with-token-call', message: 'Also sends QUAI to the token contract.' });
      break;
    case 'contract-call':
      flags.push({
        level: 'high',
        code: 'unknown-function',
        message: `Calls function ${decoded.selector} with ${decoded.dataBytes} bytes of data. SafeBuddy cannot show what it does; decode it independently before approving.`,
      });
      if (decoded.note) flags.push({ level: 'high', code: 'non-canonical-encoding', message: `The calldata ${decoded.note}.` });
      if (decoded.value > 0n) flags.push({ level: 'medium', code: 'value-to-contract', message: 'Sends QUAI along with the call.' });
      break;
  }
  return flags.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
}

function amount(raw: bigint, token?: TokenInfo): string {
  return token ? `${formatUnits(raw, token.decimals)} ${token.symbol}` : `${raw} base units`;
}

/** One line for lists; the review screen shows every field in full as well. */
export function summarizeCall(decoded: DecodedCall, token?: TokenInfo): string {
  switch (decoded.kind) {
    case 'native-transfer':
      return `Send ${formatUnits(decoded.value, 18)} QUAI to ${shortAddress(decoded.to)}`;
    case 'erc20-transfer':
      return `Transfer ${amount(decoded.amount, token)} to ${shortAddress(decoded.recipient)}`;
    case 'erc20-approve':
      return `Approve ${shortAddress(decoded.spender)} to spend ${decoded.unlimited ? 'unlimited' : amount(decoded.amount, token)}`;
    case 'contract-call':
      return `Call ${decoded.selector} on ${shortAddress(decoded.to)}`;
    case 'self-call-unknown':
      return `Unrecognised vault call ${decoded.selector}`;
    case 'admin': {
      const c = decoded.call;
      switch (c.fn) {
        case 'addOwner':
          return `Add owner ${shortAddress(c.owner)}, threshold ${c.newThreshold}`;
        case 'removeOwner':
          return `Remove owner ${shortAddress(c.owner)}, threshold ${c.newThreshold}`;
        case 'changeThreshold':
          return `Change threshold to ${c.newThreshold}`;
        case 'setMinExecutionDelay':
          return `Set minimum delay to ${formatDuration(Number(c.newDelay))}`;
        case 'cancelByConsensus':
          return `Cancel transaction ${c.txHash.slice(0, 10)}…`;
      }
    }
  }
}

export interface ConfirmationChallenge {
  prompt: string;
  expected: string;
}

/**
 * Admin changes need the user to type a value taken from the change itself, so approving
 * one means reading the parameter that matters rather than clicking through.
 */
export function confirmationChallenge(decoded: DecodedCall): ConfirmationChallenge | null {
  if (decoded.kind === 'self-call-unknown') {
    return { prompt: 'This call to the vault could not be decoded. Type UNDECODED to continue anyway', expected: 'UNDECODED' };
  }
  if (decoded.kind !== 'admin') return null;
  const c = decoded.call;
  switch (c.fn) {
    case 'addOwner':
    case 'removeOwner':
      return { prompt: `Type the last 6 characters of the owner address (${c.owner})`, expected: c.owner.slice(-6).toLowerCase() };
    case 'changeThreshold':
      return { prompt: 'Type the new threshold', expected: String(c.newThreshold) };
    case 'setMinExecutionDelay':
      return { prompt: `Type the new delay in seconds (${formatDuration(Number(c.newDelay))})`, expected: String(c.newDelay) };
    case 'cancelByConsensus':
      return { prompt: 'Type the first 8 characters after 0x of the transaction being cancelled', expected: c.txHash.slice(2, 10).toLowerCase() };
  }
}

export function challengeSatisfied(challenge: ConfirmationChallenge | null, typed: string): boolean {
  if (!challenge) return true;
  return typed.trim().toLowerCase() === challenge.expected.toLowerCase();
}
