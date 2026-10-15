/**
 * A Hardhat node on this machine with the DarkOrder protocol deployed: used by
 * `pnpm rehearse:local` to walk the whole product (founding, charter, crest, roles,
 * tribute) against a real chain.
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
  if (!existsSync(file)) throw new Error(`Missing ${file}: run \`pnpm --filter @darkorder/contracts build\` first.`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Starts `hardhat node` and resolves once it serves JSON-RPC. */
export function startHardhatNode({ port = 8646, timeoutMs = 90_000 } = {}) {
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

/** Deploys the registry, token stack and factory, wired, owned by no one (the factory cuts itself out per guild). */
export async function deployProtocol(url) {
  // cacheTimeout -1: ethers v6 otherwise replays identical requests made within 250 ms, nonces included.
  const provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1, staticNetwork: true });
  const accounts = await provider.send('eth_accounts', []);
  const founder = await provider.getSigner(accounts[0]);
  const registryArt = artifact('GuildNameRegistry');
  const stackArt = artifact('TokenStackDeployer');
  const factoryArt = artifact('GuildFactory');

  const registry = await new ContractFactory(registryArt.abi, registryArt.bytecode, founder).deploy();
  await registry.waitForDeployment();
  const tokenStack = await new ContractFactory(stackArt.abi, stackArt.bytecode, founder).deploy();
  await tokenStack.waitForDeployment();
  const factory = await new ContractFactory(factoryArt.abi, factoryArt.bytecode, founder).deploy(
    await registry.getAddress(),
    await tokenStack.getAddress()
  );
  await factory.waitForDeployment();
  const registryAddr = await registry.getAddress();
  const wired = await new ContractFactory(registryArt.abi, registryArt.bytecode, founder).attach(registryAddr);
  await (await wired.wire(await factory.getAddress())).wait();

  return { provider, accounts, registry: registryAddr, factory: await factory.getAddress() };
}
