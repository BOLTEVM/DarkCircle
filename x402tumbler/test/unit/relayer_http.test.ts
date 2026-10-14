/**
 * DarkCircle production relayer: loopback HTTP API tests
 * File: test/unit/relayer_http.test.ts
 *
 * Binds the real server (ephemeral loopback port): auth, Host/Origin rejection, rate limiting and
 * the quote → relay → status round trip. No network beyond loopback.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { getAddress } from "ethers";
import { QuaiRpcClient } from "../../src/quai/rpc.ts";
import { QUAI_ORCHARD_CYPRUS1 } from "../../src/quai/networks.ts";
import { DarkCircleRelayer, type RelayerConfig } from "../../src/relayer/relayer.ts";
import { RelayStore } from "../../src/relayer/store.ts";
import { PermittedCallSigner, WalletQuaiSigner } from "../../src/relayer/signer.ts";
import { createRelayerHttp, isLoopbackHost, type RunningRelayerHttp } from "../../src/relayer/http.ts";
import { FakeQuaiNode } from "./relayerFakeNode.ts";

const PRIV = "0x" + "33".repeat(32);
const POOL = getAddress("0x0000000000000000000000000000000000000a11");
const TOKEN = getAddress("0x0000000000000000000000000000000000000b22");
const RECIPIENT = getAddress("0x00000000000000000000000000000000000d3905");
const ROOT = 12_345n;
const NULLIFIER = 888n;
const AUTH = "test-token";

const signerAddr = WalletQuaiSigner.fromPrivateKey(PRIV).address;

function relayBody(nullifier = NULLIFIER) {
  return {
    token: TOKEN,
    proof: { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] },
    payment: {
      root: "0x" + ROOT.toString(16),
      nullifier: "0x" + nullifier.toString(16),
      changeCommitment: "0x0",
      recipient: RECIPIENT,
      amount: (5n * 10n ** 18n).toString(),
      relayer: signerAddr,
      fee: "100000"
    }
  };
}

async function makeServer(rateLimit = 100): Promise<{ httpd: RunningRelayerHttp; node: FakeQuaiNode; relayer: DarkCircleRelayer }> {
  const node = new FakeQuaiNode(POOL, signerAddr);
  node.knownRoots.add(ROOT.toString());
  const rpc = new QuaiRpcClient({ network: QUAI_ORCHARD_CYPRUS1, transport: node.transport });
  const config: RelayerConfig = {
    poolAddress: POOL,
    tokenAddress: TOKEN,
    minFee: 10n,
    unshieldGasEstimate: 100_000n,
    gasHeadroomPercent: 0,
    quoteValidityBlocks: 12,
    minGasBalance: 1n,
    confirmationsRequired: 2,
    maxRelayAttempts: 3,
    txTimeoutBlocks: 5
  };
  const relayer = new DarkCircleRelayer({
    rpc,
    signer: new PermittedCallSigner(WalletQuaiSigner.fromPrivateKey(PRIV), POOL),
    store: new RelayStore(),
    config
  });
  const httpd = await createRelayerHttp({ relayer, port: 0, authToken: AUTH, rateLimitPerInterval: rateLimit });
  return { httpd, node, relayer };
}

function request(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: opts.method ?? "GET", headers: { connection: "close", ...opts.headers } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null });
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

describe("relayer HTTP API (loopback)", () => {
  let running: RunningRelayerHttp | null = null;
  afterEach(async () => {
    if (running) {
      await running.close();
      running = null;
    }
  });

  it("refuses to start without an auth token or on a non-loopback bind", async () => {
    const made = await makeServer();
    running = made.httpd;
    assert.throws(() => createRelayerHttp({ relayer: made.relayer, port: 0, authToken: "" }), /RELAYER_AUTH_TOKEN/);
    assert.throws(() => createRelayerHttp({ relayer: made.relayer, port: 0, authToken: AUTH, host: "0.0.0.0" }), /loopback/);
  });

  it("isLoopbackHost accepts loopback forms only", () => {
    for (const ok of ["localhost", "127.0.0.1", "127.0.0.1:4790", "::1", "[::1]", "LOCALHOST"]) {
      assert.ok(isLoopbackHost(ok), ok);
    }
    for (const bad of ["example.com", "192.168.1.1", "2130706433", "0x7f000001"]) {
      assert.equal(isLoopbackHost(bad), false, bad);
    }
  });

  it("requires the bearer token", async () => {
    const made = await makeServer();
    running = made.httpd;
    const noAuth = await request(`${running.url}/health`);
    assert.equal(noAuth.status, 401);
    const badAuth = await request(`${running.url}/health`, { headers: { authorization: "Bearer wrong" } });
    assert.equal(badAuth.status, 401);
    const ok = await request(`${running.url}/health`, { headers: { authorization: `Bearer ${AUTH}` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.online, true);
    assert.equal(ok.json.pool, POOL);
  });

  it("rejects a non-loopback Host header (DNS rebinding)", async () => {
    const made = await makeServer();
    running = made.httpd;
    const res = await request(`${running.url}/health`, {
      headers: { authorization: `Bearer ${AUTH}`, host: "evil.example" }
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, "ERR_FORBIDDEN_HOST");
  });

  it("serves quote → relay → status with the relayer as on-chain sender", async () => {
    const made = await makeServer();
    running = made.httpd;
    const auth = { authorization: `Bearer ${AUTH}` };

    const quote = await request(`${running.url}/quote`, { method: "POST", headers: auth, body: { token: TOKEN } });
    assert.equal(quote.status, 200);
    assert.equal(quote.json.relayer, signerAddr);
    assert.equal(quote.json.feeToken, TOKEN);
    assert.equal(BigInt(quote.json.estimatedFeeUnits), 100_000n);

    const relayed = await request(`${running.url}/relay`, { method: "POST", headers: auth, body: relayBody() });
    assert.equal(relayed.status, 200);
    assert.equal(relayed.json.status, "pending");
    assert.equal(made.node.sent.length, 1);
    assert.equal(made.node.sent[0].from, signerAddr);

    const status = await request(`${running.url}/status/0x${NULLIFIER.toString(16)}`, { headers: auth });
    assert.equal(status.status, 200);
    assert.equal(status.json.txHash, relayed.json.txHash);

    const missing = await request(`${running.url}/status/0x999`, { headers: auth });
    assert.equal(missing.status, 404);
  });

  it("refusals map to stable status codes and named errors", async () => {
    const made = await makeServer();
    running = made.httpd;
    const auth = { authorization: `Bearer ${AUTH}` };

    made.relayer.setOnline(false, "maintenance");
    const offline = await request(`${running.url}/relay`, { method: "POST", headers: auth, body: relayBody() });
    assert.equal(offline.status, 503);
    assert.equal(offline.json.error, "ERR_RELAYER_OFFLINE");
    made.relayer.setOnline(true);

    const wrongToken = await request(`${running.url}/quote`, { method: "POST", headers: auth, body: { token: RECIPIENT } });
    assert.equal(wrongToken.status, 400);
    assert.equal(wrongToken.json.error, "TOKEN_POOL_MISMATCH");

    const malformed = await request(`${running.url}/relay`, { method: "POST", headers: auth, body: { token: TOKEN } });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.json.error, "ERR_BAD_REQUEST");
  });

  it("rate limits a chatty source", async () => {
    const made = await makeServer(2);
    running = made.httpd;
    const auth = { authorization: `Bearer ${AUTH}` };
    const first = await request(`${running.url}/health`, { headers: auth });
    const second = await request(`${running.url}/health`, { headers: auth });
    const third = await request(`${running.url}/health`, { headers: auth });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.equal(third.json.error, "ERR_RATE_LIMITED");
  });
});
