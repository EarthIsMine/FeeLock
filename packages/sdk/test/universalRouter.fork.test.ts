// Monad mainnet fork: swaps through the official Universal Router with SDK-built calldata.
// Opt-in: FEELOCK_FORK_TESTS=1 [MONAD_MAINNET_RPC_URL=...] pnpm -F @feelock/sdk test
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createPublicClient, createWalletClient, encodeAbiParameters, erc20Abi, http, zeroAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monad } from 'viem/chains';
import { feeCommitHookAbi } from '../src/abi/index.js';
import { MONAD_MAINNET_UNIVERSAL_ROUTERS, MONAD_MAINNET_V4 } from '../src/monad.js';
import type { PoolKey } from '../src/poolKey.js';
import { quoteExactInputSingle } from '../src/quote.js';
import { describeError } from '../src/revert.js';
import { encodeMaxFeeHookData } from '../src/swap.js';
import { buildUniversalRouterSwapCall, type UniversalRouterTarget } from '../src/universalRouter.js';
import { DEPLOYER_KEY, startAnvil, TRADER_KEY, type Anvil } from './anvil.js';

const enabled = process.env.FEELOCK_FORK_TESTS === '1';
const FORK_URL = process.env.MONAD_MAINNET_RPC_URL || 'https://rpc.monad.xyz';
const TRADE = 10n ** 15n;
const ZERO32 = `0x${'0'.repeat(64)}`;

describe('Universal Router on a Monad mainnet fork', { skip: !enabled && 'set FEELOCK_FORK_TESTS=1' }, () => {
  let chain: Anvil;
  let key: PoolKey;
  let token: `0x${string}`;
  const clients = () => {
    const transport = http(chain.rpcUrl);
    const client = createPublicClient({ chain: monad, transport, pollingInterval: 100 });
    const wallet = (pk: Hex) => createWalletClient({ chain: monad, transport, account: privateKeyToAccount(pk) });
    return { client, trader: wallet(TRADER_KEY), feeManager: wallet(DEPLOYER_KEY) };
  };

  before(async () => {
    // Official v4 contracts; our registry, hook and a launched demo token are deployed onto the fork.
    chain = await startAnvil({
      forkUrl: FORK_URL,
      scripts: ['DeployFeeLock', 'DemoSetup'],
      seed: {
        deployBlock: 0,
        poolManager: MONAD_MAINNET_V4.poolManager,
        quoter: MONAD_MAINNET_V4.quoter,
        stateView: MONAD_MAINNET_V4.stateView,
        router: MONAD_MAINNET_UNIVERSAL_ROUTERS.latest.address,
        registry: zeroAddress,
        feeCommitHook: zeroAddress,
        feeCommitHookCodeHash: ZERO32,
        demo: { launchpad: zeroAddress, seeder: zeroAddress, token: zeroAddress, attackHook: zeroAddress, stateFlipHook: zeroAddress, pools: [] },
      },
    });
    const demo = chain.deployment.demo!;
    assert.deepEqual(demo.pools.map((p) => p.label), ['canonical'], 'no attack pools on chain 143');
    key = demo.pools[0]!.key;
    token = demo.token;
  });
  after(() => chain?.stop());

  async function swapVia(target: UniversalRouterTarget, hookData: Hex, minAmountOut: bigint) {
    const { client, trader } = clients();
    const call = buildUniversalRouterSwapCall(target, {
      key, zeroForOne: true, amountIn: TRADE, minAmountOut, hookData, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    const before = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [trader.account.address] });
    const hash = await trader.sendTransaction({ ...call, gas: 1_000_000n });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const after = await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [trader.account.address] });
    return { receipt, received: after - before, call };
  }

  test('the official quoter quote is what the latest Universal Router pays, with the fee pinned in hookData', async () => {
    const { client } = clients();
    const hookData = encodeMaxFeeHookData(3000);
    const quote = await quoteExactInputSingle(client, chain.deployment.config, { key, zeroForOne: true, amountIn: TRADE, hookData });
    assert.equal(quote.status, 'quoted');
    if (quote.status !== 'quoted') return;
    const { receipt, received } = await swapVia(MONAD_MAINNET_UNIVERSAL_ROUTERS.latest, hookData, quote.amountOut);
    assert.equal(receipt.status, 'success');
    assert.equal(received, quote.amountOut);
  });

  test('the legacy router with the legacy layout pays the quote too', async () => {
    const { client } = clients();
    const hookData = encodeMaxFeeHookData(3000);
    const quote = await quoteExactInputSingle(client, chain.deployment.config, { key, zeroForOne: true, amountIn: TRADE, hookData });
    if (quote.status !== 'quoted') return assert.fail('quote failed');
    const { receipt, received } = await swapVia(MONAD_MAINNET_UNIVERSAL_ROUTERS.legacy, hookData, quote.amountOut);
    assert.equal(receipt.status, 'success');
    assert.equal(received, quote.amountOut);
  });

  test('the five-field layout is rejected by the latest router', async () => {
    const { client, trader } = clients();
    const call = buildUniversalRouterSwapCall(
      { address: MONAD_MAINNET_UNIVERSAL_ROUTERS.latest.address, layout: 'legacy' },
      { key, zeroForOne: true, amountIn: TRADE, minAmountOut: 0n, hookData: encodeMaxFeeHookData(3000), deadline: 2n ** 40n },
    );
    await assert.rejects(client.call({ ...call, account: trader.account.address }));
  });

  test('a fee raised after the quote reverts through the Universal Router', async () => {
    const { client, trader, feeManager } = clients();
    const pinned = encodeMaxFeeHookData(3000);
    const raise = await feeManager.writeContract({ address: key.hooks, abi: feeCommitHookAbi, functionName: 'setFee', args: [key, 10_000] });
    assert.equal((await client.waitForTransactionReceipt({ hash: raise })).status, 'success');
    const call = buildUniversalRouterSwapCall(MONAD_MAINNET_UNIVERSAL_ROUTERS.latest, {
      key, zeroForOne: true, amountIn: TRADE, minAmountOut: 0n, hookData: pinned, deadline: 2n ** 40n,
    });
    await assert.rejects(client.call({ ...call, account: trader.account.address }), (e: unknown) => {
      assert.match(describeError(e), /FeeAboveUserLimit\(10000, 3000\)/);
      return true;
    });
    // Without a pin the swap still goes through, at most at the 1% cap.
    const capped = buildUniversalRouterSwapCall(MONAD_MAINNET_UNIVERSAL_ROUTERS.latest, {
      key, zeroForOne: true, amountIn: TRADE, minAmountOut: 0n, hookData: encodeAbiParameters([], []), deadline: 2n ** 40n,
    });
    await client.call({ ...capped, account: trader.account.address });
  });
});
