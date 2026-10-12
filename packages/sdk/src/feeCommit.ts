import { keccak256, type Address, type Hex, type PublicClient } from 'viem';
import { feeCommitHookAbi } from './abi/index.js';
import type { NetworkConfig, TrustedFeeCommitHook } from './config.js';
import { checkChain, failed, sameAddress, type Failed, type LookupOptions } from './lookup.js';
import { MAX_LP_FEE, hashPoolKey, isDynamicFee, poolKeyError, type PoolKey } from './poolKey.js';

export type CommitmentResult =
  | {
      status: 'committed';
      hook: Address;
      poolId: Hex;
      /** Fee cap in pips, fixed at pool creation. */
      maxFee: number;
      /** Fee charged now, in pips; never above maxFee. */
      currentFee: number;
      feeManager: Address;
    }
  | { status: 'not_committed'; reason: 'untrusted-hook' | 'static-fee' | 'no-commitment' }
  | Failed;

export function trustedHookFor(config: NetworkConfig, key: PoolKey): TrustedFeeCommitHook | undefined {
  return config.trustedFeeCommitHooks.find((h) => sameAddress(h.address, key.hooks));
}

/**
 * The pool's fee commitment. `committed` only when the pool's hook is in the trusted list, the code at that address
 * hashes to the trusted code hash (which also pins its immutable PoolManager), and the hook holds a commitment for the
 * pool. A pool with any other hook is `not_committed`: nothing on chain limits its fee.
 */
export async function getCommitment(
  client: PublicClient,
  config: NetworkConfig,
  key: PoolKey,
  opts: LookupOptions = {},
): Promise<CommitmentResult> {
  const keyError = poolKeyError(key);
  if (keyError) return failed('format', keyError);
  const trusted = trustedHookFor(config, key);
  if (!trusted) return { status: 'not_committed', reason: 'untrusted-hook' };
  // FeeCommitHook.initializePool only accepts dynamic-fee keys, so such a pool cannot exist.
  if (!isDynamicFee(key)) return { status: 'not_committed', reason: 'static-fee' };

  const chain = await checkChain(client, config);
  if (chain) return chain;

  const poolId = hashPoolKey(key);
  let commitment: { maxFee: number; currentFee: number; feeManager: Address; exists: boolean };
  try {
    const code = await client.getCode({ address: trusted.address, blockNumber: opts.blockNumber });
    if (code === undefined || code === '0x') return failed('contract-missing', 'fee commit hook');
    if (keccak256(code) !== trusted.codeHash.toLowerCase()) return failed('contract-mismatch', 'hook code hash');
    commitment = await client.readContract({
      address: trusted.address,
      abi: feeCommitHookAbi,
      functionName: 'commitmentOf',
      args: [poolId],
      blockNumber: opts.blockNumber,
    });
  } catch (e) {
    return failed('rpc', e);
  }
  if (!commitment.exists) return { status: 'not_committed', reason: 'no-commitment' };
  if (commitment.maxFee > MAX_LP_FEE || commitment.currentFee > commitment.maxFee) {
    return failed('record-mismatch', 'commitment out of bounds');
  }
  return {
    status: 'committed',
    hook: trusted.address,
    poolId,
    maxFee: commitment.maxFee,
    currentFee: commitment.currentFee,
    feeManager: commitment.feeManager,
  };
}
