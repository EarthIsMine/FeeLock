import { fallback, getAddress, http, isAddress, zeroAddress, type Address, type Chain, type Hex, type Transport } from 'viem';
import { anvil, monad, monadTestnet } from 'viem/chains';
import { hashPoolKey, poolKeyError, type PoolKey } from './poolKey.js';

export const MONAD_MAINNET = 143;
export const MONAD_TESTNET = 10_143;
export const ANVIL = 31_337;

/** A FeeCommitHook deployment the SDK trusts: address and runtime code hash must both match on chain. */
export interface TrustedFeeCommitHook {
  address: Address;
  codeHash: Hex;
}

export interface NetworkConfig {
  chainId: number;
  poolManager: Address;
  quoter: Address;
  router: Address;
  registry: Address;
  stateView?: Address;
  trustedFeeCommitHooks: readonly TrustedFeeCommitHook[];
  /** First block worth scanning for pool events. */
  deployBlock: bigint;
}

export interface DemoPool {
  label: string;
  poolId: Hex;
  key: PoolKey;
}

export interface Deployment {
  config: NetworkConfig;
  /** Present when DemoSetup ran on this chain. */
  demo?: {
    token: Address;
    launchpad: Address;
    seeder: Address;
    attackHook?: Address;
    pools: readonly DemoPool[];
  };
}

export class DeploymentError extends Error {
  override name = 'DeploymentError';
}

const HASH32 = /^0x[0-9a-fA-F]{64}$/;

function field(obj: Record<string, unknown>, name: string, path: string): unknown {
  if (!(name in obj)) throw new DeploymentError(`${path}${name}: missing`);
  return obj[name];
}

function address(obj: Record<string, unknown>, name: string, path = ''): Address {
  const v = field(obj, name, path);
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw new DeploymentError(`${path}${name}: not an address`);
  return getAddress(v);
}

/** A deployed contract: a valid address that is not address(0). */
function deployed(obj: Record<string, unknown>, name: string, path = ''): Address {
  const a = address(obj, name, path);
  if (a === zeroAddress) throw new DeploymentError(`${path}${name}: not deployed`);
  return a;
}

function optional(obj: Record<string, unknown>, name: string, path = ''): Address | undefined {
  if (!(name in obj)) return undefined;
  const a = address(obj, name, path);
  return a === zeroAddress ? undefined : a;
}

function record(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new DeploymentError(`${path}: not an object`);
  return v as Record<string, unknown>;
}

function poolKey(v: unknown, path: string): PoolKey {
  const o = record(v, path);
  const key: PoolKey = {
    currency0: address(o, 'currency0', `${path}.`),
    currency1: address(o, 'currency1', `${path}.`),
    fee: Number(field(o, 'fee', `${path}.`)),
    tickSpacing: Number(field(o, 'tickSpacing', `${path}.`)),
    hooks: address(o, 'hooks', `${path}.`),
  };
  const error = poolKeyError(key);
  if (error) throw new DeploymentError(`${path}: ${error}`);
  return key;
}

/**
 * Validates a deployments/<chainId>.json object (as written by contracts/script/DeploymentIO.sol). Throws
 * DeploymentError on anything malformed, including a recorded poolId that does not hash from its key.
 * @param expectedChainId if given, the file must be for this chain.
 */
export function parseDeployment(json: unknown, expectedChainId?: number): Deployment {
  const root = record(json, 'deployment');
  const chainId = Number(field(root, 'chainId', ''));
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new DeploymentError('chainId: invalid');
  if (expectedChainId !== undefined && chainId !== expectedChainId) {
    throw new DeploymentError(`chainId: file is for ${chainId}, expected ${expectedChainId}`);
  }
  const deployBlock = field(root, 'deployBlock', '');
  if (typeof deployBlock !== 'number' || !Number.isSafeInteger(deployBlock) || deployBlock < 0) {
    throw new DeploymentError('deployBlock: invalid');
  }

  const feeCommitHook = deployed(root, 'feeCommitHook');
  const codeHash = field(root, 'feeCommitHookCodeHash', '');
  if (typeof codeHash !== 'string' || !HASH32.test(codeHash) || /^0x0+$/.test(codeHash)) {
    throw new DeploymentError('feeCommitHookCodeHash: invalid');
  }

  const config: NetworkConfig = {
    chainId,
    poolManager: deployed(root, 'poolManager'),
    quoter: deployed(root, 'quoter'),
    router: deployed(root, 'router'),
    registry: deployed(root, 'registry'),
    stateView: optional(root, 'stateView'),
    trustedFeeCommitHooks: [{ address: feeCommitHook, codeHash: codeHash.toLowerCase() as Hex }],
    deployBlock: BigInt(deployBlock),
  };

  if (!('demo' in root)) return { config };
  const demo = record(root.demo, 'demo');
  const token = optional(demo, 'token', 'demo.');
  if (!token) return { config };

  const rawPools = field(demo, 'pools', 'demo.');
  if (!Array.isArray(rawPools)) throw new DeploymentError('demo.pools: not an array');
  const pools = rawPools.map((p, i): DemoPool => {
    const path = `demo.pools[${i}]`;
    const o = record(p, path);
    const label = field(o, 'label', `${path}.`);
    const poolId = field(o, 'poolId', `${path}.`);
    if (typeof label !== 'string') throw new DeploymentError(`${path}.label: not a string`);
    if (typeof poolId !== 'string' || !HASH32.test(poolId)) throw new DeploymentError(`${path}.poolId: invalid`);
    const key = poolKey(o.key, `${path}.key`);
    if (hashPoolKey(key) !== poolId.toLowerCase()) throw new DeploymentError(`${path}.poolId: does not match key`);
    return { label, poolId: poolId.toLowerCase() as Hex, key };
  });

  return {
    config,
    demo: {
      token,
      launchpad: deployed(demo, 'launchpad', 'demo.'),
      seeder: deployed(demo, 'seeder', 'demo.'),
      attackHook: optional(demo, 'attackHook', 'demo.'),
      pools,
    },
  };
}

export function chainFor(chainId: number): Chain {
  switch (chainId) {
    case MONAD_MAINNET:
      return monad;
    case MONAD_TESTNET:
      return monadTestnet;
    case ANVIL:
      return anvil;
    default:
      throw new Error(`unsupported chain ${chainId}`);
  }
}

/**
 * RPC URLs for a chain from an env-like record, primary first. Works with process.env in Node and with a plain object
 * built from import.meta.env in the browser.
 */
export function rpcUrlsFromEnv(chainId: number, env: Record<string, string | undefined>): string[] {
  const pick = (...names: string[]) => names.map((n) => env[n]?.trim()).filter((u): u is string => !!u);
  switch (chainId) {
    case MONAD_MAINNET:
      return pick('MONAD_MAINNET_RPC_URL', 'MONAD_MAINNET_RPC_URL_FALLBACK');
    case MONAD_TESTNET:
      return pick('MONAD_TESTNET_RPC_URL', 'MONAD_TESTNET_RPC_URL_FALLBACK');
    case ANVIL: {
      const urls = pick('ANVIL_RPC_URL');
      return urls.length > 0 ? urls : ['http://127.0.0.1:8545'];
    }
    default:
      return [];
  }
}

/** One URL: plain http. Several: viem fallback, trying them in order when a request fails. */
export function rpcTransport(urls: readonly string[]): Transport {
  if (urls.length === 0) throw new Error('no RPC URL configured');
  if (urls.length === 1) return http(urls[0]);
  return fallback(urls.map((u) => http(u)));
}
