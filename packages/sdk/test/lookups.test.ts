import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createPublicClient, http, zeroAddress, type Address, type PublicClient } from 'viem';
import { anvil as anvilChain } from 'viem/chains';
import { feeCommitHookAbi } from '../src/abi/index.js';
import type { NetworkConfig } from '../src/config.js';
import { getCommitment } from '../src/feeCommit.js';
import { DYNAMIC_FEE_FLAG, hashPoolKey, type PoolKey } from '../src/poolKey.js';
import { getCanonicalPool } from '../src/registry.js';
import { startAnvil, type Anvil } from './anvil.js';

let chain: Anvil;
let config: NetworkConfig;
let token: Address;
let canonical: PoolKey;
let lookAlike: PoolKey;

before(async () => {
  chain = await startAnvil();
  config = chain.deployment.config;
  const demo = chain.deployment.demo!;
  token = demo.token;
  canonical = demo.pools.find((p) => p.label === 'canonical')!.key;
  lookAlike = demo.pools.find((p) => p.label === 'look-alike')!.key;
});
after(() => chain?.stop());

type Read = PublicClient['readContract'];
/** The real client with one readContract call (by function name) replaced. */
function withRead(name: string, replace: (args: Parameters<Read>[0], real: Read) => Promise<unknown>): PublicClient {
  const real = chain.client.readContract;
  return {
    ...chain.client,
    readContract: ((args: Parameters<Read>[0]) =>
      args.functionName === name ? replace(args, real) : real(args)) as Read,
  } as PublicClient;
}
const throwing = (name: string) => withRead(name, async () => Promise.reject(new Error('execution reverted')));
/** No code here on anvil. */
const EMPTY = '0x000000000000000000000000000000000000dead' as Address;
const offline = createPublicClient({ chain: anvilChain, transport: http('http://127.0.0.1:9', { retryCount: 0 }) });

describe('getCanonicalPool', () => {
  test('registered: the launchpad-declared pool, re-hashed and initialized', async () => {
    const result = await getCanonicalPool(chain.client, config, token);
    assert.equal(result.status, 'registered');
    if (result.status !== 'registered') return;
    assert.equal(result.poolId, hashPoolKey(canonical));
    assert.deepEqual(result.key, canonical);
    assert.equal(result.issuer, chain.deployment.demo!.launchpad);
    assert.equal(result.poolManager, config.poolManager);
    assert.ok(result.declaredAt > 0n);
  });

  test('not_registered only when the verified registry says so', async () => {
    assert.deepEqual(await getCanonicalPool(chain.client, config, config.router), { status: 'not_registered' });
  });

  test('bad token input', async () => {
    assert.equal((await getCanonicalPool(chain.client, config, zeroAddress)).status, 'lookup_failed');
    const r = await getCanonicalPool(chain.client, config, '0x1234' as Address);
    assert.equal(r.status === 'lookup_failed' && r.reason, 'format');
  });

  test('wrong chain, missing or foreign registry', async () => {
    const reason = async (c: NetworkConfig, client = chain.client) => {
      const r = await getCanonicalPool(client, c, token);
      return r.status === 'lookup_failed' ? r.reason : r.status;
    };
    assert.equal(await reason({ ...config, chainId: 143 }), 'chain');
    assert.equal(await reason({ ...config, registry: EMPTY }), 'contract-missing');
    assert.equal(await reason({ ...config, poolManager: config.quoter }), 'contract-mismatch');
    assert.equal(await reason(config, offline), 'rpc');
  });

  test('inconsistent records are record-mismatch or pool-uninitialized', async () => {
    const tamper = (over: (r: readonly [boolean, any]) => unknown) =>
      withRead('getCanonicalPool', async (args, real) => over((await real(args)) as readonly [boolean, any]));
    const otherId = tamper(([d, p]) => [d, { ...p, poolId: hashPoolKey(lookAlike) }]);
    const tokenless = tamper(([d, p]) => [d, { ...p, key: { ...p.key, currency1: config.router } }]);
    const uninitialized = withRead('extsload', async () => `0x${'0'.repeat(64)}`);
    for (const [client, reason] of [
      [otherId, 'record-mismatch'],
      [tokenless, 'record-mismatch'],
      [uninitialized, 'pool-uninitialized'],
    ] as const) {
      const r = await getCanonicalPool(client, config, token);
      assert.equal(r.status === 'lookup_failed' && r.reason, reason);
    }
  });

  test('no failure ever reads as not_registered', async () => {
    const clients = [throwing('getCanonicalPool'), throwing('poolManager'), throwing('extsload'), offline];
    for (const client of clients) {
      const r = await getCanonicalPool(client, config, token);
      assert.equal(r.status, 'lookup_failed');
    }
    const r = await getCanonicalPool(throwing('getCanonicalPool'), config, config.router);
    assert.equal(r.status, 'lookup_failed', 'even for an undeclared token');
  });
});

describe('getCommitment', () => {
  test('committed: trusted hook, matching code hash, cap and current fee', async () => {
    const r = await getCommitment(chain.client, config, canonical);
    assert.equal(r.status, 'committed');
    if (r.status !== 'committed') return;
    assert.equal(r.maxFee, 10_000);
    assert.equal(r.currentFee, 3_000);
    assert.equal(r.feeManager, chain.deployer.account!.address);
    assert.equal(r.poolId, hashPoolKey(canonical));
  });

  test('follows setFee within the cap', async () => {
    const hash = await chain.deployer.writeContract({
      address: canonical.hooks,
      abi: feeCommitHookAbi,
      functionName: 'setFee',
      args: [canonical, 5_000],
      chain: anvilChain,
      account: chain.deployer.account!,
    });
    await chain.client.waitForTransactionReceipt({ hash });
    const r = await getCommitment(chain.client, config, canonical);
    assert.equal(r.status === 'committed' && r.currentFee, 5_000);
  });

  test('not_committed: untrusted hook, static fee, no commitment for this key', async () => {
    assert.deepEqual(await getCommitment(chain.client, config, lookAlike), {
      status: 'not_committed',
      reason: 'untrusted-hook',
    });
    assert.deepEqual(await getCommitment(chain.client, config, { ...canonical, fee: 3_000 }), {
      status: 'not_committed',
      reason: 'static-fee',
    });
    assert.deepEqual(await getCommitment(chain.client, config, { ...canonical, tickSpacing: 10 }), {
      status: 'not_committed',
      reason: 'no-commitment',
    });
  });

  test('a trusted address is not enough: code hash must match', async () => {
    const wrongHash = { ...config, trustedFeeCommitHooks: [{ address: canonical.hooks, codeHash: `0x${'11'.repeat(32)}` as const }] };
    const r = await getCommitment(chain.client, wrongHash, canonical);
    assert.equal(r.status === 'lookup_failed' && r.reason, 'contract-mismatch');

    const noCode = { ...config, trustedFeeCommitHooks: [{ address: EMPTY, codeHash: config.trustedFeeCommitHooks[0]!.codeHash }] };
    const r2 = await getCommitment(chain.client, noCode, { ...canonical, hooks: EMPTY });
    assert.equal(r2.status === 'lookup_failed' && r2.reason, 'contract-missing');
  });

  test('failures are lookup_failed, never not_committed', async () => {
    const reason = async (client: PublicClient, c = config, key = canonical) => {
      const r = await getCommitment(client, c, key);
      return r.status === 'lookup_failed' ? r.reason : r.status;
    };
    assert.equal(await reason(chain.client, { ...config, chainId: 143 }), 'chain');
    assert.equal(await reason(offline), 'rpc');
    assert.equal(await reason(throwing('commitmentOf')), 'rpc');
    assert.equal(await reason(chain.client, config, { ...canonical, tickSpacing: 0 }), 'format');
    const overCap = withRead('commitmentOf', async (args, real) => ({
      ...((await real(args)) as object),
      currentFee: 20_000,
    }));
    assert.equal(await reason(overCap), 'record-mismatch');
    assert.equal(canonical.fee, DYNAMIC_FEE_FLAG);
  });
});
