import type { FeeLockState, PoolRow } from '../hooks/useFeeLock';
import type { FlowState } from '../hooks/useSwapFlow';
import type { CandidateSource } from '../lib/pools';
import { hashPoolKey } from '../lib/sdk';
import { FeeCompare } from './FeeCompare';
import { PoolList } from './PoolList';
import { VerdictCard } from './VerdictCard';

interface Props {
  quotes: FeeLockState;
  flow: FlowState;
  source?: CandidateSource;
  symbol: string;
  decimals: number;
}

/** Every pool, every verdict and the side-by-side, for whoever wants them. Closed by default. */
export function Details({ quotes, flow, source, symbol, decimals }: Props) {
  const guarded = flow.guard;
  // Overlay the review's guard results on the live quotes.
  const rows: PoolRow[] = quotes.rows.map((row) => {
    const g = guarded?.candidates.find((c) => hashPoolKey(c.key) === row.poolId);
    return g ? { ...row, guard: g.result } : row;
  });
  const bestSafe = guarded?.best ? rows.find((r) => r.poolId === hashPoolKey(guarded.best!.key)) : undefined;
  const merged: FeeLockState = { ...quotes, rows, bestSafe };
  const routeId = flow.route ? hashPoolKey(flow.route.key) : undefined;
  return (
    <details className="glass details">
      <summary>
        <span>Every pool, in detail</span>
        <small>
          {rows.length} pools · from {source === 'indexer' ? 'the indexer' : 'the deployments file'}
          {!guarded && ' · review a swap to see what each one really pays'}
        </small>
      </summary>
      <div className="details-body">
        <PoolList rows={rows} guardOn={!!guarded} routeId={routeId} bestQuoteId={quotes.bestQuote?.poolId} symbol={symbol} decimals={decimals} />
        {guarded && <VerdictCard rows={rows} guardOn routeId={routeId} />}
        {guarded && <FeeCompare feelock={merged} guardOn symbol={symbol} decimals={decimals} />}
      </div>
    </details>
  );
}
