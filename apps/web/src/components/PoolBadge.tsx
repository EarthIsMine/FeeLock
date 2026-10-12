import { isDynamicFee, isStatic } from '@feelock/sdk';
import type { PoolRow } from '../hooks/useFeeLock';
import { pipsPct } from '../lib/format';

type Tone = 'good' | 'info' | 'warn';

function Badge({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span className={`pool-badge pool-badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Canonical, Fee-committed (max x%), Static, or Unverified dynamic (spec §5). */
export function PoolBadges({ row }: { row: PoolRow }) {
  const { key, canonical, commitment } = row;
  return (
    <span className="pool-badges">
      {canonical && (
        <Badge tone="info" title="Declared by the token issuer in CanonicalPoolRegistry">
          Canonical
        </Badge>
      )}
      {commitment.status === 'committed' && (
        <Badge tone="good" title={`FeeCommitHook: fee ${pipsPct(commitment.currentFee)} now, never above ${pipsPct(commitment.maxFee)}`}>
          Fee-committed · max {pipsPct(commitment.maxFee)}
        </Badge>
      )}
      {isStatic(key) && <Badge tone="good" title="No hook; the fee is fixed in the pool key">Static {pipsPct(key.fee)}</Badge>}
      {!isStatic(key) && commitment.status !== 'committed' && (
        <Badge tone="warn" title="A hook decides the fee at swap time and nothing caps it">
          Unverified {isDynamicFee(key) ? 'dynamic' : 'hook'}
        </Badge>
      )}
      {commitment.status === 'lookup_failed' && <Badge tone="warn">Commitment lookup failed</Badge>}
    </span>
  );
}
