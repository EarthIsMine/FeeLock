import { demoSwapRouterAbi, hashPoolKey, type CandidatePool } from '@feelock/sdk';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseEventLogs, type Hex } from 'viem';
import { chain, publicClient } from '../lib/chain';
import { deployment } from '../lib/deployments';
import { amount, bpsPct, lossBps, pipsPct } from '../lib/format';
import {
  bestQuote,
  buildSwapCall,
  describeError,
  feelockGuard,
  guardCandidates,
  minAmountOut,
  quoteCandidates,
  type CandidateGuard,
  type PoolKey,
} from '../lib/sdk';
import { walletClientFor } from '../lib/wallet';
import { OBSERVER } from './useFeeLock';
import type { WalletState } from './useWallet';

export type StepId = 'pools' | 'quote' | 'simulate' | 'verdict' | 'sign' | 'done';
export type StepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'failed';
export type Tone = 'good' | 'warn' | 'bad';

export interface Step {
  id: StepId;
  title: string;
  status: StepStatus;
  detail?: string;
  tone?: Tone;
  /** Per-pool lines under the verdict step. */
  items?: { label: string; text: string; tone: Tone }[];
}

export type Phase = 'idle' | 'checking' | 'review' | 'signing' | 'done' | 'failed';

export interface Route {
  key: PoolKey;
  label: string;
  quoted: bigint;
  /** What the swap should pay: the simulation with FeeLock on, the quote without. */
  expected: bigint;
  minOut: bigint;
  hookData?: Hex;
  gasLimit?: bigint;
  fee?: number;
}

export interface SwapResult {
  hash: Hex;
  received?: bigint;
  reverted: boolean;
  gasLimit: bigint;
  gasCharged: bigint;
  blockNumber: bigint;
}

export interface FlowState {
  phase: Phase;
  guarded: boolean;
  steps: Step[];
  guard?: { candidates: CandidateGuard[]; best?: CandidateGuard };
  route?: Route;
  result?: SwapResult;
  error?: string;
}

const TITLES: Record<StepId, string> = {
  pools: 'Find pools',
  quote: 'Get quotes',
  simulate: 'Simulate the real swap from your address',
  verdict: 'Choose a pool',
  sign: 'Sign in your wallet',
  done: 'Swap complete',
};

const fresh = (): Step[] => (Object.keys(TITLES) as StepId[]).map((id) => ({ id, title: TITLES[id], status: 'pending' }));
const idle = (guarded: boolean): FlowState => ({ phase: 'idle', guarded, steps: fresh() });
/** Lets each step show for a moment: the checks are fast, but the user should see them happen. */
const beat = () => new Promise((r) => setTimeout(r, 450));

interface Options {
  amountIn?: bigint;
  guardOn: boolean;
  pools: readonly CandidatePool[];
  wallet: WalletState;
  slippageBps: number;
  maxFeePips: number;
  symbol: string;
  decimals: number;
}

/**
 * The swap as a sequence the user can follow: find pools, quote, simulate (FeeLock on), choose, sign, done.
 * Nothing runs until review(); changing the amount or the toggle resets it.
 */
export function useSwapFlow(o: Options) {
  const [state, setState] = useState<FlowState>(() => idle(o.guardOn));
  const run = useRef(0);
  const busy = state.phase === 'checking' || state.phase === 'signing';

  const patch = (id: number, f: (s: FlowState) => FlowState) => {
    if (id === run.current) setState(f);
  };
  const step = (id: number, sid: StepId, change: Partial<Step>) =>
    patch(id, (s) => ({ ...s, steps: s.steps.map((x) => (x.id === sid ? { ...x, ...change } : x)) }));

  useEffect(() => {
    if (busy) return;
    run.current++;
    setState(idle(o.guardOn));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.amountIn, o.guardOn, o.pools, o.wallet.account]);

  const reset = useCallback(() => {
    run.current++;
    setState(idle(o.guardOn));
  }, [o.guardOn]);

  const review = useCallback(async () => {
    const config = deployment?.config;
    const demo = deployment?.demo;
    if (!config || !demo || !o.amountIn) return;
    const id = ++run.current;
    const { guardOn, amountIn, pools, symbol, decimals } = o;
    const fmt = (v: bigint) => `${amount(v, decimals)} ${symbol}`;
    const labelOf = (key: PoolKey) => pools.find((p) => p.poolId === hashPoolKey(key))?.label ?? hashPoolKey(key).slice(0, 10);
    const trade = { zeroForOne: true, amountIn };
    const keys = pools.map((p) => p.key);
    setState({ ...idle(guardOn), phase: 'checking' });
    try {
      step(id, 'pools', { status: 'active' });
      await beat();
      step(id, 'pools', { status: 'done', detail: `${keys.length} pools trade MON → ${symbol}` });

      step(id, 'quote', { status: 'active' });
      const quotes = await quoteCandidates(publicClient, config, keys, trade);
      const top = bestQuote(quotes);
      if (!top) throw new Error('no pool could be quoted');
      await beat();
      step(id, 'quote', { status: 'done', detail: `Best quote: ${labelOf(top.key)}, ${fmt(top.quote.amountOut)}` });

      if (!guardOn) {
        step(id, 'simulate', { status: 'skipped', tone: 'warn', detail: 'FeeLock is off: the quote is taken on trust' });
        step(id, 'verdict', { status: 'done', tone: 'warn', detail: `Routing to the best quote, ${labelOf(top.key)}` });
        patch(id, (s) => ({
          ...s,
          phase: 'review',
          route: {
            key: top.key,
            label: labelOf(top.key),
            quoted: top.quote.amountOut,
            expected: top.quote.amountOut,
            minOut: minAmountOut(top.quote.amountOut, o.slippageBps),
          },
        }));
        return;
      }

      step(id, 'simulate', { status: 'active' });
      const guard = await guardCandidates({
        client: publicClient,
        config,
        account: o.wallet.ready && o.wallet.account ? o.wallet.account : OBSERVER,
        token: demo.token,
        candidates: keys,
        maxFeePips: o.maxFeePips,
        ...trade,
      });
      await beat();
      step(id, 'simulate', { status: 'done', detail: `Every pool ran the swap as your wallet would send it` });

      step(id, 'verdict', { status: 'active' });
      await beat();
      const items = guard.candidates.map(({ key, result }) => {
        const dual = result.hops[0]?.dual;
        const label = labelOf(key);
        if (result.verdict === 'SAFE') return { label, text: 'pays exactly its quote', tone: 'good' as const };
        if (result.verdict === 'FEE_MISMATCH' && dual?.status === 'compared') {
          return { label, text: `pays ${bpsPct(dual.divergenceBps)} less than it quotes: blocked`, tone: 'bad' as const };
        }
        if (result.verdict === 'UNVERIFIED') return { label, text: 'no fee cap, could change before your swap: skipped', tone: 'warn' as const };
        return { label, text: `could not be verified: held`, tone: 'warn' as const };
      });
      const best = guard.best;
      if (!best) {
        step(id, 'verdict', { status: 'failed', tone: 'bad', items, detail: 'No pool is safe to use, so the swap is held' });
        patch(id, (s) => ({ ...s, phase: 'failed', guard, error: 'No safe pool' }));
        return;
      }
      const dual = best.result.hops[0]?.dual;
      const commitment = best.result.hops[0]?.commitment;
      if (dual?.status !== 'compared') throw new Error('the chosen pool has no simulation');
      step(id, 'verdict', { status: 'done', tone: 'good', items, detail: `Using ${labelOf(best.key)}` });
      patch(id, (s) => ({
        ...s,
        phase: 'review',
        guard,
        route: {
          key: best.key,
          label: labelOf(best.key),
          quoted: dual.quoted,
          expected: dual.simulated,
          minOut: minAmountOut(dual.simulated, 50),
          hookData: best.result.hookData,
          gasLimit: best.result.gasLimit,
          fee: commitment?.status === 'committed' ? commitment.currentFee : undefined,
        },
      }));
    } catch (e) {
      patch(id, (s) => ({
        ...s,
        phase: 'failed',
        error: describeError(e),
        steps: s.steps.map((x) => (x.status === 'active' ? { ...x, status: 'failed', tone: 'bad', detail: describeError(e) } : x)),
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.amountIn, o.guardOn, o.pools, o.wallet.account, o.wallet.ready, o.slippageBps, o.maxFeePips, o.symbol, o.decimals]);

  const confirm = useCallback(async () => {
    const config = deployment?.config;
    const demo = deployment?.demo;
    const route = state.route;
    const { wallet, amountIn } = o;
    if (!config || !demo || !route || !amountIn || !wallet.account || !wallet.wallet || !wallet.ready) return;
    const id = run.current;
    setState((s) => ({ ...s, phase: 'signing', error: undefined }));
    try {
      let { hookData, gasLimit, minOut, quoted } = route;
      if (state.guarded) {
        // The review may be a minute old: check the chosen pool again right before signing.
        step(id, 'sign', { status: 'active', detail: 'Checking the pool once more…' });
        const again = await feelockGuard({
          client: publicClient,
          config,
          account: wallet.account,
          token: demo.token,
          route: [route.key],
          amountIn,
          zeroForOne: true,
          maxFeePips: o.maxFeePips,
        });
        const d = again.hops[0]?.dual;
        if (again.verdict !== 'SAFE' || d?.status !== 'compared') {
          throw new Error(`FeeLock stopped the swap: ${again.verdict}. ${again.hops[0]?.reasons[0] ?? ''}`);
        }
        hookData = again.hookData;
        gasLimit = again.gasLimit;
        minOut = minAmountOut(d.simulated, 50);
        quoted = d.quoted;
      }
      step(id, 'sign', { status: 'active', detail: 'Confirm the swap in your wallet' });
      const call = buildSwapCall(config, { key: route.key, zeroForOne: true, amountIn, hookData, minAmountOut: minOut });
      const hash = await walletClientFor(wallet.wallet.provider, wallet.account).sendTransaction({
        ...call,
        gas: gasLimit,
        account: wallet.account,
        chain,
      });
      step(id, 'sign', { status: 'done', detail: 'Signed' });
      step(id, 'done', { status: 'active', detail: 'Waiting for the block…' });
      const [receipt, tx] = await Promise.all([publicClient.waitForTransactionReceipt({ hash }), publicClient.getTransaction({ hash })]);
      const base = {
        hash,
        gasLimit: tx.gas,
        gasCharged: receipt.gasUsed * receipt.effectiveGasPrice,
        blockNumber: receipt.blockNumber,
      };
      if (receipt.status !== 'success') {
        step(id, 'done', { status: 'failed', tone: 'warn', detail: 'Reverted: the pool paid less than your minimum. Only gas was spent.' });
        patch(id, (s) => ({ ...s, phase: 'done', result: { ...base, reverted: true } }));
        return;
      }
      const [event] = parseEventLogs({ abi: demoSwapRouterAbi, eventName: 'SwapExecuted', logs: receipt.logs });
      const received = event?.args.amountOut ?? 0n;
      const gap = lossBps(quoted, received);
      step(id, 'done', {
        status: 'done',
        tone: gap > 0 ? 'bad' : 'good',
        detail: gap > 0 ? `Received ${bpsPct(gap)} less than quoted` : 'Received exactly the quote',
      });
      patch(id, (s) => ({ ...s, phase: 'done', route: s.route ? { ...s.route, quoted } : s.route, result: { ...base, received, reverted: false } }));
    } catch (e) {
      const msg = describeError(e);
      step(id, 'sign', { status: 'failed', tone: 'bad', detail: msg });
      patch(id, (s) => ({ ...s, phase: 'failed', error: msg }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.route, state.guarded, o.wallet, o.amountIn, o.maxFeePips]);

  return { state, review, confirm, reset, busy };
}

