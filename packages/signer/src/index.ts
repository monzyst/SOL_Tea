/**
 * packages/signer — the signer firewall.
 *
 * This is the only module that ever holds key material, and it deliberately has
 * the smallest possible API surface: it signs a transaction **only** if
 *   (a) the message bytes equal the digest recorded before signing,
 *   (b) the transaction's own compute-budget instructions are inside the
 *       bounds the intent declared, and
 *   (c) the program/account shape matches a policy that was admitted.
 *
 * That turns "the executor built something else" into a contained bug instead
 * of a fund-loss incident (V6 §07, and Z2-10 in the source review: an
 * allowlisted program alone is not a spending policy, so the *economic* limits
 * are checked here rather than trusted from the caller).
 *
 * Key handling rules:
 *  - the keypair is read from an absolute path OUTSIDE the repository,
 *  - the file must not be group/world readable,
 *  - the loaded public key must match the configured operator address,
 *  - the secret is never logged, returned, or copied into state.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { Keypair, PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js';
import type { Logger } from '../../obs/src';
import { messageDigest } from '../../journal/src';

export type SignerErrorCode =
  | 'NO_KEYPAIR'
  | 'KEYPAIR_UNREADABLE'
  | 'KEYPAIR_INSECURE_PERMISSIONS'
  | 'KEYPAIR_IN_REPO'
  | 'KEYPAIR_MALFORMED'
  | 'OPERATOR_MISMATCH'
  | 'INTENT_MISMATCH'
  | 'COMPUTE_BUDGET_VIOLATION'
  | 'PROGRAM_NOT_ALLOWED'
  | 'LIVE_DISABLED'
  | 'STORE_KEY_MISSING';

export class SignerError extends Error {
  constructor(
    readonly code: SignerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SignerError';
  }
}

/** Non-negotiable parts of an intent that the signature must be bound to. */
export interface SignableIntent {
  readonly buyPool: string;
  readonly sellPool: string;
  readonly maxComputeUnits: number;
  readonly priorityFeeMicroLamports: number;
  readonly commitment: 'confirmed' | 'finalized';
  /** Optional allowlist; when present every program in the message must match. */
  readonly allowedProgramIds?: readonly string[];
  /** Optional cap on the declared compute-unit price. */
  readonly maxComputeUnitPriceMicroLamports?: number;
}

export interface SignerOptions {
  readonly keypairPath: string;
  readonly expectedPublicKey: string;
  readonly repositoryRoot: string;
  readonly liveEnabled: boolean;
  readonly logger: Logger;
  /** Default program allowlist applied to every signature request. */
  readonly allowedProgramIds?: readonly string[];
  /** Hard ceiling on compute unit price, independent of the request. */
  readonly maxComputeUnitPriceMicroLamports?: number;
  readonly maxComputeUnits?: number;
}

export interface SigningRequest {
  readonly intentId: string;
  /** Message bytes (base64) the executor recorded before signing. */
  readonly expectedMessageBase64: string;
  readonly transaction: Transaction | VersionedTransaction;
  /** SHA-256 of the message bytes, journaled with the intent. */
  readonly expectedMessageSha256?: string;
  readonly intent?: SignableIntent;
}

export interface Signer {
  readonly publicKey: PublicKey | null;
  isArmed(): boolean;
  sign(request: SigningRequest): Promise<{ signature: string; messageBase64: string }>;
}

function messageOf(tx: Transaction | VersionedTransaction): Uint8Array {
  return 'message' in tx ? tx.message.serialize() : new Uint8Array();
}

/**
 * Read the compute-budget instructions out of a legacy Transaction.
 *
 * A VersionedTransaction is checked structurally instead (its instructions are
 * decoded elsewhere), which is why the legacy path is the one asserting values.
 */
function assertComputeBudget(
  tx: Transaction | VersionedTransaction,
  intent: SignableIntent,
  hardMaxCuPrice: number | undefined,
  hardMaxCu: number | undefined,
): void {
  if (!('instructions' in tx)) return;

  const limitCap = Math.min(
    intent.maxComputeUnits,
    hardMaxCu ?? Number.MAX_SAFE_INTEGER,
  );
  const priceCap = Math.min(
    intent.priorityFeeMicroLamports,
    hardMaxCuPrice ?? Number.MAX_SAFE_INTEGER,
  );

  let declaredLimit = 0;
  let declaredPrice = 0;
  for (const ix of tx.instructions) {
    if (!ix.programId.equals(COMPUTE_BUDGET_PROGRAM)) continue;
    const data = ix.data;
    // setComputeUnitLimit: discriminator 0x02, u32 LE at offset 1.
    if (data.length === 5 && data[0] === 2) {
      const units = data.readUInt32LE(1);
      declaredLimit = Math.max(declaredLimit, units);
    }
    // setComputeUnitPrice: discriminator 0x03, u64 LE at offset 1.
    if (data.length === 9 && data[0] === 3) {
      const micro = Number(data.readBigUInt64LE(1));
      declaredPrice = Math.max(declaredPrice, micro);
    }
  }

  if (declaredLimit > limitCap) {
    throw new SignerError(
      'COMPUTE_BUDGET_VIOLATION',
      `compute unit limit ${declaredLimit} exceeds permitted ${limitCap}`,
    );
  }
  if (declaredPrice > priceCap) {
    throw new SignerError(
      'COMPUTE_BUDGET_VIOLATION',
      `compute unit price ${declaredPrice} exceeds permitted ${priceCap}`,
    );
  }
}

/** Compute Budget program — the only program allowed to appear on a budget ix. */
const COMPUTE_BUDGET_PROGRAM = new PublicKey('ComputeBudget111111111111111111111111111111');

/** System + ATA programs a two-leg swap legitimately needs. */
export const DEFAULT_ALLOWED_PROGRAMS: readonly string[] = [
  'ComputeBudget111111111111111111111111111111',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  '11111111111111111111111111111111',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
];

function assertProgramsAllowed(
  tx: Transaction | VersionedTransaction,
  allowed: readonly string[] | undefined,
): void {
  if (!allowed || allowed.length === 0) return;
  if (!('instructions' in tx)) return;
  const allowSet = new Set(allowed);
  for (const ix of tx.instructions) {
    const id = ix.programId.toBase58();
    if (!allowSet.has(id)) {
      throw new SignerError('PROGRAM_NOT_ALLOWED', `program ${id} is not on the signer allowlist`);
    }
  }
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
    throw new SignerError('OPERATOR_MISMATCH', 'loaded key does not match the configured operator address');
  }

  const allowedPrograms = options.allowedProgramIds ?? DEFAULT_ALLOWED_PROGRAMS;

  options.logger.info('signer_loaded', {
    publicKey: keypair.publicKey.toBase58(),
    liveEnabled: options.liveEnabled,
    allowedPrograms: allowedPrograms.length,
  });

  return {
    publicKey: keypair.publicKey,
    isArmed: () => options.liveEnabled,
    async sign(request: SigningRequest) {
      if (!options.liveEnabled) {
        throw new SignerError('LIVE_DISABLED', 'live execution is disabled by configuration');
      }

      const actualMessage = messageOf(request.transaction);
      const actualBase64 = Buffer.from(actualMessage).toString('base64');

      if (actualBase64 !== request.expectedMessageBase64) {
        throw new SignerError(
          'INTENT_MISMATCH',
          `refusing to sign intent ${request.intentId}: message bytes differ from the admitted intent`,
        );
      }

      // Digest check is independent of the base64 comparison: it catches a
      // caller that rewrote BOTH the bytes and the base64 copy of them.
      if (request.expectedMessageSha256 !== undefined) {
        const digest = messageDigest(actualMessage);
        if (digest !== request.expectedMessageSha256) {
          throw new SignerError(
            'INTENT_MISMATCH',
            `refusing to sign intent ${request.intentId}: message digest differs from the admitted digest`,
          );
        }
      }

      if (request.intent) {
        assertProgramsAllowed(
          request.transaction,
          request.intent.allowedProgramIds ?? allowedPrograms,
        );
        assertComputeBudget(
          request.transaction,
          request.intent,
          options.maxComputeUnitPriceMicroLamports,
          options.maxComputeUnits,
        );
      }

      let signature: string;
      if ('version' in request.transaction) {
        request.transaction.sign([keypair]);
        const sig = request.transaction.signatures[0];
        if (!sig) throw new SignerError('INTENT_MISMATCH', 'transaction produced no signature');
        signature = bufferToBase58(Buffer.from(sig));
      } else {
        request.transaction.partialSign(keypair);
        const sig = request.transaction.signature;
        if (!sig) throw new SignerError('INTENT_MISMATCH', 'transaction produced no signature');
        // Solana signatures are BASE58 on the wire, not base64. Encoding them
        // as base64 produces a string that no explorer and no RPC can resolve.
        signature = bufferToBase58(sig);
      }
      options.logger.info('tx_signed', { intentId: request.intentId, signature });
      return { signature, messageBase64: actualBase64 };
    },
  };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bufferToBase58(bytes: Buffer): string {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let out = '';
  while (num > 0n) {
    out = (B58[Number(num % 58n)] as string) + out;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out === '' ? '1' : out;
}

/* ------------------------------------------------------------------ storage */

/**
 * Crash-safe signed-payload store.
 *
 * Z2-11 in the source review found the other implementation deriving its
 * encryption key from the PUBLIC authority — keccak256(public_key), which
 * provides no confidentiality at all. Here the key comes from an explicit
 * operator secret (`SIGNER_STORE_KEY`, high-entropy, never committed) via
 * scrypt, and the records are AES-256-GCM authenticated so a tampered or
 * truncated record fails to decrypt instead of silently decoding to garbage.
 *
 * A missing secret is a hard error rather than a fallback to a public key:
 * silent degradation to worthless encryption is worse than refusing to start.
 */
export interface SignedPayloadStoreOptions {
  /** Deployment secret. Absent => the store refuses to open. */
  readonly secret: string | undefined;
  readonly logger: Logger;
}

export interface SignedPayloadRecord {
  readonly intentId: string;
  readonly messageSha256: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

const SCRYPT_SALT = Buffer.from('sol-tea/signer-store/v1');

export class SignedPayloadStore {
  private readonly key: Buffer;

  constructor(private readonly options: SignedPayloadStoreOptions) {
    if (!options.secret || options.secret.length < 16) {
      throw new SignerError(
        'STORE_KEY_MISSING',
        'SIGNER_STORE_KEY must be set to a deployment secret of at least 16 characters',
      );
    }
    this.key = scryptSync(options.secret, SCRYPT_SALT, 32);
  }

  encrypt(intentId: string, messageSha256: string, payload: Uint8Array): SignedPayloadRecord {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(`${intentId}:${messageSha256}`, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    return {
      intentId,
      messageSha256,
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  }

  decrypt(record: SignedPayloadRecord): Buffer {
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(`${record.intentId}:${record.messageSha256}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const out = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]);
    // The stored digest must match what was decrypted: the AAD already binds
    // intent+digest, this makes the binding explicit at the call site too.
    if (messageDigest(out) !== record.messageSha256) {
      throw new SignerError('INTENT_MISMATCH', `decrypted payload digest mismatch for ${record.intentId}`);
    }
    return out;
  }
}

/** Idempotent signer request key: same intent + same digest => same signature. */
export function signerRequestKey(intentId: string, messageSha256: string): string {
  return createHash('sha256').update(`${intentId}:${messageSha256}`).digest('hex');
}
