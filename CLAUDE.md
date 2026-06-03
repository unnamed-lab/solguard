# CLAUDE.md — guidance for AI coding assistants in this repo

This file is read by Claude Code (and similar agents) working in the SolGuard
codebase. Humans should read it too — it encodes the non-negotiable rules that
win or lose this bounty.

## What this project is

SolGuard is a smart Solana transaction stack: a Yellowstone stream as the
source of truth, dynamic Jito tipping, full lifecycle tracking, failure
classification, and an AI agent that owns the retry-under-fault decision.
Read [`PRD.md`](./PRD.md) and [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)
before making non-trivial changes.

## Hard rules (violating any of these can disqualify the submission)

1. **No hardcoded tip values — ever.** Every tip is derived from live
   `tip_floor` data. `TIP_CEILING_LAMPORTS` is a safety rail, not a tip. CI
   guard: `pnpm lint:tips`. If a numeric literal is genuinely safe, annotate
   the line with `// no-hardcoded-tip-ok` and explain why.
2. **Stream is the source of truth for landing.** Confirm landing from the
   Yellowstone tx stream first; Jito bundle-status APIs are _reconciliation
   only_, never the sole confirmation.
3. **The AI agent must not become dressed-up `if/else`.** It receives a
   structured input context and returns strict JSON. Log the full input,
   raw reasoning, validated decision, and outcome to the decision ledger.
   Behavior must visibly vary across network conditions.
4. **Correct commitment usage.** Fetch blockhash at `confirmed`, never
   `finalized`, for time-sensitive submission. Observe all commitment levels
   on the slot stream (`filterByCommitment: false`).
5. **No secrets in the repo.** All config via env (`.env`, gitignored).
6. **Append-only logs.** `logs/*.jsonl` are immutable audit trails; slots must
   reconcile with public explorers.

## Conventions

- **Language/runtime:** TypeScript, ESM (`"type": "module"`), Node ≥20.
- **Package manager:** `pnpm` only. Do not add `package-lock.json` / `yarn.lock`.
- **Imports:** use `.js` extensions in relative imports (ESM + bundler resolution).
- **Logging:** use `logger(scope)` from `src/util/log.ts`; structured JSON, no `console.log` in library code.
- **Config:** read everything through `src/config.ts`; never read `process.env` directly elsewhere.
- **Errors:** never swallow silently. Dropped events are _counted and surfaced_ (NFR-2).
- **Separation of concerns:** the AI layer, the core stack, and failure handling
  are clean boundaries (NFR-5). The agent never calls Jito directly; the core
  never embeds decision heuristics.

## Before you commit

```bash
pnpm typecheck      # must pass
pnpm lint:tips      # must pass
```

- Small, focused commits. Conventional-commit style (`feat:`, `fix:`, `chore:`, `docs:`).
- Update [`TASK.md`](./TASK.md) checkboxes when you complete a phase item.
- Don't commit `node_modules/`, `dist/`, `.env`, wallets, or `logs/*.jsonl`.

## Where things live

See the repository layout in [`README.md`](./README.md) and component detail in
[`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) §5. The AI agent's contract
and guardrail rules are in [`AGENT.md`](./AGENT.md).

## Verification (judges will do this)

- Slot numbers in lifecycle logs are cross-checked on a Solana explorer.
- `pnpm lint:tips` is run to confirm no hardcoded tips.
- Reconnect is tested by killing the stream mid-run (replay + dedupe must hold).
- Agent decisions are inspected for input-grounded reasoning and behavior variance.
