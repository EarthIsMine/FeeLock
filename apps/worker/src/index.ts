/**
 * FeeLock pool indexer.
 *
 *   pnpm -F worker scan  [--chain 10143] [--chunk 100]            one pass: scan new blocks, classify, write the index
 *   pnpm -F worker serve [--chain 10143] [--port 8787] [--interval 30]   scan every interval and serve it over HTTP
 *
 * GET /pools?token=0x… → classified pools trading that token (all pools without ?token), GET /health.
 * Writes data/pools.<chainId>.json at the repo root and resumes from it. State is read at the latest block: Monad
 * nodes do not serve arbitrary history.
 */
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { chainFor, rpcTransport, rpcUrlsFromEnv, type NetworkConfig } from '@feelock/sdk';
import { loadDeployment } from '@feelock/sdk/node';
import { createPublicClient, isAddress, type PublicClient } from 'viem';
import { classifyPool } from './classify.js';
import { scanLogs } from './scan.js';
import { addEvents, loadIndex, poolsForToken, saveIndex, type PoolIndex } from './store.js';

export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../../data/', import.meta.url));
export const indexPath = (chainId: number, dir = DEFAULT_DATA_DIR) => `${dir.replace(/\/$/, '')}/pools.${chainId}.json`;

export interface IndexOptions {
  path: string;
  chunk?: bigint;
  /** Stop at this block instead of the latest. */
  toBlock?: bigint;
  log?: (line: string) => void;
}

/** Scans from the checkpoint to the latest block, then reclassifies every known pool against the latest state. */
export async function indexOnce(client: PublicClient, config: NetworkConfig, opts: IndexOptions): Promise<PoolIndex> {
  const log = opts.log ?? (() => {});
  const index = await loadIndex(opts.path, config.chainId, config.deployBlock);
  const latest = opts.toBlock ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const from = BigInt(index.scannedThrough) + 1n;
  if (from <= latest) {
    log(`scanning ${from}..${latest} (${latest - from + 1n} blocks)`);
    let chunks = 0;
    const result = await scanLogs(client, config, {
      fromBlock: from,
      toBlock: latest,
      chunk: opts.chunk ?? 100n,
      onChunk: async (partial) => {
        // Checkpoint every 50 chunks so a long first scan can resume. Pools and declarations are saved together with
        // the block they cover; addEvents skips what is already there.
        if (++chunks % 50 !== 0) return;
        addEvents(index, partial.pools, partial.declarations);
        index.scannedThrough = partial.toBlock.toString();
        await saveIndex(opts.path, index);
        log(`  through ${partial.toBlock}: ${index.pools.length} pools`);
      },
    });
    addEvents(index, result.pools, result.declarations);
    index.scannedThrough = result.toBlock.toString();
  }
  const canonical = new Map(index.declarations.map((d) => [d.poolId.toLowerCase(), d.token]));
  index.classified = [];
  for (const p of index.pools) {
    index.classified.push(
      await classifyPool(client, config, { poolId: p.poolId, key: p.key, blockNumber: BigInt(p.blockNumber) }, canonical),
    );
  }
  index.updatedAt = new Date().toISOString();
  await saveIndex(opts.path, index);
  log(`indexed ${index.pools.length} pools through block ${index.scannedThrough}`);
  return index;
}

const json = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

/** HTTP API over the latest index. CORS is open: the data is public chain state. */
export function startServer(getIndex: () => PoolIndex | undefined, port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const index = getIndex();
    let reply: { status: number; body: string };
    if (req.method !== 'GET') reply = json(405, { error: 'GET only' });
    else if (url.pathname === '/health') {
      reply = json(index ? 200 : 503, index ? { ok: true, chainId: index.chainId, scannedThrough: index.scannedThrough, updatedAt: index.updatedAt } : { ok: false });
    } else if (url.pathname === '/pools') {
      const token = url.searchParams.get('token') ?? undefined;
      if (token !== undefined && !isAddress(token, { strict: false })) reply = json(400, { error: 'token must be an address' });
      else if (!index) reply = json(503, { error: 'index not ready' });
      else reply = json(200, { chainId: index.chainId, scannedThrough: index.scannedThrough, updatedAt: index.updatedAt, pools: poolsForToken(index, token) });
    } else reply = json(404, { error: 'not found' });
    res.writeHead(reply.status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(reply.body);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function main() {
  const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      chain: { type: 'string', default: '10143' },
      chunk: { type: 'string', default: '100' },
      port: { type: 'string', default: '8787' },
      interval: { type: 'string', default: '30' },
    },
  });
  const command = positionals[0];
  if (command !== 'scan' && command !== 'serve') throw new Error('usage: scan|serve [--chain id] [--chunk n] [--port n] [--interval s]');
  const chainId = Number(values.chain);
  const { config } = await loadDeployment(chainId);
  const client = createPublicClient({
    chain: chainFor(chainId),
    transport: rpcTransport(rpcUrlsFromEnv(chainId, process.env), { maxRequestsPerSecond: 8 }),
  });
  const opts = { path: indexPath(chainId), chunk: BigInt(values.chunk), log: (l: string) => console.log(l) };
  if (command === 'scan') {
    await indexOnce(client, config, opts);
    return;
  }
  let current: PoolIndex | undefined;
  await startServer(() => current, Number(values.port));
  console.log(`serving http://localhost:${values.port}/pools?token=…`);
  for (;;) {
    try {
      current = await indexOnce(client, config, opts);
    } catch (e) {
      console.error('index pass failed, serving the previous index:', e instanceof Error ? e.message.split('\n')[0] : e);
    }
    await new Promise((r) => setTimeout(r, Number(values.interval) * 1000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

