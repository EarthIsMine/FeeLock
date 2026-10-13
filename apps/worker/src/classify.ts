import { getCommitment, hashPoolKey, isStatic, type NetworkConfig, type PoolKey } from '@feelock/sdk';
import type { Hex, PublicClient } from 'viem';

/**
 * static: no hook, fee fixed in the key. fee-committed: a trusted FeeCommitHook holds a cap for it.
 * unverified: any other hook or dynamic fee. unknown: the commitment lookup failed (never guessed as unverified).
 */
export type PoolKind = 'static' | 'fee-committed' | 'unverified' | 'unknown';

export interface ClassifiedPool {
  poolId: Hex;
  key: PoolKey;
  kind: PoolKind;
  /** Declared canonical for one of its tokens. */
  canonical: boolean;
  canonicalFor?: Hex;
  commitment?: { maxFee: number; currentFee: number };
  /** Why kind is unknown. */
  reason?: string;
  initializedAt: string;
}

export async function classifyPool(
  client: PublicClient,
  config: NetworkConfig,
  pool: { poolId: Hex; key: PoolKey; blockNumber: bigint },
  canonicalTokenOf: ReadonlyMap<string, Hex>,
): Promise<ClassifiedPool> {
  const poolId = hashPoolKey(pool.key);
  const canonicalFor = canonicalTokenOf.get(poolId);
  const base = {
    poolId,
    key: pool.key,
    canonical: canonicalFor !== undefined,
    ...(canonicalFor ? { canonicalFor } : {}),
    initializedAt: pool.blockNumber.toString(),
  };
  if (poolId !== pool.poolId.toLowerCase()) return { ...base, kind: 'unknown', reason: 'event id does not hash from its key' };
  if (isStatic(pool.key)) return { ...base, kind: 'static' };
  const c = await getCommitment(client, config, pool.key);
  if (c.status === 'committed') {
    return { ...base, kind: 'fee-committed', commitment: { maxFee: c.maxFee, currentFee: c.currentFee } };
  }
  if (c.status === 'not_committed') return { ...base, kind: 'unverified' };
  return { ...base, kind: 'unknown', reason: `${c.reason}${c.detail ? `: ${c.detail}` : ''}` };
}
