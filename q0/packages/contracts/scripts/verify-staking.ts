/**
 * Proves the deployed QUAI liquid-staking contracts were built from the sources in contracts/staking, and collects what
 * an explorer needs to show that source.
 *
 *   pnpm --filter contracts compile && pnpm --filter contracts verify:staking
 *
 * For the vault, stQUAI and the Dante strategy in deployments/mainnet.dante-staking.json it reads the runtime code from
 * Cyprus-1 and compares it with the compile byte for byte, masking only the compiler's immutable slots; the values found
 * in those slots are then checked against the deployment record. The metadata hash at the end of the code covers every
 * source file, so a match means these exact sources. Exit code 2 if anything differs.
 *
 * Writes deployments/verification/cyprus1-staking/: the standard-JSON compiler input and a manifest (address, contract,
 * ABI-encoded constructor arguments, compiler settings). Nothing is sent anywhere: upload them to the explorer yourself.
 * On Quai a creation transaction's input ends in a 4-byte salt ground to land the address in Cyprus-1; it is not a
 * constructor argument, which is why the arguments are written out here rather than left to the explorer to detect.
 */
import * as fs from "fs";
import * as path from "path";
import { AbiCoder, getAddress } from "ethers";

const ROOT = path.resolve(__dirname, "..");
const RPC = "https://rpc.quai.network/cyprus1";
const RECORD = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments/mainnet.dante-staking.json"), "utf8"));
const OUT = path.join(ROOT, "deployments/verification/cyprus1-staking");

async function rpc(method: string, params: unknown[]): Promise<any> {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const json: any = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error.message}`);
    return json.result;
}

function buildInfoFor(source: string): any {
    const dir = path.join(ROOT, "artifacts/build-info");
    for (const file of fs.readdirSync(dir)) {
        const info = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        if (info.output?.contracts?.[source]) return info;
    }
    throw new Error(`No compile output for ${source}: run pnpm --filter contracts compile first.`);
}

/** AST id -> name of each state variable, to label immutable slots. */
function variableNames(info: any): Map<number, string> {
    const names = new Map<number, string>();
    const walk = (n: any) => {
        if (!n || typeof n !== "object") return;
        if (n.nodeType === "VariableDeclaration" && typeof n.id === "number") names.set(n.id, n.name);
        for (const v of Object.values(n)) walk(v);
    };
    for (const s of Object.values<any>(info.output.sources)) walk(s.ast);
    return names;
}

const coder = AbiCoder.defaultAbiCoder();
const addressWord = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const uintWord = (n: bigint | string | number) => "0x" + BigInt(n).toString(16).padStart(64, "0");

const ITEMS = [
    {
        label: "QUAI liquid-staking vault",
        address: RECORD.liquidStaking,
        source: "contracts/staking/QuaiLiquidStaking.sol",
        name: "QuaiLiquidStaking",
        constructorArgs: coder.encode(["address", "address", "uint64", "address"], [RECORD.wquai, RECORD.strategy, RECORD.withdrawalDelaySeconds, RECORD.owner]),
        immutables: { WQUAI: addressWord(RECORD.wquai), strategy: addressWord(RECORD.strategy), stQUAI: addressWord(RECORD.stquai), withdrawalDelay: uintWord(RECORD.withdrawalDelaySeconds) }
    },
    {
        label: "stQUAI receipt token (created by the vault's constructor)",
        address: RECORD.stquai,
        source: "contracts/staking/StQuai.sol",
        name: "StQuai",
        constructorArgs: coder.encode(["address"], [RECORD.liquidStaking]),
        immutables: { vault: addressWord(RECORD.liquidStaking), _cachedThis: addressWord(RECORD.stquai), _cachedChainId: uintWord(RECORD.chainId) }
    },
    {
        label: "Dante QUAI revenue strategy",
        address: RECORD.strategy,
        source: "contracts/staking/DanteQuaiStrategy.sol",
        name: "DanteQuaiStrategy",
        constructorArgs: coder.encode(["address", "address", "address"], [RECORD.wquai, RECORD.deployer, RECORD.facilitator]),
        immutables: { WQUAI: addressWord(RECORD.wquai) }
    }
];

async function main() {
    let ok = true;
    const manifest: any[] = [];
    let input: any = null;
    for (const item of ITEMS) {
        const info = buildInfoFor(item.source);
        input = info.input;
        const compiled = info.output.contracts[item.source][item.name].evm.deployedBytecode;
        const names = variableNames(info);
        const onChain: string = (await rpc("quai_getCode", [getAddress(item.address), "latest"])).slice(2);
        const want = compiled.object.split("");
        const got = onChain.split("");
        const problems: string[] = [];
        for (const [id, locations] of Object.entries<any>(compiled.immutableReferences ?? {})) {
            const name = names.get(Number(id)) ?? `#${id}`;
            for (const { start, length } of locations) {
                const value = "0x" + onChain.slice(start * 2, (start + length) * 2);
                const expected = (item.immutables as Record<string, string>)[name];
                if (expected && value !== expected) problems.push(`immutable ${name} is ${value}, expected ${expected}`);
                for (let i = start * 2; i < (start + length) * 2; i++) want[i] = got[i] = "0";
            }
        }
        if (onChain.length !== compiled.object.length) problems.push(`${onChain.length / 2} bytes on chain, ${compiled.object.length / 2} compiled`);
        else if (want.join("") !== got.join("")) problems.push("code differs outside the immutable slots");
        ok &&= problems.length === 0;
        console.log(`${problems.length ? "MISMATCH" : "MATCH   "} ${item.name} ${item.address}${problems.length ? "\n  - " + problems.join("\n  - ") : ""}`);
        manifest.push({
            label: item.label,
            address: item.address,
            contract: `${item.source}:${item.name}`,
            constructorArgs: item.constructorArgs,
            compiler: `v${info.solcLongVersion}`,
            settings: { optimizer: info.input.settings.optimizer, viaIR: info.input.settings.viaIR, evmVersion: info.input.settings.evmVersion },
            license: "MIT",
            codeMatchesCompile: problems.length === 0
        });
    }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "standard-input.json"), JSON.stringify(input));
    fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`\nWrote ${path.relative(ROOT, OUT)}/standard-input.json and manifest.json`);
    if (!ok) process.exit(2);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
