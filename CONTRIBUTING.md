# Contributing to SolGuard

Team workflow for the bounty build. Keep it lightweight but disciplined — the
audit trail (logs, commits, docs) is part of what judges evaluate.

## Setup

```bash
pnpm install
cp .env.example .env   # fill in your own credentials — never commit .env
pnpm typecheck
```

Requires **Node ≥20** and **pnpm ≥9**. Do not use npm/yarn (no competing lockfiles).

## Branching

- `main` is always green (typecheck + lint:tips pass).
- Branch per task: `feat/stream-reconnect`, `fix/tip-ceiling`, `docs/architecture`.
- Reference the [`TASK.md`](./TASK.md) item in the PR description.

## Commits

Conventional commits:

```
feat: dynamic tip model from tip_floor percentiles
fix: dedupe replayed slots after reconnect
chore: bump yellowstone-grpc
docs: architecture diagram for lifecycle tracker
```

Small, focused commits. Don't mix refactors with features.

## Before opening a PR

```bash
pnpm typecheck      # must pass
pnpm lint:tips      # must pass — no hardcoded tip values
```

- Update [`TASK.md`](./TASK.md) checkboxes for anything you finished.
- If you touched the AI agent, re-read [`AGENT.md`](./AGENT.md) and keep the
  anti-disqualification checklist satisfied.
- If you added config, update both `src/config.ts` **and** `.env.example`.

## Code review checklist (the bounty-critical bits)

- [ ] No hardcoded tip values (CI `lint:tips` green).
- [ ] Landing confirmed from the **stream**, not polling alone.
- [ ] Blockhash fetched at `confirmed`, never `finalized`.
- [ ] Dropped events counted + surfaced, never silent.
- [ ] No secrets committed.
- [ ] Agent changes preserve input-grounded reasoning + ledger logging.

## Never commit

`node_modules/`, `dist/`, `.env`, `*.key`, `wallet*.json`, `logs/*.jsonl`.

## Communication

- Claim a [`TASK.md`](./TASK.md) item by putting your `@handle` as its owner.
- Surface blockers early — especially missing credentials (Yellowstone, Jito,
  Anthropic, funded wallet), which gate Phases 0/2/4.
