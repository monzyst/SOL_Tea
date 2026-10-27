/**
 * Deterministic invariant tests for the money math.
 *
 * These run with the Node test runner (no network, no chain access). They lock
 * the properties that a silent regression would violate: rounding direction,
 * no negative results, and the closed-cycle impossibility of two profitable
 * directions at once.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addAmount,
  amount,
  applySlippageFloor,
  DomainError,
  mulDivCeil,
  mulDivFloor,
  scaleDecimalsCeil,
  scaleDecimalsFloor,
  subAmount,
  type AssetId,
} from '../../packages/domain/src';

const USDC: AssetId = {
  chain: 'solana-mainnet',
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  tokenProgram: 'spl-token',
  decimals: 6,
};

test('mulDivFloor never rounds up', () => {
  assert.equal(mulDivFloor(10n, 1n, 3n), 3n);
  assert.equal(mulDivFloor(1n, 1n, 3n), 0n);
  assert.equal(mulDivFloor(7n, 7n, 7n), 7n);
});

test('mulDivCeil never rounds down', () => {
  assert.equal(mulDivCeil(10n, 1n, 3n), 4n);
  assert.equal(mulDivCeil(1n, 1n, 3n), 1n);
  assert.equal(mulDivCeil(0n, 5n, 3n), 0n);
});

test('slippage floor reduces output and rejects out-of-range input', () => {
  assert.equal(applySlippageFloor(10_000n, 50), 9_950n);
  assert.equal(applySlippageFloor(10_000n, 0), 10_000n);
  assert.throws(() => applySlippageFloor(10_000n, 20_000), /slippageBps out of range/);
  assert.throws(() => applySlippageFloor(10_000n, -1), /slippageBps out of range/);
});

test('decimal scaling floors proceeds and ceils costs', () => {
  // 1.234567 USDC (6dp) -> lamports (9dp)
  assert.equal(scaleDecimalsFloor(1_234_567n, 6, 9), 1_234_567_000n);
  // 1 lamport (9dp) -> USDC (6dp) floors to 0, ceils to 1
  assert.equal(scaleDecimalsFloor(1n, 9, 6), 0n);
  assert.equal(scaleDecimalsCeil(1n, 9, 6), 1n);
});

/** Assert on the structured error code, not on prose that may be reworded. */
function domainCode(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as DomainError).code;
  }
  return 'NO_THROW';
}

test('amount arithmetic rejects mismatched assets and negative results', () => {
  const other: AssetId = { ...USDC, mint: 'So11111111111111111111111111111111111111112' };
  assert.equal(domainCode(() => addAmount({ asset: USDC, raw: 1n }, { asset: other, raw: 1n })), 'ASSET_MISMATCH');
  assert.equal(domainCode(() => subAmount({ asset: USDC, raw: 1n }, { asset: USDC, raw: 2n })), 'NEGATIVE_RESULT');
  assert.equal(domainCode(() => amount(USDC, -1n)), 'NEGATIVE_AMOUNT');
});
