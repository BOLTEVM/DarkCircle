/**
 * Starts the operator UI on http://127.0.0.1:<port>/ against the SIMULATED environment.
 * Usage: pnpm ui [--port 5180 --asset WQI]
 */
import { startApiServer } from "../src/api/server.ts";
import path from "node:path";
import { PersistenceManager } from "../src/persistence/manager.ts";
import { EncryptedStore } from "../src/persistence/store.ts";
import { AgentBook, encryptedBookStore } from "../src/agent/book.ts";

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const port = Number(arg("--port") ?? 5180);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`--port must be a whole number from 0 to 65535 (got ${arg("--port")})`);
  process.exit(1);
}
const asset = arg("--asset");

// Durable state: --data-dir <dir> with the passphrase in DARKCIRCLE_STORE_PASSPHRASE (never on the command line).
const dataDir = arg("--data-dir") ?? process.env.DARKCIRCLE_DATA_DIR;
let persistence: PersistenceManager | undefined;
let agentBook: AgentBook | undefined;
if (dataDir) {
  const passphrase = process.env.DARKCIRCLE_STORE_PASSPHRASE;
  if (!passphrase) {
    console.error("A data directory needs a passphrase: set DARKCIRCLE_STORE_PASSPHRASE (12+ characters). It is not accepted as a flag so it does not land in shell history.");
    process.exit(1);
  }
  persistence = PersistenceManager.open({ dir: dataDir, passphrase });
  // The voice agent's contacts, services, limits and activity: private, so encrypted the same way.
  agentBook = new AgentBook(encryptedBookStore(EncryptedStore.open({ dir: path.join(dataDir, "agent"), passphrase, keep: 3 })));
}

// @admin:begin
// The admin console is opt-in (--admin or DARKCIRCLE_ADMIN=1). Redacted from production builds.
const adminOn = process.argv.includes("--admin") || process.env.DARKCIRCLE_ADMIN === "1";
// @admin:end

const api = await startApiServer({
  port,
  asset,
  persistence,
  agent: agentBook ? { book: agentBook } : undefined,
  // @admin:begin
  admin: adminOn ? {} : undefined
  // @admin:end
});
console.log(`DarkCircle UI: ${api.url}`);
console.log("  The dashboard is a SIMULATION (no real funds). The Voice agent page works on the REAL Quai network: your wallet signs every transaction.");
if (persistence) {
  const r = api.state.recovery;
  console.log(r ? `Persistence ON (${dataDir}): restored snapshot #${r.seq} saved ${r.savedAt}` : `Persistence ON (${dataDir}): no snapshot yet, starting fresh`);
}
// @admin:begin
if (api.admin) {
  console.log("Admin console ENABLED (development only; redact before release).");
  console.log(
    api.admin.generatedToken
      ? `Admin token for this run (shown once, never sent to the page): ${api.admin.token}`
      : "Admin token: taken from DARKCIRCLE_ADMIN_TOKEN."
  );
}
// @admin:end
// Ctrl+C and service managers (SIGTERM) both flush the pending autosave before exiting; a second signal
// while the flush runs is ignored rather than cutting the write short.
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    try {
      await api.close();
    } finally {
      process.exit(0);
    }
  });
}
