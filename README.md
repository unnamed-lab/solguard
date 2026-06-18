# SolGuard — Autonomous Bundle Intelligence Stack

> A traffic-aware GPS for Solana transactions. SolGuard watches the network in
> real time, submits Jito bundles only into valid leader windows, prices tips
> dynamically from live data, tracks every transaction across all commitment
> levels, classifies failures, and uses an **AI agent** to own the
> retry-under-fault decision with fully auditable reasoning.

SolGuard ships as two things at once:
- **Infrastructure / SDK** — a `SolGuard` class developers import into their trading bot, DEX aggregator, or NFT tool. They call `submit(tx)` and get back a landing result + full lifecycle. The stack handles tipping, bundling, confirmation, AI retry.
- **Demo dashboard** — a terminal UI (`pnpm start`) that visualises the running stack for judges and ops teams. It is the _window into_ the infrastructure, not the product itself.

**Bounty:** Advanced Infrastructure Challenge — Build a Smart Transaction Stack (Superteam Nigeria)  
**Architecture Document (public URL):** [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system components, data flow, failure taxonomy, AI agent responsibilities, commitment-level strategy, and ASCII diagrams  
**Docs:** [`PRD.md`](./PRD.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) · [`AGENT.md`](./AGENT.md)

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
| Exposes it as infra      | Programmatic `SolGuard` SDK class + HTTP API server (`POST /submit`, `GET /health`) |

---

## Architecture (overview)

```
Yellowstone gRPC ─▶ Stream Manager ─▶ ┬─▶ Congestion Oracle ──┐
 (reconnect/replay/dedupe/backpressure)├─▶ Leader Detector      ├─▶ AI Agent ─▶ Bundle Builder ─▶ Jito Block Engine
                                        └─▶ Lifecycle Tracker ──┘  (guardrail)   (dynamic tip)
                                                                          │
                                               Decision Ledger + Lifecycle Log (append-only JSONL)
                                                                          │
                                          SolGuard SDK / HTTP API (src/sdk, src/server.ts)
```

Full detail (components, data flow, failure taxonomy, commitment strategy): [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---


## Developer integration

The real consumers of SolGuard are developers — trading bots, DEX aggregators, NFT minters — who need transactions to land reliably without building retry/tip/confirmation infrastructure themselves.

### As a library (import)

```typescript
import { SolGuard } from './src/index.js';

const guard = new SolGuard(); // reads WALLET_SECRET_KEY + credentials from env
await guard.start();           // connects Yellowstone stream, warms up oracle

// Pass instructions, unsigned tx, or a pre-signed base64 tx:
const result = await guard.submit([myTransferInstruction]);

if (result.landed) {
  console.log(`Landed at slot ${result.slot} — sig ${result.signature}`);
} else {
  console.error(`Failed: ${result.error}`);
  // result.lifecycle has every stage, delta, and AI decision recorded
}
```

**What `submit()` accepts:**

| Input | SolGuard behaviour |
|---|---|
| `TransactionInstruction[]` | Compiles, signs with `WALLET_SECRET_KEY`, auto-refreshes blockhash on retry |
| `VersionedTransaction` / `Transaction` (unsigned) | Signs with `WALLET_SECRET_KEY`, auto-refreshes |
| Pre-signed transaction (browser wallet) | Sends as-is; aborts with clear error if blockhash refresh needed (can't re-sign) |
| Base64 / Base58 string | Deserializes then routes as above |

### As an HTTP API

```bash
# Start the API server
pnpm server            # production
pnpm server:watch      # hot-reload
PORT=3500 pnpm server  # custom port

# Submit a transaction
curl -X POST http://localhost:3000/submit \
  -H "content-type: application/json" \
  -d '{"transaction": "<base64-encoded-tx>", "urgency": "high"}'

# Health check (Render / Railway / Fly.io compatible)
curl http://localhost:3000/health
# → {"status":"healthy","initialized":true,"streamMetrics":{...},"congestion":{...}}
```

---

## Quick start

> Package manager: **pnpm** (≥9). Node ≥20.

```bash
pnpm install
cp .env.example .env      # then fill in credentials
pnpm typecheck            # verify the build

# Demo / judge view
pnpm start                # terminal dashboard (stream + congestion + bundles live)
pnpm live --submit        # full live pipeline with real submissions (spends SOL)

# Developer integration
pnpm server               # HTTP API server  POST /submit  GET /health
pnpm server:watch         # hot-reload dev mode

# Testing / validation
pnpm stream               # raw stream probe
pnpm bundle:dry           # build + sign bundle, no submission
pnpm fault:test           # end-to-end fault injection (offline mock)
pnpm fault:test:evidence  # same, but requires live ANTHROPIC_API_KEY
pnpm test                 # unit tests (54 tests)
pnpm lint:tips            # no-hardcoded-tip guard

# Use-case test harnesses (require live ANTHROPIC_API_KEY + funded wallet)
pnpm test:agent           # 4 mainnet fault scenarios with AI reasoning box
pnpm test:trading         # 5 trader scenarios: swap, slippage, leader skip, fee low
pnpm test:requote         # Re-quote retry loop: slippage failure → fresh price → land
pnpm test:sniper          # Token launch sniper: pool detection → quote → bundle race
pnpm test:budget          # Tip budget cap: AI adapts as session budget shrinks
pnpm test:sandwich        # MEV sandwich protection: public TX risk vs bundle privacy
```

### Required credentials (`.env`)

- `RPC_HTTP_URL` — Solana RPC (blockhash, leader schedule, tip accounts)
- `YELLOWSTONE_GRPC_URL` + `YELLOWSTONE_X_TOKEN` — Geyser stream
- `JITO_BLOCK_ENGINE_URL` — regional Jito endpoint
- `WALLET_SECRET_KEY` — minimal hot wallet (Phase 2+)
- `ANTHROPIC_API_KEY` — AI agent (Phase 4+)

See [`.env.example`](./.env.example) for the full annotated list.

---

## Test Harnesses

Six executable test harnesses demonstrate every layer of the stack against live mainnet data. Each uses real Anthropic AI calls, real Jito bundle submissions, and live tip floor pricing — no mocks.

| Command | What it tests | Real SOL spent |
|---|---|---|
| `pnpm test:agent` | 4 mainnet fault scenarios (happy path, blockhash expired, fee too low, compute exceeded). AI reasoning shown via typewriter box. | < 0.001 SOL (tip only) |
| `pnpm test:trading` | 5 trader scenarios through a Jupiter swap stack: happy swap, stale quote, slippage exceeded, leader skip, launch rush. | S1 only: ~0.003 SOL |
| `pnpm test:requote` | Slippage failure lifecycle: initial quote → `simulation_failed` injected → AI classifies → re-quote at 200 bps + fresh price → resubmit. Demonstrates that SolGuard re-quotes rather than blindly aborting. | ~0.004 SOL (if balance ≥ 0.01) |
| `pnpm test:sniper` | Token launch sniper pipeline: synthetic pool creation event fires → Jupiter quote fetched → bundle assembled → submitted to Jito. Measures detection-to-submission latency in ms and slot delta. Shows why same-slot or +1 slot submission wins a launch. | ~0.002 SOL |
| `pnpm test:budget` | Per-session tip budget enforcement. Session budget is derived from `tf.p75 × 8` (live floor, no hardcoded values). Three consecutive failures progressively drain the budget; AI agent receives `remaining_tip_budget_lamports` in every decision context and must adapt — tip conservatively when budget tightens, hold or abort when exhausted. Guardrail re-prompts if AI recommends a tip above the remaining budget. | None (fault injection only) |
| `pnpm test:sandwich` | MEV sandwich protection comparison. Quotes a real SOL → JUP swap, models sandwich profitability (MEV extractable ≈ price impact × trade size × 0.5), animates the frontrun/backrun attack sequence for the public TX path, then submits the identical swap as a SolGuard Jito bundle. Side-by-side table shows tokens received, MEV loss, and net protection benefit vs tip cost. | ~0.006 SOL (if balance ≥ 0.012) |

All test harnesses print a live spinner while the AI agent thinks, then reveal the full reasoning via a typewriter box showing diagnosis, action, confidence, and exact params used.

---

## Project status

Tracked phase-by-phase in [`TASK.md`](./TASK.md). All core phases complete and verified on mainnet-beta:
- **Stream** — Yellowstone gRPC connected, slot replay, backpressure, reconnect
- **Network** — Congestion oracle (64-slot window), Jito leader detector
- **Tips** — Live floor fetch + congestion-multiplied dynamic tip, zero hardcoded values
- **Bundle** — Jito block engine submission; RPC fallback on `Invalid` detection (< 2 s)
- **Lifecycle** — 4-stage tracker (processed → confirmed → finalized), measured on-chain
- **AI Agent** — DeepSeek / Claude retry decisions, strict-JSON guardrail, decision ledger
- **API** — `POST /submit`, `GET /health`, WebSocket + SSE bridge for live dashboard

---

## Lifecycle Log

The stack records every bundle submission to append-only JSONL files in `logs/`:

| File | Contents |
|---|---|
| `logs/lifecycle.jsonl` | One JSON object per bundle: `bundle_id`, `signatures`, `tip_lamports`, `stages` (slot + timestamp for submitted / processed / confirmed / finalized), `deltas_ms`, `failure` classification, `confirmed_via` |
| `logs/decisions.jsonl` | One JSON object per AI agent decision: input context, decision (retry/hold/abort), confidence, diagnosis, params |

**Verification:** All `bundle_id` and `signatures` fields from real mainnet runs (slot range 427,224,198 – 427,280,xxx) can be looked up on [Solscan](https://solscan.io) or via the [Jito bundle explorer](https://explorer.jito.wtf). Each entry includes the `tip_account` (one of the 8 official Jito tip addresses) and the Jito regional block-engine URL used.

`confirmed_via: "stream"` entries prove that confirmation came from the Yellowstone tx subscription, not RPC polling alone.

---

## The three required questions

**Q1 — What does the delta between `processed_at` and `confirmed_at` tell you about network health?**
_Measured live on mainnet-beta (slot 427,230,617, 2026-06-18): processed → confirmed = **432 ms** at a skip rate of ~0% (healthy window). Our congestion oracle accumulates this delta in a 64-sample rolling window; p50 rises to ~800 ms+ and the multiplier escalates tip recommendations when the network is under stress._

It measures how long the cluster took to reach supermajority vote on the block containing the transaction. A small delta (< 500 ms) indicates healthy, fast voting and low fork pressure; a large/widening delta indicates vote latency, fork churn, or validator degradation. SolGuard surfaces this as `pcDelta` in real time and adjusts the tip tier accordingly.

**Q2 — Why never use `finalized` commitment when fetching a blockhash for a time-sensitive transaction?**
A blockhash is valid for ~150 slots (~60s). `finalized` lags `confirmed` by ~32 slots (~13s), so fetching at finalized burns ~1/5 of the validity window before you submit. We fetch at `confirmed` to maximize usable validity while avoiding the revert risk of `processed`.

**Q3 — What happens to your bundle if the Jito leader skips their slot?**
The bundle is dropped — bundles are only processed while the scheduled Jito-Solana leader is producing; standard validators do not execute or forward them. We detect the skip from the slot stream, classify it as a bundle drop, and the agent resubmits targeting the next scheduled Jito leader window.

---

## Repository layout

```
src/
  sdk/
    solguard.ts  SolGuard class — programmatic API for developers (submit, start, stop, status)
  stream/        Stream Manager: connect, reconnect, replay, dedupe, ping, bounded queue
  network/       Congestion Oracle + Leader Window Detector
  tips/          tip_floor fetch + dynamic tip model (no hardcoded values)
  bundle/        Bundle builder + submitter + status reconciliation
  lifecycle/     4-stage tracker + failure classifier
  agent/         Contract, Anthropic call, guardrail, decision ledger
  faults/        Deterministic fault injector
  dashboard/     Terminal UI (demo / ops view)
  server.ts      HTTP API server  POST /submit  GET /health
  index.ts       Exports SolGuard SDK; runs terminal dashboard when executed directly
  live.ts        Full live pipeline with real submissions (pnpm live --submit)
scripts/         CI guards (no-hardcoded-tips) + fault-test harness
logs/            Append-only lifecycle.jsonl + decisions.jsonl (generated)
```

---

## License

MIT (see `LICENSE`).
