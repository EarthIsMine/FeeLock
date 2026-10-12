// hashPoolKey and poolKeyAbi ported from EarthIsMine/klamp contract/sdk/poolKey.ts.
import { encodeAbiParameters, isAddress, keccak256, zeroAddress, type Address, type Hex } from 'viem';

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export const poolKeyAbi = {
  type: 'tuple',
  components: [
    { name: 'currency0', type: 'address' },
    { name: 'currency1', type: 'address' },
    { name: 'fee', type: 'uint24' },
    { name: 'tickSpacing', type: 'int24' },
    { name: 'hooks', type: 'address' },
  ],
} as const;

/** v4 LPFeeLibrary constants, in pips (1_000_000 = 100%). */
export const DYNAMIC_FEE_FLAG = 0x800000;
export const MAX_LP_FEE = 1_000_000;
/** v4 TickMath.MIN_TICK_SPACING / MAX_TICK_SPACING. */
export const MIN_TICK_SPACING = 1;
export const MAX_TICK_SPACING = 32_767;

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Same value as Solidity keccak256(abi.encode(key)) and v4 PoolIdLibrary. */
export function hashPoolKey(key: PoolKey): Hex {
  return keccak256(encodeAbiParameters([poolKeyAbi], [key]));
}

export function isDynamicFee(key: PoolKey): boolean {
  return key.fee === DYNAMIC_FEE_FLAG;
}

export function hasHooks(key: PoolKey): boolean {
  return !eq(key.hooks, zeroAddress);
}

/** No hook and a fee fixed in the key: the fee a quote sees is the fee a swap pays. */
export function isStatic(key: PoolKey): boolean {
  return !hasHooks(key) && !isDynamicFee(key);
}

export function hasCurrency(key: PoolKey, currency: Address): boolean {
  return eq(key.currency0, currency) || eq(key.currency1, currency);
}

/**
 * Returns why a key can never name an initialized pool, or null if it is well formed. PoolManager rejects such keys
 * on initialize, so callers treat them as invalid input rather than as a pool to look up.
 */
export function poolKeyError(key: PoolKey): string | null {
  if (![key.currency0, key.currency1, key.hooks].every((a) => typeof a === 'string' && isAddress(a, { strict: false }))) {
    return 'invalid address';
  }
  if (BigInt(key.currency0) >= BigInt(key.currency1)) return 'currencies not sorted (currency0 < currency1)';
  if (!Number.isInteger(key.fee) || (key.fee > MAX_LP_FEE && key.fee !== DYNAMIC_FEE_FLAG) || key.fee < 0) {
    return 'fee out of range';
  }
  if (!Number.isInteger(key.tickSpacing) || key.tickSpacing < MIN_TICK_SPACING || key.tickSpacing > MAX_TICK_SPACING) {
    return 'tickSpacing out of range';
  }
  return null;
}
