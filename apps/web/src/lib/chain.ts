import { chainFor, MONAD_MAINNET, MONAD_TESTNET, rpcTransport, rpcUrlsFromEnv } from '@feelock/sdk';
import { createPublicClient, toHex, type Chain, type PublicClient } from 'viem';

/** The chain this build talks to. Default: Monad testnet. VITE_CHAIN_ID=31337 for a local anvil. */
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? MONAD_TESTNET);
export const chain: Chain = chainFor(CHAIN_ID);

/** VITE_MONAD_TESTNET_RPC_URL etc. with the prefix stripped, so the SDK's env names apply. */
const env = Object.fromEntries(
  Object.entries(import.meta.env as Record<string, string | undefined>)
    .filter(([k]) => k.startsWith('VITE_'))
    .map(([k, v]) => [k.slice('VITE_'.length), v]),
);
const configured = rpcUrlsFromEnv(CHAIN_ID, env);
export const rpcUrls: readonly string[] = configured.length > 0 ? configured : chain.rpcUrls.default.http;

export const publicClient: PublicClient = createPublicClient({ chain, transport: rpcTransport(rpcUrls) });

const EXPLORERS: Record<number, string> = {
  [MONAD_TESTNET]: 'https://testnet.monadscan.com',
  [MONAD_MAINNET]: 'https://monadscan.com',
};
export const explorer = EXPLORERS[CHAIN_ID];
export const txUrl = (hash: string) => (explorer ? `${explorer}/tx/${hash}` : undefined);
export const addressUrl = (address: string) => (explorer ? `${explorer}/address/${address}` : undefined);

/** wallet_addEthereumChain parameters for this chain. */
export const addChainParams = {
  chainId: toHex(chain.id),
  chainName: chain.name,
  nativeCurrency: chain.nativeCurrency,
  rpcUrls: [chain.rpcUrls.default.http[0]!],
  ...(explorer ? { blockExplorerUrls: [explorer] } : {}),
};
