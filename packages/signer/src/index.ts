/**
 * packages/signer — the signer firewall.
 *
 * This is the only module that ever holds key material, and it deliberately has
 * the smallest possible API surface: it signs a transaction **only** if that
 * transaction is byte-identical to the one described by the admitted intent.
 * That check turns "the executor built something else" into a contained bug
 * instead of a fund-loss incident (V6 §07).
 *
 * Key handling rules:
 *  - the keypair is read from an absolute path OUTSIDE the repository,
 *  - the file must not be group/world readable,
 *  - the loaded public key must match the configured operator address,
 *  - the secret is never logged, returned, or copied into state.
 */

import { readFileSync, statSync } from 'node:fs';
import { Keypair, type PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import type { Logger } from '../../obs/src';

export type SignerErrorCode =
  | 'NO_KEYPAIR'
  | 'KEYPAIR_UNREADABLE'
  | 'KEYPAIR_INSECURE_PERMISSIONS'
  | 'KEYPAIR_IN_REPO'
  | 'KEYPAIR_MALFORMED'
  | 'OPERATOR_MISMATCH'
  | 'INTENT_MISMATCH'
  | 'LIVE_DISABLED';

export class SignerError extends Error {
  constructor(
    readonly code: SignerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SignerError';
  }
}

export interface SignerOptions {
  readonly keypairPath: string;
  readonly expectedPublicKey: string;
  readonly repositoryRoot: string;
  readonly liveEnabled: boolean;
  readonly logger: Logger;
}

export interface SigningRequest {
  readonly intentId: string;
  /** Message bytes (base64) the executor recorded before signing. */
  readonly expectedMessageBase64: string;
  readonly transaction: Transaction | VersionedTransaction;
}

export interface Signer {
  readonly publicKey: PublicKey | null;
  isArmed(): boolean;
  sign(request: SigningRequest): Promise<{ signature: string; messageBase64: string }>;
}

function messageBase64(tx: Transaction | VersionedTransaction): string {
  const message = 'message' in tx ? tx.message.serialize() : Buffer.alloc(0);
  return Buffer.from(message).toString('base64');
}

export function loadSigner(options: SignerOptions): Signer {
  if (options.keypairPath === '') {
    options.logger.warn('signer_not_configured', { mode: 'observe-only' });
    return {
      publicKey: null,
      isArmed: () => false,
      sign: async () => {
        throw new SignerError('NO_KEYPAIR', 'no keypair configured; engine is observe-only');
      },
    };
  }

  // Refuse a keypair inside the checkout: it would reach a commit or a backup
  // eventually, whatever .gitignore says.
  if (options.keypairPath.startsWith(options.repositoryRoot)) {
    throw new SignerError('KEYPAIR_IN_REPO', 'keypair must live outside the repository working tree');
  }

  let raw: string;
  try {
    raw = readFileSync(options.keypairPath, 'utf8');
  } catch (error) {
    throw new SignerError('KEYPAIR_UNREADABLE', `cannot read keypair: ${(error as Error).message}`);
  }

  // A world-readable secret is a compromised secret.
  const mode = statSync(options.keypairPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new SignerError(
      'KEYPAIR_INSECURE_PERMISSIONS',
      `keypair file mode ${mode.toString(8)} must not be group/world accessible (chmod 600)`,
    );
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[]));
  } catch {
    throw new SignerError('KEYPAIR_MALFORMED', 'keypair file is not a valid JSON secret-key array');
  }

  if (options.expectedPublicKey !== '' && keypair.publicKey.toBase58() !== options.expectedPublicKey) {
    throw new SignerError(
      'OPERATOR_MISMATCH',
      `loaded key does not match the configured operator address`,
    );
  }

  options.logger.info('signer_loaded', {
    publicKey: keypair.publicKey.toBase58(),
    liveEnabled: options.liveEnabled,
  });

  return {
    publicKey: keypair.publicKey,
    isArmed: () => options.liveEnabled,
    async sign(request: SigningRequest) {
      if (!options.liveEnabled) {
        throw new SignerError('LIVE_DISABLED', 'live execution is disabled by configuration');
      }
      const actual = messageBase64(request.transaction);
      if (actual !== request.expectedMessageBase64) {
        // The transaction changed after admission. Never sign that.
        throw new SignerError(
          'INTENT_MISMATCH',
          `refusing to sign intent ${request.intentId}: message bytes differ from the admitted intent`,
        );
      }
      let signature: string;
      if ('version' in request.transaction) {
        request.transaction.sign([keypair]);
        const sig = request.transaction.signatures[0];
        if (!sig) throw new SignerError('INTENT_MISMATCH', 'transaction produced no signature');
        signature = Buffer.from(sig).toString('base64');
      } else {
        request.transaction.partialSign(keypair);
        const sig = request.transaction.signature;
        if (!sig) throw new SignerError('INTENT_MISMATCH', 'transaction produced no signature');
        signature = sig.toString('base64');
      }
      options.logger.info('tx_signed', { intentId: request.intentId });
      return { signature, messageBase64: actual };
    },
  };
}
