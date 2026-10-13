import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { getAddress, zeroAddress } from 'viem';
import { DYNAMIC_FEE_FLAG, hashPoolKey } from '../src/poolKey.js';
import { fetchIndexedPools } from '../src/pools.js';

const TOKEN = getAddress('0x00000000000000000000000000000000000000aa');
const key = { currency0: zeroAddress, currency1: TOKEN, fee: DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: getAddress('0x0000000000000000000000000000000000002080') };
let body: unknown;
let status = 200;
let base: string;
const server = createServer((_, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test('parses, re-hashes and labels indexed pools', async () => {
  status = 200;
  body = { chainId: 10143, pools: [{ key, poolId: hashPoolKey(key), kind: 'fee-committed', canonical: true }] };
  const pools = await fetchIndexedPools(base, 10143, TOKEN, { labelOf: () => 'canonical' });
  assert.deepEqual(pools, [{ key, poolId: hashPoolKey(key), label: 'canonical', kind: 'fee-committed', canonical: true }]);
  const unlabelled = await fetchIndexedPools(base, 10143, TOKEN);
  assert.equal(unlabelled[0]!.label, `fee-committed ${hashPoolKey(key).slice(0, 8)}`);
});

test('rejects another chain, a tampered poolId and server errors', async () => {
  body = { chainId: 143, pools: [] };
  await assert.rejects(fetchIndexedPools(base, 10143, TOKEN), /chain 143/);
  body = { chainId: 10143, pools: [{ key, poolId: `0x${'00'.repeat(32)}` }] };
  await assert.rejects(fetchIndexedPools(base, 10143, TOKEN), /does not hash/);
  body = { chainId: 10143, pools: [{ key: { ...key, currency0: TOKEN, currency1: zeroAddress }, poolId: hashPoolKey(key) }] };
  await assert.rejects(fetchIndexedPools(base, 10143, TOKEN), /not sorted/);
  status = 503;
  body = { error: 'index not ready' };
  await assert.rejects(fetchIndexedPools(base, 10143, TOKEN), /503/);
});
