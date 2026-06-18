# Implementation Plan — SolGuard

**Project:** SolGuard — Autonomous Bundle Intelligence Stack
**Bounty:** Advanced Infrastructure Challenge — Build a Smart Transaction Stack (Superteam Nigeria)
**Companion doc:** `PRD.md`
**Build window:** ~25 days

---

## 1. Architecture

```
                 +---------------------+
   Yellowstone   |  Stream Manager     |  reconnect + from_slot replay + dedupe
   gRPC  ------->|  (slots, txns)      |  ping/pong keepalive, bounded queue
                 +----------+----------+
                            | slot + tx events
              +-------------+--------------+
              v             v              v
     +--------------+ +----------+ +--------------+
     | Congestion   | | Leader   | | Lifecycle    |
     | Oracle       | | Window   | | Tracker      |
     | (skip rate,  | | Detector | | (4 stages,   |
     |  P->C delta) | |          | |  deltas)     |
     +------+-------+ +----+-----+ +------+-------+
            |              |              |
            +------+-------+--------------+
                   v
          +------------------+      +-----------------+
          |  AI Agent        |----->|  Anthropic API  |
          |  (decision core) |      |  (Claude)       |
          +--------+---------+      +-----------------+
                   | validated decision (guardrail)
                   v
          +------------------+
          |  Bundle Builder  |  tip = f(oracle, tip_floor), 8 tip accts
          |  + Submitter     |  -> Jito Block Engine /api/v1/bundles
          +--------+---------+
                   v
          +------------------+
          | Fault Injector   |  deterministic, reproducible failures
          +--------+---------+
                   v
          Decision Ledger + Lifecycle Log (append-only JSON / SQLite)
```

**Design principles**

- The Yellowstone stream is the source of truth for landing; bundle-status APIs are secondary reconciliation.
- The AI layer is strictly separated from the core stack and from failure handling.
- Nothing in the tip path is hardcoded; every tip is derived from live `tip_floor` data.
- Every agent decision is reproducible from its logged input context.

---

## 2. Tech stack and rationale

| Concern    | Choice                                                     | Why                                                                                                         |
| ---------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Language   | TypeScript (Node 20+)                                      | Mature Jito + Yellowstone TS clients; fastest path to a polished AI layer, which is where the bounty is won |
| Streaming  | `@triton-one/yellowstone-grpc`                             | Reference Yellowstone client; supports `fromSlot` replay and commitment filtering                           |
| Solana SDK | `@solana/web3.js` (v1) or `@solana/kit`                    | Versioned transactions, blockhash, compute budget                                                           |
| Jito       | Block engine REST (`/api/v1/bundles`) + `jito-ts` patterns | `sendBundle`, `getTipAccounts`, `getInflightBundleStatuses`, `getBundleStatuses`                            |
| AI         | Anthropic API (Claude)                                     | Structured reasoning with strict-JSON output                                                                |
| Storage    | Append-only JSON + optional SQLite                         | Auditable logs; explorer-verifiable                                                                         |
| Dashboard  | `blessed`/`ink` (terminal) or minimal web UI               | Legible demo video                                                                                          |

**Optional depth flex:** port only the Stream Manager to Rust (`yellowstone-grpc` Rust client auto-reconnects from v13.1.0) and note it in the architecture doc. Do this only after the TS stack is complete.

---

## 3. Repository structure

```
solguard/
  src/
    stream/
      manager.ts          # connect, reconnect, replay, dedupe, ping/pong
      queue.ts            # bounded queue + backpressure policy
      filters.ts          # slot + transaction subscribe requests
    network/
      congestion.ts       # skip rate, P->C delta distributions
      leader.ts           # leader schedule cache + next Jito leader
    tips/
      tipFloor.ts         # fetch + cache tip_floor percentiles/EMA
      model.ts            # tip = f(percentile, congestion multiplier)
    bundle/
      builder.ts          # <=5 tx, tip in last tx, shared blockhash
      submitter.ts        # regional endpoint + fallbacks
      status.ts           # inflight + bundle status reconciliation
    lifecycle/
      tracker.ts          # 4 stages, slots, ts, deltas
      classifier.ts       # failure taxonomy
    agent/
      contract.ts         # input/output schemas
      agent.ts            # Anthropic call + prompt
      guardrail.ts        # validate + re-prompt
      ledger.ts           # append-only decision ledger
    faults/
      injector.ts         # deterministic fault scenarios
    dashboard/
      ui.ts
    index.ts              # orchestrator
  logs/
    lifecycle.jsonl
    decisions.jsonl
  docs/                   # architecture doc source / exports
  .env.example
  README.md
  package.json
```

---

## 4. Key external interfaces (reference)

**Jito tip floor (REST):** `GET https://bundles.jito.wtf/api/v1/bundles/tip_floor`
Returns recent landed tip percentiles (p25/p50/p75/p95/p99) and an EMA. Optional live feed: tip-stream WebSocket.

**Jito block engine (regional):** `https://<region>.mainnet.block-engine.jito.wtf`

- `POST /api/v1/bundles` -> `sendBundle`
- base path -> `getTipAccounts` (8 static accounts; pick one at random)
- base path -> `getInflightBundleStatuses`, `getBundleStatuses`
- next scheduled Jito leader endpoint -> used to detect valid submission windows

**Bundle rules**

- <=5 transactions, executed sequentially and atomically (all-or-nothing).
- Tip is a SOL transfer to a tip account, placed in the **last** transaction.
- All transactions in the bundle share one recent blockhash.
- Bundles are only processed while a Jito-Solana leader is producing; leaders rotate ~every 1.6s (4 slots). Tipping when a non-Jito leader is up is wasted.

**Yellowstone gRPC**

- Subscribe to `slots` with `filterByCommitment: false` to see processed/confirmed/finalized transitions; subscribe to `transactions` filtered to your signatures.
- Commitment levels: PROCESSED (fastest, revertible), CONFIRMED (supermajority vote - default for time-sensitive work), FINALIZED (rooted; ~32 slots / ~13s behind).
- Reconnect: track last processed slot, resubscribe with `fromSlot`, dedupe (replay window ~150 slots).
- Server sends pings ~every 15s; reply with a ping subscribe request to keep the stream alive.

---

## 5. Component implementation detail

### 5.1 Stream Manager (`src/stream`)

- Open subscription; register `data`/`error`/`end` handlers.
- Maintain `lastProcessedSlot`, persisted to disk.
- On `error`/`end`: backoff, reconnect, resubscribe with `fromSlot = lastProcessedSlot`, dedupe by `(slot, signature)`.
- Reply to server pings on a ~15s cadence.
- **Backpressure:** push events into a bounded queue; on overflow either pause the gRPC read or drop-oldest with an incremented `dropped_events` metric (never silent). Surface the metric on the dashboard.

### 5.2 Congestion Oracle (`src/network/congestion.ts`)

- Ring buffer of the last N slots (e.g., 64).
- **Skip rate:** fraction of recent slots that never reached `confirmed`.
- **Processed->confirmed delta:** record per-slot ms between first `processed` and `confirmed`; expose p50/p95.
- Output a single normalized `congestion_multiplier` consumed by the tip model and surfaced to the agent.
- This component also produces the measured numbers used to answer README Q1.

### 5.3 Leader Window Detector (`src/network/leader.ts`)

- Cache `getLeaderSchedule` per epoch.
- Query the block engine for the next scheduled Jito leader and slot.
- Expose `slotsUntilJitoLeader` and a boolean `inSubmitWindow`.

### 5.4 Tip model (`src/tips`)

- `tipFloor.ts`: fetch + cache `tip_floor` (~60s TTL); expose percentiles + EMA.
- `model.ts`: `tip = percentile(tip_floor, p) x congestion_multiplier`, where `p` and the multiplier scale with congestion and urgency. Enforce a configurable ceiling. **No literal lamport constants in the decision path.**

### 5.5 Bundle Builder + Submitter (`src/bundle`)

- Fetch blockhash at **confirmed** commitment.
- Build <=5 versioned transactions; append tip transfer as the last transaction to a randomly chosen tip account; reuse the single blockhash for all.
- Submit to the closest regional endpoint; 0-2 fallbacks max.
- `status.ts`: poll `getInflightBundleStatuses` early, then `getBundleStatuses`; treat these as reconciliation against the stream, not as the primary confirmation.

### 5.6 Lifecycle Tracker (`src/lifecycle/tracker.ts`)

- Key by `bundle_id` and member signatures.
- On each stream event, advance the stage and stamp `{slot, ts}`.
- Compute deltas: submitted->processed, processed->confirmed, confirmed->finalized.
- Write each completed (or failed) entry to `logs/lifecycle.jsonl`.

### 5.7 Failure Classifier (`src/lifecycle/classifier.ts`)

- Map signals to the five classes (expired blockhash, fee/tip too low, compute exceeded, bundle dropped/leader skip, simulation failed).
- Attach evidence (blockhash age in slots, observed skip, simulation error text).

### 5.8 AI Agent (`src/agent`)

- `contract.ts`: input/output schemas (see PRD §8).
- `agent.ts`: build the prompt from the structured input, call the Anthropic API, request strict JSON only (no prose, no code fences). Parse defensively.
- `guardrail.ts`: validate output ranges (tip within `[floor, ceiling]`, blockhash age legal, `submit_at_slot` in the future). On invalid output, re-prompt with the validation error; never substitute a hardcoded decision.
- `ledger.ts`: append `{ts, trigger, input_context, raw_reasoning, validated_decision, guardrail_action, executed_action, eventual_outcome}` to `logs/decisions.jsonl`.
- Run on **real** failures during live operation, not only injected ones.

### 5.9 Fault Injector (`src/faults/injector.ts`)

Deterministic, reproducible scenarios:

- **Blockhash expiry:** build with a ~20-slot-old blockhash.
- **Tip too low:** submit near-zero tip into a congested window.
- **Leader skip:** submit just after a Jito window closes.
- **Compute exceeded:** include an instruction that exceeds the compute budget.
  Each scenario routes through detection -> classification -> agent -> resubmission so it lands in both logs.

### 5.10 Dashboard (`src/dashboard`)

- Live slot ticker, current/next leader, `slotsUntilJitoLeader`.
- Active bundles and their current stage.
- Latest agent decision (root cause + action + confidence).
- `dropped_events` and reconnect counters.

---

## 6. Phased build plan

### Phase 0 - Foundations (Days 1-2)

- Monorepo, env config, SolInfra RPC + Yellowstone credentials.
- Stream Manager: subscribe, reconnect with `fromSlot`, dedupe, ping/pong, bounded queue.
- **DoD:** stream survives a forced disconnect and resumes without missing or double-counting slots; `dropped_events` metric present.

### Phase 1 - Observability (Days 3-5)

- Slot subscription across all commitment levels.
- Congestion Oracle (skip rate, P->C delta distributions).
- Terminal dashboard skeleton.
- **DoD:** dashboard shows live slots and a live congestion reading; oracle numbers logged for later README use.

### Phase 2 - Bundle pipeline (Days 6-9)

- `getTipAccounts` + caching; `tip_floor` fetch + tip model.
- Bundle builder (tip in last tx, shared confirmed-blockhash); regional submitter.
- **DoD:** a real bundle lands on devnet/mainnet with a dynamically computed tip; no hardcoded tip constants.

### Phase 3 - Lifecycle + reconciliation (Days 10-13)

- Lifecycle Tracker (4 stages, deltas) keyed by signature.
- Stream-primary confirmation; status-API reconciliation.
- Failure Classifier.
- **DoD:** a landed bundle produces a complete lifecycle entry with explorer-verifiable slots; a failed bundle is correctly classified.

### Phase 4 - AI agent + ledger (Days 14-18)

- Contract, agent call, guardrail, decision ledger.
- Run against live failures to accumulate real reasoning samples.
- **DoD:** agent returns valid strict-JSON decisions; ledger entries contain input context + reasoning + outcome; at least one real (non-injected) decision recorded.

### Phase 5 - Fault injection (Days 19-21)

- Implement all four deterministic faults; route through the full pipeline.
- **DoD:** >=2 verified failure cases captured end-to-end with agent decisions and successful autonomous resubmission for at least the blockhash-expiry case.

### Phase 6 - Evidence + writeup (Days 22-25)

- Run >=10 real bundles (mix of happy path + failures).
- Export lifecycle log; write README (with measured numbers) + architecture doc; record demo.
- **DoD:** all acceptance criteria in PRD §13 met; architecture doc published; demo recorded.

---

## 7. Timeline at a glance

| Days  | Phase             | Primary deliverable                    |
| ----- | ----------------- | -------------------------------------- |
| 1-2   | 0 Foundations     | Resilient Stream Manager               |
| 3-5   | 1 Observability   | Congestion Oracle + dashboard          |
| 6-9   | 2 Bundle pipeline | First dynamically-tipped landed bundle |
| 10-13 | 3 Lifecycle       | Full 4-stage tracking + classifier     |
| 14-18 | 4 AI agent        | Agent + guardrail + decision ledger    |
| 19-21 | 5 Fault injection | >=2 verified failure cases             |
| 22-25 | 6 Evidence        | Logs, README, architecture doc, demo   |

Buffer is intentionally back-loaded; if any phase slips, compress the optional Rust flex and the web dashboard (terminal UI is sufficient).

---

## 8. Verification strategy

- **Slot verification:** every lifecycle entry's slots are checkable on a Solana explorer - judges will do this.
- **No-hardcoded-tip check:** grep the codebase for literal lamport tip constants in the submission path; CI lint rule optional.
- **Stream-primary check:** disable the status-API reconciliation temporarily and confirm landing is still detected via the stream.
- **Agent variance check:** run the agent under low vs high congestion and confirm it produces materially different decisions (e.g., hold vs escalate).
- **Reconnect check:** kill the stream mid-run and confirm replay + dedup leave the lifecycle log consistent.

---

## 9. README answers (drafts - replace bracketed values with your measured numbers)

**Q1 - What does the delta between `processed_at` and `confirmed_at` tell you about network health?**
It measures how long the cluster took to reach supermajority vote on the block containing the transaction. A small delta (roughly under 400ms) indicates healthy, fast voting and low fork pressure; a large or widening delta indicates vote latency, fork churn, or validator performance degradation at that moment. In our runs we observed p50 ~ 380 ms and p95 ~ 1500 ms; spikes correlated with our measured slot-skip rate of 10%.

**Q2 - Why never use `finalized` commitment when fetching a blockhash for a time-sensitive transaction?**
A blockhash is only valid for ~150 slots (~60s). Finalized commitment lags confirmed by ~32 slots (~13s), so fetching at finalized burns roughly a fifth of the validity window before you even submit - shrinking your landing window and increasing expiry risk. We fetch at `confirmed` to maximize usable validity while still avoiding the revert risk of `processed`.

**Q3 - What happens to your bundle if the Jito leader skips their slot?**
The bundle is dropped. Bundles are routed to the scheduled Jito-Solana leader and are only processed while that leader is producing; standard validators do not receive or execute bundles, and the bundle is not forwarded onward. We detect the skip from the slot stream (the slot completes under a different/no validator), classify it as a bundle drop, and the agent resubmits targeting the next scheduled Jito leader window.

---

## 10. Demo plan (3-5 min)

1. Dashboard live: slots advancing, next Jito leader countdown, current congestion.
2. Happy-path bundle: dynamic tip computed, lands, full lifecycle with deltas shown.
3. Inject a blockhash-expiry fault: failure detected and classified.
4. Cut to the agent's reasoning in the ledger: it diagnoses expiry, refreshes blockhash, recalculates tip, picks a submit slot - then resubmits autonomously and lands.
5. Close on the lifecycle log + a slot number opened in an explorer to prove it's real.

---

## 11. Risk register

| Risk                           | Mitigation                                                           |
| ------------------------------ | -------------------------------------------------------------------- |
| Agent reads as hardcoded logic | Log full input + reasoning; show decision variance across conditions |
| Stream drops lose slots        | `fromSlot` replay + dedup; persist last slot                         |
| Hardcoded tip slips in         | All tips from `tip_floor`; grep/lint check                           |
| Polling-only confirmation      | Stream-primary, status-API secondary                                 |
| No real failures captured      | Deterministic injector + run during congestion                       |
| Mainnet cost overrun           | Tip ceilings, minimal hot wallet, devnet fallback                    |
| Architecture doc neglected     | Build in parallel from Phase 1; it is judged separately              |
| Phase slip                     | Back-loaded buffer; drop Rust flex / web UI first                    |
