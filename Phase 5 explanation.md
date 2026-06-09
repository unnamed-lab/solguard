# Phase 5 — Fault Injection: A Complete Explanation

This document explains everything about SolGuard's **Phase 5** task: what it is,
why it exists, how it's built, how the pieces connect, the bug we found and
fixed, and the evidence-mode safeguard we added. It's written so you can
understand the whole phase end-to-end without reading the code first.

---

## 1. What Phase 5 is, in one sentence

Phase 5 proves that when a Solana bundle **fails for a known reason**, SolGuard
can *deliberately cause* that failure, *detect and name* it, *ask the AI agent
what to do*, and *act on the decision* — all the way through to a bundle that
lands. It is the phase that demonstrates the whole stack works under fault, not
just on the happy path.

The relevant requirements from the PRD:

- **FR-25** — provide a *deterministic, reproducible* fault injector for four
  faults: blockhash expiry, tip-too-low, leader skip, compute exceeded.
- **FR-26** — each injected fault must flow through
  **detection → classification → agent decision → resubmission**, and produce
  entries in **both** the lifecycle log *and* the decision ledger.

The Phase 5 **Definition of Done** (from `TASK.md`):

> ≥2 verified failure cases end-to-end with agent decisions; autonomous
> resubmission lands for ≥ the blockhash-expiry case.

---

## 2. Why this phase matters for the bounty

The single most valuable thing SolGuard claims is that an **AI agent owns the
retry-under-fault decision** — not an `if/else` ladder. To prove that claim you
need *real failures to react to*. In live trading you can't wait around for the
network to hand you a blockhash-expiry at a convenient moment, and you certainly
can't reproduce one on demand for a judge.

So Phase 5 builds a **fault injector**: a controlled way to force each failure
class deterministically. That gives you:

1. Repeatable evidence (the same fault, every run).
2. A way to show the agent's behavior **varies** by failure type (retry vs.
   escalate-tip vs. abort) — which is exactly what distinguishes a real agent
   from dressed-up branching (CLAUDE.md hard rule #3).

---

## 3. The four faults and how each is injected

All injection lives in **`src/faults/injector.ts`** as a small stateful class.
You set one active fault at a time with `setFault(...)`, and each injection
method is a no-op unless its fault is active. This keeps injection points
sprinkled through the real pipeline without changing behavior when no fault is
set.

| Fault | What it simulates | How it's injected | Method |
|---|---|---|---|
| `blockhash_expired` | The blockhash aged out before the tx landed | Returns a stale blockhash whose `lastValidBlockHeight` is 200 blocks in the past | `injectBlockhash()` |
| `fee_too_low` | Tip lost the Jito auction | Forces the tip down to **1 lamport**, far below the p25 floor | `injectTip()` |
| `bundle_dropped_leader_skip` | Targeted Jito leader slot was skipped / window closed | Sets `inSubmitWindow: false` and `slotsUntilJitoLeader: -1` | `injectLeaderWindow()` |
| `compute_exceeded` | Transaction blew the compute budget | Appends a `ComputeBudgetProgram` instruction requesting **15,000,000 CUs** (max is ~1.4M) | `injectComputeError()` |

**Note on the tip literal:** the `1` lamport in `injectTip` is annotated
`// no-hardcoded-tip-ok` because it's a *fault simulation*, not a real tip. This
is the only sanctioned way around the "no hardcoded tips" rule, and the
`pnpm lint:tips` guard still passes.

---

## 4. The end-to-end flow (FR-26)

Every fault travels the same four-stage path. This is the heart of Phase 5:

```
  INJECT            DETECT/CLASSIFY        DECIDE                ACT
  ──────            ───────────────        ──────                ───
  FaultInjector  →  classifyFailure()  →   agent.decide()   →    buildBundle()
  (faults/          (lifecycle/            (agent/agent.ts)       + submitBundle()
   injector.ts)      classifier.ts)                               + tracker landing
        │                  │                     │                      │
        │                  ▼                     ▼                      ▼
        │            lifecycle.jsonl        decisions.jsonl       lifecycle.jsonl
        │            (failure recorded)     (full decision)       (retry tracked)
        └─── all driven by the harness: scripts/fault-test.ts ───┘
```

Stage by stage:

1. **Inject** — the harness sets a fault, then builds a bundle through the
   *real* builder/submitter, so the corrupted input flows through production
   code paths.
2. **Detect & classify** — `classifyFailure()` (in
   `src/lifecycle/classifier.ts`) maps the observed signals to one of **five**
   failure classes and attaches **evidence** (e.g. the actual block heights, the
   tip vs. the p50 floor, the simulation error text). Classification order
   matters: explicit signals (simulation error, block-height overrun) are
   checked before congestion heuristics.
3. **Decide** — the failure record + network context is handed to
   `agent.decide()`. The agent returns a strict-JSON decision: a diagnosis,
   root cause, an action (`retry | hold | abort`), and parameters
   (`refresh_blockhash`, `new_tip_lamports`, target slot, etc.).
4. **Act** — if the agent says `retry`, the harness rebuilds and resubmits the
   bundle (refreshing the blockhash / changing the tip as the agent directed),
   then simulates the stream confirming it landed. The `LifecycleTracker`
   records the full 4-stage lifecycle (submitted → processed → confirmed →
   finalized) for the retried bundle.

Both audit trails are written: **`logs/lifecycle.jsonl`** (what happened to each
bundle) and **`logs/decisions.jsonl`** (what the agent decided and why).

---

## 5. The harness: `scripts/fault-test.ts`

Because live Yellowstone streams and real mainnet SOL aren't available in a test
environment, the harness runs a **high-fidelity offline simulator**. It mocks
exactly three external surfaces and runs *everything else for real*:

- `connection().getLatestBlockhash` / `getSlot` — mocked RPC.
- `tipFloorService().get` — mocked Jito tip-floor API.
- `jitoClient().sendBundle` / `getTipAccounts` — mocked Jito block engine.

Everything in between — tip computation, bundle building & signing, failure
classification, the AI agent, guardrails, the lifecycle tracker, the ledger — is
the **real production code**.

It runs four scenarios in order:

1. **Happy path** — build, submit, simulate landing, verify the bundle reaches
   `finalized` in the tracker. (Baseline: the pipeline works at all.)
2. **Blockhash expiry** — inject stale blockhash → classify `blockhash_expired`
   → agent decides → **autonomous retry that lands** (this is the DoD case).
3. **Tip too low** — inject 1-lamport tip under simulated congestion → classify
   `fee_too_low` → agent escalates the tip.
4. **Compute exceeded** — inject 15M-CU instruction → classify
   `compute_exceeded` → agent aborts (correctly: retrying won't help a tx that
   can't fit the compute budget).

The varied outcomes (retry, escalate, abort) are the visible proof that the
agent reasons from the input rather than always doing the same thing.

---

## 6. The bug we found, and the fix

### The symptom
`pnpm fault:test` **crashed at Scenario 2** with:

```
Error: Expected Agent to retry, but got action: abort
```

### The root cause
An **invalid `ANTHROPIC_API_KEY` was set in the shell environment**. (`dotenv`
does *not* override a variable that already exists in the shell, so the empty
value in `.env` was ignored and the bad shell key won.) In this environment a
proxy returns an HTTP `200` whose body is the plain text `"Access Denied"` —
**not** valid JSON.

So the agent's flow was:

1. Live API "succeeds" (HTTP 200) but the body isn't JSON → parse fails.
2. The agent re-prompts the same dead endpoint up to 3 times — pointless, the
   endpoint will never return JSON.
3. After exhausting retries, the agent fell back to a blanket **`abort`**.
4. The harness treats `abort` on the blockhash case as fatal and crashes.

### The fix (in the **agent**, `src/agent/agent.ts` — not the harness)
We made the agent **degrade gracefully** instead of looping and aborting, in two
places:

1. **Thrown API errors** (bad key, network, rate-limit): caught immediately.
   Re-prompting can't help an unreachable endpoint, so we degrade **once** to
   the grounded local policy (`generateMockDecision`), which is still
   guardrail-checked.
2. **Non-throwing junk responses** (the "Access Denied" 200 case): after the
   re-prompt loop exhausts, we fall back to the grounded policy **instead of** a
   blanket abort. A safe `abort` remains only as a true last resort, used solely
   if even the grounded policy fails validation.

Both fallbacks still pass through `validateAgentOutput` + `checkGuardrails`, and
the ledger's `raw_reasoning` is tagged `[grounded-fallback: ...]` so a fallback
is never silently mistaken for genuine model output.

**Result:** the harness now passes (exit 0) regardless of API-key state, and
once you set a *valid* key the live Claude path runs unchanged.

---

## 7. The evidence-mode safeguard (the important part)

The graceful fallback created a new risk: the grounded local policy is, by
design, deterministic `if/else` on the failure type. That's a fine *safety net*,
but it is exactly the "dressed-up if/else" that the bounty forbids as **AI
evidence**. You must never submit a fallback-derived decision as proof of the AI
agent.

To make that mistake impossible, we added **decision provenance** and an
**evidence mode**.

### Provenance: `decision_source`
Every decision now carries a `decision_source`, recorded in the ledger *and*
returned to callers:

| Source | Meaning |
|---|---|
| `live_model` | Parsed & validated from a real Anthropic response. **The only evidence-grade source.** |
| `local_mock` | No API key configured at all; grounded policy used by design. |
| `grounded_fallback` | Key present but unreachable / returned garbage; degraded to local policy. |
| `safe_abort` | Even the grounded policy was invalid; last-resort abort. |

### Evidence mode
The harness now has two modes:

- **Dev mode** (`pnpm fault:test`): fallbacks are allowed. The run passes but
  prints a clear provenance warning listing every non-live decision.
- **Evidence mode** (`pnpm fault:test:evidence`, or `--evidence`, or
  `FAULT_TEST_EVIDENCE=1`): the harness **fails loudly** the moment any decision
  is not `live_model`:

  ```
  EVIDENCE MODE: decision "blockhash_expired" came from "grounded_fallback",
  not the live model. Set a valid ANTHROPIC_API_KEY and re-run. Refusing to
  treat fallback decisions as AI evidence.
  ```

This guarantees you **cannot accidentally produce mock-derived decisions and
submit them as AI evidence**. When you have a working key, run evidence mode; if
anything degraded, it stops you.

---

## 8. How to run it

```bash
# Dev run — always works, fallbacks allowed, prints provenance warnings
pnpm fault:test

# Evidence run — REQUIRES a valid ANTHROPIC_API_KEY; fails if any decision
# did not come from the live model
pnpm fault:test:evidence
```

To produce evidence-grade decisions:

1. Make sure no **invalid** `ANTHROPIC_API_KEY` is exported in your shell
   (check with `echo $ANTHROPIC_API_KEY`; `unset` it if it's stale).
2. Put a valid key in `.env` (it's gitignored) **or** export a valid one.
3. Run `pnpm fault:test:evidence` and confirm it exits 0 with
   "all decisions came from the live model."

---

## 9. Where everything lives

| File | Role in Phase 5 |
|---|---|
| `src/faults/injector.ts` | The four deterministic fault injectors (FR-25). |
| `src/lifecycle/classifier.ts` | Maps signals → 5 failure classes + evidence (detection). |
| `src/agent/agent.ts` | The AI decision, re-prompt loop, graceful fallback, provenance. |
| `src/agent/contract.ts` | Strict input/output schema + validators. |
| `src/agent/guardrail.ts` | Safety bounds applied to every decision. |
| `src/agent/ledger.ts` | Append-only `decisions.jsonl`; now records `decision_source`. |
| `src/lifecycle/tracker.ts` | 4-stage lifecycle, slots/timestamps/deltas. |
| `scripts/fault-test.ts` | The end-to-end harness + evidence-mode guard. |
| `logs/lifecycle.jsonl` | Per-bundle lifecycle audit trail. |
| `logs/decisions.jsonl` | Per-decision audit trail (input, reasoning, decision, outcome). |

---

## 10. Status & honest caveats

**Working and verified:**
- All four faults inject deterministically.
- Full detection → classification → decision → resubmission flow, writing both
  logs.
- Behavior varies by failure type (retry / escalate / abort).
- Harness passes in dev mode; fails correctly in evidence mode without a valid
  key.
- `pnpm typecheck`, `pnpm test` (54/54), and `pnpm lint:tips` all green.

**Still open (be aware before claiming the DoD as fully met):**
- "Lands" in the harness is **simulated** via the mocked stream, not an
  explorer-verifiable mainnet slot. The DoD's "autonomous resubmission lands" is
  satisfied *in simulation*; a real landed bundle (Phase 2/3 follow-up) is still
  outstanding.
- The decision ledger currently contains `injected_fault` entries only. The
  Phase 4 DoD's "≥1 real (non-injected) decision" still needs a real run.
- For submission, produce the Phase 5 decisions via **evidence mode with a valid
  key**, so the ledger shows genuine `live_model` reasoning rather than the
  grounded fallback.
