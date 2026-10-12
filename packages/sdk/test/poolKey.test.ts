import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zeroAddress, type Address } from 'viem';
import { loadDeployment } from '../src/node.js';
import {
  DYNAMIC_FEE_FLAG,
  hasCurrency,
  hashPoolKey,
  isDynamicFee,
  isStatic,
  poolKeyError,
  type PoolKey,
} from '../src/poolKey.js';

const TOKEN = '0xd1936bBbC76761e4AB41d3522C3fa204b901D353' as Address;
const HOOK = '0xd5F07e4cf5A97545b9e9Bb30F700269b79Df6080' as Address;
const key = (over: Partial<PoolKey> = {}): PoolKey => ({
  currency0: zeroAddress,
  currency1: TOKEN,
  fee: 3000,
  tickSpacing: 60,
  hooks: zeroAddress,
  ...over,
});

test('hashPoolKey matches the poolIds forge recorded on anvil', async () => {
  const { demo } = await loadDeployment(31337);
  assert.ok(demo, 'deployments/31337.json has a demo section');
  assert.deepEqual(demo.pools.map((p) => p.label), ['canonical', 'look-alike', 'state-flip']);
  for (const pool of demo.pools) assert.equal(hashPoolKey(pool.key), pool.poolId, pool.label);
});

test('hashPoolKey is case-insensitive in addresses', () => {
  const lower = key({ currency1: TOKEN.toLowerCase() as Address });
  assert.equal(hashPoolKey(lower), hashPoolKey(key()));
});

test('isStatic: no hook and a fixed fee only', () => {
  assert.equal(isStatic(key()), true);
  assert.equal(isStatic(key({ hooks: HOOK })), false, 'a hook may take fees through deltas');
  assert.equal(isStatic(key({ fee: DYNAMIC_FEE_FLAG })), false);
  assert.equal(isDynamicFee(key({ fee: DYNAMIC_FEE_FLAG, hooks: HOOK })), true);
});

test('hasCurrency', () => {
  assert.equal(hasCurrency(key(), TOKEN.toLowerCase() as Address), true);
  assert.equal(hasCurrency(key(), HOOK), false);
});

test('poolKeyError rejects keys PoolManager could never initialize', () => {
  assert.equal(poolKeyError(key()), null);
  assert.equal(poolKeyError(key({ fee: DYNAMIC_FEE_FLAG, hooks: HOOK })), null);
  assert.match(poolKeyError(key({ currency0: TOKEN, currency1: zeroAddress }))!, /not sorted/);
  assert.match(poolKeyError(key({ currency0: TOKEN }))!, /not sorted/, 'identical currencies');
  assert.match(poolKeyError(key({ fee: 1_000_001 }))!, /fee/);
  assert.match(poolKeyError(key({ fee: -1 }))!, /fee/);
  assert.match(poolKeyError(key({ tickSpacing: 0 }))!, /tickSpacing/);
  assert.match(poolKeyError(key({ tickSpacing: 32_768 }))!, /tickSpacing/);
  assert.match(poolKeyError(key({ hooks: '0x1234' as Address }))!, /address/);
});
