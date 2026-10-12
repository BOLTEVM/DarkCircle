import { expect } from "chai";
import { constructorArgsOf, explorerCreation, type FetchLike } from "../scripts/lib/fromChain";

// verify:bundle --from-chain rebuilds a deployment record from the chain. The two pieces that can silently produce a
// wrong bundle are cutting constructor arguments out of a creation transaction and trusting the explorer's index.

const BYTECODE = "0x6080604052" + "ab".repeat(40);
const ARGS = "0x" + "00".repeat(12) + "11".repeat(20) + "00".repeat(31) + "05";
const SALT = "deadbeef";

describe("from-chain verification: constructor arguments", function () {
    it("cuts the arguments out of bytecode | args | salt, and drops the 4-byte salt", function () {
        const input = BYTECODE + ARGS.slice(2) + SALT;
        expect(constructorArgsOf(input, BYTECODE)).to.equal(ARGS);
    });

    it("returns 0x when the contract has no constructor arguments", function () {
        expect(constructorArgsOf(BYTECODE + SALT, BYTECODE)).to.equal("0x");
    });

    it("is case-insensitive about hex", function () {
        const input = (BYTECODE + ARGS.slice(2) + SALT).toUpperCase().replace("0X", "0x");
        expect(constructorArgsOf(input, BYTECODE)).to.equal(ARGS);
    });

    it("refuses an input that does not start with the local compile (a different build was deployed)", function () {
        const other = "0x6080604052" + "cd".repeat(40);
        expect(constructorArgsOf(other + ARGS.slice(2) + SALT, BYTECODE)).to.equal(null);
    });

    it("refuses a tail that is not whole 32-byte words plus the salt rather than guessing a split", function () {
        expect(constructorArgsOf(BYTECODE + "11".repeat(10) + SALT, BYTECODE)).to.equal(null);
        expect(constructorArgsOf(BYTECODE + "11", BYTECODE)).to.equal(null);
    });
});

describe("from-chain verification: explorer creation lookup", function () {
    const TX = "0x" + "ab".repeat(32);
    const reply = (status: number, body: unknown): FetchLike =>
        async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

    it("reads the creating transaction, block, creator and kind", async function () {
        const f = reply(200, {
            contract: { created_at_tx: TX, created_at_block: "10510549", creator_address: "0x005c", deployment: { creation_kind: "TOP_LEVEL_CREATE" } }
        });
        const info = await explorerCreation("0x0061bAC19852dfA0c4AF18d65FCaa9A585e14B86", f);
        expect(info).to.deep.equal({ txHash: TX, block: 10510549, creator: "0x005c", kind: "TOP_LEVEL_CREATE" });
    });

    it("asks for the lower-case address", async function () {
        let url = "";
        const f: FetchLike = async u => {
            url = u;
            return { ok: true, status: 200, json: async () => ({ contract: { created_at_tx: TX } }) };
        };
        await explorerCreation("0x0061bAC19852dfA0c4AF18d65FCaa9A585e14B86", f, "https://example.test");
        expect(url).to.equal("https://example.test/api/contract/0x0061bac19852dfa0c4af18d65fcaa9a585e14b86");
    });

    it("returns null for an address the explorer has no record of, instead of inventing one", async function () {
        expect(await explorerCreation("0x005c", reply(404, {}))).to.equal(null);
        expect(await explorerCreation("0x005c", reply(200, { contract: null }))).to.equal(null);
    });

    it("rejects a malformed transaction hash", async function () {
        expect(await explorerCreation("0x005c", reply(200, { contract: { created_at_tx: "0x1234" } }))).to.equal(null);
        expect(await explorerCreation("0x005c", reply(200, { contract: { created_at_tx: "not a hash" } }))).to.equal(null);
    });

    it("throws on a server error so a flaky index is not mistaken for 'not found'", async function () {
        let thrown: unknown = null;
        try {
            await explorerCreation("0x005c", reply(503, {}));
        } catch (e) {
            thrown = e;
        }
        expect(thrown).to.be.instanceOf(Error);
    });
});
