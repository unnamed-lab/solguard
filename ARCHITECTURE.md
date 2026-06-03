# ARCHITECTURE — SolGuard

> Judged separately and weighted heavily (PRD §4). This is the in-repo source
> of truth; the public hosted version (Notion/Docs/Figma) is exported from it.
> Keep it current from Phase 1 onward.

## 1. System overview

SolGuard is a smart Solana transaction stack. A live Yellowstone/Geyser gRPC
stream is the **source of truth** for landing. From the slot stream we derive
network-health telemetry; we price Jito tips dynamically from live tip-floor
data; we track each bundle across all commitment levels; and an AI agent owns
the retry-under-fault decision with auditable reasoning.

```
                 ┌─────────────────────┐
   Yellowstone   │  Stream Manager     │  reconnect + fromSlot replay + dedupe
   gRPC  ───────▶│  (slots, txns)      │  ping/pong keepalive, bounded queue
                 └──────────┬──────────┘
                            │ normalized slot + tx events
              ┌─────────────┼──────────────┐
              ▼             ▼               ▼
     ┌──────────────┐ ┌──────────┐ ┌──────────────┐
     │ Congestion   │ │ Leader   │ │ Lifecycle    │
     │ Oracle       │ │ Window   │ │ Tracker      │
     │ (skip rate,  │ │ Detector │ │ (4 stages,   │
     │  P→C delta)  │ │          │ │  deltas)     │
     └──────┬───────┘ └────┬─────┘ └──────┬───────┘
            │              │              │
            └──────┬───────┴──────────────┘
                   ▼
          ┌──────────────────┐      ┌─────────────────┐
          │  AI Agent        │─────▶│  Anthropic API  │
          │  (decision core) │      │  (Claude)       │
          └────────┬─────────┘      └─────────────────┘
                   │ validated decision (guardrail)
                   ▼
          ┌──────────────────┐
          │  Bundle Builder  │  tip = f(oracle, tip_floor), 8 tip accts
          │  + Submitter     │  → Jito Block Engine /api/v1/bundles
          └────────┬─────────┘
                   ▼
          ┌──────────────────┐
          │ Fault Injector   │  deterministic, reproducible failures
          └────────┬─────────┘
                   ▼
          Decision Ledger + Lifecycle Log (append-only JSONL)
```

## 2. Design principles

1. **Stream-primary.** The Yellowstone stream decides landing; bundle-status
   APIs are secondary reconciliation.
2. **AI isolation.** The AI layer is strictly separated from the core stack and
   from failure handling (NFR-5). See [`AGENT.md`](./AGENT.md).
3. **No hardcoded tips.** Every tip derives from live `tip_floor`; only a
   safety ceiling is configured.
4. **Reproducible decisions.** Every agent decision is reconstructable from its
   logged input context.

## 3. Components

### Stream Manager (`src/stream/`) — Phase 0 ✅

- `manager.ts` — long-lived gRPC subscription; reconnect with exponential
  backoff; resume via `fromSlot = lastProcessedSlot`; dedupe `(slot|status)`
  and signatures within the ~150-slot replay window; reply to server pings.
- `queue.ts` — bounded queue, **drop-oldest** policy, counted `dropped` metric.
- `state.ts` — durable `lastProcessedSlot` (throttled disk flush).
- `filters.ts` — slot (all commitments), tx (by signer accounts), ping requests.
- `events.ts` — normalized `SlotEvent` / `TxEvent` + `StreamMetrics`.

### Congestion Oracle (`src/network/congestion.ts`) — Phase 1

Ring buffer of last N slots → skip rate + processed→confirmed delta (p50/p95)
→ a single normalized `congestion_multiplier`. Produces README Q1 numbers.

### Leader Window Detector (`src/network/leader.ts`) — Phase 1

Caches `getLeaderSchedule`; queries next scheduled Jito leader; exposes
`slotsUntilJitoLeader` and `inSubmitWindow`.

### Tip model (`src/tips/`) — Phase 2

`tipFloor.ts` fetches/caches percentiles + EMA; `model.ts` computes
`tip = percentile(p) × congestion_multiplier`, bounded by the ceiling.

### Bundle Builder + Submitter (`src/bundle/`) — Phase 2/3

≤5 versioned tx, tip transfer last, shared `confirmed` blockhash; random tip
account; regional endpoint + 0–2 fallbacks; `status.ts` reconciliation.

### Lifecycle Tracker + Classifier (`src/lifecycle/`) — Phase 3

4-stage tracking with slot/ts/deltas keyed by signature; 5-class failure
taxonomy with attached evidence.

### AI Agent (`src/agent/`) — Phase 4

Contract + Anthropic call + guardrail + append-only ledger. Full spec in
[`AGENT.md`](./AGENT.md).

### Fault Injector (`src/faults/injector.ts`) — Phase 5

Deterministic: blockhash expiry, tip-too-low, leader skip, compute exceeded.

### Dashboard (`src/dashboard/ui.ts`) — Phase 1+

Live slot ticker, current/next leader, `slotsUntilJitoLeader`, active bundle
stages, latest agent decision, `dropped_events` + reconnect counters.

## 4. Data flow: a bundle's life

1. Oracle + leader detector say conditions are good and a Jito window is near.
2. Tip model prices the tip from live `tip_floor` × congestion.
3. Builder assembles ≤5 tx (tip last, shared confirmed blockhash); submitter
   sends to the regional Jito endpoint.
4. Lifecycle tracker watches the tx stream: submitted → processed → confirmed →
   finalized, stamping slots/ts and computing deltas.
5. On failure, the classifier labels it and hands a structured context to the
   agent, which decides retry/hold/abort (+ tip + slot). Guardrail validates;
   ledger records; executor acts.
6. Status APIs reconcile in the background.

## 5. Commitment-level strategy

- Slot stream subscribed with `filterByCommitment: false` → observe every
  processed → confirmed → finalized transition.
- Blockhash fetched at **`confirmed`** (never `finalized`) to maximize the
  ~150-slot validity window for time-sensitive submission.

## 6. Failure taxonomy

| Class                        | Primary signal                 | Typical agent response                       |
| ---------------------------- | ------------------------------ | -------------------------------------------- |
| Expired blockhash            | current slot > last valid slot | refresh blockhash, resubmit next Jito window |
| Fee/tip too low              | lost auction under congestion  | raise tip toward higher percentile           |
| Compute exceeded             | compute-budget error           | adjust budget / split instructions           |
| Bundle dropped (leader skip) | scheduled Jito slot skipped    | resubmit next Jito leader                    |
| Simulation failed            | block-engine sim rejection     | inspect; abort or fix and resubmit           |

## 7. Storage

Append-only JSONL: `logs/lifecycle.jsonl`, `logs/decisions.jsonl`. Optional
SQLite mirror for querying. Slots reconcile with public explorers.

## 8. Tech stack

TypeScript / Node 20+ / ESM · `@triton-one/yellowstone-grpc` ·
`@solana/web3.js` · Jito block-engine REST · `@anthropic-ai/sdk` · pnpm.
Optional depth flex: port the Stream Manager to Rust (note only).
