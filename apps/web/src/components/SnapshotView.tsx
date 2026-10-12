import { txUrl } from '../lib/chain';
import { amount, bpsPct, pipsPct } from '../lib/format';
import type { Snapshot } from '../lib/snapshot';

const TONE = { SAFE: 'good', UNVERIFIED: 'warn', LOOKUP_FAILED: 'warn', FEE_MISMATCH: 'bad' } as const;

/** Read-only view of a recorded snapshot, clearly labelled, with swapping disabled. */
export function SnapshotView({ snap, reason }: { snap: Snapshot; reason: string }) {
  const { symbol, decimals } = snap.token;
  const out = (v: string | null) => (v === null ? '—' : `${amount(BigInt(v), decimals)} ${symbol}`);
  return (
    <div className="col">
      <section className="card snapshot-banner" role="status">
        <strong>Recorded snapshot</strong> · block {snap.blockNumber} · {new Date(snap.recordedAt).toLocaleString()}
        <p className="muted small">
          {reason} These numbers are not live, and swapping is disabled until the RPC answers again.
        </p>
      </section>
      <section className="card">
        <h2>
          Pools for MON → {symbol} · {amount(BigInt(snap.amountIn), 18, 6)} MON
        </h2>
        {snap.rows.map((r) => (
          <div key={r.poolId} className={`verdict-row tone-${TONE[r.verdict]}`}>
            <div className="verdict-head">
              <span className="verdict-pill">{r.verdict}</span>
              <strong>{r.label}</strong>
              {r.canonical && <span className="pool-badge pool-badge-info">Canonical</span>}
              {r.commitment && <span className="pool-badge pool-badge-good">Fee-committed · max {pipsPct(r.commitment.maxFee)}</span>}
              {r.poolId === snap.naiveRoute && <span className="tag">best quote</span>}
              {r.poolId === snap.feelockRoute && <span className="tag">FeeLock route</span>}
            </div>
            <p className="small">
              Quoted {out(r.quoted)} · simulated {out(r.simulated)}
              {r.divergenceBps !== null && r.divergenceBps > 0 && <span className="delta-bad"> · −{bpsPct(r.divergenceBps)}</span>}
            </p>
            <ul className="small">
              {r.reasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>
      {snap.swaps.length > 0 && (
        <section className="card">
          <h2>Recorded swaps</h2>
          {snap.swaps.map((s) => (
            <p key={s.hash} className="small">
              <strong>{s.route === 'naive' ? 'Best quote, no checks' : 'FeeLock'}</strong>: received {out(s.received)} ·{' '}
              <a href={txUrl(s.hash)} target="_blank" rel="noreferrer">
                transaction
              </a>
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
