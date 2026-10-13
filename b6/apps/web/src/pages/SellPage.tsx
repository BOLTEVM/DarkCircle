import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileCheck2, Landmark } from 'lucide-react';
import {
  PROPERTY_TYPES,
  buildListingDetails,
  calls,
  formatArea,
  formatBps,
  formatQuai,
  intakeFileJson,
  packageDeedIntake,
  parseQuai,
  propertyTypeLabel,
  settlementFor,
  type DeedView,
} from '@darkquestate/core';
import { Button, Card, LienDisclosure, Notice, ParcelPlan, SelectField, TextArea, TextField, cx } from '@darkquestate/ui';
import { useMarket } from '../state/MarketContext.js';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { useTx } from '../state/TxContext.js';
import { href, navigate } from '../lib/router.js';

type Tab = 'list' | 'intake';

export const SellPage: React.FC = () => {
  const [tab, setTab] = useState<Tab>('list');
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 lg:px-8">
      <h1 className="font-display text-4xl text-bone">Sell with Dark Questate</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-bone-dim">
        A property is sold through the desk once it has a deed: the registrar mints one after verifying your title. If you already hold a deed, list it here.
      </p>
      <div className="mt-8 inline-flex rounded-lg border border-line bg-panel p-1" role="tablist">
        {(
          [
            ['list', Landmark, 'List a deed you hold'],
            ['intake', FileCheck2, 'Request a deed'],
          ] as const
        ).map(([t, Icon, label]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cx('inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm', tab === t ? 'bg-panel-raised text-gold' : 'text-bone-dim hover:text-bone')}
          >
            <Icon className="h-4 w-4" aria-hidden /> {label}
          </button>
        ))}
      </div>
      <div className="mt-8">{tab === 'list' ? <ListDeed /> : <DeedIntake />}</div>
    </div>
  );
};

/* ------------------------------------------------------------------ list a held deed */

const ListDeed: React.FC = () => {
  const market = useMarket();
  const { deployment } = useNetwork();
  const { address, connect, wallet, onExpectedChain } = useWallet();
  const { run } = useTx();
  const [deeds, setDeeds] = useState<DeedView[] | null>(null);
  const [deedId, setDeedId] = useState<string>('');
  const [priceText, setPriceText] = useState('');
  const [broker, setBroker] = useState('');
  const [form, setForm] = useState({ title: '', type: 'residential', city: '', region: '', country: '', summary: '', beds: '', baths: '', interiorSqm: '', yearBuilt: '' });

  useEffect(() => {
    let alive = true;
    setDeeds(null);
    if (!market.reader || !address) return;
    market.reader.deedsHeldBy(address).then(
      (d) => alive && setDeeds(d),
      () => alive && setDeeds([])
    );
    return () => {
      alive = false;
    };
  }, [market.reader, address, market.updatedAt]);

  const activeBrokers = market.brokers.filter((b) => b.active);
  const deed = deeds?.find((d) => d.id.toString() === deedId) ?? null;
  const price = parseQuai(priceText);
  const details = useMemo(() => buildListingDetails(form), [form]);
  const chosenBroker = activeBrokers.find((b) => b.address === broker) ?? null;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  if (market.mode === 'showcase') {
    return (
      <Notice tone="gold" title="Listing opens when the contracts are deployed">
        On this network the site is a showcase. You can still prepare a deed request in the other tab: it produces the file the registrar needs, and nothing is sent anywhere.
      </Notice>
    );
  }
  if (!address) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <p className="text-sm text-bone-dim">Connect the wallet that holds your deed.</p>
        <Button onClick={connect}>{wallet ? `Connect ${wallet.name}` : 'Connect a Quai wallet'}</Button>
      </Card>
    );
  }

  const ready = deed && !deed.debt.foreclosed && price && price > 0n && chosenBroker && details.ok && onExpectedChain && !market.status?.paused;
  const submit = async () => {
    if (!ready || !deed || !price || !chosenBroker || !details.json) return;
    const approved = await market.reader!.isDeskApproved(address, deed.id);
    const steps = [
      ...(approved ? [] : [{ label: `Allow the desk to hold deed #${deed.id.toString()} while it is listed`, build: () => calls.approveDeed(deployment!, deed.id) }]),
      {
        label: `List at ${formatQuai(price)} QUAI through ${chosenBroker.name}`,
        build: () => calls.createListing(deployment!, deed.id, price, chosenBroker.address, details.json!),
      },
    ];
    if (await run('List your property', steps)) navigate({ name: 'portfolio' });
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <Card className="space-y-4">
          <h2 className="font-display text-xl text-bone">1. The deed</h2>
          {deeds === null ? (
            <p className="text-sm text-bone-mute">Reading deeds in your wallet…</p>
          ) : deeds.length === 0 ? (
            <p className="text-sm text-bone-mute">
              This wallet holds no Dark Questate deeds. Listed deeds are held by the desk; see your <a href={href({ name: 'portfolio' })} className="text-gold">portfolio</a>. To get a
              deed, use “Request a deed”.
            </p>
          ) : (
            <SelectField
              label="Deed to list"
              value={deedId}
              onChange={(e) => setDeedId(e.target.value)}
              options={[{ value: '', label: 'Choose a deed…' }, ...deeds.map((d) => ({ value: d.id.toString(), label: `#${d.id} · ${d.record.parcelId} · ${d.record.physicalAddress}` }))]}
            />
          )}
          {deed && (
            <div className="grid gap-4 sm:grid-cols-2">
              <ParcelPlan geoJson={deed.record.geoJson} label={deed.record.parcelId} className="rounded-lg border border-line" />
              <LienDisclosure debt={deed.debt} />
            </div>
          )}
        </Card>

        <Card className="space-y-4">
          <h2 className="font-display text-xl text-bone">2. Price and broker</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Asking price"
              suffix="QUAI"
              inputMode="decimal"
              value={priceText}
              onChange={(e) => setPriceText(e.target.value)}
              error={priceText && !price ? 'Enter a plain amount, like 1,250,000.' : null}
            />
            <SelectField
              label="Listing broker"
              value={broker}
              onChange={(e) => setBroker(e.target.value)}
              options={[{ value: '', label: activeBrokers.length ? 'Choose a broker…' : 'No broker is taking listings' }, ...activeBrokers.map((b) => ({ value: b.address, label: `${b.name} · ${formatBps(b.commissionBps)}` }))]}
              help="The commission is fixed at listing time and paid only if the property sells."
            />
          </div>
        </Card>

        <Card className="space-y-4">
          <h2 className="font-display text-xl text-bone">3. Listing details</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Title" value={form.title} onChange={set('title')} placeholder="Cliff-top residence with harbour views" className="sm:col-span-2" />
            <SelectField label="Type" value={form.type} onChange={set('type')} options={PROPERTY_TYPES.map((t) => ({ value: t, label: propertyTypeLabel(t) }))} />
            <TextField label="City" value={form.city} onChange={set('city')} />
            <TextField label="Region" value={form.region} onChange={set('region')} />
            <TextField label="Country" value={form.country} onChange={set('country')} />
            <TextField label="Bedrooms" inputMode="numeric" value={form.beds} onChange={set('beds')} />
            <TextField label="Bathrooms" inputMode="numeric" value={form.baths} onChange={set('baths')} />
            <TextField label="Interior area" suffix="m²" inputMode="numeric" value={form.interiorSqm} onChange={set('interiorSqm')} />
            <TextField label="Year built" inputMode="numeric" value={form.yearBuilt} onChange={set('yearBuilt')} />
            <TextArea label="Summary" value={form.summary} onChange={set('summary')} className="sm:col-span-2" help={`${details.bytes ?? 0} of 1,024 bytes stored on chain.`} />
          </div>
          {!details.ok && (form.title || form.city) && (
            <ul className="list-disc space-y-1 pl-5 text-xs text-rose-300">
              {details.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        <Card className="space-y-4">
          <div className="text-[11px] uppercase tracking-[0.16em] text-bone-mute">If it sells at this price</div>
          {price && chosenBroker ? (
            (() => {
              const s = settlementFor(price, chosenBroker.commissionBps);
              return (
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-bone-mute">Price</dt>
                    <dd className="tabular-nums text-bone">{formatQuai(s.price)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-bone-mute">Commission</dt>
                    <dd className="tabular-nums text-bone-dim">−{formatQuai(s.commission)}</dd>
                  </div>
                  <div className="flex justify-between border-t border-line pt-2">
                    <dt className="text-bone">You receive</dt>
                    <dd className="font-display tabular-nums text-gold-pale">{formatQuai(s.sellerNet)} QUAI</dd>
                  </div>
                </dl>
              );
            })()
          ) : (
            <p className="text-sm text-bone-mute">Choose a price and a broker.</p>
          )}
          <Button className="w-full" disabled={!ready} onClick={submit}>
            Approve and list
          </Button>
          <p className="text-xs leading-relaxed text-bone-mute">
            The desk holds the deed until it sells or you cancel; cancelling returns it to you. Up to two wallet confirmations: one to allow the desk to hold this deed,
            one to list.
          </p>
        </Card>
      </aside>
    </div>
  );
};

/* ------------------------------------------------------------------ deed intake */

const SAMPLE_BOUNDARY = JSON.stringify(
  {
    type: 'Polygon',
    coordinates: [
      [
        [-9.42155, 38.69174],
        [-9.42102, 38.69174],
        [-9.42102, 38.69139],
        [-9.42155, 38.69139],
        [-9.42155, 38.69174],
      ],
    ],
  },
  null,
  2
);

const DeedIntake: React.FC = () => {
  const { network } = useNetwork();
  const { address } = useWallet();
  const [f, setF] = useState({
    recipient: '',
    parcelId: '',
    physicalAddress: '',
    legalOwner: '',
    legalDescription: '',
    geoJson: SAMPLE_BOUNDARY,
    operatingAgreementText: '',
  });
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    if (address) setF((cur) => (cur.recipient ? cur : { ...cur, recipient: address }));
  }, [address]);

  const result = useMemo(() => packageDeedIntake(f, network), [f, network]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((cur) => ({ ...cur, [k]: e.target.value }));

  const download = () => {
    if (!result.pkg) return;
    const blob = new Blob([intakeFileJson(result.pkg)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `darkquestate-intake-${result.pkg.mintArgs.parcelId}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
      <div className="space-y-6">
        <Notice tone="info" title="Nothing here is sent anywhere">
          The form checks your title details and builds the file the registrar signs from: the exact mint arguments, the deed's metadata document and its IPFS
          content id, and the hash of your operating agreement. The agreement text itself never leaves this page.
        </Notice>
        <Card className="space-y-4">
          <h2 className="font-display text-xl text-bone">Title</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Parcel id (APN / cadastral id)" value={f.parcelId} onChange={set('parcelId')} placeholder="PV-0042-17" />
            <TextField label="Street address" value={f.physicalAddress} onChange={set('physicalAddress')} />
            <TextField label="Legal owner on the deed" value={f.legalOwner} onChange={set('legalOwner')} placeholder="Harbour Street Holdings LLC" className="sm:col-span-2" />
            <TextArea label="Legal description (as recorded)" value={f.legalDescription} onChange={set('legalDescription')} className="sm:col-span-2" />
            <TextField
              label="Deed goes to (your Cyprus-1 wallet)"
              value={f.recipient}
              onChange={set('recipient')}
              placeholder="0x00…"
              className="sm:col-span-2"
              inputClassName="font-mono"
              help="Double-check it: a deed minted to another zone or a Qi address can never be moved."
            />
          </div>
        </Card>
        <Card className="space-y-4">
          <h2 className="font-display text-xl text-bone">Boundary and agreement</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <TextArea label="Boundary (GeoJSON Polygon, WGS84 longitude/latitude)" value={f.geoJson} onChange={set('geoJson')} inputClassName="font-mono text-xs" rows={12} />
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-bone-dim">Preview</div>
              <ParcelPlan geoJson={f.geoJson} label={f.parcelId || undefined} className="rounded-lg border border-line" />
            </div>
          </div>
          <TextArea
            label="Operating agreement of the owning entity"
            value={f.operatingAgreementText}
            onChange={set('operatingAgreementText')}
            help="Only its keccak256 hash goes on chain, binding the deed to this exact text."
          />
        </Card>
      </div>
      <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        <Card className="space-y-4">
          <div className="text-[11px] uppercase tracking-[0.16em] text-bone-mute">Intake package</div>
          {result.ok && result.pkg ? (
            <dl className="space-y-3 text-xs">
              <div>
                <dt className="text-bone-mute">Parcel id on chain</dt>
                <dd className="font-mono text-bone">{result.pkg.mintArgs.parcelId}</dd>
              </div>
              <div>
                <dt className="text-bone-mute">Lot area</dt>
                <dd className="text-bone">{formatArea(result.pkg.areaSqm)}</dd>
              </div>
              <div>
                <dt className="text-bone-mute">Agreement hash</dt>
                <dd className="break-all font-mono text-bone-dim">{result.pkg.agreementHash}</dd>
              </div>
              <div>
                <dt className="text-bone-mute">Metadata content id (CIDv0)</dt>
                <dd className="break-all font-mono text-bone-dim">{result.pkg.metadataCid}</dd>
              </div>
            </dl>
          ) : (
            submitted && (
              <ul className="list-disc space-y-1 pl-4 text-xs text-rose-300">
                {result.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )
          )}
          <Button
            className="w-full"
            onClick={() => {
              setSubmitted(true);
              download();
            }}
            disabled={submitted && !result.ok}
          >
            <Download className="h-4 w-4" aria-hidden /> {result.ok ? 'Download intake file' : 'Check and download'}
          </Button>
          <p className="text-xs leading-relaxed text-bone-mute">
            Send the file to the registrar with your recorded deed and identity documents. After verifying them, the registrar loads the file in the Registrar console
            and mints. The metadata document should also be published (IPFS or Arweave) so the content id resolves.
          </p>
        </Card>
      </aside>
    </div>
  );
};
