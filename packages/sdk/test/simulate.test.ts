import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  http,
  maxUint256,
  type Address,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil as anvilChain } from 'viem/chains';
import { demoSwapRouterAbi } from '../src/abi/index.js';
import type { NetworkConfig } from '../src/config.js';
import type { PoolKey } from '../src/poolKey.js';
import { bestQuote, quoteCandidates, quoteExactInputSingle } from '../src/quote.js';
import { dualSimulate, simulateSwap } from '../src/simulate.js';
import { startAnvil, TRADER_KEY, type Anvil } from './anvil.js';

const TRADE = 10n ** 15n; // 0.001 MON
/** Never funded on anvil: the simulation's balance override must carry it. */
const FRESH = '0x00000000000000000000000000000000000fee10' as Address;
const maxFee = (fee: number) => encodeAbiParameters([{ type: 'uint24' }], [fee]);

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

const buy = (key: PoolKey, hookData?: `0x${string}`) => ({ key, zeroForOne: true, amountIn: TRADE, hookData });

describe('quotes', () => {
  test('a best-quote router picks the look-alike', async () => {
    const quotes = await quoteCandidates(chain.client, config, [canonical, lookAlike], { zeroForOne: true, amountIn: TRADE });
    assert.ok(quotes.every((q) => q.quote.status === 'quoted'));
    assert.equal(bestQuote(quotes)?.key.hooks, lookAlike.hooks);
  });

  test('bad input is a format failure', async () => {
    const r = await quoteExactInputSingle(chain.client, config, { ...buy(canonical), amountIn: 0n });
    assert.equal(r.status === 'lookup_failed' && r.reason, 'format');
  });
});

describe('dualSimulate', () => {
  test('canonical fee-committed pool: quote == execution, from an unfunded address', async () => {
    const r = await dualSimulate(chain.client, config, FRESH, buy(canonical, maxFee(10_000)));
    assert.equal(r.status, 'compared');
    if (r.status !== 'compared') return;
    assert.equal(r.simulated, r.quoted);
    assert.equal(r.divergenceBps, 0);
  });

  test('look-alike pool: execution pays ~10% less than the quote', async () => {
    const r = await dualSimulate(chain.client, config, FRESH, buy(lookAlike));
    assert.equal(r.status, 'compared');
    if (r.status !== 'compared') return;
    assert.ok(r.simulated < r.quoted);
    assert.ok(Math.abs(r.divergenceBps - 995) <= 15, `divergence ${r.divergenceBps} bps`);
  });

  test('swapper limit below the fee: both paths revert with the decoded reason', async () => {
    const r = await dualSimulate(chain.client, config, FRESH, buy(canonical, maxFee(2_999)));
    assert.equal(r.status === 'lookup_failed' && r.reason, 'reverted');
    assert.match(r.status === 'lookup_failed' ? r.detail! : '', /^FeeAboveUserLimit\(3000, 2999\) via beforeSwap of 0x/);

    const s = await simulateSwap(chain.client, config, FRESH, buy(canonical, maxFee(2_999)));
    assert.match(s.status === 'lookup_failed' ? s.detail! : '', /FeeAboveUserLimit\(3000, 2999\) via beforeSwap/);
  });

  test('ERC-20 input needs a real balance and allowance', async () => {
    const sell = { key: canonical, zeroForOne: false, amountIn: 10n ** 18n };
    const before = await simulateSwap(chain.client, config, FRESH, sell);
    assert.equal(before.status === 'lookup_failed' && before.reason, 'reverted');

    // The trader buys tokens for real, approves the router, and the sell then simulates exactly as quoted.
    const trader = createWalletClient({ chain: anvilChain, transport: http(chain.rpcUrl), account: privateKeyToAccount(TRADER_KEY) });
    const send = async (hash: Promise<`0x${string}`>) => chain.client.waitForTransactionReceipt({ hash: await hash });
    await send(
      trader.writeContract({
        address: config.router,
        abi: demoSwapRouterAbi,
        functionName: 'swapExactInputSingle',
        args: [canonical, true, TRADE, 0n, '0x'],
        value: TRADE,
      }),
    );
    await send(trader.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args: [config.router, maxUint256] }));
    const r = await dualSimulate(chain.client, config, trader.account.address, sell);
    assert.equal(r.status === 'compared' && r.divergenceBps, 0);
  });

  test('simulates at the network gas price, as the real transaction would', async () => {
    let seen: bigint | undefined;
    const spy = {
      ...chain.client,
      simulateContract: ((args: { gasPrice?: bigint }) => {
        seen = args.gasPrice;
        return chain.client.simulateContract(args as never);
      }) as PublicClient['simulateContract'],
    } as PublicClient;
    await simulateSwap(spy, config, FRESH, buy(canonical));
    assert.equal(seen, await chain.client.getGasPrice());
    assert.ok(seen! > 0n);
  });

  test('RPC failure is lookup_failed', async () => {
    const offline = createPublicClient({ chain: anvilChain, transport: http('http://127.0.0.1:9', { retryCount: 0 }) });
    const r = await dualSimulate(offline, config, FRESH, buy(canonical));
    assert.equal(r.status === 'lookup_failed' && r.reason, 'rpc');
  });
});
