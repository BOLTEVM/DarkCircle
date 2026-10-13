import React, { useEffect, useState } from 'react';
import { Gavel, KeyRound, PauseCircle, PlayCircle, Upload, UserPlus } from 'lucide-react';
import {
  ZERO_ADDRESS,
  calls,
  checkAddress,
  formatArea,
  formatBps,
  formatQuai,
  parseQuai,
  readIntakeFile,
  sameAddress,
  type DeedView,
  type IntakeResult,
} from '@darkquestate/core';
import { Badge, Button, Card, LienDisclosure, Modal, Notice, ParcelPlan, SelectField, TextArea, TextField } from '@darkquestate/ui';
import { useMarket } from '../state/MarketContext.js';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { useTx } from '../state/TxContext.js';
import { AddressTag } from '../components/Money.js';

export const RegistrarPage: React.FC = () => {
  const market = useMarket();
  const { address } = useWallet();
  const status = market.status;
  const isRegistrar = market.mode === 'chain' && sameAddress(address, status?.registrar);
  const isOperator = market.mode === 'chain' && sameAddress(address, status?.operator);

  return (
    <div className="mx-auto max-w-5xl space-y-8 px-4 py-10 lg:px-8">
      <div>
        <h1 className="font-display text-4xl text-bone">Registrar console</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-bone-dim">
          The registrar mints deeds for verified titles and records liens, credits and foreclosures. The operator registers brokers and can pause new business. Both
          act only through their own wallets; neither can reach deposits, proceeds or listed deeds.
        </p>
      </div>

      {status && (
        <Card className="grid gap-4 text-sm sm:grid-cols-2">
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-[0.14em] text-bone-mute">Registrar</div>
            <AddressTag address={status.registrar} label={isRegistrar ? 'You' : undefined} />
          </div>
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-[0.14em] text-bone-mute">Operator</div>
            <AddressTag address={status.operator} label={isOperator ? 'You' : undefined} />
          </div>
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-[0.14em] text-bone-mute">Offer deposits held</div>
            <div className="text-bone">{formatQuai(status.totalOfferEscrow)} QUAI</div>
          </div>
          <div className="space-y-1">
            <div className="text-[11px] uppercase tracking-[0.14em] text-bone-mute">Proceeds owed to sellers and brokers</div>
            <div className="text-bone">{formatQuai(status.totalProceedsOwed)} QUAI</div>
          </div>
        </Card>
      )}

      {market.mode === 'showcase' && (
        <Notice tone="gold" title="No contracts on this network yet">
          The console needs the deployed registry and brokerage. You can still check an intake file below: nothing is sent.
        </Notice>
      )}
      {market.mode === 'chain' && !isRegistrar && !isOperator && (
        <Notice tone="info" icon={<KeyRound className="h-4 w-4" />}>
          Connect the registrar's or operator's wallet to use these tools. Everyone else sees them read-only.
        </Notice>
      )}

      <MintDeed enabled={isRegistrar} />
      {market.mode === 'chain' && <ServiceDeeds enabled={isRegistrar} />}
      {market.mode === 'chain' && <Brokers enabled={isOperator} />}
    </div>
  );
};

/* ------------------------------------------------------------------ mint */

const MintDeed: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const { network, deployment } = useNetwork();
  const { onExpectedChain } = useWallet();
  const { run } = useTx();
  const [text, setText] = useState('');
  const [result, setResult] = useState<IntakeResult | null>(null);

  const load = (t: string) => {
    setText(t);
    setResult(t.trim() ? readIntakeFile(t, network) : null);
  };
  const pkg = result?.ok ? result.pkg! : null;

  return (
    <Card className="space-y-4">
      <h2 className="flex items-center gap-2 font-display text-xl text-bone">
        <Upload className="h-4 w-4 text-gold" aria-hidden /> Mint a deed from an intake file
      </h2>
      <div className="flex flex-wrap items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line bg-panel-raised px-4 py-2 text-sm text-bone hover:border-line-strong">
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) load(await file.text());
            }}
          />
          Choose file…
        </label>
        <span className="text-xs text-bone-mute">or paste it below</span>
      </div>
      <TextArea label="Intake file" value={text} onChange={(e) => load(e.target.value)} inputClassName="font-mono text-xs" rows={4} />
      {result && !result.ok && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-rose-300">
          {result.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {pkg && (
        <div className="grid gap-4 md:grid-cols-2">
          <ParcelPlan geoJson={pkg.mintArgs.geoJson} label={pkg.mintArgs.parcelId} className="rounded-lg border border-line" />
          <dl className="space-y-2 text-xs">
            {(
              [
                ['Parcel id', pkg.mintArgs.parcelId],
                ['Address', pkg.mintArgs.physicalAddress],
                ['Legal owner', pkg.mintArgs.legalOwner],
                ['Lot area', formatArea(pkg.areaSqm)],
                ['Deed goes to', pkg.mintArgs.recipient],
                ['Agreement hash', pkg.mintArgs.operatingAgreementHash],
                ['Metadata', pkg.mintArgs.metadataUri],
              ] as [string, string][]
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-bone-mute">{k}</dt>
                <dd className="break-all font-mono text-bone">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {pkg && (
        <Notice tone="warn">
          Minting is permanent: the parcel id can never be registered again and the record cannot be edited. Mint only after verifying the recorded deed, the owner's
          identity and that the operating agreement matches this hash.
        </Notice>
      )}
      <div className="flex justify-end">
        <Button
          disabled={!enabled || !pkg || !onExpectedChain}
          onClick={async () => {
            if (!pkg) return;
            if (await run('Mint deed', [{ label: `Mint deed for ${pkg.mintArgs.parcelId}`, build: () => calls.mintDeed(deployment!, pkg.mintArgs) }])) load('');
          }}
        >
          Mint deed
        </Button>
      </div>
    </Card>
  );
};

/* ------------------------------------------------------------------ servicing */

const ServiceDeeds: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const market = useMarket();
  const { deployment } = useNetwork();
  const { onExpectedChain } = useWallet();
  const { run } = useTx();
  const [deeds, setDeeds] = useState<DeedView[] | null>(null);
  const [selected, setSelected] = useState('');
  const [kind, setKind] = useState<'lien' | 'credit' | 'clear'>('lien');
  const [amountText, setAmountText] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [foreclosing, setForeclosing] = useState(false);

  useEffect(() => {
    let alive = true;
    market.reader?.allDeeds().then(
      (d) => alive && setDeeds(d),
      () => alive && setDeeds([])
    );
    return () => {
      alive = false;
    };
  }, [market.reader, market.updatedAt]);

  const deed = deeds?.find((d) => d.id.toString() === selected) ?? null;
  const amount = parseQuai(amountText);
  const signed = kind === 'clear' ? 0n : kind === 'lien' ? (amount ?? 0n) : -(amount ?? 0n);
  const canRecord = enabled && deed && !deed.debt.foreclosed && onExpectedChain && (kind === 'clear' || (amount !== null && amount > 0n));

  return (
    <Card className="space-y-4">
      <h2 className="flex items-center gap-2 font-display text-xl text-bone">
        <Gavel className="h-4 w-4 text-gold" aria-hidden /> Service a deed
      </h2>
      <SelectField
        label="Deed"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        options={[
          { value: '', label: deeds === null ? 'Loading…' : deeds.length ? 'Choose a deed…' : 'No deeds minted yet' },
          ...(deeds ?? []).map((d) => ({ value: d.id.toString(), label: `#${d.id} · ${d.record.parcelId} · ${d.record.physicalAddress}` })),
        ]}
      />
      {deed && (
        <>
          <LienDisclosure debt={deed.debt} />
          <div className="grid gap-4 sm:grid-cols-[180px_1fr_auto] sm:items-end">
            <SelectField
              label="Record"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
              options={[
                { value: 'lien', label: 'A lien (owed)' },
                { value: 'credit', label: 'A credit (held)' },
                { value: 'clear', label: 'Clear (nothing)' },
              ]}
            />
            <TextField label="Amount" suffix="QUAI" inputMode="decimal" value={kind === 'clear' ? '' : amountText} disabled={kind === 'clear'} onChange={(e) => setAmountText(e.target.value)} />
            <Button
              disabled={!canRecord}
              onClick={() =>
                run('Record debt', [
                  {
                    label: kind === 'clear' ? 'Clear the debt record' : `Record a ${kind} of ${formatQuai(amount ?? 0n)} QUAI`,
                    build: () => calls.setDebt(deployment!, deed.id, ZERO_ADDRESS, signed),
                  },
                ])
              }
            >
              Record
            </Button>
          </div>
          <p className="text-xs text-bone-mute">Open offers carry the lien their buyer accepted; recording a larger lien makes those offers impossible to accept.</p>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-rose-400/25 bg-rose-400/[0.05] px-4 py-3">
            <p className="text-xs leading-relaxed text-rose-100">Foreclosure is permanent: the deed stops representing the property and can never close through the desk.</p>
            <Button variant="danger" size="sm" disabled={!enabled || deed.debt.foreclosed || !onExpectedChain} onClick={() => setForeclosing(true)}>
              Foreclose
            </Button>
          </div>
          <Modal open={foreclosing} onClose={() => setForeclosing(false)} title={`Foreclose ${deed.record.parcelId}?`} width="sm">
            <div className="space-y-4">
              <p className="text-sm text-bone-dim">Type the parcel id to confirm. This cannot be undone.</p>
              <TextField label="Parcel id" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setForeclosing(false)}>
                  Keep
                </Button>
                <Button
                  variant="danger"
                  disabled={confirmText !== deed.record.parcelId}
                  onClick={() => {
                    setForeclosing(false);
                    setConfirmText('');
                    run('Foreclose deed', [{ label: `Foreclose deed #${deed.id.toString()}`, build: () => calls.foreclose(deployment!, deed.id) }]);
                  }}
                >
                  Foreclose
                </Button>
              </div>
            </div>
          </Modal>
        </>
      )}
    </Card>
  );
};

/* ------------------------------------------------------------------ brokers */

const Brokers: React.FC<{ enabled: boolean }> = ({ enabled }) => {
  const market = useMarket();
  const { network, deployment } = useNetwork();
  const { onExpectedChain } = useWallet();
  const { run } = useTx();
  const [f, setF] = useState({ address: '', name: '', licence: '', commission: '3' });
  const addr = checkAddress(f.address, network.addressRule);
  const pct = Number(f.commission);
  const bps = Math.round(pct * 100);
  const valid = addr.ok && f.name.trim() && f.licence.trim() && Number.isFinite(pct) && bps >= 0 && bps <= 1000;
  const paused = market.status?.paused ?? false;

  return (
    <Card className="space-y-5">
      <h2 className="flex items-center gap-2 font-display text-xl text-bone">
        <UserPlus className="h-4 w-4 text-gold" aria-hidden /> Brokers and desk
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Broker wallet (Cyprus-1)"
          value={f.address}
          onChange={(e) => setF({ ...f, address: e.target.value })}
          error={f.address && !addr.ok ? addr.error : null}
          className="sm:col-span-2"
        />
        <TextField label="Firm name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <TextField label="Licence id" value={f.licence} onChange={(e) => setF({ ...f, licence: e.target.value })} />
        <TextField label="Commission" suffix="%" inputMode="decimal" value={f.commission} onChange={(e) => setF({ ...f, commission: e.target.value })} help="At most 10%." />
      </div>
      <div className="flex justify-end">
        <Button
          disabled={!enabled || !valid || !onExpectedChain}
          onClick={() =>
            run('Register broker', [
              { label: `Register ${f.name.trim()} at ${formatBps(bps)}`, build: () => calls.registerBroker(deployment!, addr.address!, f.name.trim(), f.licence.trim(), bps) },
            ])
          }
        >
          Register or update broker
        </Button>
      </div>
      {market.brokers.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {market.brokers.map((b) => (
            <li key={b.address} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div>
                <div className="text-bone">{b.name}</div>
                <AddressTag address={b.address} />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-bone-dim">{formatBps(b.commissionBps)}</span>
                {b.active ? <Badge tone="emerald">Active</Badge> : <Badge tone="slate">Inactive</Badge>}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!enabled || !onExpectedChain}
                  onClick={() =>
                    run(b.active ? 'Deactivate broker' : 'Reactivate broker', [
                      { label: `${b.active ? 'Stop' : 'Resume'} new listings through ${b.name}`, build: () => calls.setBrokerActive(deployment!, b.address, !b.active) },
                    ])
                  }
                >
                  {b.active ? 'Deactivate' : 'Reactivate'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-ink-deep px-4 py-3">
        <p className="text-xs leading-relaxed text-bone-mute">
          Pausing stops new listings, offers and closings. Cancelling listings and withdrawing offers or proceeds keep working.
        </p>
        <Button
          size="sm"
          variant={paused ? 'primary' : 'secondary'}
          disabled={!enabled || !onExpectedChain}
          onClick={() => run(paused ? 'Resume the desk' : 'Pause the desk', [{ label: paused ? 'Resume new business' : 'Pause new business', build: () => calls.setPaused(deployment!, !paused) }])}
        >
          {paused ? <PlayCircle className="h-4 w-4" /> : <PauseCircle className="h-4 w-4" />} {paused ? 'Resume' : 'Pause'}
        </Button>
      </div>
    </Card>
  );
};
