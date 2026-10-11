/**
 * DarkCircle agent: HTTP routes
 * File: src/agent/routes.ts
 *
 * The voice agent's part of the local API (src/api/server.ts mounts it behind the same loopback, Host, Origin,
 * session-token and CSP rules as everything else). These routes never touch the simulated environment: the
 * agent works on the real Quai network through the user's wallet.
 *
 *   GET  /api/agent/state                    book, limits, recent activity, speech status
 *   POST /api/agent/say       {text, network, wallet}       one turn: answer, refusal or plan
 *   POST /api/agent/confirm   {planId, code, wallet}         step 2: returns the plan to sign
 *   POST /api/agent/cancel    {planId}
 *   POST /api/agent/report    {planId, index, txHash}        step 4: pending | verified | done | paid | failed
 *   POST /api/agent/collect   {planId}                       a paid purchase: fetch the resource
 *   POST /api/agent/contacts  {action: add|remove, name, address}
 *   POST /api/agent/services  {action: add|remove, name, url, maxAmount, asset}
 *   POST /api/agent/policy    {perAction, daily}
 *   POST /api/voice/transcribe   raw audio (audio/webm, ogg, wav, mp4, mpeg) -> {text}
 */

import type { QuaiNetwork } from "../quai/networks.ts";
import { AGENT_NETWORKS, VoiceAgent, type WalletInfo } from "./agent.ts";
import { Refusal } from "./planner.ts";
import { MAX_AUDIO_BYTES, type LocalTranscriber } from "../voice/transcriber.ts";

export interface AgentRouteResult {
  status: number;
  body: unknown;
}

export class AgentRouteError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const str = (v: unknown, max = 300): string => {
  if (typeof v !== "string" || v.length > max) throw new AgentRouteError(400, "BAD_REQUEST", "invalid field");
  return v;
};

function network(v: unknown): QuaiNetwork {
  const id = v === undefined ? AGENT_NETWORKS[0].id : str(v, 40);
  const n = AGENT_NETWORKS.find((x) => x.id === id);
  if (!n) throw new AgentRouteError(400, "BAD_REQUEST", `network must be one of ${AGENT_NETWORKS.map((x) => x.id).join(", ")}`);
  return n;
}

function wallet(v: unknown): WalletInfo | undefined {
  if (v === undefined || v === null) return undefined;
  const w = v as { address?: unknown; chainId?: unknown };
  const address = str(w.address, 64);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new AgentRouteError(400, "BAD_REQUEST", "wallet.address is not an address");
  const chainId = Number(w.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new AgentRouteError(400, "BAD_REQUEST", "wallet.chainId is not a chain id");
  return { address, chainId };
}

/** Maps what the agent throws to HTTP: a refusal is a reasoned 422, a validation error a 400. */
function asHttp(err: unknown): never {
  if (err instanceof AgentRouteError) throw err;
  if (err instanceof Refusal) throw new AgentRouteError(422, err.code, err.message);
  const m = (err as Error).message ?? String(err);
  const code = /^ERR_([A-Z0-9_]+)/.exec(m)?.[1];
  if (code) throw new AgentRouteError(code.startsWith("VOICE") || code.startsWith("TRANSCRIBE") ? 503 : 400, code, m.replace(/^ERR_[A-Z0-9_]+:\s*/, ""));
  throw err;
}

export function agentState(agent: VoiceAgent, transcriber: LocalTranscriber | null) {
  return {
    networks: AGENT_NETWORKS.map((n) => ({ id: n.id, title: n.title, chainId: n.chainId, testnet: n.testnet, explorerUrl: n.explorerUrl, zonePrefix: "0x" + n.zone.byte })),
    contacts: agent.book.listContacts(),
    services: agent.book.listServices(),
    policy: agent.book.getPolicy(),
    persistent: agent.book.persistent,
    activity: agent.book.recentActivity(40),
    voice: transcriber ? transcriber.status() : { state: "unavailable", reason: "speech-to-text is not configured on this server" }
  };
}

export async function handleAgentRoute(route: string, body: any, query: URLSearchParams, agent: VoiceAgent, transcriber: LocalTranscriber | null): Promise<AgentRouteResult> {
  try {
    switch (route) {
      case "GET /api/agent/state":
        return { status: 200, body: agentState(agent, transcriber) };
      case "GET /api/voice/status":
        return { status: 200, body: transcriber ? transcriber.status() : { state: "unavailable" } };
      case "POST /api/agent/say":
        return { status: 200, body: await agent.say(str(body?.text, 300), { network: network(body?.network), wallet: wallet(body?.wallet) }) };
      case "POST /api/agent/confirm":
        return { status: 200, body: { plan: agent.confirm(str(body?.planId, 40), body?.code === undefined ? undefined : str(String(body.code), 6), wallet(body?.wallet)) } };
      case "POST /api/agent/cancel":
        return { status: 200, body: agent.cancel(str(body?.planId, 40)) };
      case "POST /api/agent/report": {
        const index = body?.index === undefined ? 0 : Number(body.index);
        return { status: 200, body: await agent.report(str(body?.planId, 40), index, str(body?.txHash, 80)) };
      }
      case "POST /api/agent/collect":
        return { status: 200, body: await agent.collect(str(body?.planId, 40)) };
      case "GET /api/agent/plan":
        return { status: 200, body: agent.plan(query.get("id") ?? "") };
      case "POST /api/agent/contacts": {
        const action = str(body?.action, 10);
        if (action === "add") agent.book.addContact(body?.name, body?.address);
        else if (action === "remove") {
          if (!agent.book.removeContact(str(body?.name, 60))) throw new AgentRouteError(404, "NOT_FOUND", "no such contact");
        } else throw new AgentRouteError(400, "BAD_REQUEST", "action must be add or remove");
        return { status: 200, body: { contacts: agent.book.listContacts() } };
      }
      case "POST /api/agent/services": {
        const action = str(body?.action, 10);
        if (action === "add") agent.book.addService(body?.name, body?.url, body?.maxAmount, body?.asset);
        else if (action === "remove") {
          if (!agent.book.removeService(str(body?.name, 60))) throw new AgentRouteError(404, "NOT_FOUND", "no such service");
        } else throw new AgentRouteError(400, "BAD_REQUEST", "action must be add or remove");
        return { status: 200, body: { services: agent.book.listServices() } };
      }
      case "POST /api/agent/policy":
        return { status: 200, body: { policy: agent.book.setPolicy({ perAction: body?.perAction, daily: body?.daily }) } };
      default:
        throw new AgentRouteError(404, "NOT_FOUND", "no such route");
    }
  } catch (err) {
    asHttp(err);
  }
}

/** POST /api/voice/transcribe: the recorded clip, as sent by the browser's MediaRecorder. */
export async function handleTranscribe(audio: Buffer, contentType: string, agent: VoiceAgent, transcriber: LocalTranscriber | null): Promise<AgentRouteResult> {
  if (!transcriber) throw new AgentRouteError(503, "VOICE_UNAVAILABLE", "speech-to-text is not configured on this server");
  if (audio.length > MAX_AUDIO_BYTES) throw new AgentRouteError(413, "AUDIO_TOO_LARGE", "keep a command under 30 seconds");
  try {
    const hints = [...agent.book.listContacts().map((c) => c.name), ...agent.book.listServices().map((s) => s.name)];
    const t = await transcriber.transcribe(audio, { mime: contentType, hints });
    return { status: 200, body: t };
  } catch (err) {
    asHttp(err);
  }
}
