import { isAddress, keccak256, encodePacked, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { canonicalPoolRegistryAbi, iPoolManagerAbi } from './abi/index.js';
import type { NetworkConfig } from './config.js';
import { checkChain, failed, hasCode, sameAddress, type Failed, type LookupOptions } from './lookup.js';
import { hasCurrency, hashPoolKey, poolKeyError, type PoolKey } from './poolKey.js';

/** v4-core StateLibrary.POOLS_SLOT; CanonicalPoolRegistry and the Monad fork test check the same value. */
export const POOLS_SLOT = 6n;

export type CanonicalPoolResult =
  | {
      status: 'registered';
      chainId: number;
      poolManager: Address;
      poolId: Hex;
      key: PoolKey;
      issuer: Address;
      declaredAt: bigint;
    }
  | { status: 'not_registered' }
  | Failed;

/** pools[poolId].slot0 in PoolManager storage; its low 160 bits are sqrtPriceX96 (0 = uninitialized). */
export function poolSlot0(poolId: Hex): Hex {
  return keccak256(encodePacked(['bytes32', 'uint256'], [poolId, POOLS_SLOT]));
}

export async function isPoolInitialized(
  client: PublicClient,
  poolManager: Address,
  poolId: Hex,
  opts: LookupOptions = {},
): Promise<boolean> {
  const slot0 = await client.readContract({
    address: poolManager,
    abi: iPoolManagerAbi,
    functionName: 'extsload',
    args: [poolSlot0(poolId)],
    blockNumber: opts.blockNumber,
  });
  return (BigInt(slot0) & ((1n << 160n) - 1n)) !== 0n;
}

/**
 * The token's canonical pool from CanonicalPoolRegistry. `not_registered` only when the registry, verified to be the
 * configured one on the configured chain, answers that nothing was declared. Every other problem is `lookup_failed`.
 */
export async function getCanonicalPool(
  client: PublicClient,
  config: NetworkConfig,
  token: Address,
  opts: LookupOptions = {},
): Promise<CanonicalPoolResult> {
  if (typeof token !== 'string' || !isAddress(token, { strict: false }) || sameAddress(token, zeroAddress)) {
    return failed('format', 'token address');
  }
  const chain = await checkChain(client, config);
  if (chain) return chain;

  let declared: boolean;
  let pool: { poolId: Hex; key: PoolKey; issuer: Address; declaredAt: bigint };
  try {
    if (!(await hasCode(client, config.registry, opts))) return failed('contract-missing', 'registry');
    const manager = await client.readContract({
      address: config.registry,
      abi: canonicalPoolRegistryAbi,
      functionName: 'poolManager',
      blockNumber: opts.blockNumber,
    });
    if (!sameAddress(manager, config.poolManager)) return failed('contract-mismatch', 'registry points to another PoolManager');
    [declared, pool] = await client.readContract({
      address: config.registry,
      abi: canonicalPoolRegistryAbi,
      functionName: 'getCanonicalPool',
      args: [token],
      blockNumber: opts.blockNumber,
    });
  } catch (e) {
    return failed('rpc', e);
  }
  if (!declared) return { status: 'not_registered' };

  const key: PoolKey = { ...pool.key };
  if (poolKeyError(key) || !hasCurrency(key, token)) return failed('record-mismatch', 'declared key');
  const poolId = hashPoolKey(key);
  if (poolId !== pool.poolId.toLowerCase()) return failed('record-mismatch', 'poolId does not hash from key');

  try {
    if (!(await isPoolInitialized(client, config.poolManager, poolId, opts))) return failed('pool-uninitialized');
  } catch (e) {
    return failed('rpc', e);
  }
  return {
    status: 'registered',
    chainId: config.chainId,
    poolManager: config.poolManager,
    poolId,
    key,
    issuer: pool.issuer,
    declaredAt: pool.declaredAt,
  };
}
