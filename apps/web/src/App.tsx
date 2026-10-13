import type { CandidatePool } from '@feelock/sdk';
import { useEffect, useMemo, useState } from 'react';
import { parseEther } from 'viem';
import { CheckFlow } from './components/CheckFlow';
import { Details } from './components/Details';
import { Explainer } from './components/Explainer';
import { SnapshotView } from './components/SnapshotView';
import { SwapCard } from './components/SwapCard';
import { useFeeLock } from './hooks/useFeeLock';
import { useNetworkStatus } from './hooks/useNetworkStatus';
import { useSwapFlow } from './hooks/useSwapFlow';
import { useWallet, type WalletState } from './hooks/useWallet';
import { addressUrl, chain, CHAIN_ID, publicClient } from './lib/chain';
import { deployment } from './lib/deployments';
import { short } from './lib/format';
import { loadCandidates, type CandidateSource } from './lib/pools';
import { snapshot } from './lib/snapshot';
import { tokenMeta, type TokenMeta } from './lib/token';

const NO_POOLS: CandidatePool[] = [];
/** The swapper's fee limit: 1%, matching the demo pool's committed cap. */
const MAX_FEE_PIPS = 10_000;

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden>
      <rect x="2" y="2" width="28" height="28" rx="9" fill="currentColor" />
      <path d="M11 14v-2.5a5 5 0 0 1 10 0V14" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" />
      <rect x="8.5" y="14" width="15" height="11" rx="3" fill="#fff" />
      <path d="M13 22.5l6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="13.4" cy="17.4" r="1.2" fill="currentColor" />
      <circle cx="18.6" cy="21.6" r="1.2" fill="currentColor" />
    </svg>
  );
}

function NetworkPill({ status }: { status: ReturnType<typeof useNetworkStatus> }) {
  const state = !status.checked ? 'pending' : status.ok ? 'ok' : 'down';
  return (
    <span className={`pill net-${state}`} title={status.ok ? `Block ${status.blockNumber}` : status.error}>
      <span className="dot" />
      {chain.name}
    </span>
  );
}

function WalletPill({ w }: { w: WalletState }) {
  if (w.account) {
    return (
      <button className="pill pill-button" onClick={w.disconnect} title="Disconnect">
        {w.wallet?.icon && <img src={w.wallet.icon} alt="" className="wallet-icon" />}
        {short(w.account)}
      </button>
    );
  }
  if (w.wallets.length === 0) return <span className="pill muted">No wallet</span>;
  return (
    <>
      {w.wallets.map((wallet) => (
        <button key={wallet.id} className="pill pill-button primary" onClick={() => w.connect(wallet)}>
          {wallet.icon && <img src={wallet.icon} alt="" className="wallet-icon" />}
          Connect{w.wallets.length > 1 ? ` ${wallet.name}` : ''}
        </button>
      ))}
    </>
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
  const [slippageBps, setSlippageBps] = useState(1500);
  const [token, setToken] = useState<TokenMeta>();
  const [balance, setBalance] = useState<bigint>();
  const [candidates, setCandidates] = useState<{ pools: CandidatePool[]; source: CandidateSource; note?: string }>();
  const amountIn = useMemo(() => parseAmount(amountText), [amountText]);
  const pools = candidates?.pools ?? NO_POOLS;
  const symbol = token?.symbol ?? 'FLD';
  const decimals = token?.decimals ?? 18;

  useEffect(() => {
    void loadCandidates().then(setCandidates);
    if (deployment?.demo) void tokenMeta(deployment.demo.token).then(setToken);
  }, []);

  // Live quotes only: cheap, and enough for the estimate. The full check runs when the user asks for a review.
  const quotes = useFeeLock(amountIn, false, undefined, MAX_FEE_PIPS, pools);
  const flow = useSwapFlow({ amountIn, guardOn, pools, wallet, slippageBps, maxFeePips: MAX_FEE_PIPS, symbol, decimals });

  useEffect(() => {
    if (!wallet.account) return setBalance(undefined);
    void publicClient.getBalance({ address: wallet.account }).then(setBalance, () => setBalance(undefined));
  }, [wallet.account, flow.state.phase]);

  const canonicalRow = quotes.rows.find((r) => r.canonical);
  const estimate = flow.state.route?.expected ?? (guardOn ? canonicalRow?.quoted : quotes.bestQuote?.quoted);
  const estimateNote = flow.state.route
    ? flow.state.guarded
      ? `via ${flow.state.route.label}, simulated from your address`
      : `via ${flow.state.route.label}, quoted`
    : guardOn
      ? 'Estimate from the canonical pool; checked when you review'
      : `Best quote: ${quotes.bestQuote?.label ?? '…'}`;

  const snapshotReason = forceSnapshot
    ? 'Opened with ?snapshot.'
    : network.down
      ? `The RPC is unreachable (${network.error ?? 'no answer'}).`
      : quotes.error
        ? `Live lookups failed (${quotes.error}).`
        : undefined;

  return (
    <div className="page">
      <header className="topbar">
        <a className="brand" href="/" aria-label="FeeLock home">
          <Logo />
          <span>FeeLock</span>
        </a>
        <div className="topbar-right">
          <NetworkPill status={network} />
          <WalletPill w={wallet} />
        </div>
      </header>

      <main className="stage">
        <div className="hero">
          <span className="kicker">Uniswap v4 on Monad testnet</span>
          <h1>Swap at the fee you were quoted</h1>
          <p>FeeLock checks every pool before you sign, and the hook enforces the fee when the swap runs.</p>
        </div>

        {!deployment?.demo ? (
          <p className="glass note warn">No FeeLock demo deployment for chain {CHAIN_ID}.</p>
        ) : snapshotReason && snapshot ? (
          <SnapshotView snap={snapshot} reason={snapshotReason} />
        ) : (
          <>
            <SwapCard
              amountText={amountText}
              onAmountText={setAmountText}
              amountIn={amountIn}
              balance={balance}
              guardOn={guardOn}
              onGuard={setGuardOn}
              estimate={estimate}
              estimateNote={estimateNote}
              slippageBps={slippageBps}
              onSlippage={setSlippageBps}
              symbol={symbol}
              decimals={decimals}
              wallet={wallet}
              flow={flow.state}
              onReview={flow.review}
            />
            {wallet.error && <p className="glass note warn">{wallet.error}</p>}
            <CheckFlow
              flow={flow.state}
              wallet={wallet}
              amountIn={amountIn}
              symbol={symbol}
              decimals={decimals}
              onConfirm={flow.confirm}
              onReset={flow.reset}
            />
            <Details quotes={quotes} flow={flow.state} source={candidates?.source} symbol={symbol} decimals={decimals} />
          </>
        )}

        <Explainer />

        <footer className="footer">
          <a href="https://github.com/EarthIsMine/FeeLock" target="_blank" rel="noreferrer">GitHub</a>
          {deployment && (
            <a href={addressUrl(deployment.config.trustedFeeCommitHooks[0]!.address)} target="_blank" rel="noreferrer">
              FeeCommitHook
            </a>
          )}
          {deployment && (
            <a href={addressUrl(deployment.config.registry)} target="_blank" rel="noreferrer">
              CanonicalPoolRegistry
            </a>
          )}
          <span>Testnet demo · no real funds</span>
        </footer>
      </main>
    </div>
  );
}
