/**
 * DarkCircle production relayer: unit tests
 * File: test/unit/relayer.test.ts
 *
 * The chain layer (phase 2) against a scripted Quai node — no network. Covers quoting, the relay
 * path, idempotency (sequential and concurrent), the durable nonce record across a restart,
 * reconcile-on-start, confirmations, reorg handling and the operator off switch / gas floor.
 * The adversarial refuse set lives in test/adversarial/relayer_adversarial.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAddress } from "ethers";
import { QuaiRpcClient } from "../../src/quai/rpc.ts";
import { QUAI_ORCHARD_CYPRUS1 } from "../../src/quai/networks.ts";
import { DarkCircleRelayer, POOL_UNSHIELD_IFACE, type RelayerConfig } from "../../src/relayer/relayer.ts";
import { RelayStore } from "../../src/relayer/store.ts";
import { PermittedCallSigner, UNSHIELD_SELECTOR, WalletQuaiSigner } from "../../src/relayer/signer.ts";
import { isRelayerError, type RelayRequest } from "../../src/relayer/types.ts";
import { FakeQuaiNode } from "./relayerFakeNode.ts";

const PRIV = "0x" + "11".repeat(32);
const POOL = getAddress("0x0000000000000000000000000000000000000a11");
const TOKEN = getAddress("0x0000000000000000000000000000000000000b22");
const RECIPIENT = getAddress("0x00000000000000000000000000000000000d3905");
const OTHER = getAddress("0x0000000000000000000000000000000000000c33");
const ROOT = 12_345n;
const NULLIFIER = 777n;
const FEE = 100_000n; // gasPrice 1 × estimate 100000 × headroom 1 → quote is exactly this

function baseConfig(): RelayerConfig {
  return {
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
}

function makeRequest(over: { payment?: Partial<RelayRequest["payment"]>; token?: string; nullifier?: bigint } = {}): RelayRequest {
  return {
    token: over.token ?? TOKEN,
    proof: { a: ["1", "2"], b: [["3", "4"], ["5", "6"]], c: ["7", "8"] },
    payment: {
      root: "0x" + ROOT.toString(16),
      nullifier: "0x" + (over.nullifier ?? NULLIFIER).toString(16),
      changeCommitment: "0x0",
      recipient: RECIPIENT,
      amount: (5n * 10n ** 18n).toString(),
      relayer: signerAddress(),
      fee: FEE.toString(),
      ...(over.payment ?? {})
    }
  };
}

let signerAddr: string | undefined;
function signerAddress(): string {
  if (!signerAddr) signerAddr = WalletQuaiSigner.fromPrivateKey(PRIV).address;
  return signerAddr;
}

interface Harness {
  node: FakeQuaiNode;
  relayer: DarkCircleRelayer;
  store: RelayStore;
  logs: string[];
}

function makeHarness(storePath?: string, shared?: FakeQuaiNode): Harness {
  const node = shared ?? new FakeQuaiNode(POOL, signerAddress());
  node.knownRoots.add(ROOT.toString());
  const rpc = new QuaiRpcClient({ network: QUAI_ORCHARD_CYPRUS1, transport: node.transport });
  const store = new RelayStore(storePath);
  const logs: string[] = [];
  const relayer = new DarkCircleRelayer({
    rpc,
    signer: new PermittedCallSigner(WalletQuaiSigner.fromPrivateKey(PRIV), POOL),
    store,
    config: baseConfig(),
    log: (m) => logs.push(m)
  });
  return { node, relayer, store, logs };
}

describe("production relayer: chain layer", () => {
  describe("quoting", () => {
    it("quotes max(minFee, gas estimate × price × headroom) with an expiry block", async () => {
      const { relayer } = makeHarness();
      const q = await relayer.getQuote();
      assert.equal(q.relayer, signerAddress());
      assert.equal(q.feeToken, TOKEN);
      assert.equal(BigInt(q.estimatedFeeUnits), 100_000n);
      assert.equal(q.expiresAtBlock, q.quoteBlock + 12);
    });

    it("raises the quote when the gas price moves", async () => {
      const { relayer, node } = makeHarness();
      node.gasPrice = 3n;
      const q = await relayer.getQuote();
      assert.equal(BigInt(q.estimatedFeeUnits), 300_000n);
    });
  });

  describe("relay: happy path", () => {
    it("simulates, signs and broadcasts; the wire format decodes back to the same payment", async () => {
      const { relayer, node } = makeHarness();
      const rec = await relayer.relay(makeRequest());
      assert.equal(rec.status, "pending");
      assert.equal(rec.attempts, 1);
      assert.equal(node.sent.length, 1);

      const tx = node.sent[0];
      assert.equal(tx.to, POOL);
      assert.ok(tx.data.startsWith(UNSHIELD_SELECTOR));
      assert.equal(tx.chainId, 15000n);
      assert.equal(tx.nonce, 0n);
      assert.equal(tx.gas, 120_000n); // estimate 100000 + 20% buffer
      assert.equal(tx.from, signerAddress());

      // The calldata the relayer broadcast is exactly what DarkCirclePool.unshield accepts:
      // decode it with the pool's own interface and compare every payment field.
      const parsed = POOL_UNSHIELD_IFACE.parseTransaction({ data: tx.data });
      assert.ok(parsed, "the broadcast calldata must decode with the pool's own interface");
      const pay = parsed.args.pay as { root: bigint; nullifier: bigint; recipient: string; amount: bigint; relayer: string; fee: bigint };
      assert.equal(pay.root, ROOT);
      assert.equal(pay.nullifier, NULLIFIER);
      assert.equal(getAddress(pay.recipient), RECIPIENT);
      assert.equal(pay.amount, 5n * 10n ** 18n);
      assert.equal(getAddress(pay.relayer), signerAddress());
      assert.equal(pay.fee, FEE);
    });

    it("confirms after the required number of blocks", async () => {
      const { relayer, node } = makeHarness();
      const rec = await relayer.relay(makeRequest());
      node.mineBlocks(1);
      await relayer.sync();
      assert.equal(relayer.status(rec.nullifier)?.status, "pending");
      assert.equal(relayer.status(rec.nullifier)?.confirmations, 1);
      node.mineBlocks(1);
      await relayer.sync();
      const done = relayer.status(rec.nullifier);
      assert.equal(done?.status, "confirmed");
      assert.equal(done?.confirmations, 2);
    });
  });

  describe("idempotency and nonces", () => {
    it("a retried request returns the original transaction instead of sending a second", async () => {
      const { relayer, node } = makeHarness();
      const first = await relayer.relay(makeRequest());
      const second = await relayer.relay(makeRequest());
      assert.equal(node.sent.length, 1);
      assert.equal(second.txHash, first.txHash);
      assert.equal(second.attempts, 1);
    });

    it("concurrent double submit sends exactly one transaction", async () => {
      const { relayer, node } = makeHarness();
      const [a, b] = await Promise.all([relayer.relay(makeRequest()), relayer.relay(makeRequest())]);
      assert.equal(node.sent.length, 1);
      assert.equal(a.txHash, b.txHash);
    });

    it("the nonce record is durable: a restarted relayer never reuses or skips", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-test-"));
      const storePath = path.join(dir, "state.json");
      try {
        const node = new FakeQuaiNode(POOL, signerAddress());
        const h1 = makeHarness(storePath, node);
        await h1.relayer.relay(makeRequest());
        assert.equal(h1.store.nonceHint, 1);

        // kill and restart against the same durable store and chain
        const h2 = makeHarness(storePath, node);
        await h2.relayer.relay(makeRequest({ nullifier: 778n }));
        assert.equal(h2.node.sent.length, 2);
        assert.equal(h2.node.sent[1].nonce, 1n); // continues at 1, does not reuse 0
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a restart reconciles every in-flight unshield before accepting work", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-test-"));
      const storePath = path.join(dir, "state.json");
      try {
        const node = new FakeQuaiNode(POOL, signerAddress());
        const h1 = makeHarness(storePath, node);
        const rec = await h1.relayer.relay(makeRequest());

        const h2 = makeHarness(storePath, node);
        const reconciling = h2.relayer.relay(makeRequest({ nullifier: 999n }));
        h2.relayer.reconcile(); // starts reconciling the first relay's in-flight record
        await assert.rejects(reconciling, (e: unknown) => isRelayerError(e, "ERR_RELAYER_RECONCILING"));
        await h2.relayer.reconcile();

        h2.node.mineBlocks(2);
        await h2.relayer.sync();
        assert.equal(h2.relayer.status(rec.nullifier)?.status, "confirmed");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("reorgs (O-10)", () => {
    it("a reorged-out, unspent unshield goes back to re-checked pending and resends only via relay()", async () => {
      const { relayer, node } = makeHarness();
      const rec = await relayer.relay(makeRequest());
      node.mineBlocks(2);
      await relayer.sync();
      assert.equal(relayer.status(rec.nullifier)?.status, "confirmed");

      node.reorg(3, { undoSpend: true });
      await relayer.sync();
      const after = relayer.status(rec.nullifier);
      assert.equal(after?.status, "reorged");
      assert.equal(after?.txHash, undefined); // unspent: safe to resend through relay()

      const resent = await relayer.relay(makeRequest());
      assert.equal(node.sent.length, 2);
      assert.equal(node.sent[1].nonce, 1n);
      assert.notEqual(resent.txHash, rec.txHash);
      assert.equal(resent.attempts, 2);
    });

    it("a reorged-out but spent unshield keeps its transaction and waits for it to re-land", async () => {
      const { relayer, node } = makeHarness();
      const rec = await relayer.relay(makeRequest());
      node.mineBlocks(2);
      await relayer.sync();

      node.reorg(3, { undoSpend: false }); // spend survived on the canonical chain
      await relayer.sync();
      const after = relayer.status(rec.nullifier);
      assert.equal(after?.status, "reorged");
      assert.equal(after?.txHash, rec.txHash); // kept: the same tx will re-land
    });

    it("a receipt claiming a block ahead of the head is not counted (stale/lying RPC)", async () => {
      const { relayer, node } = makeHarness();
      const rec = await relayer.relay(makeRequest());
      node.mineBlocks(1);
      node.futureReceipt = true;
      await relayer.sync();
      const s = relayer.status(rec.nullifier);
      assert.equal(s?.status, "pending"); // not confirmed on the word of a lying receipt
      assert.ok(s?.confirmations === 0 || s?.confirmations === undefined);
    });
  });

  describe("operator controls (SP-EX-04, gas floor)", () => {
    it("offline refuses everything before anything is attempted", async () => {
      const { relayer, node } = makeHarness();
      relayer.setOnline(false, "scheduled maintenance");
      await assert.rejects(relayer.relay(makeRequest()), (e: unknown) => {
        assert.ok(isRelayerError(e, "ERR_RELAYER_OFFLINE"));
        assert.match((e as Error).message, /scheduled maintenance/);
        return true;
      });
      assert.equal(node.sent.length, 0);
    });

    it("at or below the gas floor the relayer takes itself offline with a named error", async () => {
      const { relayer, node } = makeHarness();
      node.balances.set(signerAddress().toLowerCase(), 1n); // exactly the floor
      await assert.rejects(relayer.relay(makeRequest()), (e: unknown) => isRelayerError(e, "ERR_RELAYER_GAS_FLOOR"));
      assert.equal(node.sent.length, 0);
      // and it recovers when topped up
      node.balances.set(signerAddress().toLowerCase(), 100n);
      const rec = await relayer.relay(makeRequest());
      assert.equal(rec.status, "pending");
    });
  });

  describe("dropped and reverted transactions", () => {
    it("a lost receipt (RPC never surfaces it) becomes dropped, and a re-post resends", async () => {
      const { relayer, node } = makeHarness();
      node.loseNextReceipt = true;
      const rec = await relayer.relay(makeRequest());
      assert.equal(rec.txHash !== undefined, true);
      node.mineBlocks(6); // well past txTimeoutBlocks=5
      await relayer.sync();
      assert.equal(relayer.status(rec.nullifier)?.status, "dropped");

      const retried = await relayer.relay(makeRequest());
      assert.equal(node.sent.length, 2);
      assert.equal(node.sent[1].nonce, 1n); // next nonce; the dropped one is never reused blindly
      assert.equal(retried.attempts, 2);
    });

    it("an on-chain revert marks the record reverted and does not spend the nullifier", async () => {
      const { relayer, node } = makeHarness();
      node.revertNextTx = true;
      const rec = await relayer.relay(makeRequest());
      node.mineBlocks(1);
      await relayer.sync();
      const s = relayer.status(rec.nullifier);
      assert.equal(s?.status, "reverted");
      assert.equal(node.spentNullifiers.has(NULLIFIER.toString()), false);
      assert.match(s?.lastError ?? "", /reverted/);

      // retry path is open: the nullifier is unspent
      node.revertNextTx = false;
      const retried = await relayer.relay(makeRequest());
      assert.equal(retried.status, "pending");
      assert.equal(node.sent.length, 2);
    });
  });

  describe("signer policy guard", () => {
    it("refuses to sign for any contract other than the pool, or any other calldata", async () => {
      const guard = new PermittedCallSigner(WalletQuaiSigner.fromPrivateKey(PRIV), POOL);
      const base = { chainId: 15000, nonce: 0, gasPrice: 1n, gasLimit: "0x5208", value: "0x0", accessList: [], from: signerAddress() };
      const good = { ...base, to: POOL, data: UNSHIELD_SELECTOR + "00".repeat(100) };
      await assert.ok((await guard.sign(good)).startsWith("0x"));
      await assert.rejects(guard.sign({ ...good, to: OTHER }), (e: unknown) => isRelayerError(e, "ERR_SIGNER_POLICY"));
      await assert.rejects(guard.sign({ ...good, data: "0xdeadbeef" }), (e: unknown) => isRelayerError(e, "ERR_SIGNER_POLICY"));
    });

    it("keystore round-trip: same address, wrong passphrase refused", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-key-"));
      try {
        const file = path.join(dir, "keystore.json");
        const addr = await WalletQuaiSigner.createKeystoreFile(file, "correct horse battery");
        const opened = await WalletQuaiSigner.fromKeystoreFile(file, "correct horse battery");
        assert.equal(opened.address, addr);
        await assert.rejects(WalletQuaiSigner.fromKeystoreFile(file, "wrong passphrase"));
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("logging redaction", () => {
    it("logs carry no proof points, payment payloads or key material", async () => {
      const { relayer, logs } = makeHarness();
      await relayer.relay(makeRequest());
      const joined = logs.join("\n");
      for (const forbidden of ["\"a\":[\"1\",\"2\"]", "\"b\":[[\"3\",\"4\"]", "5000000000000000000"]) {
        assert.equal(joined.includes(forbidden), false, `log line leaked payload data: ${joined}`);
      }
    });
  });
});
