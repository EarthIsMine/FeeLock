import { useCallback, useEffect, useState } from 'react';
import type { Address } from 'viem';
import { chain } from '../lib/chain';
import { requestAccount, switchToAppChain, walletChainId, watchWallets, type InjectedWallet } from '../lib/wallet';

export interface WalletState {
  wallets: InjectedWallet[];
  wallet?: InjectedWallet;
  account?: Address;
  chainId?: number;
  /** Connected and on this app's chain. */
  ready: boolean;
  error?: string;
  connect(wallet: InjectedWallet): Promise<void>;
  switchChain(): Promise<void>;
  disconnect(): void;
}

const message = (e: unknown) => (e as { shortMessage?: string }).shortMessage ?? (e instanceof Error ? e.message : String(e));

export function useWallet(): WalletState {
  const [wallets, setWallets] = useState<InjectedWallet[]>([]);
  const [wallet, setWallet] = useState<InjectedWallet>();
  const [account, setAccount] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [error, setError] = useState<string>();

  useEffect(() => watchWallets(setWallets), []);

  useEffect(() => {
    if (!wallet) return;
    const onAccounts = (accounts: string[]) => setAccount(accounts[0] as Address | undefined);
    const onChain = (id: string) => setChainId(Number(id));
    wallet.provider.on('accountsChanged', onAccounts);
    wallet.provider.on('chainChanged', onChain);
    return () => {
      wallet.provider.removeListener('accountsChanged', onAccounts);
      wallet.provider.removeListener('chainChanged', onChain);
    };
  }, [wallet]);

  const connect = useCallback(async (w: InjectedWallet) => {
    setError(undefined);
    try {
      const a = await requestAccount(w.provider);
      setWallet(w);
      setAccount(a);
      setChainId(await walletChainId(w.provider));
    } catch (e) {
      setError(message(e));
    }
  }, []);

  const switchChain = useCallback(async () => {
    if (!wallet) return;
    setError(undefined);
    try {
      await switchToAppChain(wallet.provider);
      setChainId(await walletChainId(wallet.provider));
    } catch (e) {
      setError(message(e));
    }
  }, [wallet]);

  const disconnect = useCallback(() => {
    setWallet(undefined);
    setAccount(undefined);
    setChainId(undefined);
  }, []);

  return {
    wallets,
    wallet,
    account,
    chainId,
    ready: !!account && chainId === chain.id,
    error,
    connect,
    switchChain,
    disconnect,
  };
}
