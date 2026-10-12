import { CHAIN_ID } from './chain';

/** Shape written by scripts/snapshot.ts. Amounts are decimal strings (JSON has no bigint). */
export interface Snapshot {
  chainId: number;
  blockNumber: string;
  recordedAt: string;
  amountIn: string;
  token: { address: string; symbol: string; decimals: number };
  rows: {
    label: string;
    poolId: string;
    hooks: string;
    verdict: 'SAFE' | 'UNVERIFIED' | 'FEE_MISMATCH' | 'LOOKUP_FAILED';
    reasons: string[];
    canonical: boolean;
    commitment: { maxFee: number; currentFee: number } | null;
    quoted: string | null;
    simulated: string | null;
    divergenceBps: number | null;
  }[];
  naiveRoute: string;
  feelockRoute: string | null;
  swaps: {
    route: 'naive' | 'feelock';
    hash: string;
    status: string;
    blockNumber: string;
    amountIn: string | null;
    received: string | null;
    gasLimit: string;
    gasCharged: string;
  }[];
}

const files = import.meta.glob<Snapshot>('../snapshot/*.json', { eager: true, import: 'default' });
export const snapshot: Snapshot | undefined = Object.values(files).find((s) => s.chainId === CHAIN_ID);
