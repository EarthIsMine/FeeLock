import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeAbiParameters, decodeFunctionData, getAddress, zeroAddress, type Hex } from 'viem';
import { MONAD_MAINNET_UNIVERSAL_ROUTERS } from '../src/monad.js';
import { DYNAMIC_FEE_FLAG, poolKeyAbi } from '../src/poolKey.js';
import { encodeMaxFeeHookData } from '../src/swap.js';
import { buildUniversalRouterSwapCall, universalRouterAbi, type V4RouterLayout } from '../src/universalRouter.js';

const TOKEN = getAddress('0x00000000000000000000000000000000000000aa');
const HOOK = getAddress('0x0000000000000000000000000000000000002080');
const key = { currency0: zeroAddress, currency1: TOKEN, fee: DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: HOOK };
const hookData = encodeMaxFeeHookData(3000);

function decode(layout: V4RouterLayout, zeroForOne = true) {
  const target = { address: MONAD_MAINNET_UNIVERSAL_ROUTERS.latest.address, layout } as const;
  const call = buildUniversalRouterSwapCall(target, { key, zeroForOne, amountIn: 5n, minAmountOut: 4n, hookData, deadline: 99n });
  const { args } = decodeFunctionData({ abi: universalRouterAbi, data: call.data });
  const [commands, inputs, deadline] = args;
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], inputs[0]!);
  return { call, commands, deadline, actions, params: params as readonly Hex[] };
}

test('one V4_SWAP command: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL', () => {
  const { call, commands, deadline, actions, params } = decode('min-hop-price');
  assert.equal(call.to, MONAD_MAINNET_UNIVERSAL_ROUTERS.latest.address);
  assert.equal(call.value, 5n, 'native input is sent as value');
  assert.equal(commands, '0x10');
  assert.equal(deadline, 99n);
  assert.equal(actions, '0x060c0f');
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]!), [zeroAddress, 5n]);
  assert.deepEqual(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]!), [TOKEN, 4n]);
});

test('min-hop-price layout carries minHopPriceX36 before hookData', () => {
  const { params } = decode('min-hop-price');
  const [p] = decodeAbiParameters(
    [{ type: 'tuple', components: [{ ...poolKeyAbi, name: 'poolKey' }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'minHopPriceX36', type: 'uint256' }, { name: 'hookData', type: 'bytes' }] }],
    params[0]!,
  );
  assert.deepEqual(p, { poolKey: key, zeroForOne: true, amountIn: 5n, amountOutMinimum: 4n, minHopPriceX36: 0n, hookData });
});

test('legacy layout has five fields', () => {
  const { params } = decode('legacy');
  const [p] = decodeAbiParameters(
    [{ type: 'tuple', components: [{ ...poolKeyAbi, name: 'poolKey' }, { name: 'zeroForOne', type: 'bool' }, { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'hookData', type: 'bytes' }] }],
    params[0]!,
  );
  assert.deepEqual(p, { poolKey: key, zeroForOne: true, amountIn: 5n, amountOutMinimum: 4n, hookData });
});

test('ERC-20 input: no value, settles the token and takes the native output', () => {
  const { call, params } = decode('min-hop-price', false);
  assert.equal(call.value, 0n);
  assert.equal(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]!)[0], TOKEN);
  assert.equal(decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]!)[0], zeroAddress);
});
