import type { SwapStatus } from './SwapPanel';
import { txUrl } from '../lib/chain';
import { amount, bpsPct, lossBps } from '../lib/format';

/** Result of the last swap: what was received against the quote, and what gas Monad charged. */
export function TxReceipt({ status, symbol, decimals }: { status: SwapStatus; symbol: string; decimals: number }) {
  if (status.step === 'pending') {
    return (
      <section className="card">
        <h2>Last swap</h2>
        <p className="muted">
          Sent, waiting for the block… <a href={txUrl(status.hash)} target="_blank" rel="noreferrer">view</a>
        </p>
      </section>
    );
  }
  if (status.step !== 'done' && status.step !== 'reverted') return null;
  const gas = (
    <div>
      <dt>Gas charged</dt>
      <dd>
        {amount(status.gasCharged, 18, 6)} MON <span className="muted small">(limit {status.gasLimit.toString()}; Monad bills the whole limit)</span>
      </dd>
    </div>
  );
  const link = (
    <a href={txUrl(status.hash)} target="_blank" rel="noreferrer">
      View transaction · block {status.blockNumber.toString()}
    </a>
  );
  if (status.step === 'reverted') {
    return (
      <section className="card receipt tone-warn">
        <h2>Last swap reverted</h2>
        <p>
          {status.pool.label} paid less than your minimum of {amount(status.minOut, decimals)} {symbol}, so the swap
          reverted. You kept your MON but paid the gas.
        </p>
        <dl className="receipt-rows">{gas}</dl>
        {link}
      </section>
    );
  }
  const gap = lossBps(status.quoted, status.received);
  return (
    <section className={`card receipt ${gap > 0 ? 'tone-bad' : 'tone-good'}`}>
      <h2>Last swap {status.guarded ? '(FeeLock)' : '(no checks)'}</h2>
      <dl className="receipt-rows">
        <div>
          <dt>Pool</dt>
          <dd>{status.pool.label}</dd>
        </div>
        <div>
          <dt>Quoted</dt>
          <dd className="num">{amount(status.quoted, decimals)} {symbol}</dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd className="num">
            <strong>{amount(status.received, decimals)} {symbol}</strong>{' '}
            {gap > 0 ? <span className="delta-bad">−{bpsPct(gap)} vs quote</span> : <span className="delta-good">= quote</span>}
          </dd>
        </div>
        {gas}
      </dl>
      {link}
    </section>
  );
}
