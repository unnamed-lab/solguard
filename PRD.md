# Product Requirements Document — SolGuard

**Project:** SolGuard — Autonomous Bundle Intelligence Stack
**Bounty:** Advanced Infrastructure Challenge — Build a Smart Transaction Stack (Superteam Nigeria)
**Status:** Draft v1.0
**Owner:** _Herald Team_
**Target network:** Mainnet-beta (Devnet fallback)
**Submission deadline driver:** Winner announcement July 13, 2026

---

## 1. Summary

SolGuard is a smart Solana transaction stack that observes the network in real time, submits Jito bundles intelligently, tracks each transaction across all commitment levels, and uses an AI agent to own one real operational decision: **autonomous retry under fault injection** (with tip and timing as sub-decisions inside the retry).

The system treats a live Yellowstone/Geyser stream as the source of truth for landing, derives network-health telemetry from the slot stream, prices Jito tips dynamically from live tip-floor data, and logs every AI decision in an auditable ledger so reviewers can verify that decisions are reasoned rather than hardcoded.

---

## 2. Problem statement

On Solana, sending a transaction is one small step in a multi-stage lifecycle: leader scheduling, TPU ingestion, block production, shred propagation, and several commitment stages. Naive senders fire transactions blindly, poll RPC for status, and retry with hardcoded parameters. They fail silently under congestion, waste tips, and cannot explain _why_ a transaction did or did not land.

A production-grade stack must understand the full flow, confirm outcomes from streams rather than polling alone, react correctly to specific failure classes, and make cost/landing tradeoffs under changing conditions.

---

## 3. Goals and non-goals

### Goals

- G1. Stream live slot and leader data and submit bundles only into valid Jito leader windows.
- G2. Price tips dynamically from live data with **zero hardcoded tip values**.
- G3. Track the full lifecycle (submitted -> processed -> confirmed -> finalized) with slots, timestamps, and latency deltas.
- G4. Confirm landing primarily via stream subscriptions, reconciled with Jito bundle-status APIs.
- G5. Classify failures into specific, actionable categories.
- G6. Have an AI agent own a real operational decision with visible, logged reasoning.
- G7. Produce auditable evidence: >=10 real bundle submissions including >=2 failures, plus a decision ledger.

### Non-goals

- Not an MEV/arbitrage searcher; SolGuard demonstrates infrastructure, not a profit strategy.
- Not a general wallet or dApp UI.
- Not a multi-chain system.
- No hardcoded retry flow or "sequential wrapper" automation masquerading as AI.

---

## 4. Success metrics (mapped to judging criteria)

| Judging criterion    | SolGuard success metric                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does it work?        | >=10 real bundles submitted on mainnet/devnet; lifecycle logs with explorer-verifiable slot numbers; >=2 demonstrated failure cases                              |
| Depth of integration | Real Jito bundle construction; dynamic tips from `tip_floor`; correct commitment-level usage; stream-based confirmation; reconnect + backpressure handling       |
| AI demonstration     | Every agent decision logged with full input context and free-text reasoning that references real signals; observable behavior variance across network conditions |
| Explanation          | Architecture document + README answering the three questions with measured numbers from the running system                                                       |

---

## 5. Users and context

- **Primary user (evaluation context):** bounty judges who will read the architecture doc, run/inspect the code, read the lifecycle logs, and cross-reference slot numbers on Solana explorers.
- **Conceptual end user:** an infrastructure engineer who needs reliable, explainable transaction landing under variable network conditions.

---

## 6. Functional requirements

### 6.1 Streaming and network observation

- **FR-1.** Subscribe to slot updates via Yellowstone gRPC across all commitment levels (`filterByCommitment: false`) to observe processed -> confirmed -> finalized transitions per slot.
- **FR-2.** Subscribe to transaction updates filtered to the stack's own signatures for landing confirmation.
- **FR-3.** On disconnect, reconnect and resubscribe with `fromSlot = lastProcessedSlot`; deduplicate replayed updates. Persist `lastProcessedSlot` (replay window is ~150 slots).
- **FR-4.** Reply to server pings (~15s interval) to maintain the long-lived stream.
- **FR-5.** Apply backpressure: bounded queue with an explicit policy (pause consumption or drop-oldest with a counted metric) so a slow consumer cannot exhaust memory.

### 6.2 Leader window detection

- **FR-6.** Cache the leader schedule (`getLeaderSchedule`) and identify upcoming **Jito** leaders via the block engine's next-scheduled-leader endpoint.
- **FR-7.** Only submit bundles when a Jito-Solana leader is producing or imminent; bundles are not processed by standard validators.

### 6.3 Tip intelligence

- **FR-8.** Fetch live tip data from `https://bundles.jito.wtf/api/v1/bundles/tip_floor` (percentiles p25/p50/p75/p95/p99 + EMA). Optionally subscribe to the tip-stream WebSocket.
- **FR-9.** Compute tip as a function of tip-floor percentile and a congestion multiplier from the oracle. No hardcoded tip values anywhere in the code path.
- **FR-10.** Retrieve the 8 tip accounts via `getTipAccounts`; select one at random per bundle to avoid write-lock contention.

### 6.4 Bundle construction and submission

- **FR-11.** Construct bundles of <=5 transactions; place the tip transfer in the **last** transaction; all transactions share one recent blockhash.
- **FR-12.** Fetch blockhash at `confirmed` commitment for time-sensitive submission (never `finalized`).
- **FR-13.** Submit to a single closest regional block-engine endpoint (`https://<region>.mainnet.block-engine.jito.wtf/api/v1/bundles`); 0-2 fallbacks maximum.

### 6.5 Lifecycle tracking

- **FR-14.** Track each bundle across four stages: submitted, processed, confirmed, finalized.
- **FR-15.** Capture slot number and timestamp at each stage; compute latency deltas between consecutive stages (notably processed->confirmed).

### 6.6 Landing confirmation and reconciliation

- **FR-16.** Confirm landing primarily by matching the transaction signature in the Yellowstone transaction stream.
- **FR-17.** Reconcile with `getInflightBundleStatuses` (early) and `getBundleStatuses` (after) as a secondary signal. RPC polling alone must not be the sole confirmation mechanism.

### 6.7 Failure classification

- **FR-18.** Classify failures into: expired blockhash, fee/tip too low, compute exceeded, bundle dropped (leader skip), and simulation failure.
- **FR-19.** Attach evidence to each classified failure (e.g., blockhash age in slots, observed skip, simulation error).

### 6.8 AI agent

- **FR-20.** The agent owns the retry decision under fault injection, including sub-decisions for tip recalculation and submission timing.
- **FR-21.** The agent receives a structured input context (failure, bundle, network, history) and returns a strict-JSON decision (diagnosis, root_cause, action, params, confidence).
- **FR-22.** A guardrail layer validates the agent's output for sanity (tip bounds, legal blockhash age) and re-prompts on invalid output; it must never substitute its own decision.
- **FR-23.** Every agent invocation is recorded in an append-only decision ledger: input context, raw reasoning, validated decision, and eventual outcome.
- **FR-24.** The agent is exercised on **real** failures from live runs, not only injected ones.

### 6.9 Fault injection

- **FR-25.** Provide a deterministic, reproducible fault injector for: blockhash expiry, tip-too-low, leader skip, compute exceeded.
- **FR-26.** Each injected fault must flow through detection -> classification -> agent decision -> resubmission, producing entries in both the lifecycle log and the decision ledger.

### 6.10 Evidence and reporting

- **FR-27.** Export a lifecycle log of >=10 real bundle submissions with >=2 failure cases; each entry contains slot numbers, commitment progression, timestamps, tip amount, and failure classification where applicable.
- **FR-28.** Provide a README answering the three required questions using measured numbers from the running system.
- **FR-29.** Provide a public architecture document (Notion/Google Docs/Figma/public URL) hosted separately from the repo.

---

## 7. Non-functional requirements

- **NFR-1. Reliability:** stream reconnection with slot replay and deduplication; no missed or double-counted slots in normal operation.
- **NFR-2. Backpressure:** bounded memory under burst load; dropped events are counted and surfaced, never silent.
- **NFR-3. Observability:** a live dashboard (terminal or web) showing slot ticker, current/next leader, bundle states, and the latest agent decision.
- **NFR-4. Auditability:** all logs append-only and timestamped; slot numbers must reconcile with public explorers.
- **NFR-5. Separation of concerns:** clean boundary between the AI layer, the core transaction stack, and failure handling.
- **NFR-6. Reproducibility:** clear setup instructions; deterministic fault injection; config via environment variables (no secrets in repo).
- **NFR-7. Cost safety:** tips bounded by configurable ceilings; hot wallet holds only minimal funds.

---

## 8. AI agent specification

### Decision contract - input

```json
{
  "event": "bundle_failed | pre_submit_evaluation",
  "failure": {
    "type": "blockhash_expired | fee_too_low | compute_exceeded | bundle_dropped_leader_skip | simulation_failed",
    "evidence": { "blockhash_age_slots": 47, "last_valid_slot": 312900 }
  },
  "bundle": {
    "attempt": 1,
    "tip_lamports": 5000,
    "tip_account": "...",
    "submitted_slot": 312847,
    "target_leader_slot": 312850
  },
  "network": {
    "current_slot": 312901,
    "slot_skip_rate_64": 0.04,
    "processed_to_confirmed_ms_p50": 380,
    "tip_floor": {
      "p25": 1000,
      "p50": 5000,
      "p75": 12000,
      "p95": 25000,
      "ema": 6200
    },
    "next_jito_leader_slot": 312912,
    "slots_until_jito_leader": 11
  },
  "history": [{ "attempt": 1, "outcome": "expired" }]
}
```

### Decision contract - output (strict JSON)

```json
{
  "diagnosis": "2-4 sentences referencing the actual input signals",
  "root_cause": "blockhash_expired",
  "action": "retry | hold | abort",
  "params": {
    "refresh_blockhash": true,
    "new_tip_lamports": 11000,
    "tip_percentile_target": 75,
    "submit_at_slot": 312911,
    "max_blockhash_age_slots": 60
  },
  "confidence": 0.82,
  "expected_outcome": "land within next Jito leader window"
}
```

### Anti-disqualification rules

- The `diagnosis` must reference real signals from the input (validated in review, surfaced in the ledger).
- Observable behavior must vary across conditions - e.g., **hold** during a skip spike, **escalate tip** during congestion, **abort** after repeated identical failures.
- The agent runs on real failures, not only injected ones.

---

## 9. Data models

### Lifecycle log entry

```json
{
  "bundle_id": "...",
  "signatures": ["..."],
  "tip_lamports": 11000,
  "tip_account": "...",
  "attempt": 2,
  "stages": {
    "submitted": { "slot": 312911, "ts": "..." },
    "processed": { "slot": 312913, "ts": "..." },
    "confirmed": { "slot": 312915, "ts": "..." },
    "finalized": { "slot": 312947, "ts": "..." }
  },
  "deltas_ms": {
    "submitted_to_processed": 410,
    "processed_to_confirmed": 380,
    "confirmed_to_finalized": 12800
  },
  "failure": null,
  "confirmed_via": "stream"
}
```

### Decision ledger entry

```json
{
  "ts": "...",
  "trigger": "real_failure | injected_fault",
  "input_context": {},
  "raw_reasoning": "...",
  "validated_decision": {},
  "guardrail_action": "accepted | re-prompted",
  "executed_action": "retry",
  "eventual_outcome": "landed @ slot 312915"
}
```

---

## 10. Failure taxonomy

| Class                        | Primary signal                                             | Typical agent response                            |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| Expired blockhash            | current slot > last valid slot                             | refresh blockhash, resubmit into next Jito window |
| Fee/tip too low              | bundle lost auction, never processed under congestion      | raise tip toward higher percentile                |
| Compute exceeded             | tx error: compute budget exceeded                          | adjust compute budget / split instructions        |
| Bundle dropped (leader skip) | scheduled Jito slot skipped or produced by other validator | resubmit targeting next Jito leader               |
| Simulation failed            | block engine simulation rejection                          | inspect instruction; abort or fix and resubmit    |

---

## 11. Out of scope

- Profit-generating MEV strategies.
- Cross-chain or non-Solana support.
- Persisting full historical chain data beyond the replay/dedup window.
- Production-grade key management (a minimal funded hot wallet is sufficient for the demo).

---

## 12. Risks and mitigations

| Risk                                  | Impact                              | Mitigation                                                        |
| ------------------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| Agent looks like dressed-up `if/else` | Disqualifying for AI score          | Log full input context + reasoning; demonstrate behavior variance |
| Stream drops lose slots               | Inaccurate lifecycle data           | `fromSlot` replay + dedup; persist last slot                      |
| Hardcoded tip slips in                | Disqualifying for depth score       | All tips derived from `tip_floor`; code review checklist          |
| Confirmation via polling only         | Explicitly insufficient             | Stream-primary confirmation, status APIs secondary                |
| No real failures captured             | Weak AI + README evidence           | Deterministic fault injector + run during congestion              |
| Mainnet cost overrun                  | Wasted funds                        | Tip ceilings; minimal hot wallet; devnet fallback                 |
| Missing architecture doc              | Heavily weighted, judged separately | Build doc in parallel from Phase 1                                |

---

## 13. Acceptance criteria (definition of done)

- [ ] Live slot + leader streaming with reconnection, slot replay, dedup, and backpressure.
- [ ] Bundles submitted only into Jito leader windows.
- [ ] Tips computed from live `tip_floor`; no hardcoded values in the codebase.
- [ ] Full four-stage lifecycle tracked with slots, timestamps, and deltas.
- [ ] Landing confirmed via stream, reconciled with bundle-status APIs.
- [ ] Failure classifier covers all five classes with evidence.
- [ ] AI agent owns retry-under-fault-injection with strict-JSON contract, guardrails, and decision ledger.
- [ ] Deterministic fault injector produces >=2 verified failure cases.
- [ ] Lifecycle log of >=10 real submissions with explorer-verifiable slots exported.
- [ ] README answers all three questions with measured numbers.
- [ ] Public architecture document published.
- [ ] Open-source repo with clear setup instructions and a working prototype.
- [ ] 3-5 minute demo video showing dashboard, a live failure, and the agent resolving it.
