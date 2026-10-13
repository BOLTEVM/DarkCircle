import { useCallback, useEffect, useState } from 'react';
import { Gift } from 'lucide-react';
import {
  airdropLeaf,
  airdropTx,
  createBatch,
  findEntry,
  formatUnits,
  readAirdropState,
  readIsClaimed,
  verifyMerkleProof,
  type AirdropContractState,
  type Distribution,
  type DistributionEntry
} from 'quai-service';
import { Badge, Notice, Spinner, box, muted } from './ui';
import { describeTxError, sendContractCall } from './farmSend';

const fmt = (n: bigint) => Number(formatUnits(n, 18, 2)).toLocaleString('en-US', { maximumFractionDigits: 2 });

type Loaded =
  | { kind: 'none' }
  | { kind: 'ready'; dist: Distribution; chain: AirdropContractState }
  | { kind: 'problem'; message: string };

/**
 * The airdrop claim card. It stays invisible until the project publishes a distribution file (public/airdrop/distribution.json)
 * AND that file's contract holds the same Merkle root: a stale or tampered file shows nothing rather than a wrong amount.
 */
export default function AirdropClaim({ wallet, onConnect }: { wallet: string | null; onConnect: () => void | Promise<void> }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'none' });
  const [claimed, setClaimed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`${import.meta.env.BASE_URL}airdrop/distribution.json`, { cache: 'no-store' });
        if (!res.ok) return; // not published yet: no card
        const dist = (await res.json()) as Distribution;
        if (dist?.version !== 1 || !Array.isArray(dist.entries) || !dist.contract || !/^0x[0-9a-f]{64}$/.test(dist.merkleRoot ?? '')) {
          if (live) setLoaded({ kind: 'problem', message: 'The published airdrop file is not in a form this page understands.' });
          return;
        }
        const chain = await readAirdropState(createBatch(), dist.contract);
        if (!live) return;
        // only a file that is exactly what the contract was opened with is shown
        if (!chain.rootSet) return;
        if (chain.merkleRoot !== dist.merkleRoot.toLowerCase()) {
          setLoaded({ kind: 'problem', message: 'The published airdrop file does not match the contract, so no amounts are shown. Please wait for it to be fixed.' });
          return;
        }
        setLoaded({ kind: 'ready', dist, chain });
      } catch {
        /* offline, or no file: the card simply does not appear */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const entry: DistributionEntry | null = loaded.kind === 'ready' ? findEntry(loaded.dist, wallet) : null;
  const proofOk = Boolean(
    loaded.kind === 'ready' && entry && verifyMerkleProof(entry.proof, loaded.dist.merkleRoot, airdropLeaf(entry.index, entry.account, BigInt(entry.amountA), BigInt(entry.amountB)))
  );

  const refreshClaimed = useCallback(async () => {
    if (loaded.kind !== 'ready' || !entry) return setClaimed(null);
    try {
      setClaimed(await readIsClaimed(createBatch(), loaded.dist.contract!, entry.index));
    } catch {
      setClaimed(null);
    }
  }, [loaded, entry]);
  useEffect(() => {
    void refreshClaimed();
  }, [refreshClaimed]);

  if (loaded.kind === 'none') return null;
  if (loaded.kind === 'problem') return <div style={{ ...box, margin: '0 0 1rem' }}><Notice tone="warn">{loaded.message}</Notice></div>;

  const { dist, chain } = loaded;
  const open = Date.now() / 1000 <= chain.claimDeadline;
  const claim = async () => {
    if (!wallet || !entry) return;
    setBusy(true);
    setMessage(null);
    try {
      await sendContractCall(wallet, dist.contract!, airdropTx.claim(entry.index, entry.account, BigInt(entry.amountA), BigInt(entry.amountB), entry.proof), { gasMultiplier: 1.5 });
      setMessage({ tone: 'ok', text: 'Claimed. The tokens are in your wallet.' });
    } catch (e: any) {
      setMessage({ tone: 'danger', text: describeTxError(e) });
    } finally {
      setBusy(false);
      void refreshClaimed();
    }
  };

  return (
    <section className="glass-card" style={{ marginBottom: '1rem' }} aria-label="Airdrop">
      <h3 style={{ margin: '0 0 0.4rem', display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '1rem' }}>
        <Gift size={17} /> Airdrop for Quainance BDELTA stakers
      </h3>
      {!wallet ? (
        <p style={{ ...muted, fontSize: '0.85rem', margin: '0 0 0.6rem' }}>Connect your wallet to see whether you are in the airdrop.</p>
      ) : !entry ? (
        <p style={{ ...muted, fontSize: '0.85rem', margin: 0 }}>This wallet is not in the airdrop. It was for wallets with at least 1,000 BDELTA staked on Quainance at the snapshot.</p>
      ) : !proofOk ? (
        <Notice tone="danger">Your entry in the published file does not verify. Do not claim; tell the team.</Notice>
      ) : (
        <>
          <p style={{ fontSize: '0.9rem', margin: '0 0 0.5rem' }}>
            You can claim <strong>{fmt(BigInt(entry.amountA))} Q0</strong> and <strong>{fmt(BigInt(entry.amountB))} QAXE</strong>
            {entry.burner && <> {' '}<Badge severity="ok" title="You burned liquidity, so your share counts 1.5x">burner bonus</Badge></>}
          </p>
          {claimed === true ? (
            <Badge severity="ok">Already claimed</Badge>
          ) : !open ? (
            <Notice tone="warn">The claim window closed on {new Date(chain.claimDeadline * 1000).toUTCString()}.</Notice>
          ) : (
            <button type="button" className="btn-primary" style={{ fontSize: '0.82rem', padding: '0.5rem 1rem' }} onClick={() => void claim()} disabled={busy || claimed === null}>
              {busy ? <><Spinner /> Claiming…</> : 'Claim'}
            </button>
          )}
          <small style={{ ...muted, display: 'block', marginTop: '0.4rem' }}>Open until {new Date(chain.claimDeadline * 1000).toUTCString()}.</small>
        </>
      )}
      {!wallet && (
        <button type="button" className="btn-primary" style={{ fontSize: '0.82rem', padding: '0.5rem 1rem' }} onClick={() => void onConnect()}>
          Connect
        </button>
      )}
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
    </section>
  );
}
