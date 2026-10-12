import { formatUnits } from 'viem';

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function amount(value: bigint, decimals = 18, digits = 2): string {
  return Number(formatUnits(value, decimals)).toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** Fee in pips (1_000_000 = 100%) as a percentage. */
export const pipsPct = (pips: number) => `${(pips / 10_000).toFixed(2).replace(/\.?0+$/, '')}%`;

export const bpsPct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/** (a - b) / a in basis points; positive when b is smaller. */
export const lossBps = (a: bigint, b: bigint) => (a === 0n ? 0 : Number(((a - b) * 10_000n) / a));
