import { encodeAbiParameters, encodeFunctionData, zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { demoSwapRouterAbi } from './abi/index.js';
import type { NetworkConfig } from './config.js';
import { sameAddress } from './lookup.js';
import { MAX_LP_FEE } from './poolKey.js';
import type { SwapParams } from './quote.js';

/** FeeCommitHook's swapper limit: abi.encode(uint24 maxFee). */
export function encodeMaxFeeHookData(maxFeePips: number): Hex {
  if (!Number.isInteger(maxFeePips) || maxFeePips < 0 || maxFeePips > MAX_LP_FEE) throw new RangeError('maxFeePips');
  return encodeAbiParameters([{ type: 'uint24' }], [maxFeePips]);
}

/** quoted minus the slippage tolerance, rounded down. */
export function minAmountOut(quoted: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) throw new RangeError('slippageBps');
  return (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
}

export interface SwapCall {
  to: Address;
  data: Hex;
  value: bigint;
}

/** Calldata for DemoSwapRouter.swapExactInputSingle. Native input sends exactly amountIn as value. */
export function buildSwapCall(config: NetworkConfig, params: SwapParams & { minAmountOut: bigint }): SwapCall {
  const input = params.zeroForOne ? params.key.currency0 : params.key.currency1;
  return {
    to: config.router,
    data: encodeFunctionData({
      abi: demoSwapRouterAbi,
      functionName: 'swapExactInputSingle',
      args: [params.key, params.zeroForOne, params.amountIn, params.minAmountOut, params.hookData ?? '0x'],
    }),
    value: sameAddress(input, zeroAddress) ? params.amountIn : 0n,
  };
}

/**
 * Monad charges the full gas limit, not the gas used, so the limit is the estimate plus a small margin rather than
 * a wallet's usual generous buffer. 10% matches the forge scripts' --gas-estimate-multiplier 110.
 */
export const GAS_MARGIN_BPS = 1_000;

export function withGasMargin(estimate: bigint, marginBps = GAS_MARGIN_BPS): bigint {
  return (estimate * BigInt(10_000 + marginBps) + 9_999n) / 10_000n;
}

/** Estimated gas for the swap from `account` (needs its real balance and allowance), with margin; undefined if it fails. */
export async function swapGasLimit(
  client: PublicClient,
  config: NetworkConfig,
  account: Address,
  params: SwapParams,
): Promise<bigint | undefined> {
  const call = buildSwapCall(config, { ...params, minAmountOut: 0n });
  try {
    return withGasMargin(await client.estimateGas({ account, to: call.to, data: call.data, value: call.value }));
  } catch {
    return undefined;
  }
}
