/**
 * DarkCircle production relayer: loopback HTTP API
 * File: src/relayer/http.ts
 *
 * The v1 interface (RELAYER_PLAN.md §3.5): POST /quote, POST /relay, GET /status/:nullifier and
 * GET /health on loopback only. Hardening mirrors src/api/server.ts because browsers can be tricked
 * into calling localhost:
 *  - binds to the loopback interface only;
 *  - rejects any Host that is not loopback (DNS rebinding) and any cross-site Origin;
 *  - every call needs the bearer token that only the operator holds (RELAYER_AUTH_TOKEN);
 *  - JSON bodies only, capped at 64 KiB;
 *  - a token-bucket rate limit per source.
 *
 * Logging redaction: request and response logs contain method, path, status, duration and (for
 * relay) the nullifier — public data. The proof and payment payload are NEVER logged; the request
 * carries no notes or keys by construction, and the code keeps it that way.
 */

import http from "node:http";
import { DarkCircleRelayer } from "./relayer.ts";
import { RELAYER_ERRORS, RelayerError, isRelayerError, type RelayRequest } from "./types.ts";

const MAX_BODY = 64 * 1024;

/** Maps a named refusal to an HTTP status. Anything unnamed is a 500. */
const ERROR_STATUS: Record<string, number> = {
  ERR_RELAYER_OFFLINE: 503,
  ERR_RELAYER_GAS_FLOOR: 503,
  ERR_RELAYER_RECONCILING: 503,
  TOKEN_POOL_MISMATCH: 400,
  RELAYER_ADDRESS_MISMATCH: 400,
  FEE_BELOW_QUOTE: 400,
  QUOTE_EXPIRED: 400,
  NULLIFIER_ALREADY_SPENT: 409,
  UNKNOWN_ROOT: 400,
  RELAY_SIMULATION_FAILED: 422,
  NULLIFIER_RECORD_CONFLICT: 409,
  RELAY_ATTEMPTS_EXHAUSTED: 429,
  ERR_RPC_TX_DROPPED: 504,
  ERR_SIGNER_POLICY: 500,
  ERR_BAD_REQUEST: 400
};

export interface RelayerHttpOptions {
  relayer: DarkCircleRelayer;
  port?: number;
  host?: string;
  /** Bearer token required on every call. When empty, the server refuses to start. */
  authToken: string;
  /** Requests per bucket interval per source IP. */
  rateLimitPerInterval?: number;
  rateLimitIntervalMs?: number;
  log?: (msg: string) => void;
}

export interface RunningRelayerHttp {
  server: http.Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return (
    h === "localhost" ||
    h === "::1" ||
    h === "[::1]" ||
    /^localhost(:\d+)?$/.test(h) ||
    /^127\.0\.0\.1(:\d+)?$/.test(h) ||
    /^\[::1\](:\d+)?$/.test(h)
  );
}

class TokenBucket {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly intervalMs: number;

  constructor(limit: number, intervalMs: number) {
    this.limit = limit;
    this.intervalMs = intervalMs;
  }

  public allow(key: string): boolean {
    const now = Date.now();
    const window = now - this.intervalMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > window);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

export function createRelayerHttp(opts: RelayerHttpOptions): Promise<RunningRelayerHttp> {
  const relayer = opts.relayer;
  const log = opts.log ?? ((m: string) => console.log(m));
  if (!opts.authToken) throw new Error("ERR_RELAYER_CONFIG: RELAYER_AUTH_TOKEN must be set");
  const bucket = new TokenBucket(opts.rateLimitPerInterval ?? 30, opts.rateLimitIntervalMs ?? 60_000);
  const host = opts.host ?? "127.0.0.1";
  if (!isLoopbackHost(host)) {
    throw new Error(`ERR_RELAYER_CONFIG: ${host} is not loopback; the v1 API binds to 127.0.0.1 only (O-8)`);
  }

  const write = (res: http.ServerResponse, status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const source = req.socket.remoteAddress ?? "unknown";
    const pathName = (req.url ?? "/").split("?")[0];

    const finish = (status: number) => log(`${req.method} ${pathName} ${status} ${Date.now() - started}ms from ${source}`);

    try {
      // Host / Origin checks first: a browser tricked into a localhost call is the v1 threat model.
      const hostHeader = req.headers.host ?? "";
      if (!isLoopbackHost(hostHeader)) {
        write(res, 403, { error: "ERR_FORBIDDEN_HOST" });
        return finish(403);
      }
      const origin = req.headers.origin;
      if (origin !== undefined) {
        let ok = false;
        try {
          ok = isLoopbackHost(new URL(origin).host);
        } catch {
          ok = false;
        }
        if (!ok) {
          write(res, 403, { error: "ERR_FORBIDDEN_ORIGIN" });
          return finish(403);
        }
      }

      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${opts.authToken}`) {
        write(res, 401, { error: "ERR_UNAUTHORIZED" });
        return finish(401);
      }

      if (!bucket.allow(source)) {
        write(res, 429, { error: "ERR_RATE_LIMITED" });
        return finish(429);
      }

      if (req.method === "GET" && pathName === "/health") {
        write(res, 200, relayer.health());
        return finish(200);
      }

      if (req.method === "POST" && pathName === "/quote") {
        const body = await readBody(req);
        const token = (body as { token?: string })?.token ?? relayer.config.tokenAddress;
        const quote = await relayer.getQuote();
        if (String(token).toLowerCase() !== relayer.config.tokenAddress.toLowerCase()) {
          write(res, 400, { error: "TOKEN_POOL_MISMATCH" });
          return finish(400);
        }
        write(res, 200, quote);
        return finish(200);
      }

      if (req.method === "POST" && pathName === "/relay") {
        const body = (await readBody(req)) as RelayRequest;
        const record = await relayer.relay(body);
        write(res, 200, record);
        return finish(200);
      }

      const statusMatch = pathName.match(/^\/status\/(0x[0-9a-fA-F]{1,64})$/);
      if (req.method === "GET" && statusMatch) {
        const record = relayer.status(statusMatch[1]);
        if (!record) {
          write(res, 404, { error: "ERR_NOT_FOUND", nullifier: statusMatch[1] });
          return finish(404);
        }
        write(res, 200, record);
        return finish(200);
      }

      write(res, 404, { error: "ERR_NOT_FOUND" });
      finish(404);
    } catch (err) {
      if (isRelayerError(err)) {
        const status = ERROR_STATUS[(err as RelayerError).name] ?? 500;
        write(res, status, { error: (err as RelayerError).name, detail: status < 500 ? (err as Error).message : undefined });
        return finish(status);
      }
      if (err instanceof SyntaxError) {
        write(res, 400, { error: "ERR_BAD_REQUEST", detail: "malformed JSON body" });
        return finish(400);
      }
      log(`unhandled error on ${req.method} ${pathName}: ${(err as Error).message}`);
      write(res, 500, { error: "ERR_INTERNAL" });
      finish(500);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            (server as { closeAllConnections?: () => void }).closeAllConnections?.();
            server.close(() => done());
          })
      });
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new RelayerError("ERR_BAD_REQUEST", "body exceeds 64 KiB"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export { RELAYER_ERRORS };
