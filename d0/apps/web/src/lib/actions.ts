import { id as keccakId } from 'ethers';
import { GUILD, TOKEN, VOTING, formatTokenAmount, shortAddress, type GuildAction } from '@darkorder/core';

/**
 * Turns a proposal's raw actions into plain language for the War Room, so a voter reads what a
 * proposal DOES, not its calldata. Known shapes are decoded with the same ABIs the contracts
 * expose; anything unrecognized is shown as a raw call, never hidden.
 */

const ROLE_NAMES: Record<string, string> = {
  [keccakId('ROOT_ROLE').toLowerCase()]: 'root power',
  [keccakId('EXECUTE_ROLE').toLowerCase()]: 'execute power',
  [keccakId('SET_METADATA_ROLE').toLowerCase()]: 'metadata power',
};

export interface ActionExplanation {
  title: string;
  detail: string;
  /** false for calls we could not decode: the voter should treat them with care. */
  decoded: boolean;
}

export function explainAction(action: GuildAction, ctx: { guild: string; token: string | null; module: string }): ActionExplanation {
  const to = action.to.toLowerCase();
  const data = action.data ?? '0x';
  const value = action.value ?? 0n;

  // Plain QUAI transfer.
  if (data === '0x' && value > 0n) {
    return {
      title: `Send ${formatTokenAmount(value)} QUAI`,
      detail: `Moves ${formatTokenAmount(value)} QUAI from the treasury to ${shortAddress(action.to)}.`,
      decoded: true,
    };
  }

  const tryParse = (iface: typeof GUILD | typeof TOKEN | typeof VOTING) => {
    try {
      return iface.parseTransaction({ data, value });
    } catch {
      return null;
    }
  };

  // Token calls (mint / delegate / transfers).
  if (ctx.token && to === ctx.token.toLowerCase()) {
    const tx = tryParse(TOKEN);
    if (tx) {
      if (tx.name === 'mint') {
        const [toAddr, amount] = tx.args as unknown as [string, bigint];
        return {
          title: 'Mint new voting power',
          detail: `Mints ${formatTokenAmount(amount)} governance tokens to ${shortAddress(toAddr)}. New supply dilutes every current holder.`,
          decoded: true,
        };
      }
      if (tx.name === 'delegate') {
        const [delegatee] = tx.args as unknown as [string];
        return { title: 'Delegate voting power', detail: `Delegates the treasury's voting power to ${shortAddress(delegatee)}.`, decoded: true };
      }
      if (tx.name === 'transfer') {
        const [toAddr, amount] = tx.args as unknown as [string, bigint];
        return {
          title: 'Transfer governance tokens',
          detail: `Sends ${formatTokenAmount(amount)} governance tokens to ${shortAddress(toAddr)}.`,
          decoded: true,
        };
      }
      return { title: `Token call: ${tx.name}`, detail: `Calls ${tx.name} on the guild's governance token.`, decoded: true };
    }
  }

  // Calls on the guild itself.
  if (to === ctx.guild.toLowerCase()) {
    const tx = tryParse(GUILD);
    if (tx) {
      if (tx.name === 'setMetadata') {
        const [metadata] = tx.args as unknown as [string];
        return { title: 'Rewrite the charter', detail: `Replaces the guild's metadata with: “${metadata.length > 140 ? `${metadata.slice(0, 140)}…` : metadata}”`, decoded: true };
      }
      if (tx.name === 'grant' || tx.name === 'revoke') {
        const [role, who] = tx.args as unknown as [string, string];
        const roleName = ROLE_NAMES[role.toLowerCase()] ?? `role ${shortAddress(role, 10, 6)}`;
        return {
          title: `${tx.name === 'grant' ? 'Grant' : 'Revoke'} ${roleName}`,
          detail: `${tx.name === 'grant' ? 'Gives' : 'Takes'} ${roleName} ${tx.name === 'grant' ? 'to' : 'from'} ${shortAddress(who)}.`,
          decoded: true,
        };
      }
      return { title: `Guild call: ${tx.name}`, detail: `Calls ${tx.name} on the guild contract itself.`, decoded: true };
    }
    if (data === '0x') return { title: 'Touch the guild', detail: 'Calls the guild with no calldata and no value.', decoded: true };
  }

  // Calls on the voting module (rule changes).
  if (to === ctx.module.toLowerCase()) {
    const tx = tryParse(VOTING);
    if (tx && tx.name === 'updateSettings') {
      const [support, participation, duration] = tx.args as unknown as [bigint, bigint, bigint];
      return {
        title: 'Change the voting rules',
        detail: `Support threshold ${(Number(support) / 100).toFixed(1)}%, minimum participation ${(Number(participation) / 100).toFixed(1)}%, minimum duration ${Number(duration) / 3600}h. Applies to future proposals.`,
        decoded: true,
      };
    }
    if (tx) return { title: `Module call: ${tx.name}`, detail: `Calls ${tx.name} on the governance module.`, decoded: true };
  }

  return {
    title: `Raw call to ${shortAddress(action.to)}`,
    detail: `${(data.length - 2) / 2} bytes of calldata${value > 0n ? ` and ${formatTokenAmount(value)} QUAI` : ''}. This action is not one of the known shapes; read the calldata before voting.`,
    decoded: false,
  };
}
