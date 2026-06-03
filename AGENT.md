# AGENT.md — the SolGuard AI Decision Agent

This document specifies the **AI agent** that is the brain of SolGuard. It is
the part the bounty weighs most heavily, so the contract here is binding for
everyone working on `src/agent/`.

> Not to be confused with [`CLAUDE.md`](./CLAUDE.md), which governs AI *coding
> assistants* working in this repo. This file describes the agent that ships
> **inside** the product.

---

## 1. The one decision the agent owns

**Autonomous retry under fault**, with **tip recalculation** and **submission
timing** as sub-decisions. When a bundle fails (real or injected), the agent
reads the situation and decides: `retry`, `hold`, or `abort` — and with what
tip and at which slot.

It is explicitly **not** a hardcoded `if failed: retry with bigger tip`. It
reasons over live signals and its behavior must change with conditions.

---

## 2. Separation of concerns (NFR-5)

```
core stack  ──(structured failure + network context)──▶  AGENT  ──(strict JSON decision)──▶  guardrail ──▶ executor
                                                            │
                                                            ▼
                                                     decision ledger (append-only)
```

- The agent **never** calls Jito, RPC, or the stream directly.
- The core stack **never** embeds retry heuristics — it asks the agent.
- Failure handling is a separate layer that *routes* failures to the agent.

---

## 3. Input contract (built by the core, fed to the agent)

```jsonc
{
  "event": "bundle_failed | pre_submit_evaluation",
  "failure": {
    "type": "blockhash_expired | fee_too_low | compute_exceeded | bundle_dropped_leader_skip | simulation_failed",
    "evidence": { "blockhash_age_slots": 47, "last_valid_slot": 312900 }
  },
  "bundle": {
    "attempt": 1, "tip_lamports": 5000, "tip_account": "…",
    "submitted_slot": 312847, "target_leader_slot": 312850
  },
  "network": {
    "current_slot": 312901,
    "slot_skip_rate_64": 0.04,
    "processed_to_confirmed_ms_p50": 380,
    "tip_floor": { "p25":1000,"p50":5000,"p75":12000,"p95":25000,"ema":6200 },
    "next_jito_leader_slot": 312912,
    "slots_until_jito_leader": 11
  },
  "history": [ { "attempt": 1, "outcome": "expired" } ]
}
```

Every field here comes from a real subsystem: `failure`/`evidence` from the
classifier, `network` from the congestion oracle + leader detector + tip-floor
fetcher, `history` from the lifecycle log.

---

## 4. Output contract (strict JSON, no prose, no code fences)

```jsonc
{
  "diagnosis": "2–4 sentences referencing the ACTUAL input signals",
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

The model is prompted to emit JSON only. The parser is defensive (strip
accidental fences, reject on parse failure → re-prompt).

---

## 5. Guardrail layer (`src/agent/guardrail.ts`)

Validates the agent output for sanity **without substituting its own decision**:
- `new_tip_lamports` ∈ `[tip_floor.p25, TIP_CEILING_LAMPORTS]`
- `submit_at_slot` is in the future and within a reachable Jito window
- `max_blockhash_age_slots` ≤ 150 (legal blockhash validity)
- `action` ∈ {retry, hold, abort}; `confidence` ∈ [0, 1]

On invalid output → **re-prompt** with the specific validation error. The
guardrail may reject and re-ask, but it must never fabricate a decision. The
`guardrail_action` (`accepted | re-prompted`) is recorded.

---

## 6. Decision ledger (`logs/decisions.jsonl`, append-only)

Every invocation writes one entry:

```jsonc
{
  "ts": "…",
  "trigger": "real_failure | injected_fault",
  "input_context": { /* full agent input */ },
  "raw_reasoning": "…",
  "validated_decision": { /* output after guardrail */ },
  "guardrail_action": "accepted | re-prompted",
  "executed_action": "retry",
  "eventual_outcome": "landed @ slot 312915"
}
```

This ledger is the proof to judges that decisions are *reasoned, not coded*.

---

## 7. Anti-disqualification checklist (enforce in review)

- [ ] `diagnosis` references real signals from the input (not generic text).
- [ ] Behavior varies across conditions:
      **hold** during a skip spike · **escalate tip** during congestion ·
      **abort** after repeated identical failures.
- [ ] The agent runs on **real** failures from live runs, not only injected ones.
- [ ] No decision parameters are hardcoded in the executor — they come from the agent.
- [ ] Full input + raw reasoning + outcome present in the ledger for every call.

---

## 8. Variance test (verification §8)

Run the agent under low vs high congestion with otherwise-similar inputs and
confirm it produces *materially different* decisions (e.g. hold vs escalate).
This is a required pre-submission check.

---

## 9. Implementation pointers

| File | Responsibility |
|---|---|
| `src/agent/contract.ts` | Input/output TypeScript schemas + validators |
| `src/agent/agent.ts`    | Prompt construction + Anthropic API call (strict JSON) |
| `src/agent/guardrail.ts`| Range validation + re-prompt loop |
| `src/agent/ledger.ts`   | Append-only decision ledger writer |

Model: `ANTHROPIC_MODEL` (default `claude-opus-4-8`). Use prompt caching for the
static system prompt to cut latency/cost.
