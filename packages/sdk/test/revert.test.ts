import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeErrorResult, parseAbi } from 'viem';
import { describeRevert } from '../src/revert.js';

const abi = parseAbi([
  'error WrappedError(address target, bytes4 selector, bytes reason, bytes details)',
  'error UnexpectedRevertBytes(bytes revertData)',
  'error FeeAboveUserLimit(uint24 fee, uint24 userMax)',
  'error HookCallFailed()',
]);
const HOOK = '0xd5F07e4cf5A97545b9e9Bb30F700269b79Df6080';

test('unwraps quoter → PoolManager → hook revert data', () => {
  const inner = encodeErrorResult({ abi, errorName: 'FeeAboveUserLimit', args: [3000, 2999] });
  const wrapped = encodeErrorResult({
    abi,
    errorName: 'WrappedError',
    args: [HOOK, '0x575e24b4', inner, encodeErrorResult({ abi, errorName: 'HookCallFailed' })],
  });
  const viaQuoter = encodeErrorResult({ abi, errorName: 'UnexpectedRevertBytes', args: [wrapped] });
  assert.equal(describeRevert(inner), 'FeeAboveUserLimit(3000, 2999)');
  assert.equal(describeRevert(wrapped), `FeeAboveUserLimit(3000, 2999) via beforeSwap of ${HOOK}`);
  assert.equal(describeRevert(viaQuoter), `FeeAboveUserLimit(3000, 2999) via beforeSwap of ${HOOK} via UnexpectedRevertBytes`);
});

test('empty and unknown revert data', () => {
  assert.equal(describeRevert('0x'), 'reverted without data');
  assert.equal(describeRevert(undefined), 'reverted without data');
  assert.equal(describeRevert('0xdeadbeef'), 'unknown error 0xdeadbeef');
});
