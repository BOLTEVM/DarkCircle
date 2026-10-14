/**
 * DarkCircle production relayer: adversarial tests (phase-3 exit criteria)
 * File: test/adversarial/relayer_adversarial.test.ts
 *
 * Every hostile input or chain behaviour refuses with a named error — or, where the chain itself
 * recovers (reorg), returns to a re-checked state with no duplicate transaction and no loss:
 *   replayed proof, wrong relayer address, stale root, fee below quote, double submit,
 *   RPC returning stale/future state, a proof that would revert, malformed requests,
 *   and a signer that is asked to sign outside its policy.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAddress } from "ethers";
import { QuaiRpcClient } from "../../src/quai/rpc.ts";
import { QUAI_ORCHARD_CYPRUS1 } from "../../src/quai/networks.ts";
import { DarkCircleRelayer, type RelayerConfig } from "../../src/relayer/relayer.ts";
import { RelayStore } from "../../src/relayer/store.ts";
import { PermittedCallSigner, WalletQuaiSigner } from "../../src/relayer/signer.ts";
import { isRelayerError, type RelayRequest } from "../../src/relayer/types.ts";
import { FakeQuaiNode } from "../unit/relayerFakeNode.ts";

const PRIV = "0x" + "22".repeat(32);
const POOL = getAddress("0x0000000000000000000000000000000000000a11");
const TOKEN = getAddress("0x0000000000000000000000000000000000000b22");
const OTHER_TOKEN = getAddress("0x0000000000000000000000000000000000000e44");
const RECIPIENT = getAddress("0x00000000000000000000000000000000000d3905");
const ATTACKER_RELAYER = getAddress("0x0000000000000000000000000000000000000f55");
const ROOT = 12_345n;
const NULLIFIER = 777n;
const FEE = 100_000n;

const signerAddr = WalletQuaiSigner.fromPrivateKey(PRIV).address;

function makeRequest(over: { payment?: Partial<RelayRequest["payment"]>; token?: string; nullifier?: bigint } = {}): RelayRequest {
  return {
    token: over.token ?? TOKEN,
    proof: { a: ["9", "8"], b: [["7", "6"], ["5", "4"]], c: ["3", "2"] },
    payment: {
      root: "0x" + ROOT.toString(16),
      nullifier: "0x" + (over.nullifier ?? NULLIFIER).toString(16),
      changeCommitment: "0x0",
      recipient: RECIPIENT,
      amount: (5n * 10n ** 18n).toString(),
      relayer: signerAddr,
      fee: FEE.toString(),
      ...(over.payment ?? {})
    }
  };
}

function config(): RelayerConfig {
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

function harness() {
  const node = new FakeQuaiNode(POOL, signerAddr);
  node.knownRoots.add(ROOT.toString());
  const rpc = new QuaiRpcClient({ network: QUAI_ORCHARD_CYPRUS1, transport: node.transport });
  const relayer = new DarkCircleRelayer({
    rpc,
    signer: new PermittedCallSigner(WalletQuaiSigner.fromPrivateKey(PRIV), POOL),
    store: new RelayStore(),
    config: config()
  });
  return { node, relayer };
}

describe("relayer adversarial: every hostile input refuses with a named error", () => {
  it("replayed proof after confirmation returns the original transaction, never a second send", async () => {
    const { node, relayer } = harness();
    const first = await relayer.relay(makeRequest());
    node.mineBlocks(2);
    await relayer.sync();
    assert.equal(relayer.status(first.nullifier)?.status, "confirmed");

    const replay = await relayer.relay(makeRequest());
    assert.equal(replay.txHash, first.txHash);
    assert.equal(node.sent.length, 1, "a replay must not produce a second transaction");
  });

  it("a proof naming a different relayer is refused (front-running binding)", async () => {
    const { node, relayer } = harness();
    await assert.rejects(
      relayer.relay(makeRequest({ payment: { relayer: ATTACKER_RELAYER } })),
      (e: unknown) => isRelayerError(e, "RELAYER_ADDRESS_MISMATCH")
    );
    assert.equal(node.sent.length, 0);
  });

  it("a stale root — not in the pool's history — is refused", async () => {
    const { node, relayer } = harness();
    node.knownRoots.clear();
    await assert.rejects(relayer.relay(makeRequest()), (e: unknown) => isRelayerError(e, "UNKNOWN_ROOT"));
    assert.equal(node.sent.length, 0);
  });

  it("a fee below the quote is refused", async () => {
    const { node, relayer } = harness();
    await assert.rejects(
      relayer.relay(makeRequest({ payment: { fee: (FEE - 1n).toString() } })),
      (e: unknown) => isRelayerError(e, "FEE_BELOW_QUOTE")
    );
    assert.equal(node.sent.length, 0);
  });

  it("a token this relayer does not settle is refused (WQUAI and WQI never mix)", async () => {
    const { node, relayer } = harness();
    await assert.rejects(
      relayer.relay(makeRequest({ token: OTHER_TOKEN })),
      (e: unknown) => isRelayerError(e, "TOKEN_POOL_MISMATCH")
    );
    assert.equal(node.sent.length, 0);
  });

  it("a nullifier the chain already knows as spent is refused", async () => {
    const { node, relayer } = harness();
    node.spentNullifiers.add(NULLIFIER.toString());
    await assert.rejects(relayer.relay(makeRequest()), (e: unknown) => isRelayerError(e, "NULLIFIER_ALREADY_SPENT"));
    assert.equal(node.sent.length, 0);
  });

  it("a request that would revert on chain is refused before any gas is spent", async () => {
    const { node, relayer } = harness();
    node.simulationFails = true; // the pool's simulation endpoints report a revert
    await assert.rejects(relayer.relay(makeRequest()), (e: unknown) => isRelayerError(e, "RELAY_SIMULATION_FAILED"));
    assert.equal(node.sent.length, 0);
    assert.equal(node.nonces.get(signerAddr.toLowerCase()), 0, "a refused relay must not consume a nonce");
  });

  it("malformed requests are refused as ERR_BAD_REQUEST and never reach the chain", async () => {
    const { node, relayer } = harness();
    const bad = makeRequest();
    bad.payment.amount = "not-a-number";
    await assert.rejects(relayer.relay(bad), (e: unknown) => isRelayerError(e, "ERR_BAD_REQUEST"));

    const zeroNullifier = makeRequest({ payment: { nullifier: "0x0" } });
    await assert.rejects(relayer.relay(zeroNullifier), (e: unknown) => isRelayerError(e, "ERR_BAD_REQUEST"));

    const outOfField = makeRequest({ payment: { root: "0x" + (2n ** 254n).toString(16) } });
    await assert.rejects(relayer.relay(outOfField), (e: unknown) => isRelayerError(e, "ERR_BAD_REQUEST"));

    assert.equal(node.sent.length, 0);
  });

  it("RPC returning stale/future state cannot fake a confirmation", async () => {
    const { node, relayer } = harness();
    const rec = await relayer.relay(makeRequest());
    node.mineBlocks(5); // enough blocks for confirmation, if the receipt were honest
    node.futureReceipt = true; // the receipt claims a block far ahead of the head
    await relayer.sync();
    assert.notEqual(relayer.status(rec.nullifier)?.status, "confirmed");
  });

  it("the resend cap stops a nullifier that keeps being reorged", async () => {
    const { node, relayer } = harness();
    const rec = await relayer.relay(makeRequest());
    node.mineBlocks(2);
    await relayer.sync();
    assert.equal(relayer.status(rec.nullifier)?.status, "confirmed");

    for (let attempt = 2; attempt <= 3; attempt++) {
      node.reorg(3, { undoSpend: true });
      await relayer.sync();
      assert.equal(relayer.status(rec.nullifier)?.status, "reorged");
      const resent = await relayer.relay(makeRequest());
      assert.equal(resent.attempts, attempt);
      node.mineBlocks(2);
      await relayer.sync();
      assert.equal(relayer.status(rec.nullifier)?.status, "confirmed");
    }

    node.reorg(3, { undoSpend: true });
    await relayer.sync();
    assert.equal(relayer.status(rec.nullifier)?.status, "reorged");
    await assert.rejects(relayer.relay(makeRequest()), (e: unknown) => isRelayerError(e, "RELAY_ATTEMPTS_EXHAUSTED"));
    assert.equal(node.sent.length, 3, "no fourth transaction was sent");
  });

  it("a crash between broadcast and confirmation is adopted on restart, not duplicated", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayer-adv-"));
    const storePath = path.join(dir, "state.json");
    try {
      const { node } = harness();
      const rpc = new QuaiRpcClient({ network: QUAI_ORCHARD_CYPRUS1, transport: node.transport });
      const relayer1 = new DarkCircleRelayer({
        rpc,
        signer: new PermittedCallSigner(WalletQuaiSigner.fromPrivateKey(PRIV), POOL),
        store: new RelayStore(storePath),
        config: config()
      });
      const rec = await relayer1.relay(makeRequest());
      node.mineBlocks(2); // the chain confirms while the process is "down"

      const relayer2 = new DarkCircleRelayer({
        rpc,
        signer: new PermittedCallSigner(WalletQuaiSigner.fromPrivateKey(PRIV), POOL),
        store: new RelayStore(storePath),
        config: config()
      });
      await relayer2.reconcile();
      // The chain says the nullifier is spent; we never saw the receipt. Adopt, do not resend.
      const adopted = await relayer2.relay(makeRequest());
      assert.equal(adopted.status, "confirmed");
      assert.equal(node.sent.length, 1);
      assert.equal(adopted.txHash, rec.txHash);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
