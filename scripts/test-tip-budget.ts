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
 * Usage:
 *   pnpm test:budget
 */

import "dotenv/config";
import { SystemProgram } from "@solana/web3.js";
import { tipFloorService } from "../src/tips/tipFloor.js";
import { connection, wallet } from "../src/solana/connection.js";
import { Spinner, Col, c, scenarioBanner, delay, submitTransaction } from "./_ui.js";

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

async function main() {
  console.log(c("purple", "\n╔════════════════════════════════════════════════════════╗"));
  console.log(c("purple",   "║   SolGuard — Tip Budget Cap                             ║"));
  console.log(c("purple",   "╚════════════════════════════════════════════════════════╝"));
  console.log(c("dim", "  Session budget derived from live tip floor after bootstrap.\n"));

  const conn  = connection();
  const payer = wallet();

  scenarioBanner("BOOT", "Network Bootstrap", "purple");
  const currentSlot = await conn.getSlot("confirmed");
  const tf          = await tipFloorService().get();

  const SESSION_BUDGET_LAMPORTS = tf.p75 * 8;
  const budget = new TipBudgetManager(SESSION_BUDGET_LAMPORTS);

  ok(`Slot    : ${currentSlot.toLocaleString()}`);
  ok(`Tip p50 : ${tf.p50.toLocaleString()} lmp`);
  ok(`Tip p75 : ${tf.p75.toLocaleString()} lmp`);
  ok(`Budget  : ${SESSION_BUDGET_LAMPORTS.toLocaleString()} lmp  (8 × p75 — covers ~8 competitive retries)`);

  const dummyIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey:   payer.publicKey,
    lamports:   0,
  });

  // ─── S1: BUDGET HEALTHY ───────────────────────────────────────────────────
  scenarioBanner("S1", `Leader Skip  |  Budget: ${budget.remaining.toLocaleString()} lmp`, "cyan");
  info("Submitting via API with leader_skip simulation...");
  const s1Result = await submitTransaction(
    [dummyIx], conn, payer, {
      urgency: "high",
      customTipLamports: tf.p50,
      simulateFault: "leader_skip",
      remainingTipBudgetLamports: budget.remaining,
    }
  );
  if (s1Result.landed) {
    const tipSpent = s1Result.lifecycle.tip_lamports;
    ok(`Confirmed on retry ✔`);
    budget.spend(tipSpent, "S1");
  } else {
    warn(`Submission failed: ${s1Result.error}`);
  }
  ok(`Budget after S1: ${budget.remaining.toLocaleString()} lmp`);

  // ─── S2: BUDGET SHRINKING ─────────────────────────────────────────────────
  scenarioBanner("S2", `Fee Too Low  |  Budget: ${budget.remaining.toLocaleString()} lmp`, "yellow");
  info("Submitting via API with fee_too_low simulation...");
  const s2Result = await submitTransaction(
    [dummyIx], conn, payer, {
      urgency: "high",
      customTipLamports: tf.p25,
      simulateFault: "fee_too_low",
      remainingTipBudgetLamports: budget.remaining,
    }
  );
  if (s2Result.landed) {
    const tipSpent = s2Result.lifecycle.tip_lamports;
    ok(`Confirmed on retry ✔`);
    budget.spend(tipSpent, "S2");
  } else {
    warn(`Submission failed: ${s2Result.error}`);
  }
  ok(`Budget after S2: ${budget.remaining.toLocaleString()} lmp`);

  // ─── S3: BUDGET NEARLY EXHAUSTED ───────────────────────────────────────────
  scenarioBanner("S3", `Leader Skip Again  |  Budget: ${budget.remaining.toLocaleString()} lmp`, "red");
  info("Submitting via API with leader_skip simulation...");
  const s3Result = await submitTransaction(
    [dummyIx], conn, payer, {
      urgency: "high",
      customTipLamports: tf.p50,
      simulateFault: "leader_skip",
      remainingTipBudgetLamports: budget.remaining,
    }
  );

  if (s3Result.landed) {
    const tipSpent = s3Result.lifecycle.tip_lamports;
    ok(`Unexpected confirmation: transaction landed within budget! Spent: ${tipSpent}`);
    budget.spend(tipSpent, "S3");
  } else {
    ok(`Aborted by AI Agent as expected (insufficient budget)! Error: ${s3Result.error}`);
    budget.spend(0, "S3");
  }

  // ─── SUMMARY ───────────────────────────────────────────────────────────────
  scenarioBanner("", "Budget Spend Summary", "green");
  budget.printLedger();

  console.log(c("green", "\n  ✔ Tip budget cap demonstration complete.\n"));
  process.exit(0);
}

main().catch((err) => {
  console.error(c("red", `\n  ✘ Fatal: ${err}\n`));
  process.exit(1);
});
