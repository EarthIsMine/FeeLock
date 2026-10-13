// Test harness: a throwaway anvil chain with the full FeeLock demo deployed by the real forge scripts.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createPublicClient, createWalletClient, http, type Hex, type PublicClient, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import type { Deployment } from '../src/config.js';
import { loadDeployment } from '../src/node.js';

const run = promisify(execFile);
const CONTRACTS = fileURLToPath(new URL('../../../contracts/', import.meta.url));

/** anvil's default account 0 and 1 (public test keys). */
export const DEPLOYER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const TRADER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export interface Anvil {
  rpcUrl: string;
  client: PublicClient;
  deployer: WalletClient;
  deployment: Deployment;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function waitForRpc(client: PublicClient, proc: ChildProcess): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (proc.exitCode !== null) throw new Error(`anvil exited with ${proc.exitCode}`);
    try {
      await client.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('anvil did not start');
}

export interface AnvilOptions {
  /** Fork this RPC instead of starting an empty chain. */
  forkUrl?: string;
  /** Forge scripts to run, in order. Default: the full local demo. */
  scripts?: string[];
  /** deployments/<chainId>.json written before the scripts run (e.g. the official v4 addresses on a fork). */
  seed?: Record<string, unknown>;
}

const LOCAL_DEMO = ['DeployCore', 'DeployFeeLock', 'DemoSetup', 'DemoStateFlip'];

/** Starts anvil on a free port (optionally forking a chain) and deploys with the real forge scripts. */
export async function startAnvil(opts: AnvilOptions = {}): Promise<Anvil> {
  const port = await freePort();
  const rpcUrl = `http://127.0.0.1:${port}`;
  const args = ['--port', String(port), '--silent', ...(opts.forkUrl ? ['--fork-url', opts.forkUrl] : [])];
  const proc = spawn('anvil', args, { stdio: 'ignore' });
  const dir = `deployments/.test-${port}`;
  const stop = async () => {
    proc.kill();
    await rm(`${CONTRACTS}${dir}`, { recursive: true, force: true });
  };
  try {
    const client = createPublicClient({ chain: anvil, transport: http(rpcUrl), pollingInterval: 100 });
    // A fork's first RPC answer can take a while: it fetches the fork block.
    await waitForRpc(client, proc);
    // Broadcast logs go to the throwaway directory too: a fork of chain 143 must not leave mainnet-looking logs behind.
    const env = {
      ...process.env,
      FEELOCK_PK: DEPLOYER_KEY,
      FEELOCK_DEPLOYMENTS_DIR: dir,
      FOUNDRY_BROADCAST: `${CONTRACTS}${dir}/broadcast`,
    };
    const chainId = await client.getChainId();
    if (opts.seed) {
      await mkdir(`${CONTRACTS}${dir}`, { recursive: true });
      await writeFile(`${CONTRACTS}${dir}/${chainId}.json`, JSON.stringify({ ...opts.seed, chainId }));
    }
    for (const script of opts.scripts ?? LOCAL_DEMO) {
      await run('forge', ['script', `script/${script}.s.sol:${script}`, '--rpc-url', rpcUrl, '--broadcast'], {
        cwd: CONTRACTS,
        env,
        maxBuffer: 64 * 1024 * 1024,
      });
    }
    const deployment = await loadDeployment(chainId, `${CONTRACTS}${dir}`);
    const deployer = createWalletClient({ chain: anvil, transport: http(rpcUrl), account: privateKeyToAccount(DEPLOYER_KEY) });
    return { rpcUrl, client, deployer, deployment, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
