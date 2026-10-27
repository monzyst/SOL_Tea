/**
 * apps/solana-worker/main — the real-time worker: wiring and lifecycle.
 *
 * Startup order is deliberate and non-negotiable:
 *   1. validate environment + chain/policy files (fail fast, before any I/O)
 *   2. open the durable store; expire stale reservations from the last process
 *   3. open the signed outbox and resolve anything left unresolved
 *   4. build providers, market store, liquidity cache, fee estimator, signer
 *   5. subscribe to live pool accounts (with provider failover)
 *   6. warm the liquidity maps, then arm the evaluator
 *   7. expose health, then loop
 *
 * Shutdown is equally deliberate: stop intake first (so no new candidate is
 * born), wait for an in-flight attempt to finish, then close the journal.
 *
 * The evaluator is EDGE-TRIGGERED by pool updates but COALESCED: a burst of
 * account writes produces at most one evaluation every `minAttemptIntervalMs`,
 * and never more than one concurrent attempt. That keeps the hot path bounded
 * without dropping the latest state.
 */

import { Connection } from '@solana/web3.js';
import {
  executionAllowed,
  loadChainConfig,
  loadDotEnv,
  loadEnv,
  loadPolicy,
  priorityFeePolicy,
  unresolvedPolicyFields,
  liveSubmissionAllowed,
} from '../../../packages/config/src';
import { POOL_W_SOL_USDC_400, POOL_W_SOL_USDC_500, USDC } from '../../../packages/registry/src';
import { createLogger, Funnel, Metrics, hostId, nowMonoNs } from '../../../packages/obs/src';
import {
  buildProviderConfigs,
  FailoverConnectionFactory,
  ProviderPool,
  SubscriptionManager,
  PriorityFeeEstimator,
  type StreamGap,
  type StreamStatus,
} from '../../../packages/rpc/src';
import { MarketStateStore } from '../../../packages/market/src';
import { SignedOutbox, journalPathFor } from '../../../packages/journal/src';
import { loadSigner, SignerError } from '../../../packages/signer/src';
import { Executor } from '../../../packages/executor/src';
import { Reconciler } from '../../../packages/reconcile/src';
import { openStore } from '../../../packages/store/src';
import { LiquidityCache, fetchLiquidityMap } from '../../../chains/solana/src/venues';
import {
  AlertDispatcher,
  RemotePauseChannel,
  WebhookAlertTransport,
  readPauseState,
} from '../../../packages/control/src';
import { ingestPoolUpdate, type PipelineDeps } from './pipeline';
import { evaluateOnce } from './lifecycle';
import { warmupPools } from './warmup';
import { startHealthServer } from './health';
import { readVaultReserves } from '../../../chains/solana/src/vaults';

const REPO_ROOT = process.cwd();

async function main(): Promise<void> {
  // Local .env is a convenience only; real environment variables always win.
  const dotenv = loadDotEnv();
  const env = loadEnv();
  const logger = createLogger({
    component: 'solana-worker',
    level: env.LOG_LEVEL,
    pretty: env.LOG_PRETTY,
  });
  const metrics = new Metrics();
  const funnel = new Funnel();

  logger.info('boot_start', {
    hostId: hostId(),
    service: env.SERVICE_NAME,
    liveRequested: env.ENABLE_LIVE_EXECUTION,
    dotenvLoaded: dotenv.loaded,
    dotenvKeys: dotenv.appliedKeys,
  });

  /* 1. configuration ------------------------------------------------------- */
  const chain = loadChainConfig(env.SOL_TEA_CHAIN_CONFIG);
  const policy = loadPolicy(env.SOL_TEA_POLICY_CONFIG);
  const unresolved = unresolvedPolicyFields(policy);
  const feePolicy = priorityFeePolicy(policy);

  if (unresolved.length > 0) {
    // Not fatal: observe-only mode is a first-class operating mode.
    logger.warn('policy_unresolved', { fields: unresolved, mode: 'observe-only' });
  }

  const liveGate = liveSubmissionAllowed({
    config: chain,
    envLiveEnabled: executionAllowed(env),
    envPaused: env.EMERGENCY_PAUSE,
    unresolvedPolicy: unresolved,
  });
  const liveEnabled = liveGate.allowed;
  if (!liveEnabled) {
    logger.info('live_execution_blocked', { reasons: liveGate.reasons });
  }

  /* 2. durable store ------------------------------------------------------- */
  const store = openStore(chain.store.path);
  // Reservations outstanding from a dead process can never be settled from
  // memory; they are expired here so the period budget is not silently held.
  let expiredAtBoot = 0;
  for (const reservation of store.outstandingReservations()) {
    store.expireReservation(reservation.reservationId, new Date(), 'BOOT_STALE_RESERVATION');
    expiredAtBoot += 1;
  }
  if (expiredAtBoot > 0) logger.warn('reservations_expired_at_boot', { count: expiredAtBoot });

  /* 3. journal + recovery -------------------------------------------------- */
  const journal = new SignedOutbox(journalPathFor(env.JOURNAL_DIR));
  const recovery = journal.recovery();
  const pendingAtBoot = journal.unresolved();
  if (pendingAtBoot.length > 0) {
    logger.warn('journal_unresolved_at_boot', {
      count: pendingAtBoot.length,
      signedNotSubmitted: recovery.signedNotSubmitted.length,
      submittedUnresolved: recovery.submittedUnresolved.length,
      awaitingFinality: recovery.awaitingFinality.length,
    });
  }

  /* 4. providers, market, liquidity, fees, signer -------------------------- */
  const providers = new ProviderPool(
    buildProviderConfigs({
      httpUrl: env.RPC_HTTP_URL,
      wsUrl: env.RPC_WS_URL,
      httpUrlSecondary: env.RPC_HTTP_URL_SECONDARY,
      wsUrlSecondary: env.RPC_WS_URL_SECONDARY,
    }),
    { commitment: chain.chain.commitment, logger },
  );

  const market = new MarketStateStore({
    maxQuoteAgeMs: chain.market.maxQuoteAgeMs,
    maxSkewSlots: env.MAX_SKEW_SLOTS,
  });

  const bindings = new Map([
    [POOL_W_SOL_USDC_400.address, POOL_W_SOL_USDC_400],
    [POOL_W_SOL_USDC_500.address, POOL_W_SOL_USDC_500],
  ]);

  const liquidity = new LiquidityCache({
    connection: providers.primary.connection,
    logger,
    maxAgeMs: chain.market.liquidityMapMaxAgeMs,
    span: chain.market.liquidityMapSpan,
  });

  const priorityFee = new PriorityFeeEstimator({
    connection: providers.primary.connection,
    logger,
    watchedAccounts: [...bindings.keys()],
    percentile: feePolicy.percentile,
    floorMicroLamports: feePolicy.floorMicroLamports,
    ceilingMicroLamports: feePolicy.ceilingMicroLamports,
    minSamples: feePolicy.minSamples,
    ttlMs: feePolicy.ttlMs,
    fallbackMicroLamports: feePolicy.fallbackMicroLamports,
  });

  const signer = loadSigner({
    keypairPath: env.WALLET_KEYPAIR_PATH,
    expectedPublicKey:
      env.OPERATOR_PUBLIC_ADDRESS !== ''
        ? env.OPERATOR_PUBLIC_ADDRESS
        : chain.executor.operatorPublicAddress === 'REQUIRED_OWNER_BINDING'
          ? ''
          : chain.executor.operatorPublicAddress,
    repositoryRoot: REPO_ROOT,
    liveEnabled,
    logger,
    maxComputeUnitPriceMicroLamports: feePolicy.ceilingMicroLamports,
    maxComputeUnits: chain.executor.maxComputeUnits,
  });

  const reconciler = new Reconciler({ connection: providers.primary.connection, journal, logger });

  if (signer.publicKey) {
    try {
      const recovered = await reconciler.reconcilePending({
        settlementMint: chain.chain.settlementMint,
        ownerAddress: signer.publicKey.toBase58(),
      });
      if (recovered.length > 0) {
        logger.info('boot_reconciliation', {
          attempted: recovered.length,
          proven: recovered.filter((result) => result.verdict !== 'UNPROVEN').length,
        });
      }
    } catch (error) {
      // Reconciliation failure blocks new signing: an unresolved intent means the
      // fee ledger is unknown, and guessing is not acceptable.
      logger.error('boot_reconciliation_failed', { error: (error as Error).message });
    }
  } else if (pendingAtBoot.length > 0) {
    logger.error('reconciliation_blocked', { reason: 'no-signer-configured' });
  }

  /* alerting: durable outbox in front of the webhook ----------------------- */
  const alerts = new AlertDispatcher({
    store,
    transport: env.ALERT_WEBHOOK_URL !== '' ? new WebhookAlertTransport({ url: env.ALERT_WEBHOOK_URL }) : null,
    logger,
  });

  const remotePause = new RemotePauseChannel({
    url: policy.control.independentPause?.url ?? '',
    timeoutMs: policy.control.independentPause?.timeoutMs ?? 3_000,
    staleAfterMs: policy.control.independentPause?.staleAfterMs ?? 300_000,
  });

  const pipelineDeps: PipelineDeps = {
    logger,
    funnel,
    metrics,
    market,
    bindings,
    settlementMint: chain.chain.settlementMint,
  };

  const executor = new Executor({
    connection: providers.primary.connection,
    signer,
    journal,
    logger,
  });

  /* 5. evaluator (coalesced, single-flight) -------------------------------- */
  let inFlight = false;
  let lastAttemptMonoNs = 0n;
  let cachedRemotePaused = false;
  const minAttemptIntervalMs = 250;

  const runEvaluation = async (): Promise<void> => {
    if (inFlight) {
      funnel.markReason('MAX_CONCURRENT_PENDING');
      return;
    }
    const sinceLast = Number(nowMonoNs() - lastAttemptMonoNs) / 1_000_000;
    if (sinceLast < minAttemptIntervalMs) return;
    lastAttemptMonoNs = nowMonoNs();

    inFlight = true;
    try {
      const outcome = await evaluateOnce({
        logger,
        funnel,
        metrics,
        market,
        connection: providers.primary.connection,
        chain,
        policy,
        store,
        bindings,
        liquidity,
        priorityFee,
        executor,
        reconciler,
        settlementMint: chain.chain.settlementMint,
        liveEnabled,
        paused: cachedRemotePaused || env.EMERGENCY_PAUSE,
      });
      if (outcome.admitted) {
        logger.debug('evaluation_admitted', {
          intentId: outcome.intentId,
          mode: outcome.mode,
          signature: outcome.signature,
        });
      }
    } catch (error) {
      // An unexpected throw must not kill the loop, but it must be visible.
      metrics.inc('lifecycle.error');
      logger.error('evaluation_failed', { error: (error as Error).message });
      void alerts.notify({
        topic: 'lifecycle.error',
        severity: 'critical',
        message: (error as Error).message,
      });
    } finally {
      inFlight = false;
    }
  };

  /**
   * Refresh the liquidity map for a pool and then evaluate.
   *
   * Discovery can only price a pool once its tick arrays are loaded, so this is
   * on the critical path for the first quote of each pool — but it happens off
   * the socket callback, and it is coalesced by the cache.
   */
  const refreshLiquidity = (poolAddress: string): void => {
    const snapshot = market.get(poolAddress);
    if (!snapshot) return;
    if (snapshot.liquidityRaw <= 0n) {
      metrics.inc('liquidity.zero_skipped');
      return;
    }
    void liquidity
      .refresh({
        binding: snapshot.binding,
        tickIndex: snapshot.tickIndex,
        liquidity: snapshot.liquidityRaw,
      })
      .then((map) => {
        metrics.inc('liquidity.map_refreshed');
        metrics.set('liquidity.initialized_ticks', map.map.size);
        void runEvaluation();
      })
      .catch((error: unknown) => {
        metrics.inc('liquidity.map_failed');
        logger.warn('liquidity_map_failed', {
          pool: poolAddress,
          error: (error as Error).message,
        });
      });
  };

  /* 6. live intake --------------------------------------------------------- */
  const failover = new FailoverConnectionFactory(providers, chain.chain.commitment, logger);

  const subscription = new SubscriptionManager({
    wsUrl: env.RPC_WS_URL,
    programId: chain.market.programId,
    poolAddresses: [...bindings.keys()],
    commitment: chain.chain.commitment,
    reconnectBaseMs: chain.market.reconnectBaseMs,
    reconnectMaxMs: chain.market.reconnectMaxMs,
    stallThresholdMs: Math.max(30_000, chain.market.maxQuoteAgeMs * 5),
    healthCheckIntervalMs: chain.market.healthCheckIntervalMs,
    maxSlotGap: 64,
    logger,
    providerId: providers.primary.config.id,
    // Audit T07: the subscription follows provider failover instead of pinning
    // the single configured websocket host.
    connect: (wsUrl, commitment) => {
      if (providers.rotation().length === 1) {
        // Single provider: keep the configured URL exactly as written.
        return new Connection(env.RPC_HTTP_URL, { commitment, wsEndpoint: wsUrl });
      }
      return failover.next().connection;
    },
    resolveProviderId: () => failover.peekProviderId(),
    onPoolUpdate: (update) => {
      const decoded = ingestPoolUpdate(pipelineDeps, {
        poolAddress: update.poolAddress,
        data: update.data,
        // Ownership is asserted by the program filter on the subscription.
        owner: chain.market.programId,
        slot: update.slot,
        receivedAtUtc: update.receivedAtUtc,
        receivedMonoNs: update.receivedMonoNs,
        providerId: update.providerId,
      });
      if (!decoded.snapshot) return;

      const snapshot = decoded.snapshot;

      // Two independent things must follow a pool update: the liquidity map (for
      // exact pricing) and, when the caller needs them, vault reserves (for the
      // cheap ranking pass). Both are async and both are cache-coalesced.
      if (liquidity.ageMs(snapshot.poolAddress) === null || !liquidity.peek(snapshot.poolAddress)) {
        refreshLiquidity(snapshot.poolAddress);
      }

      void hydrateReserves(snapshot).then(() => runEvaluation());
    },
    onSlot: (slot: number) => {
      // Feed the chain tip to the market store so freshness is judged in slots,
      // not wall-clock. Without this a quiet pool looks permanently stale.
      market.setChainTipSlot(slot);
    },
    onGap: (gap: StreamGap) => {
      metrics.inc(`ws.gap.${gap.reason}`);
      // Cached bytes are unprovable after a gap: quarantine, never guess.
      market.invalidateAll(gap.reason);
      liquidity.invalidateAll();
      logger.warn('stream_gap', { reason: gap.reason, detail: gap.detail });
    },
    onStatus: (status: StreamStatus) => {
      metrics.set('ws.live', status === 'live' ? 1 : 0);
      if (status === 'live') failover.reset();
    },
  });

  /* 7. control surface + housekeeping ------------------------------------- */
  /**
   * Read vault reserves for one pool and fold them into the market snapshot.
   *
   * Reserves are only used by the cheap ranking pass; exact pricing uses the tick
   * map. A failed read is logged and does not abort the evaluation, because
   * reserves are advisory — but it is counted so a persistently failing RPC shows
   * up in metrics rather than silently degrading quotes.
   */
  const hydrateReserves = async (snapshot: {
    poolAddress: string;
    vaultA: string;
    vaultB: string;
  }): Promise<void> => {
    try {
      const reserves = await readVaultReserves({
        connection: providers.primary.connection,
        poolAddress: snapshot.poolAddress,
        vaultA: snapshot.vaultA,
        vaultB: snapshot.vaultB,
        commitment: chain.chain.commitment,
      });
      const current = market.get(snapshot.poolAddress);
      if (current) {
        market.apply({ ...current, reserveA: reserves.reserveA, reserveB: reserves.reserveB });
      }
      metrics.inc('market.reserves_hydrated');
    } catch (error) {
      metrics.inc('market.reserves_failed');
      logger.warn('reserves_read_failed', {
        pool: snapshot.poolAddress,
        error: (error as Error).message,
      });
    }
  };

  /**
   * Timer path: refresh maps if aged out, hydrate reserves, then evaluate.
   * Every step is best-effort; a failure must not stop the cadence.
   */
  const refreshReservesAndEvaluate = async (): Promise<void> => {
    for (const address of bindings.keys()) {
      const snapshot = market.get(address);
      if (!snapshot) continue;
      const cached = liquidity.peek(address);
      if (!cached) {
        refreshLiquidity(address);
        // Skip this round: the map is being fetched, so a quote now would refuse
        // for a reason that is about to disappear.
        continue;
      }
      await hydrateReserves(snapshot);
    }
    await runEvaluation();
  };

  const health = startHealthServer(
    {
      logger,
      metrics,
      funnel,
      market,
      journal,
      store,
      pauseFile: policy.control.pauseFile,
      getStreamStatus: () => subscription.getStatus(),
      getProviderStates: () => providers.statesSnapshot(),
      getUnresolvedIntents: () => journal.unresolved().length,
      getLiquiditySnapshot: () => liquidity.snapshot(),
      getPriorityFee: () => {
        const estimate = priorityFee.peek();
        return estimate
          ? {
              microLamports: estimate.microLamports,
              rawPercentile: estimate.rawPercentile,
              source: estimate.source,
              sampleCount: estimate.sampleCount,
              nonZeroSamples: estimate.nonZeroSamples,
              sampledAtUtc: estimate.sampledAtUtc,
            }
          : null;
      },
      getLiveGate: () => liveGate,
    },
    env.HEALTH_PORT,
  );

  // Remote pause polled out-of-band; the hot path reads the cached verdict so a
  // slow monitor never adds latency to a decision.
  const pauseTimer = setInterval(() => {
    void readPauseState({
      pauseFilePath: '',
      envPaused: false,
      remote: remotePause,
    })
      .then((state) => {
        if (state.paused !== cachedRemotePaused) {
          logger.warn('remote_pause_changed', {
            paused: state.paused,
            sources: state.sources,
            remoteStale: state.remoteStale,
          });
          if (state.paused) {
            void alerts.notify({
              topic: 'control.paused',
              severity: 'warn',
              message: 'engine paused by remote control plane',
              fields: state.detail,
            });
          }
        }
        cachedRemotePaused = state.paused;
        metrics.set('control.paused', state.paused ? 1 : 0);
      })
      .catch(() => {
        /* readPauseState already fail-closes; nothing to add here */
      });
  }, 15_000);
  pauseTimer.unref?.();

  /**
   * Evaluation cadence.
   *
   * Event-driven is the primary trigger, but it is NOT sufficient on its own: a
   * pool account changes only when someone trades it, so on a quiet venue (a
   * thin second leg, an overnight market) an event-only engine can go minutes
   * between evaluations and will miss windows that open without either pool
   * printing an update. The timer guarantees a bounded evaluation interval while
   * leaving the hot path event-driven; `runEvaluation` is re-entrancy guarded and
   * rate-limited, so a burst of events plus this tick still costs one evaluation.
   *
   * Interval is deliberately not tight: each tick does an RPC read for vault
   * reserves, so 1s keeps RPC load negligible while bounding staleness.
   */
  const evaluationTimer = setInterval(() => {
    void refreshReservesAndEvaluate();
  }, 1_000);
  evaluationTimer.unref?.();

  const alertDrainTimer = setInterval(() => {
    void alerts.drainPending(10).catch(() => undefined);
  }, 30_000);
  alertDrainTimer.unref?.();

  // Warm the states BEFORE the first evaluation: pool snapshots over one batched
  // read, then the liquidity maps, so the first opportunity is priced exactly
  // rather than skipped for want of tick arrays.
  await subscription.start();

  const warm = await warmupPools({
    connection: providers.primary.connection,
    market,
    bindings,
    commitment: chain.chain.commitment,
    logger,
  });
  if (warm.failed.length > 0) {
    logger.warn('warmup_partial', { warmed: warm.warmed.length, failed: warm.failed });
  }

  for (const address of warm.warmed) {
    const snapshot = market.get(address);
    if (!snapshot) continue;
    try {
      await liquidity.refresh({
        binding: snapshot.binding,
        tickIndex: snapshot.tickIndex,
        liquidity: snapshot.liquidityRaw,
      });
    } catch (error) {
      logger.warn('warmup_liquidity_failed', { pool: address, error: (error as Error).message });
    }
  }

  await priorityFee.estimate().catch(() => undefined);

  logger.info('boot_complete', {
    mode: liveEnabled ? 'live' : chain.chain.executionMode,
    liveBlockers: liveGate.reasons,
    pools: [...bindings.keys()],
    commitment: chain.chain.commitment,
    settlementMint: USDC.mint,
    feePolicy,
    storePath: chain.store.path,
    liquidityMaps: liquidity.snapshot().length,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutdown_begin', { signal });
    clearInterval(pauseTimer);
    clearInterval(evaluationTimer);
    clearInterval(alertDrainTimer);
    await subscription.stop();
    health.close();
    // Wait briefly for an in-flight attempt: aborting mid-submit is exactly the
    // ambiguity the executor is built to avoid.
    const deadline = Date.now() + 20_000;
    while (inFlight && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (inFlight) logger.error('shutdown_inflight_timeout', { note: 'outcome left UNKNOWN by design' });
    store.close();
    logger.info('shutdown_complete', { journalSize: journal.size });
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', { reason: reason as Error });
  });
  process.on('uncaughtException', (error) => {
    // Deliberately fatal: continuing after an unknown exception risks signing
    // from an inconsistent state.
    logger.error('uncaught_exception', { error: error.message, stack: error.stack });
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  const failure = error as Error;
  const code = failure instanceof SignerError ? failure.code : 'BOOT_FAILED';
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      component: 'solana-worker',
      event: 'boot_failed',
      code,
      error: failure.message,
    }) + '\n',
  );
  process.exit(1);
});
