import { erc20Abi, type Address } from 'viem';
import { publicClient } from './chain';

export interface TokenMeta {
  address: Address;
  symbol: string;
  decimals: number;
}

const cache = new Map<string, Promise<TokenMeta>>();

export function tokenMeta(address: Address): Promise<TokenMeta> {
  let meta = cache.get(address);
  if (!meta) {
    meta = Promise.all([
      publicClient.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
      publicClient.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    ]).then(([symbol, decimals]) => ({ address, symbol, decimals }));
    cache.set(address, meta);
  }
  return meta;
}
