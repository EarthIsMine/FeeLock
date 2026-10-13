import type { FlowState, Step } from '../hooks/useSwapFlow';
import type { WalletState } from '../hooks/useWallet';
import { txUrl } from '../lib/chain';
import { amount, lossBps, bpsPct, pipsPct } from '../lib/format';

function StepRow({ s }: { s: Step }) {
  return (
    <li className={`step is-${s.status} ${s.tone ? `tone-${s.tone}` : ''}`}>
      <span className="step-dot" aria-hidden>
        {s.status === 'done' ? '✓' : s.status === 'failed' ? '!' : s.status === 'skipped' ? '–' : ''}
      </span>
      <div className="step-body">
        <span className="step-title">{s.title}</span>
        {s.detail && <span className="step-detail">{s.detail}</span>}
        {s.items && (
          <ul className="step-items">
            {s.items.map((i) => (
              <li key={i.label} className={`tone-${i.tone}`}>
                <strong>{i.label}</strong> {i.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

interface Props {
  flow: FlowState;
  wallet: WalletState;
  amountIn?: bigint;
  symbol: string;
  decimals: number;
  onConfirm: () => void;
  onReset: () => void;
}

/** What FeeLock is doing, one step at a time; the review sheet before signing; the result after. */
export function CheckFlow({ flow, wallet, amountIn, symbol, decimals, onConfirm, onReset }: Props) {
  if (flow.phase === 'idle') return null;
  const visible = flow.steps.filter((s) => s.status !== 'pending' || (s.id !== 'sign' && s.id !== 'done' && flow.phase === 'checking'));
  const r = flow.route;
  const res = flow.result;
  const fmt = (v: bigint) => `${amount(v, decimals)} ${symbol}`;
  return (
    <section className="glass flow" aria-live="polite">
      <ol className="timeline">
        {visible.map((s) => (
          <StepRow key={s.id} s={s} />
        ))}
      </ol>

      {flow.phase === 'review' && r && amountIn && (
        <div className="sheet">
          <h3>Review</h3>
          <dl className="rows">
            <div><dt>Pool</dt><dd>{r.label}</dd></div>
            <div><dt>You pay</dt><dd>{amount(amountIn, 18, 6)} MON</dd></div>
            <div>
              <dt>You receive</dt>
              <dd>
                <strong>{fmt(r.expected)}</strong>
                <small>{flow.guarded ? 'simulated from your address' : 'quoted, not checked'}</small>
              </dd>
            </div>
            {r.fee !== undefined && <div><dt>Fee</dt><dd>{pipsPct(r.fee)} <small>pinned in the transaction</small></dd></div>}
            {!flow.guarded && <div><dt>Minimum</dt><dd>{fmt(r.minOut)}</dd></div>}
            {r.gasLimit && <div><dt>Gas limit</dt><dd>{r.gasLimit.toString()} <small>Monad bills the whole limit</small></dd></div>}
          </dl>
          {!flow.guarded && <p className="note warn">Without FeeLock, nothing checks that this pool charges what it quotes.</p>}
          <button className="cta" onClick={onConfirm} disabled={!wallet.ready}>
            {wallet.ready ? 'Confirm swap' : wallet.account ? 'Switch network to swap' : 'Connect a wallet to swap'}
          </button>
          <button className="link" onClick={onReset}>Cancel</button>
        </div>
      )}

      {flow.phase === 'done' && res && r && (
        <div className={`result ${res.reverted ? 'tone-warn' : lossBps(r.quoted, res.received ?? 0n) > 0 ? 'tone-bad' : 'tone-good'}`}>
          {res.reverted ? (
            <p className="result-big">Reverted</p>
          ) : (
            <>
              <p className="result-big">{fmt(res.received ?? 0n)}</p>
              <p className="result-sub">
                {lossBps(r.quoted, res.received ?? 0n) > 0
                  ? `${bpsPct(lossBps(r.quoted, res.received ?? 0n))} less than the ${fmt(r.quoted)} quote`
                  : 'exactly what was quoted'}
              </p>
            </>
          )}
          <dl className="rows">
            <div><dt>Gas charged</dt><dd>{amount(res.gasCharged, 18, 6)} MON <small>limit {res.gasLimit.toString()}</small></dd></div>
            <div><dt>Block</dt><dd>{res.blockNumber.toString()}</dd></div>
          </dl>
          <a className="link" href={txUrl(res.hash)} target="_blank" rel="noreferrer">View on Monadscan</a>
          <button className="cta secondary" onClick={onReset}>New swap</button>
        </div>
      )}

      {flow.phase === 'failed' && (
        <div className="result tone-warn">
          <p className="result-sub">{flow.error}</p>
          <button className="cta secondary" onClick={onReset}>Start over</button>
        </div>
      )}
    </section>
  );
}
