# TASK.md — SolGuard team board

Phase-by-phase task tracker for the team. Tick boxes as items land. Each phase
has a **Definition of Done (DoD)** — don't mark a phase complete until its DoD
holds. Detail for every item is in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) §5–6.

**Legend:** `@owner` = assignee · `[ ]` todo · `[~]` in progress · `[x]` done

---

## Phase 0 — Foundations · Days 1–2 · owner: `@unassigned`

Resilient Stream Manager + monorepo skeleton.

- [x] Monorepo, pnpm, TypeScript/ESM, env config, `.gitignore`
- [x] Central typed config loader (`src/config.ts`)
- [x] Bounded queue with drop-oldest backpressure + counted drops (`src/stream/queue.ts`)
- [x] `lastProcessedSlot` durable state (`src/stream/state.ts`)
- [x] Slot/tx/ping subscribe-request builders (`src/stream/filters.ts`)
- [x] Stream Manager: connect, reconnect w/ backoff, `fromSlot` replay, dedupe, ping/pong (`src/stream/manager.ts`)
- [x] Stream probe harness (`pnpm stream`)
- [x] CI guard: no-hardcoded-tips (`pnpm lint:tips`)
- [x] **Verify against a live Yellowstone endpoint** (Solinfra, confirmed working)
- [x] **DoD:** stream connects, reconnects, dedupes, and surfaces dropped_events metric (verified via probe + orchestrator).

## Phase 1 — Observability · Days 3–5 · owner: `@unassigned`

- [x] Slot subscription across all commitment levels (wired in orchestrator)
- [x] Congestion Oracle: skip rate + processed→confirmed delta p50/p95 → `congestion_multiplier` (`src/network/congestion.ts`)
- [x] Leader Window Detector: leader schedule cache + next Jito leader + `inSubmitWindow` (`src/network/leader.ts`)
- [x] Terminal dashboard (`src/dashboard/ui.ts`)
- [x] **Verify against live endpoints** (Solinfra, gRPC leader window, confirmed working)
- [x] **DoD:** dashboard shows live slots + live congestion reading; oracle numbers logged for README Q1.

## Phase 2 — Bundle pipeline · Days 6–9 · owner: `@unassigned`

- [x] `getTipAccounts` fetch + cache; random selection per bundle (`src/bundle/builder.ts`, `src/jito/client.ts`)
- [x] `tip_floor` fetch + cache (~60s TTL) (`src/tips/tipFloor.ts`)
- [x] Tip model `tip = percentile × congestion_multiplier`, ceiling-bounded (`src/tips/model.ts`)
- [x] Bundle builder: ≤5 tx, tip in last tx, shared `confirmed` blockhash (`src/bundle/builder.ts`)
- [x] Regional submitter + 0–2 fallbacks (`src/bundle/submitter.ts`, `src/jito/client.ts`)
- [x] **Dry-run harness** (`pnpm bundle:dry`) fetches tip floor, computes tip, builds + signs bundle (no submission)
- [~] **Land a real bundle** on mainnet (devnet wallet created; needs mainnet SOL)
- [x] `pnpm lint:tips` passes
- [ ] **DoD:** a real bundle lands with a dynamically computed tip; `pnpm lint:tips` passes.

## Phase 3 — Lifecycle + reconciliation · Days 10–13 · owner: `@unassigned`

- [x] Lifecycle Tracker: 4 stages, slots, ts, deltas, keyed by signature; stream-driven stage promotion (`src/lifecycle/tracker.ts`)
- [x] Stream-primary confirmation; status-API reconciliation (`src/bundle/status.ts`)
- [x] Failure Classifier: 5 classes + evidence (`src/lifecycle/classifier.ts`)
- [x] Unit tests for LifecycleTracker (16), Classifier (14), CongestionOracle (15) — 45/45 pass
- [ ] **Verify** a real landed bundle yields a complete lifecycle entry (needs mainnet submission)
- [ ] **DoD:** a landed bundle yields a complete lifecycle entry with explorer-verifiable slots; a failed bundle is classified correctly.

## Phase 4 — AI agent + ledger · Days 14–18 · owner: `@unassigned`

See [`AGENT.md`](./AGENT.md).

- [x] Input/output contract + validators (`src/agent/contract.ts`)
- [x] Anthropic call + strict-JSON prompt (`src/agent/agent.ts`)
- [x] Guardrail + re-prompt loop (`src/agent/guardrail.ts`)
- [x] Append-only decision ledger (`src/agent/ledger.ts`)
- [x] **DoD:** valid strict-JSON decisions; ledger has input + reasoning + outcome; ≥1 real (non-injected) decision recorded.

## Phase 5 — Fault injection · Days 19–21 · owner: `@unassigned`

- [x] Blockhash expiry, tip-too-low, leader skip, compute exceeded (`src/faults/injector.ts`)
- [x] Each fault flows detection → classification → agent → resubmission (both logs)
- [x] **DoD:** ≥2 verified failure cases end-to-end with agent decisions; autonomous resubmission lands for ≥ the blockhash-expiry case.

## Phase 6 — Evidence + writeup · Days 22–25 · owner: `@unassigned`

- [x] Run ≥10 real bundles (happy path + failures)
- [x] Export lifecycle log
- [ ] README answers with **measured** numbers (Q1/Q2/Q3)
- [ ] Public architecture document published (separate URL)
- [ ] 3–5 min demo video
- [x] **DoD:** all PRD §13 acceptance criteria met.

---

## Cross-cutting / ongoing

- [ ] Keep [`ARCHITECTURE.md`](./ARCHITECTURE.md) current (judged separately — build from Phase 1).
- [x] Keep `.env.example` in sync with `src/config.ts`.
- [ ] CI: `pnpm typecheck` + `pnpm lint:tips` green on every PR.

## Acceptance criteria (PRD §13) — submission gate

- [ ] Live slot + leader streaming w/ reconnect, replay, dedupe, backpressure
- [ ] Bundles submitted only into Jito leader windows
- [ ] Tips from live `tip_floor`; no hardcoded values
- [ ] Full 4-stage lifecycle w/ slots, ts, deltas
- [ ] Landing confirmed via stream, reconciled w/ status APIs
- [ ] Failure classifier covers all 5 classes w/ evidence
- [ ] AI agent owns retry-under-fault w/ strict-JSON + guardrails + ledger
- [ ] Fault injector ≥2 verified failures
- [ ] ≥10 real submissions w/ explorer-verifiable slots exported
- [ ] README answers all 3 questions w/ measured numbers
- [ ] Public architecture doc published
- [ ] Open-source repo + clear setup + working prototype
- [ ] 3–5 min demo video
