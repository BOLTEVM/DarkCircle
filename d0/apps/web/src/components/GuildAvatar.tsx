import React from 'react';
import { Crown, Flame } from 'lucide-react';
import { cx } from './primitives.js';

/**
 * A hall's crest: the uploaded avatar when the profile carries one, otherwise the mode sigil.
 * Avatars are raster data URIs or https/ipfs pointers validated by parseGuildProfile, so the
 * <img> never sees javascript: or svg payloads.
 */
export const GuildAvatar: React.FC<{ avatar: string | null; mode: 'token' | 'council'; size?: 'md' | 'lg'; className?: string }> = ({
  avatar,
  mode,
  size = 'md',
  className,
}) => {
  const box = size === 'lg' ? 'h-12 w-12 rounded-xl' : 'h-10 w-10 rounded-lg';
  const icon = size === 'lg' ? 'h-6 w-6' : 'h-5 w-5';
  if (avatar) {
    return (
      <img
        src={avatar}
        alt=""
        className={cx(box, 'shrink-0 border border-gold/25 object-cover', className)}
        loading="lazy"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <span className={cx(box, 'flex shrink-0 items-center justify-center border border-gold/25 bg-gold/10 text-gold', className)}>
      {mode === 'token' ? <Flame className={icon} aria-hidden /> : <Crown className={icon} aria-hidden />}
    </span>
  );
};
