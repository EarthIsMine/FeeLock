import type { Address, PublicClient } from 'viem';
import type { NetworkConfig } from './config.js';

/**
 * Why an on-chain lookup could not be answered. Every one of these is a failure to verify: callers must hold, never
 * read it as "not registered" or "not committed" (principle ported from EarthIsMine/klamp contract/sdk/canonicalPool.ts).
 */
export type LookupFailure =
  | 'rpc' // request failed or reverted
  | 'chain' // RPC is on another chain than the config
  | 'format' // malformed input (token address, pool key)
  | 'contract-missing' // no code at a configured contract
  | 'contract-mismatch' // contract present but not the one configured (wrong PoolManager, code hash)
  | 'record-mismatch' // a returned record is internally inconsistent
  | 'pool-uninitialized' // the record names a pool PoolManager has not initialized
  | 'reverted'; // a quote or simulation reverted (detail has the decoded reason)

export interface LookupOptions {
  /** Pin every read to this block. Default: latest. Get it with getBlockNumber({ cacheTime: 0 }): viem caches the
   *  block number for seconds by default, which is many Monad blocks. */
  blockNumber?: bigint;
}

export type Failed = { status: 'lookup_failed'; reason: LookupFailure; detail?: string };

export const failed = (reason: LookupFailure, detail?: unknown): Failed => ({
  status: 'lookup_failed',
  reason,
  ...(detail === undefined ? {} : { detail: detail instanceof Error ? detail.message.split('\n')[0] : String(detail) }),
});

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** null when the client is on the configured chain, otherwise the failure to return. */
export async function checkChain(client: PublicClient, config: NetworkConfig): Promise<Failed | null> {
  try {
    const chainId = await client.getChainId();
    return chainId === config.chainId ? null : failed('chain', `rpc chain ${chainId}, config ${config.chainId}`);
  } catch (e) {
    return failed('rpc', e);
  }
}

export async function hasCode(client: PublicClient, address: Address, opts: LookupOptions): Promise<boolean> {
  const code = await client.getCode({ address, blockNumber: opts.blockNumber });
  return code !== undefined && code !== '0x';
}
