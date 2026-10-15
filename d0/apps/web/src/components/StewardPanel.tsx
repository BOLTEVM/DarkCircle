import React, { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound, ScrollText, ShieldCheck, Upload, X } from 'lucide-react';
import {
  GUILD_ROLES,
  PROFILE_LIMITS,
  avatarFileToDataUri,
  buildGuildProfile,
  encodeCreateCouncilProposal,
  encodeCreateVotingProposal,
  encodeGrant,
  encodeRevoke,
  encodeSetMetadata,
  isAcceptableLinkUrl,
  parseGuildProfile,
  readGuildRoles,
  requireAddress,
  type GuildLink,
  type GuildRecord,
  type GuildRoles,
  type GuildRoleKey,
  type GuildSummary,
} from '@darkorder/core';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { useTx } from '../state/TxContext.js';
import { Badge, Button, Card, Notice, SelectField, TextArea, TextField, cx } from './primitives.js';
import { GuildAvatar } from './GuildAvatar.js';

const ROLE_LABELS: Record<GuildRoleKey, string> = {
  ROOT: 'root power',
  EXECUTE: 'execute power',
  SET_METADATA: 'metadata power',
};

const NO_ROLES: GuildRoles = { root: false, execute: false, setMetadata: false };

/**
 * The steward's desk: where a holder of metadata power rewrites the hall's charter (crests
 * and links included) and where a root holder hands roles to other keys. Every change can
 * also go through a proposal instead — the proposal executes as the guild itself, which
 * holds every permission, so governance always has a path even when no connected key does.
 */
export const StewardPanel: React.FC<{ record: GuildRecord; summary: GuildSummary | null }> = ({ record, summary }) => {
  const { network, rpc } = useNetwork();
  const { address } = useWallet();
  const tx = useTx();
  const fileRef = useRef<HTMLInputElement | null>(null);

  const current = useMemo(() => parseGuildProfile(summary?.metadata ?? ''), [summary?.metadata]);
  const [description, setDescription] = useState(current.description);
  const [avatar, setAvatar] = useState<string | null>(current.avatar);
  const [links, setLinks] = useState<GuildLink[]>(current.links);
  const [roleKey, setRoleKey] = useState<GuildRoleKey>('SET_METADATA');
  const [roleAddr, setRoleAddr] = useState('');
  const [roleAction, setRoleAction] = useState<'grant' | 'revoke'>('grant');
  const [myRoles, setMyRoles] = useState<GuildRoles>(NO_ROLES);
  const [moduleExecute, setModuleExecute] = useState<boolean | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // Re-seed the form when the confirmed metadata changes (initial load or after a tx).
  useEffect(() => {
    setDescription(current.description);
    setAvatar(current.avatar);
    setLinks(current.links);
  }, [current]);

  useEffect(() => {
    let alive = true;
    setMyRoles(NO_ROLES);
    setModuleExecute(null);
    if (!address) return;
    readGuildRoles(rpc, record.guild, address)
      .then((r) => alive && setMyRoles(r))
      .catch(() => undefined);
    readGuildRoles(rpc, record.guild, record.module)
      .then((r) => alive && setModuleExecute(r.execute))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [rpc, record.guild, record.module, address]);

  if (!address) {
    return (
      <Card className="mt-6">
        <h2 className="flex items-center gap-2 font-display text-lg text-bone">
          <ShieldCheck className="h-4 w-4 text-gold" aria-hidden /> The steward's desk
        </h2>
        <p className="mt-2 text-sm text-bone-dim">Connect your wallet to rewrite the charter or assign roles. Every change can go direct (if your key holds the role) or through a proposal.</p>
      </Card>
    );
  }

  const metadata = buildGuildProfile({ description, avatar, links });
  const metadataChanged = metadata !== (summary?.metadata ?? '');
  const proposalPathNote =
    moduleExecute === false
      ? 'The governance module does not hold execute power, so a proposal could not act — only a direct call can.'
      : null;

  const submitMetadata = (direct: boolean) => {
    setFormError(null);
    if (description.trim() === '' && !avatar) return setFormError('A charter needs at least a description or a crest.');
    if (links.some((l) => !isAcceptableLinkUrl(l.url))) return setFormError('Every link must be an https:// or ipfs:// address.');
    void tx.run(direct ? 'Rewrite the charter' : 'Propose the new charter', [
      direct
        ? { label: 'Write the metadata on chain', build: () => ({ to: record.guild, data: encodeSetMetadata(metadata) }) }
        : {
            label: 'Create the proposal',
            build: () => ({
              to: record.module,
              data:
                record.mode === 'token'
                  ? encodeCreateVotingProposal('Rewrite the charter', [{ to: record.guild, value: 0n, data: encodeSetMetadata(metadata) }])
                  : encodeCreateCouncilProposal('Rewrite the charter', [{ to: record.guild, value: 0n, data: encodeSetMetadata(metadata) }]),
            }),
          },
    ]);
  };

  const submitRole = (direct: boolean) => {
    setFormError(null);
    let who: string;
    try {
      who = requireAddress(roleAddr.trim(), network.addressRule, 'The address');
    } catch (e) {
      return setFormError((e as Error).message);
    }
    const data = roleAction === 'grant' ? encodeGrant(GUILD_ROLES[roleKey], who) : encodeRevoke(GUILD_ROLES[roleKey], who);
    const verb = `${roleAction === 'grant' ? 'Grant' : 'Revoke'} ${ROLE_LABELS[roleKey]}`;
    void tx.run(verb, [
      direct
        ? { label: `${verb} on chain`, build: () => ({ to: record.guild, data }) }
        : {
            label: 'Create the proposal',
            build: () => ({
              to: record.module,
              data: record.mode === 'token' ? encodeCreateVotingProposal(verb, [{ to: record.guild, value: 0n, data }]) : encodeCreateCouncilProposal(verb, [{ to: record.guild, value: 0n, data }]),
            }),
          },
    ]);
  };

  const onCrestFile = async (file: File) => {
    setFormError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      setAvatar(avatarFileToDataUri(file.name, file.type, bytes));
    } catch (e) {
      setFormError((e as Error).message);
    }
  };

  return (
    <Card className="mt-6 border-gold/20" id="steward-desk">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-display text-lg text-bone">
          <ShieldCheck className="h-4 w-4 text-gold" aria-hidden /> The steward's desk
        </h2>
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(ROLE_LABELS) as GuildRoleKey[]).map((k) => (
            <Badge key={k} tone={myRoles[k.toLowerCase() as 'root' | 'execute' | 'setMetadata'] ? 'emerald' : 'slate'} title={myRoles[k.toLowerCase() as 'root' | 'execute' | 'setMetadata'] ? `Your key holds ${ROLE_LABELS[k]}` : `Your key does not hold ${ROLE_LABELS[k]}`}>
              {ROLE_LABELS[k]}
            </Badge>
          ))}
        </div>
      </div>

      {formError && (
        <Notice tone="danger" className="mt-4">
          {formError}
        </Notice>
      )}
      {proposalPathNote && (
        <Notice tone="warn" className="mt-4">
          {proposalPathNote}
        </Notice>
      )}

      {/* Charter */}
      <section className="mt-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-bone">
          <ScrollText className="h-4 w-4 text-gold" aria-hidden /> The charter — what the halls show
        </h3>
        <div className="mt-3 flex items-start gap-4">
          <GuildAvatar avatar={avatar} mode={record.mode} size="lg" />
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onCrestFile(f);
                e.target.value = '';
              }}
            />
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
              <Upload className="h-3.5 w-3.5" aria-hidden /> Upload crest
            </Button>
            {avatar && (
              <Button variant="ghost" size="sm" onClick={() => setAvatar(null)}>
                <X className="h-3.5 w-3.5" aria-hidden /> Remove
              </Button>
            )}
            <span className="self-center text-xs text-bone-mute">PNG, JPEG, GIF or WebP, at most {PROFILE_LIMITS.avatarBytes / 1024} KB.</span>
          </div>
        </div>
        <TextArea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={PROFILE_LIMITS.description}
          rows={3}
          placeholder="What this hall is, who it admits, what it guards."
          className="mt-3"
        />
        <div className="mt-3 space-y-2">
          {links.map((l, i) => (
            <div key={i} className="flex gap-2">
              <TextField
                label={`Link ${i + 1} label`}
                value={l.label}
                onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                placeholder="Charter"
                className="w-40 [&>label]:sr-only"
              />
              <TextField
                label={`Link ${i + 1} URL`}
                value={l.url}
                onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))}
                placeholder="https://…"
                className={cx('flex-1 [&>label]:sr-only')}
              />
              <Button variant="ghost" size="sm" onClick={() => setLinks(links.filter((_, j) => j !== i))} aria-label="Remove link">
                <X className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          {links.length < PROFILE_LIMITS.links && (
            <Button variant="ghost" size="sm" onClick={() => setLinks([...links, { label: '', url: '' }])}>
              + Add a link
            </Button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => submitMetadata(true)} disabled={!metadataChanged || !myRoles.setMetadata} title={myRoles.setMetadata ? undefined : 'Your key does not hold metadata power'}>
            Write it directly
          </Button>
          <Button size="sm" variant="secondary" onClick={() => submitMetadata(false)} disabled={!metadataChanged || moduleExecute === false}>
            Put it to a proposal
          </Button>
          <span className="text-xs text-bone-mute">{metadata.length.toLocaleString()} bytes on chain</span>
        </div>
      </section>

      {/* Roles */}
      <section className="mt-6 border-t border-line pt-5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-bone">
          <KeyRound className="h-4 w-4 text-gold" aria-hidden /> Roles — who may act for the hall
        </h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
          <SelectField
            label="Role"
            value={roleKey}
            onChange={(e) => setRoleKey(e.target.value as GuildRoleKey)}
            options={(Object.keys(ROLE_LABELS) as GuildRoleKey[]).map((k) => ({ value: k, label: ROLE_LABELS[k] }))}
            className="[&>label]:sr-only"
          />
          <TextField label="Address" value={roleAddr} onChange={(e) => setRoleAddr(e.target.value)} placeholder="0x00… Cyprus-1 address" className="[&>label]:sr-only" />
          <SelectField
            label="Action"
            value={roleAction}
            onChange={(e) => setRoleAction(e.target.value as 'grant' | 'revoke')}
            options={[
              { value: 'grant', label: 'Grant' },
              { value: 'revoke', label: 'Revoke' },
            ]}
            className="[&>label]:sr-only"
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => submitRole(true)} disabled={!myRoles.root || !roleAddr.trim()} title={myRoles.root ? undefined : 'Your key does not hold root power'}>
            Apply directly
          </Button>
          <Button size="sm" variant="secondary" onClick={() => submitRole(false)} disabled={!roleAddr.trim() || moduleExecute === false}>
            Put it to a proposal
          </Button>
        </div>
        <p className="mt-2 text-xs text-bone-mute">
          Root power grants and revokes every role. Execute power lets a module spend the treasury. Metadata power rewrites the charter. A proposal executes as the
          guild itself, which holds all three.
        </p>
      </section>
    </Card>
  );
};
