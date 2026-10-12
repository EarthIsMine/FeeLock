import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createPublicClient, createWalletClient, http, type Address, type WalletClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil as anvilChain } from 'viem/chains';
import { feeCommitHookAbi } from '../src/abi/index.js';
import type { NetworkConfig } from '../src/config.js';
import { feelockGuard, guardCandidates, type GuardInput } from '../src/guard.js';
import type { PoolKey } from '../src/poolKey.js';
import { describeError } from '../src/revert.js';
import { buildSwapCall, encodeMaxFeeHookData, minAmountOut } from '../src/swap.js';
import { startAnvil, TRADER_KEY, type Anvil } from './anvil.js';

const TRADE = 10n ** 15n;

let chain: Anvil;
let config: NetworkConfig;
let token: Address;
let canonical: PoolKey;
let lookAlike: PoolKey;
let trader: WalletClient;

before(async () => {
  chain = await startAnvil();
  config = chain.deployment.config;
  const demo = chain.deployment.demo!;
  token = demo.token;
  canonical = demo.pools.find((p) => p.label === 'canonical')!.key;
  lookAlike = demo.pools.find((p) => p.label === 'look-alike')!.key;
  trader = createWalletClient({ chain: anvilChain, transport: http(chain.rpcUrl), account: privateKeyToAccount(TRADER_KEY) });
});
after(() => chain?.stop());

const input = (over: Partial<GuardInput> = {}): GuardInput => ({
  client: chain.client,
  config,
  account: trader.account!.address,
  token,
  route: [canonical],
  amountIn: TRADE,
  zeroForOne: true,
  maxFeePips: 10_000,
  ...over,
});

describe('feelockGuard', () => {
  test('canonical fee-committed pool: SAFE, with hookData pinning the quoted fee and a gas limit', async () => {
    const r = await feelockGuard(input());
    assert.equal(r.verdict, 'SAFE', r.hops[0]?.reasons.join('; ') ?? '');
    assert.equal(r.hookData, encodeMaxFeeHookData(3000));
    assert.ok(r.gasLimit && r.gasLimit > 21_000n);
    assert.deepEqual(r.hops[0]?.reasons, ['fee 3000 pips, committed cap 10000 within your 10000', 'canonical pool']);
  });

  test('look-alike pool: FEE_MISMATCH from the dual simulation', async () => {
    const r = await feelockGuard(input({ route: [lookAlike] }));
    assert.equal(r.verdict, 'FEE_MISMATCH');
    assert.equal(r.hookData, undefined);
    assert.equal(r.gasLimit, undefined);
    assert.match(r.hops[0]!.reasons[0]!, /execution pays 99\d bps less than the quote/);
    assert.equal(r.hops[0]!.reasons.at(-1), 'not the canonical pool');
  });

  test('a cap above the user limit is UNVERIFIED, without hookData', async () => {
    const r = await feelockGuard(input({ maxFeePips: 5_000 }));
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.equal(r.hookData, undefined);
    assert.equal(r.hops[0]!.hookData, '0x');
  });

  test('input errors are LOOKUP_FAILED before any RPC', async () => {
    const other = { ...canonical, currency1: config.router };
    for (const over of [{ route: [other] }, { route: [] }, { route: [canonical, canonical] }, { maxFeePips: -1 }]) {
      const r = await feelockGuard(input(over as Partial<GuardInput>));
      assert.equal(r.verdict, 'LOOKUP_FAILED');
      assert.ok(r.errors && r.errors.length > 0);
    }
  });

  test('an unreachable RPC holds the swap', async () => {
    const offline = createPublicClient({ chain: anvilChain, transport: http('http://127.0.0.1:9', { retryCount: 0 }) });
    assert.equal((await feelockGuard(input({ client: offline }))).verdict, 'LOOKUP_FAILED');
  });
});

describe('guardCandidates', () => {
  test('requote over SAFE pools only: the canonical pool wins, the better-quoted look-alike is blocked', async () => {
    const { candidates, best } = await guardCandidates({ ...input(), candidates: [lookAlike, canonical] });
    assert.deepEqual(candidates.map((c) => c.result.verdict), ['FEE_MISMATCH', 'SAFE']);
    assert.equal(best?.key.hooks, canonical.hooks);
  });
});

describe('executing a SAFE result', () => {
  test('pays exactly the simulated amount; a fee raised after the guard reverts the swap', async () => {
    const r = await feelockGuard(input());
    const dual = r.hops[0]!.dual;
    assert.equal(dual.status, 'compared');
    if (dual.status !== 'compared') return;
    const call = buildSwapCall(config, {
      key: canonical,
      zeroForOne: true,
      amountIn: TRADE,
      hookData: r.hookData,
      minAmountOut: minAmountOut(dual.simulated, 50),
    });

    const receipt = await chain.client.waitForTransactionReceipt({
      hash: await trader.sendTransaction({ ...call, gas: r.gasLimit, account: trader.account!, chain: anvilChain }),
    });
    assert.equal(receipt.status, 'success');
    assert.ok(receipt.gasUsed <= r.gasLimit!);

    // Same hookData, but the fee manager has raised the fee within the cap since the guard ran.
    const raise = await chain.deployer.writeContract({
      address: canonical.hooks,
      abi: feeCommitHookAbi,
      functionName: 'setFee',
      args: [canonical, 10_000],
      chain: anvilChain,
      account: chain.deployer.account!,
    });
    assert.equal((await chain.client.waitForTransactionReceipt({ hash: raise })).status, 'success');
    const stale = buildSwapCall(config, { key: canonical, zeroForOne: true, amountIn: TRADE, hookData: r.hookData, minAmountOut: 0n });
    await assert.rejects(chain.client.call({ ...stale, account: trader.account!.address }), (e: unknown) => {
      assert.match(describeError(e), /^FeeAboveUserLimit\(10000, 3000\) via beforeSwap/);
      return true;
    });
    const again = await feelockGuard(input());
    assert.equal(again.verdict, 'SAFE', 'still within the 1% limit; requoting pins the new fee');
    assert.equal(again.hookData, encodeMaxFeeHookData(10_000));
  });
});
