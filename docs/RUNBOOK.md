# Runbook

Operating procedures for the Solana worker. Written for the person on call at
03:00 who did not write the code.

---

## 1. Start and verify

```bash
npm run check:config          # must exit 0
npm run build
npm start                     # or: npm run dev
```

Confirm the engine is actually watching the market — "process running" is not
the same thing:

```bash
curl -s localhost:8787/healthz | jq '{
  status, stream, feedHealthy, unresolvedIntents,
  pools: [.pools[] | {pool: .pool[0:8], slot, coherence, ageMs}]
}'
```

Expected observe-only state:

| Field | Healthy value |
|---|---|
| `stream` | `live` |
| `feedHealthy` | `true` |
| `pools[].coherence` | `COHERENT` |
| `pools[].ageMs` | well under `maxQuoteAgeMs` (2000) |
| `pools[].slot` | advancing between checks |

If `feedHealthy` is `false` while `stream` is `live`, the socket is up but the
market data is not — read section 3.

---

## 2. Reading the funnel

`funnel.reasons` answers "why did nothing trade?". It is cumulative, so compare
two reads a minute apart to see the current mix.

| Reason | Meaning | Action |
|---|---|---|
| `FEED_STALE` | A pool exceeded `maxQuoteAgeMs` | Normal on a quiet pool; see §3 if persistent |
| `FEED_GAP` | Socket gap or slot skew | Self-healing; escalate if it repeats for minutes |
| `NO_EDGE_AFTER_FEES` | Cycle exists but is not profitable | **Normal** — the engine working as designed |
| `SIZE_BELOW_MINIMUM` | Principal outside policy bounds | Check policy vs. available capital |
| `POLICY_OR_CODE_DRIFT` | Unresolved bindings, or pool flags drifted | Run `npm run check:config` |
| `FEE_LIMIT_REACHED` | Worst-case fee exceeds the cap | Raise cap or lower priority fee |
| `MAX_CONCURRENT_PENDING` | Attempt already in flight | Normal under fast markets |
| `PAUSED` | Pause file or `EMERGENCY_PAUSE` | Check §4 |
| `QUOTES_UNAVAILABLE` | Provider failed during quoting | Check `providers` array |
| `COOLDOWN_AFTER_FAILURE` | Route quarantined after failures | Investigate before clearing |

**A healthy engine spends most of its time in `NO_EDGE_AFTER_FEES`.** Two pools
priced within a few basis points of each other, minus two fee tiers and priority
fee, usually leave nothing. Zero trades is the correct output of a well-behaved
engine in a calm market — not a bug.

---

## 3. Feed is stale

```bash
curl -s localhost:8787/healthz | jq '.pools, .providers'
```

1. **One pool stale, the other fresh** — usually genuine: the secondary pool
   (`7qbRF6…`) trades far less than the primary. Confirm by polling its account:
   if its slot only advances when someone trades, the gate is right.
2. **Both stale, `stream: live`** — slot heartbeats arrive but no account
   changes; the watchdog fires `STALL` then reconnects. Watch for
   `ws_stream_stalled` followed by `ws_status`.
3. **`stream: degraded`** — reconnect in flight. Check
   `ws_reconnect_scheduled` for the attempt count; backoff caps at
   `reconnectMaxMs` (30s).
4. **Providers degraded** — `providers[].healthy: false`. Failover is automatic.
   With both down the engine stops quoting rather than trading blind.

---

## 4. Pause and resume

Pause stops **new** signing. In-flight transactions still reconcile — deliberately,
because abandoning an in-flight transaction is how state diverges.

```bash
touch var/PAUSE      # pause
rm var/PAUSE         # resume
```

For a hard stop that survives file edits, set `EMERGENCY_PAUSE=true` and restart.
The env var wins over the file and cannot be cleared by accident.

Confirm: `funnel.reasons.PAUSED` should be increasing.

---

## 5. Unresolved intents

Any intent left `SIGNED`/`SUBMITTED` means a transaction may be on chain.

```bash
curl -s localhost:8787/journal | jq '.unresolved'
```

**Do not clear these manually.** The journal is hash-chained; editing it makes
the process refuse to start (by design). Resolution paths:

1. Restart with a configured signer — boot auto-reconciles.
2. If a signature is present, check it directly:
   `getSignatureStatuses([sig])` — landed? failed? genuinely absent?
3. Delete `var/journal/` **only** after confirming every unreconciled signature
   is absent on chain *and* blockhash-expired. Losing this file loses the audit
   trail for real fees.

---

## 6. Emergency procedures

**Suspected double-execution.** Set `EMERGENCY_PAUSE=true`, restart, export the
journal, and compare signatures per `intentId`. Never reuse an `intentId`.

**Unexpected fee drawdown.** Check `feeBudget.spentRaw` against `capRaw`, then
the journal for `SETTLED` records. A reservation that never settled is headroom
returned, not money lost.

**Compromised key.** Stop the process. Rotate the keypair, update
`OPERATOR_PUBLIC_ADDRESS`, drain the old account. The engine refuses to load a
key whose address does not match its configuration — that tripwire is a feature.

**Runaway reconnect loop.** If `ws_reconnect_scheduled` attempts keep climbing
within minutes, the endpoint is likely rejecting the connection. Verify the
`wss://` URL independently, then restart with a secondary provider.

---

## 7. Logs

JSON, one object per line, to stdout. Useful filters:

```bash
# one intent's full lifecycle
grep '"intentId":"HOST:boot:1a"' app.log | jq -c '{ts,event,state,payload}'

# everything that went wrong
jq -c 'select(.level=="error" or .level=="warn")' app.log

# transport health over time
jq -c 'select(.event|test("ws_|rpc_provider"))' app.log
```

Secrets are redacted before serialisation — a base58 secret blob or bearer token
will never appear. If one does, that is a bug worth reporting.

---

## 8. Pre-live checklist

Tick every box before setting `chain.enabled: true`:

- [ ] `npm run check:config` reports all bindings resolved
- [ ] `ENABLE_LIVE_EXECUTION=true` and `EMERGENCY_PAUSE=false`
- [ ] Keypair outside the repo, `chmod 600`, address matches configuration
- [ ] Dedicated RPC provider set; secondary configured and distinct
- [ ] Priority fee reviewed against current mainnet conditions
- [ ] `maxConcurrentPending=1` for the first live session
- [ ] Fee caps low enough that a bug is cheap to discover
- [ ] Someone watching `/healthz` and the funnel for the first hour
- [ ] Pause path tested (`touch var/PAUSE`, confirm `PAUSED` increments)
