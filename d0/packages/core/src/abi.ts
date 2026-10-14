import { id } from 'ethers';

/**
 * Turn a raw revert payload into words. Decodes the standard Error(string) and Panic(uint256)
 * ABI forms, then names the DarkOrder custom errors it knows; anything else is passed through
 * trimmed, never thrown away. Browser-safe: no Buffer, no node APIs.
 */

const PANICS: Record<number, string> = {
  0x01: 'an assertion failed',
  0x11: 'an arithmetic overflow or underflow',
  0x12: 'a division by zero',
  0x21: 'an invalid enum conversion',
  0x22: 'a corrupted storage byte array',
  0x31: 'a pop on an empty array',
  0x32: 'an out-of-bounds array index',
  0x41: 'too much memory allocated',
  0x51: 'a call to an invalid function pointer',
};

const KNOWN_ERROR_SIGS: Record<string, string> = {
  'Unauthorized(bytes32,address)': 'this address does not hold the required role',
  'AlreadyGranted(bytes32,address)': 'the role is already granted',
  'NotGranted(bytes32,address)': 'the role is not granted',
  'ActionFailed(uint256)': 'one action of the proposal batch failed, so the whole batch reverted',
  'ProposalUnknown(uint256)': 'no proposal with that id',
  'NoVotingPower(address)': 'no voting power at the snapshot (delegate your tokens first)',
  'StartInPast(uint64)': 'the start date is in the past',
  'EndTooEarly(uint64,uint64)': 'the end date is before the minimum duration',
  'VoteNotStarted(uint256)': 'voting has not started',
  'VoteEnded(uint256)': 'voting has ended',
  'AlreadyVoted(uint256,address)': 'this address has already voted',
  'VoteNone()': 'a vote must be yes, no or abstain',
  'CannotExecute(uint256)': 'the proposal cannot be executed (yet)',
  'NotTheGuild(address)': 'only the guild itself may change these settings',
  'ThresholdInvalid(uint256)': 'thresholds are basis points and cannot exceed 10000',
  'NoMembers()': 'a council needs at least one member',
  'MinApprovalsInvalid(uint256,uint256)': 'min approvals must be between 1 and the member count',
  'MemberZero()': 'the zero address cannot be a council member',
  'MemberDuplicate(address)': 'a council member is listed twice',
  'NotMember(address)': 'only council members may do this',
  'AlreadyApproved(uint256,address)': 'this member has already approved',
  'NotFactory(address)': 'only the founding factory may write the registry',
  'NotDeployer(address)': 'only the registry deployer may wire it',
  'AlreadyWired()': 'the registry is already wired to its factory',
  'NameTaken(string)': 'that hall name is taken',
  'NameInvalid(string)': 'hall names are 1-64 chars: lowercase a-z, 0-9, hyphen, underscore',
};

const KNOWN_BY_SELECTOR = new Map(Object.entries(KNOWN_ERROR_SIGS).map(([sig, msg]) => [id(sig).slice(0, 10).toLowerCase(), msg]));

function hexToText(hex: string): string {
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  try {
    return decodeURIComponent(escape(out));
  } catch {
    return out;
  }
}

function extractHex(message: string, data?: unknown): string | null {
  if (typeof data === 'string' && /^0x[0-9a-fA-F]{10,}$/.test(data)) return data.toLowerCase();
  const m = /0x[0-9a-fA-F]{10,}/.exec(message);
  return m ? m[0].toLowerCase() : null;
}

export function explainRevert(message: string, data?: unknown): string {
  const hex = extractHex(message, data);
  if (hex) {
    // Error(string)
    if (hex.startsWith('0x08c379a0') && hex.length >= 10 + 128) {
      try {
        const len = parseInt(hex.slice(10 + 64, 10 + 128), 16);
        const text = hexToText(hex.slice(10 + 128, 10 + 128 + len * 2));
        if (text) return `The contract refused: ${text}`;
      } catch {
        /* fall through */
      }
    }
    // Panic(uint256)
    if (hex.startsWith('0x4e487b71') && hex.length >= 10 + 64) {
      const code = parseInt(hex.slice(10, 10 + 64), 16);
      return `The contract panicked: ${PANICS[code] ?? `code ${code}`}.`;
    }
    // Known DarkOrder custom error
    const known = KNOWN_BY_SELECTOR.get(hex.slice(0, 10));
    if (known) return `The contract refused: ${known}.`;
  }
  const trimmed = message.replace(/^execution reverted:?\s*/i, '').trim();
  return trimmed.length > 220 ? `${trimmed.slice(0, 220)}…` : trimmed || 'The call was refused without a reason.';
}
