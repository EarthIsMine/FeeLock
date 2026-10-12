import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { zeroAddress } from 'viem';
import { DEFAULT_DEPLOYMENTS_DIR, loadDeployment } from '../src/node.js';
import { chainFor, parseDeployment, rpcTransport, rpcUrlsFromEnv } from '../src/config.js';

const raw = async () => JSON.parse(await readFile(`${DEFAULT_DEPLOYMENTS_DIR}/31337.json`, 'utf8'));

test('loads deployments/31337.json into a NetworkConfig', async () => {
  const { config, demo } = await loadDeployment(31337);
  const file = await raw();
  assert.equal(config.chainId, 31337);
  assert.equal(config.poolManager, file.poolManager);
  assert.equal(config.registry, file.registry);
  assert.deepEqual(config.trustedFeeCommitHooks, [
    { address: file.feeCommitHook, codeHash: file.feeCommitHookCodeHash.toLowerCase() },
  ]);
  assert.equal(config.deployBlock, BigInt(file.deployBlock));
  assert.equal(demo?.pools[0]?.label, 'canonical');
  assert.equal(demo?.pools[0]?.key.hooks, file.feeCommitHook);
});

test('rejects a file for another chain', async () => {
  const file = await raw();
  assert.throws(() => parseDeployment({ ...file, chainId: 10143 }, 31337), /file is for 10143, expected 31337/);
  await assert.rejects(loadDeployment(31337, '/nonexistent'));
});

test('rejects undeployed core contracts and bad hashes', async () => {
  const file = await raw();
  assert.throws(() => parseDeployment({ ...file, registry: zeroAddress }), /registry: not deployed/);
  assert.throws(() => parseDeployment({ ...file, quoter: '0x1234' }), /quoter: not an address/);
  assert.throws(() => parseDeployment({ ...file, feeCommitHookCodeHash: `0x${'0'.repeat(64)}` }), /CodeHash/);
  const { poolManager: _, ...noManager } = file;
  assert.throws(() => parseDeployment(noManager), /poolManager: missing/);
});

test('rejects a demo pool whose poolId does not hash from its key', async () => {
  const file = await raw();
  file.demo.pools[1].poolId = file.demo.pools[0].poolId;
  assert.throws(() => parseDeployment(file), /pools\[1\]\.poolId: does not match key/);
});

test('a file without a demo token has no demo section', async () => {
  const file = await raw();
  file.demo = { launchpad: zeroAddress, seeder: zeroAddress, token: zeroAddress, attackHook: zeroAddress, pools: [] };
  assert.equal(parseDeployment(file).demo, undefined);
});

test('RPC URLs: primary first, fallback second, empty values skipped', () => {
  const env = { MONAD_MAINNET_RPC_URL: 'https://a', MONAD_MAINNET_RPC_URL_FALLBACK: ' https://b ', MONAD_TESTNET_RPC_URL: '' };
  assert.deepEqual(rpcUrlsFromEnv(143, env), ['https://a', 'https://b']);
  assert.deepEqual(rpcUrlsFromEnv(10143, env), []);
  assert.deepEqual(rpcUrlsFromEnv(31337, {}), ['http://127.0.0.1:8545']);
  assert.throws(() => rpcTransport([]), /no RPC URL/);
  assert.equal(rpcTransport(['https://a', 'https://b'])({}).config.type, 'fallback');
  assert.equal(rpcTransport(['https://a'])({}).config.type, 'http');
});

test('chainFor', () => {
  assert.equal(chainFor(143).id, 143);
  assert.equal(chainFor(10143).id, 10143);
  assert.equal(chainFor(31337).id, 31337);
  assert.throws(() => chainFor(1), /unsupported/);
});

test('rateLimited spaces requests and keeps them in order', async () => {
  const { custom } = await import('viem');
  const { rateLimited } = await import('../src/config.js');
  const starts: number[] = [];
  const base = custom({ request: async () => (starts.push(Date.now()), '0x1') });
  const t = rateLimited(base, 20)({});
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 5 }, () => t.request({ method: 'eth_chainId' })));
  assert.equal(starts.length, 5);
  assert.ok(starts[4]! - t0 >= 4 * 50 - 5, `5 requests at 20/s take >= 200ms, took ${starts[4]! - t0}`);
  for (let i = 1; i < 5; i++) assert.ok(starts[i]! >= starts[i - 1]!);
  assert.throws(() => rateLimited(base, 0), RangeError);
});
