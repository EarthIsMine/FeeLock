import { createWalletClient, custom, getAddress, type Address, type EIP1193Provider, type WalletClient } from 'viem';
import { addChainParams, chain } from './chain';

/** An injected wallet, from EIP-6963 announcements or the legacy window.ethereum. */
export interface InjectedWallet {
  id: string;
  name: string;
  icon?: string;
  provider: EIP1193Provider;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}

/**
 * Collects wallets that announce themselves (EIP-6963), so several installed extensions do not fight over
 * window.ethereum. Falls back to window.ethereum when nothing announces. Returns an unsubscribe function.
 */
export function watchWallets(onChange: (wallets: InjectedWallet[]) => void): () => void {
  const found = new Map<string, InjectedWallet>();
  const emit = () => onChange([...found.values()]);
  const onAnnounce = (event: Event) => {
    const { info, provider } = (event as CustomEvent<Eip6963Detail>).detail;
    found.set(info.rdns || info.uuid, { id: info.rdns || info.uuid, name: info.name, icon: info.icon, provider });
    emit();
  };
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const legacy = setTimeout(() => {
    const injected = (window as { ethereum?: EIP1193Provider }).ethereum;
    if (found.size === 0 && injected) {
      found.set('injected', { id: 'injected', name: 'Browser wallet', provider: injected });
      emit();
    }
  }, 300);
  return () => {
    window.removeEventListener('eip6963:announceProvider', onAnnounce);
    clearTimeout(legacy);
  };
}

export async function requestAccount(provider: EIP1193Provider): Promise<Address> {
  const [account] = await provider.request({ method: 'eth_requestAccounts' });
  if (!account) throw new Error('the wallet returned no account');
  return getAddress(account);
}

export async function walletChainId(provider: EIP1193Provider): Promise<number> {
  return Number(await provider.request({ method: 'eth_chainId' }));
}

/** Switches the wallet to this app's chain, adding it first if the wallet does not know it (error 4902). */
export async function switchToAppChain(provider: EIP1193Provider): Promise<void> {
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: addChainParams.chainId }] });
  } catch (error) {
    const code = (error as { code?: number }).code ?? (error as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [addChainParams] });
  }
}

export function walletClientFor(provider: EIP1193Provider, account: Address): WalletClient {
  return createWalletClient({ account, chain, transport: custom(provider) });
}
