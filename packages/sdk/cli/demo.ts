/**
 * Naive best-quote routing vs FeeLock, in the terminal.
 *
 *   pnpm -F @feelock/sdk demo [--mode naive|feelock|both] [--amount 0.001] [--slippage 1500] [--max-fee 10000]
 *                             [--chain 31337] [--execute]
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
import { demoSwapRouterAbi } from '../src/abi/index.js';
import { chainFor, rpcTransport, rpcUrlsFromEnv, type Deployment } from '../src/config.js';
import { guardCandidates, type GuardResult } from '../src/guard.js';
import { loadDeployment } from '../src/node.js';
import { hashPoolKey, type PoolKey } from '../src/poolKey.js';
import { bestQuote, quoteCandidates } from '../src/quote.js';
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
  const label = (key: PoolKey) => demo.pools.find((p) => p.poolId === hashPoolKey(key))?.label ?? hashPoolKey(key).slice(0, 10);
  const candidates = demo.pools.map((p) => p.key);
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
    },
  });
  if (!['naive', 'feelock', 'both'].includes(values.mode)) throw new Error('--mode naive|feelock|both');
  const chainId = Number(values.chain);
  const deployment = await loadDeployment(chainId);
  const client = createPublicClient({
    chain: chainFor(chainId),
    transport: rpcTransport(rpcUrlsFromEnv(chainId, process.env), { maxRequestsPerSecond: 10 }),
  });
  const pk = process.env.FEELOCK_PK?.trim();
  await runDemo(
    { client, deployment, privateKey: pk ? (pk as Hex) : undefined },
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
