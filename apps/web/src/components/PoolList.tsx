import type { PoolRow } from '../hooks/useFeeLock';
import { addressUrl } from '../lib/chain';
import { amount, bpsPct, lossBps, short } from '../lib/format';
import { PoolBadges } from './PoolBadge';

interface Props {
  rows: PoolRow[];
  guardOn: boolean;
  /** The pool the swap will use. */
  routeId?: string;
  bestQuoteId?: string;
  symbol: string;
  decimals: number;
}

/** One row per candidate pool, like a provider comparison: what it quotes, and with FeeLock on, what it really pays. */
export function PoolList({ rows, guardOn, routeId, bestQuoteId, symbol, decimals }: Props) {
  if (rows.length === 0) return <p className="muted">Enter an amount to quote the pools.</p>;
  return (
    <div className="pool-table" role="table">
      <div className="pool-row pool-head" role="row">
        <span role="columnheader">Pool</span>
        <span role="columnheader">Quoted</span>
        <span role="columnheader">{guardOn ? 'Execution (simulated)' : 'Execution'}</span>
      </div>
      {rows.map((row) => {
        const dual = row.guard?.hops[0]?.dual;
        const simulated = dual?.status === 'compared' ? dual.simulated : undefined;
        const loss = row.quoted !== undefined && simulated !== undefined ? lossBps(row.quoted, simulated) : undefined;
        return (
          <div key={row.poolId} role="row" className={`pool-row ${row.poolId === routeId ? 'is-route' : ''}`}>
            <span role="cell" className="pool-name">
              <span>
                <strong>{row.label}</strong>{' '}
                <a className="muted" href={addressUrl(row.key.hooks)} target="_blank" rel="noreferrer">
                  hook {short(row.key.hooks)}
                </a>
              </span>
              <PoolBadges row={row} />
            </span>
            <span role="cell" className="num">
              {row.quoted !== undefined ? `${amount(row.quoted, decimals)} ${symbol}` : <span className="error">quote failed</span>}
              {row.poolId === bestQuoteId && <span className="tag">best quote</span>}
            </span>
            <span role="cell" className="num">
              {!guardOn && <span className="muted">not checked</span>}
              {guardOn && simulated !== undefined && (
                <>
                  {amount(simulated, decimals)} {symbol}
                  {loss !== undefined && loss > 0 && <span className="delta-bad">−{bpsPct(loss)} vs quote</span>}
                  {loss === 0 && <span className="delta-good">= quote</span>}
                </>
              )}
              {guardOn && simulated === undefined && <span className="muted">{row.guard ? 'not simulated' : 'checking…'}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}
