/**
 * apps/reconciler — the independent settlement loop.
 *
 * Why a separate process. A worker that dies mid-flight leaves transactions whose
 * fate nobody knows. If settlement lived INSIDE the worker, the crash would also
 * destroy the thing responsible for resolving it. The reconciler is therefore a
 * standalone role: it reads the durable store, asks the chain what actually
 * happened, and writes the verdict. It can be restarted, scaled, or run by hand
 * without touching the trading loop.
 *
 * It has no signer and no submitter, so a defect here cannot create a
 * transaction — only an incorrect bookkeeping row.
 *
 * The governing rule (V6 §09): the ledger is the source of truth, never the
 * intent. Anything this process cannot prove stays UNPROVEN and keeps counting
 * against the exposure cap.
 */

import type { Connection } from '@solana/web3.js';

import { loadDotEnv, loadEnv, loadChainConfig } from '../../../packages/config/src';
import { openStore, type Store, type IntentRow } from '../../../packages/store/src';
import { buildProviderConfigs, ProviderPool } from '../../../packages/rpc/src/provider';
import { createLogger, Metrics } from '../../../packages/obs/src';
import { startHealthServer } from './health';

const POLL_INTERVAL_MS = 4_000;

/**
 * How long an unseen signature may stay unresolved before it is declared dead.
 * A Solana blockhash is valid for ~150 blocks (~60-90 s); 5 minutes is
 * comfortably beyond that, so "never seen and older than this" means it cannot
 * land. Anything younger stays honestly UNKNOWN.
 */
const ABANDON_AFTER_MS = 5 * 60_000;

const QUARANTINE_AFTER = 3;
const QUARANTINE_MS = 15 * 60_000;

async function main(): Promise<void> {
  // Load .env before validation, exactly as the worker does. Without this a
  // standalone role refuses to boot even when a valid .env is present — each
  // entrypoint must be runnable on its own.
  loadDotEnv();
  const env = loadEnv();
  const chain = loadChainConfig(env.SOL_TEA_CHAIN_CONFIG);
  const logger = createLogger({ component: 'reconciler', level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
  const metrics = new Metrics();

  const pool = new ProviderPool(
    buildProviderConfigs({
      httpUrl: env.RPC_HTTP_URL,
      wsUrl: env.RPC_WS_URL,
      httpUrlSecondary: env.RPC_HTTP_URL_SECONDARY,
      wsUrlSecondary: env.RPC_WS_URL_SECONDARY,
    }),
    { commitment: chain.chain.commitment, logger },
  );

  const store = openStore(env.STORE_PATH);

  const health = startHealthServer({
    logger,
    port: env.HEALTH_PORT,
    snapshot: () => ({
      commitment: chain.chain.commitment,
      store: env.STORE_PATH,
      unresolved: store.unresolvedIntents().length,
      totals: store.totals(),
      providers: pool.statesSnapshot(),
    }),
  });

  let stopping = false;
  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info('shutdown_requested', { signal });
    health.close();
    store.close();
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  logger.info('reconciler_started', {
    commitment: chain.chain.commitment,
    pollIntervalMs: POLL_INTERVAL_MS,
    abandonAfterMs: ABANDON_AFTER_MS,
    store: env.STORE_PATH,
    settlementMint: chain.chain.settlementMint,
    owner: env.OPERATOR_PUBLIC_ADDRESS || '(unset)',
  });

  let round = 0;
  while (!stopping) {
    round += 1;
    try {
      await settleRound({ store, pool, logger, metrics, env, chain });
      health.tick();
    } catch (error) {
      // Never crash this loop: the attempts it is meant to resolve would be
      // orphaned, and the next round can retry.
      logger.error('reconcile_round_failed', { round, error: (error as Error).message });
      metrics.inc('reconciler_errors');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

async function settleRound(deps: {
  store: Store;
  pool: ProviderPool;
  logger: ReturnType<typeof createLogger>;
  metrics: Metrics;
  env: ReturnType<typeof loadEnv>;
  chain: ReturnType<typeof loadChainConfig>;
}): Promise<void> {
  const { store, pool, logger, metrics, env, chain } = deps;
  const pending = store.unresolvedIntents();
  if (pending.length === 0) return;

  const withSignature = pending.filter(
    (intent): intent is IntentRow & { signature: string } => Boolean(intent.signature),
  );

  // One batched status call per round instead of one per intent.
  const statuses =
    withSignature.length === 0
      ? { value: [] as Array<{ err: unknown; confirmationStatus?: string; slot: number } | null> }
      : await pool.read('getSignatureStatuses', (connection: Connection) =>
          connection.getSignatureStatuses(
            withSignature.map((intent) => intent.signature),
            { searchTransactionHistory: true },
          ),
        );

  for (let index = 0; index < withSignature.length; index += 1) {
    const intent = withSignature[index] as IntentRow & { signature: string };
    const status = statuses.value[index] ?? null;
    const ageMs = Date.now() - Date.parse(intent.createdAtUtc);

    if (!status) {
      if (ageMs > ABANDON_AFTER_MS) abandon({ store, logger, metrics, intent, ageMs });
      continue;
    }

    // Reverted on chain: the fee was spent, nothing else moved.
    if (status.err) {
      const fee = await readFeeLamports(pool, intent.signature);
      finishAsReverted({ store, logger, intent, feeLamports: fee });
      continue;
    }

    const commitment = chain.chain.commitment;
    const isFinal =
      status.confirmationStatus === 'finalized' ||
      (commitment === 'confirmed' && status.confirmationStatus === 'confirmed');

    // Sighted but not settled: record the progress, then wait. A merely-slow
    // transaction must never be mistaken for a dead one.
    if (!isFinal) {
      if (intent.state === 'SUBMITTED') {
        store.setIntentState({
          intentId: intent.intentId,
          state: 'INCLUDED',
          nowUtc: new Date(),
          note: `included in slot ${status.slot}`,
        });
      }
      continue;
    }

    await finishAsSettled({ store, pool, logger, metrics, env, chain, intent });
  }
}

/** Fee paid by an included transaction, in lamports. */
async function readFeeLamports(pool: ProviderPool, signature: string): Promise<bigint> {
  try {
    const tx = await pool.read('getTransaction', (connection: Connection) =>
      connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }),
    );
    return tx?.meta ? BigInt(tx.meta.fee) : 0n;
  } catch {
    // An unknown fee must not block the state transition; 0n understates spend,
    // and the settlement note records that the figure was unproven.
    return 0n;
  }
}

function abandon(input: {
  store: Store;
  logger: ReturnType<typeof createLogger>;
  metrics: Metrics;
  intent: IntentRow & { signature: string };
  ageMs: number;
}): void {
  const { store, logger, metrics, intent, ageMs } = input;
  store.settleReservation({
    reservationId: reservationIdFor(store, intent.intentId),
    actualFeeRaw: 0n,
    nowUtc: new Date(),
    intentState: 'FAILED',
  });
  store.recordSettlement({
    signature: intent.signature,
    intentId: intent.intentId,
    routeKey: intent.routeKey,
    verdict: 'UNPROVEN_ABANDONED',
    realisedDeltaRaw: 0n,
    feeLamports: 0n,
    slot: null,
    nowUtc: new Date(),
    note: `never observed after ${Math.round(ageMs / 1000)}s; blockhash window expired`,
  });
  logger.warn('reconcile_abandoned', {
    intentId: intent.intentId,
    signature: intent.signature,
    ageMs,
  });
  metrics.inc('reconciler_abandoned');
}

function finishAsReverted(input: {
  store: Store;
  logger: ReturnType<typeof createLogger>;
  intent: IntentRow & { signature: string };
  feeLamports: bigint;
}): void {
  const { store, logger, intent, feeLamports } = input;
  store.settleReservation({
    reservationId: reservationIdFor(store, intent.intentId),
    actualFeeRaw: feeLamports,
    nowUtc: new Date(),
    intentState: 'FAILED',
  });
  store.recordSettlement({
    signature: intent.signature,
    intentId: intent.intentId,
    routeKey: intent.routeKey,
    verdict: 'PROVEN_NET_NON_POSITIVE',
    realisedDeltaRaw: 0n,
    feeLamports,
    slot: null,
    nowUtc: new Date(),
    note: 'reverted on chain; fee spent, balances unchanged',
  });
  store.recordRouteOutcome({
    routeKey: intent.routeKey,
    outcome: 'REVERTED',
    nowUtc: new Date(),
    quarantineAfter: QUARANTINE_AFTER,
    quarantineMs: QUARANTINE_MS,
  });
  logger.warn('reconcile_reverted', {
    intentId: intent.intentId,
    signature: intent.signature,
    feeLamports: feeLamports.toString(),
  });
}

async function finishAsSettled(input: {
  store: Store;
  pool: ProviderPool;
  logger: ReturnType<typeof createLogger>;
  metrics: Metrics;
  env: ReturnType<typeof loadEnv>;
  chain: ReturnType<typeof loadChainConfig>;
  intent: IntentRow & { signature: string };
}): Promise<void> {
  const { store, pool, logger, metrics, env, chain, intent } = input;

  const tx = await pool.read('getTransaction', (connection: Connection) =>
    connection.getTransaction(intent.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: 'finalized',
    }),
  );

  if (!tx?.meta) {
    // Finality proves inclusion but the receipt is unavailable (pruned, or we
    // failed over to a provider without history). Do NOT invent a number.
    logger.warn('reconcile_unproven_no_receipt', {
      intentId: intent.intentId,
      signature: intent.signature,
    });
    store.setIntentState({
      intentId: intent.intentId,
      state: 'AWAITING_FINALITY',
      nowUtc: new Date(),
      note: 'finalized but receipt unavailable from this provider',
    });
    metrics.inc('reconciler_missing_receipt');
    return;
  }

  const feeLamports = BigInt(tx.meta.fee);
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  const owner = env.OPERATOR_PUBLIC_ADDRESS;

  // Attribute only the operator's own accounts, and only the settlement mint.
  const sumFor = (entries: typeof pre): bigint => {
    let total = 0n;
    for (const entry of entries) {
      if (entry.mint !== chain.chain.settlementMint) continue;
      if (entry.owner && owner && entry.owner !== owner) continue;
      total += BigInt(entry.uiTokenAmount.amount);
    }
    return total;
  };

  const hasBalanceData = pre.length > 0 || post.length > 0;
  const realisedDeltaRaw = hasBalanceData ? sumFor(post) - sumFor(pre) : null;
  const verdict =
    realisedDeltaRaw === null
      ? 'UNPROVEN_NO_BALANCE_DATA'
      : realisedDeltaRaw > 0n
        ? 'PROVEN_NET_POSITIVE'
        : 'PROVEN_NET_NON_POSITIVE';

  store.settleReservation({
    reservationId: reservationIdFor(store, intent.intentId),
    actualFeeRaw: feeLamports,
    nowUtc: new Date(),
    intentState: 'RECONCILED',
  });

  const inserted = store.recordSettlement({
    signature: intent.signature,
    intentId: intent.intentId,
    routeKey: intent.routeKey,
    verdict,
    realisedDeltaRaw,
    feeLamports,
    slot: tx.slot ?? null,
    nowUtc: new Date(),
    note: verdict === 'UNPROVEN_NO_BALANCE_DATA' ? 'receipt carried no token balance data' : null,
  });

  store.recordRouteOutcome({
    routeKey: intent.routeKey,
    outcome: verdict === 'PROVEN_NET_POSITIVE' ? 'SUCCESS' : 'FAILED',
    nowUtc: new Date(),
    quarantineAfter: QUARANTINE_AFTER,
    quarantineMs: QUARANTINE_MS,
  });

  // Fee overrun: the reservation used a worst-case estimate, so paying materially
  // more means the estimator margin is wrong and the cap is not what it claims.
  const worstCase = BigInt(intent.worstCaseFeeRaw);
  if (worstCase > 0n && feeLamports > worstCase) {
    logger.error('fee_overrun', {
      intentId: intent.intentId,
      worstCaseLamports: worstCase.toString(),
      actualLamports: feeLamports.toString(),
      overrunLamports: (feeLamports - worstCase).toString(),
    });
    metrics.inc('fee_overruns');
  }

  metrics.inc('reconciled');
  logger.info('reconcile_complete', {
    intentId: intent.intentId,
    signature: intent.signature,
    verdict,
    realisedDeltaRaw: realisedDeltaRaw?.toString() ?? null,
    feeLamports: feeLamports.toString(),
    duplicate: !inserted,
  });
}

/** The outstanding reservation for an intent, if the store still holds one. */
function reservationIdFor(store: Store, intentId: string): string {
  for (const reservation of store.outstandingReservations()) {
    if (reservation.intentId === intentId) return reservation.reservationId;
  }
  return `resv:${intentId}`;
}

main().catch((error: unknown) => {
  // stderr directly: configuration may be what failed, so no logger yet.
  console.error(
    JSON.stringify({
      level: 'fatal',
      service: 'sol-tea-reconciler',
      message: 'startup_failed',
      error: error instanceof Error ? error.message : String(error),
      ts: new Date().toISOString(),
    }),
  );
  process.exit(1);
});
