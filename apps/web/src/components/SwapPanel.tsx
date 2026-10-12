import { demoSwapRouterAbi } from '@feelock/sdk';
import { useEffect, useState } from 'react';
import { parseEventLogs, type Hex } from 'viem';
import type { FeeLockState, PoolRow } from '../hooks/useFeeLock';
import { REFRESH_MS } from '../hooks/useFeeLock';
import type { WalletState } from '../hooks/useWallet';
import { chain, publicClient } from '../lib/chain';
import { deployment } from '../lib/deployments';
import { amount } from '../lib/format';
import { buildSwapCall, describeError, feelockGuard, minAmountOut } from '../lib/sdk';
import { walletClientFor } from '../lib/wallet';

/** What a mined swap cost. Monad bills the gas limit, so gasUsed in the receipt equals the limit. */
export interface MinedInfo {
  hash: Hex;
  blockNumber: bigint;
  gasLimit: bigint;
  gasCharged: bigint;
}

export type SwapStatus =
  | { step: 'idle' }
  | { step: 'checking' | 'signing' }
  | { step: 'pending'; hash: Hex }
  | ({ step: 'done'; received: bigint; quoted: bigint; pool: PoolRow; guarded: boolean } & MinedInfo)
  | ({ step: 'reverted'; quoted: bigint; minOut: bigint; pool: PoolRow; guarded: boolean } & MinedInfo)
  | { step: 'failed'; error: string; hash?: Hex };

const SLIPPAGES = [50, 500, 1500];

interface Props {
  amountText: string;
  onAmountText: (v: string) => void;
  amountIn?: bigint;
  guardOn: boolean;
  feelock: FeeLockState;
  route?: PoolRow;
  wallet: WalletState;
  maxFeePips: number;
  symbol: string;
  decimals: number;
  onResult: (s: SwapStatus) => void;
}

export function SwapPanel(p: Props) {
  const { guardOn, route, wallet, symbol, decimals } = p;
  const [slippageBps, setSlippageBps] = useState(1500);
  const [status, setStatus] = useState<SwapStatus>({ step: 'idle' });
  const [balance, setBalance] = useState<bigint>();
  const update = (s: SwapStatus) => {
    setStatus(s);
    p.onResult(s);
  };

  useEffect(() => {
    if (!wallet.account) return setBalance(undefined);
    void publicClient.getBalance({ address: wallet.account }).then(setBalance, () => setBalance(undefined));
  }, [wallet.account, status.step]);

  const dual = route?.guard?.hops[0]?.dual;
  const expected = guardOn ? (dual?.status === 'compared' ? dual.simulated : undefined) : route?.quoted;
  const busy = status.step === 'checking' || status.step === 'signing' || status.step === 'pending';

  async function swap() {
    const config = deployment?.config;
    const demo = deployment?.demo;
    if (!config || !demo || !route || !p.amountIn || !wallet.account || !wallet.wallet) return;
    const trade = { key: route.key, zeroForOne: true, amountIn: p.amountIn };
    try {
      let hookData: Hex | undefined;
      let gas: bigint | undefined;
      let minOut: bigint;
      let quoted: bigint;
      if (guardOn) {
        // Check again right before signing: the list may be seconds old.
        update({ step: 'checking' });
        const fresh = await feelockGuard({
          client: publicClient,
          config,
          account: wallet.account,
          token: demo.token,
          route: [route.key],
          amountIn: p.amountIn,
          zeroForOne: true,
          maxFeePips: p.maxFeePips,
        });
        const d = fresh.hops[0]?.dual;
        if (fresh.verdict !== 'SAFE' || d?.status !== 'compared') {
          return update({ step: 'failed', error: `FeeLock stopped the swap: ${fresh.verdict}. ${fresh.hops[0]?.reasons[0] ?? ''}` });
        }
        hookData = fresh.hookData;
        gas = fresh.gasLimit;
        quoted = d.quoted;
        minOut = minAmountOut(d.simulated, 50);
      } else {
        quoted = route.quoted!;
        minOut = minAmountOut(quoted, slippageBps);
      }
      update({ step: 'signing' });
      const call = buildSwapCall(config, { ...trade, hookData, minAmountOut: minOut });
      const client = walletClientFor(wallet.wallet.provider, wallet.account);
      const hash = await client.sendTransaction({ ...call, gas, account: wallet.account, chain });
      update({ step: 'pending', hash });
      const [receipt, tx] = await Promise.all([
        publicClient.waitForTransactionReceipt({ hash }),
        publicClient.getTransaction({ hash }),
      ]);
      const mined: MinedInfo = {
        hash,
        blockNumber: receipt.blockNumber,
        gasLimit: tx.gas,
        gasCharged: receipt.gasUsed * receipt.effectiveGasPrice,
      };
      if (receipt.status !== 'success') {
        return update({ step: 'reverted', ...mined, quoted, minOut, pool: route, guarded: guardOn });
      }
      const [event] = parseEventLogs({ abi: demoSwapRouterAbi, eventName: 'SwapExecuted', logs: receipt.logs });
      update({ step: 'done', ...mined, received: event?.args.amountOut ?? 0n, quoted, pool: route, guarded: guardOn });
    } catch (e) {
      update({ step: 'failed', error: describeError(e) });
    }
  }

  let action: { label: string; onClick?: () => void; disabled?: boolean; tone?: string };
  if (!wallet.account) action = { label: 'Connect a wallet to swap', disabled: true };
  else if (!wallet.ready) action = { label: `Switch to ${chain.name}`, onClick: wallet.switchChain, tone: 'warn' };
  else if (!p.amountIn) action = { label: 'Enter an amount', disabled: true };
  else if (!route) action = { label: guardOn ? 'No SAFE pool: swap held' : 'No quote', disabled: true, tone: 'bad' };
  else if (busy) action = { label: status.step === 'checking' ? 'Checking…' : status.step === 'signing' ? 'Confirm in your wallet…' : 'Waiting for the block…', disabled: true };
  else action = { label: guardOn ? `Swap via ${route.label} (checked)` : `Swap via ${route.label}`, onClick: swap, tone: guardOn ? undefined : 'warn' };

  return (
    <section className="card swap">
      <div className="swap-box">
        <label htmlFor="amount" className="muted">You pay</label>
        <div className="swap-line">
          <input
            id="amount"
            inputMode="decimal"
            placeholder="0.0"
            value={p.amountText}
            onChange={(e) => p.onAmountText(e.target.value.replace(/[^0-9.]/g, ''))}
          />
          <span className="token">MON</span>
        </div>
        {balance !== undefined && <span className="muted small">Balance {amount(balance, 18, 4)} MON</span>}
      </div>
      <div className="swap-box">
        <span className="muted">You receive {guardOn ? '(simulated from your address)' : '(quoted)'}</span>
        <div className="swap-line">
          <output className="out">
            {expected !== undefined ? amount(expected, decimals) : p.feelock.loading ? 'checking…' : '—'}
          </output>
          <span className="token">{symbol}</span>
        </div>
        {route && <span className="muted small">via {route.label} · refreshes every {REFRESH_MS / 1000}s</span>}
      </div>

      {!guardOn && (
        <div className="slippage">
          <span className="muted small">Slippage tolerance</span>
          {SLIPPAGES.map((bps) => (
            <button key={bps} className={`chip ${slippageBps === bps ? 'is-on' : ''}`} onClick={() => setSlippageBps(bps)}>
              {bps / 100}%
            </button>
          ))}
        </div>
      )}
      {guardOn && <p className="muted small">FeeLock pins the quoted fee in hookData and re-checks the pool before you sign.</p>}

      <button className={`button wide ${action.tone ?? ''}`} onClick={action.onClick} disabled={action.disabled}>
        {action.label}
      </button>
      {status.step === 'failed' && <p className="error small">{status.error}</p>}
      {p.feelock.error && <p className="error small">{p.feelock.error}</p>}
      <p className="muted small">Swaps can't be reversed once they are in a block.</p>
    </section>
  );
}
