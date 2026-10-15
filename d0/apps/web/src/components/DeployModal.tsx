import React, { useEffect, useMemo, useState } from 'react';
import { AbiCoder, concat, dataSlice, getAddress, getCreateAddress, keccak256, toBeHex, zeroPadValue } from 'ethers';
import { CheckCircle2, CircleDashed, ExternalLink, Loader2, Rocket, XCircle } from 'lucide-react';
import {
  BroadcastError,
  MAX_GAS_LIMIT,
  REGISTRY,
  assertWalletOnChain,
  checkAddress,
  explorerAddressUrl,
  explorerTxUrl,
  prepareTransaction,
  receiptSucceeded,
  runtimeMatchesBuild,
  sendPrepared,
  waitForConfirmations,
  type NetworkConfig,
} from '@darkorder/core';
import { Button, Modal, Notice } from './primitives.js';
import { useNetwork } from '../state/NetworkContext.js';
import { useWallet } from '../state/WalletContext.js';
import { BROWSER_DEPLOYMENT_NETWORKS, SAVED_DEPLOYMENT_PREFIX, readStored, writeStored } from '../lib/env.js';

interface Artifact {
  abi: unknown[];
  bytecode: string;
  deployedBytecode: string;
}

interface Builds {
  registry: Artifact;
  tokenStack: Artifact;
  factory: Artifact;
}

// import.meta.glob gives an empty map (not a build error) when the contracts have not been compiled.
const ARTIFACTS = import.meta.glob('../../../../packages/contracts/artifacts/contracts/*/*.json');
const CREATION_GAS_PER_RUNTIME_BYTE = 1_250n;
/** Gas headroom for the one-time registry.wire(factory) call; the real limit comes from simulation. */
const WIRE_GAS_HEADROOM = 300_000n;
const POST_KEY = 'darkorder.launch.post.';

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

/**
 * Predicts the CREATE address and, on Quai, appends a 4-byte salt (constructors ignore it) until
 * the address lands in Cyprus-1 on the Quai ledger. A plain EVM node (the local Hardhat chain)
 * derives the address as RLP(from, nonce) — init data plays no part, so there is nothing to grind.
 */
function grind(network: NetworkConfig, from: string, nonce: number, data: string): { data: string; predicted: string } {
  if (network.rpcNamespace !== 'quai') return { data, predicted: getCreateAddress({ from, nonce }) };
  let salt = nonce >>> 0;
  for (let i = 0; i < 200_000; i++) {
    const candidate = data + salt.toString(16).padStart(8, '0');
    const predicted = quaiCreateAddress(from, nonce, candidate);
    if (checkAddress(predicted, 'cyprus1').ok) return { data: candidate, predicted };
    salt = (salt + 1) >>> 0;
  }
  throw new Error('Could not find an in-zone contract address.');
}

const runtimeBytes = (a: Artifact) => (a.deployedBytecode.length - 2) / 2;

type Phase = 'waiting' | 'working' | 'done' | 'failed';
const STEP_LABELS = [
  'GuildNameRegistry (hall names)',
  'TokenStackDeployer (guild tokens)',
  'GuildFactory (founding)',
  'registry.wire(factory)',
] as const;

const POST_ITEMS: [string, string][] = [
  [
    'record',
    'Record the addresses permanently: run the CLI deploy script with --replace, or edit packages/core/src/deployments.ts, then rebuild and redeploy the site. An address saved in this browser only ever affects this browser.',
  ],
  ['smoke', 'Found one test guild, upload its crest and charter from the steward desk, and cast a test vote before telling anyone the Halls are live.'],
  ['tribute', 'Send a small x402 tribute from the Tribute page to confirm the payment rail settles on this network.'],
  ['keys', 'Back up the deployer key anyway: wiring is done and it holds no remaining powers, but it is the protocol’s provenance.'],
];

export const DeployModal: React.FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
  const { network, rpc, deployment } = useNetwork();
  const { wallet, address, addressProblem, onExpectedChain, connect, connecting, error: walletError } = useWallet();
  const [builds, setBuilds] = useState<'checking' | 'ok' | string>('checking');
  const [arts, setArts] = useState<Builds | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [gasPrice, setGasPrice] = useState<bigint | null>(null);
  const [ackUnaudited, setAckUnaudited] = useState(false);
  const [ackSpend, setAckSpend] = useState(false);
  const [phases, setPhases] = useState<Phase[]>(['waiting', 'waiting', 'waiting', 'waiting']);
  const [hashes, setHashes] = useState<(string | null)[]>([null, null, null, null]);
  const [conf, setConf] = useState<number[]>([0, 0, 0, 0]);
  const [registryAddr, setRegistryAddr] = useState<string | null>(null);
  const [tokenStackAddr, setTokenStackAddr] = useState<string | null>(null);
  const [factoryAddr, setFactoryAddr] = useState<string | null>(null);
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
    Promise.all([loadArtifact('GuildNameRegistry'), loadArtifact('TokenStackDeployer'), loadArtifact('GuildFactory')])
      .then(([registry, tokenStack, factory]) => {
        if (!alive) return;
        const ok = (a: Artifact) => /^0x[0-9a-fA-F]+$/.test(a.bytecode) && a.deployedBytecode.length > 4;
        if (ok(registry) && ok(tokenStack) && ok(factory)) {
          setArts({ registry, tokenStack, factory });
          setBuilds('ok');
        } else {
          setBuilds('A compiled contract has empty bytecode (an interface, not a contract).');
        }
      })
      .catch((e: Error) => alive && setBuilds(e.message));
    rpc
      .getGasPrice()
      .then((g) => alive && setGasPrice(g))
      .catch(() => alive && setGasPrice(null));
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
    rpc
      .getBalance(address)
      .then((b) => alive && setBalance(b))
      .catch(() => alive && setBalance(null));
    return () => {
      alive = false;
    };
  }, [open, address, rpc]);

  // Worst case = all three creation gas limits plus the wire headroom at the current price
  // (a revert is charged the whole limit). Exact runtime sizes once the builds have loaded;
  // until then a contract's runtime is at most 24,576 bytes (EIP-170).
  const worstCase = useMemo(() => {
    if (gasPrice === null) return null;
    const limit = (bytes: bigint) => (bytes * CREATION_GAS_PER_RUNTIME_BYTE < MAX_GAS_LIMIT ? bytes * CREATION_GAS_PER_RUNTIME_BYTE : MAX_GAS_LIMIT);
    const creations = arts
      ? limit(BigInt(runtimeBytes(arts.registry))) + limit(BigInt(runtimeBytes(arts.tokenStack))) + limit(BigInt(runtimeBytes(arts.factory)))
      : 3n * limit(24_576n);
    return (creations + WIRE_GAS_HEADROOM) * gasPrice;
  }, [gasPrice, arts]);

  const fmt = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(4)} QUAI`;
  const checklist: { label: string; ok: boolean; hint?: string }[] = [
    { label: `Target network: ${network.label}`, ok: true },
    { label: 'No deployment is recorded for this network', ok: !deployment, hint: 'A deployment already exists here; redeploying would orphan its guilds.' },
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
    { label: 'Four real transactions acknowledged', ok: ackSpend, hint: 'Tick the box below.' },
  ];
  const ready = checklist.every((c) => c.ok);

  const patchPhase = (idx: number, phase: Phase) => setPhases((p) => p.map((x, i) => (i === idx ? phase : x)));
  const patchHash = (idx: number, hash: string) => setHashes((h) => h.map((x, i) => (i === idx ? hash : x)));
  const patchConf = (idx: number, n: number) => setConf((c) => c.map((x, i) => (i === idx ? n : x)));

  const sendCreation = async (idx: number, label: string, from: string, data: string, bytes: number, predicted: string): Promise<string> => {
    if (!wallet) throw new Error('No wallet.');
    patchPhase(idx, 'working');
    await assertWalletOnChain(wallet.provider, network.chainId);
    await rpc.request('quai_call', [{ from, data }, 'latest']).catch((e: Error) => {
      throw new Error(`The chain says ${label} would fail, so nothing was sent: ${e.message}`);
    });
    const wanted = BigInt(bytes) * CREATION_GAS_PER_RUNTIME_BYTE;
    const gasLimit = wanted < MAX_GAS_LIMIT ? wanted : MAX_GAS_LIMIT;
    const params: Record<string, unknown> = { from, data };
    params[wallet.namespace === 'quai' ? 'gasLimit' : 'gas'] = '0x' + gasLimit.toString(16);
    const hash = await wallet.provider.request({ method: `${wallet.namespace}_sendTransaction`, params: [params] });
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`The wallet returned an unexpected hash: ${String(hash)}`);
    patchHash(idx, hash);
    const receipt = await waitForConfirmations(rpc, hash, {
      confirmations: network.confirmations,
      timeoutMs: 20 * 60_000,
      onProgress: (p) => patchConf(idx, p.confirmations),
    });
    if (!receiptSucceeded(receipt)) throw new Error(`${label} reverted on chain (tx ${hash}). Its gas was spent.`);
    const created = receipt.contractAddress ? getAddress(receipt.contractAddress) : null;
    if (created !== predicted) throw new Error(`${label} landed at ${created}, expected ${predicted}. Nothing was recorded; check tx ${hash}.`);
    patchPhase(idx, 'done');
    return created;
  };

  const nonceOf = async (from: string): Promise<number> => parseInt(await rpc.request<string>('quai_getTransactionCount', [from, 'pending']), 16);

  const deploy = async () => {
    if (!address || !arts || !wallet) return;
    setBusy(true);
    setError(null);
    try {
      const coder = AbiCoder.defaultAbiCoder();
      const from = getAddress(address);

      const g1 = grind(network, from, await nonceOf(from), arts.registry.bytecode);
      const registry = await sendCreation(0, 'GuildNameRegistry', from, g1.data, runtimeBytes(arts.registry), g1.predicted);
      setRegistryAddr(registry);
      if (!runtimeMatchesBuild(await rpc.getCode(registry), arts.registry.deployedBytecode, [from]))
        throw new Error('GuildNameRegistry code on chain does not match the build.');

      const g2 = grind(network, from, await nonceOf(from), arts.tokenStack.bytecode);
      const tokenStack = await sendCreation(1, 'TokenStackDeployer', from, g2.data, runtimeBytes(arts.tokenStack), g2.predicted);
      setTokenStackAddr(tokenStack);
      if (!runtimeMatchesBuild(await rpc.getCode(tokenStack), arts.tokenStack.deployedBytecode))
        throw new Error('TokenStackDeployer code on chain does not match the build.');

      const g3 = grind(network, from, await nonceOf(from), arts.factory.bytecode + coder.encode(['address', 'address'], [registry, tokenStack]).slice(2));
      const factory = await sendCreation(2, 'GuildFactory', from, g3.data, runtimeBytes(arts.factory), g3.predicted);
      setFactoryAddr(factory);
      if (!runtimeMatchesBuild(await rpc.getCode(factory), arts.factory.deployedBytecode, [registry, tokenStack]))
        throw new Error('GuildFactory code on chain does not match the build.');

      // Wire the registry to its factory (one-time, deployer-only) through the standard
      // simulate -> access list -> sign pipeline; its gas limit comes from the estimate.
      patchPhase(3, 'working');
      await assertWalletOnChain(wallet.provider, network.chainId);
      const prepared = await prepareTransaction(rpc, network, { from, to: registry, data: REGISTRY.encodeFunctionData('wire', [factory]) });
      const wireHash = await sendPrepared(wallet.provider, prepared, wallet.namespace);
      patchHash(3, wireHash);
      const wireReceipt = await waitForConfirmations(rpc, wireHash, {
        confirmations: network.confirmations,
        timeoutMs: 20 * 60_000,
        onProgress: (p) => patchConf(3, p.confirmations),
      });
      if (!receiptSucceeded(wireReceipt)) throw new BroadcastError(`registry.wire reverted on chain (tx ${wireHash}). Its gas was spent.`, wireHash);
      patchPhase(3, 'done');

      if (BROWSER_DEPLOYMENT_NETWORKS.includes(network.name)) {
        const head = Number(await rpc.getBlockNumber());
        writeStored(SAVED_DEPLOYMENT_PREFIX + network.name, JSON.stringify({ factory, registry, fromBlock: Math.max(0, head - network.confirmations - 5) }));
        setPersisted(true);
      }
      setSaved(true);
    } catch (e) {
      const err = e as Error & { code?: number };
      setPhases((p) => p.map((x) => (x === 'working' ? 'failed' : x)));
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

  const stepRow = (i: number, label: string, addr: string | null) => (
    <li key={label} className="flex gap-3 rounded-lg border border-line bg-ink-deep px-4 py-3">
      {icon(phases[i] ?? 'waiting')}
      <div className="min-w-0 flex-1 text-sm">
        <div className="text-bone">
          {i + 1}. {label}
        </div>
        {phases[i] === 'working' && (
          <div className="mt-0.5 text-xs text-bone-mute">
            {hashes[i] ? `Confirmations ${Math.min(conf[i] ?? 0, network.confirmations)} of ${network.confirmations}…` : 'Approve it in your wallet.'}
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
    <Modal open={open} onClose={() => !busy && onClose()} title="Deploy DarkOrder" subtitle={`GuildNameRegistry + TokenStackDeployer + GuildFactory on ${network.label}`} width="md" locked={busy}>
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
                  <span>Send three creation transactions and one wiring call from my wallet. My account pays the gas and becomes the registry deployer.</span>
                </label>
              </div>
            </div>

            <ol className="space-y-2">
              {stepRow(0, STEP_LABELS[0], registryAddr)}
              {stepRow(1, STEP_LABELS[1], tokenStackAddr)}
              {stepRow(2, STEP_LABELS[2], factoryAddr)}
              {stepRow(3, STEP_LABELS[3], null)}
            </ol>

            {!address ? (
              <Button onClick={connect} loading={connecting} className="w-full">
                Connect wallet
              </Button>
            ) : (
              <Button onClick={deploy} disabled={!ready || busy} loading={busy} className="w-full" data-testid="deploy-button">
                <Rocket className="h-4 w-4" /> Deploy the protocol
              </Button>
            )}
          </>
        )}

        {saved && (
          <>
            <Notice tone="gold" title="All three contracts deployed, verified and wired on chain">
              {persisted
                ? 'The code on chain matches the build, immutable slots included. The addresses are saved in this browser only; reloading switches this browser from showcase to live.'
                : `The code on chain matches the build, immutable slots included. ${network.label} addresses are never taken from browser storage: record them (the CLI with --replace, or packages/core/src/deployments.ts) and rebuild the site to go live.`}
            </Notice>
            <ol className="space-y-2">
              {stepRow(0, 'GuildNameRegistry', registryAddr)}
              {stepRow(1, 'TokenStackDeployer', tokenStackAddr)}
              {stepRow(2, 'GuildFactory', factoryAddr)}
              {stepRow(3, 'registry.wire(factory)', null)}
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
