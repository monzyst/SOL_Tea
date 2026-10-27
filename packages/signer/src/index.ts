/**
 * packages/signer — the signer firewall.
 *
 * This is the only module that touches key material, and it is deliberately
 * paranoid in three ways:
 *  1. it refuses to load a key file inside the repository
 *  2. it refuses a key file with group/world permissions
 *  3. it refuses to sign bytes that differ from the ones that were admitted
 *
 * The third is the one that matters most: a transaction is signed and then
 * broadcast, so "almost the same message" is a different trade.
 */

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Keypair, VersionedTransaction, type PublicKey } from '@solana/web3.js';
import type { Logger } from '../../obs/src';

export class SignerError extends Error {
  constructor(
    readonly code:
      | 'KEYPAIR_INSIDE_REPO'
      | 'KEYPAIR_INSECURE_PERMISSIONS'
      | 'KEYPAIR_UNREADABLE'
      | 'KEYPAIR_INVALID'
      | 'ADDRESS_MISMATCH'
      | 'INTENT_MISMATCH'
      | 'NOT_ARMED',
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

export interface Signer {
  readonly publicKey: PublicKey | null;
  readonly address: string | null;
  isArmed(): boolean;
  /** Sign exactly these bytes for this intent; throws on any mismatch. */
  signIntent(input: {
    intentId: string;
    messageFingerprint: string;
    transaction: VersionedTransaction;
  }): Promise<{ signature: string; transaction: VersionedTransaction }>;
}

/**
 * Load (or deliberately not load) the operator key.
 *
 * With no path configured the returned signer is unarmed but fully functional:
 * the engine can run observe-only without pretending to be broken.
 */
export function loadSigner(options: SignerOptions): Signer {
  const { keypairPath, expectedPublicKey, repositoryRoot, liveEnabled, logger } = options;

  if (keypairPath === '') {
    logger.warn('signer_not_configured', { mode: 'observe-only' });
    return unarmedSigner();
  }

  const absoluteRepo = resolve(repositoryRoot);
  const absoluteKey = resolve(keypairPath);

  // A key inside the working tree is one `git add -A` away from being published.
  if (absoluteKey === absoluteRepo || absoluteKey.startsWith(absoluteRepo + '/')) {
    throw new SignerError(
      'KEYPAIR_INSIDE_REPO',
      `keypair path ${absoluteKey} is inside the repository; move it outside (e.g. /etc/sol-tea/keys/)`,
    );
  }

  let mode: number;
  try {
    mode = statSync(absoluteKey).mode;
  } catch {
    throw new SignerError('KEYPAIR_UNREADABLE', `cannot stat keypair at ${absoluteKey}`);
  }
  // 0o077 forbids group and world access entirely.
  if ((mode & 0o077) !== 0) {
    throw new SignerError(
      'KEYPAIR_INSECURE_PERMISSIONS',
      `keypair ${absoluteKey} is accessible by group/world (mode ${(mode & 0o777).toString(8)}); use chmod 600`,
    );
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(absoluteKey, 'utf8'))));
  } catch (error) {
    throw new SignerError('KEYPAIR_INVALID', `cannot parse keypair: ${(error as Error).message}`);
  }

  const address = keypair.publicKey.toBase58();
  if (expectedPublicKey !== '' && expectedPublicKey !== address) {
    throw new SignerError(
      'ADDRESS_MISMATCH',
      `loaded key is ${address} but OPERATOR_PUBLIC_ADDRESS is ${expectedPublicKey}`,
    );
  }

  logger.info('signer_loaded', { address, armed: liveEnabled });

  return {
    publicKey: keypair.publicKey,
    address,
    isArmed: () => liveEnabled,
    async signIntent(input) {
      if (!liveEnabled) {
        throw new SignerError('NOT_ARMED', 'live execution is disabled; refusing to sign');
      }

      // Bind the signature to the admitted intent. If the message changed after
      // admission, sign nothing.
      const liveFingerprint = fingerprint(input.transaction);
      if (liveFingerprint !== input.messageFingerprint) {
        throw new SignerError(
          'INTENT_MISMATCH',
          `intent ${input.intentId}: message changed between admission and signing`,
        );
      }

      input.transaction.sign([keypair]);
      const signature = input.transaction.signatures[0];
      if (!signature) throw new SignerError('INTENT_MISMATCH', 'signature missing after signing');

      const encoded = encodeBase58(signature);
      logger.info('tx_signed', { intentId: input.intentId, signature: encoded });
      return { signature: encoded, transaction: input.transaction };
    },
  };
}

/** An unarmed signer that fails loudly rather than silently doing nothing. */
function unarmedSigner(): Signer {
  return {
    publicKey: null,
    address: null,
    isArmed: () => false,
    async signIntent() {
      throw new SignerError('NOT_ARMED', 'no signer configured; set WALLET_KEYPAIR_PATH');
    },
  };
}

import { createHash } from 'node:crypto';

/** Fingerprint of the compiled message, matching what the journal recorded. */
export function fingerprint(transaction: VersionedTransaction): string {
  return createHash('sha256').update(transaction.message.serialize()).digest('hex');
}

function encodeBase58(bytes: Uint8Array): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let out = '';
  while (num > 0n) {
    const remainder = Number(num % 58n);
    out = alphabet[remainder] + out;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out === '' ? '1' : out;
}
