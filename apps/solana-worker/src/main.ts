/**
 * apps/solana-worker/main — process wiring and lifecycle.
 *
 * Startup order is deliberate and non-negotiable:
 *   1. validate environment + chain/policy files (fail fast, before any I/O)
 *   2. open the signed outbox and reconcile anything left unresolved
 *   3. build providers, market store, ledger, signer
 *   4. subscribe to live pool accounts
 *   5. expose health, then arm the loop
 *
 * Shutdown is equally deliberate: stop intake first (so no new candidate is
 * born), then close the journal.
 */

import { Connection } from '@solana/web3.js';
import {
  executionAllowed,
  loadChainConfig,
  loadDotEnv,
  loadEnv,
  loadPolicy,
  unresolvedPolicyFields,
} from '../../../packages/config/src';
import { POOL_W_SOL_USDC_400, POOL_W_SOL_USDC_500, USDC } from '../../../packages/registry/src';
import { createLogger, Funnel, Metrics, hostId } from '../../../packages/obs/src';
import {
  buildProviderConfigs,
  ProviderPool,
  SubscriptionManager,
  type StreamGap,
  type StreamStatus,
} from '../../../packages/rpc/src';
import { MarketStateStore } from '../../../packages/market/src';
import { ReservationLedger, admitOpportunity } from '../../../packages/policy/src';
import { SignedOutbox, journalPathFor } from '../../../packages/journal/src';
import { loadSigner } from '../../../packages/signer/src';
import { Executor, estimateWorstCaseFeeLamports } from '../../../packages/executor/src';
import { Reconciler } from '../../../packages/reconcile/src';
import { ingestPoolUpdate, selectBestCycle, type PipelineDeps } from './pipeline';
import { readPauseState, startHealthServer } from './health';
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
    liveRequested: env.ENABLE_LIVE_EXECUTION,
    dotenvLoaded: dotenv.loaded,
    dotenvKeys: dotenv.appliedKeys,
  });

  /* 1. configuration ------------------------------------------------------- */
  const chain = loadChainConfig(env.SOL_TEA_CHAIN_CONFIG);
  const policy = loadPolicy(env.SOL_TEA_POLICY_CONFIG);
  const unresolved = unresolvedPolicyFields(policy);

  if (chain.chain.genesisHash === 'REQUIRED_OWNER_BINDING') {
    throw new Error('chain.genesisHash is unresolved; refusing to start');
  }
  if (unresolved.length > 0) {
    // Not fatal: observe-only mode is a first-class operating mode.
    logger.warn('policy_unresolved', { fields: unresolved, mode: 'observe-only' });
  }

  const liveEnabled = executionAllowed(env) && chain.chain.enabled && unresolved.length === 0;

  /* 2. journal + recovery -------------------------------------------------- */
  const journal = new SignedOutbox(journalPathFor(env.JOURNAL_DIR));
  const pendingAtBoot = journal.unresolved();
  if (pendingAtBoot.length > 0) {
    logger.warn('journal_unresolved_at_boot', {
      count: pendingAtBoot.length,
      intents: pendingAtBoot.slice(0, 10).map((record) => record.intentId),
    });
  }

  /* 3. providers, market, ledger, signer ----------------------------------- */
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
    maxSkewSlots: 32,
  });

  const ledger = new ReservationLedger(policy);
  const signer = loadSigner({
    keypairPath: env.WALLET_KEYPAIR_PATH,
    expectedPublicKey: env.OPERATOR_PUBLIC_ADDRESS,
    repositoryRoot: REPO_ROOT,
    liveEnabled,
    logger,
  });

  const reconciler = new Reconciler({ connection: providers.primary.connection, journal, logger });

  if (signer.publicKey) {
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
  } else if (pendingAtBoot.length > 0) {
    // Without an owner address nothing can be reconciled; signing stays blocked.
    logger.error('reconciliation_blocked', { reason: 'no-signer-configured' });
  }

  /* 4. live intake --------------------------------------------------------- */
  const bindings = new Map([
    [POOL_W_SOL_USDC_400.address, POOL_W_SOL_USDC_400],
    [POOL_W_SOL_USDC_500.address, POOL_W_SOL_USDC_500],
  ]);

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

  let lastAttemptMonoNs = 0n;
  let inFlight = false;
  const minAttemptIntervalMs = 250;

  const evaluator = (): void => {
    if (inFlight) {
      funnel.markReason('MAX_CONCURRENT_PENDING');
      return;
    }
    const pause = readPauseState(policy.control.pauseFile, env.EMERGENCY_PAUSE);
    if (pause.paused) {
      funnel.markReason('PAUSED');
      return;
    }

    // Rate-limit the expensive path: feed updates arrive far faster than any
    // attempt could possibly be built.
    const nowMono = process.hrtime.bigint();
    if (Number(nowMono - lastAttemptMonoNs) / 1_000_000 < minAttemptIntervalMs) return;
    lastAttemptMonoNs = nowMono;

    inFlight = true;
    try {
      const principal =
        policy.solArb.minPrincipalRawPerAttempt === 'REQUIRED_OWNER_BINDING'
          ? 1_000_000n
          : BigInt(policy.solArb.minPrincipalRawPerAttempt);

      const candidate = selectBestCycle(pipelineDeps, principal);
      if (!candidate) return;

      const admission = admitOpportunity({
        policy,
        routeKey: candidate.key,
        grossSurplusRaw: candidate.grossSurplusRaw,
        principalRaw: candidate.amountInRaw,
        worstCaseNativeFeeRaw: estimateWorstCaseFeeLamports({
          signatureCount: 1,
          computeUnits: chain.executor.maxComputeUnits,
          priorityFeeMicroLamports: chain.executor.priorityFeeMicroLamports,
        }),
        activePending: ledger.activePending(),
        routeFailures: 0,
        lastFailureAtUtc: null,
        nowUtc: new Date(),
        paused: pause.paused,
        liveExecutionEnabled: liveEnabled,
      });

      funnel.markStage(admission.admitted ? 'ADMITTED' : 'REJECTED');
      if (!admission.admitted) {
        funnel.markReason(admission.reason);
        logger.debug('admission_rejected', {
          routeKey: candidate.key,
          reason: admission.reason,
          detail: admission.detail,
        });
        return;
      }

      // Live quoting/submission attaches here once the PRE-LIVE gate is signed
      // off (`executor` is wired and armed above). Until then every admitted
      // candidate is recorded as a dry-run observation so the funnel can be
      // verified on real data without any risk.
      logger.info('candidate_admitted_dry_run', {
        routeKey: candidate.key,
        surplusRaw: candidate.grossSurplusRaw.toString(),
        principalRaw: candidate.amountInRaw.toString(),
        slot: candidate.basedOnSlot,
        executorArmed: signer.isArmed(),
      });
      funnel.markReason('OK');
    } finally {
      inFlight = false;
    }
  };

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
    providerId: 'primary',
    // web3.js requires an HTTP endpoint as the connection base and takes the
    // socket URL via `wsEndpoint`; passing a wss:// URL as the first argument
    // throws "Endpoint URL must start with http:".
    connect: (wsUrl, commitment) =>
      new Connection(env.RPC_HTTP_URL, { commitment, wsEndpoint: wsUrl }),
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

      // Whirlpool accounts carry price + liquidity but NOT token balances, so
      // depth must be read from the two vault token accounts. This is done here
      // (async, off the socket callback) and the snapshot is re-applied with
      // reserves attached; without them no cycle can be sized.
      const snapshot = decoded.snapshot;
      void readVaultReserves({
        connection: providers.primary.connection,
        poolAddress: snapshot.poolAddress,
        vaultA: snapshot.vaultA,
        vaultB: snapshot.vaultB,
        commitment: chain.chain.commitment,
      })
        .then((reserves) => {
          market.apply({ ...snapshot, reserveA: reserves.reserveA, reserveB: reserves.reserveB });
          metrics.inc('market.reserves_hydrated');
          evaluator();
        })
        .catch((error: unknown) => {
          metrics.inc('market.reserves_failed');
          logger.warn('reserves_read_failed', {
            pool: snapshot.poolAddress,
            error: (error as Error).message,
          });
        });
    },
    onGap: (gap: StreamGap) => {
      metrics.inc(`ws.gap.${gap.reason}`);
      // Cached bytes are unprovable after a gap: quarantine, never guess.
      market.invalidateAll(gap.reason);
    },
    onStatus: (status: StreamStatus) => {
      metrics.set('ws.live', status === 'live' ? 1 : 0);
    },
  });

  /* 5. control surface + lifecycle ---------------------------------------- */
  const health = startHealthServer(
    {
      logger,
      metrics,
      funnel,
      market,
      ledger,
      journal,
      pauseFile: policy.control.pauseFile,
      getStreamStatus: () => subscription.getStatus(),
      getProviderStates: () => providers.statesSnapshot(),
      getUnresolvedIntents: () => journal.unresolved().length,
    },
    env.HEALTH_PORT,
  );

  await subscription.start();
  logger.info('boot_complete', {
    mode: liveEnabled ? 'live' : 'observe-only',
    pools: [...bindings.keys()],
    commitment: chain.chain.commitment,
    settlementMint: USDC.mint,
    executorWired: executor instanceof Executor,
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('shutdown_begin', { signal });
    await subscription.stop();
    health.close();
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
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      component: 'solana-worker',
      event: 'boot_failed',
      error: failure.message,
    }) + '\n',
  );
  process.exit(1);
});
