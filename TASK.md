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
- [ ] **Verify against a live Yellowstone endpoint** (needs credentials)
- [ ] **DoD:** stream survives a forced disconnect and resumes with no missed/double slots; `dropped_events` metric present.

## Phase 1 — Observability · Days 3–5 · owner: `@unassigned`

- [ ] Slot subscription across all commitment levels (wired; verify transitions)
- [ ] Congestion Oracle: skip rate + processed→confirmed delta p50/p95 → `congestion_multiplier` (`src/network/congestion.ts`)
- [ ] Leader Window Detector: leader schedule cache + next Jito leader + `inSubmitWindow` (`src/network/leader.ts`)
- [ ] Terminal dashboard skeleton (`src/dashboard/ui.ts`)
- [ ] **DoD:** dashboard shows live slots + live congestion reading; oracle numbers logged for README Q1.

## Phase 2 — Bundle pipeline · Days 6–9 · owner: `@unassigned`

- [ ] `getTipAccounts` fetch + cache; random selection per bundle (`src/bundle/`)
- [ ] `tip_floor` fetch + cache (~60s TTL) (`src/tips/tipFloor.ts`)
- [ ] Tip model `tip = percentile × congestion_multiplier`, ceiling-bounded (`src/tips/model.ts`)
- [ ] Bundle builder: ≤5 tx, tip in last tx, shared `confirmed` blockhash (`src/bundle/builder.ts`)
- [ ] Regional submitter + 0–2 fallbacks (`src/bundle/submitter.ts`)
- [ ] **DoD:** a real bundle lands with a dynamically computed tip; `pnpm lint:tips` passes.

## Phase 3 — Lifecycle + reconciliation · Days 10–13 · owner: `@unassigned`

- [ ] Lifecycle Tracker: 4 stages, slots, ts, deltas, keyed by signature (`src/lifecycle/tracker.ts`)
- [ ] Stream-primary confirmation; status-API reconciliation (`src/bundle/status.ts`)
- [ ] Failure Classifier: 5 classes + evidence (`src/lifecycle/classifier.ts`)
- [ ] **DoD:** a landed bundle yields a complete lifecycle entry with explorer-verifiable slots; a failed bundle is classified correctly.

## Phase 4 — AI agent + ledger · Days 14–18 · owner: `@unassigned`

See [`AGENT.md`](./AGENT.md).

- [ ] Input/output contract + validators (`src/agent/contract.ts`)
- [ ] Anthropic call + strict-JSON prompt (`src/agent/agent.ts`)
- [ ] Guardrail + re-prompt loop (`src/agent/guardrail.ts`)
- [ ] Append-only decision ledger (`src/agent/ledger.ts`)
- [ ] **DoD:** valid strict-JSON decisions; ledger has input + reasoning + outcome; ≥1 real (non-injected) decision recorded.

## Phase 5 — Fault injection · Days 19–21 · owner: `@unassigned`

- [ ] Blockhash expiry, tip-too-low, leader skip, compute exceeded (`src/faults/injector.ts`)
- [ ] Each fault flows detection → classification → agent → resubmission (both logs)
- [ ] **DoD:** ≥2 verified failure cases end-to-end with agent decisions; autonomous resubmission lands for ≥ the blockhash-expiry case.

## Phase 6 — Evidence + writeup · Days 22–25 · owner: `@unassigned`

- [ ] Run ≥10 real bundles (happy path + failures)
- [ ] Export lifecycle log
- [ ] README answers with **measured** numbers (Q1/Q2/Q3)
- [ ] Public architecture document published (separate URL)
- [ ] 3–5 min demo video
- [ ] **DoD:** all PRD §13 acceptance criteria met.

---

## Cross-cutting / ongoing

- [ ] Keep [`ARCHITECTURE.md`](./ARCHITECTURE.md) current (judged separately — build from Phase 1).
- [ ] Keep `.env.example` in sync with `src/config.ts`.
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
