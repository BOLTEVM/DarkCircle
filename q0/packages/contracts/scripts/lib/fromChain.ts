/**
 * Rebuilds a deployment record for source verification from what is on Cyprus-1, for a deployment that has no
 * `deployments/<network>.amm.json` (this one was deployed from the browser). Read-only: no key, nothing sent.
 *
 * Every address is READ from the chain, never trusted from a file: the factory proxy's implementation comes from the
 * EIP-1967 slot, the timelock is the factory's owner, the pool beacon is the factory's, the pool implementation is the
 * beacon's. The transaction that created each contract comes from the explorer's index and is cross-checked against the
 * node (the receipt must name the same contract address), and the constructor arguments are cut out of that
 * transaction's input, not guessed.
 *
 * Whether each contract's code is the compiled contract is decided here too, by the same normalised hash the
 * integrity inspector uses (immutables zeroed, metadata trailer dropped), so a bundle never claims a match it has not
 * checked.
 */
import { getAddress } from "quais";
import { AbiCoder, Interface } from "ethers";
import { loadArtifact, loadImmutableRanges } from "./artifacts";
import { normalizedCodeHash } from "../../../quai-service/src/codeHash";
import { EIP1967_IMPLEMENTATION_SLOT } from "../../../quai-service/src/eip1967";

export interface ChainReader {
    call(to: string, data: string): Promise<string>;
    getCode(address: string): Promise<string>;
    getStorageAt(address: string, slot: string): Promise<string>;
    getTransaction(hash: string): Promise<{ input: string; from: string; blockNumber: string } | null>;
    getReceipt(hash: string): Promise<{ contractAddress?: string | null; status?: string } | null>;
}

export interface CreationInfo {
    txHash: string;
    block: number | null;
    creator: string | null;
    /** TOP_LEVEL_CREATE for a contract made by a transaction; anything else was made by another contract. */
    kind: string | null;
}

export type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export function jsonRpcReader(rpcUrl: string, fetchImpl: FetchLike = fetch as any): ChainReader {
    let id = 0;
    const send = async (method: string, params: unknown[]) => {
        const res = await fetchImpl(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
            signal: AbortSignal.timeout(30_000)
        });
        if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(`RPC ${method}: ${json.error.message}`);
        return json.result;
    };
    // quai_getCode / quai_getStorageAt reject a lower-case address ("invalid checksum"), quai_call accepts either.
    return {
        call: (to, data) => send("quai_call", [{ to: getAddress(to), data }, "latest"]),
        getCode: a => send("quai_getCode", [getAddress(a), "latest"]),
        getStorageAt: (a, slot) => send("quai_getStorageAt", [getAddress(a), slot, "latest"]),
        getTransaction: h => send("quai_getTransactionByHash", [h]),
        getReceipt: h => send("quai_getTransactionReceipt", [h])
    };
}

/** Where the explorer says a contract was created. Null when it has no record (it is an index, not the chain). */
export async function explorerCreation(address: string, fetchImpl: FetchLike = fetch as any, base = "https://explorer.qu.ai"): Promise<CreationInfo | null> {
    const res = await fetchImpl(`${base}/api/contract/${address.toLowerCase()}`, { signal: AbortSignal.timeout(30_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`explorer /api/contract/${address}: HTTP ${res.status}`);
    const c = (await res.json())?.contract;
    const txHash = c?.created_at_tx ?? c?.deployment?.tx_hash;
    if (!c || typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
    const block = Number(c.created_at_block ?? c.deployment?.block_height);
    return {
        txHash,
        block: Number.isFinite(block) ? block : null,
        creator: typeof c.creator_address === "string" ? c.creator_address : null,
        kind: c.deployment?.creation_kind ?? null
    };
}

/**
 * The constructor arguments inside a creation transaction's input. On Quai the input is
 *   creation bytecode | ABI-encoded constructor arguments | 4-byte salt
 * and the salt is not an argument. Null when the input does not start with the compiled creation bytecode (the local
 * compile is then not what was deployed, which the caller reports instead of guessing a split).
 */
export function constructorArgsOf(input: string, creationBytecode: string): string | null {
    const have = input.toLowerCase();
    const code = creationBytecode.toLowerCase();
    if (!have.startsWith(code)) return null;
    const tail = have.slice(code.length);
    if (tail.length < 8 || (tail.length - 8) % 64 !== 0) return null;
    return "0x" + tail.slice(0, tail.length - 8);
}

const wordAddress = (hex: string) => getAddress("0x" + hex.replace(/^0x/, "").padStart(64, "0").slice(-40));
const isZeroWord = (hex: string) => !/[1-9a-f]/i.test(hex.replace(/^0x/, ""));

export interface ChainItem {
    label: string;
    /** Artifact (contract) name used to compile it. */
    name: string;
    address: string;
    constructorArgs: string;
    creationTx?: string;
    creationBlock?: number | null;
    note?: string;
    /** Did the code on chain equal the compiled `name`? Hash with immutables zeroed and metadata dropped. */
    codeMatchesCompiled: boolean;
    onChainCodeHash?: string;
    /** Problems found while reconstructing this item (an unchecked claim is reported, never smoothed over). */
    problems: string[];
}

export interface ChainDeployment {
    network: string;
    chainId: string;
    contracts: Record<string, string | undefined>;
    owner?: string;
    items: ChainItem[];
}

export interface FromChainInput {
    network: string;
    chainId: bigint;
    factory: string;
    router?: string | null;
    farm?: string | null;
    qrb?: string | null;
    qrbNft?: string | null;
}

/** Everything that did not come from a creation transaction of its own. */
const INTERNAL_NOTE = "Created inside another contract's transaction (the factory proxy's initialize call); it has no creation transaction of its own.";

export async function reconstructFromChain(reader: ChainReader, input: FromChainInput, fetchImpl: FetchLike = fetch as any): Promise<ChainDeployment> {
    const items: ChainItem[] = [];
    const contracts: Record<string, string | undefined> = {};

    const view = async (name: string, to: string, fn: string, args: unknown[] = []) => {
        const iface = new Interface(loadArtifact(name).abi);
        const out = await reader.call(to, iface.encodeFunctionData(fn, args));
        const decoded = iface.decodeFunctionResult(fn, out);
        return decoded.length === 1 ? decoded[0] : decoded;
    };
    const implementationOf = async (proxy: string): Promise<string | null> => {
        const word = await reader.getStorageAt(proxy, EIP1967_IMPLEMENTATION_SLOT);
        return !word || isZeroWord(word) ? null : wordAddress(word);
    };

    /** Adds one contract: code comparison, creation transaction, constructor arguments, every problem recorded. */
    const addItem = async (
        label: string,
        name: string,
        address: string,
        o: { derivedArgs?: string; creationOf?: string; note?: string } = {}
    ) => {
        const problems: string[] = [];
        const art = loadArtifact(name);
        let codeMatchesCompiled = false;
        let onChainCodeHash: string | undefined;
        try {
            const code = await reader.getCode(address);
            if (!code || code === "0x") problems.push("no code at this address");
            else {
                const ranges = loadImmutableRanges(name);
                onChainCodeHash = normalizedCodeHash(code, ranges);
                const want = normalizedCodeHash(art.deployedBytecode, ranges);
                codeMatchesCompiled = onChainCodeHash === want;
                if (!codeMatchesCompiled) problems.push(`on-chain code is not the local compile of ${name} (hash ${onChainCodeHash}, compiled ${want})`);
            }
        } catch (e: any) {
            problems.push(`code could not be read: ${e.message}`);
        }

        let creationTx: string | undefined;
        let creationBlock: number | null | undefined;
        let constructorArgs = o.derivedArgs ?? "0x";
        try {
            const info = await explorerCreation(o.creationOf ?? address, fetchImpl);
            if (!info) problems.push("the explorer has no creation record for this address");
            else {
                creationTx = info.txHash;
                creationBlock = info.block;
                if (!o.derivedArgs) {
                    const tx = await reader.getTransaction(info.txHash);
                    const receipt = await reader.getReceipt(info.txHash);
                    if (!tx || !receipt) problems.push(`creation transaction ${info.txHash} was not found on the node`);
                    else {
                        if (receipt.status !== "0x1") problems.push("the creation transaction did not succeed");
                        // the node, not the explorer's index, decides which contract this transaction made
                        if (!receipt.contractAddress || receipt.contractAddress.toLowerCase() !== address.toLowerCase()) {
                            problems.push(`the node says that transaction created ${receipt.contractAddress ?? "no contract"}, not ${address}`);
                        } else {
                            const args = constructorArgsOf(tx.input, art.bytecode);
                            if (args === null) {
                                problems.push(
                                    `the creation input does not start with the local compile of ${name} ` +
                                        `(${(tx.input.length - 2) / 2} bytes in the transaction, ${(art.bytecode.length - 2) / 2} compiled): constructor arguments could not be cut out`
                                );
                            } else constructorArgs = args;
                        }
                    }
                }
            }
        } catch (e: any) {
            problems.push(`creation lookup failed: ${e.message}`);
        }
        items.push({ label, name, address, constructorArgs, creationTx, creationBlock, note: o.note, codeMatchesCompiled, onChainCodeHash, problems });
    };

    // ---- the AMM: addresses come from the proxies, owners and beacons, not from a file --------------------------
    const factory = getAddress(input.factory);
    contracts.factory = factory;
    const factoryImpl = await implementationOf(factory);
    const owner = (await view("CircleswapFactory", factory, "owner")) as string;
    const beacon = (await view("CircleswapFactory", factory, "pairBeacon")) as string;
    const pairImpl = (await view("UpgradeableBeacon", beacon, "implementation")) as string;
    contracts.timelock = owner;
    contracts.factoryImplementation = factoryImpl ?? undefined;
    contracts.pairBeacon = beacon;
    contracts.pairImplementation = pairImpl;

    await addItem("Timelock", "CircleswapTimelock", owner);
    if (factoryImpl) await addItem("Factory implementation", "CircleswapFactory", factoryImpl);
    await addItem("Factory proxy", "ERC1967Proxy", factory);

    if (input.router) {
        const router = getAddress(input.router);
        contracts.router = router;
        const routerImpl = await implementationOf(router);
        contracts.routerImplementation = routerImpl ?? undefined;
        if (routerImpl) await addItem("Router implementation", "CircleswapRouter", routerImpl);
        await addItem("Router proxy", "ERC1967Proxy", router);
    }

    // The beacon and the pool implementation are made by the factory proxy's initialize(): same transaction.
    // new UpgradeableBeacon(poolImplementation, factory): both arguments are read back above.
    await addItem("Pool beacon", "UpgradeableBeacon", beacon, {
        derivedArgs: AbiCoder.defaultAbiCoder().encode(["address", "address"], [pairImpl, factory]),
        creationOf: factory,
        note: INTERNAL_NOTE
    });
    await addItem("Pool implementation", "CircleswapPair", pairImpl, { derivedArgs: "0x", creationOf: factory, note: INTERNAL_NOTE });

    // ---- the farm and its boost token / NFT ---------------------------------------------------------------------
    if (input.farm) await addItem("Farm (MasterChef)", "CircleswapMasterChef", getAddress(input.farm));
    if (input.qrb) await addItem("Qrb token", "Qrb", getAddress(input.qrb));
    if (input.qrbNft) await addItem("Qrb artifact NFT", "QrbArtifactNFT", getAddress(input.qrbNft));

    return { network: input.network, chainId: input.chainId.toString(), contracts, owner, items };
}
