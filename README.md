# SOL_Tea

A real-time Solana trading engine: event-driven pool intake, exact Whirlpool
quoting, policy-gated execution, and receipt reconciliation.

> **Status: observe-only by default.** The engine boots, subscribes to live
> mainnet pool accounts, decodes and prices them, and runs the full decision
> funnel — but it will not sign or submit a transaction until every owner binding
> in `config/policy.solana.yaml` is resolved **and** `chain.enabled` is `true`.
> That is intentional, not unfinished wiring.

---

## What the code does

SOL_Tea watches two **distinct** WSOL/USDC liquidity pools and looks for a
*spatial* arbitrage: buy the base asset on one pool and sell it back on the
other, closing an asset cycle in a single atomic transaction.

The economic definition matters. Borrowing is liquidity, not profit. A one-way
swap is not a candidate. A candidate exists only when two different pools form a
closed cycle whose output exceeds its input **after** pool fees, priority fee and
base fee.

Three properties drive the architecture:

1. **"No data" is never reported as "no opportunity."** A feed that goes quiet, a
   socket that gaps, or a pool whose bytes fail to decode all produce an explicit
   reason code. The funnel in `/healthz` always answers *why* nothing traded.
2. **The signed artifact is journaled before it is signed.** A crash between sign
   and submit leaves a recoverable record rather than an untraceable spend.
3. **Only proven receipts are booked.** A transaction whose outcome cannot be
   verified is `UNPROVEN` and blocks new signing for that route — it is never
   optimistically counted as profit.

---

## Architecture

```
                    ┌─────────────────────────────┐
   Solana mainnet   │  RPC (HTTP)   ·   WS (wss)   │
                    └───────────┬─────────────────┘
                                │  program subscriptions
                    ┌───────────▼──────────────┐
                    │ packages/rpc              │
                    │  ProviderPool  (failover) │
                    │  SubscriptionManager      │
                    │   · slot heartbeat        │
                    │   · gap detection         │
                    │   · backoff + jitter      │
                    └───────────┬──────────────┘
                                │  raw account bytes
                    ┌───────────▼──────────────┐
                    │ chains/solana             │
                    │  whirlpool.decode  (pure) │
                    │  vaults.readReserves      │
                    └───────────┬──────────────┘
                                │  PoolSnapshot
                    ┌───────────▼──────────────┐
                    │ packages/market           │
                    │  coherent state store     │
                    │  freshness + skew gates   │
                    └───────────┬──────────────┘
                                │  coherent pair
                    ┌───────────▼──────────────┐
                    │ packages/strategies       │
                    │  discoverPair / rank      │
                    └───────────┬──────────────┘
                                │  CycleCandidate
                    ┌───────────▼──────────────┐
                    │ packages/policy           │
                    │  admitOpportunity         │
                    │  ReservationLedger        │
                    └───────────┬──────────────┘
                                │  admitted intent
                    ┌───────────▼──────────────┐
                    │ chains/solana/quoter      │  ← authoritative price
                    │  swapQuoteByInputToken    │    (tick-array walk)
                    └───────────┬──────────────┘
                                │  ExecutableQuote × 2
                    ┌───────────▼──────────────┐
                    │ packages/journal          │  ADMITTED → SIGNED
                    │ packages/signer           │  intent firewall
                    │ packages/executor         │  build · submit · await
                    └───────────┬──────────────┘
                                │  signature
                    ┌───────────▼──────────────┐
                    │ packages/reconcile        │  pre/post balances
                    └──────────────────────────┘
```

### Module layout

| Path | Responsibility |
|---|---|
| `apps/solana-worker/src/main.ts` | Process wiring, startup ordering, graceful shutdown |
| `apps/solana-worker/src/pipeline.ts` | Intake path: decode → gate → rank (sync, allocation-light) |
| `apps/solana-worker/src/health.ts` | `/healthz` readiness, pause-file control |
| `packages/domain` | `AssetId`, integer `Amount`, route identity, reason codes |
| `packages/config` | zod-validated env + YAML chain/policy contracts, `.env` loader |
| `packages/registry` | Qualified pool bindings with freshness windows |
| `packages/obs` | JSON logger, redaction, latency histogram, funnel, metrics |
| `packages/rpc` | Provider pool with measured health; WebSocket manager |
| `packages/market` | Coherent pool state; freshness/skew/coherence gates |
| `packages/strategies` | Two-pool cycle discovery and ranking |
| `packages/policy` | Admission decisions; fee reservation ledger |
| `packages/journal` | Hash-chained append-only signed outbox |
| `packages/signer` | Key custody + intent firewall |
| `packages/executor` | Transaction assembly, submission, outcome capture |
| `packages/reconcile` | On-chain receipt → realised P&L |
| `chains/solana/src/whirlpool.ts` | Whirlpool account decoder (pure, no I/O) |
| `chains/solana/src/vaults.ts` | Batched vault reserve reads |
| `chains/solana/src/quoter.ts` | Official SDK quoting + swap instruction builder |
| `config/` | `mainnet.solana.yaml`, `policy.solana.yaml` (placeholders only) |
| `tests/unit/` | Deterministic invariants — no network, no chain |

---

## Real-time data and execution flow

**Intake.** `SubscriptionManager` opens a `wss` connection and registers
`onProgramAccountChange` for the Whirlpool program plus `onSlotChange` as a
liveness heartbeat. Updates for any account that is not a registered pool are
dropped, so the subscription cannot silently widen.

**Coherence.** Each update is decoded by a pure function that validates account
size, program owner and both mints against the registry. An undecodable pool is
*invalidated*, not guessed at. Reserves are then read from the two vault token
accounts in one batched call — a Whirlpool stores price and liquidity but not
balances, so without this step there is no depth to size against.

**Gating.** `MarketStateStore.readiness()` refuses a pair unless both legs are
fresh (within `maxQuoteAgeMs`), coherent, and within `maxSkewSlots` of each
other. Each refusal names a reason code.

**Decision.** The strategy ranks both directions of every eligible pair, then the
policy layer runs safety gates before economics: pause → live-enabled →
unresolved bindings → route quarantine → concurrency → size bounds → net edge →
fee cap. The first true blocker becomes the reason code.

**Execution.** Reserved fee → journal `ADMITTED` with the exact message bytes →
signer verifies those bytes are unchanged → journal `SIGNED` → submit → await
inclusion or blockhash expiry. Outcomes are `INCLUDED`, `REVERTED` (fee spent,
no fill), `UNKNOWN` (must be reconciled) or `NOT_SENT` (provably never left).

**Reconciliation.** Pre/post token balances for the operator's own accounts give
the realised delta. Verdicts are `PROVEN_NET_POSITIVE`,
`PROVEN_NET_NON_POSITIVE` or `UNPROVEN`. Unresolved intents from a previous
process are reconciled at boot before new signing is allowed.

---

## Setup

Requires Node **20.11+**.

```bash
git clone <this-repo> && cd SOL_Tea
npm install
cp .env.example .env      # then edit .env (git-ignored)
npm run check:config      # validates config/ and lists outstanding bindings
npm run build
npm test
```

### Run

```bash
npm run dev      # tsx watch, observe-only
npm start        # compiled build
```

Health and funnel state:

```bash
curl -s localhost:8787/healthz | jq
curl -s localhost:8787/journal | jq
```

Expected observe-only output: `stream: live`, both pools `COHERENT` with a fresh
`slot` and `ageMs`, and a funnel that accumulates `FEED_*` reasons while no
opportunity clears the economic floor.

### Enabling live execution

Do these in order — the engine will refuse out of sequence:

1. Resolve every `REQUIRED_OWNER_BINDING` in `config/policy.solana.yaml`
   (capital bounds, economic floors, fee caps, concurrency, period start).
2. Put a keypair **outside the repository**, `chmod 600`, and set
   `WALLET_KEYPAIR_PATH` plus `OPERATOR_PUBLIC_ADDRESS`.
3. Set `ENABLE_LIVE_EXECUTION=true`.
4. Set `chain.enabled: true` in `config/mainnet.solana.yaml`.

Pause instantly without a restart:

```bash
touch var/PAUSE     # blocks NEW signing; in-flight work still reconciles
rm var/PAUSE        # resume
```

---

## Configuration variables

| Variable | Default | Meaning |
|---|---|---|
| `RPC_HTTP_URL` | — | HTTPS RPC endpoint (required) |
| `RPC_WS_URL` | — | WebSocket endpoint (required) |
| `RPC_HTTP_URL_SECONDARY` | empty | Independent backup provider |
| `RPC_WS_URL_SECONDARY` | empty | Must be set together with the HTTP sibling |
| `WALLET_KEYPAIR_PATH` | empty | Absolute path outside the repo; empty = observe-only |
| `OPERATOR_PUBLIC_ADDRESS` | empty | Preflight assertion against the loaded key |
| `SOL_TEA_CHAIN_CONFIG` | `config/mainnet.solana.yaml` | Chain binding file |
| `SOL_TEA_POLICY_CONFIG` | `config/policy.solana.yaml` | Financial policy file |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `LOG_PRETTY` | `false` | Human-readable local logs |
| `HEALTH_PORT` | `8787` | Loopback health endpoint |
| `JOURNAL_DIR` | `var/journal` | Signed outbox location |
| `ENABLE_LIVE_EXECUTION` | `false` | Master signing switch |
| `EMERGENCY_PAUSE` | `false` | One-shot pause without touching files |

`REQUIRED_OWNER_BINDING` in the YAML files is a hard placeholder. It is not a
default and never resolves itself: the validator rejects the file until an owner
replaces it. Real environment variables always take precedence over `.env`.

---

## Secrets

No credential is ever committed. `.gitignore` excludes `.env*` (except
`.env.example`), `secrets/`, `*.key`, `*.pem`, `id.json`, `*keypair*.json`,
`wallet*.json`, journals and build output.

The signer additionally refuses to load a keypair whose path starts inside the
repository, or whose file mode is group/world readable. The logger redacts
base58 secret-key blobs, bearer tokens and `user:pass@` URLs before serialisation.

---

## Known limitations and outstanding items

**Blocking a live launch**

1. **Owner policy bindings are unresolved.** Ten bounds in
   `config/policy.solana.yaml` are `REQUIRED_OWNER_BINDING`. Capital limits,
   economic floors and fee caps are owner decisions; shipping them pre-filled
   would be a fund-loss risk.
2. **No independent RPC provider.** The engine runs on a public endpoint. A
   dedicated provider is required for production — public endpoints rate limit
   and are not an acceptable Phase-1 supplier.
3. **Priority fee is a static constant.** `priorityFeeMicroLamports: 1000` is
   untuned. Mainnet inclusion needs an adaptive estimate from recent fees.
4. **Second pool may be quiet.** `7qbRF6…` is a genuine WSOL/USDC Whirlpool but
   trades less than `Czfq3x…`, so a pair-level `FEED_STALE` is a normal result.
   The gate behaving this way is correct; the fix is picking two comparably
   active pools, which is a registry decision.

**Scope not yet built**

5. **No flash-loan composition.** `lender.kind` is `JUPITER_LEND` but
   `enabled: false`: the atomic borrow → swap → swap → repay path has not been
   proven against a live program. Without it the engine trades only its own
   capital. Two-leg cycles are wired; the borrow wrapper is not.
6. **Dry-run decision path.** `main.ts` records admitted candidates but does not
   yet call the quoter/executor inline. Both are implemented, wired and unit
   covered — the call site is deliberately left gated behind the PRE-LIVE
   sign-off.
7. **Single venue family.** Only Orca Whirlpool is adapted. Raydium CLMM and
   Meteora would widen the route space considerably.
8. **In-memory reservation ledger.** `ReservationLedger` is correct but not
   durable; the SQL outbox in `docs/ARCHITECTURE.md` replaces the store without
   changing semantics.
9. **No alerting transport.** `alertTargetRef` is bound to a placeholder, so
   pause/unknown-outcome events are logged but not pushed anywhere.

---

## Documentation

- `docs/ARCHITECTURE.md` — module contracts, invariants, failure modes
- `docs/RUNBOOK.md` — operating procedures and incident response
- `docs/SOURCE_REGISTER.md` — verified addresses and their provenance
