import { fetchIndexedPools, type CandidatePool } from '@feelock/sdk';
import { CHAIN_ID } from './chain';
import { deployment } from './deployments';

export type CandidateSource = 'indexer' | 'deployments';

const demoPools: CandidatePool[] = deployment?.demo?.pools.map((p) => ({ key: p.key, poolId: p.poolId, label: p.label })) ?? [];
const demoLabel = (poolId: string) => deployment?.demo?.pools.find((p) => p.poolId === poolId)?.label;

/**
 * Candidate pools for the demo token: from the indexer when VITE_POOLS_API is set and answers, otherwise the
 * deployments file. Either way the guard checks every pool itself.
 */
export async function loadCandidates(): Promise<{ pools: CandidatePool[]; source: CandidateSource; note?: string }> {
  const api = import.meta.env.VITE_POOLS_API as string | undefined;
  const token = deployment?.demo?.token;
  if (!api || !token) return { pools: demoPools, source: 'deployments' };
  try {
    const pools = await fetchIndexedPools(api, CHAIN_ID, token, { labelOf: demoLabel });
    return pools.length > 0 ? { pools, source: 'indexer' } : { pools: demoPools, source: 'deployments', note: 'indexer has no pools yet' };
  } catch (e) {
    return { pools: demoPools, source: 'deployments', note: `indexer unavailable (${e instanceof Error ? e.message : e})` };
  }
}
