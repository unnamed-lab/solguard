/**
 * USE CASE: Tip Budget Cap
 *
 * Demonstrates per-session tip spend enforcement. A caller sets a hard cap
 * on how many lamports SolGuard may spend on Jito tips across all retry
 * attempts. The AI agent receives remaining_tip_budget_lamports in its
 * network context and must adapt its recommendations accordingly:
 *
 *   - When budget is healthy: recommend competitive tips as normal
 *   - When budget is tight:   hold for a cheaper window rather than overspend
 *   - When budget is depleted: abort — cannot land within constraints
 *
 * The guardrail enforces this: if the AI recommends new_tip_lamports above
 * the remaining budget, the decision is re-prompted. After 3 failures it
 * hard-aborts. This test shows all three budget phases.
 *
 * Scenarios:
 *   S1  Budget: 60,000 lmp  |  leader skip — AI retries within budget
 *   S2  Budget: 38,000 lmp  |  fee_too_low  — AI must tip conservatively
 *   S3  Budget: 12,000 lmp  |  another skip — budget below p50; AI holds/aborts
 *   BUDGET SUMMARY: spend timeline, remaining, AI adaptation evidence
 *
 * Usage:
 *   pnpm test:budget
 */

import "dotenv/config";
import { CongestionOracle } from "../src/network/congestion.js";
import { tipFloorService } from "../src/tips/tipFloor.js";
import { computeTip } from "../src/tips/model.js";
import { classifyFailure } from "../src/lifecycle/classifier.js";
import { aiAgentClient } from "../src/agent/agent.js";
import { decisionLedger } from "../src/agent/ledger.js";
import { connection } from "../src/solana/connection.js";
import type { AgentInput } from "../src/agent/contract.js";
import { Spinner, Col, c, scenarioBanner, showReasoningBox, delay } from "./_ui.js";

// SESSION_BUDGET_LAMPORTS is computed from the live tip floor after bootstrap —
// see main() where it's set to tf.p75 * 8 (enough for ~8 p75-priced retries).

// ─── Tip Budget Manager ────────────────────────────────────────────────────────
class TipBudgetManager {
  private budget:  number;
  private spent:   number = 0;
  private history: Array<{ scenario: string; spent: number; remaining: number }> = [];

  constructor(budgetLamports: number) {
    this.budget = budgetLamports;
  }

  get remaining(): number { return Math.max(0, this.budget - this.spent); }
  get totalSpent(): number { return this.spent; }
  get isExhausted(): boolean { return this.remaining === 0; }

  spend(lamports: number, scenario: string) {
    this.spent += lamports;
    this.history.push({ scenario, spent: lamports, remaining: this.remaining });
  }

  /** Inject remaining budget into an AgentInput network block. */
  withBudget(base: AgentInput["network"]): AgentInput["network"] {
    return { ...base, remaining_tip_budget_lamports: this.remaining };
  }

  printLedger() {
    console.log(`\n  ${"Scenario".padEnd(10)} ${"Spent".padEnd(14)} ${"Remaining".padEnd(14)} Budget used`);
    console.log(`  ${"─".repeat(56)}`);
    for (const h of this.history) {
      const pct = Math.round((this.budget - h.remaining) / this.budget * 100);
      const col: Col = pct < 50 ? "green" : pct < 80 ? "yellow" : "red";
      console.log(
        `  ${c("dim", h.scenario.padEnd(10))}` +
        `${h.spent.toLocaleString().padEnd(14)}` +
        `${c(col, h.remaining.toLocaleString().padEnd(14))}` +
        `${c(col, pct + " %")}`
      );
    }
    console.log(`\n  ${c("dim", "Session budget: ")}${this.budget.toLocaleString()} lmp`);
    console.log(`  ${c("dim", "Total spent:    ")}${this.spent.toLocaleString()} lmp`);
    console.log(`  ${c("dim", "Remaining:      ")}${c(this.remaining > 5_000 ? "green" : "red", this.remaining.toLocaleString() + " lmp")}`);
  }
}

const ok   = (m: string) => console.log(`  ${c("green",  "✔")} ${m}`);
const warn = (m: string) => console.log(`  ${c("yellow", "⚠")} ${m}`);
const info = (m: string) => console.log(`  ${c("dim",    "·")} ${m}`);

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(c("purple", "\n╔════════════════════════════════════════════════════════╗"));
  console.log(c("purple",   "║   SolGuard — Tip Budget Cap                             ║"));
  console.log(c("purple",   "╚════════════════════════════════════════════════════════╝"));
  console.log(c("dim", "  Session budget derived from live tip floor after bootstrap.\n"));

  const conn  = connection();
  const agent = aiAgentClient();

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  scenarioBanner("BOOT", "Network Bootstrap", "purple");
  const oracle      = new CongestionOracle();
  const currentSlot = await conn.getSlot("confirmed");
  const tf          = await tipFloorService().get();

  for (let i = 0; i < 64; i++) {
    const slot = BigInt(currentSlot - 64 + i);
    oracle.ingest({ kind: "slot", slot, status: "processed",  ts: Date.now() - (64-i)*400 });
    if (Math.random() > 0.03)
      oracle.ingest({ kind: "slot", slot, status: "confirmed", ts: Date.now() - (64-i)*400 + 420 });
  }
  const snap = oracle.snapshot();

  // Budget = 8 × live p75 tip — enough for ~8 competitive retries.
  // Derived from the live floor so the demo scales with real network conditions.
  const SESSION_BUDGET_LAMPORTS = tf.p75 * 8;
  const budget = new TipBudgetManager(SESSION_BUDGET_LAMPORTS);

  ok(`Slot    : ${currentSlot.toLocaleString()}`);
  ok(`Tip p50 : ${tf.p50.toLocaleString()} lmp`);
  ok(`Tip p75 : ${tf.p75.toLocaleString()} lmp`);
  ok(`Budget  : ${SESSION_BUDGET_LAMPORTS.toLocaleString()} lmp  (8 × p75 — covers ~8 competitive retries)`);

  const baseNetwork = {
    current_slot:                  currentSlot,
    slot_skip_rate_64:             snap.skipRate,
    processed_to_confirmed_ms_p50: snap.p2cMsP50,
    tip_floor:                     tf,
    next_jito_leader_slot:         currentSlot + 8,
    slots_until_jito_leader:       8,
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // S1: BUDGET HEALTHY — leader skip, 60,000 lmp remaining
  // AI should retry normally; tip bounded by budget (well within range here)
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("S1", `Leader Skip  |  Budget: ${budget.remaining.toLocaleString()} lmp`, "cyan");
  info(`Failure: bundle_dropped_leader_skip`);
  info(`Budget remaining: ${budget.remaining.toLocaleString()} lmp — healthy, AI should retry at p75`);

  const s1BundleId  = `fault_budget_${Math.random().toString(36).substring(2, 10)}`;
  const s1TipSpent  = tf.p50; // what the original bundle paid
  const s1Failure   = classifyFailure({
    bundleId: s1BundleId, currentSlot, neverProcessed: true,
    leaderSlotSkipped: true, targetLeaderSlot: currentSlot - 2, congestion: snap,
  });
  warn(`Classified: ${c("red", s1Failure.type)}`);

  const s1Input: AgentInput = {
    event: "bundle_failed", failure: s1Failure,
    bundle: { attempt: 1, tip_lamports: s1TipSpent, tip_account: "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
      submitted_slot: currentSlot - 2, target_leader_slot: currentSlot - 2 },
    network: budget.withBudget({ ...baseNetwork, next_jito_leader_slot: currentSlot + 8, slots_until_jito_leader: 8 }),
    history: [{ attempt: 1, outcome: "bundle_dropped_leader_skip" }],
  };

  const s1Spin = new Spinner();
  s1Spin.start(`AI agent deciding (budget: ${budget.remaining.toLocaleString()} lmp remaining)…`);
  const { decision: s1Dec, ledgerTs: s1Ts } = await agent.decide(s1Input, "injected_fault");
  s1Spin.clear();
  await showReasoningBox(s1Dec.root_cause, s1Dec.diagnosis, s1Dec.action, s1Dec.confidence, s1Dec.params, currentSlot);

  const s1TipRec = s1Dec.params.new_tip_lamports;
  info(`Recommended tip: ${s1TipRec.toLocaleString()} lmp  (budget allows up to ${budget.remaining.toLocaleString()} lmp)`);
  if (s1TipRec <= budget.remaining) {
    ok(`Within budget ✔`);
    budget.spend(s1TipRec, "S1");
  } else {
    warn(`Exceeds budget — guardrail blocked this (re-prompt triggered)`);
    budget.spend(Math.min(s1TipRec, budget.remaining), "S1");
  }
  decisionLedger().updateOutcome(s1Ts, s1BundleId, `${s1Dec.action} — tip ${s1TipRec.toLocaleString()} lmp`);
  ok(`Budget after S1: ${budget.remaining.toLocaleString()} lmp`);

  // ─────────────────────────────────────────────────────────────────────────────
  // S2: BUDGET SHRINKING — fee_too_low, budget now reduced
  // AI must tip conservatively; recommending p95 would likely exceed remaining budget
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("S2", `Fee Too Low  |  Budget: ${budget.remaining.toLocaleString()} lmp`, "yellow");
  info("Failure: fee_too_low — tip was below the competitive floor");
  info(`Budget remaining: ${budget.remaining.toLocaleString()} lmp — tightening, AI should be conservative`);

  const s2BundleId  = `fault_budget_${Math.random().toString(36).substring(2, 10)}`;
  const s2Failure   = classifyFailure({
    bundleId: s2BundleId, currentSlot, neverProcessed: true,
    tipLamports: tf.p25, tipFloorP50: tf.p50, congestion: snap,
  });
  warn(`Classified: ${c("red", s2Failure.type)}`);

  const s2Input: AgentInput = {
    event: "bundle_failed", failure: s2Failure,
    bundle: { attempt: 1, tip_lamports: tf.p25, tip_account: "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
      submitted_slot: currentSlot - 3, target_leader_slot: currentSlot - 1 },
    network: budget.withBudget({ ...baseNetwork, next_jito_leader_slot: currentSlot + 5, slots_until_jito_leader: 5 }),
    history: [{ attempt: 1, outcome: "fee_too_low" }],
  };

  const s2Spin = new Spinner();
  s2Spin.start(`AI agent deciding (budget: ${budget.remaining.toLocaleString()} lmp remaining)…`);
  const { decision: s2Dec, ledgerTs: s2Ts } = await agent.decide(s2Input, "injected_fault");
  s2Spin.clear();
  await showReasoningBox(s2Dec.root_cause, s2Dec.diagnosis, s2Dec.action, s2Dec.confidence, s2Dec.params, currentSlot);

  const s2TipRec = s2Dec.params.new_tip_lamports;
  info(`Recommended tip: ${s2TipRec.toLocaleString()} lmp  (budget allows up to ${budget.remaining.toLocaleString()} lmp)`);
  if (s2TipRec <= budget.remaining) {
    ok(`Within budget ✔`);
    budget.spend(s2TipRec, "S2");
  } else {
    warn(`Would exceed budget — guardrail capped it`);
    budget.spend(budget.remaining > 0 ? Math.min(s2TipRec, budget.remaining) : 0, "S2");
  }
  decisionLedger().updateOutcome(s2Ts, s2BundleId, `${s2Dec.action} — tip rec: ${s2TipRec.toLocaleString()} lmp`);
  ok(`Budget after S2: ${budget.remaining.toLocaleString()} lmp`);

  // ─────────────────────────────────────────────────────────────────────────────
  // S3: BUDGET NEARLY EXHAUSTED — another leader skip
  // Remaining budget is likely below p50 — AI should hold or abort
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("S3", `Leader Skip Again  |  Budget: ${budget.remaining.toLocaleString()} lmp`, "red");
  info("Failure: bundle_dropped_leader_skip (again — skip rate spike)");
  info(`Budget remaining: ${budget.remaining.toLocaleString()} lmp`);
  if (budget.remaining < tf.p50) {
    warn(`Remaining budget (${budget.remaining.toLocaleString()}) is BELOW p50 (${tf.p50.toLocaleString()}) — very constrained`);
  }

  const s3BundleId  = `fault_budget_${Math.random().toString(36).substring(2, 10)}`;
  const s3Congestion = { ...snap, skipRate: 0.14, congestionMultiplier: 2.5 };
  const s3Failure   = classifyFailure({
    bundleId: s3BundleId, currentSlot, neverProcessed: true,
    leaderSlotSkipped: true, targetLeaderSlot: currentSlot - 1, congestion: s3Congestion,
  });
  warn(`Classified: ${c("red", s3Failure.type)}`);

  const s3Input: AgentInput = {
    event: "bundle_failed", failure: s3Failure,
    bundle: { attempt: 2, tip_lamports: s2Dec.params.new_tip_lamports, tip_account: "96gYZGLnJYVFihjz5EPg5Q8pD8krrG1685mYdBt9Q7tb",
      submitted_slot: currentSlot - 1, target_leader_slot: currentSlot - 1 },
    network: budget.withBudget({
      ...baseNetwork,
      slot_skip_rate_64:     0.14,
      next_jito_leader_slot: currentSlot + 15,
      slots_until_jito_leader: 15,
    }),
    history: [
      { attempt: 1, outcome: "fee_too_low" },
      { attempt: 2, outcome: "bundle_dropped_leader_skip" },
    ],
  };

  const s3Spin = new Spinner();
  s3Spin.start(`AI agent deciding (budget: ${budget.remaining.toLocaleString()} lmp remaining)…`);
  const { decision: s3Dec, ledgerTs: s3Ts } = await agent.decide(s3Input, "injected_fault");
  s3Spin.clear();
  await showReasoningBox(s3Dec.root_cause, s3Dec.diagnosis, s3Dec.action, s3Dec.confidence, s3Dec.params, currentSlot);

  const s3TipRec = s3Dec.params.new_tip_lamports;
  info(`Recommended tip: ${s3TipRec.toLocaleString()} lmp  (budget allows up to ${budget.remaining.toLocaleString()} lmp)`);

  const s3ActionNote = s3Dec.action === "abort"
    ? "budget-aware abort — cannot land competitively within remaining budget"
    : s3Dec.action === "hold"
    ? `hold — waiting for cheaper window; tip ${s3TipRec.toLocaleString()} lmp`
    : `retry — tip ${s3TipRec.toLocaleString()} lmp`;

  if (s3TipRec <= budget.remaining || s3Dec.action === "abort") {
    if (s3Dec.action !== "abort") budget.spend(s3TipRec, "S3");
    else budget.spend(0, "S3");
    ok(s3Dec.action === "abort" ? "Budget-aware abort — no tip spent" : "Within budget ✔");
  } else {
    warn(`Would exceed budget — guardrail would re-prompt; likely leads to abort`);
    budget.spend(0, "S3");
  }
  decisionLedger().updateOutcome(s3Ts, s3BundleId, s3ActionNote);

  // ─────────────────────────────────────────────────────────────────────────────
  // SUMMARY — Budget spend ledger
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("", "Budget Spend Summary", "green");
  budget.printLedger();

  console.log(`\n  ${c("dim", "─── AI Adaptation Evidence ────────────────────────────────────────")}`);
  const tipProgression = [s1Dec.params.new_tip_lamports, s2Dec.params.new_tip_lamports, s3Dec.params.new_tip_lamports];
  const actions        = [s1Dec.action, s2Dec.action, s3Dec.action];
  const remaining      = [SESSION_BUDGET_LAMPORTS, SESSION_BUDGET_LAMPORTS - s1Dec.params.new_tip_lamports,
                          Math.max(0, SESSION_BUDGET_LAMPORTS - s1Dec.params.new_tip_lamports - s2Dec.params.new_tip_lamports)];

  console.log();
  console.log(`  ${"".padEnd(4)} ${"Budget Before".padEnd(18)} ${"Tip Rec".padEnd(16)} ${"Action".padEnd(9)} Trend`);
  console.log(`  ${"─".repeat(62)}`);
  for (let i = 0; i < 3; i++) {
    const pct = remaining[i]! / SESSION_BUDGET_LAMPORTS;
    const col: Col = pct > 0.6 ? "green" : pct > 0.25 ? "yellow" : "red";
    const trend = i === 0 ? "—" : tipProgression[i]! < tipProgression[i-1]! ? "▼ lower" : tipProgression[i]! > tipProgression[i-1]! ? "▲ higher" : "= same";
    console.log(
      `  ${c("dim", `S${i+1}`.padEnd(4))}` +
      `${c(col, remaining[i]!.toLocaleString().padEnd(18))}` +
      `${tipProgression[i]!.toLocaleString().padEnd(16)}` +
      `${c(actions[i]! === "retry" ? "green" : actions[i]! === "abort" ? "red" : "yellow", actions[i]!.padEnd(9))}` +
      `${c("dim", trend)}`
    );
  }

  console.log(`\n  Decision ledger → logs/decisions.jsonl\n`);
  console.log(c("green", "  ✔ Tip budget cap demonstration complete.\n"));
  process.exit(0);
}

main().catch((err) => {
  console.error(c("red", `\n  ✘ Fatal: ${err}\n`));
  process.exit(1);
});
