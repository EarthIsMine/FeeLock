import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeAbiParameters, decodeFunctionData, getAddress, zeroAddress } from 'viem';
import { demoSwapRouterAbi } from '../src/abi/index.js';
import type { NetworkConfig } from '../src/config.js';
import { buildSwapCall, encodeMaxFeeHookData, minAmountOut, withGasMargin } from '../src/swap.js';

const TOKEN = getAddress('0x00000000000000000000000000000000000000aa');
const config = { router: '0x00000000000000000000000000000000000000bb' } as unknown as NetworkConfig;
const key = { currency0: zeroAddress, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress };

test('hookData is abi.encode(uint24)', () => {
  assert.deepEqual(decodeAbiParameters([{ type: 'uint24' }], encodeMaxFeeHookData(3000)), [3000]);
  assert.throws(() => encodeMaxFeeHookData(1_000_001), RangeError);
  assert.throws(() => encodeMaxFeeHookData(-1), RangeError);
});

test('swap calldata and native value', () => {
  const hookData = encodeMaxFeeHookData(3000);
  const buy = buildSwapCall(config, { key, zeroForOne: true, amountIn: 5n, minAmountOut: 4n, hookData });
  assert.equal(buy.to, config.router);
  assert.equal(buy.value, 5n);
  const { functionName, args } = decodeFunctionData({ abi: demoSwapRouterAbi, data: buy.data });
  assert.equal(functionName, 'swapExactInputSingle');
  assert.deepEqual(args, [key, true, 5n, 4n, hookData]);
  assert.equal(buildSwapCall(config, { key, zeroForOne: false, amountIn: 5n, minAmountOut: 0n }).value, 0n);
});

test('minAmountOut and gas margin', () => {
  assert.equal(minAmountOut(10_000n, 50), 9_950n);
  assert.equal(minAmountOut(999n, 0), 999n);
  assert.throws(() => minAmountOut(1n, 10_001), RangeError);
  assert.equal(withGasMargin(100_000n), 110_000n);
  assert.equal(withGasMargin(1n), 2n, 'rounds up');
});
