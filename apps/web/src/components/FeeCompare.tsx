import type { FeeLockState } from '../hooks/useFeeLock';
import { amount, bpsPct, lossBps, pipsPct } from '../lib/format';

function simulatedOf(row: FeeLockState['bestQuote']) {
  const dual = row?.guard?.hops[0]?.dual;
  return dual?.status === 'compared' ? dual.simulated : undefined;
}

/** The two routes side by side: what each quotes, what each really pays, and the difference. */
export function FeeCompare({ feelock, guardOn, symbol, decimals }: { feelock: FeeLockState; guardOn: boolean; symbol: string; decimals: number }) {
  if (!guardOn) {
    return (
      <section className="card">
        <h2>Quote vs execution</h2>
        <p className="muted">Turn FeeLock on to simulate every pool from your address and see what each route really pays.</p>
      </section>
    );
  }
  const naive = feelock.bestQuote;
  const safe = feelock.bestSafe;
  const naiveOut = simulatedOf(naive);
  const safeOut = simulatedOf(safe);
  if (!naive || naiveOut === undefined || naive.quoted === undefined) {
    return (
      <section className="card">
        <h2>Quote vs execution</h2>
        <p className="muted">{feelock.loading ? 'Simulating…' : 'Not enough data to compare.'}</p>
      </section>
    );
  }
  const same = safe?.poolId === naive.poolId;
  const cols = [
    { title: 'Best quote (naive)', row: naive, out: naiveOut },
    ...(safe && !same && safeOut !== undefined ? [{ title: 'FeeLock route', row: safe, out: safeOut }] : []),
  ];
  return (
    <section className="card">
      <h2>Quote vs execution</h2>
      <div className="compare-wrap">
        <table className="compare">
          <thead>
            <tr>
              <th />
              {cols.map((c) => (
                <th key={c.title} scope="col">
                  {c.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Pool</th>
              {cols.map(({ title, row }) => (
                <td key={title}>{row.label}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Fee</th>
              {cols.map(({ title, row }) => (
                <td key={title}>
                  {row.commitment.status === 'committed'
                    ? `${pipsPct(row.commitment.currentFee)} (cap ${pipsPct(row.commitment.maxFee)})`
                    : 'set by the hook at swap time'}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Quoted</th>
              {cols.map(({ title, row }) => (
                <td key={title} className="num">
                  {amount(row.quoted!, decimals)} {symbol}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Pays</th>
              {cols.map(({ title, out }) => (
                <td key={title} className="num">
                  {amount(out, decimals)} {symbol}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Gap</th>
              {cols.map(({ title, row, out }) => {
                const gap = lossBps(row.quoted!, out);
                return (
                  <td key={title} className={gap > 0 ? 'delta-bad' : 'delta-good'}>
                    {gap > 0 ? `−${bpsPct(gap)} (−${amount(row.quoted! - out, decimals)})` : 'none: pays its quote'}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
      {safe && !same && safeOut !== undefined && (
        <p className="compare-sum">
          The best quote looks <strong>{amount(naive.quoted - (safe.quoted ?? 0n), decimals)} {symbol}</strong> better, but
          really pays <strong className="delta-bad">{amount(safeOut - naiveOut, decimals)} {symbol} less</strong> (
          {bpsPct(lossBps(safeOut, naiveOut))}) than the FeeLock route.
        </p>
      )}
    </section>
  );
}
