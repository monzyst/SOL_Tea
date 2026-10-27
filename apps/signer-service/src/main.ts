/**
 * apps/signer-service — the signing role, separated from the trading loop.
 *
 * Why separate. In a single-process design, anything that can reach the trading
 * code can reach the key. Splitting the signer out means the worker holds no
 * secret at all: it POSTs a transaction it has already built, and receives a
 * signature only if the request passes the firewall here.
 *
 * Three independent conditions gate every request:
 *   1. The service must be armed (keypair present, live enabled, pause clear).
 *   2. The message digest must match the digest the worker journaled BEFORE
 *      signing — so a message swapped in flight is refused, not signed.
 *   3. The transaction must satisfy the economic limits decoded from the message
 *      itself (see packages/signer): programs, compute price, compute ceiling.
 *
 * The service is bound to loopback by default and requires a bearer token. It is
 * NOT an internet-facing API; if you must cross a host boundary, put it on a
 * private network with mTLS in front.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { VersionedTransaction } from '@solana/web3.js';
import { timingSafeEqual, createHash } from 'node:crypto';

import { loadDotEnv, loadEnv } from '../../../packages/config/src';
import { loadChainConfig } from '../../../packages/config/src';
import { createLogger, Metrics } from '../../../packages/obs/src';
import {
  loadSigner,
  SignedPayloadStore,
  signerRequestKey,
  SignerError,
  type SignedPayloadRecord,
} from '../../../packages/signer/src';
import { UNRESOLVED } from '../../../packages/config/src';

const MAX_BODY_BYTES = 512 * 1024;

interface SignRequestBody {
  intentId?: unknown;
  transactionBase64?: unknown;
  expectedMessageSha256?: unknown;
  buyPool?: unknown;
  sellPool?: unknown;
  maxComputeUnits?: unknown;
  priorityFeeMicroLamports?: unknown;
}

/** Constant-time token comparison; a length mismatch is still a rejection. */
function tokenMatches(provided: string, expected: string): boolean {
  if (expected.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function main(): void {
  // Load .env before validation, exactly as the worker does. Without this a
  // standalone role refuses to boot even when a valid .env is present — each
  // entrypoint must be runnable on its own.
  loadDotEnv();
  const env = loadEnv();
  const chain = loadChainConfig(env.SOL_TEA_CHAIN_CONFIG);
  const logger = createLogger({ component: 'signer-service', level: env.LOG_LEVEL, pretty: env.LOG_PRETTY });
  const metrics = new Metrics();

  if (env.SIGNER_SERVICE_TOKEN.length < 16) {
    throw new Error('SIGNER_SERVICE_TOKEN must be at least 16 characters; refusing to serve');
  }

  // The keypair path must come from the environment and must live outside the
  // checkout — loadSigner enforces that, and throws if it does not.
  const signer = loadSigner({
    keypairPath: env.WALLET_KEYPAIR_PATH,
    expectedPublicKey: env.OPERATOR_PUBLIC_ADDRESS,
    repositoryRoot: process.cwd(),
    liveEnabled: env.ENABLE_LIVE_EXECUTION,
    logger,
    maxComputeUnitPriceMicroLamports: chain.executor.priorityFeeMicroLamports > 0
      ? Math.ceil(chain.executor.priorityFeeMicroLamports * 1.5)
      : undefined,
    maxComputeUnits: chain.executor.maxComputeUnits,
  });

  // The payload store is what allows a retry after a crash to re-submit the SAME
  // bytes instead of re-signing a fresh (and different) transaction.
  const payloadStore = env.SIGNER_STORE_KEY.length >= 16
    ? new SignedPayloadStore({ secret: env.SIGNER_STORE_KEY, logger })
    : null;
  if (payloadStore === null) {
    logger.warn('signed_payload_store_disabled', {
      reason: 'SIGNER_STORE_KEY unset; retries after restart will require a fresh intent',
    });
  }
  const payloads = new Map<string, SignedPayloadRecord>();

  const ownerUnresolved = chain.executor.operatorPublicAddress === UNRESOLVED;

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/readyz')) {
        const armed = signer.isArmed();
        send(res, armed ? 200 : 503, {
          service: 'signer',
          // Arming is reported honestly: a signer with no key is not "healthy at
          // signing", it is a non-signing process that happens to be alive.
          armed,
          publicKey: signer.publicKey?.toBase58() ?? null,
          ownerBindingResolved: !ownerUnresolved,
          payloadStore: payloadStore !== null,
          liveEnabled: env.ENABLE_LIVE_EXECUTION,
          metrics: metrics.snapshot(),
        });
        return;
      }

      if (req.method !== 'POST' || req.url !== '/sign') {
        send(res, 404, { error: 'not found' });
        return;
      }

      const provided = req.headers.authorization ?? '';
      const token = provided.startsWith('Bearer ') ? provided.slice(7) : '';
      if (!tokenMatches(token, env.SIGNER_SERVICE_TOKEN)) {
        // Deliberately terse: do not tell an unauthenticated caller which part
        // of the credential was wrong.
        metrics.inc('signer_auth_failures');
        send(res, 401, { error: 'unauthorized' });
        return;
      }

      if (!signer.isArmed()) {
        metrics.inc('signer_not_armed');
        send(res, 503, { error: 'signer is not armed (no keypair or live execution disabled)' });
        return;
      }

      const raw = await readBody(req);
      let body: SignRequestBody;
      try {
        body = JSON.parse(raw) as SignRequestBody;
      } catch {
        send(res, 400, { error: 'body must be JSON' });
        return;
      }

      const intentId = typeof body.intentId === 'string' ? body.intentId : '';
      const txBase64 = typeof body.transactionBase64 === 'string' ? body.transactionBase64 : '';
      const expectedSha = typeof body.expectedMessageSha256 === 'string' ? body.expectedMessageSha256 : '';
      if (intentId === '' || txBase64 === '' || expectedSha === '') {
        send(res, 400, { error: 'intentId, transactionBase64 and expectedMessageSha256 are required' });
        return;
      }

      let transaction: VersionedTransaction;
      try {
        transaction = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'));
      } catch (error) {
        send(res, 400, { error: `transactionBase64 is not a deserialisable transaction: ${(error as Error).message}` });
        return;
      }

      const intent =
        typeof body.buyPool === 'string' && typeof body.sellPool === 'string'
          ? {
              buyPool: body.buyPool,
              sellPool: body.sellPool,
              maxComputeUnits: Number(body.maxComputeUnits ?? chain.executor.maxComputeUnits),
              priorityFeeMicroLamports: Number(
                body.priorityFeeMicroLamports ?? chain.executor.priorityFeeMicroLamports,
              ),
              commitment: chain.chain.commitment,
            }
          : undefined;

      // Idempotency: the same intent + digest must yield the same stored payload,
      // so a retry never produces a second, different transaction.
      const requestKey = signerRequestKey(intentId, expectedSha);
      const existing = payloads.get(requestKey);
      if (existing) {
        metrics.inc('signer_idempotent_hits');
        send(res, 200, {
          signature: existing.ciphertext,
          messageSha256: existing.messageSha256,
          reused: true,
        });
        return;
      }

      const started = process.hrtime.bigint();
      const result = await signer.sign({
        intentId,
        expectedMessageBase64: txBase64,
        transaction,
        expectedMessageSha256: expectedSha,
        intent,
      });
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;

      // Store the SIGNED message (not the unsigned one) under the request key, so
      // a retry replays exactly what was already broadcast.
      const digest = createHash('sha256').update(Buffer.from(result.messageBase64, 'base64')).digest('hex');
      const record: SignedPayloadRecord = payloadStore
        ? payloadStore.encrypt(intentId, digest, Buffer.from(result.messageBase64, 'base64'))
        : { intentId, messageSha256: digest, ciphertext: result.messageBase64, iv: '', tag: '' };
      payloads.set(requestKey, record);

      metrics.inc('signed');
      metrics.set('last_signing_ms', Math.round(elapsedMs));
      logger.info('signed', {
        intentId,
        messageSha256: digest,
        elapsedMs: Math.round(elapsedMs),
      });

      send(res, 200, {
        signature: result.signature,
        messageSha256: digest,
        reused: false,
      });
    } catch (error) {
      if (error instanceof SignerError) {
        // A refusal is a normal, expected outcome — log it as a warning with the
        // code, never as an unhandled exception.
        metrics.inc(`signer_refused_${error.code.toLowerCase()}`);
        logger.warn('sign_refused', { code: error.code, error: error.message });
        send(res, 403, { error: error.message, code: error.code });
        return;
      }
      logger.error('sign_failed', { error: (error as Error).message });
      metrics.inc('signer_errors');
      send(res, 500, { error: 'internal signing error' });
    }
  });

  server.listen(env.HEALTH_PORT, '127.0.0.1', () => {
    logger.info('signer_service_listening', {
      port: env.HEALTH_PORT,
      armed: signer.isArmed(),
      publicKey: signer.publicKey?.toBase58() ?? null,
    });
  });

  const stop = (signal: string): void => {
    logger.info('shutdown_requested', { signal });
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

try {
  main();
} catch (error) {
  console.error(
    JSON.stringify({
      level: 'fatal',
      service: 'sol-tea-signer',
      message: 'startup_failed',
      error: error instanceof Error ? error.message : String(error),
      ts: new Date().toISOString(),
    }),
  );
  process.exit(1);
}
