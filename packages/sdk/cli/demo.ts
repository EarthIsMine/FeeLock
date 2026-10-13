/**
 * Naive best-quote routing vs FeeLock, in the terminal.
 *
 *   pnpm -F @feelock/sdk demo [--mode naive|feelock|both] [--amount 0.001] [--slippage 1500] [--max-fee 10000]
 *                             [--chain 31337] [--execute] [--scenario quote|flip]
 *
 * --scenario flip runs scenario 2 (StateFlipFeeHook: a fee raised between quote and execution).
 * --pools-api <url> (or FEELOCK_POOLS_API) takes candidates from the apps/worker indexer, else the deployments file.
 *
 * Candidates are the demo pools in contracts/deployments/<chain>.json. Without --execute nothing is sent: execution
 * is shown as a simulation from the account. --execute needs FEELOCK_PK (from the environment or the repo .env).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs, styleText } from 'node:util';
import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  formatUnits,
  parseEther,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { demoSwapRouterAbi, feeCommitHookAbi, stateFlipFeeHookAbi } from '../src/abi/index.js';
import { chainFor, rpcTransport, rpcUrlsFromEnv, type Deployment } from '../src/config.js';
import { feelockGuard, guardCandidates, type GuardResult } from '../src/guard.js';
import { loadDeployment } from '../src/node.js';
import { hashPoolKey, type PoolKey } from '../src/poolKey.js';
import { fetchIndexedPools, type CandidatePool } from '../src/pools.js';
import { bestQuote, quoteCandidates } from '../src/quote.js';
import { describeError } from '../src/revert.js';
import { simulateSwap } from '../src/simulate.js';
import { buildSwapCall, minAmountOut } from '../src/swap.js';

/** Simulation-only account when no key is configured. Never funded; the simulation overrides its balance. */
const OBSERVER = '0x00000000000000000000000000000000000fee10' as Address;

export interface DemoOptions {
  mode: 'naive' | 'feelock' | 'both';
  amountIn: bigint;
  slippageBps: number;
  maxFeePips: number;
  execute: boolean;
}

export interface DemoContext {
  client: PublicClient;
  deployment: Deployment;
  /** Candidate pools; default: the demo pools in the deployments file. */
  pools?: CandidatePool[];
  /** Required for execute. */
  privateKey?: Hex;
  log?: (line: string) => void;
}

export interface DemoOutcome {
  naive?: { pool: PoolKey; quoted: bigint; simulated?: bigint; received?: bigint; reverted?: string };
  feelock?: { pool?: PoolKey; results: GuardResult[]; simulated?: bigint; received?: bigint };
}

const color = (format: Parameters<typeof styleText>[0], text: string) => styleText(format, text);
const VERDICT_COLOR = { SAFE: 'green', UNVERIFIED: 'yellow', LOOKUP_FAILED: 'yellow', FEE_MISMATCH: 'red' } as const;

export async function runDemo(ctx: DemoContext, opts: DemoOptions): Promise<DemoOutcome> {
  const log = ctx.log ?? console.log;
  const { client, deployment } = ctx;
  const { config, demo } = deployment;
  if (!demo || demo.pools.length === 0) throw new Error(`no demo pools in deployments/${config.chainId}.json`);
  if (opts.execute && !ctx.privateKey) throw new Error('--execute needs FEELOCK_PK');

  const account = ctx.privateKey ? privateKeyToAccount(ctx.privateKey) : undefined;
  const from = account?.address ?? OBSERVER;
  const wallet = account
    ? createWalletClient({ account, chain: client.chain, transport: custom({ request: client.request }) })
    : undefined;
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: demo.token, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address: demo.token, abi: erc20Abi, functionName: 'decimals' }),
  ]);
  const amount = (v: bigint) => Number(formatUnits(v, decimals)).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
  const pools = ctx.pools ?? demo.pools.map((p) => ({ key: p.key, poolId: p.poolId, label: p.label }));
  const label = (key: PoolKey) => pools.find((p) => p.poolId === hashPoolKey(key))?.label ?? hashPoolKey(key).slice(0, 10);
  const candidates = pools.map((p) => p.key);
  const trade = { zeroForOne: true, amountIn: opts.amountIn };
  const outcome: DemoOutcome = {};

  log(color('bold', `FeeLock demo · chain ${config.chainId} · ${formatUnits(opts.amountIn, 18)} MON → ${symbol}`));
  log(`account ${from}${account ? '' : ' (simulation only)'}\n`);

  const quotes = await quoteCandidates(client, config, candidates, trade);
  const best = bestQuote(quotes);
  log(color('bold', 'Candidate pools (V4Quoter)'));
  for (const { key, quote } of quotes) {
    const q = quote.status === 'quoted' ? `${amount(quote.amountOut)} ${symbol}` : `quote failed: ${quote.reason}`;
    const mark = best && hashPoolKey(best.key) === hashPoolKey(key) ? color('cyan', '  ← best quote') : '';
    log(`  ${label(key).padEnd(12)} hook ${key.hooks.slice(0, 10)}…  ${q}${mark}`);
  }
  log('');

  const send = async (key: PoolKey, minOut: bigint, hookData: Hex | undefined, gas?: bigint) => {
    const call = buildSwapCall(config, { key, ...trade, hookData, minAmountOut: minOut });
    const hash = await wallet!.sendTransaction({ ...call, gas, account: account!, chain: client.chain });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') return { hash, reverted: true as const };
    const [event] = parseEventLogs({ abi: demoSwapRouterAbi, eventName: 'SwapExecuted', logs: receipt.logs });
    return { hash, received: event!.args.amountOut };
  };

  if (opts.mode !== 'feelock') {
    log(color('bold', '[naive] route to the best quote'));
    if (!best) {
      log('  no pool could be quoted');
    } else {
      const quoted = best.quote.amountOut;
      const minOut = minAmountOut(quoted, opts.slippageBps);
      log(`  pool ${label(best.key)}, quoted ${amount(quoted)} ${symbol}, min out at ${pct(opts.slippageBps)} slippage ${amount(minOut)}`);
      const sim = await simulateSwap(client, config, from, { key: best.key, ...trade });
      outcome.naive = { pool: best.key, quoted };
      if (sim.status === 'simulated') {
        const lossBps = Number(((quoted - sim.amountOut) * 10_000n) / quoted);
        outcome.naive.simulated = sim.amountOut;
        const passes = sim.amountOut >= minOut;
        log(`  execution pays ${amount(sim.amountOut)} ${symbol}: ${color(lossBps > 0 ? 'red' : 'green', `${pct(lossBps)} less than quoted`)}`);
        log(`  ${passes ? color('red', `fits inside ${pct(opts.slippageBps)} slippage: the swap goes through and the trader eats the loss`) : `exceeds ${pct(opts.slippageBps)} slippage: the swap reverts (gas lost)`}`);
      } else {
        log(`  simulation failed: ${sim.reason}${sim.detail ? ` (${sim.detail})` : ''}`);
      }
      if (opts.execute) {
        const sent = await send(best.key, minOut, undefined);
        if ('reverted' in sent) {
          outcome.naive.reverted = sent.hash;
          log(`  sent ${sent.hash}: reverted`);
        } else {
          outcome.naive.received = sent.received;
          log(`  sent ${sent.hash}: received ${amount(sent.received)} ${symbol}`);
        }
      }
    }
    log('');
  }

  if (opts.mode !== 'naive') {
    log(color('bold', `[feelock] guard every candidate (your fee limit ${pct(opts.maxFeePips / 100)})`));
    const { candidates: guarded, best: safe } = await guardCandidates({
      client,
      config,
      account: from,
      token: demo.token,
      candidates,
      maxFeePips: opts.maxFeePips,
      ...trade,
    });
    outcome.feelock = { results: guarded.map((g) => g.result) };
    for (const { key, result } of guarded) {
      const reasons = result.hops[0]?.reasons ?? result.errors ?? [];
      log(`  ${label(key).padEnd(12)} ${color(VERDICT_COLOR[result.verdict], result.verdict.padEnd(13))} ${reasons.join(' · ')}`);
    }
    if (!safe) {
      log(color('yellow', '  no SAFE pool: hold the swap'));
    } else {
      const dual = safe.result.hops[0]!.dual;
      const simulated = dual.status === 'compared' ? dual.simulated : 0n;
      outcome.feelock.pool = safe.key;
      outcome.feelock.simulated = simulated;
      const pinned = safe.result.hookData ? `, hookData pins the ${pct(safe.result.hops[0]!.commitment.status === 'committed' ? safe.result.hops[0]!.commitment.currentFee / 100 : 0)} fee` : '';
      log(`  → route ${label(safe.key)}${pinned}${safe.result.gasLimit ? `, gas limit ${safe.result.gasLimit}` : ''}`);
      log(`  execution pays ${amount(simulated)} ${symbol}: ${color('green', 'the quoted amount')}`);
      if (opts.execute) {
        const sent = await send(safe.key, minAmountOut(simulated, 50), safe.result.hookData, safe.result.gasLimit);
        if ('reverted' in sent) log(`  sent ${sent.hash}: reverted`);
        else {
          outcome.feelock.received = sent.received;
          log(`  sent ${sent.hash}: received ${amount(sent.received)} ${symbol}`);
        }
      }
    }
  }
  return outcome;
}

export interface FlipOutcome {
  verdict: GuardResult['verdict'];
  divergenceBps?: number;
  quoted?: bigint;
  received?: bigint;
  /** Why the same move on the FeeCommitHook pool failed. */
  blocked?: string;
}

/**
 * Scenario 2: a hook a simulation cannot catch. The state-flip pool charges everyone 0.3%, so quote and simulation
 * agree; its owner then raises the fee to 10% before the swap executes. Then the same move on the canonical
 * FeeCommitHook pool, which the cap and the pinned fee stop. Flipping needs --execute and FEELOCK_PK of the hook owner
 * (the deployer); fees are reset afterwards.
 */
export async function runFlipScenario(ctx: DemoContext, opts: DemoOptions): Promise<FlipOutcome> {
  const log = ctx.log ?? console.log;
  const { client, deployment } = ctx;
  const { config, demo } = deployment;
  const flipPool = demo?.pools.find((p) => p.label === 'state-flip');
  const canonicalPool = demo?.pools.find((p) => p.label === 'canonical');
  if (!demo || !flipPool || !canonicalPool) throw new Error('no state-flip pool: run contracts/script/DemoStateFlip.s.sol');
  if (opts.execute && !ctx.privateKey) throw new Error('--execute needs FEELOCK_PK');
  const account = ctx.privateKey ? privateKeyToAccount(ctx.privateKey) : undefined;
  const from = account?.address ?? OBSERVER;
  const wallet = account ? createWalletClient({ account, chain: client.chain, transport: custom({ request: client.request }) }) : undefined;
  const decimals = await client.readContract({ address: demo.token, abi: erc20Abi, functionName: 'decimals' });
  const amount = (v: bigint) => Number(formatUnits(v, decimals)).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
  const send = async (request: Parameters<NonNullable<typeof wallet>['writeContract']>[0]) => {
    const hash = await wallet!.writeContract(request);
    return client.waitForTransactionReceipt({ hash });
  };
  const trade = { zeroForOne: true, amountIn: opts.amountIn };

  log(color('bold', 'Scenario 2: a fee change the simulation cannot see'));
  const guard = await feelockGuard({ client, config, account: from, token: demo.token, route: [flipPool.key], maxFeePips: opts.maxFeePips, ...trade });
  const dual = guard.hops[0]?.dual;
  const out: FlipOutcome = { verdict: guard.verdict };
  if (dual?.status === 'compared') {
    out.divergenceBps = dual.divergenceBps;
    out.quoted = dual.quoted;
    log(`  state-flip pool: quoted ${amount(dual.quoted)}, simulated ${amount(dual.simulated)} (${dual.divergenceBps} bps apart)`);
  }
  log(`  FeeLock: ${color(VERDICT_COLOR[guard.verdict], guard.verdict)} · ${(guard.hops[0]?.reasons ?? guard.errors ?? []).join(' · ')}`);
  if (!opts.execute || !wallet || !account || out.quoted === undefined) {
    log(color('dim', '  run with --execute and FEELOCK_PK of the hook owner to flip the fee for real'));
    return out;
  }

  const owner = await client.readContract({ address: flipPool.key.hooks, abi: stateFlipFeeHookAbi, functionName: 'owner' });
  if (owner.toLowerCase() !== account.address.toLowerCase()) throw new Error(`FEELOCK_PK is not the hook owner ${owner}`);
  const startFee = await client.readContract({ address: flipPool.key.hooks, abi: stateFlipFeeHookAbi, functionName: 'fee' });
  await send({ address: flipPool.key.hooks, abi: stateFlipFeeHookAbi, functionName: 'setFee', args: [100_000], account, chain: client.chain });
  log(`  the owner raises the fee to 10% after the quote`);
  try {
    const call = buildSwapCall(config, { key: flipPool.key, ...trade, minAmountOut: minAmountOut(out.quoted, opts.slippageBps) });
    const hash = await wallet.sendTransaction({ ...call, account, chain: client.chain });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const [event] = parseEventLogs({ abi: demoSwapRouterAbi, eventName: 'SwapExecuted', logs: receipt.logs });
    if (receipt.status === 'success' && event) {
      out.received = event.args.amountOut;
      const loss = Number(((out.quoted - out.received) * 10_000n) / out.quoted);
      log(`  a naive swap at ${pct(opts.slippageBps)} slippage receives ${amount(out.received)}: ${color('red', `${pct(loss)} less than quoted`)} (${hash})`);
    } else {
      log(`  the swap reverted on its slippage limit (${hash})`);
    }
  } finally {
    await send({ address: flipPool.key.hooks, abi: stateFlipFeeHookAbi, functionName: 'setFee', args: [startFee], account, chain: client.chain });
    log(color('dim', `  state-flip fee reset to ${startFee / 10_000}%`));
  }

  log(color('bold', 'The same move on the canonical FeeCommitHook pool'));
  const safe = await feelockGuard({ client, config, account: from, token: demo.token, route: [canonicalPool.key], maxFeePips: opts.maxFeePips, ...trade });
  const commitment = safe.hops[0]?.commitment;
  if (safe.verdict !== 'SAFE' || commitment?.status !== 'committed' || !safe.hookData) {
    log(`  canonical pool is ${safe.verdict}; skipping`);
    return out;
  }
  if (commitment.feeManager.toLowerCase() !== account.address.toLowerCase()) {
    log(`  FEELOCK_PK is not the fee manager ${commitment.feeManager}; skipping`);
    return out;
  }
  log(`  quote pins ${commitment.currentFee / 10_000}% in hookData; the fee manager can raise it at most to the cap, ${commitment.maxFee / 10_000}%`);
  await send({ address: canonicalPool.key.hooks, abi: feeCommitHookAbi, functionName: 'setFee', args: [canonicalPool.key, commitment.maxFee], account, chain: client.chain });
  try {
    const call = buildSwapCall(config, { key: canonicalPool.key, ...trade, hookData: safe.hookData, minAmountOut: 0n });
    await client.call({ ...call, account: account.address });
    out.blocked = 'not blocked';
    log(color('red', '  the swap went through (unexpected)'));
  } catch (e) {
    out.blocked = describeError(e);
    log(`  the swap with the pinned fee reverts: ${color('green', out.blocked)}`);
  } finally {
    await send({ address: canonicalPool.key.hooks, abi: feeCommitHookAbi, functionName: 'setFee', args: [canonicalPool.key, commitment.currentFee], account, chain: client.chain });
    log(color('dim', `  canonical fee reset to ${commitment.currentFee / 10_000}%`));
  }
  return out;
}

async function main() {
  const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const { values } = parseArgs({
    options: {
      mode: { type: 'string', default: 'both' },
      amount: { type: 'string', default: '0.001' },
      slippage: { type: 'string', default: '1500' },
      'max-fee': { type: 'string', default: '10000' },
      chain: { type: 'string', default: '31337' },
      execute: { type: 'boolean', default: false },
      scenario: { type: 'string', default: 'quote' },
      'pools-api': { type: 'string', default: process.env.FEELOCK_POOLS_API ?? '' },
    },
  });
  if (!['quote', 'flip'].includes(values.scenario)) throw new Error('--scenario quote|flip');
  if (!['naive', 'feelock', 'both'].includes(values.mode)) throw new Error('--mode naive|feelock|both');
  const chainId = Number(values.chain);
  const deployment = await loadDeployment(chainId);
  const client = createPublicClient({
    chain: chainFor(chainId),
    transport: rpcTransport(rpcUrlsFromEnv(chainId, process.env), { maxRequestsPerSecond: 10 }),
  });
  const pk = process.env.FEELOCK_PK?.trim();
  let pools: CandidatePool[] | undefined;
  const api = values['pools-api'];
  if (api && deployment.demo) {
    const demoLabel = (id: Hex) => deployment.demo?.pools.find((p) => p.poolId === id)?.label;
    try {
      pools = await fetchIndexedPools(api, chainId, deployment.demo.token, { labelOf: demoLabel });
      console.log(color('dim', `candidates from the indexer at ${api}: ${pools.length} pools`));
    } catch (e) {
      console.log(color('yellow', `indexer unavailable (${e instanceof Error ? e.message : e}); using the deployments file`));
    }
  }
  const run = values.scenario === 'flip' ? runFlipScenario : runDemo;
  await run(
    { client, deployment, privateKey: pk ? (pk as Hex) : undefined, ...(pools?.length ? { pools } : {}) },
    {
      mode: values.mode as DemoOptions['mode'],
      amountIn: parseEther(values.amount),
      slippageBps: Number(values.slippage),
      maxFeePips: Number(values['max-fee']),
      execute: values.execute,
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(color('red', e instanceof Error ? e.message : String(e)));
    process.exit(1);
  });
}
