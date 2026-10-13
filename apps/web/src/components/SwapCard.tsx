import type { WalletState } from '../hooks/useWallet';
import type { FlowState } from '../hooks/useSwapFlow';
import { chain } from '../lib/chain';
import { amount } from '../lib/format';

const SLIPPAGES = [50, 500, 1500];

interface Props {
  amountText: string;
  onAmountText: (v: string) => void;
  amountIn?: bigint;
  balance?: bigint;
  guardOn: boolean;
  onGuard: (on: boolean) => void;
  estimate?: bigint;
  estimateNote: string;
  slippageBps: number;
  onSlippage: (bps: number) => void;
  symbol: string;
  decimals: number;
  wallet: WalletState;
  flow: FlowState;
  onReview: () => void;
}

/** The amount, the FeeLock switch and one button. Everything else appears once the user asks for a review. */
export function SwapCard(p: Props) {
  const checking = p.flow.phase === 'checking';
  const locked = p.flow.phase === 'signing';
  return (
    <section className="glass swap-card" aria-label="Swap">
      <label className={`feelock-switch ${p.guardOn ? 'is-on' : ''}`}>
        <span className="switch-text">
          <strong>FeeLock {p.guardOn ? 'on' : 'off'}</strong>
          <small>{p.guardOn ? 'Checks every pool before you sign' : 'Takes the best quote on trust'}</small>
        </span>
        <input type="checkbox" role="switch" checked={p.guardOn} disabled={locked} onChange={(e) => p.onGuard(e.target.checked)} />
        <span className="switch" aria-hidden />
      </label>

      <div className="amount-field">
        <label htmlFor="amount" className="field-label">You pay</label>
        <div className="amount-line">
          <input
            id="amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={p.amountText}
            disabled={locked}
            onChange={(e) => p.onAmountText(e.target.value.replace(/[^0-9.]/g, ''))}
          />
          <span className="token-chip">MON</span>
        </div>
        {p.balance !== undefined && <span className="field-hint">Balance {amount(p.balance, 18, 4)} MON</span>}
      </div>

      <div className="receive">
        <span className="field-label">You receive</span>
        <span className="receive-value">
          {p.estimate !== undefined ? `≈ ${amount(p.estimate, p.decimals)}` : '—'} <small>{p.symbol}</small>
        </span>
        <span className="field-hint">{p.estimateNote}</span>
      </div>

      {!p.guardOn && (
        <div className="slippage" role="group" aria-label="Slippage tolerance">
          <span className="field-hint">Slippage</span>
          {SLIPPAGES.map((bps) => (
            <button key={bps} className={`chip ${p.slippageBps === bps ? 'is-on' : ''}`} onClick={() => p.onSlippage(bps)} disabled={locked}>
              {bps / 100}%
            </button>
          ))}
        </div>
      )}

      {!p.wallet.account ? (
        <p className="field-hint center">Connect a wallet to swap. You can review without one.</p>
      ) : !p.wallet.ready ? (
        <button className="cta warn" onClick={p.wallet.switchChain}>Switch to {chain.name}</button>
      ) : null}
      <button className={`cta ${p.flow.phase === 'idle' || checking ? '' : 'secondary'}`} onClick={p.onReview} disabled={!p.amountIn || checking || locked}>
        {checking ? 'Checking…' : p.flow.phase === 'idle' ? 'Review swap' : 'Review again'}
      </button>
    </section>
  );
}
