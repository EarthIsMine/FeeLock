import {
  getCanonicalPool,
  getCommitment,
  hashPoolKey,
  type CanonicalPoolResult,
  type CommitmentResult,
} from '@feelock/sdk';
import { useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { publicClient } from '../lib/chain';
import { deployment } from '../lib/deployments';
import { guardCandidates, quoteCandidates, type CandidateGuard, type PoolKey } from '../lib/sdk';

/** Simulations run from this address until a wallet connects; it is never funded, the simulation overrides it. */
export const OBSERVER = '0x00000000000000000000000000000000000fee10' as Address;
export const REFRESH_MS = 10_000;

export interface PoolRow {
  key: PoolKey;
  poolId: string;
  label: string;
  quoted?: bigint;
  quoteError?: string;
  canonical: boolean;
  commitment: CommitmentResult;
  /** Present when FeeLock is on. */
  guard?: CandidateGuard['result'];
}

export interface FeeLockState {
  rows: PoolRow[];
  /** Best quoted pool: what a naive router picks. */
  bestQuote?: PoolRow;
  /** Best SAFE pool by simulated output (FeeLock on). */
  bestSafe?: PoolRow;
  canonical?: CanonicalPoolResult;
  loading: boolean;
  error?: string;
  updatedAt?: number;
}

const demo = deployment?.demo;
const config = deployment?.config;
const candidates = demo?.pools.map((p) => p.key) ?? [];
const labelOf = (key: PoolKey) => demo?.pools.find((p) => p.poolId === hashPoolKey(key))?.label ?? hashPoolKey(key).slice(0, 10);

/**
 * Quotes every demo pool and reads its canonical/commitment status; with FeeLock on, also runs the guard on each.
 * Re-runs when the inputs change (debounced) and every REFRESH_MS.
 */
export function useFeeLock(amountIn: bigint | undefined, guardOn: boolean, account: Address | undefined, maxFeePips: number): FeeLockState {
  const [state, setState] = useState<FeeLockState>({ rows: [], loading: false });
  const run = useRef(0);

  useEffect(() => {
    if (!config || !demo || !amountIn || amountIn <= 0n) {
      setState({ rows: [], loading: false });
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      const id = ++run.current;
      setState((s) => ({ ...s, loading: true }));
      try {
        const trade = { zeroForOne: true, amountIn };
        let rows: PoolRow[];
        let canonical: CanonicalPoolResult | undefined;
        let bestSafeKey: PoolKey | undefined;
        if (guardOn) {
          // The guard already quotes, reads the registry and the commitment per pool: reuse it, do not ask twice.
          const guarded = await guardCandidates({
            client: publicClient,
            config,
            account: account ?? OBSERVER,
            token: demo.token,
            candidates,
            maxFeePips,
            ...trade,
          });
          if (id !== run.current) return;
          bestSafeKey = guarded.best?.key;
          rows = guarded.candidates.map(({ key, result }): PoolRow => {
            const hop = result.hops[0];
            const dual = hop?.dual;
            canonical ??= hop?.canonical;
            return {
              key,
              poolId: hashPoolKey(key),
              label: labelOf(key),
              quoted: dual?.status === 'compared' ? dual.quoted : undefined,
              quoteError: dual && dual.status !== 'compared' ? (dual.detail ?? dual.reason) : undefined,
              canonical: hop?.canonical.status === 'registered' && hop.canonical.poolId === hashPoolKey(key),
              commitment: hop?.commitment ?? { status: 'lookup_failed', reason: 'format' },
              guard: result,
            };
          });
        } else {
          const [quotes, canon, commitments] = await Promise.all([
            quoteCandidates(publicClient, config, candidates, trade),
            getCanonicalPool(publicClient, config, demo.token),
            Promise.all(candidates.map((key) => getCommitment(publicClient, config, key))),
          ]);
          if (id !== run.current) return;
          canonical = canon;
          rows = candidates.map((key, i): PoolRow => {
            const poolId = hashPoolKey(key);
            const q = quotes[i]!.quote;
            return {
              key,
              poolId,
              label: labelOf(key),
              quoted: q.status === 'quoted' ? q.amountOut : undefined,
              quoteError: q.status === 'quoted' ? undefined : (q.detail ?? q.reason),
              canonical: canon.status === 'registered' && canon.poolId === poolId,
              commitment: commitments[i]!,
            };
          });
        }
        const quoted = rows.filter((r) => r.quoted !== undefined);
        const bestQuote = quoted.reduce<PoolRow | undefined>((b, r) => (!b || r.quoted! > b.quoted! ? r : b), undefined);
        const bestSafe = bestSafeKey ? rows.find((r) => r.poolId === hashPoolKey(bestSafeKey!)) : undefined;
        setState({ rows, bestQuote, bestSafe, canonical, loading: false, updatedAt: Date.now() });
      } catch (e) {
        if (id === run.current) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
      }
      timer = setTimeout(load, REFRESH_MS);
    };
    timer = setTimeout(load, 300);
    return () => {
      clearTimeout(timer);
      run.current++;
    };
  }, [amountIn, guardOn, account, maxFeePips]);

  return state;
}
