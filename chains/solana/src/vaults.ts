/**
 * chains/solana/src/vaults — pool reserves.
 *
 * A Whirlpool account stores its price, liquidity and *vault addresses*, but not
 * the token balances. Reserves therefore have to be read from the two SPL token
 * accounts the pool owns. This matters because a price alone cannot size a
 * trade: without reserves there is no notion of depth, and every cycle would be
 * sized against nothing.
 *
 * Both balances are fetched in ONE `getMultipleAccounts` call. On a busy pool
 * that is the difference between one round trip per update and two.
 */

import { PublicKey, type Connection } from '@solana/web3.js';

export interface VaultReserves {
  readonly reserveA: bigint;
  readonly reserveB: bigint;
  readonly slot: number;
}

export class ReserveReadError extends Error {
  constructor(
    readonly poolAddress: string,
    message: string,
  ) {
    super(`cannot read reserves for ${poolAddress}: ${message}`);
    this.name = 'ReserveReadError';
  }
}

/** Read SPL token account balances for a pair of vaults. */
export async function readVaultReserves(input: {
  connection: Connection;
  poolAddress: string;
  vaultA: string;
  vaultB: string;
  commitment?: 'confirmed' | 'finalized';
}): Promise<VaultReserves> {
  const commitment = input.commitment ?? 'confirmed';

  const response = await input.connection.getMultipleAccountsInfoAndContext(
    [new PublicKey(input.vaultA), new PublicKey(input.vaultB)],
    commitment,
  );

  const [accountA, accountB] = response.value;
  if (!accountA) throw new ReserveReadError(input.poolAddress, 'vault A does not exist');
  if (!accountB) throw new ReserveReadError(input.poolAddress, 'vault B does not exist');

  // SPL token account layout: mint(32) owner(32) amount(u64 LE at offset 64).
  if (accountA.data.length < 72 || accountB.data.length < 72) {
    throw new ReserveReadError(input.poolAddress, 'vault account is not an SPL token account');
  }

  return {
    reserveA: accountA.data.readBigUInt64LE(64),
    reserveB: accountB.data.readBigUInt64LE(64),
    slot: response.context.slot,
  };
}
