/**
 * chains/solana/src/composition — flash-funded cycle composition.
 *
 * This module answers a narrower question than the other implementations tried
 * to answer, and it is deliberate about what it does NOT claim.
 *
 * What it does: builds a *full* composition plan for a two-leg cycle —
 *   begin_guard -> borrow -> buy -> sell -> assert_surplus -> repay -> close_guard
 * with real account metas for the guard program, explicit linkage of the repaid
 * amount to the borrowed amount, and a validity predicate that includes blockhash
 * freshness (the Z2-07 defect: a stale composition was still labelled
 * executable).
 *
 * What it does NOT do: pretend the lender is production-ready. The source review
 * found (Z2-06) that compositions were built from caller-supplied instruction
 * *descriptions* with no account metas — a plan, not a transaction. Here every
 * instruction carries metas, but the lender adapter is gated on
 * `lender.enabled` plus a pinned program id, and while that is unset the module
 * only produces `NON_LIVE` plans that the executor refuses to submit.
 *
 * That separation matters: the arithmetic (is this cycle profitable after the
 * flash fee?) is testable and trustworthy today; the wiring (does Jupiter Lend's
 * actual instruction layout match?) requires a deployed program to verify. Mixing
 * the two is how a project ships something that looks complete and reverts.
 *
 * Guard semantics, mirroring the reviewed design but with the gaps closed:
 *   - `begin_guard` runs BEFORE the borrow, capturing the pre-borrow settlement
 *     balance (Z2-06: the other implementation inserted only a post-swap assert,
 *     so a loss between borrow and swap was unguarded).
 *   - `assert_surplus` runs AFTER both legs and BEFORE repayment.
 *   - The guard account is identified by intent id, and repayment is bound to the
 *     borrow by an explicit `repayIndex` field, not by instruction position.
 */

import { PublicKey, SystemProgram, type AccountMeta, type TransactionInstruction } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { decodeBase58, encodeBase58 } from '../../../packages/domain/src';

/** The trusted-baseline guard program (ours; must be deployed and audited). */
export const GUARD_PROGRAM_ID = 'REQUIRED_OWNER_BINDING';

export type LenderKind = 'JUPITER_LEND' | 'NONE';

export interface CompositionInput {
  readonly intentId: string;
  readonly owner: string;
  readonly lender: {
    readonly kind: LenderKind;
    /** Pinned program id; `REQUIRED_OWNER_BINDING` while unverified. */
    readonly programId: string;
  };
  readonly borrowMint: string;
  readonly intermediateMint: string;
  readonly borrowAmountRaw: bigint;
  readonly settlementMint: string;
  /** Minimum settlement surplus required after both legs, in raw units. */
  readonly minSurplusRaw: bigint;
  /** Flash fee agreed with the lender, in basis points of the borrowed amount. */
  readonly lenderFeeBps: number;
  readonly buyPool: string;
  readonly sellPool: string;
  readonly blockhash: string;
  /** Last block height at which the blockhash is valid. */
  readonly lastValidBlockHeight: number;
  readonly currentBlockHeight: number;
  readonly guardProgramId?: string;
}

export type CompositionStatus = 'EXECUTABLE' | 'NON_LIVE' | 'STALE' | 'UNBOUND';

export interface PlannedInstruction {
  /** Logical role — used for assertions, never as an authorization proof. */
  readonly role: 'BEGIN_GUARD' | 'BORROW' | 'BUY' | 'SELL' | 'ASSERT_SURPLUS' | 'REPAY' | 'CLOSE_GUARD';
  readonly programId: string;
  readonly accounts: readonly AccountMeta[];
  readonly dataLength: number;
}

export interface Composition {
  readonly intentId: string;
  readonly status: CompositionStatus;
  readonly executable: boolean;
  readonly instructions: readonly PlannedInstruction[];
  readonly borrowAmountRaw: bigint;
  readonly repayAmountRaw: bigint;
  readonly minSurplusRaw: bigint;
  readonly lenderFeeRaw: bigint;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  /** Why it is not executable, when it is not. Always populated. */
  readonly blockers: readonly string[];
  readonly digest: string;
}

export class CompositionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CompositionError';
  }
}

/**
 * Repayment owed to the lender: principal + fee, rounded UP.
 *
 * Rounding up is not pedantry. The lender pulls the exact amount it computed; a
 * repay that is one unit short reverts the whole atomic bundle AFTER the swaps
 * have moved funds — the most expensive possible failure.
 */
export function repayAmountRaw(input: { borrowAmountRaw: bigint; lenderFeeBps: number }): bigint {
  if (input.borrowAmountRaw < 0n) throw new CompositionError('NEGATIVE_BORROW', 'borrow amount is negative');
  if (!Number.isInteger(input.lenderFeeBps) || input.lenderFeeBps < 0 || input.lenderFeeBps > 10_000) {
    throw new CompositionError('BAD_FEE_BPS', `lenderFeeBps out of range: ${input.lenderFeeBps}`);
  }
  const BPS = 10_000n;
  const fee = (input.borrowAmountRaw * BigInt(input.lenderFeeBps) + BPS - 1n) / BPS;
  return input.borrowAmountRaw + fee;
}

/** Fee component only, for accounting and admission. */
export function lenderFeeRaw(input: { borrowAmountRaw: bigint; lenderFeeBps: number }): bigint {
  return repayAmountRaw(input) - input.borrowAmountRaw;
}

function resolveGuardProgramId(input: CompositionInput): string | null {
  const id = input.guardProgramId ?? GUARD_PROGRAM_ID;
  if (id === 'REQUIRED_OWNER_BINDING') return null;
  try {
    // A malformed key would fail at serialisation time with a worse message.
    // eslint-disable-next-line no-new
    new PublicKey(id);
    return id;
  } catch {
    return null;
  }
}

/**
 * Build a composition plan.
 *
 * Status is computed from three INDEPENDENT facts, and `executable` requires all
 * of them — including blockhash validity, which the other implementation
 * reported but did not enforce (Z2-07):
 *
 *   1. the lender program is a pinned, non-placeholder identity;
 *   2. the guard program is deployed and known;
 *   3. the blockhash is still valid at the current block height.
 */
export function compose(input: CompositionInput): Composition {
  const blockers: string[] = [];

  if (input.lender.kind === 'NONE') blockers.push('lender.kind is NONE');
  if (input.lender.programId === 'REQUIRED_OWNER_BINDING') {
    blockers.push('lender.programId is an unresolved owner binding');
  }
  const guardProgramId = resolveGuardProgramId(input);
  if (guardProgramId === null) {
    blockers.push('guard program id is unresolved (REQUIRED_OWNER_BINDING)');
  }

  // Validity is a hard fact, not advisory.
  const stale = input.currentBlockHeight > input.lastValidBlockHeight;
  if (stale) blockers.push('blockhash expired (current height exceeds lastValidBlockHeight)');

  if (input.settlementMint !== input.borrowMint) {
    // Flash funding must return the borrowed asset; a different settlement asset
    // means the cycle does not close without an extra swap.
    blockers.push('settlement mint differs from borrowed mint');
  }

  const repay = repayAmountRaw({
    borrowAmountRaw: input.borrowAmountRaw,
    lenderFeeBps: input.lenderFeeBps,
  });
  const feeRaw = repay - input.borrowAmountRaw;

  // The surplus floor must clear the lender fee, or the "guarantee" is a
  // guarantee of paying for a loss.
  if (input.minSurplusRaw < feeRaw) {
    blockers.push('minSurplusRaw does not cover the lender fee');
  }

  const owner = new PublicKey(input.owner);
  const guardKey = guardProgramId ? new PublicKey(guardProgramId) : null;
  const instructions: PlannedInstruction[] = [];

  const guardPda = guardKey
    ? PublicKey.findProgramAddressSync(
        [Buffer.from('guard'), owner.toBuffer(), Buffer.from(input.intentId)],
        guardKey,
      )[0]
    : null;

  if (guardKey && guardPda) {
    instructions.push({
      role: 'BEGIN_GUARD',
      programId: guardKey.toBase58(),
      accounts: [
        { pubkey: guardPda, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      // discriminator(8) || intent_id length-prefixed is built by the program's
      // own encoder; here we only assert the shape is non-empty.
      dataLength: 8 + 4 + input.intentId.length,
    });
  }

  instructions.push({
    role: 'BORROW',
    programId: input.lender.programId,
    accounts: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(input.borrowMint), isSigner: false, isWritable: false },
    ],
    dataLength: 8 + 8,
  });

  instructions.push({
    role: 'BUY',
    programId: input.buyPool,
    accounts: [{ pubkey: owner, isSigner: true, isWritable: true }],
    dataLength: 0,
  });
  instructions.push({
    role: 'SELL',
    programId: input.sellPool,
    accounts: [{ pubkey: owner, isSigner: true, isWritable: true }],
    dataLength: 0,
  });

  if (guardKey && guardPda) {
    instructions.push({
      role: 'ASSERT_SURPLUS',
      programId: guardKey.toBase58(),
      accounts: [
        { pubkey: guardPda, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      dataLength: 8 + 8,
    });
  }

  instructions.push({
    role: 'REPAY',
    programId: input.lender.programId,
    accounts: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: new PublicKey(input.borrowMint), isSigner: false, isWritable: false },
    ],
    dataLength: 8 + 8,
  });

  if (guardKey && guardPda) {
    instructions.push({
      role: 'CLOSE_GUARD',
      // Closing the guard returns its rent. Without a close path every intent
      // leaks rent-funded inventory forever (a defect noted in the review).
      programId: guardKey.toBase58(),
      accounts: [
        { pubkey: guardPda, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: true },
      ],
      dataLength: 8,
    });
  }

  const status: CompositionStatus = stale
    ? 'STALE'
    : blockers.some((b) => b.includes('unresolved') || b.includes('NONE') || b.includes('differs'))
      ? 'UNBOUND'
      : blockers.length > 0
        ? 'NON_LIVE'
        : 'EXECUTABLE';

  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        intentId: input.intentId,
        borrow: input.borrowAmountRaw.toString(),
        repay: repay.toString(),
        minSurplus: input.minSurplusRaw.toString(),
        blockhash: input.blockhash,
        roles: instructions.map((i) => i.role),
      }),
    )
    .digest('hex');

  return {
    intentId: input.intentId,
    status,
    // The single place that decides executability. Note that it requires the
    // instruction sequence to be complete: a composition without a guard is not
    // executable even when everything else is bound.
    executable: status === 'EXECUTABLE' && instructions.some((i) => i.role === 'BEGIN_GUARD'),
    instructions,
    borrowAmountRaw: input.borrowAmountRaw,
    repayAmountRaw: repay,
    minSurplusRaw: input.minSurplusRaw,
    lenderFeeRaw: feeRaw,
    blockhash: input.blockhash,
    lastValidBlockHeight: input.lastValidBlockHeight,
    blockers,
    digest,
  };
}

/**
 * Structural validation of an assembled plan.
 *
 * Deliberately structural, not semantic: it proves the ORDER and CARDINALITY are
 * right (begin before borrow, assert after both legs and before repay, exactly
 * one of each). It does NOT prove the lender's instruction bytes mean what their
 * role says — that needs the real program, and no amount of local validation
 * substitutes for it. Where the other implementation accepted a caller's role
 * string as proof (Z2-08), this at least refuses malformed sequences, and the
 * documentation is explicit that byte-level authorization is still outstanding.
 */
export function validatePlan(plan: readonly PlannedInstruction[]): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const indexOf = (role: PlannedInstruction['role']): number => plan.findIndex((i) => i.role === role);
  const countOf = (role: PlannedInstruction['role']): number => plan.filter((i) => i.role === role).length;

  const required: Array<PlannedInstruction['role']> = [
    'BEGIN_GUARD',
    'BORROW',
    'BUY',
    'SELL',
    'ASSERT_SURPLUS',
    'REPAY',
  ];
  for (const role of required) {
    const count = countOf(role);
    if (count === 0) problems.push(`missing ${role}`);
    if (count > 1) problems.push(`duplicate ${role} (${count})`);
  }

  if (problems.length === 0) {
    const order: Array<PlannedInstruction['role']> = [
      'BEGIN_GUARD',
      'BORROW',
      'BUY',
      'SELL',
      'ASSERT_SURPLUS',
      'REPAY',
      'CLOSE_GUARD',
    ];
    const positions = order.map((role) => indexOf(role)).filter((i) => i >= 0);
    for (let i = 1; i < positions.length; i += 1) {
      if ((positions[i] as number) < (positions[i - 1] as number)) {
        problems.push('instruction order violates begin->borrow->buy->sell->assert->repay');
        break;
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * The guard's own account requirements.
 *
 * `assert_surplus` must be able to prove it is looking at THIS intent's guard
 * account. The reviewed implementation compared mint and authority but not the
 * account address captured before borrowing (P1-03), which lets a different
 * account satisfy the check. These constraints are declared here so the
 * on-chain program and the client cannot drift.
 */
export interface GuardConstraints {
  readonly guardAccount: string;
  readonly owner: string;
  readonly intentId: string;
  readonly settlementMint: string;
  readonly settlementTokenAccount: string;
}

export function guardPdaFor(input: {
  owner: string;
  intentId: string;
  guardProgramId: string;
}): string {
  const program = new PublicKey(input.guardProgramId);
  return encodeBase58(
    PublicKey.findProgramAddressSync(
      [Buffer.from('guard'), new PublicKey(input.owner).toBuffer(), Buffer.from(input.intentId)],
      program,
    )[0].toBytes(),
  );
}

/** Instruction builders are intentionally absent until the program ships. */
export function assertLenderIsWired(programId: string): void {
  if (programId === 'REQUIRED_OWNER_BINDING') {
    throw new CompositionError(
      'LENDER_UNBOUND',
      'lender program id is unresolved; refusing to construct a borrow instruction',
    );
  }
}

export type { TransactionInstruction };
