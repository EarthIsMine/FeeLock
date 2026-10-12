/**
 * Records what the web app shows, from the live chain, so the page can fall back to it when the RPC is down:
 *   pnpm -F web snapshot [--chain 10143] [--amount 0.001] [--swap <naiveTxHash>:<feelockTxHash>]
 * Writes src/snapshot/<chainId>.json. Every number comes from the chain at the recorded block, nothing is typed in.
 */
import {
  chainFor,
  guardCandidates,
  hashPoolKey,
  rpcTransport,
  rpcUrlsFromEnv,
  demoSwapRouterAbi,
  type GuardResult,
} from '@feelock/sdk';
import { loadDeployment } from '@feelock/sdk/node';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createPublicClient, erc20Abi, parseEther, parseEventLogs, type Address, type Hex } from 'viem';

const OBSERVER = '0x00000000000000000000000000000000000fee10' as Address;
const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const { values } = parseArgs({
  options: { chain: { type: 'string', default: '10143' }, amount: { type: 'string', default: '0.001' }, swap: { type: 'string' } },
});
const chainId = Number(values.chain);
const { config, demo } = await loadDeployment(chainId);
if (!demo) throw new Error(`no demo pools for chain ${chainId}`);
const client = createPublicClient({
  chain: chainFor(chainId),
  transport: rpcTransport(rpcUrlsFromEnv(chainId, process.env), { maxRequestsPerSecond: 8 }),
});
const amountIn = parseEther(values.amount);
const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
const [symbol, decimals] = await Promise.all([
  client.readContract({ address: demo.token, abi: erc20Abi, functionName: 'symbol' }),
  client.readContract({ address: demo.token, abi: erc20Abi, functionName: 'decimals' }),
]);
const { candidates, best } = await guardCandidates({
  client,
  config,
  account: OBSERVER,
  token: demo.token,
  candidates: demo.pools.map((p) => p.key),
  amountIn,
  zeroForOne: true,
  maxFeePips: 10_000,
});

const str = (v: bigint | undefined) => (v === undefined ? null : v.toString());
const row = ({ key, result }: { key: (typeof demo.pools)[number]['key']; result: GuardResult }) => {
  const hop = result.hops[0];
  const dual = hop?.dual;
  return {
    label: demo.pools.find((p) => p.poolId === hashPoolKey(key))?.label ?? hashPoolKey(key),
    poolId: hashPoolKey(key),
    hooks: key.hooks,
    verdict: result.verdict,
    reasons: hop?.reasons ?? result.errors ?? [],
    canonical: hop?.canonical.status === 'registered' && hop.canonical.poolId === hashPoolKey(key),
    commitment:
      hop?.commitment.status === 'committed'
        ? { maxFee: hop.commitment.maxFee, currentFee: hop.commitment.currentFee }
        : null,
    quoted: str(dual?.status === 'compared' ? dual.quoted : undefined),
    simulated: str(dual?.status === 'compared' ? dual.simulated : undefined),
    divergenceBps: dual?.status === 'compared' ? dual.divergenceBps : null,
  };
};
const rows = candidates.map(row);
const quoted = rows.filter((r) => r.quoted !== null);
const naive = quoted.reduce((b, r) => (BigInt(r.quoted!) > BigInt(b.quoted!) ? r : b), quoted[0]!);

async function swapRecord(route: 'naive' | 'feelock', hash: Hex) {
  const [receipt, tx] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })]);
  const [event] = parseEventLogs({ abi: demoSwapRouterAbi, eventName: 'SwapExecuted', logs: receipt.logs });
  return {
    route,
    hash,
    status: receipt.status,
    blockNumber: receipt.blockNumber.toString(),
    poolId: event?.args.poolId ?? null,
    amountIn: str(event?.args.amountIn),
    received: str(event?.args.amountOut),
    gasLimit: tx.gas.toString(),
    gasCharged: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
  };
}
const swaps = values.swap
  ? await Promise.all(values.swap.split(':').map((h, i) => swapRecord(i === 0 ? 'naive' : 'feelock', h as Hex)))
  : [];

const snapshot = {
  chainId,
  blockNumber: blockNumber.toString(),
  recordedAt: new Date().toISOString(),
  amountIn: amountIn.toString(),
  token: { address: demo.token, symbol, decimals },
  rows,
  naiveRoute: naive.poolId,
  feelockRoute: best ? hashPoolKey(best.key) : null,
  swaps,
};
const out = fileURLToPath(new URL(`../src/snapshot/${chainId}.json`, import.meta.url));
mkdirSync(fileURLToPath(new URL('../src/snapshot/', import.meta.url)), { recursive: true });
writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`wrote ${out} at block ${blockNumber}`);
for (const r of rows) console.log(`  ${r.label.padEnd(11)} ${r.verdict.padEnd(13)} quoted ${r.quoted} simulated ${r.simulated}`);
