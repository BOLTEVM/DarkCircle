import React, { useMemo, useState } from 'react';
import { Interface } from 'ethers';
import { Copy, FileJson, HandCoins, ScrollText } from 'lucide-react';
import {
  ChallengeParser,
  NATIVE_QUAI,
  buildTributeChallenge,
  formatTokenAmount,
  newInvoiceId,
  parseTokenAmount,
  registryTokenLookup,
  shortAddress,
  validateChallenge,
  type ParsedPaymentChallenge,
} from '@darkorder/core';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { useTx } from '../state/TxContext.js';
import { useGuildDirectory } from '../state/directory.js';
import { Button, Card, Notice, SelectField, TextArea, TextField } from '../components/primitives.js';

const ERC20_TRANSFER = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);

/** Accepts a bare RFC 7807 body, a {headers, body} bundle, or a raw header object. */
function parsePasted(text: string, networkName: 'mainnet' | 'orchard' | 'local'): ParsedPaymentChallenge {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('That is not JSON. Paste the 402 response body, or a {"headers": …, "body": …} bundle.');
  }
  const lookup = registryTokenLookup(networkName);
  const obj = json as Record<string, unknown>;
  if (obj && typeof obj === 'object' && (obj.headers || obj.body)) {
    return ChallengeParser.parse(obj.headers as Record<string, string> | undefined, obj.body, { tokenLookup: lookup });
  }
  if (obj && typeof obj === 'object' && ('payment' in obj || 'recipient' in obj || 'invoiceId' in obj)) {
    return ChallengeParser.parse(undefined, obj, { tokenLookup: lookup });
  }
  return ChallengeParser.parse(obj as Record<string, string>, undefined, { tokenLookup: lookup });
}

export const TributePage: React.FC = () => {
  const { network } = useNetwork();
  const { address } = useWallet();
  const tx = useTx();
  const directory = useGuildDirectory();

  // ---- pay side
  const [pasted, setPasted] = useState('');
  const [challenge, setChallenge] = useState<ParsedPaymentChallenge | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [proofHeaders, setProofHeaders] = useState<Record<string, string> | null>(null);

  // ---- invoice side
  const [invoiceGuild, setInvoiceGuild] = useState('');
  const [invoiceAmount, setInvoiceAmount] = useState('5');
  const [invoiceTtl, setInvoiceTtl] = useState('10');
  const [invoiceMemo, setInvoiceMemo] = useState('');
  const [issued, setIssued] = useState<{ headers: Record<string, string>; body: unknown } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const problems = useMemo(() => (challenge ? validateChallenge(challenge, network) : []), [challenge, network]);

  const read = () => {
    setParseError(null);
    setChallenge(null);
    setProofHeaders(null);
    try {
      setChallenge(parsePasted(pasted, network.name));
    } catch (e) {
      setParseError((e as Error).message);
    }
  };

  const pay = async () => {
    if (!challenge || problems.length) return;
    const native = challenge.tokenAddress.toLowerCase() === NATIVE_QUAI;
    const hash = await tx.run(`Pay ${formatTokenAmount(challenge.amount, challenge.tokenDecimals)} ${challenge.tokenSymbol}`, [
      {
        label: native
          ? `Pay ${formatTokenAmount(challenge.amount, challenge.tokenDecimals)} QUAI to ${shortAddress(challenge.recipientAddress)} (invoice ${challenge.invoiceId.slice(0, 10)}…)`
          : `Transfer ${formatTokenAmount(challenge.amount, challenge.tokenDecimals)} ${challenge.tokenSymbol} to ${shortAddress(challenge.recipientAddress)}`,
        build: () =>
          native
            ? { to: challenge.recipientAddress, data: challenge.callData ?? '0x', value: challenge.amount }
            : { to: challenge.tokenAddress, data: ERC20_TRANSFER.encodeFunctionData('transfer', [challenge.recipientAddress, challenge.amount]), value: 0n },
      },
    ]);
    if (hash) setProofHeaders(ChallengeParser.formatPaymentProofHeaders(challenge.invoiceId, hash));
  };

  const issue = () => {
    setIssued(null);
    const guild = directory.guilds.find((g) => g.name === invoiceGuild);
    if (!guild) return;
    let amount: bigint;
    try {
      amount = parseTokenAmount(invoiceAmount, 18);
      if (amount <= 0n) return;
    } catch {
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(1, Number(invoiceTtl) || 10);
    setIssued(
      buildTributeChallenge({
        network,
        guildName: guild.name,
        treasury: guild.guild,
        amount,
        invoiceId: newInvoiceId(),
        resourceUri: `https://darkorder.guild/halls/${encodeURIComponent(guild.name)}/tribute`,
        createdAt: now,
        expiresAt: now + ttl * 60,
        memo: invoiceMemo.trim() || undefined,
      })
    );
  };

  const copy = (label: string, text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 1500);
    });
  };

  const showcase = directory.mode === 'showcase';

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 lg:px-8">
      <h1 className="font-display text-3xl text-bone">Tribute · x402</h1>
      <p className="mt-2 max-w-3xl text-sm leading-relaxed text-bone-dim">
        x402 is the suite's payment rail: a service answers <span className="font-mono">402 Payment Required</span> with a challenge, you pay it on Quai, and
        the transaction hash is the proof. DarkOrder adds the native tribute scheme — paying a guild treasury in QUAI writes your invoice id into the guild's
        on-chain <span className="font-mono">TributeReceived</span> event, so the hall itself keeps the receipt. Challenges from any DarkCircle-speaking
        service parse here unchanged.
      </p>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* Pay a challenge */}
        <Card>
          <h2 className="flex items-center gap-2 font-display text-lg text-bone">
            <HandCoins className="h-4 w-4 text-gold" aria-hidden /> Pay a challenge
          </h2>
          <TextArea
            className="mt-4"
            label="The 402 response (JSON body or a {headers, body} bundle)"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder='{"payment": {"recipient": "0x00…", "amount": "5.0", "invoiceId": "…"}}'
            inputClassName="min-h-[140px] font-mono text-xs"
          />
          {parseError && <p className="mt-2 text-xs text-rose-300">{parseError}</p>}
          <div className="mt-3 flex justify-end">
            <Button variant="secondary" onClick={read} disabled={!pasted.trim()}>
              Read the challenge
            </Button>
          </div>

          {challenge && (
            <div className="mt-4 rounded-lg border border-line bg-ink-deep p-4">
              <dl className="space-y-1.5 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-bone-mute">Amount</dt>
                  <dd className="font-display text-base text-bone">
                    {formatTokenAmount(challenge.amount, challenge.tokenDecimals)} {challenge.tokenSymbol}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-bone-mute">To</dt>
                  <dd className="font-mono text-bone-dim">{shortAddress(challenge.recipientAddress, 10, 8)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-bone-mute">Scheme</dt>
                  <dd className="font-mono text-bone-dim">{challenge.scheme}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-bone-mute">Network</dt>
                  <dd className="font-mono text-bone-dim">
                    {challenge.network} · chain {challenge.chainId}
                  </dd>
                </div>
                {challenge.expiresAt !== 0 && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-bone-mute">Expires</dt>
                    <dd className="text-bone-dim">{new Date(challenge.expiresAt * 1000).toLocaleString()}</dd>
                  </div>
                )}
                {challenge.memo && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-bone-mute">Memo</dt>
                    <dd className="text-right text-bone-dim">{challenge.memo}</dd>
                  </div>
                )}
              </dl>
              {problems.length > 0 ? (
                <Notice tone="danger" className="mt-3">
                  <ul className="list-inside list-disc space-y-0.5">
                    {problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </Notice>
              ) : (
                <div className="mt-3 flex justify-end">
                  <Button onClick={() => void pay()} disabled={!address}>
                    {address ? 'Simulate, then sign' : 'Connect your wallet first'}
                  </Button>
                </div>
              )}
            </div>
          )}

          {proofHeaders && (
            <div className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/[0.05] p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-emerald-200">Paid. Retry the request with these proof headers:</div>
                <Button size="sm" variant="ghost" onClick={() => copy('proof', JSON.stringify(proofHeaders, null, 2))}>
                  <Copy className="h-3.5 w-3.5" aria-hidden /> {copied === 'proof' ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <pre className="mt-2 overflow-x-auto font-mono text-[11px] leading-relaxed text-emerald-100/80">{JSON.stringify(proofHeaders, null, 2)}</pre>
            </div>
          )}
        </Card>

        {/* Issue a tribute invoice */}
        <Card>
          <h2 className="flex items-center gap-2 font-display text-lg text-bone">
            <ScrollText className="h-4 w-4 text-gold" aria-hidden /> Issue a tribute invoice
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-bone-mute">
            For guild-facing services: render the challenge a 402 response should carry. Whoever pays it lands QUAI in the guild treasury with the invoice id
            in the event log.
          </p>
          <SelectField
            className="mt-4"
            label="Hall"
            value={invoiceGuild}
            onChange={(e) => setInvoiceGuild(e.target.value)}
            options={[
              { value: '', label: directory.guilds.length ? 'Choose a hall…' : 'No halls on this network' },
              ...directory.guilds.map((g) => ({ value: g.name, label: `${g.name} (${g.mode})` })),
            ]}
          />
          <div className="mt-4 grid grid-cols-2 gap-4">
            <TextField label="Amount" value={invoiceAmount} onChange={(e) => setInvoiceAmount(e.target.value)} inputMode="decimal" suffix="QUAI" />
            <TextField label="Expires in" value={invoiceTtl} onChange={(e) => setInvoiceTtl(e.target.value)} inputMode="numeric" suffix="min" />
          </div>
          <TextField className="mt-4" label="Memo (optional)" value={invoiceMemo} onChange={(e) => setInvoiceMemo(e.target.value)} placeholder="Chronicle access, one epoch" />
          <div className="mt-4 flex justify-end">
            <Button onClick={issue} disabled={!invoiceGuild}>
              Render the challenge
            </Button>
          </div>

          {issued && (
            <div className="mt-4 rounded-lg border border-line bg-ink-deep p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-bone">
                  <FileJson className="h-4 w-4 text-gold" aria-hidden /> RFC 7807 body
                </div>
                <Button size="sm" variant="ghost" onClick={() => copy('body', JSON.stringify(issued.body, null, 2))}>
                  <Copy className="h-3.5 w-3.5" aria-hidden /> {copied === 'body' ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <pre className="mt-2 max-h-64 overflow-auto font-mono text-[11px] leading-relaxed text-bone-dim">{JSON.stringify(issued.body, null, 2)}</pre>
              <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
                <div className="text-sm font-medium text-bone">Headers</div>
                <Button size="sm" variant="ghost" onClick={() => copy('headers', JSON.stringify(issued.headers, null, 2))}>
                  <Copy className="h-3.5 w-3.5" aria-hidden /> {copied === 'headers' ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <pre className="mt-2 max-h-48 overflow-auto font-mono text-[11px] leading-relaxed text-bone-dim">{JSON.stringify(issued.headers, null, 2)}</pre>
              <p className="mt-3 text-[11px] leading-relaxed text-bone-mute">
                Serve the body with status 402 and the headers alongside it. A payer pastes it into the left panel — or any x402 client pays it directly.
              </p>
            </div>
          )}
          {showcase && (
            <Notice tone="gold" className="mt-4">
              Showcase halls issue real challenge documents, but their treasury addresses are invented samples — do not pay them.
            </Notice>
          )}
        </Card>
      </div>
    </div>
  );
};
