// The SDK surface the app uses, bound to this build's chain and deployment.
export {
  bestQuote,
  buildSwapCall,
  describeError,
  feelockGuard,
  guardCandidates,
  hashPoolKey,
  minAmountOut,
  quoteCandidates,
  simulateSwap,
  VERDICT_ACTION,
  type CandidateGuard,
  type GuardResult,
  type HopReport,
  type PoolKey,
  type Verdict,
} from '@feelock/sdk';

import { publicClient } from './chain';

export interface NetworkStatus {
  ok: boolean;
  blockNumber?: bigint;
  error?: string;
}

/** Latest block, uncached: on Monad a cached block number is many blocks old. */
export async function networkStatus(): Promise<NetworkStatus> {
  try {
    return { ok: true, blockNumber: await publicClient.getBlockNumber({ cacheTime: 0 }) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.split('\n')[0] : String(e) };
  }
}
