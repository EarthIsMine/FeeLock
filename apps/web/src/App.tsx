import { useEffect, useState } from 'react';
import { useWallet } from './hooks/useWallet';
import { addressUrl, chain, CHAIN_ID } from './lib/chain';
import { deployment } from './lib/deployments';
import { networkStatus, type NetworkStatus } from './lib/sdk';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

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

function WalletButton() {
  const w = useWallet();
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

function DeploymentSummary() {
  if (!deployment) {
    return <p className="error">No FeeLock deployment for chain {CHAIN_ID} in contracts/deployments.</p>;
  }
  const { config, demo } = deployment;
  const rows: [string, string][] = [
    ['CanonicalPoolRegistry', config.registry],
    ['FeeCommitHook', config.trustedFeeCommitHooks[0]!.address],
    ['V4Quoter', config.quoter],
    ['DemoSwapRouter', config.router],
    ...(demo ? ([['Demo token', demo.token]] as [string, string][]) : []),
  ];
  return (
    <dl className="contracts">
      {rows.map(([name, address]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>
            <a href={addressUrl(address)} target="_blank" rel="noreferrer">
              <code>{short(address)}</code>
            </a>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export default function App() {
  return (
    <>
      <header className="header">
        <div className="brand">
          <strong>FeeLock</strong>
          <span className="muted">The fee you see in the quote is the fee you pay.</span>
        </div>
        <div className="header-right">
          <NetworkBadge />
          <WalletButton />
        </div>
      </header>
      <main className="main">
        <section className="card">
          <h2>Deployment</h2>
          <DeploymentSummary />
        </section>
      </main>
    </>
  );
}
