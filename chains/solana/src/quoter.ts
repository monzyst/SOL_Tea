/**
 * chains/solana/src/quoter — authoritative executable quotes via the official
 * Orca Whirlpool SDK.
 *
 * Why the SDK and not our own math: a Whirlpool is a concentrated-liquidity
 * pool, so pricing a trade means walking real tick arrays under the pool's fee
 * and protocol-fee rules. Reproducing that by hand is exactly the kind of
 * "almost right" arithmetic that yields a profitable-looking quote which reverts
 * on chain. `swapQuoteByInputToken` performs the real walk.
 *
 * This module is the only place allowed to produce an *executable* number.
 * Written against @orca-so/whirlpools-sdk 0.22.0.
 */

import { PublicKey, type Connection, type TransactionInstruction } from '@solana/web3.js';
import BN from 'bn.js';
import { Percentage } from '@orca-so/common-sdk';
import {
  PDAUtil,
  WhirlpoolContext,
  WhirlpoolIx,
  buildWhirlpoolClient,
  swapQuoteByInputToken,
  type SwapQuote,
} from '@orca-so/whirlpools-sdk';
import type { PoolBinding } from '../../../packages/registry/src';

export interface ExecutableQuote {
  readonly poolAddress: string;
  readonly amountIn: bigint;
  readonly expectedAmountOut: bigint;
  readonly minimumAmountOut: bigint;
  readonly feeAmount: bigint;
  readonly estimatedEndTickIndex: number;
  readonly aToB: boolean;
  readonly quotedAtUtc: string;
  readonly sdkVersion: string;
  readonly sqrtPriceLimit: bigint;
}

export class QuoteUnavailableError extends Error {
  constructor(
    readonly poolAddress: string,
    readonly failureCause: string,
  ) {
    super(`quote unavailable for ${poolAddress}: ${failureCause}`);
    this.name = 'QuoteUnavailableError';
  }
}

/** Version marker recorded with every quote so drift stays traceable (V6 §11). */
export const WHIRLPOOL_SDK_VERSION = '0.22.0';

/**
 * Build a quote-only Whirlpool context.
 *
 * Signature: `WhirlpoolContext.from(connection, wallet, fetcher?,
 * lookupTableFetcher?, opts?, programId?)`.
 *
 * The fetcher arguments are omitted so the SDK constructs its default account
 * fetcher over the supplied connection — that fetcher is the one used to load
 * tick arrays, so it must not be an empty stub.
 */
function quoteContext(connection: Connection, programId: string): WhirlpoolContext {
  return WhirlpoolContext.from(
    connection,
    // Quoting needs no signer. The SDK type requires a Wallet and this path
    // never calls into it; documented so it is not mistaken for an oversight.
    {} as never,
    undefined,
    undefined,
    undefined,
    new PublicKey(programId),
  );
}

function slip(slippageBps: number): Percentage {
  return Percentage.fromFraction(slippageBps, 10_000);
}

/**
 * Quote an exact-input swap. `slippageBps` produces the on-chain
 * `otherAmountThreshold`: the transaction reverts rather than filling worse.
 */
export async function quoteExactIn(input: {
  connection: Connection;
  binding: PoolBinding;
  programId: string;
  inputMint: string;
  amountIn: bigint;
  slippageBps: number;
}): Promise<ExecutableQuote> {
  const { connection, binding, amountIn, slippageBps } = input;
  if (amountIn <= 0n) throw new QuoteUnavailableError(binding.address, 'amountIn must be positive');
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 2_000) {
    throw new QuoteUnavailableError(binding.address, `slippageBps out of range: ${slippageBps}`);
  }

  const ctx = quoteContext(connection, input.programId);
  const client = buildWhirlpoolClient(ctx);
  const whirlpool = await client.getPool(new PublicKey(binding.address));

  let quote: SwapQuote;
  try {
    quote = await swapQuoteByInputToken(
      whirlpool,
      input.inputMint,
      new BN(amountIn.toString()),
      slip(slippageBps),
      ctx.program.programId,
      ctx.fetcher,
    );
  } catch (error) {
    throw new QuoteUnavailableError(binding.address, (error as Error).message);
  }

  return {
    poolAddress: binding.address,
    amountIn: BigInt(quote.estimatedAmountIn.toString()),
    expectedAmountOut: BigInt(quote.estimatedAmountOut.toString()),
    minimumAmountOut: BigInt(quote.otherAmountThreshold.toString()),
    feeAmount: BigInt(quote.estimatedFeeAmount.toString()),
    estimatedEndTickIndex: quote.estimatedEndTickIndex,
    aToB: quote.aToB,
    quotedAtUtc: new Date().toISOString(),
    sdkVersion: WHIRLPOOL_SDK_VERSION,
    sqrtPriceLimit: BigInt(quote.sqrtPriceLimit.toString()),
  };
}

/**
 * Build the swap instruction for a quoted leg.
 *
 * Tick arrays come from a fresh quote at the same parameters, because mixing a
 * new array set with an older threshold is how a leg silently executes at the
 * wrong price. The fresh quote is taken with zero slippage purely to obtain the
 * arrays; the executed bound is always `quote.minimumAmountOut`.
 */
export async function buildSwapInstruction(input: {
  connection: Connection;
  binding: PoolBinding;
  programId: string;
  owner: PublicKey;
  quote: ExecutableQuote;
  tokenOwnerAccountA: PublicKey;
  tokenOwnerAccountB: PublicKey;
}): Promise<{ instruction: TransactionInstruction; cleanup: TransactionInstruction[] }> {
  const ctx = quoteContext(input.connection, input.programId);
  const client = buildWhirlpoolClient(ctx);
  const whirlpoolKey = new PublicKey(input.binding.address);
  const whirlpool = await client.getPool(whirlpoolKey);
  const data = whirlpool.getData();

  const inputMint = input.quote.aToB ? input.binding.mintA : input.binding.mintB;
  const freshQuote = await swapQuoteByInputToken(
    whirlpool,
    inputMint,
    new BN(input.quote.amountIn.toString()),
    slip(0),
    ctx.program.programId,
    ctx.fetcher,
  );

  const oracle = PDAUtil.getOracle(ctx.program.programId, whirlpoolKey);

  const swapped = WhirlpoolIx.swapIx(ctx.program, {
    amount: new BN(input.quote.amountIn.toString()),
    otherAmountThreshold: new BN(input.quote.minimumAmountOut.toString()),
    sqrtPriceLimit: new BN(input.quote.sqrtPriceLimit.toString()),
    amountSpecifiedIsInput: true,
    aToB: input.quote.aToB,
    whirlpool: whirlpoolKey,
    tokenAuthority: input.owner,
    tokenOwnerAccountA: input.tokenOwnerAccountA,
    tokenVaultA: new PublicKey(data.tokenVaultA),
    tokenOwnerAccountB: input.tokenOwnerAccountB,
    tokenVaultB: new PublicKey(data.tokenVaultB),
    tickArray0: freshQuote.tickArray0,
    tickArray1: freshQuote.tickArray1,
    tickArray2: freshQuote.tickArray2,
    oracle: oracle.publicKey,
  });

  return {
    instruction: swapped.instructions[0] as TransactionInstruction,
    cleanup: swapped.cleanupInstructions as TransactionInstruction[],
  };
}
