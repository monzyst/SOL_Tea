# Architecture

Why the code is shaped the way it is, and which invariants must not be broken.

---

## 1. Module boundaries

Dependencies point in one direction only:

```
apps  →  chains  →  packages
                       ├── strategies → market → domain
                       ├── policy     → config → domain
                       ├── executor   → signer, journal, quoter
                       └── reconcile  → journal
```

| Rule | Reason |
|---|---|
| `domain` imports nothing | Value types usable anywhere without cycles |
| `whirlpool.decode` is pure | Account bytes in, snapshot out — testable without a chain |
| Only `quoter` produces executable prices | One place to audit pricing correctness |
| Only `signer` touches key material | Minimal blast radius for custody |
| Only `journal` writes the outbox | Single writer, single sequence, hash chain holds |
| `executor` never retries | Retry is a policy decision; blind re-signing double-executes |

---

## 2. Invariants

**I-1 — Integer money only.** All amounts are `bigint` base units. Costs round up
(`mulDivCeil`), proceeds round down (`mulDivFloor`). No `number` holds a balance.

**I-2 — An asset is an identity, not a symbol.** `(chain, mint, tokenProgram,
decimals)`. Two things called "USDC" on different chains are never equal.

**I-3 — A route needs two distinct pools.** `routeKey()` throws when
`poolBuy === poolSell`. A venue name is not a route.

**I-4 — Stale state is never executable.** `readiness()` gates on age, coherence
and slot skew, and returns a `ReasonCode` — never a bare boolean.

**I-5 — Journal before sign.** Order is `ADMITTED → SIGNED → SUBMITTED`. The
`SIGNED` record hits disk before broadcast, so a crash leaves something to
reconcile instead of an untraceable spend.

**I-6 — Sign only what was admitted.** The signer compares the transaction's
message bytes against the fingerprint the executor journaled. A mismatch is
`INTENT_MISMATCH` and it refuses to sign.

**I-7 — Reserving does not spend.** `spentRaw` moves only on `settle()`. An
expired reservation returns headroom untouched, so a failed build cannot consume
budget.

**I-8 — Unknown is not failed.** Blockhash expiry yields `UNKNOWN`. Treating it
as failure is how a transaction that later lands gets double-executed.

**I-9 — Only proven receipts are booked.** `UNPROVEN` when a receipt lacks
balance data. Unproven routes are blocked, never credited.

---

## 3. Real-time transport

**Two signals, not one.** A slot heartbeat proves the socket is alive; pool
account updates prove the *market* is alive. A subscription can be perfectly
connected while its pool has gone quiet, and conflating those states is how a
dead feed looks healthy.

**Gap taxonomy.** `SLOT_GAP` (jump beyond `maxSlotGap`), `STALL` (no event within
the watchdog window), `RESUBSCRIBE` (every reconnect). Any gap invalidates cached
state: bytes received before a gap cannot be proven contiguous with bytes
received after it.

**Backoff.** Exponential with jitter, capped at `reconnectMaxMs`. Jitter is not
cosmetic — without it a fleet resubscribes in lockstep and re-creates the outage
that caused the reconnect.

**Why no `memcmp` filter.** `onProgramAccountChange` memcmp filters match against
**account data**, not the account key. An offset-0 filter on a pool address can
never match, and silently yields zero updates. The program filter is the only
server-side narrowing; `handleAccountUpdate` drops non-registered accounts.

---

## 4. Pricing

The pool account gives `sqrtPriceX64` and `liquidity` — enough to rank
candidates, not enough to execute. A Whirlpool is concentrated liquidity: a
correct quote must walk real tick arrays under the pool's fee and protocol-fee
rules.

- **Discovery** uses constant-product math over vault reserves. Fast, and
  explicitly an approximation — ranking only.
- **Execution** uses `swapQuoteByInputToken`, which returns
  `otherAmountThreshold` (the on-chain minimum) and the tick arrays needed.

Mixing the two is the dangerous case: a fresh tick-array set against an older
threshold executes at a price nobody approved. `buildSwapInstruction` re-quotes
at the same parameters to obtain arrays and always enforces the original
`minimumAmountOut`.

**Reserves are separate.** The pool account stores vault *addresses*, not
balances. `vaults.readVaultReserves` batches both token accounts into one
`getMultipleAccountsInfoAndContext` call.

---

## 5. Fee accounting

Worst-case fee reserved before signing:

```
base      = 5_000 lamports × signatureCount
priority  = computeUnits × microLamports / 1_000_000
worst     = base + priority
```

Reserving the worst case and settling the actual fee can only return headroom,
never overdraw. The period cap counts `spent + outstanding + requested`, so
concurrent attempts cannot jointly exceed it.

**Period start is stamped once.** A deposit or restart never re-opens a spent
budget — that would let a bad day reset itself by restarting the process.

---

## 6. Failure modes

| Failure | Detection | Response |
|---|---|---|
| RPC endpoint down | 2 consecutive failures | Provider marked degraded, failover |
| Both providers down | `AllProvidersFailedError` | Attempt aborted, `QUOTES_UNAVAILABLE` |
| Socket silent | Watchdog > stall window | `STALL` gap, invalidate, reconnect |
| Pool bytes undecodable | Size/owner/mint check | Invalidated until next good update |
| Pool mints changed | `MINT_MISMATCH` | Route unusable; registry re-qualification |
| Fee tier drifted | Decoded ≠ registry | `FEE_TIER_DRIFT`, pool `DEGRADED` |
| Transaction reverted | On-chain error | `REVERTED`, fee booked, route penalised |
| Outcome unknown | Blockhash expired | `UNKNOWN`, reconciliation required |
| Journal tampered | Hash chain mismatch | Process refuses to start |
| Key file weak perms | Mode check | `KEYPAIR_INSECURE_PERMISSIONS`, refuse to load |
| Build exception | try/catch before submit | `NOT_SENT` — provably never broadcast |

---

## 7. Extending to durable storage

`ReservationLedger` and `SignedOutbox` are the reference implementations. For
multi-host operation the same contracts move to Postgres:

```sql
CREATE TABLE fee_reservation (
  reservation_id   text PRIMARY KEY,
  intent_id        text NOT NULL,
  route_key        text NOT NULL,
  worst_case_raw   numeric(38,0) NOT NULL,
  actual_raw       numeric(38,0),
  state            text NOT NULL CHECK (state IN ('RESERVED','SETTLED','EXPIRED')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);

CREATE TABLE signed_outbox (
  seq          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  intent_id    text NOT NULL,
  route_key    text NOT NULL,
  state        text NOT NULL,
  signature    text,
  payload      jsonb NOT NULL,
  prev_hash    text NOT NULL,
  hash         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

Semantics to preserve: reserve-then-settle (never settle twice), and verify the
hash chain on read — a ledger nobody verifies is a ledger nobody can trust.

---

## 8. Hot path

Per pool update, in order:

1. map lookup for the binding (O(1))
2. decode — fixed offsets, no allocation beyond two base58 encodes
3. newest-slot check (drop out-of-order updates)
4. one batched vault read (2 accounts, 1 round trip)
5. readiness check — integer comparisons only
6. ranking at most two directions per pair

The SDK quote is deliberately **after** all cheap gates, so a stale or
economically hopeless market never pays for a tick-array walk. An in-flight guard
plus a 250 ms floor rate-limit the expensive path: feed updates arrive far faster
than any attempt could be built.
