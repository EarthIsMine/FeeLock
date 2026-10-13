import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PoolKey } from '@feelock/sdk';
import type { Hex } from 'viem';
import type { ClassifiedPool } from './classify.js';
import type { Declaration, InitializedPool } from './scan.js';

/** data/pools.<chainId>.json: raw events (so a rescan resumes) and the latest classification. */
export interface PoolIndex {
  chainId: number;
  fromBlock: string;
  /** Last block scanned; the next scan starts after it. */
  scannedThrough: string;
  updatedAt: string;
  pools: { poolId: Hex; key: PoolKey; blockNumber: string }[];
  declarations: { token: Hex; poolId: Hex; issuer: Hex; blockNumber: string }[];
  classified: ClassifiedPool[];
}

export function emptyIndex(chainId: number, fromBlock: bigint): PoolIndex {
  return {
    chainId,
    fromBlock: fromBlock.toString(),
    scannedThrough: (fromBlock - 1n).toString(),
    updatedAt: new Date(0).toISOString(),
    pools: [],
    declarations: [],
    classified: [],
  };
}

export async function loadIndex(path: string, chainId: number, fromBlock: bigint): Promise<PoolIndex> {
  if (!existsSync(path)) return emptyIndex(chainId, fromBlock);
  const index = JSON.parse(await readFile(path, 'utf8')) as PoolIndex;
  if (index.chainId !== chainId) throw new Error(`${path} is for chain ${index.chainId}, not ${chainId}`);
  return index;
}

/** Atomic write: a crash mid-write leaves the previous index. */
export async function saveIndex(path: string, index: PoolIndex): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, `${JSON.stringify(index, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}

export function addEvents(index: PoolIndex, pools: InitializedPool[], declarations: Declaration[]): void {
  const seen = new Set(index.pools.map((p) => p.poolId.toLowerCase()));
  for (const p of pools) {
    if (seen.has(p.poolId.toLowerCase())) continue;
    seen.add(p.poolId.toLowerCase());
    index.pools.push({ poolId: p.poolId, key: p.key, blockNumber: p.blockNumber.toString() });
  }
  const declared = new Set(index.declarations.map((d) => d.token.toLowerCase()));
  for (const d of declarations) {
    if (declared.has(d.token.toLowerCase())) continue;
    declared.add(d.token.toLowerCase());
    index.declarations.push({ token: d.token, poolId: d.poolId, issuer: d.issuer, blockNumber: d.blockNumber.toString() });
  }
}

export function poolsForToken(index: PoolIndex, token?: string): ClassifiedPool[] {
  if (!token) return index.classified;
  const t = token.toLowerCase();
  return index.classified.filter((p) => p.key.currency0.toLowerCase() === t || p.key.currency1.toLowerCase() === t);
}
