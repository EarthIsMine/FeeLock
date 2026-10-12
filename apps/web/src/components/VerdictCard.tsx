import { VERDICT_ACTION, type Verdict } from '@feelock/sdk';
import type { PoolRow } from '../hooks/useFeeLock';

const TONE: Record<Verdict, string> = { SAFE: 'good', UNVERIFIED: 'warn', LOOKUP_FAILED: 'warn', FEE_MISMATCH: 'bad' };
const TITLE: Record<Verdict, string> = {
  SAFE: 'Safe: execution matches the quote',
  UNVERIFIED: 'Unverified: nothing caps this fee',
  LOOKUP_FAILED: 'Hold: could not verify',
  FEE_MISMATCH: 'Blocked: execution pays less than the quote',
};

/** The guard's verdict per candidate, with its reasons as label/value rows. */
export function VerdictCard({ rows, guardOn, routeId }: { rows: PoolRow[]; guardOn: boolean; routeId?: string }) {
  if (!guardOn) {
    return (
      <section className="card verdict verdict-off">
        <h2>No checks</h2>
        <p className="muted">
          FeeLock is off. The swap goes to whichever pool quotes the most. A hook can show the quoter one fee and charge
          your swap another; nothing here would notice.
        </p>
      </section>
    );
  }
  const judged = rows.filter((r) => r.guard);
  if (judged.length === 0) return <section className="card verdict"><p className="muted">Checking pools…</p></section>;
  return (
    <section className="card verdict">
      <h2>FeeLock verdicts</h2>
      {judged.map((row) => {
        const r = row.guard!;
        const reasons = r.hops[0]?.reasons ?? r.errors ?? [];
        return (
          <div key={row.poolId} className={`verdict-row tone-${TONE[r.verdict]}`}>
            <div className="verdict-head">
              <span className="verdict-pill">{r.verdict}</span>
              <strong>{row.label}</strong>
              {row.poolId === routeId && <span className="tag">your route</span>}
            </div>
            <p className="verdict-title">{TITLE[r.verdict]}</p>
            <dl className="reasons">
              {reasons.map((reason) => (
                <div key={reason}>
                  <dt>•</dt>
                  <dd>{reason}</dd>
                </div>
              ))}
              <div>
                <dt>→</dt>
                <dd className="muted">{VERDICT_ACTION[r.verdict]}</dd>
              </div>
            </dl>
          </div>
        );
      })}
    </section>
  );
}
