/**
 * A Hardhat node on this machine with the Dark Questate contracts deployed: used by the core
 * end-to-end test and by `pnpm local:market` for trying the site against a real chain.
 *
 * Never point this at a public network: the node's accounts are Hardhat's well-known dev keys.
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ContractFactory, JsonRpcProvider } from 'ethers';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONTRACTS_ROOT = path.resolve(HERE, '../..');

export function artifact(name) {
  const file = path.join(CONTRACTS_ROOT, 'artifacts/contracts', `${name}.sol`, `${name}.json`);
  if (!existsSync(file)) throw new Error(`Missing ${file}: run \`pnpm --filter @darkquestate/contracts build\` first.`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Starts `hardhat node` and resolves once it serves JSON-RPC. */
export function startHardhatNode({ port = 8545, timeoutMs = 90_000 } = {}) {
  const cli = path.join(CONTRACTS_ROOT, 'node_modules/hardhat/internal/cli/bootstrap.js');
  const child = spawn(process.execPath, [cli, 'node', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: CONTRACTS_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: 'true' },
  });
  let log = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`hardhat node did not start within ${timeoutMs} ms:\n${log}`));
    }, timeoutMs);
    const onData = (chunk) => {
      log += chunk.toString();
      if (log.includes('Started HTTP and WebSocket JSON-RPC server')) {
        clearTimeout(timer);
        resolve({
          url: `http://127.0.0.1:${port}`,
          stop: () =>
            new Promise((done) => {
              if (child.exitCode !== null) return done();
              child.once('exit', () => done());
              child.kill();
            }),
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`hardhat node exited with ${code}:\n${log}`));
    });
  });
}

/** Deploys the registry and brokerage, owned by the node's first account. */
export async function deployMarket(url) {
  // cacheTimeout -1: ethers v6 otherwise replays identical requests made within 250 ms, nonces included.
  const provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1, staticNetwork: true });
  const accounts = await provider.send('eth_accounts', []);
  const operator = await provider.getSigner(accounts[0]);
  const deedArt = artifact('QuestateDeed');
  const deskArt = artifact('QuestateBrokerage');
  const deed = await new ContractFactory(deedArt.abi, deedArt.bytecode, operator).deploy(accounts[0]);
  await deed.waitForDeployment();
  const desk = await new ContractFactory(deskArt.abi, deskArt.bytecode, operator).deploy(await deed.getAddress(), accounts[0]);
  await desk.waitForDeployment();
  const block = await provider.getBlockNumber();
  return { provider, accounts, deed: await deed.getAddress(), brokerage: await desk.getAddress(), fromBlock: block };
}

/** Gives every dev account `amountWei` (Hardhat only): realistic property prices exceed the default 10,000. */
export async function fundAccounts(provider, accounts, amountWei) {
  for (const a of accounts) await provider.send('hardhat_setBalance', [a, '0x' + amountWei.toString(16)]);
}
