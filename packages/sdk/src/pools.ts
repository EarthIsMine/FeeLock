import { getAddress, type Address, type Hex } from 'viem';
import { hashPoolKey, poolKeyError, type PoolKey } from './poolKey.js';

/** A candidate pool for a token, from the indexer (apps/worker) or a deployments file. */
export interface CandidatePool {
  key: PoolKey;
  poolId: Hex;
  label: string;
  /** Indexer classification, when the pool came from the indexer. */
  kind?: 'static' | 'fee-committed' | 'unverified' | 'unknown';
  canonical?: boolean;
}

/**
 * Pools trading `token` from a FeeLock indexer (`GET <api>/pools?token=`). Every key is validated and re-hashed;
 * a response that is not for `chainId` or does not parse throws, so callers can fall back to their deployments file.
 * The classification is only a hint: the guard still checks every pool itself.
 */
export async function fetchIndexedPools(
  api: string,
  chainId: number,
  token: Address,
  opts: { timeoutMs?: number; labelOf?: (poolId: Hex) => string | undefined } = {},
): Promise<CandidatePool[]> {
  const url = `${api.replace(/\/$/, '')}/pools?token=${token}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000) });
  if (!res.ok) throw new Error(`indexer answered ${res.status}`);
  const body = (await res.json()) as { chainId?: unknown; pools?: unknown };
  if (body.chainId !== chainId) throw new Error(`indexer is for chain ${String(body.chainId)}, not ${chainId}`);
  if (!Array.isArray(body.pools)) throw new Error('indexer response has no pools');
  return body.pools.map((raw, i): CandidatePool => {
    const p = raw as { key?: PoolKey; poolId?: string; kind?: CandidatePool['kind']; canonical?: boolean };
    if (!p.key || typeof p.poolId !== 'string') throw new Error(`pool ${i}: missing key or poolId`);
    const key: PoolKey = {
      currency0: getAddress(p.key.currency0),
      currency1: getAddress(p.key.currency1),
      fee: Number(p.key.fee),
      tickSpacing: Number(p.key.tickSpacing),
      hooks: getAddress(p.key.hooks),
    };
    const error = poolKeyError(key);
    if (error) throw new Error(`pool ${i}: ${error}`);
    const poolId = hashPoolKey(key);
    if (poolId !== p.poolId.toLowerCase()) throw new Error(`pool ${i}: poolId does not hash from its key`);
    return {
      key,
      poolId,
      label: opts.labelOf?.(poolId) ?? `${p.kind ?? 'pool'} ${poolId.slice(0, 8)}`,
      ...(p.kind ? { kind: p.kind } : {}),
      ...(p.canonical !== undefined ? { canonical: p.canonical } : {}),
    };
  });
}
