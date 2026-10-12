import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zeroAddress, type Address } from 'viem';
import type { CommitmentResult } from '../src/feeCommit.js';
import { judgeHop, judgeRoute, type HopFacts, type Verdict } from '../src/judge.js';
import { DYNAMIC_FEE_FLAG, hashPoolKey, type PoolKey } from '../src/poolKey.js';
import type { CanonicalPoolResult } from '../src/registry.js';
import type { DualSimulationResult } from '../src/simulate.js';

const TOKEN = '0x00000000000000000000000000000000000000aa' as Address;
const TRUSTED = '0x0000000000000000000000000000000000002080' as Address;
const OTHER = '0x0000000000000000000000000000000000000080' as Address;

const staticKey: PoolKey = { currency0: zeroAddress, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const committedKey: PoolKey = { ...staticKey, fee: DYNAMIC_FEE_FLAG, hooks: TRUSTED };
const hookKey: PoolKey = { ...staticKey, fee: DYNAMIC_FEE_FLAG, hooks: OTHER };

const registered = (key: PoolKey): CanonicalPoolResult => ({
  status: 'registered',
  chainId: 31337,
  poolManager: OTHER,
  poolId: hashPoolKey(key),
  key,
  issuer: OTHER,
  declaredAt: 1n,
});
const committed = (maxFee = 10_000, currentFee = 3_000): CommitmentResult => ({
  status: 'committed',
  hook: TRUSTED,
  poolId: hashPoolKey(committedKey),
  maxFee,
  currentFee,
  feeManager: OTHER,
});
const compared = (divergenceBps = 0): DualSimulationResult => ({
  status: 'compared',
  quoted: 1_000n,
  simulated: 1_000n - BigInt(divergenceBps) / 10n,
  divergenceBps,
  quoteGasEstimate: 1n,
  blockNumber: 1n,
});
const failed = { status: 'lookup_failed', reason: 'rpc' } as const;

const facts = (over: Partial<HopFacts>): HopFacts => ({
  key: staticKey,
  canonical: { status: 'not_registered' },
  commitment: { status: 'not_committed', reason: 'untrusted-hook' },
  dual: compared(),
  maxFeePips: 10_000,
  toleranceBps: 10,
  ...over,
});
const verdict = (over: Partial<HopFacts>) => judgeHop(facts(over)).verdict;

test('any lookup failure: registry, commitment, quote or simulation', () => {
  assert.equal(verdict({ canonical: failed }), 'LOOKUP_FAILED');
  assert.equal(verdict({ key: committedKey, commitment: failed }), 'LOOKUP_FAILED');
  assert.equal(verdict({ dual: { status: 'lookup_failed', reason: 'reverted', detail: 'x' } }), 'LOOKUP_FAILED');
  const { reasons } = judgeHop(facts({ dual: { status: 'lookup_failed', reason: 'reverted', detail: 'FeeAboveUserLimit(1, 0)' } }));
  assert.match(reasons[0]!, /quote\/simulation: reverted \(FeeAboveUserLimit\(1, 0\)\)/);
});

test('FEE_MISMATCH: divergence above tolerance, or a committed pool above its cap', () => {
  assert.equal(verdict({ key: hookKey, dual: compared(995) }), 'FEE_MISMATCH');
  assert.equal(verdict({ dual: compared(11) }), 'FEE_MISMATCH');
  assert.equal(verdict({ dual: compared(10) }), 'SAFE', 'at the tolerance is fine');
  assert.equal(verdict({ dual: compared(-500) }), 'SAFE', 'paying more than quoted is not a loss');
  assert.equal(verdict({ key: committedKey, commitment: committed(10_000, 10_001) }), 'FEE_MISMATCH');
});

test('measured divergence outranks a missing lookup in the same hop', () => {
  assert.equal(verdict({ key: hookKey, canonical: failed, dual: compared(995) }), 'FEE_MISMATCH');
});

test('static pool: SAFE, canonical or not', () => {
  assert.equal(verdict({}), 'SAFE');
  assert.deepEqual(judgeHop(facts({ canonical: registered(staticKey) })).reasons.at(-1), 'canonical pool');
});

test('trusted FeeCommitHook pool: SAFE only when the cap is within the user limit', () => {
  assert.equal(verdict({ key: committedKey, commitment: committed(10_000) }), 'SAFE');
  assert.equal(verdict({ key: committedKey, commitment: committed(10_000), maxFeePips: 10_000 }), 'SAFE');
  assert.equal(verdict({ key: committedKey, commitment: committed(10_000), maxFeePips: 9_999 }), 'UNVERIFIED');
});

test('other hook pools are UNVERIFIED, even the canonical one', () => {
  const j = judgeHop(facts({ key: hookKey, canonical: registered(hookKey) }));
  assert.equal(j.verdict, 'UNVERIFIED');
  assert.deepEqual(j.reasons, [
    'hook pool without a trusted fee cap: quote and simulation agree now, but nothing caps the fee before your swap executes',
    'canonical pool',
  ]);
  const unsimulated = judgeHop(facts({ key: hookKey, dual: { status: 'lookup_failed', reason: 'rpc' } }));
  assert.equal(unsimulated.verdict, 'LOOKUP_FAILED');
  assert.equal(verdict({ key: { ...hookKey, fee: 3000 } }), 'UNVERIFIED', 'a hook can take fees through deltas');
  assert.equal(
    judgeHop(facts({ key: hookKey, canonical: registered(committedKey) })).reasons.at(-1),
    'not the canonical pool',
  );
});

test('route verdict is the worst hop: FEE_MISMATCH > LOOKUP_FAILED > UNVERIFIED > SAFE', () => {
  const cases: [Verdict[], Verdict][] = [
    [['SAFE'], 'SAFE'],
    [['SAFE', 'UNVERIFIED'], 'UNVERIFIED'],
    [['UNVERIFIED', 'LOOKUP_FAILED', 'SAFE'], 'LOOKUP_FAILED'],
    [['LOOKUP_FAILED', 'FEE_MISMATCH'], 'FEE_MISMATCH'],
    [['FEE_MISMATCH', 'SAFE'], 'FEE_MISMATCH'],
    [[], 'LOOKUP_FAILED'],
  ];
  for (const [hops, expected] of cases) assert.equal(judgeRoute(hops), expected, hops.join(','));
});

