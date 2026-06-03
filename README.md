# SolGuard — Autonomous Bundle Intelligence Stack

> A traffic-aware GPS for Solana transactions. SolGuard watches the network in
> real time, submits Jito bundles only into valid leader windows, prices tips
> dynamically from live data, tracks every transaction across all commitment
> levels, classifies failures, and uses an **AI agent** to own the
> retry-under-fault decision with fully auditable reasoning.

**Bounty:** Advanced Infrastructure Challenge — Build a Smart Transaction Stack (Superteam Nigeria)
**Docs:** [`PRD.md`](./PRD.md) · [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`AGENT.md`](./AGENT.md) · [`TASK.md`](./TASK.md)

---

## What it does

| Capability               | How                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Watches the network live | Yellowstone gRPC slot/tx stream (source of truth for landing)                       |
| Picks the right moment   | Leader-window detector submits only into Jito leader windows                        |
| Pays the right tip       | Tip derived from live `tip_floor` × congestion multiplier — **zero hardcoded tips** |
| Tracks what happened     | Four-stage lifecycle (submitted → processed → confirmed → finalized) with deltas    |
| Knows why it failed      | Failure classifier (expired blockhash, fee too low, compute, leader skip, sim fail) |
| Decides what to do next  | AI agent (Claude) returns strict-JSON retry decisions, guardrailed + logged         |

---

## Architecture (overview)

```
Yellowstone gRPC ─▶ Stream Manager ─▶ ┬─▶ Congestion Oracle ─┐
 (reconnect/replay/dedupe/backpressure)├─▶ Leader Detector    ├─▶ AI Agent ─▶ Bundle Builder ─▶ Jito Block Engine
                                       └─▶ Lifecycle Tracker ─┘   (guardrail)   (dynamic tip)
                                                                       │
                                              Decision Ledger + Lifecycle Log (append-only JSONL)
```

Full detail: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## Quick start

> Package manager: **pnpm** (≥9). Node ≥20.

```bash
pnpm install
cp .env.example .env      # then fill in credentials
pnpm typecheck            # verify the build
pnpm stream               # Phase 0: live slot stream + resilience probe
pnpm start                # orchestrator entrypoint
```

### Required credentials (`.env`)

- `RPC_HTTP_URL` — Solana RPC (blockhash, leader schedule, tip accounts)
- `YELLOWSTONE_GRPC_URL` + `YELLOWSTONE_X_TOKEN` — Geyser stream
- `JITO_BLOCK_ENGINE_URL` — regional Jito endpoint
- `WALLET_SECRET_KEY` — minimal hot wallet (Phase 2+)
- `ANTHROPIC_API_KEY` — AI agent (Phase 4+)

See [`.env.example`](./.env.example) for the full annotated list.

---

## Project status

Tracked phase-by-phase in [`TASK.md`](./TASK.md). Current: **Phase 0 — Foundations** (resilient Stream Manager).

---

## The three required questions

> Answers are filled with **measured numbers from our running system** before submission. Drafts live in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) §9.

**Q1 — What does the delta between `processed_at` and `confirmed_at` tell you about network health?**
_Measured: p50 ≈ `TBD` ms, p95 ≈ `TBD` ms; correlated with a slot-skip rate of `TBD`._
It measures how long the cluster took to reach supermajority vote on the block containing the transaction. A small delta indicates healthy, fast voting and low fork pressure; a large/widening delta indicates vote latency, fork churn, or validator degradation.

**Q2 — Why never use `finalized` commitment when fetching a blockhash for a time-sensitive transaction?**
A blockhash is valid for ~150 slots (~60s). `finalized` lags `confirmed` by ~32 slots (~13s), so fetching at finalized burns ~1/5 of the validity window before you submit. We fetch at `confirmed` to maximize usable validity while avoiding the revert risk of `processed`.

**Q3 — What happens to your bundle if the Jito leader skips their slot?**
The bundle is dropped — bundles are only processed while the scheduled Jito-Solana leader is producing; standard validators do not execute or forward them. We detect the skip from the slot stream, classify it as a bundle drop, and the agent resubmits targeting the next scheduled Jito leader window.

---

## Repository layout

```
src/
  stream/      Stream Manager: connect, reconnect, replay, dedupe, ping, bounded queue
  network/     Congestion Oracle + Leader Window Detector
  tips/        tip_floor fetch + dynamic tip model (no hardcoded values)
  bundle/      Bundle builder + submitter + status reconciliation
  lifecycle/   4-stage tracker + failure classifier
  agent/       Contract, Anthropic call, guardrail, decision ledger
  faults/      Deterministic fault injector
  dashboard/   Terminal UI
  index.ts     Orchestrator
scripts/       CI guards (e.g. no-hardcoded-tips)
logs/          Append-only lifecycle.jsonl + decisions.jsonl (generated)
```

---

## License

MIT (see `LICENSE`).
