// Run: node --test test/tokenMetadata.test.ts   (Node 22.18+ / 24 strips the types)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeText, decodeAbiString, decodeAbiUint, decodeDecimals, splitDisplayName, shortAddress,
  resolveIconUrl, parseExplorerToken, readChainFields, readExplorerFields, createTokenMetadataService,
  PROFILE_TTL_MS, MARKET_TTL_MS, NEGATIVE_TTL_MS, TOKEN_PROFILE_STORAGE_KEY
} from '../src/tokenMetadata.ts';

const RPC = 'https://rpc.test/cyprus1';
const EXPLORER = 'https://explorer.test';
const A = '0x00325150094e51107a931980fdfc3bb1a4c48379';
const B = '0x002d4a4fbac3df3342ed17fdba5139818a43b508';

const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const utf8Hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
/** ABI-encode a dynamic string return value. */
function encString(s: string): string {
  const data = utf8Hex(s);
  return '0x' + word(32) + word(data.length / 2) + data.padEnd(Math.ceil(data.length / 64) * 64, '0');
}
const encUint = (n: bigint | number) => '0x' + word(n);

// ---------------------------------------------------------------------------------------------
describe('decoding untrusted contract output', () => {
  it('decodes a standard ABI string, UTF-8 included', () => {
    assert.equal(decodeAbiString(encString('QBOLT')), 'QBOLT');
    assert.equal(decodeAbiString(encString('Café ☕')), 'Café ☕');
  });

  it('decodes a legacy bytes32 name', () => {
    const hex = '0x' + utf8Hex('MKR').padEnd(64, '0');
    assert.equal(decodeAbiString(hex), 'MKR');
  });

  it('returns undefined, never raw hex, for empty or malformed data', () => {
    for (const bad of ['0x', '', undefined, null, 42, '0xzz', '0x1234', '0x' + word(32) + word(5)]) {
      assert.equal(decodeAbiString(bad as unknown), undefined, String(bad));
    }
    // length word claims more bytes than the payload carries
    assert.equal(decodeAbiString('0x' + word(32) + word(500) + 'aa'.repeat(8)), undefined);
    // absurd length
    assert.equal(decodeAbiString('0x' + word(32) + word(10_000_000) + 'aa'.repeat(8)), undefined);
    // misaligned offset
    assert.equal(decodeAbiString('0x' + word(33) + word(1) + '41'.padEnd(64, '0')), undefined);
  });

  it('treats decimals as unknown, not zero, when the read is bad or out of range', () => {
    assert.equal(decodeDecimals(encUint(18)), 18);
    assert.equal(decodeDecimals(encUint(0)), 0); // a real 0-decimals token is still fine
    assert.equal(decodeDecimals('0x'), undefined);
    assert.equal(decodeDecimals(undefined), undefined);
    assert.equal(decodeDecimals(encUint(255)), undefined);
    assert.equal(decodeDecimals(encUint(37)), undefined);
  });

  it('decodes uints and rejects junk', () => {
    assert.equal(decodeAbiUint(encUint(10n ** 27n)), 10n ** 27n);
    assert.equal(decodeAbiUint('0x'), undefined);
    assert.equal(decodeAbiUint('0x' + '1'.repeat(65)), undefined);
  });
});

// ---------------------------------------------------------------------------------------------
describe('text and url hygiene', () => {
  it('strips control, bidi and zero-width characters and caps the length', () => {
    const evil = 'Wrapped‮ Quai​\u0007\n⁦x';
    const clean = sanitizeText(evil, 64)!;
    assert.doesNotMatch(clean, /[\u0000-\u001f​-‏‪-‮⁦-⁩]/u);
    assert.equal(clean, 'Wrapped Quai x');
    assert.equal(sanitizeText('a'.repeat(200), 20)!.length, 20);
    assert.equal(sanitizeText('   ​  ', 10), undefined);
    assert.equal(sanitizeText(123 as unknown, 10), undefined);
  });

  it('splits a bracketed tag off a display name', () => {
    assert.deepEqual(splitDisplayName('BOLTDELTA [delta.boltevm.com]'), { title: 'BOLTDELTA', tag: 'delta.boltevm.com' });
    assert.deepEqual(splitDisplayName('Wrapped Quai'), { title: 'Wrapped Quai' });
    assert.deepEqual(splitDisplayName('[only a tag]'), { title: '[only a tag]' });
  });

  it('shortens addresses', () => {
    assert.equal(shortAddress(A), '0x0032…8379');
  });

  it('resolves root-relative icon paths against the explorer, not the app origin', () => {
    assert.equal(resolveIconUrl('/token-icons/wrapped-quai.png', EXPLORER), `${EXPLORER}/token-icons/wrapped-quai.png`);
    assert.equal(resolveIconUrl('/api/nft-media/abc', EXPLORER + '/'), `${EXPLORER}/api/nft-media/abc`);
  });

  it('routes ipfs:// and ar:// through gateways and upgrades protocol-relative urls', () => {
    assert.equal(resolveIconUrl('ipfs://bafy123', EXPLORER), 'https://ipfs.io/ipfs/bafy123');
    assert.equal(resolveIconUrl('ipfs://ipfs/bafy123', EXPLORER), 'https://ipfs.io/ipfs/bafy123');
    assert.equal(resolveIconUrl('ar://MbJXaZJw', EXPLORER), 'https://arweave.net/MbJXaZJw');
    assert.equal(resolveIconUrl('//cdn.example/x.png', EXPLORER), 'https://cdn.example/x.png');
  });

  it('refuses anything that is not https or a raster data image', () => {
    for (const bad of ['http://evil.example/x.png', 'javascript:alert(1)', 'data:text/html;base64,PGgxPg==',
      'data:image/svg+xml;base64,PHN2Zz4=', 'file:///etc/passwd', 'ftp://x/y', '', '   ', 42, null]) {
      assert.equal(resolveIconUrl(bad as unknown, EXPLORER), undefined, String(bad));
    }
    assert.match(resolveIconUrl('data:image/png;base64,iVBORw0KGgo=', EXPLORER)!, /^data:image\/png/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('explorer body parsing', () => {
  it('reads price and holders and tolerates marketStats: null', () => {
    const full = parseExplorerToken({
      token: { name: 'QBOLT', symbol: 'Q0', icon_url: '/token-icons/q0.jpg', website: 'https://boltevm.com/', holder_count: 83, description: 'Official' },
      marketStats: { priceUsd: '0.000026', marketCapUsd: '26000' }
    }, EXPLORER)!;
    assert.equal(full.priceUsd, 0.000026);
    assert.equal(full.marketCapUsd, 26000);
    assert.equal(full.holders, 83);
    assert.equal(full.iconUrl, `${EXPLORER}/token-icons/q0.jpg`);
    assert.equal(full.website, 'https://boltevm.com/');

    const noStats = parseExplorerToken({ token: { name: 'X', symbol: 'X', holder_count: 1 }, marketStats: null }, EXPLORER)!;
    assert.equal(noStats.priceUsd, undefined);
    assert.equal(noStats.holders, 1);
  });

  it('rejects a non-https website and a zero or garbage price', () => {
    const r = parseExplorerToken({ token: { name: 'X', symbol: 'X', website: 'http://x.example' }, marketStats: { priceUsd: '0', marketCapUsd: 'NaN' } }, EXPLORER)!;
    assert.equal(r.website, undefined);
    assert.equal(r.priceUsd, undefined);
    assert.equal(r.marketCapUsd, undefined);
  });

  it('returns null for a body without a token', () => {
    assert.equal(parseExplorerToken(null, EXPLORER), null);
    assert.equal(parseExplorerToken({ token: null }, EXPLORER), null);
    assert.equal(parseExplorerToken('oops', EXPLORER), null);
  });
});

// ---------------------------------------------------------------------------------------------
// A scripted network: JSON-RPC (batch or not, with per-call errors) and the explorer.
interface NetScript {
  chain: Record<string, { name?: string; symbol?: string; decimals?: number | 'bad'; supply?: bigint; failName?: boolean }>;
  explorer: Record<string, unknown | number>; // body, or an HTTP status
  batch?: boolean; // false: the node rejects batch arrays
  rpcDown?: boolean;
  explorerDown?: boolean;
}
function scripted(s: NetScript) {
  const log = { rpcRequests: 0, rpcCalls: 0, explorer: [] as string[] };
  const answer = (call: any) => {
    const to = String(call.params[0].to).toLowerCase();
    const data = call.params[0].data;
    const c = s.chain[to];
    if (!c) return { jsonrpc: '2.0', id: call.id, result: '0x' };
    log.rpcCalls++;
    if (data === '0x06fdde03') return c.failName ? { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'revert' } } : { jsonrpc: '2.0', id: call.id, result: c.name === undefined ? '0x' : encString(c.name) };
    if (data === '0x95d89b41') return { jsonrpc: '2.0', id: call.id, result: c.symbol === undefined ? '0x' : encString(c.symbol) };
    if (data === '0x313ce567') return { jsonrpc: '2.0', id: call.id, result: c.decimals === 'bad' ? '0x' : encUint(c.decimals ?? 18) };
    if (data === '0x18160ddd') return { jsonrpc: '2.0', id: call.id, result: encUint(c.supply ?? 0n) };
    return { jsonrpc: '2.0', id: call.id, result: '0x' };
  };
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    if (input === RPC) {
      log.rpcRequests++;
      if (s.rpcDown) throw new Error('network down');
      const body = JSON.parse(String(init?.body));
      if (Array.isArray(body)) {
        if (s.batch === false) return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch unsupported' } }), { status: 200 });
        return new Response(JSON.stringify(body.map(answer)), { status: 200 });
      }
      return new Response(JSON.stringify(answer(body)), { status: 200 });
    }
    if (input.startsWith(EXPLORER + '/api/token/')) {
      const address = input.slice((EXPLORER + '/api/token/').length).toLowerCase();
      log.explorer.push(address);
      if (s.explorerDown) throw new Error('explorer down');
      const v = s.explorer[address];
      if (typeof v === 'number') return new Response('{}', { status: v });
      if (v === undefined) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify(v), { status: 200 });
    }
    throw new Error('unexpected url ' + input);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, log };
}

const explorerBody = (over: Record<string, unknown> = {}, stats: unknown = { priceUsd: '0.05' }) => ({
  token: { name: 'Explorer Name', symbol: 'EXP', decimals: 6, icon_url: '/token-icons/x.jpg', holder_count: 10, ...over },
  marketStats: stats
});

describe('chain reads', () => {
  it('reads every token in one batch request', async () => {
    const net = scripted({ chain: { [A]: { name: 'QBOLT', symbol: 'Q0', supply: 10n ** 27n }, [B]: { name: 'BOLTDELTA [delta.boltevm.com]', symbol: 'BDELTA' } }, explorer: {} });
    const out = await readChainFields([A, B], { fetch: net.fetch, rpcUrl: RPC });
    assert.equal(net.log.rpcRequests, 1, 'one HTTP request for 2 tokens x 4 fields');
    assert.equal(net.log.rpcCalls, 8);
    assert.deepEqual(out[A], { name: 'QBOLT', symbol: 'Q0', decimals: 18, totalSupply: (10n ** 27n).toString() });
    assert.equal(out[B].name, 'BOLTDELTA [delta.boltevm.com]');
  });

  it('keeps the other fields when one call reverts', async () => {
    const net = scripted({ chain: { [A]: { name: 'X', symbol: 'XX', failName: true } }, explorer: {} });
    const out = await readChainFields([A], { fetch: net.fetch, rpcUrl: RPC });
    assert.equal(out[A].name, undefined);
    assert.equal(out[A].symbol, 'XX');
    assert.equal(out[A].decimals, 18);
  });

  it('reports unreadable decimals as undefined, not 0', async () => {
    const net = scripted({ chain: { [A]: { name: 'X', symbol: 'XX', decimals: 'bad' } }, explorer: {} });
    assert.equal((await readChainFields([A], { fetch: net.fetch, rpcUrl: RPC }))[A].decimals, undefined);
  });

  it('falls back to single calls when the node rejects batches', async () => {
    const net = scripted({ chain: { [A]: { name: 'QBOLT', symbol: 'Q0' } }, explorer: {}, batch: false });
    const out = await readChainFields([A], { fetch: net.fetch, rpcUrl: RPC });
    assert.equal(out[A].symbol, 'Q0');
    assert.ok(net.log.rpcRequests > 1);
  });

  it('survives a totally unreachable node', async () => {
    const net = scripted({ chain: {}, explorer: {}, rpcDown: true });
    const out = await readChainFields([A], { fetch: net.fetch, rpcUrl: RPC });
    assert.deepEqual(out[A], { name: undefined, symbol: undefined, decimals: undefined, totalSupply: undefined });
  });
});

describe('explorer reads', () => {
  it('treats 404 as "unknown token", other failures as errors', async () => {
    const net = scripted({ chain: {}, explorer: { [A]: 404, [B]: 502 } });
    assert.equal(await readExplorerFields(A, { fetch: net.fetch, explorerUrl: EXPLORER }), null);
    await assert.rejects(readExplorerFields(B, { fetch: net.fetch, explorerUrl: EXPLORER }));
  });
});

// ---------------------------------------------------------------------------------------------
function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), raw: m };
}

describe('merging and precedence', () => {
  it('chain wins for name, symbol and decimals; the explorer adds presentation only', async () => {
    const net = scripted({
      chain: { [A]: { name: 'Chain Name', symbol: 'CHN', decimals: 18 } },
      explorer: { [A]: explorerBody() } // says 6 decimals and a different name
    });
    const svc = createTokenMetadataService({ fetch: net.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage: null });
    const { profiles } = await svc.load([A]);
    const p = profiles[A];
    assert.equal(p.name, 'Chain Name');
    assert.equal(p.symbol, 'CHN');
    assert.equal(p.decimals, 18, 'decimals must come from the chain, never the explorer');
    assert.equal(p.iconUrl, `${EXPLORER}/token-icons/x.jpg`);
    assert.equal(p.priceUsd, 0.05);
    assert.equal(p.holders, 10);
    assert.deepEqual(p.source, { chain: true, explorer: true });
  });

  it('never takes decimals from the explorer when the chain read failed', async () => {
    const net = scripted({ chain: { [A]: { decimals: 'bad' } }, explorer: { [A]: explorerBody() } });
    const svc = createTokenMetadataService({ fetch: net.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage: null });
    const { profiles } = await svc.load([A]);
    assert.equal(profiles[A].decimals, undefined);
    assert.equal(profiles[A].name, 'Explorer Name', 'the explorer may fill a name the chain did not give');
  });

  it('works with the explorer down (chain data only) and with the chain down (explorer only)', async () => {
    const a = scripted({ chain: { [A]: { name: 'N', symbol: 'S' } }, explorer: {}, explorerDown: true });
    const r1 = await createTokenMetadataService({ fetch: a.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage: null }).load([A]);
    assert.equal(r1.profiles[A].name, 'N');
    assert.equal(r1.profiles[A].iconUrl, undefined);

    const b = scripted({ chain: {}, explorer: { [A]: explorerBody() }, rpcDown: true });
    const r2 = await createTokenMetadataService({ fetch: b.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage: null }).load([A]);
    assert.equal(r2.profiles[A].iconUrl, `${EXPLORER}/token-icons/x.jpg`);
    assert.equal(r2.profiles[A].decimals, undefined);
  });

  it('lists tokens neither source could describe as failed', async () => {
    const net = scripted({ chain: {}, explorer: {}, rpcDown: true });
    const { profiles, failed } = await createTokenMetadataService({ fetch: net.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage: null }).load([A]);
    assert.deepEqual(failed, [A]);
    assert.deepEqual(profiles, {});
  });

  it('reports progress per token as results arrive', async () => {
    const net = scripted({ chain: { [A]: { name: 'A', symbol: 'A' }, [B]: { name: 'B', symbol: 'B' } }, explorer: { [A]: explorerBody(), [B]: explorerBody() } });
    const seen: string[] = [];
    await createTokenMetadataService({ fetch: net.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage: null })
      .load([A, B], { onProfile: p => seen.push(p.address) });
    assert.ok(seen.includes(A) && seen.includes(B));
    assert.ok(seen.length >= 2);
  });
});

describe('caching', () => {
  it('serves a second load inside the TTL without any network request', async () => {
    let t = 1_000_000;
    const net = scripted({ chain: { [A]: { name: 'N', symbol: 'S' } }, explorer: { [A]: explorerBody() } });
    const svc = createTokenMetadataService({ fetch: net.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage: null, now: () => t });
    await svc.load([A]);
    const before = { rpc: net.log.rpcRequests, ex: net.log.explorer.length };
    t += 60_000;
    await svc.load([A]);
    assert.equal(net.log.rpcRequests, before.rpc);
    assert.equal(net.log.explorer.length, before.ex);
  });

  it('refreshes only the explorer (price) after the market TTL, and the chain after the profile TTL', async () => {
    let t = 1_000_000;
    const net = scripted({ chain: { [A]: { name: 'N', symbol: 'S' } }, explorer: { [A]: explorerBody() } });
    const svc = createTokenMetadataService({ fetch: net.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage: null, now: () => t });
    await svc.load([A]);
    const rpc0 = net.log.rpcRequests, ex0 = net.log.explorer.length;
    t += MARKET_TTL_MS + 1;
    await svc.load([A]);
    assert.equal(net.log.rpcRequests, rpc0, 'chain data is not stale yet');
    assert.equal(net.log.explorer.length, ex0 + 1);
    t += PROFILE_TTL_MS;
    await svc.load([A]);
    assert.equal(net.log.rpcRequests, rpc0 + 1);
  });

  it('does not hammer a failing source: negative results are cached briefly, then retried', async () => {
    let t = 1_000_000;
    const net = scripted({ chain: {}, explorer: {}, rpcDown: true, explorerDown: true });
    const svc = createTokenMetadataService({ fetch: net.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage: null, now: () => t });
    await svc.load([A]);
    const rpc1 = net.log.rpcRequests, ex1 = net.log.explorer.length;
    t += 5_000;
    await svc.load([A]);
    assert.equal(net.log.rpcRequests, rpc1);
    assert.equal(net.log.explorer.length, ex1);
    t += NEGATIVE_TTL_MS;
    await svc.load([A]);
    assert.ok(net.log.rpcRequests > rpc1, 'retried after the cool-down');
  });

  it('force bypasses TTLs and cool-downs', async () => {
    const t = 1_000_000;
    const net = scripted({ chain: { [A]: { name: 'N', symbol: 'S' } }, explorer: { [A]: explorerBody() } });
    const svc = createTokenMetadataService({ fetch: net.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage: null, now: () => t });
    await svc.load([A]);
    const before = net.log.rpcRequests;
    await svc.load([A], { force: true });
    assert.equal(net.log.rpcRequests, before + 1);
  });

  it('persists to storage and a fresh service serves it with no network', async () => {
    const storage = memoryStorage();
    const net = scripted({ chain: { [A]: { name: 'N', symbol: 'S' } }, explorer: { [A]: explorerBody() } });
    await createTokenMetadataService({ fetch: net.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage }).load([A]);
    assert.ok(storage.raw.has(TOKEN_PROFILE_STORAGE_KEY));

    const offline = scripted({ chain: {}, explorer: {}, rpcDown: true, explorerDown: true });
    const svc2 = createTokenMetadataService({ fetch: offline.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage });
    assert.equal(svc2.peek(A)?.symbol, 'S', 'available synchronously for first paint');
    assert.equal(svc2.peek(A)?.iconUrl, `${EXPLORER}/token-icons/x.jpg`);
  });

  it('ignores a corrupt or hostile storage blob', async () => {
    for (const blob of ['not json', '{"v":2}', '{"v":1,"entries":{"0xBAD":{"profile":{"address":"0xBAD"}}}}', '[]', 'null']) {
      const storage = memoryStorage();
      storage.setItem(TOKEN_PROFILE_STORAGE_KEY, blob);
      const svc = createTokenMetadataService({ fetch: scripted({ chain: {}, explorer: {} }).fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage });
      assert.equal(svc.peek('0xBAD'), undefined, blob);
    }
  });

  it('survives storage that throws', async () => {
    const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
    const net = scripted({ chain: { [A]: { name: 'N', symbol: 'S' } }, explorer: {} });
    const { profiles } = await createTokenMetadataService({ fetch: net.fetch, rpcUrl: RPC, explorerUrl: EXPLORER, storage: throwing }).load([A]);
    assert.equal(profiles[A].symbol, 'S');
  });
});
