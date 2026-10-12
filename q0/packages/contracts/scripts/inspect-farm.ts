/**
 * Read-only inspection of the deployed farm (CircleswapMasterChef) and the contracts it is wired to. Needs no key and sends
 * nothing.
 *
 *   pnpm --filter contracts inspect:farm [--network cyprus1] [--farm <address>] [--json]
 *
 * What it answers:
 *   1. Is the code at each address exactly the compiled contract? (hash with immutables zeroed and the metadata trailer
 *      dropped, so a padded imitation does not pass.)
 *   2. Is the farm wired to the tokens and boost source the app expects?
 *   3. Who owns it, and is that a contract (multisig/timelock) or a single account?
 *   4. What pools exist, what is emitted, and how long does the reward inventory last?
 *   5. Does the app's static FARM_REGISTRY agree with the chain? (It must not be used to address pools.)
 *
 * Exit codes: 0 = nothing wrong, 2 = a code or wiring check FAILED (do not point users at this farm), 1 = could not run.
 */
import { getAddress } from "quais";
import { loadArtifact, loadImmutableRanges } from "./lib/artifacts";
import { NETWORKS, type NetworkName } from "./lib/quaiClient";
import { DEPLOYED } from "../../quai-service/src/registries/deployed";
import { TOKEN_REGISTRY } from "../../quai-service/src/registries/tokens";
import { FARM_REGISTRY } from "../../quai-service/src/registries/farms";
import { normalizedCodeHash } from "../../quai-service/src/codeHash";
import { batchQuaiCall } from "../../quai-service/src/tokenMetadata";
import {
    readFarmState,
    readPairs,
    runwaySeconds,
    ownerRisk,
    SECONDS_PER_DAY,
    type FarmState,
    type FarmBatch
} from "../../quai-service/src/farm";

type Status = "PASS" | "FAIL" | "WARN" | "INFO";
interface Finding {
    status: Status;
    title: string;
    detail?: string;
}

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : undefined;
}

async function rpc(url: string, method: string, params: unknown[]): Promise<any> {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(30_000)
    });
    if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
    const json: any = await res.json();
    if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
    return json.result;
}

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const same = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const fmt = (v: bigint, d = 18) => {
    const s = v.toString().padStart(d + 1, "0");
    const whole = s.slice(0, -d) || "0";
    const frac = s.slice(-d).replace(/0+$/, "").slice(0, 6);
    return frac ? `${whole}.${frac}` : whole;
};
const days = (s: number | null) => (s === null ? "never (no emission)" : s > 365 * SECONDS_PER_DAY ? "more than a year" : `${(s / SECONDS_PER_DAY).toFixed(1)} days`);

async function main() {
    const network = (arg("network") ?? "cyprus1") as NetworkName;
    if (!NETWORKS[network]) throw new Error(`Unknown network ${network}`);
    const rpcUrl = NETWORKS[network].rpc;
    const json = process.argv.includes("--json");
    const farmAddress = arg("farm") ?? DEPLOYED.MASTERCHEF;
    if (!farmAddress) throw new Error("No farm address: pass --farm <address> or set MASTERCHEF in deployed.ts.");

    const batch: FarmBatch = calls => batchQuaiCall(calls, { rpcUrl });
    const getCode = async (a: string): Promise<string> => rpc(rpcUrl, "quai_getCode", [getAddress(a), "latest"]);
    const findings: Finding[] = [];
    const add = (status: Status, title: string, detail?: string) => findings.push({ status, title, detail });

    // ---- 1. code, by hash --------------------------------------------------------------------------------------------
    const codeChecks: [string, string | null, string][] = [
        ["Farm", farmAddress, "CircleswapMasterChef"],
        ["Qrb", DEPLOYED.QRB, "Qrb"],
        ["Qrb NFT", DEPLOYED.QRB_NFT, "QrbArtifactNFT"]
    ];
    for (const [label, address, name] of codeChecks) {
        if (!address) { add("INFO", `${label}: not deployed (no address in deployed.ts)`); continue; }
        try {
            const art = loadArtifact(name);
            const immutables = loadImmutableRanges(name);
            const onChain = await getCode(address);
            if (!onChain || onChain === "0x") { add("FAIL", `${label}: no code at ${address}`); continue; }
            const wantBytes = (art.deployedBytecode.length - 2) / 2;
            const haveBytes = (onChain.length - 2) / 2;
            const want = normalizedCodeHash(art.deployedBytecode, immutables);
            const have = normalizedCodeHash(onChain, immutables);
            if (haveBytes !== wantBytes) add("FAIL", `${label} is not the compiled ${name}`, `${haveBytes} bytes on chain, ${wantBytes} compiled`);
            else if (have !== want) add("FAIL", `${label} is not the compiled ${name}`, `code hash ${have} != compiled ${want}`);
            else add("PASS", `${label} runs the compiled ${name}`, `${address}, ${haveBytes} bytes, hash ${have}`);
        } catch (e: any) {
            add("WARN", `${label}: could not check code`, e.message);
        }
    }

    // ---- 2-4. state ------------------------------------------------------------------------------------------------
    let farm: FarmState | null = null;
    try {
        farm = await readFarmState(batch, farmAddress);
    } catch (e: any) {
        add("FAIL", "The farm could not be read", e.message);
    }

    if (farm) {
        const wantA = TOKEN_REGISTRY.BDELTA.address;
        const wantB = TOKEN_REGISTRY.Q0.address;
        add(same(farm.rewardTokenA, wantA) ? "PASS" : "FAIL", "Reward token A is BDELTA", `${farm.rewardTokenA}${same(farm.rewardTokenA, wantA) ? "" : ` (expected ${wantA})`}`);
        add(same(farm.rewardTokenB, wantB) ? "PASS" : "FAIL", "Reward token B is Q0", `${farm.rewardTokenB}${same(farm.rewardTokenB, wantB) ? "" : ` (expected ${wantB})`}`);
        if (DEPLOYED.QRB) add(same(farm.qrb, DEPLOYED.QRB) ? "PASS" : "FAIL", "Boost source is the deployed Qrb", `${farm.qrb ?? "none"}${same(farm.qrb, DEPLOYED.QRB) ? "" : ` (expected ${DEPLOYED.QRB})`}`);
        add("INFO", "Not upgradeable", "A plain constructor contract: no proxy, reward tokens and boost source are immutable. Logic can never be changed; only pools, allocations, emissions and pause are owner-controlled.");

        const ownerCode = await getCode(farm.owner);
        const ownerIsContract = !!ownerCode && ownerCode !== "0x";
        const risk = ownerRisk(ownerIsContract);
        add(risk.level === "warning" ? "WARN" : "INFO", `Owner ${farm.owner}${ownerIsContract ? " (contract)" : " (single account)"}`, risk.message);
        if (DEPLOYED.AMM_FACTORY) {
            const ownerOfFactory = await batch([{ to: DEPLOYED.AMM_FACTORY, data: "0x8da5cb5b" }]);
            const timelock = ownerOfFactory[0] ? "0x" + ownerOfFactory[0].slice(26) : null;
            if (timelock && same(timelock, farm.owner)) add("PASS", "The farm is owned by the AMM timelock", timelock);
        }
        if (farm.pendingOwner) add("WARN", `Ownership transfer pending to ${farm.pendingOwner}`, "It completes only when that address calls acceptOwnership(). Until then the current owner keeps full control.");
        add(farm.paused ? "WARN" : "PASS", farm.paused ? "Deposits and harvests are PAUSED (withdrawals still work)" : "Not paused");

        add("INFO", "Emission", `${fmt(farm.rewardAPerSecond)} BDELTA/s (${fmt(farm.rewardAPerSecond * 86400n)}/day), ${fmt(farm.rewardBPerSecond)} Q0/s (${fmt(farm.rewardBPerSecond * 86400n)}/day)`);
        const boost = farm.boostBps;
        const runA = runwaySeconds(farm.inventoryA.available, farm.rewardAPerSecond, boost);
        const runB = runwaySeconds(farm.inventoryB.available, farm.rewardBPerSecond, boost);
        const funded = farm.inventoryA.available > 0n && farm.inventoryB.available > 0n;
        add(
            funded ? ((runA ?? Infinity) < 7 * SECONDS_PER_DAY || (runB ?? Infinity) < 7 * SECONDS_PER_DAY ? "WARN" : "PASS") : "WARN",
            funded ? "Reward inventory" : "The farm holds no rewards to pay out",
            `BDELTA available ${fmt(farm.inventoryA.available)} (lasts ${days(runA)}); Q0 available ${fmt(farm.inventoryB.available)} (lasts ${days(runB)}). Rewards are paid only from this inventory, never from stakers' tokens.`
        );

        if (farm.pools.length === 0) {
            add("WARN", "The farm has no pools", "Nobody can stake anything yet. Add pools from the admin dashboard (Farms & Pools -> Admin) or call addPool(allocPoint, lpToken) from the owner.");
        } else {
            const pairs = await readPairs(batch, farm.pools.map(p => p.lpToken));
            for (const p of farm.pools) {
                const pair = pairs[p.lpToken];
                const label = pair?.token0 ? `${short(pair.token0)} / ${short(pair.token1!)}` : "single asset";
                add("INFO", `Pool #${p.pid}: ${label}`, `stake token ${p.lpToken}, allocation ${p.allocPoint} (${p.sharePct}%), staked ${fmt(p.totalStaked)}`);
            }
        }
        // the app's fixed list must not be used to pick pool ids
        const registryDisagrees = FARM_REGISTRY.filter(r => !farm!.pools.some(p => p.pid === r.pid && p.lpToken === r.stakeToken.address.toLowerCase()));
        if (registryDisagrees.length) {
            add("WARN", `${registryDisagrees.length} of ${FARM_REGISTRY.length} entries in the app's static FARM_REGISTRY do not match the chain`, "Pool ids must be read from the farm (the Farms page does), never from the registry: " + registryDisagrees.map(r => `#${r.pid} ${r.name}`).join("; "));
        }
    }

    const failed = findings.some(f => f.status === "FAIL");
    if (json) {
        console.log(JSON.stringify({ network, farm: farmAddress, findings }, null, 2));
    } else {
        console.log(`Farm inspection (${network})  ${farmAddress}\n`);
        for (const f of findings) {
            console.log(`  [${f.status}] ${f.title}`);
            if (f.detail) console.log(`         ${f.detail}`);
        }
        console.log(`\n${failed ? "FAILED: do not point users at this farm until the failing checks are understood." : "No code or wiring check failed."}`);
    }
    process.exit(failed ? 2 : 0);
}

main().catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
});
