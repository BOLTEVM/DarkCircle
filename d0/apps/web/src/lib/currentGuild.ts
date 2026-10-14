import type { GuildRecord } from '@darkorder/core';

/**
 * The hall the user is "in". GuildPage sets it when a hall loads; the voice agent and the
 * tribute desk read it so "vote yes on proposal 3" knows which guild is meant. Kept in
 * localStorage so it survives a reload; never trusted as anything but a hint.
 */

const KEY = 'darkorder.current-guild';
export const CURRENT_GUILD_EVENT = 'darkorder:current-guild';

export function setCurrentGuild(record: GuildRecord): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    /* not remembered */
  }
  window.dispatchEvent(new CustomEvent(CURRENT_GUILD_EVENT));
}

export function getCurrentGuild(): GuildRecord | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as GuildRecord;
    if (typeof v?.name !== 'string' || typeof v?.guild !== 'string' || typeof v?.module !== 'string') return null;
    if (v.mode !== 'token' && v.mode !== 'council') return null;
    return { name: v.name, guild: v.guild, module: v.module, mode: v.mode, token: typeof v.token === 'string' ? v.token : null };
  } catch {
    return null;
  }
}
