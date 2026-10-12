import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { runDemo } from '../cli/demo.js';
import { startAnvil, TRADER_KEY, type Anvil } from './anvil.js';

let chain: Anvil;
before(async () => {
  chain = await startAnvil();
});
after(() => chain?.stop());

const options = { mode: 'both', amountIn: 10n ** 15n, slippageBps: 1500, maxFeePips: 10_000 } as const;

test('simulation only: naive picks the look-alike and loses ~10%, FeeLock routes to the canonical pool', async () => {
  const lines: string[] = [];
  const out = await runDemo(
    { client: chain.client, deployment: chain.deployment, log: (l) => lines.push(stripVTControlCharacters(l)) },
    { ...options, execute: false },
  );
  const text = lines.join('\n');
  assert.equal(out.naive?.pool.hooks, chain.deployment.demo!.attackHook);
  assert.ok(out.naive!.simulated! < out.naive!.quoted);
  assert.match(text, /look-alike .*← best quote/);
  assert.match(text, /execution pays .* 9\.9\d% less than quoted/);
  assert.match(text, /fits inside 15\.00% slippage/);
  assert.match(text, /look-alike\s+FEE_MISMATCH\s+execution pays 99\d bps less than the quote/);
  assert.match(text, /canonical\s+SAFE\s+fee 3000 pips, committed cap 10000 within your 10000 · canonical pool/);
  assert.match(text, /→ route canonical, hookData pins the 0\.30% fee/);
  assert.equal(out.feelock?.pool?.hooks, chain.deployment.config.trustedFeeCommitHooks[0]!.address);
});

test('5% slippage: the naive swap would revert', async () => {
  const lines: string[] = [];
  await runDemo(
    { client: chain.client, deployment: chain.deployment, log: (l) => lines.push(stripVTControlCharacters(l)) },
    { ...options, mode: 'naive', slippageBps: 500, execute: false },
  );
  assert.match(lines.join('\n'), /exceeds 5\.00% slippage: the swap reverts/);
});

test('--execute sends both swaps: naive receives the simulated loss, FeeLock receives its quote', async () => {
  const out = await runDemo(
    { client: chain.client, deployment: chain.deployment, privateKey: TRADER_KEY, log: () => {} },
    { ...options, execute: true },
  );
  assert.equal(out.naive?.received, out.naive?.simulated);
  assert.ok(out.naive!.received! < out.naive!.quoted);
  assert.equal(out.feelock?.received, out.feelock?.simulated);
  assert.ok(out.feelock!.received! > out.naive!.received!);
});

test('--execute without a key is refused', async () => {
  await assert.rejects(runDemo({ client: chain.client, deployment: chain.deployment, log: () => {} }, { ...options, execute: true }), /FEELOCK_PK/);
});
