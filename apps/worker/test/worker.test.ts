import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { PublicClient } from 'viem';
import { startAnvil, type Anvil } from '../../../packages/sdk/test/anvil.js';
import { indexOnce, startServer } from '../src/index.js';
import { scanLogs } from '../src/scan.js';
import type { PoolIndex } from '../src/store.js';

let chain: Anvil;
let dir: string;
before(async () => {
  chain = await startAnvil();
  dir = await mkdtemp(join(tmpdir(), 'feelock-worker-'));
});
after(async () => {
  await chain?.stop();
  if (dir) await rm(dir, { recursive: true, force: true });
});

const byLabel = (index: PoolIndex) => {
  const demo = chain.deployment.demo!;
  return Object.fromEntries(
    index.classified.map((p) => [demo.pools.find((d) => d.poolId === p.poolId)?.label ?? p.poolId, p]),
  );
};

test('indexes and classifies the demo pools', async () => {
  const index = await indexOnce(chain.client, chain.deployment.config, { path: join(dir, 'one.json'), chunk: 5n });
  assert.equal(index.classified.length, 3);
  const pools = byLabel(index);
  assert.equal(pools.canonical?.kind, 'fee-committed');
  assert.equal(pools.canonical?.canonical, true);
  assert.equal(pools.canonical?.canonicalFor, chain.deployment.demo!.token);
  assert.deepEqual(pools.canonical?.commitment, { maxFee: 10_000, currentFee: 3_000 });
  assert.equal(pools['look-alike']?.kind, 'unverified');
  assert.equal(pools['state-flip']?.kind, 'unverified');
  assert.equal(pools['look-alike']?.canonical, false);
});

test('a scan split in two passes equals one pass, and resumes after the checkpoint', async () => {
  const latest = await chain.client.getBlockNumber({ cacheTime: 0 });
  const path = join(dir, 'two.json');
  const first = await indexOnce(chain.client, chain.deployment.config, { path, chunk: 3n, toBlock: latest / 2n });
  assert.equal(first.scannedThrough, (latest / 2n).toString());
  const second = await indexOnce(chain.client, chain.deployment.config, { path, chunk: 3n, toBlock: latest });
  const single = await indexOnce(chain.client, chain.deployment.config, { path: join(dir, 'single.json'), toBlock: latest });
  assert.deepEqual(second.pools, single.pools);
  assert.deepEqual(second.declarations, single.declarations);
  assert.deepEqual(second.classified, single.classified);
});

test('a range the RPC refuses is retried in smaller chunks', async () => {
  let refused = 0;
  const strict = {
    ...chain.client,
    getLogs: ((args: { fromBlock: bigint; toBlock: bigint }) => {
      if (args.toBlock - args.fromBlock + 1n > 4n) {
        refused++;
        return Promise.reject(new Error('eth_getLogs is limited to a 4 range'));
      }
      return chain.client.getLogs(args as never);
    }) as PublicClient['getLogs'],
  } as PublicClient;
  const latest = await chain.client.getBlockNumber({ cacheTime: 0 });
  const all = await scanLogs(chain.client, chain.deployment.config, { fromBlock: 0n, toBlock: latest, chunk: 100n });
  const limited = await scanLogs(strict, chain.deployment.config, { fromBlock: 0n, toBlock: latest, chunk: 100n });
  assert.ok(refused > 0);
  assert.deepEqual(limited.pools, all.pools);
  assert.deepEqual(limited.declarations, all.declarations);
});

test('HTTP API: pools by token, health, input errors', async () => {
  const index = await indexOnce(chain.client, chain.deployment.config, { path: join(dir, 'api.json') });
  const server = await startServer(() => index, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const get = async (p: string) => {
      const r = await fetch(base + p);
      return { status: r.status, cors: r.headers.get('access-control-allow-origin'), body: (await r.json()) as Record<string, unknown> };
    };
    const forToken = await get(`/pools?token=${chain.deployment.demo!.token}`);
    assert.equal(forToken.status, 200);
    assert.equal(forToken.cors, '*');
    assert.equal((forToken.body.pools as unknown[]).length, 3);
    assert.equal(((await get(`/pools?token=0x${'11'.repeat(20)}`)).body.pools as unknown[]).length, 0);
    assert.equal((await get('/pools?token=nope')).status, 400);
    assert.equal((await get('/health')).body.ok, true);
    assert.equal((await get('/other')).status, 404);
  } finally {
    server.close();
  }
});
