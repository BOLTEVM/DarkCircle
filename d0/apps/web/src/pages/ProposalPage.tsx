import React, { useEffect, useMemo, useState } from 'react';
import { Gavel, ShieldCheck } from 'lucide-react';
import {
  COUNCIL,
  TOKEN,
  VOTING,
  councilProposalStatus,
  encodeCouncilApprove,
  encodeCouncilExecute,
  encodeVote,
  encodeVotingExecute,
  formatTokenAmount,
  readCouncilActions,
  readCouncilProposal,
  readVotingActions,
  readVotingProposal,
  showcaseProposal,
  votingProposalStatus,
  type CouncilProposalView,
  type GuildAction,
  type GuildRecord,
  type ProposalStatus,
  type RpcClient,
  type VoteChoice,
  type VotingProposalView,
} from '@darkorder/core';
import { explainAction } from '../lib/actions.js';
import { canExecuteProposal, readVotingPower } from '../lib/chain.js';
import { navigate } from '../lib/router.js';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { useTx, CHAIN_CHANGED_EVENT } from '../state/TxContext.js';
import { useGuildDirectory } from '../state/directory.js';
import { Badge, Button, Card, Notice, Stat, cx } from '../components/primitives.js';
import { VoteMeter } from '../components/VoteMeter.js';

const STATUS_TONE: Record<ProposalStatus, 'gold' | 'emerald' | 'rose' | 'sky' | 'slate'> = {
  active: 'gold',
  pending: 'sky',
  passed: 'emerald',
  defeated: 'rose',
  executed: 'slate',
};

const VOTE_WORD: Record<number, string> = { 0: 'no vote', 1: 'abstain', 2: 'yes', 3: 'no' };

async function callOne(rpc: RpcClient, to: string, iface: typeof VOTING | typeof COUNCIL | typeof TOKEN, fn: string, args: unknown[]): Promise<any> {
  const raw = await rpc.call({ to, data: iface.encodeFunctionData(fn, args) });
  return iface.decodeFunctionResult(fn, raw)[0];
}

export const ProposalPage: React.FC<{ guildName: string; id: number }> = ({ guildName, id }) => {
  const { rpc } = useNetwork();
  const { address } = useWallet();
  const tx = useTx();
  const directory = useGuildDirectory();
  const record = useMemo<GuildRecord | null>(() => directory.guilds.find((g) => g.name === guildName) ?? null, [directory.guilds, guildName]);
  const showcase = directory.mode === 'showcase';

  const [voting, setVoting] = useState<VotingProposalView | null>(null);
  const [council, setCouncil] = useState<CouncilProposalView | null>(null);
  const [actions, setActions] = useState<GuildAction[] | null>(null);
  const [canExec, setCanExec] = useState(false);
  const [myVote, setMyVote] = useState(0);
  const [myApproved, setMyApproved] = useState(false);
  const [power, setPower] = useState<bigint | null>(null);
  const [supply, setSupply] = useState<bigint>(0n);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    const onChange = () => setNonce((n) => n + 1);
    window.addEventListener(CHAIN_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CHAIN_CHANGED_EVENT, onChange);
  }, []);

  useEffect(() => {
    let alive = true;
    setVoting(null);
    setCouncil(null);
    setActions(null);
    setMyVote(0);
    setMyApproved(false);
    setPower(null);
    setError(null);
    if (!record) return;
    if (showcase) {
      const now = Math.floor(Date.now() / 1000);
      setVoting(record.mode === 'token' ? showcaseProposal(record.name, id) : null);
      setCouncil(record.mode === 'council' ? { id, metadata: 'Rotate the eastern keyholder', createdAt: now - 43_200, executed: false, approvals: 2n } : null);
      setActions([]);
      setSupply(100_000n * 10n ** 18n);
      return;
    }
    (async () => {
      try {
        const [exec, acts] = await Promise.all([
          canExecuteProposal(rpc, record, id),
          record.mode === 'token' ? readVotingActions(rpc, record.module, id) : readCouncilActions(rpc, record.module, id),
        ]);
        if (!alive) return;
        setCanExec(exec);
        setActions(acts);
        if (record.mode === 'token' && record.token) {
          const p = await readVotingProposal(rpc, record.module, id);
          if (!alive) return;
          setVoting(p);
          setSupply(await callOne(rpc, record.token, TOKEN, 'getPastTotalSupply', [p.snapshotBlock]).then(BigInt, () => 0n));
          if (address) {
            const [vp, vote] = await Promise.all([
              readVotingPower(rpc, record.token!, address).catch(() => null),
              callOne(rpc, record.module, VOTING, 'voteOf', [id, address]).then(Number, () => 0),
            ]);
            if (!alive) return;
            if (vp) setPower(vp.votes);
            setMyVote(vote);
          }
        } else {
          const p = await readCouncilProposal(rpc, record.module, id);
          if (!alive) return;
          setCouncil(p);
          if (address) {
            const approved = await callOne(rpc, record.module, COUNCIL, 'hasApproved', [id, address]).then(Boolean, () => false);
            if (alive) setMyApproved(approved);
          }
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [rpc, record, id, showcase, address, nonce]);

  const status: ProposalStatus | null = voting ? votingProposalStatus(voting, canExec) : council ? councilProposalStatus(council, canExec) : null;

  const vote = (choice: VoteChoice) => {
    if (!record) return;
    void tx.run(`Vote ${choice} on proposal ${id}`, [
      { label: `Vote ${choice.toUpperCase()} on proposal #${id} in "${record.name}"`, build: () => ({ to: record.module, data: encodeVote(id, choice, true), value: 0n }) },
    ]);
  };
  const approve = () => {
    if (!record) return;
    void tx.run(`Approve proposal ${id}`, [
      { label: `Approve proposal #${id} in the "${record.name}" council`, build: () => ({ to: record.module, data: encodeCouncilApprove(id, true), value: 0n }) },
    ]);
  };
  const execute = () => {
    if (!record) return;
    const data = record.mode === 'token' ? encodeVotingExecute(id) : encodeCouncilExecute(id);
    void tx.run(`Execute proposal ${id}`, [
      { label: `Execute proposal #${id} in "${record.name}" — its actions run as the guild`, build: () => ({ to: record.module, data, value: 0n }) },
    ]);
  };

  if (directory.mode !== 'loading' && !record) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center">
        <h1 className="font-display text-3xl text-bone">No hall called “{guildName}”</h1>
        <Button className="mt-6" variant="secondary" onClick={() => navigate({ name: 'home' })}>
          Back to the halls
        </Button>
      </div>
    );
  }

  const title = voting?.metadata ?? council?.metadata ?? '';
  const active = status === 'active';
  const passed = status === 'passed';

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 lg:px-8">
      {record && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <a href={`#/guild/${encodeURIComponent(record.name)}`} className="text-xs text-bone-mute hover:text-gold">
                ← {record.name}
              </a>
              <h1 className="mt-1 font-display text-3xl text-bone">
                <span className="mr-2 font-mono text-xl text-bone-mute">#{id}</span>
                {title || 'War Room'}
              </h1>
            </div>
            {status && <Badge tone={STATUS_TONE[status]}>{status}</Badge>}
          </div>

          {showcase && (
            <Notice tone="gold" className="mt-4" title="Showcase">
              This war room shows invented numbers. Nothing here can be signed until the protocol is deployed on this network.
            </Notice>
          )}
          {error && (
            <Notice tone="danger" className="mt-4">
              Could not read this proposal: {error}
            </Notice>
          )}

          {voting && (
            <div className="mt-6 grid gap-4 sm:grid-cols-3">
              <Card>
                <Stat label="Closes" value={new Date(voting.endDate * 1000).toLocaleString()} hint={`opened ${new Date(voting.startDate * 1000).toLocaleString()}`} />
              </Card>
              <Card>
                <Stat
                  label="Rules (snapshot)"
                  value={`${Number(voting.supportThreshold) / 100}% / ${Number(voting.minParticipation) / 100}%`}
                  hint="support / turnout, frozen at creation"
                />
              </Card>
              <Card>
                <Stat label="Your power" value={power !== null ? formatTokenAmount(power) : '—'} hint={address ? 'your delegated votes right now' : 'connect a wallet'} />
              </Card>
            </div>
          )}

          {voting && (
            <Card className="mt-4">
              <VoteMeter proposal={voting} thresholdBps={Number(voting.supportThreshold)} totalSupply={supply} />
            </Card>
          )}

          {council && (
            <Card className="mt-6">
              <Stat label="Approvals" value={council.approvals.toString()} hint={myApproved ? 'you have approved' : 'waiting on council keys'} />
            </Card>
          )}

          <Card className="mt-4">
            <h2 className="flex items-center gap-2 font-display text-lg text-bone">
              <Gavel className="h-4 w-4 text-gold" aria-hidden /> What this proposal does
            </h2>
            {actions === null ? (
              <p className="mt-3 text-sm text-bone-mute">Reading the actions…</p>
            ) : actions.length === 0 ? (
              <p className="mt-3 text-sm text-bone-dim">A motion without actions: it speaks, but moves nothing.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {actions.map((a, i) => {
                  const ex = explainAction(a, { guild: record.guild, token: record.token, module: record.module });
                  return (
                    <li key={i} className={cx('rounded-lg border px-4 py-3', ex.decoded ? 'border-line bg-ink-deep' : 'border-amber-400/30 bg-amber-400/[0.05]')}>
                      <div className="text-sm font-medium text-bone">{ex.title}</div>
                      <div className="mt-0.5 text-xs leading-relaxed text-bone-mute">{ex.detail}</div>
                      {!ex.decoded && <div className="mt-1.5 break-all font-mono text-[10px] text-bone-mute">{a.data}</div>}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {!showcase && (
            <Card className="mt-4 border-gold/25">
              <h2 className="flex items-center gap-2 font-display text-lg text-bone">
                <ShieldCheck className="h-4 w-4 text-gold" aria-hidden /> The floor
              </h2>
              {!address ? (
                <p className="mt-2 text-sm text-bone-dim">Connect a wallet to act.</p>
              ) : record.mode === 'token' ? (
                <div className="mt-3 space-y-3">
                  <div className="flex flex-wrap gap-2">
                    {(['yes', 'no', 'abstain'] as const).map((choice) => (
                      <Button key={choice} variant={choice === 'no' ? 'danger' : choice === 'yes' ? 'primary' : 'secondary'} disabled={!active || myVote !== 0} onClick={() => vote(choice)}>
                        Vote {choice}
                      </Button>
                    ))}
                  </div>
                  <p className="text-xs text-bone-mute">
                    {myVote !== 0
                      ? `Your recorded vote: ${VOTE_WORD[myVote] ?? 'unknown'}. Votes cannot be changed.`
                      : active
                        ? 'One vote per address, weighed at the proposal’s snapshot.'
                        : 'Voting is not open.'}
                  </p>
                </div>
              ) : (
                <div className="mt-3 space-y-3">
                  <Button onClick={approve} disabled={!active || myApproved}>
                    {myApproved ? 'You have approved' : 'Approve (and try execution)'}
                  </Button>
                  <p className="text-xs text-bone-mute">Approval with try-execution runs the proposal the moment the threshold lands.</p>
                </div>
              )}
              {passed && (
                <div className="mt-4 border-t border-line pt-4">
                  <Button onClick={execute}>Execute now</Button>
                </div>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
};
