import type { Hex, PublicClient } from 'viem';
import { v4QuoterAbi } from './abi/index.js';
import type { NetworkConfig } from './config.js';
import { failed, type Failed, type LookupOptions } from './lookup.js';
import { poolKeyError, type PoolKey } from './poolKey.js';
import { describeError, revertData } from './revert.js';

export interface SwapParams {
  key: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  /** Forwarded to the pool's hook. For FeeCommitHook: abi.encode(uint24 maxFee). */
  hookData?: Hex;
}

export type QuoteResult = { status: 'quoted'; amountOut: bigint; gasEstimate: bigint } | Failed;

const MAX_UINT128 = (1n << 128n) - 1n;

export function swapParamsError(p: SwapParams): string | null {
  const keyError = poolKeyError(p.key);
  if (keyError) return keyError;
  if (typeof p.amountIn !== 'bigint' || p.amountIn <= 0n || p.amountIn > MAX_UINT128) return 'amountIn out of range';
  if (p.hookData !== undefined && !/^0x([0-9a-fA-F]{2})*$/.test(p.hookData)) return 'hookData not hex bytes';
  return null;
}

/**
 * V4Quoter.quoteExactInputSingle. The quoter is the PoolManager caller here, so a hook sees `sender == quoter`: this is
 * exactly the view an attack hook can fake. Compare with simulateSwap before trusting it.
 */
export async function quoteExactInputSingle(
  client: PublicClient,
  config: NetworkConfig,
  params: SwapParams,
  opts: LookupOptions = {},
): Promise<QuoteResult> {
  const inputError = swapParamsError(params);
  if (inputError) return failed('format', inputError);
  try {
    const { result } = await client.simulateContract({
      address: config.quoter,
      abi: v4QuoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          poolKey: params.key,
          zeroForOne: params.zeroForOne,
          exactAmount: params.amountIn,
          hookData: params.hookData ?? '0x',
        },
      ],
      blockNumber: opts.blockNumber,
    });
    const [amountOut, gasEstimate] = result;
    return { status: 'quoted', amountOut, gasEstimate };
  } catch (e) {
    return failed(revertData(e) ? 'reverted' : 'rpc', describeError(e));
  }
}

export interface CandidateQuote {
  key: PoolKey;
  quote: QuoteResult;
}

/** Quotes every candidate pool for the same trade, at one block. */
export async function quoteCandidates(
  client: PublicClient,
  config: NetworkConfig,
  candidates: readonly PoolKey[],
  trade: Omit<SwapParams, 'key'>,
  opts: LookupOptions = {},
): Promise<CandidateQuote[]> {
  let blockNumber = opts.blockNumber;
  if (blockNumber === undefined) {
    try {
      blockNumber = await client.getBlockNumber();
    } catch (e) {
      const quote = failed('rpc', e);
      return candidates.map((key) => ({ key, quote }));
    }
  }
  return Promise.all(
    candidates.map(async (key) => ({ key, quote: await quoteExactInputSingle(client, config, { ...trade, key }, { blockNumber }) })),
  );
}

export type QuotedCandidate = { key: PoolKey; quote: Extract<QuoteResult, { status: 'quoted' }> };

/** What a best-quote router does: the candidate with the highest quoted output. Failed quotes are skipped. */
export function bestQuote(quotes: readonly CandidateQuote[]): QuotedCandidate | undefined {
  let best: QuotedCandidate | undefined;
  for (const { key, quote } of quotes) {
    if (quote.status === 'quoted' && (!best || quote.amountOut > best.quote.amountOut)) best = { key, quote };
  }
  return best;
}
