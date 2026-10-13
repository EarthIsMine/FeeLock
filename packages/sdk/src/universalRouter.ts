import { encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { sameAddress } from './lookup.js';
import { poolKeyAbi } from './poolKey.js';
import type { SwapParams } from './quote.js';
import type { SwapCall } from './swap.js';

/**
 * How a Universal Router's V4Router decodes SWAP_EXACT_IN_SINGLE params. v4-periphery added `minHopPriceX36` to
 * ExactInputSingleParams; routers built before that expect five fields. A legacy router fed the six-field layout does
 * not revert, it misreads the trailing fields (hookData among them), so the layout must match the router exactly.
 */
export type V4RouterLayout = 'legacy' | 'min-hop-price';

export interface UniversalRouterTarget {
  address: Address;
  layout: V4RouterLayout;
}

/** Universal Router command and V4Router actions (v4-periphery Actions.sol). */
export const UR_V4_SWAP = 0x10;
export const V4_SWAP_EXACT_IN_SINGLE = 0x06;
export const V4_SETTLE_ALL = 0x0c;
export const V4_TAKE_ALL = 0x0f;

export const universalRouterAbi = parseAbi([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

const exactInSingleLegacy = {
  type: 'tuple',
  components: [
    { ...poolKeyAbi, name: 'poolKey' },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'hookData', type: 'bytes' },
  ],
} as const;

const exactInSingleMinHop = {
  type: 'tuple',
  components: [
    { ...poolKeyAbi, name: 'poolKey' },
    { name: 'zeroForOne', type: 'bool' },
    { name: 'amountIn', type: 'uint128' },
    { name: 'amountOutMinimum', type: 'uint128' },
    { name: 'minHopPriceX36', type: 'uint256' },
    { name: 'hookData', type: 'bytes' },
  ],
} as const;

export interface UniversalRouterSwap extends SwapParams {
  minAmountOut: bigint;
  /** Unix seconds after which the router rejects the call. */
  deadline: bigint;
  /** Only for the 'min-hop-price' layout; 0 disables the check. */
  minHopPriceX36?: bigint;
}

/**
 * Universal Router `execute` calldata for one exact-input v4 hop: V4_SWAP with SWAP_EXACT_IN_SINGLE, SETTLE_ALL of
 * the input and TAKE_ALL of the output (to the caller, at least minAmountOut). hookData is passed to the pool's hook
 * as is, so FeeCommitHook's pinned fee applies. Native input sends amountIn as value; ERC-20 input needs a Permit2
 * allowance for the router.
 */
export function buildUniversalRouterSwapCall(target: UniversalRouterTarget, swap: UniversalRouterSwap): SwapCall {
  const { key, zeroForOne, amountIn, minAmountOut, deadline } = swap;
  const hookData = swap.hookData ?? '0x';
  const [input, output] = zeroForOne ? [key.currency0, key.currency1] : [key.currency1, key.currency0];
  const swapParams =
    target.layout === 'legacy'
      ? encodeAbiParameters([exactInSingleLegacy], [
          { poolKey: key, zeroForOne, amountIn, amountOutMinimum: minAmountOut, hookData },
        ])
      : encodeAbiParameters([exactInSingleMinHop], [
          { poolKey: key, zeroForOne, amountIn, amountOutMinimum: minAmountOut, minHopPriceX36: swap.minHopPriceX36 ?? 0n, hookData },
        ]);
  const params: Hex[] = [
    swapParams,
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [input, amountIn]),
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [output, minAmountOut]),
  ];
  const actions = encodePacked(['uint8', 'uint8', 'uint8'], [V4_SWAP_EXACT_IN_SINGLE, V4_SETTLE_ALL, V4_TAKE_ALL]);
  const v4Input = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [actions, params]);
  return {
    to: target.address,
    data: encodeFunctionData({
      abi: universalRouterAbi,
      functionName: 'execute',
      args: [encodePacked(['uint8'], [UR_V4_SWAP]), [v4Input], deadline],
    }),
    value: sameAddress(input, zeroAddress) ? amountIn : 0n,
  };
}
