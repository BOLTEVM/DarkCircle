import React, { useMemo, useState } from 'react';
import { Crown, Flame } from 'lucide-react';
import { checkAddress, encodeFoundGuild, parseTokenAmount, type GuildMode } from '@darkorder/core';
import { navigate } from '../lib/router.js';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { useTx } from '../state/TxContext.js';
import { Button, Card, Notice, TextArea, TextField, cx } from '../components/primitives.js';

const HANDLE = /^[a-z0-9_-]{1,64}$/;

interface Draft {
  name: string;
  metadata: string;
  mode: GuildMode;
  tokenName: string;
  tokenSymbol: string;
  initialSupply: string;
  supportPercent: string;
  participationPercent: string;
  minDurationHours: string;
  members: string;
  minApprovals: string;
}

const EMPTY: Draft = {
  name: '',
  metadata: '',
  mode: 'token',
  tokenName: '',
  tokenSymbol: '',
  initialSupply: '1000000',
  supportPercent: '50',
  participationPercent: '20',
  minDurationHours: '24',
  members: '',
  minApprovals: '2',
};

/** Validates the whole form; returns the encoded params or the first problem. */
function review(draft: Draft): { ok: true; params: Parameters<typeof encodeFoundGuild>[0] } | { ok: false; problem: string } {
  if (!HANDLE.test(draft.name)) return { ok: false, problem: 'The handle must be 1-64 characters of a-z, 0-9, hyphen or underscore.' };
  let initialSupply = 0n;
  if (draft.mode === 'token') {
    if (!draft.tokenName.trim()) return { ok: false, problem: 'The governance token needs a name.' };
    if (!/^[A-Z0-9]{2,11}$/.test(draft.tokenSymbol.trim())) return { ok: false, problem: 'The token symbol must be 2-11 characters of A-Z and 0-9.' };
    try {
      initialSupply = parseTokenAmount(draft.initialSupply || '0', 18);
    } catch {
      return { ok: false, problem: `"${draft.initialSupply}" is not a valid initial supply.` };
    }
    const support = Number(draft.supportPercent);
    const participation = Number(draft.participationPercent);
    if (!(support > 0 && support <= 100)) return { ok: false, problem: 'Support threshold must be between 0 and 100 percent.' };
    if (!(participation >= 0 && participation <= 100)) return { ok: false, problem: 'Minimum participation must be between 0 and 100 percent.' };
    const hours = Number(draft.minDurationHours);
    if (!(hours >= 1 && hours <= 24 * 365)) return { ok: false, problem: 'Minimum duration must be at least one hour.' };
    return {
      ok: true,
      params: {
        name: draft.name,
        metadata: draft.metadata.trim(),
        mode: 'token',
        tokenName: draft.tokenName.trim(),
        tokenSymbol: draft.tokenSymbol.trim(),
        initialSupply,
        supportThreshold: BigInt(Math.round(support * 100)),
        minParticipation: BigInt(Math.round(participation * 100)),
        minDuration: BigInt(Math.round(hours * 3600)),
        members: [],
        minApprovals: 0n,
      },
    };
  }
  const members = draft.members
    .split(/[\s,]+/)
    .map((m) => m.trim())
    .filter(Boolean);
  if (members.length === 0) return { ok: false, problem: 'A council needs at least one member address.' };
  const checked: string[] = [];
  for (const m of members) {
    const c = checkAddress(m, 'any');
    if (!c.ok || !c.address) return { ok: false, problem: `Council member ${m}: ${c.error}` };
    if (checked.some((x) => x.toLowerCase() === c.address!.toLowerCase())) return { ok: false, problem: `Council member ${m} is listed twice.` };
    checked.push(c.address);
  }
  const minApprovals = Number(draft.minApprovals);
  if (!(Number.isInteger(minApprovals) && minApprovals >= 1 && minApprovals <= checked.length)) {
    return { ok: false, problem: `Minimum approvals must be between 1 and ${checked.length}.` };
  }
  return {
    ok: true,
    params: {
      name: draft.name,
      metadata: draft.metadata.trim(),
      mode: 'council',
      tokenName: '',
      tokenSymbol: '',
      initialSupply: 0n,
      supportThreshold: 0n,
      minParticipation: 0n,
      minDuration: 0n,
      members: checked,
      minApprovals: BigInt(minApprovals),
    },
  };
}

export const FoundPage: React.FC = () => {
  const { deployment, network } = useNetwork();
  const { address } = useWallet();
  const tx = useTx();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const result = useMemo(() => review(draft), [draft]);
  const [step, setStep] = useState<'form' | 'review'>('form');

  const found = async () => {
    if (!result.ok || !deployment) return;
    const data = encodeFoundGuild(result.params);
    const ok = await tx.run(`Found "${result.params.name}"`, [
      {
        label: 'The Founding Rite: deploy the guild, wire its module, mint the founder’s power, register the handle',
        build: () => ({ to: deployment.factory, data, value: 0n }),
      },
    ]);
    if (ok) navigate({ name: 'guild', guild: result.params.name });
  };

  if (!deployment) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="font-display text-3xl text-bone">Found a guild</h1>
        <Notice tone="gold" className="mt-6" title="Showcase mode">
          The DarkOrder protocol is not deployed on {network.label}, so no guild can be founded here yet. Switch networks, or walk the sample halls first.
        </Notice>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 lg:px-8">
      <h1 className="font-display text-3xl text-bone">Found a guild</h1>
      <p className="mt-2 text-sm leading-relaxed text-bone-dim">
        One transaction: the guild, its governance module, the founder's voting power, and the registry entry. When it confirms, no key but the guild's own
        governance can act — the factory retains nothing.
      </p>

      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {(['token', 'council'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => set({ mode })}
            aria-pressed={draft.mode === mode}
            className={cx(
              'rounded-xl border p-5 text-left transition-colors',
              draft.mode === mode ? 'border-gold/50 bg-gold/[0.08]' : 'border-line bg-panel hover:border-line-strong'
            )}
          >
            <span className={cx('flex h-9 w-9 items-center justify-center rounded-lg border', draft.mode === mode ? 'border-gold/40 bg-gold/10 text-gold' : 'border-line text-bone-mute')}>
              {mode === 'token' ? <Flame className="h-4 w-4" aria-hidden /> : <Crown className="h-4 w-4" aria-hidden />}
            </span>
            <span className="mt-3 block font-display text-lg text-bone">{mode === 'token' ? 'Token hall' : 'Council hall'}</span>
            <span className="mt-1 block text-xs leading-relaxed text-bone-mute">
              {mode === 'token'
                ? 'Voting power is a checkpointed ERC-20. Proposals pass on support and turnout thresholds.'
                : 'A fixed set of members; N of M approvals execute a proposal. No token, no delegation.'}
            </span>
          </button>
        ))}
      </div>

      <Card className="mt-6 space-y-5">
        <TextField
          label="Hall handle"
          help="1-64 chars: a-z, 0-9, hyphen, underscore. This is the directory key; identity names live on quaidomains.com."
          value={draft.name}
          onChange={(e) => set({ name: e.target.value.toLowerCase() })}
          placeholder="obsidiantrust"
        />
        <TextArea
          label="Charter (metadata)"
          help="Text, or a pointer to a longer document. Written on chain; changeable later only by a passed proposal."
          value={draft.metadata}
          onChange={(e) => set({ metadata: e.target.value })}
          placeholder="Stewards of the skyline…"
        />
        {draft.mode === 'token' ? (
          <>
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField label="Token name" value={draft.tokenName} onChange={(e) => set({ tokenName: e.target.value })} placeholder="Emberhold Mark" />
              <TextField label="Token symbol" value={draft.tokenSymbol} onChange={(e) => set({ tokenSymbol: e.target.value.toUpperCase() })} placeholder="EMBER" />
            </div>
            <TextField
              label="Initial supply (minted to you)"
              help="Voting power counts only after you delegate to yourself; the next screen reminds you."
              value={draft.initialSupply}
              onChange={(e) => set({ initialSupply: e.target.value })}
              inputMode="decimal"
              suffix="tokens"
            />
            <div className="grid gap-5 sm:grid-cols-3">
              <TextField label="Support threshold" value={draft.supportPercent} onChange={(e) => set({ supportPercent: e.target.value })} inputMode="decimal" suffix="%" />
              <TextField label="Min participation" value={draft.participationPercent} onChange={(e) => set({ participationPercent: e.target.value })} inputMode="decimal" suffix="%" />
              <TextField label="Min duration" value={draft.minDurationHours} onChange={(e) => set({ minDurationHours: e.target.value })} inputMode="numeric" suffix="hours" />
            </div>
          </>
        ) : (
          <>
            <TextArea
              label="Council members (one address per line)"
              help="Cyprus-1 Quai account addresses. The council is fixed at founding; changing it takes a proposal."
              value={draft.members}
              onChange={(e) => set({ members: e.target.value })}
              placeholder={'0x00…\n0x00…\n0x00…'}
              inputClassName="font-mono text-xs"
            />
            <TextField label="Minimum approvals" value={draft.minApprovals} onChange={(e) => set({ minApprovals: e.target.value })} inputMode="numeric" />
          </>
        )}
      </Card>

      {step === 'review' && result.ok && (
        <Card className="mt-6 border-gold/30">
          <h2 className="font-display text-lg text-bone">Review the rite</h2>
          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-bone-mute">Handle</dt>
              <dd className="font-mono text-bone">{result.params.name}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-bone-mute">Mode</dt>
              <dd className="text-bone">{result.params.mode === 'token' ? 'Token hall' : 'Council hall'}</dd>
            </div>
            {result.params.mode === 'token' ? (
              <>
                <div className="flex justify-between gap-4">
                  <dt className="text-bone-mute">Token</dt>
                  <dd className="text-bone">
                    {result.params.tokenName} ({result.params.tokenSymbol})
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-bone-mute">Rules</dt>
                  <dd className="text-bone">
                    {Number(result.params.supportThreshold) / 100}% support · {Number(result.params.minParticipation) / 100}% turnout ·{' '}
                    {Number(result.params.minDuration) / 3600}h minimum
                  </dd>
                </div>
              </>
            ) : (
              <div className="flex justify-between gap-4">
                <dt className="text-bone-mute">Council</dt>
                <dd className="text-bone">
                  {result.params.members.length} members, {result.params.minApprovals.toString()} to act
                </dd>
              </div>
            )}
          </dl>
          <Notice tone="warn" className="mt-4">
            Founding costs gas on {network.label} and cannot be undone: the handle is taken forever. Your wallet shows the exact transaction before you sign.
          </Notice>
          <div className="mt-4 flex justify-end gap-3">
            <Button variant="secondary" onClick={() => setStep('form')}>
              Back
            </Button>
            <Button onClick={found} disabled={!address}>
              {address ? 'Sign the Founding Rite' : 'Connect your wallet first'}
            </Button>
          </div>
        </Card>
      )}

      {step === 'form' && (
        <div className="mt-6 flex items-center justify-end gap-4">
          {!result.ok && draft.name && <span className="text-xs text-rose-300">{result.problem}</span>}
          <Button size="lg" disabled={!result.ok} onClick={() => setStep('review')}>
            Review the rite
          </Button>
        </div>
      )}
    </div>
  );
};
