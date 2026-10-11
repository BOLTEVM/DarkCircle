/**
 * Read-only check of DarkCircle's Quai assumptions against a live zone endpoint.
 * Usage: pnpm verify:quai [--network quai-orchard-cyprus1]
 * Sends only quai_chainId / quai_nodeLocation / quai_getCode / quai_call. It never signs or broadcasts.
 */
import { QuaiRpcClient, resolveQuaiNetwork, defaultQuaiTokenRegistry, DEFAULT_QUAI_NETWORK } from "../src/quai/index.ts";

const argIdx = process.argv.indexOf("--network");
const network = argIdx > 0 ? resolveQuaiNetwork(process.argv[argIdx + 1]) : DEFAULT_QUAI_NETWORK;
if (!network) {
  console.error("Unknown network id");
  process.exit(2);
}

const client = new QuaiRpcClient({ network });
await client.assertZone();
console.log(`zone ok: ${network.id} chain ${network.chainId} via ${network.rpcUrl}`);

const tokens = defaultQuaiTokenRegistry.list(network);
if (tokens.length === 0) {
  console.log(`no registered tokens for ${network.id}; nothing to verify`);
}
let failed = false;
for (const token of tokens) {
  const v = await client.verifyToken(token);
  const caps = await client.probeCapabilities(token);
  const capOk = caps.wrapsNative === token.wrapsNative && caps.permit === token.permit;
  console.log(
    `${v.ok && capOk ? "PASS" : "FAIL"} ${token.symbol} ${token.address} ` +
      `on-chain="${v.onChain.name}"/${v.onChain.symbol}/${v.onChain.decimals} code=${v.codeBytes}B ` +
      `wrapsNative=${caps.wrapsNative} permit=${caps.permit}` +
      (v.permitDomainOk !== undefined ? ` permitDomain=${v.permitDomainOk ? "ok" : "MISMATCH"}` : "") +
      (v.problems.length ? ` problems=${v.problems.join("; ")}` : "")
  );
  if (!v.ok || !capOk) failed = true;
}
process.exit(failed ? 1 : 0);
