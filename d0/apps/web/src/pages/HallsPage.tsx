import React, { useMemo, useState } from 'react';
import { Castle, Coins, Flame, Search, Users } from 'lucide-react';
import { formatTokenAmount, normalizeQnsName, parseGuildProfile, qnsSearchUrl, type GuildSummary } from '@darkorder/core';
import { href } from '../lib/router.js';
import { useNetwork } from '../state/NetworkContext.js';
import { useGuildDirectory } from '../state/directory.js';
import { GuildAvatar } from '../components/GuildAvatar.js';
import { Badge, Card, TextField, cx } from '../components/primitives.js';

const GuildCard: React.FC<{ record: GuildSummary; enriching: boolean }> = ({ record, enriching }) => {
  const profile = useMemo(() => parseGuildProfile(record.metadata), [record.metadata]);
  return (
    <a href={href({ name: 'guild', guild: record.name })} className="group block">
      <Card className="flex h-full flex-col transition-colors group-hover:border-gold/40 group-hover:bg-panel-hover">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <GuildAvatar avatar={profile.avatar} mode={record.mode} />
            <div>
              <div className="font-display text-lg text-bone group-hover:text-gold-light">{record.name}</div>
              <div className="text-xs text-bone-mute">{record.mode === 'token' ? 'Token hall' : 'Council hall'}</div>
            </div>
          </div>
          <Badge tone={record.mode === 'token' ? 'gold' : 'sky'}>{record.mode}</Badge>
        </div>
        <p className={cx('mt-3 line-clamp-3 min-h-[3.75rem] text-sm leading-relaxed text-bone-dim', enriching && !record.metadata && 'animate-pulse text-bone-mute')}>
          {profile.description || (enriching && !record.metadata ? 'Reading the charter…' : 'This hall keeps no charter yet.')}
        </p>
        <div className="mt-auto flex items-center justify-between gap-2 pt-4 text-xs text-bone-mute">
          <span className="inline-flex items-center gap-1.5">
            <Coins className="h-3.5 w-3.5 text-gold/70" aria-hidden />
            {enriching && record.treasury === 0n ? '…' : `${formatTokenAmount(record.treasury)} QUAI`}
          </span>
          {profile.links.length > 0 && <span>{profile.links.length} link{profile.links.length === 1 ? '' : 's'}</span>}
        </div>
      </Card>
    </a>
  );
};

export const HallsPage: React.FC = () => {
  const { network } = useNetwork();
  const directory = useGuildDirectory();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return directory.guilds;
    return directory.guilds.filter((g) => g.name.toLowerCase().includes(q) || parseGuildProfile(g.metadata).description.toLowerCase().includes(q));
  }, [directory.guilds, query]);

  const qns = normalizeQnsName(query);

  return (
    <div className="mx-auto max-w-7xl px-4 lg:px-8">
      {/* Hero */}
      <section className="py-14 sm:py-20">
        <div className="mx-auto max-w-3xl text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-gold/30 bg-gold/10 text-gold shadow-ember">
            <Castle className="h-7 w-7" aria-hidden />
          </div>
          <h1 className="mt-6 font-display text-4xl text-bone sm:text-5xl">The Grand Guild Halls</h1>
          <p className="mx-auto mt-4 max-w-2xl text-sm leading-relaxed text-bone-dim sm:text-base">
            Every guild of the DarkOrder lives here, on Quai's Cyprus-1: founded in one transaction, governed by token vote or council, fed by x402 tribute.
            Speak your intent to the voice agent, or walk the halls by hand.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href={href({ name: 'found' })}
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-gold px-5 text-sm font-semibold text-ink shadow-lift transition-colors hover:bg-gold-light"
            >
              <Flame className="h-4 w-4" aria-hidden /> Found a guild
            </a>
            <a
              href={href({ name: 'voice' })}
              className="inline-flex h-11 items-center gap-2 rounded-lg border border-line bg-panel-raised px-5 text-sm text-bone transition-colors hover:border-line-strong hover:bg-panel-hover"
            >
              Speak to the agent
            </a>
          </div>
        </div>
      </section>

      {/* Directory */}
      <section className="pb-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="font-display text-2xl text-bone">The Directory</h2>
            <p className="mt-1 text-sm text-bone-mute">
              {directory.mode === 'chain'
                ? `${directory.guilds.length} guild${directory.guilds.length === 1 ? '' : 's'} in the on-chain registry on ${network.label}.`
                : directory.mode === 'showcase'
                  ? 'Sample halls, shown until the protocol is deployed on this network.'
                  : directory.mode === 'loading'
                    ? 'Reading the on-chain registry…'
                    : 'The registry could not be read.'}
            </p>
          </div>
          <div className="w-full sm:w-80">
            <TextField
              label="Search the halls"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="emberhold, ironcouncil…"
              className="[&>label]:sr-only"
            />
          </div>
        </div>

        {directory.mode === 'error' && (
          <Card className="mt-6 border-rose-400/30">
            <p className="text-sm text-rose-200">Could not read the registry: {directory.error}</p>
          </Card>
        )}

        {directory.mode === 'loading' && (
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="h-32 animate-pulse bg-panel-raised" />
            ))}
          </div>
        )}

        {(directory.mode === 'chain' || directory.mode === 'showcase') && (
          <>
            {filtered.length === 0 ? (
              <Card className="mt-6">
                <p className="text-sm text-bone-dim">No hall matches “{query}”.</p>
                {qns && (
                  <p className="mt-2 text-sm text-bone-dim">
                    Claim <span className="font-mono text-gold-light">{qns.fqdn}</span> as your guild's identity on{' '}
                    <a href={qnsSearchUrl(qns.name)} target="_blank" rel="noopener noreferrer" className="text-gold underline underline-offset-2 hover:text-gold-light">
                      quaidomains.com
                    </a>
                    , then found the hall to match.
                  </p>
                )}
              </Card>
            ) : (
              <div className={cx('mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3', directory.mode === 'showcase' && 'opacity-90')}>
                {filtered.map((g) => (
                  <GuildCard key={g.guild} record={g} enriching={directory.enriching} />
                ))}
              </div>
            )}
          </>
        )}
      </section>

      {/* How a guild lives */}
      <section className="border-t border-line py-12">
        <div className="grid gap-8 md:grid-cols-3">
          <div>
            <Flame className="h-5 w-5 text-gold" aria-hidden />
            <h3 className="mt-3 font-display text-lg text-bone">Founded in one rite</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-bone-mute">
              One transaction deploys the guild, its voting module and its token, mints the founder's power, and cuts the factory out entirely. No admin keys
              survive it.
            </p>
          </div>
          <div>
            <Users className="h-5 w-5 text-gold" aria-hidden />
            <h3 className="mt-3 font-display text-lg text-bone">Governed two ways</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-bone-mute">
              Token halls weigh checkpointed votes against thresholds snapshotted per proposal. Council halls turn a fixed set of keys, N of M, into one will.
            </p>
          </div>
          <div>
            <Search className="h-5 w-5 text-gold" aria-hidden />
            <h3 className="mt-3 font-display text-lg text-bone">Named by QNS</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-bone-mute">
              The registry handle is a directory key; identity is a <span className="font-mono">.quai</span> name on quaidomains.com, the suite's answer to ENS.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};
