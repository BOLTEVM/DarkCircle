import React, { useEffect, useMemo, useState } from 'react';
import { AbiCoder, concat, dataSlice, getAddress, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { CheckCircle2, CircleDashed, ExternalLink, Loader2, Rocket, XCircle } from 'lucide-react';
import {
  BroadcastError,
  assertWalletOnChain,
  checkAddress,
  explorerAddressUrl,
  explorerTxUrl,
  receiptSucceeded,
  runtimeMatchesBuild,
  waitForConfirmations,
  MAX_GAS_LIMIT,
} from '@darkquestate/core';
import { Button, Modal, Notice } from '@darkquestate/ui';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { BROWSER_DEPLOYMENT_NETWORKS, SAVED_DEPLOYMENT_PREFIX as SAVED_PREFIX, readStored, writeStored } from '../lib/env.js';

interface Artifact {
  abi: unknown[];
  bytecode: string;
  deployedBytecode: string;
}

// import.meta.glob gives an empty map (not a build error) when the contracts have not been compiled.
const ARTIFACTS = import.meta.glob('../../../../packages/contracts/artifacts/contracts/*/*.json');
const CREATION_GAS_PER_RUNTIME_BYTE = 1_250n;
const POST_KEY = 'darkquestate.launch.post.';

async function loadArtifact(name: string): Promise<Artifact> {
  const key = Object.keys(ARTIFACTS).find((k) => k.endsWith(`/${name}.sol/${name}.json`));
  const load = key ? ARTIFACTS[key] : undefined;
  if (!load) throw new Error(`The ${name} build is missing. Run the contracts build (pnpm build in packages/contracts), then reload.`);
  const mod: any = await load();
  return (mod.default ?? mod) as Artifact;
}

/** The address the Quai CREATE opcode yields: keccak256(from ++ 8-byte nonce ++ init data)[12:]. */
function quaiCreateAddress(from: string, nonce: number, data: string): string {
  return getAddress(dataSlice(keccak256(concat([from, zeroPadValue(toBeHex(nonce), 8), data])), 12));
}

/** Appends a 4-byte salt (constructors ignore it) until the address lands in Cyprus-1 on the Quai ledger. */
function grind(from: string, nonce: number, data: string, rule: 'cyprus1' | 'any'): { data: string; predicted: string } {
  let salt = nonce >>> 0;
  for (let i = 0; i < 200_000; i++) {
    const candidate = data + salt.toString(16).padStart(8, '0');
    const predicted = quaiCreateAddress(from, nonce, candidate);
    if (rule === 'any' || checkAddress(predicted, 'cyprus1').ok) return { data: candidate, predicted };
    salt = (salt + 1) >>> 0;
  }
  throw new Error('Could not find an in-zone contract address.');
}

type Phase = 'waiting' | 'working' | 'done' | 'failed';
const POST_ITEMS: [string, string][] = [
  ['broker', 'Register at least one broker from the Registrar console (nothing can be listed until one exists).'],
  ['registrar', 'Confirm the registrar address is the key that will mint deeds, and that it is backed up.'],
  ['record', 'Record the addresses permanently: run the CLI with --replace, or edit packages/core/src/deployments.ts, then rebuild the site.'],
  ['smoke', 'Mint one test deed, list it, make an offer and withdraw it before telling anyone the desk is live.'],
];

export const DeployModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { network, rpc, deployment } = useNetwork();
  const { wallet, address, addressProblem, onExpectedChain, connect, connecting, error: walletError } = useWallet();
  const [builds, setBuilds] = useState<'checking' | 'ok' | string>('checking');
  const [balance, setBalance] = useState<bigint | null>(null);
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const [ackUnaudited, setAckUnaudited] = useState(false);
  const [ackSpend, setAckSpend] = useState(false);
  const [phases, setPhases] = useState<[Phase, Phase]>(['waiting', 'waiting']);
  const [hashes, setHashes] = useState<[string | null, string | null]>([null, null]);
  const [conf, setConf] = useState<[number, number]>([0, 0]);
  const [deedAddr, setDeedAddr] = useState<string | null>(null);
  const [deskAddr, setDeskAddr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  /** Whether this browser kept the addresses (testnets only; mainnet goes live from the build). */
  const [persisted, setPersisted] = useState(false);
  const [post, setPost] = useState<Record<string, boolean>>({});

  const isMainnet = network.name === 'mainnet';

  useEffect(() => {
    if (!open) return;
    let alive = true;
    Promise.all([loadArtifact('QuestateDeed'), loadArtifact('QuestateBrokerage')])
      .then(([d, b]) => {
        if (!alive) return;
        const ok = (a: Artifact) => /^0x[0-9a-fA-F]+$/.test(a.bytecode) && a.deployedBytecode.length > 4;
        setBuilds(ok(d) && ok(b) ? 'ok' : 'A compiled contract has empty bytecode (an interface, not a contract).');
      })
      .catch((e: Error) => alive && setBuilds(e.message));
    rpc.getGasPrice().then((g) => alive && setGasPrice(g)).catch(() => alive && setGasPrice(null));
    try {
      setPost(JSON.parse(readStored(POST_KEY + network.name) ?? '{}'));
    } catch {
      setPost({});
    }
    return () => {
      alive = false;
    };
  }, [open, rpc, network.name]);

  useEffect(() => {
    if (!open || !address) {
      setBalance(null);
      return;
    }
    let alive = true;
    rpc.getBalance(address).then((b) => alive && setBalance(b)).catch(() => alive && setBalance(null));
    return () => {
      alive = false;
    };
  }, [open, address, rpc]);

  // Worst case = both creation gas limits at the current price (a revert is charged the whole limit).
  const worstCase = useMemo(() => {
    if (gasPrice === null) return null;
    const limit = (bytes: bigint) => (bytes * CREATION_GAS_PER_RUNTIME_BYTE < MAX_GAS_LIMIT ? bytes * CREATION_GAS_PER_RUNTIME_BYTE : MAX_GAS_LIMIT);
    // A contract's runtime is at most 24,576 bytes (EIP-170); exact sizes are only known after the build loads.
    return 2n * limit(24_576n) * gasPrice;
  }, [gasPrice]);

  const fmt = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(2)} QUAI`;
  const checklist: { label: string; ok: boolean; hint?: string }[] = [
    { label: `Target network: ${network.label}`, ok: true },
    { label: 'No deployment is recorded for this network', ok: !deployment, hint: 'A deployment already exists here; redeploying would orphan its listings.' },
    { label: 'Contract builds are present', ok: builds === 'ok', hint: builds === 'checking' ? 'Checking…' : builds },
    { label: 'Quai wallet connected', ok: Boolean(address), hint: wallet ? 'Connect your wallet.' : 'No Quai wallet found. Install Pelagus or open the page in Blip.' },
    { label: 'Wallet account is a Cyprus-1 Quai address', ok: Boolean(address) && !addressProblem, hint: addressProblem ?? 'Connect first.' },
    { label: `Wallet is on chain ${network.chainId}`, ok: Boolean(address) && onExpectedChain, hint: 'Switch the wallet network.' },
    {
      label: worstCase !== null ? `Balance covers the worst case (${fmt(worstCase)})` : 'Balance covers the worst-case gas',
      ok: balance !== null && worstCase !== null && balance >= worstCase,
      hint: balance === null ? 'Connect a wallet to read its balance.' : `Balance is ${fmt(balance)}.`,
    },
    ...(isMainnet ? [{ label: 'Unaudited deployment to mainnet acknowledged', ok: ackUnaudited, hint: 'No independent audit exists for these contracts.' }] : []),
    { label: 'Two real creation transactions acknowledged', ok: ackSpend, hint: 'Tick the box below.' },
  ];
  const ready = checklist.every((c) => c.ok);

  const send = async (idx: 0 | 1, label: string, from: string, data: string, runtimeBytes: number, predicted: string) => {
    if (!wallet) throw new Error('No wallet.');
    setPhases((p) => (idx === 0 ? ['working', p[1]] : [p[0], 'working']));
    await assertWalletOnChain(wallet.provider, network.chainId);
    await rpc.request(`${network.rpcNamespace}_call`, [{ from, data }, 'latest']).catch((e: Error) => {
      throw new Error(`The chain says ${label} would fail, so nothing was sent: ${e.message}`);
    });
    const wanted = BigInt(runtimeBytes) * CREATION_GAS_PER_RUNTIME_BYTE;
    const gasLimit = wanted < MAX_GAS_LIMIT ? wanted : MAX_GAS_LIMIT;
    const params: Record<string, unknown> = { from, data };
    params[wallet.namespace === 'quai' ? 'gasLimit' : 'gas'] = '0x' + gasLimit.toString(16);
    const hash = await wallet.provider.request({ method: `${wallet.namespace}_sendTransaction`, params: [params] });
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`The wallet returned an unexpected hash: ${String(hash)}`);
    setHashes((h) => (idx === 0 ? [hash, h[1]] : [h[0], hash]));
    const receipt = await waitForConfirmations(rpc, hash, {
      confirmations: network.confirmations,
      timeoutMs: 20 * 60_000,
      onProgress: (p) => setConf((c) => (idx === 0 ? [p.confirmations, c[1]] : [c[0], p.confirmations])),
    });
    if (!receiptSucceeded(receipt)) throw new Error(`${label} reverted on chain (tx ${hash}). Its gas was spent.`);
    const created = receipt.contractAddress ? getAddress(receipt.contractAddress) : null;
    if (created !== predicted) throw new Error(`${label} landed at ${created}, expected ${predicted}. Nothing was recorded; check tx ${hash}.`);
    setPhases((p) => (idx === 0 ? ['done', p[1]] : [p[0], 'done']));
    return created;
  };

  const nonceOf = async (from: string): Promise<number> =>
    parseInt(await rpc.request<string>(`${network.rpcNamespace}_getTransactionCount`, [from, 'pending']), 16);

  const deploy = async () => {
    if (!address) return;
    setBusy(true);
    setError(null);
    try {
      const [deedArt, deskArt] = await Promise.all([loadArtifact('QuestateDeed'), loadArtifact('QuestateBrokerage')]);
      const coder = AbiCoder.defaultAbiCoder();
      const from = getAddress(address);
      const rule = network.addressRule;

      const g1 = grind(from, await nonceOf(from), deedArt.bytecode + coder.encode(['address'], [from]).slice(2), rule);
      const deed = await send(0, 'QuestateDeed', from, g1.data, (deedArt.deployedBytecode.length - 2) / 2, g1.predicted);
      setDeedAddr(deed);
      if (!runtimeMatchesBuild(await rpc.getCode(deed), deedArt.deployedBytecode)) throw new Error('QuestateDeed code on chain does not match the build.');

      const g2 = grind(from, await nonceOf(from), deskArt.bytecode + coder.encode(['address', 'address'], [deed, from]).slice(2), rule);
      const desk = await send(1, 'QuestateBrokerage', from, g2.data, (deskArt.deployedBytecode.length - 2) / 2, g2.predicted);
      setDeskAddr(desk);
      // The brokerage's runtime embeds the registry address (an immutable), so its code is
      // compared with that slot filled in rather than by hash.
      if (!runtimeMatchesBuild(await rpc.getCode(desk), deskArt.deployedBytecode, [deed])) throw new Error('QuestateBrokerage code on chain does not match the build.');

      if (BROWSER_DEPLOYMENT_NETWORKS.includes(network.name)) {
        const head = Number(await rpc.getBlockNumber());
        writeStored(SAVED_PREFIX + network.name, JSON.stringify({ deed, brokerage: desk, fromBlock: Math.max(0, head - network.confirmations - 5) }));
        setPersisted(true);
      }
      setSaved(true);
    } catch (e) {
      const err = e as Error & { code?: number };
      setPhases((p) => p.map((x) => (x === 'working' ? 'failed' : x)) as [Phase, Phase]);
      setError(
        err instanceof BroadcastError
          ? err.message
          : err?.code === 4001 || /reject|denied|cancel/i.test(err?.message ?? '')
            ? 'You declined the request in your wallet. Nothing was sent.'
            : (err?.message ?? String(e))
      );
    } finally {
      setBusy(false);
    }
  };

  const togglePost = (k: string) => {
    const next = { ...post, [k]: !post[k] };
    setPost(next);
    writeStored(POST_KEY + network.name, JSON.stringify(next));
  };

  const icon = (p: Phase) =>
    p === 'done' ? (
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
    ) : p === 'failed' ? (
      <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
    ) : p === 'working' ? (
      <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-gold" />
    ) : (
      <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-bone-mute" />
    );

  const stepRow = (i: 0 | 1, label: string, addr: string | null) => (
    <li key={label} className="flex gap-3 rounded-lg border border-line bg-ink-deep px-4 py-3">
      {icon(phases[i])}
      <div className="min-w-0 flex-1 text-sm">
        <div className="text-bone">{label}</div>
        {phases[i] === 'working' && (
          <div className="mt-0.5 text-xs text-bone-mute">
            {hashes[i] ? `Confirmations ${Math.min(conf[i], network.confirmations)} of ${network.confirmations}…` : 'Approve it in your wallet.'}
          </div>
        )}
        {addr && (
          <div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-bone-dim">
            <span className="truncate">{addr}</span>
            {explorerAddressUrl(network, addr) && (
              <a href={explorerAddressUrl(network, addr)!} target="_blank" rel="noopener noreferrer" className="shrink-0 text-gold" aria-label="Open in explorer">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )}
        {hashes[i] && !addr && explorerTxUrl(network, hashes[i]!) && (
          <a href={explorerTxUrl(network, hashes[i]!)!} target="_blank" rel="noopener noreferrer" className="mt-1 block truncate font-mono text-[11px] text-gold">
            {hashes[i]}
          </a>
        )}
      </div>
    </li>
  );

  return (
    <Modal open={open} onClose={() => !busy && onClose()} title="Deploy Dark Questate" subtitle={`QuestateDeed + QuestateBrokerage on ${network.label}`} width="md" locked={busy}>
      <div className="space-y-4" data-testid="deploy-modal">
        {(error || walletError) && <Notice tone="danger">{error ?? walletError}</Notice>}

        {!saved && (
          <>
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-bone-dim">Launch checklist</div>
              <ul className="space-y-1.5" data-testid="launch-checklist">
                {checklist.map((c) => (
                  <li key={c.label} className="flex items-start gap-2 text-sm">
                    {c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> : <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />}
                    <div>
                      <div className={c.ok ? 'text-bone' : 'text-amber-100'}>{c.label}</div>
                      {!c.ok && c.hint && <div className="text-xs text-bone-mute">{c.hint}</div>}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="mt-3 space-y-1.5 text-sm text-bone-dim">
                {isMainnet && (
                  <label className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={ackUnaudited} onChange={(e) => setAckUnaudited(e.target.checked)} disabled={busy} />
                    <span>These contracts have had no independent audit and I deploy them to mainnet anyway.</span>
                  </label>
                )}
                <label className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={ackSpend} onChange={(e) => setAckSpend(e.target.checked)} disabled={busy} />
                  <span>Send both creation transactions from my wallet. My account becomes the registrar and the operator.</span>
                </label>
              </div>
            </div>

            <ol className="space-y-2">
              {stepRow(0, '1. QuestateDeed (deed registry)', deedAddr)}
              {stepRow(1, '2. QuestateBrokerage (listings, offers, escrow)', deskAddr)}
            </ol>

            {!address ? (
              <Button onClick={connect} loading={connecting} className="w-full">
                Connect wallet
              </Button>
            ) : (
              <Button onClick={deploy} disabled={!ready || busy} loading={busy} className="w-full" data-testid="deploy-button">
                <Rocket className="h-4 w-4" /> Deploy both contracts
              </Button>
            )}
          </>
        )}

        {saved && (
          <>
            <Notice tone="gold" title="Both contracts deployed and verified on chain">
              {persisted
                ? 'The code on chain matches the build. The addresses are saved in this browser only; reloading switches this browser from showcase to live.'
                : `The code on chain matches the build. ${network.label} addresses are never taken from browser storage: record them (the CLI with --replace, or packages/core/src/deployments.ts) and rebuild the site to go live.`}
            </Notice>
            <ol className="space-y-2">
              {stepRow(0, 'QuestateDeed', deedAddr)}
              {stepRow(1, 'QuestateBrokerage', deskAddr)}
            </ol>
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-bone-dim">After launch</div>
              <ul className="space-y-1.5 text-sm text-bone-dim" data-testid="post-launch-checklist">
                {POST_ITEMS.map(([k, text]) => (
                  <li key={k}>
                    <label className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1" checked={Boolean(post[k])} onChange={() => togglePost(k)} />
                      <span className={post[k] ? 'text-bone-mute line-through' : ''}>{text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
            {persisted && (
              <Button onClick={() => window.location.reload()} className="w-full">
                Reload as a live site
              </Button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
