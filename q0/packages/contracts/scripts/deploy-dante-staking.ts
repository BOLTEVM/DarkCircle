/**
 * Deploy the QUAI liquid-staking vault (QuaiLiquidStaking + StQuAI + DanteQuaiStrategy)
 * to a live Quai network through a node-side signing key — the same runner the browser
 * modal uses, with the same simulate-before-sign and receipt-verified-address rules.
 *
 *   npx hardhat run scripts/deploy-dante-staking.ts -- --net mainnet|orchard \
 *     --wquai 0x... --owner 0x... --facilitator 0x... [--delay 86400] [--seed 1000000000000] [--broadcast]
 *
 * Default is a DRY RUN: every step is quoted against the live node and the worst-case
 * cost is printed; nothing is signed. Pass --broadcast to send.
 *
 * The signing key comes from QUAI_PRIVATE_KEY (env) only, is never printed, and is not
 * written anywhere. Progress is kept in deployments/<network>.dante-staking.progress.json
 * so an interrupted broadcast resumes by re-verifying the chain, never redeploying.
 */
import * as fs from "fs";
import * as path from "path";
import { Wallet, JsonRpcProvider, QuaiTransaction, getAddress } from "quais";
import {
    liquidStakingFlow,
    runFlow,
    quoteStep,
    emptyProgress,
    loadProgress,
    saveProgress,
    projectCreationGas,
    creationBytes,
    depositedBytes,
    creationGasLimit,
    type RunnerEnv,
    type FlowHooks,
    type DeployStep,
} from "../../quai-service/src/deploy";

const ROOT = path.resolve(__dirname, "..");

const NETWORKS: Record<string, { chainId: number; rpc: string }> = {
    mainnet: { chainId: 9, rpc: "https://rpc.quai.network/cyprus1" },
    orchard: { chainId: 15000, rpc: "https://orchard.rpc.quai.network/cyprus1" },
};

// ── args ──
function parseArgs(argv: string[]) {
    const a: Record<string, string | boolean> = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("--")) {
            const k = argv[i].slice(2);
            const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
            a[k] = v;
        }
    }
    return a;
}
const args = parseArgs(process.argv.slice(2));
const netName = String(args.net ?? "mainnet");
const net = NETWORKS[netName];
if (!net) throw new Error(`--net mainnet|orchard (got "${netName}")`);
const WQUAI = args.wquai ? getAddress(String(args.wquai)) : null;
const OWNER = args.owner ? getAddress(String(args.owner)) : null;
const FACILITATOR = args.facilitator ? getAddress(String(args.facilitator)) : null;
const DELAY = BigInt(String(args.delay ?? "86400"));
const SEED = BigInt(String(args.seed ?? "1000000000000"));
const BROADCAST = args.broadcast === true;

if (!WQUAI) throw new Error("--wquai is required (the network's wrapped-QUAI contract)");
if (!OWNER) throw new Error("--owner is required (production owner; use a multisig, not an EOA)");
if (!FACILITATOR) throw new Error("--facilitator is required (the Dante key that funds strategy revenue)");

// ── key ──
const PK = (process.env.QUAI_PRIVATE_KEY ?? "").trim();
if (BROADCAST && !/^0x[0-9a-fA-F]{64}$/.test(PK)) {
    throw new Error("QUAI_PRIVATE_KEY (64 hex chars) is required for --broadcast");
}

const provider = new JsonRpcProvider(net.rpc, undefined, { usePathing: true });
const wallet = PK ? new Wallet(PK).connect(provider) : null;
const FROM = wallet ? getAddress(wallet.address) : getAddress(String(args.from ?? "0x0000000000000000000000000000000000000000"));
if (!wallet && BROADCAST) throw new Error("unreachable");

// ── JSON-RPC over fetch (Cloudflare filters by UA; node fetch passes) ──
const rpc: RunnerEnv["rpc"] = async (method, params) => {
    const res = await fetch(net.rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body: any = await res.json();
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
};

// ── file-backed progress store ──
const progressPath = path.join(ROOT, "deployments", `${netName}.dante-staking.progress.json`);
const store = (() => {
    let map: Record<string, string> = {};
    if (fs.existsSync(progressPath)) {
        try { map = JSON.parse(fs.readFileSync(progressPath, "utf8")); } catch { map = {}; }
    }
    return {
        getItem: (k: string) => (k in map ? map[k] : null),
        setItem: (k: string, v: string) => { map[k] = v; fs.mkdirSync(path.dirname(progressPath), { recursive: true }); fs.writeFileSync(progressPath, JSON.stringify(map, null, 2)); },
        removeItem: (k: string) => { delete map[k]; fs.writeFileSync(progressPath, JSON.stringify(map, null, 2)); },
    };
})();

// ── wallet adapter: EIP-1193 request() over a quais Wallet ──
const walletLike: RunnerEnv["wallet"] = {
    request: async ({ method, params }: { method: string; params?: any[] }) => {
        if (!wallet) throw new Error("no key loaded (dry run)");
        if (method !== "quai_sendTransaction" && method !== "eth_sendTransaction") {
            throw new Error(`wallet adapter: unsupported method ${method}`);
        }
        const p = (params ?? [])[0];
        const pop = await wallet.populateQuaiTransaction({
            from: FROM,
            ...(p.to ? { to: getAddress(p.to) } : {}),
            data: p.data,
            gasLimit: BigInt(p.gas),
            value: BigInt(p.value ?? 0),
            ...(p.nonce !== undefined ? { nonce: Number(BigInt(p.nonce)) } : {}),
        });
        const signed = await wallet.signTransaction(QuaiTransaction.from(pop));
        const zone = await wallet.zoneFromAddress(FROM);
        const resp = await (wallet.provider as any).broadcastTransaction(zone, signed, FROM);
        return resp.hash;
    },
};

async function main() {
    const flow = liquidStakingFlow({
        owner: OWNER!,
        wquai: WQUAI!,
        dante: { facilitator: FACILITATOR!, initialOwner: FROM },
        withdrawalDelaySeconds: DELAY,
        seed: SEED,
    });

    const env: RunnerEnv = {
        rpc,
        wallet: walletLike,
        from: FROM,
        chainId: net.chainId,
        confirmations: 2,
        store,
    };

    let progress = loadProgress(store, flow.id, net.chainId, FROM);
    if (!progress) progress = emptyProgress(flow.id, net.chainId, FROM, {}, `${OWNER}|${WQUAI}|${FACILITATOR}|${DELAY}|${SEED}`);

    if (!BROADCAST) {
        const bal = BigInt(await rpc("quai_getBalance", [FROM, "latest"]));
        console.log(`DRY RUN on ${netName} (chain ${net.chainId})  deployer ${FROM}  balance ${(bal / 10n ** 18n).toString()} QUAI`);
        console.log(`  owner ${OWNER}\n  facilitator ${FACILITATOR}\n  wquai ${WQUAI}\n  delay ${DELAY}s  seed ${SEED} wei`);
        let worst = 0n;
        const ctx: Record<string, string> = {};
        // baseline for projecting not-yet-simulatable creations: first quoted creation
        let baseline: { estimate: bigint; bytes: number } | null = null;
        const gasPrice = BigInt(await rpc("quai_gasPrice", []));
        const q4 = (wei: bigint) => `${(wei / 10n ** 18n).toString()}.${(wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 4)}`;
        for (const step of flow.steps) {
            let line: string;
            try {
                const quote = await quoteStep(env, step, ctx as any);
                if (step.kind === "create" && !baseline) baseline = { estimate: quote.gasEstimate, bytes: creationBytes(step) };
                worst += quote.maxFee + (quote.value ?? 0n);
                line = `gas limit ${quote.gasLimit}  max ${q4(quote.maxFee)} QUAI${quote.value ? ` + ${quote.value} wei value` : ""}`;
            } catch (e: any) {
                // depends on an address an earlier step will create — project offline
                if (step.kind === "create" && baseline) {
                    const projected = projectCreationGas(baseline.estimate, baseline.bytes, creationBytes(step));
                    const gasLimit = creationGasLimit(projected, depositedBytes(step), creationBytes(step));
                    const maxFee = gasLimit * gasPrice;
                    worst += maxFee + (step.value?.(ctx as any) ?? 0n);
                    line = `gas limit ${gasLimit}  max ${q4(maxFee)} QUAI (projected)`;
                } else if (step.kind === "call") {
                    const gasLimit = 540_000n; // conservative bound for a small owner-only call
                    const maxFee = gasLimit * gasPrice;
                    worst += maxFee;
                    line = `gas limit ${gasLimit}  max ${q4(maxFee)} QUAI (fixed bound)`;
                } else {
                    throw e;
                }
            }
            console.log(`  ${step.label}: ${line}`);
        }
        worst += SEED; // the vault seed travels with the creation
        console.log(`  worst-case spend: ${q4(worst)} QUAI (incl. ${SEED} wei seed)${worst > bal ? "  — DEPLOYER UNDERFUNDED" : ""}`);
        console.log("  pass --broadcast (with QUAI_PRIVATE_KEY) to deploy");
        return;
    }

    const hooks: FlowHooks = {
        onStatus: (stepId, status, info) => {
            console.log(`  [${stepId}] ${status}${info?.txHash ? ` tx=${info.txHash}` : ""}${info?.address ? ` addr=${info.address}` : ""}${info?.error ? ` ERR ${info.error}` : ""}`);
        },
    };

    progress = await runFlow(env, flow, progress, hooks);
    saveProgress(store, progress);

    const out = {
        network: netName,
        chainId: net.chainId,
        deployedAt: new Date().toISOString(),
        deployer: FROM,
        owner: OWNER,
        facilitator: FACILITATOR,
        wquai: WQUAI,
        withdrawalDelaySeconds: DELAY.toString(),
        seed: SEED.toString(),
        strategy: progress.ctx.DANTE_STRATEGY ?? null,
        liquidStaking: progress.ctx.LIQUID_STAKING ?? null,
        stquai: progress.ctx.STQUAI ?? null,
        steps: progress.steps,
    };
    const outPath = path.join(ROOT, "deployments", `${netName}.dante-staking.json`);
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`\nwrote ${outPath}`);
    console.log(`strategy:     ${out.strategy}`);
    console.log(`liquidStaking:${out.liquidStaking}`);
    console.log(`stquai:       ${out.stquai}`);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
