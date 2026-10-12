import { BaseError, ContractFunctionRevertedError, decodeErrorResult, parseAbi, type Abi, type Hex } from 'viem';
import {
  demoSwapRouterAbi,
  feeCommitHookAbi,
  iPoolManagerAbi,
  quoteAwareFeeHookAbi,
  v4QuoterAbi,
} from './abi/index.js';

/** Library errors that reach callers but are not in any contract ABI. */
const libraryErrors = parseAbi([
  'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
  'error HookCallFailed()',
  'error UnexpectedRevertBytes(bytes revertData)',
  'error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)',
  'error PoolNotInitialized()',
  'error Error(string)',
]);

const knownErrors: Abi = [
  ...[v4QuoterAbi, iPoolManagerAbi, feeCommitHookAbi, demoSwapRouterAbi, quoteAwareFeeHookAbi]
    .flat()
    .filter((item) => item.type === 'error'),
  ...libraryErrors,
];

/** Revert data from a viem error, if the call reverted with data. */
export function revertData(error: unknown): Hex | undefined {
  if (!(error instanceof BaseError)) return undefined;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError && reverted.raw) return reverted.raw;
  const withData = error.walk((e) => typeof (e as { data?: unknown }).data === 'string') as { data?: Hex } | null;
  return withData?.data;
}

/**
 * Readable reason for nested v4 revert data, innermost first, e.g.
 * `FeeAboveUserLimit(10000, 3000) via beforeSwap of 0x… via UnexpectedRevertBytes`.
 */
export function describeRevert(data: Hex | undefined): string {
  if (!data || data === '0x') return 'reverted without data';
  try {
    const { errorName, args } = decodeErrorResult({ abi: knownErrors, data });
    const list = (args ?? []) as readonly unknown[];
    if (errorName === 'UnexpectedRevertBytes') return `${describeRevert(list[0] as Hex)} via ${errorName}`;
    if (errorName === 'WrappedError') {
      const [target, selector, reason] = list as [Hex, Hex, Hex];
      return `${describeRevert(reason)} via ${hookFunction(selector)} of ${target}`;
    }
    return `${errorName}(${list.map((a) => String(a)).join(', ')})`;
  } catch {
    return `unknown error ${data.slice(0, 10)}`;
  }
}

/** Short reason for any thrown error: decoded revert if there is one, else the first line of the message. */
export function describeError(error: unknown): string {
  const data = revertData(error);
  if (data) return describeRevert(data);
  if (error instanceof BaseError) return error.shortMessage;
  return error instanceof Error ? error.message.split('\n')[0]! : String(error);
}

const HOOK_SELECTORS: Record<string, string> = {
  '0xdc98354e': 'beforeInitialize',
  '0x575e24b4': 'beforeSwap',
};
const hookFunction = (selector: Hex) => HOOK_SELECTORS[selector.toLowerCase()] ?? selector;
