import { useEffect, useMemo, useState } from 'react';
import { parseEther } from 'viem';
import { GuardToggle } from './components/GuardToggle';
import { PoolList } from './components/PoolList';
import { SwapPanel, type SwapStatus } from './components/SwapPanel';
import { VerdictCard } from './components/VerdictCard';
import { useFeeLock } from './hooks/useFeeLock';
import { useWallet, type WalletState } from './hooks/useWallet';
import { chain, CHAIN_ID, txUrl } from './lib/chain';
import { deployment } from './lib/deployments';
import { amount, short } from './lib/format';
import { networkStatus, type NetworkStatus } from './lib/sdk';
import { tokenMeta, type TokenMeta } from './lib/token';

/** The swapper's fee limit: 1%, matching the demo pool's committed cap. */
const MAX_FEE_PIPS = 10_000;

function NetworkBadge() {
  const [status, setStatus] = useState<NetworkStatus>();
  useEffect(() => {
    let live = true;
    const tick = async () => {
      const s = await networkStatus();
      if (live) setStatus(s);
    };
    void tick();
    const id = setInterval(tick, 2_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  const state = !status ? 'pending' : status.ok ? 'ok' : 'down';
  return (
    <span className={`badge badge-${state}`} title={status?.error}>
      <span className="dot" />
      {chain.name}
      {status?.ok ? ` · #${status.blockNumber}` : status ? ' · RPC unreachable' : ''}
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
  // ?feelock=on opens with the guard on (handy for demo links).
  const [guardOn, setGuardOn] = useState(() => new URLSearchParams(location.search).get('feelock') === 'on');
  const [amountText, setAmountText] = useState('0.001');
  const [token, setToken] = useState<TokenMeta>();
  const [last, setLast] = useState<SwapStatus>({ step: 'idle' });
  const amountIn = useMemo(() => parseAmount(amountText), [amountText]);
  const feelock = useFeeLock(amountIn, guardOn, wallet.ready ? wallet.account : undefined, MAX_FEE_PIPS);
  const route = guardOn ? feelock.bestSafe : feelock.bestQuote;

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
          <NetworkBadge />
          <WalletButton w={wallet} />
        </div>
      </header>
      {!deployment?.demo ? (
        <main className="main">
          <p className="error">No FeeLock demo deployment for chain {CHAIN_ID} in contracts/deployments.</p>
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
            {(last.step === 'pending' || last.step === 'done') && (
              <section className="card">
                <h2>Last swap</h2>
                {last.step === 'pending' && <p className="muted">Waiting for the block…</p>}
                {last.step === 'done' && (
                  <p>
                    Received <strong>{amount(last.received, decimals)} {symbol}</strong> from {last.pool.label} (quoted{' '}
                    {amount(last.quoted, decimals)}).
                  </p>
                )}
                <a href={txUrl(last.hash)} target="_blank" rel="noreferrer">
                  View transaction
                </a>
              </section>
            )}
          </div>
        </main>
      )}
    </>
  );
}
