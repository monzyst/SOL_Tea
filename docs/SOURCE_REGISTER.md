# Source register

Every address and constant the engine depends on, its provenance, and how to
re-verify it. Nothing here is taken on trust from documentation: all pool data
was read from Solana mainnet-beta.

Observed **2026-10-27** during repository construction.

---

## 1. Chain

| Item | Value | Verification |
|---|---|---|
| Cluster | Solana mainnet-beta | — |
| Genesis hash | `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d` | `getGenesisHash` |
| Commitment used | `confirmed` | Fastest commitment still safe to build on |

```bash
curl -s https://api.mainnet-beta.solana.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}'
```

The genesis hash is asserted in `config/mainnet.solana.yaml` and validated against
this constant at load time — pointing the config at devnet fails closed.

---

## 2. Programs

| Program | Address | Notes |
|---|---|---|
| Orca Whirlpool | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | Pool accounts are 653 bytes, 8-byte discriminator |
| SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | ATA derivation, vault balances |
| Jupiter Lend | *unbound* | `lender.enabled: false` — not proven live |

---

## 3. Assets

| Symbol | Mint | Program | Decimals |
|---|---|---|---|
| WSOL | `So11111111111111111111111111111111111111112` | SPL Token | 9 |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SPL Token | 6 |

USDC is the settlement asset; WSOL is the base.

---

## 4. Pools

Both are WSOL/USDC Whirlpools with different fee tiers, which is what makes a
spatial cycle possible at all.

| Field | Pool A (primary) | Pool B (secondary) |
|---|---|---|
| Address | `Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE` | `7qbRF6YsyGuLUVs6Y1q64bdVrfe4ZcUUz1JRdoVNUJnm` |
| Owner | Whirlpool program | Whirlpool program |
| Account size | 653 bytes | 653 bytes |
| mintA | WSOL | WSOL |
| mintB | USDC | USDC |
| tickSpacing | 4 | 8 |
| feeRate | 400 ppm (0.04%) | 500 ppm (0.05%) |
| Liquidity (observed) | ~652.3e12 | ~539.3e9 |
| Implied price (observed) | ~$99.4959 | ~$99.5025 |

Re-verify:

```bash
curl -s https://api.mainnet-beta.solana.com -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo",
       "params":["Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE",{"encoding":"base64"}]}'
```

The engine re-checks mint identity on **every** decode. If a pool's mints ever
change behind an address, that route is rejected (`MINT_MISMATCH`) rather than
traded on a stale assumption.

### Why these two

Pool A carries deep liquidity; Pool B is a genuine but thinner WSOL/USDC pool with
a different fee tier. Their observed spread was roughly 6.6 bps — real, but below
the sum of the two fee tiers, which is why the engine correctly reports
`NO_EDGE_AFTER_FEES` most of the time.

This is also the source of a known limitation: Pool B's lower activity means
pair-level `FEED_STALE` is a normal outcome. Selecting two comparably active pools
is a registry decision, not a code change.

---

## 5. Account layout (Whirlpool v1, 653 bytes)

Derived from live accounts and cross-checked against the published layout.

| Offset | Field | Type | Used for |
|---|---|---|---|
| 0 | discriminator | 8 bytes | sanity |
| 41 | tickSpacing | u16 | drift detection |
| 45 | feeRate | u16 | quote math, drift detection |
| 47 | protocolFeeRate | u16 | recorded |
| 49 | liquidity | u128 | depth |
| 65 | sqrtPrice | u128 | price |
| 81 | tickCurrentIndex | i32 | diagnostics |
| 85 | protocolFeeOwedA | u64 | — |
| 93 | protocolFeeOwedB | u64 | — |
| 101 | mintA | pubkey | identity check |
| 133 | vaultA | pubkey | reserve read |
| 181 | mintB | pubkey | identity check |
| 213 | vaultB | pubkey | reserve read |
| 245 | feeGrowthGlobalB | u128 | — (NOT the tick) |

u128 fields are little-endian `(hi << 64) | lo`. SPL token account balances are a
u64 at offset 64.

**A note on 245.** An earlier revision decoded `tickCurrentIndex` from offset 245,
which is actually `feeGrowthGlobalB`. That produced a plausible-looking but
impossible tick (327527288). The true value sits at 81 and reads -23064, which
matches the tick implied by the decoded `sqrtPrice` (-23063.6).
`tests/unit/whirlpool.test.ts` pins this so it cannot drift again.

**This layout is a validated observation, not a permanent guarantee.** If Orca
ships a new pool version, `decodeWhirlpool` fails closed on size or owner before
it reads a single field.

---

## 6. SDK versions

| Package | Version | Role |
|---|---|---|
| `@orca-so/whirlpools-sdk` | 0.22.0 | Authoritative quoting + swap instruction |
| `@orca-so/common-sdk` | 0.6.x | `Percentage` helper |
| `@solana/web3.js` | 1.99.x | RPC, transactions, subscriptions |
| `@solana/spl-token` | 0.4.x | ATA derivation |
| `@coral-xyz/anchor` | 0.32.1 | Transitive peer of the Whirlpool SDK (not imported directly) |

`WHIRLPOOL_SDK_VERSION` is stamped onto every `ExecutableQuote`, so a quote in a
log can always be traced to the code that produced it.

---

## 7. Re-qualification

Before trusting a registry entry, confirm all of:

1. the account exists and is owned by the Whirlpool program,
2. its size is exactly 653 bytes,
3. mintA/mintB match the registry binding,
4. tickSpacing and feeRate match (mismatch only marks the pool `DEGRADED` — the
   executable quote still comes from the SDK),
5. liquidity is non-zero.

Items 1–3 and 5 are hard rejections. Item 4 is a warning, because a fee change is
a policy question (the route may no longer be profitable), not a safety one.
