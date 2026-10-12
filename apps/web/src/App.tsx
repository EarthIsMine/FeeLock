import { useEffect, useMemo, useState } from 'react';
import { parseEther } from 'viem';
import { Explainer } from './components/Explainer';
import { FeeCompare } from './components/FeeCompare';
import { GuardToggle } from './components/GuardToggle';
import { PoolList } from './components/PoolList';
import { SwapPanel, type SwapStatus } from './components/SwapPanel';
import { SnapshotView } from './components/SnapshotView';
import { TxReceipt } from './components/TxReceipt';
import { VerdictCard } from './components/VerdictCard';
import { useFeeLock } from './hooks/useFeeLock';
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { useWallet, type WalletState } from './hooks/useWallet';
import { chain, CHAIN_ID } from './lib/chain';
import { deployment } from './lib/deployments';
import { short } from './lib/format';
import { snapshot } from './lib/snapshot';
import { tokenMeta, type TokenMeta } from './lib/token';

/** The swapper's fee limit: 1%, matching the demo pool's committed cap. */
const MAX_FEE_PIPS = 10_000;

function NetworkBadge({ status }: { status: ReturnType<typeof useNetworkStatus> }) {
  const state = !status.checked ? 'pending' : status.ok ? 'ok' : 'down';
  return (
    <span className={`badge badge-${state}`} title={status.error}>
      <span className="dot" />
      {chain.name}
      {status.ok ? ` · #${status.blockNumber}` : status.checked ? ' · RPC unreachable' : ''}
    </span>
  );
}

function WalletButton({ w }: { w: WalletState }) {
  if (w.account) {
    return (
      <div className="wallet">
        {!w.ready && (
          <button className="button warn" onClick={w.switchChain}>
            Switch to {chain.name}
          </button>
        )}
        <button className="button ghost" onClick={w.disconnect} title="Disconnect">
          {w.wallet?.icon && <img src={w.wallet.icon} alt="" className="wallet-icon" />}
          {short(w.account)}
        </button>
        {w.error && <span className="error">{w.error}</span>}
      </div>
    );
  }
  if (w.wallets.length === 0) return <span className="muted">No browser wallet found</span>;
  return (
    <div className="wallet">
      {w.wallets.map((wallet) => (
        <button key={wallet.id} className="button" onClick={() => w.connect(wallet)}>
          {wallet.icon && <img src={wallet.icon} alt="" className="wallet-icon" />}
          Connect {w.wallets.length > 1 ? wallet.name : ''}
        </button>
      ))}
      {w.error && <span className="error">{w.error}</span>}
    </div>
  );
}

function parseAmount(text: string): bigint | undefined {
  try {
    const v = parseEther(text);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
}

export default function App() {
  const wallet = useWallet();
  const network = useNetworkStatus();
  const forceSnapshot = useMemo(() => new URLSearchParams(location.search).has('snapshot'), []);
  // ?feelock=on opens with the guard on (handy for demo links).
  const [guardOn, setGuardOn] = useState(() => new URLSearchParams(location.search).get('feelock') === 'on');
  const [amountText, setAmountText] = useState('0.001');
  const [token, setToken] = useState<TokenMeta>();
  const [last, setLast] = useState<SwapStatus>({ step: 'idle' });
  const amountIn = useMemo(() => parseAmount(amountText), [amountText]);
  const feelock = useFeeLock(amountIn, guardOn, wallet.ready ? wallet.account : undefined, MAX_FEE_PIPS);
  const route = guardOn ? feelock.bestSafe : feelock.bestQuote;
  // Fall back to the recorded snapshot only when live data is really unavailable, and say so.
  const snapshotReason = forceSnapshot
    ? 'Opened with ?snapshot.'
    : network.down
      ? `The RPC is unreachable (${network.error ?? 'no answer'}).`
      : feelock.error
        ? `Live lookups failed (${feelock.error}).`
        : undefined;

  useEffect(() => {
    if (deployment?.demo) void tokenMeta(deployment.demo.token).then(setToken);
  }, []);

  const symbol = token?.symbol ?? '…';
  const decimals = token?.decimals ?? 18;

  return (
    <>
      <header className="header">
        <div className="brand">
          <strong>FeeLock</strong>
          <span className="muted">The fee you see in the quote is the fee you pay.</span>
        </div>
        <div className="header-right">
          <NetworkBadge status={network} />
          <WalletButton w={wallet} />
        </div>
      </header>
      {!deployment?.demo ? (
        <main className="main">
          <p className="error">No FeeLock demo deployment for chain {CHAIN_ID} in contracts/deployments.</p>
        </main>
      ) : snapshotReason && snapshot ? (
        <main className="main layout-single">
          <SnapshotView snap={snapshot} reason={snapshotReason} />
          <Explainer />
        </main>
      ) : (
        <main className="main layout">
          <div className="col">
            <GuardToggle on={guardOn} onChange={setGuardOn} />
            <section className="card">
              <h2>
                Pools for MON → {symbol}
                {feelock.loading && <span className="muted small"> · updating</span>}
              </h2>
              <PoolList
                rows={feelock.rows}
                guardOn={guardOn}
                routeId={route?.poolId}
                bestQuoteId={feelock.bestQuote?.poolId}
                symbol={symbol}
                decimals={decimals}
              />
            </section>
            <VerdictCard rows={feelock.rows} guardOn={guardOn} routeId={route?.poolId} />
          </div>
          <div className="col">
            <SwapPanel
              amountText={amountText}
              onAmountText={setAmountText}
              amountIn={amountIn}
              guardOn={guardOn}
              feelock={feelock}
              route={route}
              wallet={wallet}
              maxFeePips={MAX_FEE_PIPS}
              symbol={symbol}
              decimals={decimals}
              onResult={setLast}
            />
            <TxReceipt status={last} symbol={symbol} decimals={decimals} />
            <FeeCompare feelock={feelock} guardOn={guardOn} symbol={symbol} decimals={decimals} />
          </div>
          <div className="span-all">
            <Explainer />
          </div>
        </main>
      )}
    </>
  );
}
