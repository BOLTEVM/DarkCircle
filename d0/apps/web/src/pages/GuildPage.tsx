import React, { useEffect, useMemo, useState } from 'react';
import { Crown, ExternalLink, Flame, Gem, ScrollText, Users } from 'lucide-react';
import {
  councilProposalStatus,
  explorerAddressUrl,
  formatTokenAmount,
  qnsProfileUrl,
  qnsSearchUrl,
  readCouncilMembers,
  readCouncilProposal,
  readGuildSummary,
  readVotingProposal,
  shortAddress,
  showcaseSummary,
  votingProposalStatus,
  type CouncilProposalView,
  type GuildRecord,
  type GuildSummary,
  type ProposalStatus,
  type VotingProposalView,
} from '@darkorder/core';
import { href, navigate } from '../lib/router.js';
import { canExecuteProposal, proposalCount, readMinApprovals } from '../lib/chain.js';
import { setCurrentGuild } from '../lib/currentGuild.js';
import { useNetwork } from '../state/NetworkContext.js';
import { useGuildDirectory } from '../state/directory.js';
import { Badge, Button, Card, Notice, Stat, cx } from '../components/primitives.js';
import { VoteMeter } from '../components/VoteMeter.js';

interface ListedProposal {
  id: number;
  metadata: string;
  status: ProposalStatus;
  voting?: VotingProposalView;
  council?: CouncilProposalView;
}

const STATUS_TONE: Record<ProposalStatus, 'gold' | 'emerald' | 'rose' | 'sky' | 'slate'> = {
  active: 'gold',
  pending: 'sky',
  passed: 'emerald',
  defeated: 'rose',
  executed: 'slate',
};

export const GuildPage: React.FC<{ name: string }> = ({ name }) => {
  const { network, rpc } = useNetwork();
  const directory = useGuildDirectory();
  const record = useMemo<GuildRecord | null>(
    () => directory.guilds.find((g) => g.name === name) ?? null,
    [directory.guilds, name]
  );
  const showcase = directory.mode === 'showcase';
  const [summary, setSummary] = useState<GuildSummary | null>(null);
  const [proposals, setProposals] = useState<ListedProposal[] | null>(null);
  const [members, setMembers] = useState<{ list: string[]; minApprovals: bigint } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The voice agent and tribute desk treat the last-opened hall as "current".
  useEffect(() => {
    if (record && !showcase) setCurrentGuild(record);
  }, [record, showcase]);

  useEffect(() => {
    let alive = true;
    setSummary(null);
    setProposals(null);
    setMembers(null);
    setError(null);
    if (!record) return;
    if (showcase) {
      setSummary(showcaseSummary(record));
      setProposals([]);
      return;
    }
    (async () => {
      try {
        const sum = await readGuildSummary(rpc, record);
        if (!alive) return;
        setSummary(sum);
        const count = await proposalCount(rpc, record);
        const ids = Array.from({ length: Math.min(count, 25) }, (_, k) => count - 1 - k);
        const listed: ListedProposal[] = [];
        for (const id of ids) {
          const canExec = await canExecuteProposal(rpc, record, id).catch(() => false);
          if (record.mode === 'token') {
            const p = await readVotingProposal(rpc, record.module, id);
            listed.push({ id, metadata: p.metadata, status: votingProposalStatus(p, canExec), voting: p });
          } else {
            const p = await readCouncilProposal(rpc, record.module, id);
            listed.push({ id, metadata: p.metadata, status: councilProposalStatus(p, canExec), council: p });
          }
        }
        if (!alive) return;
        setProposals(listed);
        if (record.mode === 'council') {
          const [list, minApprovals] = await Promise.all([readCouncilMembers(rpc, record.module), readMinApprovals(rpc, record.module)]);
          if (alive) setMembers({ list, minApprovals });
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [rpc, record, showcase]);

  if (directory.mode !== 'loading' && !record) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center">
        <h1 className="font-display text-3xl text-bone">No hall called “{name}”</h1>
        <p className="mt-3 text-sm text-bone-dim">
          Search it on{' '}
          <a href={qnsSearchUrl(name)} target="_blank" rel="noopener noreferrer" className="text-gold underline underline-offset-2 hover:text-gold-light">
            quaidomains.com
          </a>{' '}
          or found it yourself.
        </p>
        <Button className="mt-6" variant="secondary" onClick={() => navigate({ name: 'home' })}>
          Back to the halls
        </Button>
      </div>
    );
  }

  const explorer = (addr: string) => explorerAddressUrl(network, addr);

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 lg:px-8">
      {record && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-gold/25 bg-gold/10 text-gold">
                {record.mode === 'token' ? <Flame className="h-6 w-6" aria-hidden /> : <Crown className="h-6 w-6" aria-hidden />}
              </span>
              <div>
                <h1 className="font-display text-3xl text-bone">{record.name}</h1>
                <div className="mt-1 flex items-center gap-2">
                  <Badge tone={record.mode === 'token' ? 'gold' : 'sky'}>{record.mode === 'token' ? 'Token hall' : 'Council hall'}</Badge>
                  {showcase && <Badge tone="amber">Showcase</Badge>}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              {record.mode === 'token' && !showcase && (
                <Button variant="secondary" onClick={() => navigate({ name: 'mint', guild: record.name })}>
                  <Gem className="h-4 w-4" aria-hidden /> Voting power
                </Button>
              )}
              <Button onClick={() => navigate({ name: 'tribute' })} disabled={showcase} title={showcase ? 'Disabled in showcase mode' : 'Pay x402 tribute'}>
                Tribute
              </Button>
            </div>
          </div>

          <p className="mt-5 max-w-3xl text-sm leading-relaxed text-bone-dim">{summary?.metadata ?? '…'}</p>

          {/* QNS identity block */}
          <Card className="mt-6 flex flex-wrap items-center justify-between gap-3 border-gold/20 bg-gold/[0.04]">
            <div className="text-sm">
              <span className="text-bone-dim">Identity: </span>
              <span className="font-mono text-gold-light">{record.name}.quai</span>
              <span className="ml-2 text-xs text-bone-mute">QNS on quaidomains.com — the suite's answer to ENS</span>
            </div>
            <div className="flex gap-3 text-xs">
              <a href={qnsProfileUrl(`${record.name}.quai`)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-gold hover:text-gold-light">
                Profile <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
              <a href={qnsSearchUrl(record.name)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-bone-dim hover:text-bone">
                Claim / search <ExternalLink className="h-3 w-3" aria-hidden />
              </a>
            </div>
          </Card>

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <Card>
              <Stat label="Treasury" value={summary ? `${formatTokenAmount(summary.treasury)} QUAI` : '…'} />
            </Card>
            <Card>
              <Stat label="Proposals" value={proposals ? proposals.length.toString() : '…'} hint="most recent, up to 25" />
            </Card>
            <Card>
              <Stat
                label={record.mode === 'council' ? 'Council' : 'Module'}
                value={record.mode === 'council' && members ? `${members.minApprovals.toString()} of ${members.list.length}` : shortAddress(record.module)}
                hint={record.mode === 'council' ? 'approvals to act' : 'governance module'}
              />
            </Card>
          </div>

          {error && (
            <Notice tone="danger" className="mt-6">
              Could not read this hall: {error}
            </Notice>
          )}

          {record.mode === 'council' && members && (
            <Card className="mt-6">
              <h2 className="flex items-center gap-2 font-display text-lg text-bone">
                <Users className="h-4 w-4 text-gold" aria-hidden /> The council
              </h2>
              <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
                {members.list.map((m) => (
                  <li key={m} className="font-mono text-xs text-bone-dim">
                    {explorer(m) ? (
                      <a href={explorer(m)!} target="_blank" rel="noopener noreferrer" className="hover:text-gold">
                        {m}
                      </a>
                    ) : (
                      m
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <section className="mt-10">
            <div className="flex items-center justify-between">
              <h2 className="flex items-center gap-2 font-display text-2xl text-bone">
                <ScrollText className="h-5 w-5 text-gold" aria-hidden /> Proposals
              </h2>
            </div>
            {proposals === null ? (
              <div className="mt-4 space-y-3">
                {[0, 1].map((i) => (
                  <Card key={i} className="h-24 animate-pulse bg-panel-raised" />
                ))}
              </div>
            ) : proposals.length === 0 ? (
              <Card className="mt-4">
                <p className="text-sm text-bone-dim">
                  {showcase
                    ? 'Sample proposals live on the War Room page of a sample hall once the protocol is deployed.'
                    : 'No proposals yet. The first one sets the tone of the hall.'}
                </p>
              </Card>
            ) : (
              <div className="mt-4 space-y-3">
                {proposals.map((p) => (
                  <a key={p.id} href={href({ name: 'proposal', guild: record.name, id: p.id })} className="group block">
                    <Card className="transition-colors group-hover:border-gold/40">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <span className="font-mono text-xs text-bone-mute">#{p.id}</span>
                          <span className={cx('ml-2 text-sm text-bone group-hover:text-gold-light')}>{p.metadata || '(untitled)'}</span>
                        </div>
                        <Badge tone={STATUS_TONE[p.status]}>{p.status}</Badge>
                      </div>
                      {p.voting && (
                        <div className="mt-3">
                          <VoteMeter proposal={p.voting} thresholdBps={Number(p.voting.supportThreshold)} totalSupply={0n} />
                        </div>
                      )}
                      {p.council && <div className="mt-2 text-xs text-bone-mute">{p.council.approvals.toString()} approval{p.council.approvals === 1n ? '' : 's'}</div>}
                    </Card>
                  </a>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
};
