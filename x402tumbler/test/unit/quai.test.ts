/**
 * DarkCircle Protocol: Quai Network integration tests
 * File: test/unit/quai.test.ts
 *
 * Covers the Quai-specific rules: zone/ledger address validation, WQUAI + WQI registry,
 * ephemeral key grinding, zone-enforcing spending policy, x402 challenge fields, RPC client
 * behaviour (via an injected transport), on-chain payment verification, and the Quai
 * access-list revert-burn rule. Live-chain checks live in `pnpm verify:quai`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  QUAI_CYPRUS1,
  QUAI_NETWORKS,
  QUAI_ORCHARD_CYPRUS1,
  QUAI_ZONES,
  challengeMatchesNetwork,
  getZone,
  resolveQuaiNetwork,
  assertQuaiPaymentAddress,
  getAddressLedger,
  getAddressZone,
  grindQuaiKey,
  isValidQuaiPaymentAddress,
  toQuaiChecksum,
  WQUAI,
  WQI,
  WQUAI_ADDRESS,
  WQI_ADDRESS,
  QuaiTokenRegistry,
  defaultQuaiTokenRegistry,
  formatTokenAmount,
  parseTokenAmount,
  QuaiRpcClient,
  QuaiPaymentVerifier,
  TRANSFER_TOPIC,
  type JsonRpcTransport
} from "../../src/quai/index.ts";
import { SimulatedBlockchain } from "../../src/sim/blockchain.ts";
import { ERC20Token } from "../../src/sim/erc20Token.ts";
import { createDefaultCliContext, resolveTokenArg } from "../../src/cli/context.ts";
import { runCli } from "../../src/cli/index.ts";
import { CliExitCode } from "../../src/cli/types.ts";
import { ChallengeParser } from "../../src/proxy/parser.ts";
import { SettlementCoordinator } from "../../src/proxy/settlement.ts";
import { deriveEphemeralAddress } from "../../src/gateway/ephemeral.ts";
import { AccountingJournalReconstructor } from "../../src/audit/accounting.ts";
import { SIM_VENDOR_ADDRESS, SIM_POOL_ADDRESS } from "../../src/sim/defaults.ts";

const VENDOR = SIM_VENDOR_ADDRESS;

describe("Quai Network integration", () => {
  describe("network topology", () => {
    it("mainnet is chain 9 on every zone and Orchard is 15000", () => {
      const mainnet = QUAI_NETWORKS.filter((n) => !n.testnet);
      const orchard = QUAI_NETWORKS.filter((n) => n.testnet);
      assert.equal(mainnet.length, 9);
      assert.equal(orchard.length, 9);
      assert.ok(mainnet.every((n) => n.chainId === 9));
      assert.ok(orchard.every((n) => n.chainId === 15000));
      assert.equal(QUAI_CYPRUS1.rpcUrl, "https://rpc.quai.network/cyprus1");
      assert.equal(QUAI_ORCHARD_CYPRUS1.rpcUrl, "https://orchard.rpc.quai.network/cyprus1");
    });

    it("zone table matches the quais SDK prefixes", () => {
      assert.deepEqual(
        QUAI_ZONES.map((z) => [z.name, z.byte]),
        [
          ["cyprus1", "00"], ["cyprus2", "01"], ["cyprus3", "02"],
          ["paxos1", "10"], ["paxos2", "11"], ["paxos3", "12"],
          ["hydra1", "20"], ["hydra2", "21"], ["hydra3", "22"]
        ]
      );
      assert.equal(getZone("0x00").name, "cyprus1");
      assert.throws(() => getZone("0x05"), /ERR_QUAI_UNKNOWN_ZONE/);
    });

    it("resolves challenge network ids and refuses non-Quai networks", () => {
      assert.equal(resolveQuaiNetwork("quai-cyprus1")?.id, "quai-cyprus1");
      assert.equal(resolveQuaiNetwork("quai")?.id, "quai-cyprus1");
      assert.equal(resolveQuaiNetwork("quai:cyprus2")?.id, "quai-cyprus2");
      assert.equal(resolveQuaiNetwork("quai:15000:cyprus1")?.id, "quai-orchard-cyprus1");
      assert.equal(resolveQuaiNetwork("ethereum"), undefined);
      assert.equal(resolveQuaiNetwork("base"), undefined);
      assert.equal(challengeMatchesNetwork(QUAI_CYPRUS1, { network: "quai-cyprus1", chainId: 9 }), true);
      assert.equal(challengeMatchesNetwork(QUAI_CYPRUS1, { network: "quai-cyprus2", chainId: 9 }), false);
      assert.equal(challengeMatchesNetwork(QUAI_CYPRUS1, { network: "quai-cyprus1", chainId: 15000 }), false);
    });
  });

  describe("address rules", () => {
    it("accepts a Cyprus-1 Quai-ledger address and checksums it", () => {
      const lower = VENDOR.toLowerCase();
      assert.equal(assertQuaiPaymentAddress(lower), ethers.getAddress(lower));
      assert.equal(getAddressZone(lower)?.name, "cyprus1");
      assert.equal(getAddressLedger(lower), "quai");
    });

    it("rejects other zones, Qi-ledger addresses, bad checksums and malformed input", () => {
      assert.throws(() => assertQuaiPaymentAddress("0x1111111254eeb25477b68fb85ed929f73a960582"), /ERR_QUAI_ADDRESS_WRONG_ZONE.*paxos2/);
      assert.throws(() => assertQuaiPaymentAddress("0x0100000000000000000000000000000000000001"), /WRONG_ZONE.*cyprus2/);
      assert.throws(() => assertQuaiPaymentAddress("0x0080000000000000000000000000000000000001"), /ERR_QUAI_ADDRESS_QI_LEDGER/);
      // flip the case of one letter of a checksummed address -> checksum no longer valid
      const bad = VENDOR.replace(/[a-f]/i, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
      assert.throws(() => toQuaiChecksum(bad), /ERR_QUAI_ADDRESS_INVALID/);
      assert.throws(() => assertQuaiPaymentAddress("0x1234"), /ERR_QUAI_ADDRESS_INVALID/);
      assert.equal(isValidQuaiPaymentAddress("not an address"), false);
    });

    it("zone for another network is honoured", () => {
      const paxos = resolveQuaiNetwork("quai-paxos1")!;
      assert.equal(isValidQuaiPaymentAddress("0x1000000000000000000000000000000000000001", paxos), true);
      assert.equal(isValidQuaiPaymentAddress(VENDOR, paxos), false);
    });

    it("grinds a deterministic key whose address is in zone and on the Quai ledger", () => {
      const a = grindQuaiKey(424242n);
      const b = grindQuaiKey(424242n);
      assert.deepEqual(a, b);
      assert.equal(new ethers.Wallet(a.privateKey).address, a.address);
      assert.equal(isValidQuaiPaymentAddress(a.address), true);

      const hydra = grindQuaiKey(7n, getZone("hydra3"));
      assert.equal(getAddressZone(hydra.address)?.name, "hydra3");
      const qi = grindQuaiKey(7n, getZone("cyprus1"), "qi");
      assert.equal(getAddressLedger(qi.address), "qi");
    });
  });

  describe("settlement asset registry", () => {
    it("WQUAI and WQI carry the addresses read back from Cyprus-1", () => {
      assert.equal(WQUAI_ADDRESS, "0x006C3e2AaAE5DB1bCd11A1a097cE572312EADdBB");
      assert.equal(WQI_ADDRESS, "0x002b2596EcF05C93a31ff916E8b456DF6C77c750");
      for (const t of [WQUAI, WQI]) {
        assert.equal(t.decimals, 18);
        assert.equal(isValidQuaiPaymentAddress(t.address), true);
      }
      assert.deepEqual([WQUAI.wrapsNative, WQUAI.permit], [true, false]);
      assert.deepEqual([WQI.wrapsNative, WQI.permit], [false, true]);
    });

    it("resolves by symbol or address, never by an unregistered look-alike", () => {
      assert.equal(defaultQuaiTokenRegistry.resolve("wqi")?.address, WQI_ADDRESS);
      assert.equal(defaultQuaiTokenRegistry.resolve(WQUAI_ADDRESS.toLowerCase())?.symbol, "WQUAI");
      // the unrelated "USDT" that Quaiswap lists is not in the registry
      assert.equal(defaultQuaiTokenRegistry.resolve("0x0040454f5891443d30a9992173fa84f5402c5776"), undefined);
      assert.equal(defaultQuaiTokenRegistry.resolve("USDT"), undefined);
      assert.throws(() => defaultQuaiTokenRegistry.require("USDT"), /ERR_QUAI_TOKEN_UNKNOWN/);
      // registering an Orchard deployment does not leak into mainnet lookups
      const reg = new QuaiTokenRegistry();
      reg.register({ ...WQUAI, networkId: "quai-orchard-cyprus1", address: "0x0000000000000000000000000000000000000abc" });
      assert.equal(reg.list(QUAI_ORCHARD_CYPRUS1).length, 1);
      assert.equal(reg.list(QUAI_CYPRUS1).length, 2);
    });

    it("formats and parses 18-decimal amounts exactly", () => {
      assert.equal(formatTokenAmount(1_500_000_000_000_000_000n), "1.5");
      assert.equal(formatTokenAmount(5n * 10n ** 18n), "5.0");
      assert.equal(formatTokenAmount(1n), "0.000000000000000001");
      assert.equal(parseTokenAmount("0.000000000000000001"), 1n);
      assert.equal(parseTokenAmount("12.5"), 12_500_000_000_000_000_000n);
      assert.throws(() => parseTokenAmount("1.0000000000000000001"), /ERR_QUAI_AMOUNT_INVALID/);
      assert.throws(() => parseTokenAmount("-1"), /ERR_QUAI_AMOUNT_INVALID/);
    });
  });

  describe("simulated Quai zone ledger", () => {
    it("defaults to chain 9 / Cyprus-1 with QUAI native", () => {
      const chain = new SimulatedBlockchain();
      assert.equal(chain.chainId, 9);
      assert.equal(chain.network.id, "quai-cyprus1");
      assert.equal(chain.nativeSymbol, "QUAI");
      assert.equal(new SimulatedBlockchain(15000).network.id, "quai-orchard-cyprus1");
    });

    it("a multi-contract call without an access list reverts and burns the whole gas limit", () => {
      const chain = new SimulatedBlockchain();
      const token = ERC20Token.createWQUAI(chain);
      const other = "0x0099999999999999999999999999999999999999";
      const sender = VENDOR;
      // A router-like contract that touches the token as well.
      chain.registerContract({
        address: SIM_POOL_ADDRESS,
        handleTransaction: () => ({ status: 1, logs: [], returnData: "0x" }),
        handleCall: () => "0x",
        touchedContracts: () => [token.address, other]
      });
      const gasLimit = 500_000n;
      const gasPrice = 2_000_000_000n;
      const before = chain.getBalance(sender);

      const bad = chain.executeTransaction({ from: sender, to: SIM_POOL_ADDRESS, data: "0xdeadbeef", gasLimit, gasPrice });
      assert.equal(bad.status, 0);
      assert.match(bad.error!, /ERR_QUAI_ACCESS_LIST_MISSING/);
      assert.equal(bad.gasUsed, gasLimit); // 100% of the limit, not 21k
      assert.equal(chain.getBalance(sender), before - gasLimit * gasPrice);

      const partial = chain.executeTransaction({
        from: sender, to: SIM_POOL_ADDRESS, data: "0xdeadbeef", gasLimit, gasPrice,
        accessList: chain.createAccessList(SIM_POOL_ADDRESS, [token.address]) // missing `other`
      });
      assert.equal(partial.status, 0);

      const good = chain.executeTransaction({
        from: sender, to: SIM_POOL_ADDRESS, data: "0xdeadbeef", gasLimit, gasPrice,
        accessList: chain.createAccessList(SIM_POOL_ADDRESS, [token.address, other])
      });
      assert.equal(good.status, 1);
      assert.equal(good.gasUsed, 21_000n);
    });

    it("single-contract calls need no access list", () => {
      const chain = new SimulatedBlockchain();
      const token = ERC20Token.createWQI(chain);
      token.mint(VENDOR, 10n);
      const iface = new ethers.Interface(["function transfer(address,uint256) returns (bool)"]);
      const r = chain.executeTransaction({
        from: VENDOR,
        to: token.address,
        data: iface.encodeFunctionData("transfer", [SIM_POOL_ADDRESS, 4n])
      });
      assert.equal(r.status, 1);
      assert.equal(token.balanceOf(SIM_POOL_ADDRESS), 4n);
    });
  });

  describe("x402 challenge parsing and spending policy", () => {
    it("parser defaults to Quai and WQUAI/18 and takes decimals from the registry", () => {
      const p = ChallengeParser.parse({
        "x-payment-recipient": VENDOR,
        "x-payment-amount": "1.5",
        "x-payment-invoice-id": "inv_a",
        "x-payment-token": WQUAI_ADDRESS
      });
      assert.equal(p.network, "quai-cyprus1");
      assert.equal(p.chainId, 9);
      assert.equal(p.tokenSymbol, "WQUAI");
      assert.equal(p.tokenDecimals, 18);
      assert.equal(p.amount, 1_500_000_000_000_000_000n);
    });

    it("rejects a challenge that misstates a registered token's decimals", () => {
      assert.throws(
        () => ChallengeParser.parse({
          "x-payment-recipient": VENDOR,
          "x-payment-amount": "5.0",
          "x-payment-invoice-id": "inv_b",
          "x-payment-token": WQI_ADDRESS,
          "x-payment-token-decimals": "6"
        }),
        /WQI has 18 decimals, challenge states 6/
      );
    });

    it("numeric X-Payment-Network is still read as a chain id", () => {
      const p = ChallengeParser.parse({
        "x-payment-recipient": VENDOR,
        "x-payment-amount": "1000",
        "x-payment-invoice-id": "inv_c",
        "x-payment-token": WQUAI_ADDRESS,
        "x-payment-network": "15000"
      });
      assert.equal(p.chainId, 15000);
    });

    function coordinator(ctx: ReturnType<typeof createDefaultCliContext>) {
      return new SettlementCoordinator({
        spendingPolicy: ctx.spendingPolicy,
        relayer: ctx.relayer,
        corporateKeys: ctx.corporateKeys as any,
        ppoiEngine: ctx.ppoiEngine,
        sanctionsRegistry: ctx.sanctionsRegistry,
        treasuryUTXOs: ctx.treasuryUTXOs
      });
    }
    const base = (ctx: ReturnType<typeof createDefaultCliContext>) => ({
      amount: 10n ** 18n,
      tokenAddress: ctx.tokenAddress!,
      chainId: 9,
      network: "quai-cyprus1"
    });

    it("refuses wrong-zone, Qi-ledger and unchecksummed-invalid payees before spending a note", () => {
      const ctx = createDefaultCliContext();
      const c = coordinator(ctx);
      assert.throws(() => c.validatePolicy({ ...base(ctx), recipientAddress: "0x1111111254eeb25477b68fb85ed929f73a960582" }), /ERR_QUAI_RECIPIENT_INVALID.*WRONG_ZONE/);
      assert.throws(() => c.validatePolicy({ ...base(ctx), recipientAddress: "0x0080000000000000000000000000000000000001" }), /ERR_QUAI_RECIPIENT_INVALID.*QI_LEDGER/);
      assert.doesNotThrow(() => c.validatePolicy({ ...base(ctx), recipientAddress: VENDOR }));
    });

    it("refuses other networks, other chain ids and tokens outside the registry", () => {
      const ctx = createDefaultCliContext();
      const c = coordinator(ctx);
      assert.throws(() => c.validatePolicy({ ...base(ctx), network: "ethereum", recipientAddress: VENDOR }), /ERR_UNSUPPORTED_CHAIN_OR_TOKEN/);
      assert.throws(() => c.validatePolicy({ ...base(ctx), network: "quai-cyprus2", recipientAddress: VENDOR }), /ERR_UNSUPPORTED_CHAIN_OR_TOKEN/);
      assert.throws(() => c.validatePolicy({ ...base(ctx), chainId: 15000, recipientAddress: VENDOR }), /ERR_UNSUPPORTED_CHAIN_OR_TOKEN/);
      assert.throws(
        () => c.validatePolicy({ ...base(ctx), tokenAddress: "0x0040454f5891443d30a9992173fa84f5402c5776", recipientAddress: VENDOR }),
        /ERR_UNSUPPORTED_CHAIN_OR_TOKEN/
      );
    });

    it("a sanctioned payee is reported as sanctioned even when its address is off-zone", () => {
      const ctx = createDefaultCliContext();
      const offZone = "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b"; // OFAC-listed router
      assert.throws(() => coordinator(ctx).validatePolicy({ ...base(ctx), recipientAddress: offZone }), /ERR_PAYEE_SANCTIONED/);
    });
  });

  describe("merchant gateway on Quai", () => {
    it("ephemeral payees are unique, in-zone Quai-ledger addresses with a matching key", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 8; i++) {
        const kp = deriveEphemeralAddress("root-key", `inv_${i}`);
        assert.equal(isValidQuaiPaymentAddress(kp.address), true, kp.address);
        assert.equal(new ethers.Wallet(kp.privateKey).address, kp.address);
        seen.add(kp.address);
      }
      assert.equal(seen.size, 8);
      // deterministic per (root, invoice)
      assert.equal(deriveEphemeralAddress("root-key", "inv_0").address, deriveEphemeralAddress("root-key", "inv_0").address);
    });

    it("challenges advertise quai-cyprus1 / chain 9 and a zone-valid recipient in every encoding", () => {
      const ctx = createDefaultCliContext();
      const ch = ctx.merchantGateway.createPaymentChallenge("/r", 3n * 10n ** 18n, WQI_ADDRESS.toLowerCase(), "WQI", 18);
      assert.match(ch.challengeHeaders["WWW-Authenticate"], /network="quai-cyprus1", chainId="9"/);
      assert.equal(ch.challengeHeaders["X-Payment-Network"], "quai-cyprus1");
      assert.equal(ch.challengeHeaders["X-Payment-Chain-Id"], "9");
      assert.equal(ch.challengeBody.payment.network, "quai-cyprus1");
      assert.equal(ch.challengeBody.payment.chainId, 9);
      assert.match(ch.challengeBody.detail, /3 WQI on Quai Network Cyprus One/);
      assert.equal(isValidQuaiPaymentAddress(ch.invoice.ephemeralAddress), true);
      for (const parsed of [
        ChallengeParser.parse(undefined, ch.challengeBody),
        ChallengeParser.parse({ "www-authenticate": ch.challengeHeaders["WWW-Authenticate"] }),
        ChallengeParser.parse({ "x-payment-recipient": ch.challengeHeaders["X-Payment-Recipient"], "x-payment-amount": "3000000000000000000", "x-payment-invoice-id": ch.invoice.invoiceId, "x-payment-token": WQI_ADDRESS, "x-payment-network": ch.challengeHeaders["X-Payment-Network"], "x-payment-chain-id": "9" })
      ]) {
        assert.equal(parsed.network, "quai-cyprus1");
        assert.equal(parsed.chainId, 9);
        assert.equal(parsed.tokenSymbol, "WQI");
        assert.equal(parsed.amount, 3n * 10n ** 18n);
      }
    });

    it("PERMIT_SPONSORED sweeping is refused for WQUAI (no permit) with a pointer to RELAYER_BROADCAST", async () => {
      const ctx = createDefaultCliContext();
      ctx.merchantGateway.sweeper.gasSponsorshipMode = "PERMIT_SPONSORED";
      const ch = ctx.merchantGateway.createPaymentChallenge("/r", 10n ** 18n, ctx.tokenAddress!);
      ctx.token!.mint(ch.invoice.ephemeralAddress, 10n ** 18n);
      ctx.merchantGateway.verifyPayment(ch.invoice.invoiceId, "0x" + "ab".repeat(32), 10n ** 18n);
      await assert.rejects(ctx.merchantGateway.sweepAndShield(ch.invoice.invoiceId), /ERR_QUAI_PERMIT_UNSUPPORTED.*RELAYER_BROADCAST/);
    });
  });

  describe("shielded settlement end to end on Quai", () => {
    for (const asset of ["WQUAI", "WQI"]) {
      it(`pays a vendor in ${asset} through the relayer with the Quai access list attached`, async () => {
        const ctx = createDefaultCliContext({ asset });
        assert.equal(ctx.token!.symbol, asset);
        const res = await runCli(["pay", "--recipient", VENDOR, "--amount", "2.5", "--json"], ctx);
        assert.equal(res.exitCode, CliExitCode.SUCCESS, res.stderr);
        const out = JSON.parse(res.stdout);
        assert.equal(out.status, "CONFIRMED");
        assert.equal(ctx.token!.balanceOf(VENDOR), 2_500_000_000_000_000_000n);

        // sender on chain is the relayer, and the broadcast carried [pool, token] in its access list
        const tx = ctx.blockchain.latestBlock.transactions.at(-1) as any;
        assert.equal(tx.from, ctx.relayer.relayerAddress.toLowerCase());
        assert.deepEqual(
          tx.accessList.map((e: any) => e.address).sort(),
          [ctx.pool.contractAddress.toLowerCase(), ctx.token!.address.toLowerCase()].sort()
        );
        // journal is labelled with the asset it actually holds
        assert.equal(ctx.journal!.assetSymbol, asset);
        assert.match(ctx.journal!.entries.at(-1)!.creditAccount, new RegExp(`\\(${asset}\\)`));
      });
    }

    it("pays a vendor selected with --token wqi when the treasury holds WQI", async () => {
      const ctx = createDefaultCliContext({ asset: "WQI" });
      const res = await runCli(["pay", "--recipient", VENDOR, "--amount", "1", "--token", "wqi", "--json"], ctx);
      assert.equal(res.exitCode, CliExitCode.SUCCESS, res.stderr);
    });

    it("refuses an unknown --token symbol instead of guessing", async () => {
      const ctx = createDefaultCliContext();
      assert.throws(() => resolveTokenArg("USDT", ctx), /ERR_QUAI_TOKEN_UNKNOWN/);
    });

    it("refuses to pay a wrong-zone recipient and spends nothing", async () => {
      const ctx = createDefaultCliContext();
      const before = ctx.treasuryUTXOs.reduce((s, u) => s + u.value, 0n);
      const res = await runCli(["pay", "--recipient", "0x1111111254eeb25477b68fb85ed929f73a960582", "--amount", "1", "--json"], ctx);
      assert.notEqual(res.exitCode, CliExitCode.SUCCESS);
      assert.equal(ctx.treasuryUTXOs.reduce((s, u) => s + u.value, 0n), before);
    });
  });

  describe("audit accounting keeps assets apart", () => {
    it("one ledger holds one asset and refuses to add WQI to a WQUAI journal", () => {
      const j = new AccountingJournalReconstructor("0zk-test");
      const note = (token: string) => ({
        version: 1, token, value: "1000", blinding: "0x1", npk: "0x2",
        direction: "INBOUND_SHIELD" as const, counterparty: VENDOR, memo: "m", timestamp: 1_700_000_000
      });
      j.recordInbound("0x" + "1".repeat(64), 1, "0xc1", note(WQUAI_ADDRESS.toLowerCase()));
      assert.equal(j.assetSymbol, "WQUAI");
      assert.equal(j.decimals, 18);
      assert.throws(() => j.recordInbound("0x" + "2".repeat(64), 2, "0xc2", note(WQI_ADDRESS.toLowerCase())), /ERR_AUDIT_MIXED_ASSETS/);
      assert.equal(j.runningBalance, 1000n);
    });
  });

  describe("Quai RPC client (injected transport)", () => {
    function transport(handlers: Record<string, (params: unknown[]) => unknown>, calls: Array<{ method: string; params: unknown[] }> = []): JsonRpcTransport {
      return async (method, params) => {
        calls.push({ method, params });
        const h = handlers[method];
        if (!h) throw new Error(`ERR_QUAI_RPC: ${method}: unhandled`);
        return h(params);
      };
    }
    const zoneOk = { quai_chainId: () => "0x9", quai_nodeLocation: () => ["0x0", "0x0"] };

    it("assertZone accepts Cyprus-1 and rejects the wrong chain or shard", async () => {
      await new QuaiRpcClient({ transport: transport(zoneOk) }).assertZone();
      await assert.rejects(
        new QuaiRpcClient({ transport: transport({ ...zoneOk, quai_chainId: () => "0x3a98" }) }).assertZone(),
        /ERR_QUAI_CHAIN_ID_MISMATCH/
      );
      await assert.rejects(
        new QuaiRpcClient({ transport: transport({ ...zoneOk, quai_nodeLocation: () => ["0x0", "0x1"] }) }).assertZone(),
        /ERR_QUAI_ZONE_MISMATCH/
      );
      await assert.rejects(
        new QuaiRpcClient({ transport: transport({ ...zoneOk, quai_nodeLocation: () => [] }) }).assertZone(),
        /ERR_QUAI_ZONE_MISMATCH/
      );
    });

    it("checksums addresses before sending and explains a Prime/Region endpoint", async () => {
      const calls: Array<{ method: string; params: unknown[] }> = [];
      const c = new QuaiRpcClient({
        transport: transport({
          quai_getBalance: () => "0xde0b6b3a7640000",
          quai_call: () => { throw new Error("ERR_QUAI_RPC: quai_call: call can only called in zone chain"); }
        }, calls)
      });
      assert.equal(await c.getBalance(VENDOR.toLowerCase()), 10n ** 18n);
      assert.equal(calls[0].params[0], ethers.getAddress(VENDOR.toLowerCase()));
      await assert.rejects(c.call({ to: WQUAI_ADDRESS, data: "0x" }), /ERR_QUAI_NOT_ZONE_ENDPOINT/);
      await assert.rejects(c.getBalance("0x1234"), /ERR_QUAI_ADDRESS_INVALID/);
    });

    it("prepareContractCall attaches the access list and buffers the estimate", async () => {
      const calls: Array<{ method: string; params: unknown[] }> = [];
      const list = [{ address: WQUAI_ADDRESS.toLowerCase(), storageKeys: ["0x" + "01".repeat(32)] }];
      const c = new QuaiRpcClient({
        transport: transport({
          ...zoneOk,
          quai_createAccessList: () => ({ accessList: list, gasUsed: "0x78ca" }),
          quai_estimateGas: () => "0x186a0" // 100000
        }, calls)
      });
      const tx = await c.prepareContractCall({ from: VENDOR, to: WQUAI_ADDRESS, data: "0xa9059cbb" });
      assert.equal(tx.chainId, 9);
      assert.equal(tx.accessList[0].address, WQUAI_ADDRESS); // checksummed
      assert.equal(BigInt(tx.gasLimit), 120_000n); // +20%
      // estimateGas ran WITH the access list
      const est = calls.find((x) => x.method === "quai_estimateGas")!;
      assert.equal((est.params[0] as any).accessList.length, 1);
    });

    it("prepareContractCall refuses to return a transaction the node says would fail", async () => {
      const c = new QuaiRpcClient({
        transport: transport({ ...zoneOk, quai_createAccessList: () => ({ accessList: [], error: "execution reverted" }) })
      });
      await assert.rejects(c.prepareContractCall({ from: VENDOR, to: WQUAI_ADDRESS, data: "0x" }), /ERR_QUAI_SIMULATION_FAILED.*reverted/);
      const empty = new QuaiRpcClient({ transport: transport({ ...zoneOk, quai_createAccessList: () => null }) });
      await assert.rejects(empty.prepareContractCall({ from: VENDOR, to: WQUAI_ADDRESS, data: "0x" }), /ERR_QUAI_SIMULATION_FAILED/);
    });

    it("verifyToken flags a contract whose metadata differs from the registry", async () => {
      const iface = new ethers.Interface([
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)"
      ]);
      const answer = (name: string, symbol: string, decimals: number) => (params: unknown[]) => {
        const data = (params[0] as any).data as string;
        const fn = iface.getFunction(data.slice(0, 10))!.name;
        return iface.encodeFunctionResult(fn, [{ name, symbol, decimals }[fn]]);
      };
      const good = new QuaiRpcClient({ transport: transport({ ...zoneOk, quai_getCode: () => "0x6001", quai_call: answer("Wrapped Quai", "WQUAI", 18) }) });
      assert.equal((await good.verifyToken(WQUAI)).ok, true);
      const lookalike = new QuaiRpcClient({ transport: transport({ ...zoneOk, quai_getCode: () => "0x6001", quai_call: answer("Wrapped Quai", "WQUAI", 6) }) });
      const bad = await lookalike.verifyToken(WQUAI);
      assert.equal(bad.ok, false);
      assert.match(bad.problems.join(";"), /decimals 6 != 18/);
      const none = new QuaiRpcClient({ transport: transport({ ...zoneOk, quai_getCode: () => "0x" }) });
      assert.match((await none.verifyToken(WQUAI)).problems[0], /no contract code/);
    });
  });

  describe("on-chain payment verification", () => {
    const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
    const recipient = ethers.getAddress("0x0054328ef0070fceeea0a22bb01fa5f6614098ef");
    const payer = ethers.getAddress("0x0024eb33e0e381844d7f56b748f6ad8969c3cf79");
    const hash = "0x" + "cd".repeat(32);

    function verifier(receipt: unknown, head = 105) {
      return new QuaiPaymentVerifier(new QuaiRpcClient({
        transport: async (m) => {
          if (m === "quai_chainId") return "0x9";
          if (m === "quai_nodeLocation") return ["0x0", "0x0"];
          if (m === "quai_getTransactionReceipt") return receipt;
          if (m === "quai_blockNumber") return "0x" + head.toString(16);
          throw new Error("unexpected " + m);
        }
      }));
    }
    const transferLog = (token: string, to: string, amount: bigint) => ({
      address: token, topics: [TRANSFER_TOPIC, pad(payer), pad(to)], data: ethers.toBeHex(amount, 32)
    });
    const receipt = (logs: unknown[], status = "0x1", block = 100) => ({ status, blockNumber: "0x" + block.toString(16), logs });
    const req = { txHash: hash, token: WQUAI, recipient, minAmount: 5n * 10n ** 18n };

    it("accepts a matching, confirmed Transfer and reports the payer", async () => {
      const r = await verifier(receipt([transferLog(WQUAI_ADDRESS, recipient, 5n * 10n ** 18n)])).verify(req);
      assert.equal(r.ok, true);
      assert.equal(r.payer, payer);
      assert.equal(r.confirmations, 6);
    });

    it("sums multiple transfers to the payee but ignores other tokens and other payees", async () => {
      const r = await verifier(receipt([
        transferLog(WQUAI_ADDRESS, recipient, 3n * 10n ** 18n),
        transferLog(WQUAI_ADDRESS, recipient, 2n * 10n ** 18n),
        transferLog(WQI_ADDRESS, recipient, 100n * 10n ** 18n),
        transferLog(WQUAI_ADDRESS, payer, 100n * 10n ** 18n)
      ])).verify(req);
      assert.equal(r.ok, true);
      assert.equal(r.transferred, 5n * 10n ** 18n);
    });

    it("reports each failure reason distinctly", async () => {
      assert.equal((await verifier(null).verify(req)).code, "RECEIPT_NOT_FOUND");
      assert.equal((await verifier(receipt([], "0x0")).verify(req)).code, "TX_REVERTED");
      assert.equal((await verifier(receipt([transferLog(WQI_ADDRESS, recipient, 9n * 10n ** 18n)])).verify(req)).code, "NO_MATCHING_TRANSFER");
      assert.equal((await verifier(receipt([transferLog(WQUAI_ADDRESS, recipient, 10n ** 18n)])).verify(req)).code, "AMOUNT_TOO_LOW");
      assert.equal((await verifier(receipt([transferLog(WQUAI_ADDRESS, recipient, 5n * 10n ** 18n)]), 100).verify(req)).code, "INSUFFICIENT_CONFIRMATIONS");
      assert.equal((await verifier(null).verify({ ...req, txHash: "0x12" })).code, "RECEIPT_NOT_FOUND");
    });
  });
});
