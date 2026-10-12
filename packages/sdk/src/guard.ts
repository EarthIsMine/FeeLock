import type { Address, Hex, PublicClient } from 'viem';
import type { NetworkConfig } from './config.js';
import { getCommitment, type CommitmentResult } from './feeCommit.js';
import { judgeHop, judgeRoute, type Verdict } from './judge.js';
import { failed } from './lookup.js';
import { hasCurrency, hashPoolKey, MAX_LP_FEE, poolKeyError, type PoolKey } from './poolKey.js';
import { getCanonicalPool, type CanonicalPoolResult } from './registry.js';
import { dualSimulate, type DualSimulationResult } from './simulate.js';
import { encodeMaxFeeHookData, swapGasLimit } from './swap.js';

export const DEFAULT_MISMATCH_TOLERANCE_BPS = 10;

export interface GuardInput {
  client: PublicClient;
  config: NetworkConfig;
  /** The swapper; simulations run from this address. */
  account: Address;
  /** The token being traded. Only hops that touch it are checked. */
  token: Address;
  route: readonly PoolKey[];
  amountIn: bigint;
  zeroForOne: boolean;
  /** The swapper's fee limit in pips (10_000 = 1%). */
  maxFeePips: number;
  mismatchToleranceBps?: number;
}

export interface HopReport {
  index: number;
  key: PoolKey;
  poolId: Hex;
  verdict: Verdict;
  reasons: string[];
  canonical: CanonicalPoolResult;
  commitment: CommitmentResult;
  dual: DualSimulationResult;
  /** hookData the quote and simulation used. */
  hookData: Hex;
}

export interface GuardResult {
  verdict: Verdict;
  hops: HopReport[];
  /** SAFE on a FeeCommitHook pool: pins the fee seen in the quote, so a later raise reverts the swap. */
  hookData?: Hex;
  /** SAFE only: estimated gas with a small margin (Monad bills the whole limit). Absent if estimation failed. */
  gasLimit?: bigint;
  /** Input problems that stopped the guard before any lookup. */
  errors?: string[];
}

function inputErrors(input: GuardInput): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(input.maxFeePips) || input.maxFeePips < 0 || input.maxFeePips > MAX_LP_FEE) {
    errors.push('maxFeePips out of range');
  }
  const tol = input.mismatchToleranceBps ?? DEFAULT_MISMATCH_TOLERANCE_BPS;
  if (!Number.isInteger(tol) || tol < 0 || tol > 10_000) errors.push('mismatchToleranceBps out of range');
  if (input.route.length !== 1) errors.push('only single-hop routes are supported (DemoSwapRouter)');
  for (const [i, key] of input.route.entries()) {
    const e = poolKeyError(key);
    if (e) errors.push(`hop ${i}: ${e}`);
    else if (!hasCurrency(key, input.token)) errors.push(`hop ${i}: does not trade the token`);
  }
  return errors;
}

/**
 * Checks a route before signing (spec §4). For each hop that trades the token: canonical pool, fee commitment, and
 * V4Quoter quote vs a simulation of the real swap from the user's address, all at one block. The route verdict is the
 * worst hop's. Integrations: SAFE proceed, UNVERIFIED requote over SAFE pools, FEE_MISMATCH block, LOOKUP_FAILED hold.
 */
export async function feelockGuard(input: GuardInput): Promise<GuardResult> {
  const errors = inputErrors(input);
  if (errors.length > 0) return { verdict: 'LOOKUP_FAILED', hops: [], errors };
  const { client, config, account, token, maxFeePips } = input;
  const toleranceBps = input.mismatchToleranceBps ?? DEFAULT_MISMATCH_TOLERANCE_BPS;

  let blockNumber: bigint;
  try {
    blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  } catch (e) {
    return { verdict: 'LOOKUP_FAILED', hops: [], errors: [`rpc: ${failed('rpc', e).detail}`] };
  }
  const opts = { blockNumber };

  const hops = await Promise.all(
    input.route.map(async (key, index): Promise<HopReport> => {
      const [canonical, commitment] = await Promise.all([
        getCanonicalPool(client, config, token, opts),
        getCommitment(client, config, key, opts),
      ]);
      // Pin the fee the quote sees, only where the pool can be SAFE (cap within the user's limit): the swap then
      // reverts instead of paying a fee raised after the quote.
      const hookData =
        commitment.status === 'committed' && commitment.maxFee <= maxFeePips
          ? encodeMaxFeeHookData(commitment.currentFee)
          : '0x';
      const dual = await dualSimulate(
        client,
        config,
        account,
        { key, zeroForOne: input.zeroForOne, amountIn: input.amountIn, hookData },
        opts,
      );
      const { verdict, reasons } = judgeHop({ key, canonical, commitment, dual, maxFeePips, toleranceBps });
      return { index, key, poolId: hashPoolKey(key), verdict, reasons, canonical, commitment, dual, hookData };
    }),
  );

  const verdict = judgeRoute(hops.map((h) => h.verdict));
  if (verdict !== 'SAFE') return { verdict, hops };
  const hop = hops[0]!;
  const gasLimit = await swapGasLimit(client, config, account, {
    key: hop.key,
    zeroForOne: input.zeroForOne,
    amountIn: input.amountIn,
    hookData: hop.hookData,
  });
  return {
    verdict,
    hops,
    ...(hop.hookData !== '0x' ? { hookData: hop.hookData } : {}),
    ...(gasLimit !== undefined ? { gasLimit } : {}),
  };
}

export interface CandidateGuard {
  key: PoolKey;
  result: GuardResult;
}

/**
 * Guards each single-pool candidate and returns the best SAFE one by simulated output. This is the requote step for
 * UNVERIFIED routes: route only over SAFE pools, and warn when there is none.
 */
export async function guardCandidates(
  input: Omit<GuardInput, 'route'> & { candidates: readonly PoolKey[] },
): Promise<{ candidates: CandidateGuard[]; best?: CandidateGuard }> {
  const { candidates, ...rest } = input;
  const results = await Promise.all(
    candidates.map(async (key) => ({ key, result: await feelockGuard({ ...rest, route: [key] }) })),
  );
  let best: CandidateGuard | undefined;
  for (const c of results) {
    const dual = c.result.hops[0]?.dual;
    if (c.result.verdict !== 'SAFE' || dual?.status !== 'compared') continue;
    const bestDual = best?.result.hops[0]?.dual;
    if (!best || (bestDual?.status === 'compared' && dual.simulated > bestDual.simulated)) best = c;
  }
  return { candidates: results, ...(best ? { best } : {}) };
}
