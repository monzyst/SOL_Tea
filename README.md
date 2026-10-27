# SOL_Tea

A real-time Solana trading engine: event-driven pool intake, exact Whirlpool
concentrated-liquidity quoting, policy-gated execution, and receipt
reconciliation.

> **Status: observe-only by default.** The engine boots, subscribes to live
> mainnet pool accounts, decodes and prices them, and runs the *entire* decision
> funnel — but it will not sign or submit a transaction until the owner binds the
> policy values **and** `chain.enabled` is `true` **and**
> `ENABLE_LIVE_EXECUTION` is on. Arming is the last gate, deliberately.

---

## What the code does

SOL_Tea watches two **distinct** WSOL/USDC Whirlpool pools and looks for a
*spatial* arbitrage: buy the base asset on one pool and sell it back on the
other, closing an asset cycle in one atomic transaction.

The economic definition matters. Borrowing is liquidity, not profit. A one-way
swap is not a candidate. A candidate exists only when two different pools form a
closed cycle whose output exceeds its input **after** pool fees, priority fee and
base fee.

Four properties drive the architecture:

1. **"No data" is never reported as "no opportunity."** A quiet feed, a gapped
   socket, or an undecodable pool each produce an explicit reason code. The
   funnel in `/healthz` always answers *why* nothing traded.
2. **Observing is not disabling.** In observe mode the full pipeline runs —
   pricing, sizing, fee estimation, admission — and stops at
   `LIVE_EXECUTION_DISARMED`. It does not report `PAUSED`, because no operator
   paused anything and conflating the two hides whether an edge existed.
3. **The signed artifact is journaled before it is signed**, with its full bytes
   and a SHA-256 digest. A crash between sign and submit leaves a recoverable
   record rather than an untraceable spend.
4. **Only proven receipts are booked.** A transaction whose outcome cannot be
   verified is `UNKNOWN` and blocks new signing for that route — it is never
   optimistically counted as profit.

---

## Architecture

```
                    ┌─────────────────────────────┐
   Solana mainnet   │  RPC (HTTP)   ·   WS (wss)   │
                    └──────────────┬──────────────┘
                                   │  program subscriptions + slot heartbeat
                    ┌──────────────▼──────────────┐
                    │ packages/rpc                │
                    │  ProviderPool  (failover)   │
                    │  FailoverConnectionFactory  │  ← WS follows failover
                    │  SubscriptionManager        │
                    │   · slot heartbeat          │
                    │   · gap detection           │
                    │   · backoff + jitter        │
                    │  PriorityFeeEstimator       │  ← adaptive fees
                    └──────────────┬──────────────┘
                                   │  raw account bytes
                    ┌──────────────▼──────────────┐
                    │ chains/solana               │
                    │  whirlpool.decode  (pure)   │
                    │  tickarray.decode  (pure)   │
                    │  clmm              (walks)  │
                    │  vaults / venues            │
                    └──────────────┬──────────────┘
                                   │  PoolSnapshot
                    ┌──────────────▼──────────────┐
                    │ packages/market             │
                    │  coherent state store       │
                    │  slot-lag freshness         │
                    └──────────────┬──────────────┘
                                   │  coherent pair + tick maps
                    ┌──────────────▼──────────────┐
                    │ packages/strategies         │
                    │  arb-clmm: exact CLMM walk  │
                    └──────────────┬──────────────┘
                                   │  CycleCandidate
                    ┌──────────────▼──────────────┐
                    │ packages/policy             │
                    │  admitOpportunity (ordered) │
                    │  ReservationLedger          │
                    └──────────────┬──────────────┘
                                   │  admitted intent
                    ┌──────────────▼──────────────┐
                    │ packages/store              │  ONE transaction:
                    │  intent + reservation +     │  no half-written state
                    │  outbox (SQLite WAL)        │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │ packages/signer             │  economic-limit decode,
                    │  intent firewall, digest    │  digest binding, compute
                    │  encrypted payload store    │  bounds
                    └──────────────┬──────────────┘
                                   │  signature (base58, 64 bytes)
                    ┌──────────────▼──────────────┐
                    │ packages/executor           │  build · submit · await
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │ apps/reconciler             │  independent settlement
                    └─────────────────────────────┘
```

### Module layout

| Path | Responsibility |
|---|---|
| `apps/solana-worker/src/main.ts` | Process wiring, startup ordering, evaluation cadence, graceful shutdown |
| `apps/solana-worker/src/lifecycle.ts` | One evaluation: price → freshness → fee → admission → intent |
| `apps/solana-worker/src/pipeline.ts` | Intake path: decode → gate → rank (sync, allocation-light) |
| `apps/solana-worker/src/health.ts` | `/healthz` readiness, funnel, pause-file control |
| `apps/reconciler/src/main.ts` | Independent settlement loop (separate process) |
| `apps/signer-service/src/main.ts` | Signing role over authenticated HTTP (separate process) |
| `packages/domain` | `AssetId`, integer `Amount`, route identity, reason codes, base58 |
| `packages/config` | zod-validated env + YAML contracts, `.env` loader |
| `packages/registry` | Qualified pool bindings with freshness windows |
| `packages/obs` | JSON logger, redaction, latency histogram, funnel, metrics |
| `packages/rpc` | Provider pool, WS manager, **adaptive priority-fee estimator** |
| `packages/market` | Coherent pool state; slot-lag freshness gates |
| `packages/strategies` | `arb-clmm` exact concentrated-liquidity discovery |
| `packages/policy` | Ordered admission; fee reservation ledger |
| `packages/store` | Durable SQLite state of record (WAL), atomic intent+reservation |
| `packages/journal` | Hash-chained append-only outbox with full signed bytes |
| `packages/signer` | Key custody, economic firewall, encrypted payload store |
| `packages/executor` | Transaction assembly, submission, outcome capture |
| `packages/reconcile` | On-chain receipt → realised P&L |
| `packages/control` | Composite pause (file/env/remote) + alert transports |
| `chains/solana/src/whirlpool.ts` | Whirlpool account decoder (pure, no I/O) |
| `chains/solana/src/tickarray.ts` | TickArray byte layout + decoder (pure) |
| `chains/solana/src/clmm.ts` | Tick math, liquidity map, exact-in swap walk |
| `chains/solana/src/venues.ts` | Tick-array fetching, liquidity snapshots |
| `chains/solana/src/composition.ts` | Flash-funding composition model |
| `chains/solana/src/quoter.ts` | Official SDK quoting + swap instruction builder |
| `config/` | `mainnet.solana.yaml`, `policy.solana.yaml` |
| `tests/unit/` | Deterministic invariants — no network, no chain |

Module boundaries are enforced mechanically by `npm run lint:boundaries`:
`domain` imports nothing, `whirlpool.decode`/`clmm` do no I/O, `@solana/web3.js`
is confined to an allow-list, and configuration is read only through
`packages/config`.

---

## Real-time data and execution flow

**Intake.** `SubscriptionManager` opens a `wss` connection and registers
`onProgramAccountChange` for the Whirlpool program plus `onSlotChange` as a
liveness heartbeat. Updates for accounts that are not registered pools are
dropped, so the subscription cannot silently widen. A gap (slot jump or decoded
account failure) *invalidates* cached state rather than trusting it.

**Reconnects.** The WS connection is built through `FailoverConnectionFactory`,
so a reconnect advances to the next provider in the same rotation `ProviderPool`
uses for HTTP. Exponential backoff with jitter and a stall detector mean a dead
host degrades to a slower path instead of a dead engine.

**Pricing.** Tick arrays around the current tick are fetched
(`PDAUtil.getTickArray`) and decoded into a `LiquidityMap`. The walk crosses every
initialized boundary with the exact Q64.64 math, applying fees per segment. This
is why a wrong tick stride or a wrong boundary rule is a *pricing* bug, not a
cosmetic one.

**Freshness.** A pool is quotable when its state is within `maxSlotLag` slots of
the chain tip — **not** when its account last changed. A quiet pool's account
legitimately stops changing while its price stays exact; judging it by wall-clock
age marks a healthy feed stale forever.

**Fees.** `PriorityFeeEstimator` samples `getRecentPrioritizationFees` for the
watched accounts, takes a configurable percentile (default p75) *of non-zero
samples*, clamps to floor/ceiling, caches with a TTL, and refuses with
`FEE_ESTIMATE_UNAVAILABLE` rather than inventing a number. Fee ceilings are
rounded **up**, and worst-case cost includes rent for token accounts, so a
reservation never under-counts.

**Admission.** Ordered, and the order is the design:
pause → policy completeness → route quarantine → concurrency → size band →
net edge → per-attempt fee cap → **arming**. The first true blocker becomes the
reason code. Arming last is what makes observe mode meaningful.

**Execution.** Reserve worst-case fee → persist intent+reservation+outbox in one
transaction → journal `ADMITTED` with full message bytes → signer decodes the
message and re-verifies economic limits → journal `SIGNED` → submit → await
inclusion or blockhash expiry. Outcomes: `INCLUDED`, `REVERTED` (fee spent, no
fill), `UNKNOWN` (must be reconciled), `NOT_SENT` (provably never left).

**Reconciliation.** Pre/post token balances for the operator's accounts give the
realised delta. Verdicts: `PROVEN_NET_POSITIVE`, `PROVEN_NET_NON_POSITIVE`,
`UNPROVEN`. Unresolved intents from a previous process are reconciled at boot
before new signing is allowed.

---

## Setup

Requires Node **20.11+**.

```bash
git clone https://github.com/monzyst/SOL_Tea.git && cd SOL_Tea
npm ci                    # reproducible install from the committed lockfile
cp .env.example .env      # then edit .env (git-ignored)
npm run check:config      # validates config/ and lists outstanding bindings
npm run build
npm test                  # 74 unit tests
```

### Run

```bash
npm run dev               # tsx watch, observe-only
npm start                 # compiled worker
npm run start:reconciler  # settlement role
npm run start:signer      # signing role (needs SIGNER_SERVICE_TOKEN)
```

Or the whole topology:

```bash
docker compose up --build
```

Health and funnel state:

```bash
curl -s localhost:8787/healthz | jq
```

Expected observe-only output: `stream: live`, both pools `COHERENT` with a fresh
`slot`, `liquidity` showing 5 arrays / hundreds of initialized ticks per pool,
and a funnel accumulating `NO_EDGE_AFTER_FEES` (or `LIVE_EXECUTION_DISARMED` when
an opportunity clears every economic gate). No opportunity trading is correct and
expected.

### Enabling live execution

Do these in order — the engine refuses out of sequence:

1. Review every cap in `config/policy.solana.yaml`. They ship with conservative
   first-live defaults and are **owner-tunable**; each is commented with the
   reasoning behind its value.
2. Put a keypair **outside the repository**, `chmod 600`, and set
   `WALLET_KEYPAIR_PATH` plus `OPERATOR_PUBLIC_ADDRESS`.
3. Set `SIGNER_STORE_KEY` and `SIGNER_SERVICE_TOKEN` (≥16 chars each).
4. Set `ENABLE_LIVE_EXECUTION=true`.
5. Set `chain.enabled: true` in `config/mainnet.solana.yaml`.

`GET /healthz` reports `liveGate.allowed` and, when false, exactly which
conditions are still unmet.

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
| `SIGNER_SERVICE_TOKEN` | empty | Bearer token the signer role requires (≥16 chars) |
| `SIGNER_STORE_KEY` | empty | Derives the signer payload-store encryption key (≥16 chars) |
| `SOL_TEA_CHAIN_CONFIG` | `config/mainnet.solana.yaml` | Chain binding file |
| `SOL_TEA_POLICY_CONFIG` | `config/policy.solana.yaml` | Financial policy file |
| `SERVICE_NAME` | `sol-tea` | Service label in every structured log line |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `LOG_PRETTY` | `false` | Human-readable local logs |
| `HEALTH_PORT` | `8787` | Health endpoint port |
| `JOURNAL_DIR` | `var/journal` | Signed outbox location |
| `STORE_PATH` | `var/state/sol-tea.db` | Durable SQLite state of record |
| `RPC_TIMEOUT_MS` | `15000` | Per-call RPC deadline |
| `ENABLE_LIVE_EXECUTION` | `false` | Master signing switch |
| `EMERGENCY_PAUSE` | `false` | One-shot pause without touching files |
| `ALERT_WEBHOOK_URL` | empty | https webhook for operator alerts |
| `MAX_SKEW_SLOTS` | `25` | Leg-skew budget for quote-level checks |

Real environment variables always take precedence over `.env`. `REQUIRED_OWNER_BINDING`
remains a legal value in the YAML so a fork can deliberately leave a value
unbound — the validator then blocks admission with `POLICY_OR_CODE_DRIFT`
instead of guessing.

---

## Secrets

No credential is ever committed. `.gitignore` excludes `.env*` (except
`.env.example`), `secrets/`, `*.key`, `*.pem`, `id.json`, `*keypair*.json`,
`wallet*.json`, journals, SQLite files and build output. CI enforces this in a
dedicated `secrets` job that fails on a committed `.env`, key material, or a
Solana keypair JSON.

The signer additionally refuses to load a keypair whose path is inside the
repository or whose file mode is group/world readable, refuses to start with a
short service token, and encrypts stored payloads with a key derived from
`SIGNER_STORE_KEY`. The logger redacts base58 secret-key blobs, bearer tokens and
`user:pass@` URLs before serialisation.

---

## Known limitations and outstanding items

**Blocking a live launch**

1. **Flash-funding is not executable.** `chain.funding.kind` is `DISABLED`. The
   composition model (`chains/solana/src/composition.ts`) is complete and the
   guard arithmetic is unit-tested, but the borrow → swap → swap → repay wrapper
   has not been proven against a live lender program, so it refuses to emit a
   transaction. The engine therefore trades only own capital via the direct path.
2. **No dedicated RPC provider.** The default `.env.example` points at the public
   endpoint, which is rate limited and not an acceptable production supplier.
3. **Second pool may be quiet.** `7qbRF6…` is a genuine WSOL/USDC Whirlpool but
   trades far less than `Czfq3x…`. With slot-lag freshness this no longer causes
   spurious staleness; it does still narrow the route space. Picking two
   comparably active pools is a registry decision.
4. **Live submission path is unexercised.** Build, sign, submit, await and
   reconcile are implemented and unit-covered, but no transaction has been sent
   to mainnet. The first live run should be a deliberately tiny clip.

**Scope not yet built**

5. **Single venue family.** Only Orca Whirlpool is adapted. Raydium CLMM and
   Meteora would widen the route space.
6. **Binary route only.** Exactly two pools forming a closed cycle. Three-pool
   cycles are a straightforward extension of `arb-clmm`, not yet written.
7. **Static size.** Each attempt sizes at `minPrincipalRawPerAttempt`. Growth
   toward the optimal clip is an evidence-driven step that requires live fill
   data first.
8. **No backtester.** Pricing is exact enough to reuse, but there is no historical
   replay harness.

---

## Documentation

- `docs/ARCHITECTURE.md` — module contracts, invariants, failure modes
- `docs/RUNBOOK.md` — operating procedures and incident response
- `docs/SOURCE_REGISTER.md` — verified addresses and their provenance
- `implementation/status.yaml` — per-round defect log and current capability state
