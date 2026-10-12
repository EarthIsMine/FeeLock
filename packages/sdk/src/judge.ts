import type { CommitmentResult } from './feeCommit.js';
import { hasHooks, hashPoolKey, isStatic, type PoolKey } from './poolKey.js';
import type { CanonicalPoolResult } from './registry.js';
import type { DualSimulationResult } from './simulate.js';

export type Verdict = 'SAFE' | 'UNVERIFIED' | 'FEE_MISMATCH' | 'LOOKUP_FAILED';

/** Higher is worse. A route is as bad as its worst hop. */
export const VERDICT_SEVERITY: Record<Verdict, number> = {
  SAFE: 0,
  UNVERIFIED: 1,
  LOOKUP_FAILED: 2,
  FEE_MISMATCH: 3,
};

/** Recommended integration policy per verdict. */
export const VERDICT_ACTION: Record<Verdict, string> = {
  SAFE: 'proceed',
  UNVERIFIED: 'requote over SAFE pools only; warn if there is none',
  FEE_MISMATCH: 'block',
  LOOKUP_FAILED: 'hold and retry; the user cannot override',
};

/** Everything the guard learned about one hop that touches the token. */
export interface HopFacts {
  key: PoolKey;
  canonical: CanonicalPoolResult;
  commitment: CommitmentResult;
  dual: DualSimulationResult;
  /** The swapper's fee limit in pips. */
  maxFeePips: number;
  toleranceBps: number;
}

export interface HopJudgement {
  verdict: Verdict;
  reasons: string[];
}

/**
 * Spec §4.2. Order: a measured quote/execution gap (or a committed pool charging above its cap) is FEE_MISMATCH even if
 * another lookup failed, since it is evidence rather than missing data; then any lookup failure; then the pool kind.
 */
export function judgeHop(f: HopFacts): HopJudgement {
  const reasons: string[] = [];
  const isCanonical = f.canonical.status === 'registered' && f.canonical.poolId === hashPoolKey(f.key);
  const tag = isCanonical ? 'canonical pool' : f.canonical.status === 'registered' ? 'not the canonical pool' : null;

  if (f.dual.status === 'compared' && f.dual.divergenceBps > f.toleranceBps) {
    reasons.push(`execution pays ${f.dual.divergenceBps} bps less than the quote (tolerance ${f.toleranceBps})`);
  }
  if (f.commitment.status === 'committed' && f.commitment.currentFee > f.commitment.maxFee) {
    reasons.push(`fee ${f.commitment.currentFee} above committed cap ${f.commitment.maxFee}`);
  }
  if (reasons.length > 0) return { verdict: 'FEE_MISMATCH', reasons: withTag(reasons, tag) };

  for (const [source, r] of [
    ['registry', f.canonical],
    ['fee commitment', f.commitment],
    ['quote/simulation', f.dual],
  ] as const) {
    if (r.status === 'lookup_failed') reasons.push(`${source}: ${r.reason}${r.detail ? ` (${r.detail})` : ''}`);
  }
  if (reasons.length > 0) return { verdict: 'LOOKUP_FAILED', reasons: withTag(reasons, tag) };

  if (isStatic(f.key)) return { verdict: 'SAFE', reasons: withTag([`static fee ${f.key.fee} pips, no hook`], tag) };

  if (f.commitment.status === 'committed') {
    const { maxFee, currentFee } = f.commitment;
    if (maxFee <= f.maxFeePips) {
      return { verdict: 'SAFE', reasons: withTag([`fee ${currentFee} pips, committed cap ${maxFee} within your ${f.maxFeePips}`], tag) };
    }
    return { verdict: 'UNVERIFIED', reasons: withTag([`committed cap ${maxFee} pips above your limit ${f.maxFeePips}`], tag) };
  }
  const why = hasHooks(f.key) ? 'hook pool without a trusted fee cap' : 'dynamic fee without a trusted cap';
  return { verdict: 'UNVERIFIED', reasons: withTag([why], tag) };
}

function withTag(reasons: string[], tag: string | null): string[] {
  return tag ? [...reasons, tag] : reasons;
}

/** The worst hop verdict; an empty route has nothing verified. */
export function judgeRoute(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return 'LOOKUP_FAILED';
  return verdicts.reduce((worst, v) => (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst] ? v : worst));
}
