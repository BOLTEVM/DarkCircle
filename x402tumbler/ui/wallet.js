// DarkCircle: Quai wallet bridge (Pelagus, Blip).
//
// Pelagus (desktop extension) and Blip (mobile in-app browser) are the native Quai wallets. Neither is an
// Ethereum provider wearing a different name:
//   * they inject `window.pelagus` / `window.blip` / the generic `window.quai`, NOT `window.ethereum`
//   * they do NOT implement EIP-6963 provider discovery
//   * they speak the `quai_*` namespace (`quai_requestAccounts`, `quai_sendTransaction`, `quai_chainId`),
//     not `eth_*`, and a send's transaction object uses `gasLimit`, not `gas`
// This module talks to the injected object directly. It never touches a private key and never signs or sends
// anything itself: every send opens the wallet's OWN approval screen, and the user decides there.
//
// No network fetch happens here (nothing needs `connect-src` beyond 'self'): chain reads go through the
// server's QuaiRpcClient. This module is only the bridge to the wallet extension.

function detectQuaiWallet() {
  if (typeof window === "undefined") return null;
  const w = window;
  if (w.pelagus && w.pelagus.request) return { provider: w.pelagus, name: "Pelagus" };
  if (w.blip && w.blip.request) return { provider: w.blip, name: "Blip" };
  if (w.quai && w.quai.request) {
    const name = w.quai.isPelagus ? "Pelagus" : w.quai.isBlip ? "Blip" : "Quai wallet";
    return { provider: w.quai, name };
  }
  if (w.ethereum && w.ethereum.request && (w.ethereum.isPelagus || w.ethereum.isBlip)) {
    return { provider: w.ethereum, name: w.ethereum.isBlip ? "Blip" : "Pelagus" };
  }
  return null;
}

export function getWalletName() {
  return detectQuaiWallet()?.name ?? null;
}

export function isWalletAvailable() {
  return detectQuaiWallet() !== null;
}

function provider() {
  const found = detectQuaiWallet();
  if (!found) throw new Error("No Quai wallet found. Install Pelagus (desktop) or open this page in Blip.");
  return found.provider;
}

/** Prompts the wallet's own connect UI. The user chooses which account to expose; we never see a key. */
export async function connect() {
  const accounts = await provider().request({ method: "quai_requestAccounts" });
  if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("The wallet returned no accounts.");
  return accounts[0];
}

/** Accounts already authorised, without prompting. Empty if the wallet has not been connected this session. */
export async function connectedAccounts() {
  try {
    const accounts = await provider().request({ method: "quai_accounts" });
    return Array.isArray(accounts) ? accounts : [];
  } catch {
    return [];
  }
}

export async function chainId() {
  const hex = await provider().request({ method: "quai_chainId" });
  return Number(hex);
}

/** The wallet's selected account and chain, read now (not remembered): both can change at any moment. */
export async function current() {
  const [accounts, id] = await Promise.all([connectedAccounts(), chainId()]);
  return { address: accounts[0] ?? null, chainId: id };
}

function toHexQuantity(value) {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && value.startsWith("0x") ? value : "0x" + BigInt(value).toString(16);
}

function accessListParam(list) {
  return Array.isArray(list) ? list.map((e) => ({ address: e.address, storageKeys: [...(e.storageKeys ?? [])] })) : undefined;
}

async function send(params) {
  const hash = await provider().request({ method: "quai_sendTransaction", params: [params] });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`The wallet returned an unexpected transaction hash: ${String(hash)}`);
  return hash;
}

/**
 * Sends a CONTRACT CREATION transaction (`to` is always omitted) and returns the hash the wallet reports.
 * `accessList` comes from the server's simulation of this exact transaction: on Quai a constructor that calls
 * another contract reverts and burns the whole gas limit when the transaction carries no list.
 */
export async function sendCreation({ from, data, gasLimit, accessList }) {
  const params = { from, data };
  const gas = toHexQuantity(gasLimit);
  if (gas) params.gasLimit = gas;
  const list = accessListParam(accessList);
  if (list) params.accessList = list;
  return send(params);
}

/** Sends an ordinary transaction (a call or a transfer) exactly as the server planned and simulated it. */
export async function sendTransaction({ from, to, data, value, gasLimit, accessList }) {
  if (!to) throw new Error("A transaction needs a recipient; use sendCreation for a deployment.");
  const params = { from, to, data: data || "0x" };
  const v = toHexQuantity(value);
  if (v && v !== "0x0") params.value = v;
  const gas = toHexQuantity(gasLimit);
  if (gas) params.gasLimit = gas;
  const list = accessListParam(accessList);
  if (list) params.accessList = list;
  return send(params);
}
