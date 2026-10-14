import React, { useEffect, useMemo, useState } from 'react';
import { Gem } from 'lucide-react';
import {
  TOKEN,
  checkAddress,
  encodeCreateVotingProposal,
  encodeDelegate,
  formatTokenAmount,
  parseTokenAmount,
  sameAddress,
  shortAddress,
  type GuildRecord,
} from '@darkorder/core';
import { readTokenMeta, readVotingPower, type TokenMeta, type VotingPower } from '../lib/chain.js';
import { navigate } from '../lib/router.js';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { useTx, CHAIN_CHANGED_EVENT } from '../state/TxContext.js';
import { useGuildDirectory } from '../state/directory.js';
import { Button, Card, Notice, Stat, TextArea, TextField } from '../components/primitives.js';
import { ZERO_ADDRESS } from '@darkorder/core';

/**
 * Voting power for a token hall: delegation (instant, one signature) and minting (a governance
 * act — the form drafts a proposal whose sole action mints to a chosen address).
 */
export const MintPage: React.FC<{ guildName: string }> = ({ guildName }) => {
  const { rpc } = useNetwork();
  const { address } = useWallet();
  const tx = useTx();
  const directory = useGuildDirectory();
  const record = useMemo<GuildRecord | null>(() => directory.guilds.find((g) => g.name === guildName) ?? null, [directory.guilds, guildName]);
  const showcase = directory.mode === 'showcase';

  const [meta, setMeta] = useState<TokenMeta | null>(null);
  const [power, setPower] = useState<VotingPower | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const [mintTo, setMintTo] = useState('');
  const [mintAmount, setMintAmount] = useState('');
  const [mintMemo, setMintMemo] = useState('');

  useEffect(() => {
    const onChange = () => setNonce((n) => n + 1);
    window.addEventListener(CHAIN_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(CHAIN_CHANGED_EVENT, onChange);
  }, []);

  useEffect(() => {
    let alive = true;
    setMeta(null);
    setPower(null);
    setError(null);
    if (!record || record.mode !== 'token' || !record.token || showcase) return;
    (async () => {
      try {
        const m = await readTokenMeta(rpc, record.token!);
        if (!alive) return;
        setMeta(m);
        if (address) {
          const p = await readVotingPower(rpc, record.token!, address);
          if (alive) setPower(p);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [rpc, record, address, showcase, nonce]);

  const delegateSelf = () => {
    if (!record?.token || !address) return;
    void tx.run(`Delegate voting power in "${record.name}"`, [
      { label: `Delegate your ${meta?.symbol ?? 'token'} voting power to yourself`, build: () => ({ to: record.token!, data: encodeDelegate(address), value: 0n }) },
    ]);
  };

  const mintProblem = useMemo(() => {
    if (!mintTo && !mintAmount && !mintMemo) return null;
    const addr = checkAddress(mintTo, 'any');
    if (!addr.ok) return addr.error ?? 'Bad address';
    try {
      const v = parseTokenAmount(mintAmount || '0', 18);
      if (v <= 0n) return 'The amount must be more than zero.';
    } catch {
      return `"${mintAmount}" is not a valid amount.`;
    }
    if (!mintMemo.trim()) return 'Give the proposal a title, so voters know what the mint is for.';
    return null;
  }, [mintTo, mintAmount, mintMemo]);

  const proposeMint = () => {
    if (!record?.token || mintProblem) return;
    const amount = parseTokenAmount(mintAmount, 18);
    const data = TOKEN.encodeFunctionData('mint', [mintTo.trim(), amount]);
    void tx.run(`Propose a mint in "${record.name}"`, [
      {
        label: `Create the proposal “${mintMemo.trim()}” with one action: mint ${formatTokenAmount(amount)} to ${shortAddress(mintTo.trim())}`,
        build: () => ({
          to: record.module,
          data: encodeCreateVotingProposal(mintMemo.trim(), [{ to: record.token!, value: 0n, data }]),
          value: 0n,
        }),
      },
    ]).then((ok) => {
      if (ok) navigate({ name: 'guild', guild: record.name });
    });
  };

  if (directory.mode !== 'loading' && (!record || record.mode !== 'token')) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20 text-center">
        <h1 className="font-display text-3xl text-bone">{record ? `“${guildName}” is a council hall` : `No hall called “${guildName}”`}</h1>
        <p className="mt-3 text-sm text-bone-dim">{record ? 'Councils have no token to delegate or mint.' : ''}</p>
        <Button className="mt-6" variant="secondary" onClick={() => navigate({ name: 'home' })}>
          Back to the halls
        </Button>
      </div>
    );
  }

  const needsDelegation = power !== null && power.balance > 0n && power.votes === 0n && sameAddress(power.delegatee, ZERO_ADDRESS);

  return (
    <div className="mx-auto max-w-4xl px-4 py-10 lg:px-8">
      {record && (
        <>
          <a href={`#/guild/${encodeURIComponent(record.name)}`} className="text-xs text-bone-mute hover:text-gold">
            ← {record.name}
          </a>
          <h1 className="mt-1 flex items-center gap-3 font-display text-3xl text-bone">
            <Gem className="h-6 w-6 text-gold" aria-hidden /> Voting power
          </h1>

          {showcase && (
            <Notice tone="gold" className="mt-4" title="Showcase">
              Sample numbers; nothing can be signed until the protocol is deployed.
            </Notice>
          )}
          {error && (
            <Notice tone="danger" className="mt-4">
              {error}
            </Notice>
          )}

          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <Card>
              <Stat label="Token" value={meta ? `${meta.name} (${meta.symbol})` : '…'} />
            </Card>
            <Card>
              <Stat label="Total supply" value={meta ? formatTokenAmount(meta.totalSupply) : '…'} />
            </Card>
            <Card>
              <Stat
                label="Your votes"
                value={power ? formatTokenAmount(power.votes) : '—'}
                hint={power ? `balance ${formatTokenAmount(power.balance)} · delegatee ${shortAddress(power.delegatee)}` : 'connect a wallet'}
              />
            </Card>
          </div>

          {!showcase && power && needsDelegation && (
            <Card className="mt-4 border-gold/30">
              <h2 className="font-display text-lg text-bone">Your balance is silent until you delegate</h2>
              <p className="mt-2 text-sm leading-relaxed text-bone-dim">
                Checkpointed voting power counts only once delegated. Most holders delegate to themselves: one signature, no transfer, revocable any time.
              </p>
              <Button className="mt-4" onClick={delegateSelf}>
                Delegate to myself
              </Button>
            </Card>
          )}

          {!showcase && (
            <Card className="mt-6">
              <h2 className="font-display text-lg text-bone">Propose a mint</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-bone-dim">
                New voting power is created only by a passed proposal — the guild owns the token. This drafts a proposal whose single action mints to an address
                you name.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <TextField label="Mint to" value={mintTo} onChange={(e) => setMintTo(e.target.value)} placeholder="0x00…" inputClassName="font-mono text-xs" />
                <TextField label="Amount" value={mintAmount} onChange={(e) => setMintAmount(e.target.value)} placeholder="50000" inputMode="decimal" />
              </div>
              <TextArea
                className="mt-4"
                label="Proposal title"
                value={mintMemo}
                onChange={(e) => setMintMemo(e.target.value)}
                placeholder="Fund the beacon crew's second cohort"
              />
              {mintProblem && <p className="mt-2 text-xs text-rose-300">{mintProblem}</p>}
              <div className="mt-4 flex justify-end">
                <Button disabled={!!mintProblem || !address} onClick={proposeMint}>
                  {address ? 'Create the proposal' : 'Connect your wallet first'}
                </Button>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
};
