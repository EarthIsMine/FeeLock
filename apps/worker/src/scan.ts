import { canonicalPoolRegistryAbi, iPoolManagerAbi, type NetworkConfig, type PoolKey } from '@feelock/sdk';
import { getAbiItem, type Hex, type PublicClient } from 'viem';

const initialize = getAbiItem({ abi: iPoolManagerAbi, name: 'Initialize' });
const poolDeclared = getAbiItem({ abi: canonicalPoolRegistryAbi, name: 'PoolDeclared' });

export interface InitializedPool {
  poolId: Hex;
  key: PoolKey;
  blockNumber: bigint;
}

export interface Declaration {
  token: Hex;
  poolId: Hex;
  issuer: Hex;
  blockNumber: bigint;
}

export interface ScanResult {
  pools: InitializedPool[];
  declarations: Declaration[];
  /** Last block covered. */
  toBlock: bigint;
}

export interface ScanOptions {
  fromBlock: bigint;
  toBlock: bigint;
  /** Blocks per eth_getLogs call. Monad's public RPCs allow 100. */
  chunk: bigint;
  /** Called after every chunk, e.g. to checkpoint. */
  onChunk?: (partial: ScanResult) => Promise<void> | void;
}

/**
 * PoolManager Initialize and CanonicalPoolRegistry PoolDeclared logs over [fromBlock, toBlock], both in one
 * eth_getLogs per chunk. A chunk the RPC refuses (range limit) is retried at half the size, down to one block.
 */
export async function scanLogs(client: PublicClient, config: NetworkConfig, opts: ScanOptions): Promise<ScanResult> {
  const result: ScanResult = { pools: [], declarations: [], toBlock: opts.fromBlock - 1n };
  let chunk = opts.chunk > 0n ? opts.chunk : 100n;
  let from = opts.fromBlock;
  while (from <= opts.toBlock) {
    const to = from + chunk - 1n > opts.toBlock ? opts.toBlock : from + chunk - 1n;
    let logs;
    try {
      logs = await client.getLogs({
        address: [config.poolManager, config.registry],
        events: [initialize, poolDeclared],
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
    } catch (e) {
      if (chunk === 1n) throw e;
      chunk = chunk / 2n;
      continue;
    }
    for (const log of logs) {
      if (log.eventName === 'Initialize' && log.address.toLowerCase() === config.poolManager.toLowerCase()) {
        const a = log.args;
        result.pools.push({
          poolId: a.id,
          key: { currency0: a.currency0, currency1: a.currency1, fee: a.fee, tickSpacing: a.tickSpacing, hooks: a.hooks },
          blockNumber: log.blockNumber,
        });
      } else if (log.eventName === 'PoolDeclared' && log.address.toLowerCase() === config.registry.toLowerCase()) {
        const a = log.args;
        result.declarations.push({ token: a.token, poolId: a.poolId, issuer: a.issuer, blockNumber: log.blockNumber });
      }
    }
    result.toBlock = to;
    await opts.onChunk?.(result);
    from = to + 1n;
  }
  return result;
}
