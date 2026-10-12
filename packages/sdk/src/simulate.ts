import { zeroAddress, type Address, type PublicClient } from 'viem';
import { demoSwapRouterAbi } from './abi/index.js';
import type { NetworkConfig } from './config.js';
import { failed, sameAddress, type Failed, type LookupOptions } from './lookup.js';
import { quoteExactInputSingle, swapParamsError, type SwapParams } from './quote.js';
import { describeError, revertData } from './revert.js';

export type SimulationResult = { status: 'simulated'; amountOut: bigint } | Failed;

export type DualSimulationResult =
  | {
      status: 'compared';
      quoted: bigint;
      simulated: bigint;
      /** (quoted - simulated) / quoted in basis points; positive when execution pays less than the quote. */
      divergenceBps: number;
      quoteGasEstimate: bigint;
      blockNumber: bigint;
    }
  | Failed;

/** Native balance the simulation gives the account: input plus generous gas headroom. Only affects the eth_call. */
const GAS_HEADROOM = 10n ** 24n;

export function inputCurrency(p: SwapParams): Address {
  return p.zeroForOne ? p.key.currency0 : p.key.currency1;
}

/**
 * eth_call of DemoSwapRouter.swapExactInputSingle from the swapper's own address, at the network gas price, so the
 * hook sees the same sender (the router), tx.origin and tx.gasprice as the real transaction. The account's native
 * balance is overridden for the call (input plus gas). ERC-20 input needs a real token balance and router allowance.
 */
export async function simulateSwap(
  client: PublicClient,
  config: NetworkConfig,
  account: Address,
  params: SwapParams,
  opts: LookupOptions = {},
): Promise<SimulationResult> {
  const inputError = swapParamsError(params);
  if (inputError) return failed('format', inputError);
  const native = sameAddress(inputCurrency(params), zeroAddress);
  try {
    const gasPrice = await client.getGasPrice();
    const { result } = await client.simulateContract({
      account,
      address: config.router,
      abi: demoSwapRouterAbi,
      functionName: 'swapExactInputSingle',
      args: [params.key, params.zeroForOne, params.amountIn, 0n, params.hookData ?? '0x'],
      value: native ? params.amountIn : 0n,
      gasPrice,
      // Gas at the real price needs native balance even for ERC-20 input; the override exists only in this eth_call.
      stateOverride: [{ address: account, balance: (native ? params.amountIn : 0n) + GAS_HEADROOM }],
      blockNumber: opts.blockNumber,
    });
    return { status: 'simulated', amountOut: result };
  } catch (e) {
    return failed(revertData(e) ? 'reverted' : 'rpc', describeError(e));
  }
}

const bps = (quoted: bigint, simulated: bigint) =>
  quoted === 0n ? (simulated === 0n ? 0 : -10_000) : Number(((quoted - simulated) * 10_000n) / quoted);

/**
 * Quote through V4Quoter and simulate the real swap at the same block, then compare. A hook that charges the quoter
 * less than real swappers (QuoteAwareFeeHook) shows up as a positive divergence.
 */
export async function dualSimulate(
  client: PublicClient,
  config: NetworkConfig,
  account: Address,
  params: SwapParams,
  opts: LookupOptions = {},
): Promise<DualSimulationResult> {
  let blockNumber = opts.blockNumber;
  try {
    blockNumber ??= await client.getBlockNumber();
  } catch (e) {
    return failed('rpc', e);
  }
  const [quote, simulation] = await Promise.all([
    quoteExactInputSingle(client, config, params, { blockNumber }),
    simulateSwap(client, config, account, params, { blockNumber }),
  ]);
  if (quote.status !== 'quoted') return quote;
  if (simulation.status !== 'simulated') return simulation;
  return {
    status: 'compared',
    quoted: quote.amountOut,
    simulated: simulation.amountOut,
    divergenceBps: bps(quote.amountOut, simulation.amountOut),
    quoteGasEstimate: quote.gasEstimate,
    blockNumber,
  };
}
