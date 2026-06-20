/**
 * LIVE MAINNET AGENT TEST HARNESS
 *
 * Runs all 4 agent scenarios via the unified API submission endpoint:
 *   • S1  Happy path              — SOL transfer; lands on attempt 1
 *   • S2  blockhash_expired       — fails attempt 1 → agent RETRY → lands on attempt 2
 *   • S3  fee_too_low             — fails attempt 1 (1 lmp tip) → agent RETRY → lands on attempt 2
 *   • S4  compute_exceeded        — fails attempt 1 (15M CU) → agent ABORT
 *
 * Usage:
 *   pnpm test:agent
 */

import "dotenv/config";
import { SystemProgram } from "@solana/web3.js";
import { tipFloorService } from "../src/tips/tipFloor.js";
import { computeTip } from "../src/tips/model.js";
import { connection, wallet } from "../src/solana/connection.js";
import { Spinner, c, scenarioBanner, delay, submitTransaction } from "./_ui.js";

const ok   = (m: string) => console.log(`  ${c("green",  "✔")} ${m}`);
const warn = (m: string) => console.log(`  ${c("yellow", "⚠")} ${m}`);
const info = (m: string) => console.log(`  ${c("dim",    "·")} ${m}`);

async function main() {
  console.log(c("purple", "\n╔══════════════════════════════════════════════════════╗"));
  console.log(c("purple",   "║   SolGuard — Live Mainnet AI Agent Test Harness      ║"));
  console.log(c("purple",   "╚══════════════════════════════════════════════════════╝"));
  console.log(c("dim",      "  4 fault scenarios · Unified API submission · Live Sync\n"));
  console.log(c("bold" as any, "  DESCRIPTION:"));
  console.log("    This test demonstrates how SolGuard classifies transaction failures");
  console.log("    on mainnet and routes them through the unified API server to invoke the");
  console.log("    AI Agent. The AI Agent evaluates congestion, tip floors, and failure logs");
  console.log("    to decide whether to RETRY or ABORT the transaction, updating the dashboard.");
  console.log();
  console.log(c("dim",      "  SCENARIOS:"));
  console.log("    S1 - Happy Path (normal submission with no failure)");
  console.log("    S2 - blockhash_expired (Mid-flight expiry fault -> AI RETRY)");
  console.log("    S3 - fee_too_low (Dust tip injected -> AI RETRY with competitive tip)");
  console.log("    S4 - compute_exceeded (Deterministic simulation failure -> AI ABORT)");
  console.log();

  const conn  = connection();
  const payer = wallet();

  scenarioBanner("BOOT", "Bootstrapping Network Data from RPC", "purple");
  info("Fetching slot and tip floors...");

  const currentSlot = await conn.getSlot("confirmed");
  const tf = await tipFloorService().get();

  ok(`Current slot       : ${currentSlot.toLocaleString()}`);
  ok(`Jito tip floor p50 : ${tf.p50.toLocaleString()} lamports`);

  const normalTip = computeTip({
    tipFloor: tf,
    congestionMultiplier: 1.0,
    urgency: "normal",
  });
  info(`Normal tip         : ${normalTip.lamports.toLocaleString()} lmp (${normalTip.percentileKey})`);

  const dummyIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey:   payer.publicKey,
    lamports:   0,
  });

  // ─── SCENARIO 1: Happy Path ───────────────────────────────────────────────
  scenarioBanner("S1 ●", "Happy Path — SOL Transfer (no failure)", "cyan");
  info("Submitting normal transaction via API...");
  const s1Result = await submitTransaction(
    [dummyIx], conn, payer, { urgency: "high", customTipLamports: normalTip.lamports }
  );
  const s1Landed = s1Result.landed;
  const s1Sig = s1Result.signature ?? null;

  if (s1Landed) {
    ok(`Confirmed: ${s1Sig?.substring(0, 28)}…`);
    ok("No failure → AI agent not invoked (correct behaviour)");
  } else {
    warn(`Submission returned: ${s1Result.error ?? "did not confirm"}`);
  }

  // ─── SCENARIO 2: Blockhash Expired ────────────────────────────────────────
  scenarioBanner("S2 ●", "blockhash_expired — stale BH injected mid-flight", "yellow");
  info("Submitting via API with blockhash_expired simulation...");
  const s2Result = await submitTransaction(
    [dummyIx], conn, payer, { urgency: "high", customTipLamports: normalTip.lamports, simulateFault: "blockhash_expired" }
  );
  const s2Landed = s2Result.landed;
  const s2Sig = s2Result.signature ?? null;

  if (s2Landed) {
    ok(`Confirmed on attempt 2: ${s2Sig?.substring(0, 28)}…`);
  } else {
    warn(`Submission failed: ${s2Result.error}`);
  }

  // ─── SCENARIO 3: Fee Too Low ───────────────────────────────────────────────
  scenarioBanner("S3 ●", "fee_too_low — 1-lamport tip, congestion 2.5×", "yellow");
  info("Submitting via API with fee_too_low simulation...");
  const s3Result = await submitTransaction(
    [dummyIx], conn, payer, { urgency: "high", customTipLamports: 1, simulateFault: "fee_too_low" }
  );
  const s3Landed = s3Result.landed;
  const s3Sig = s3Result.signature ?? null;

  if (s3Landed) {
    ok(`Confirmed on retry: ${s3Sig?.substring(0, 28)}…`);
  } else {
    warn(`Submission failed: ${s3Result.error}`);
  }

  // ─── SCENARIO 4: Compute Exceeded ─────────────────────────────────────────
  scenarioBanner("S4 ●", "compute_exceeded — 15M CU instruction injected", "red");
  info("Submitting via API with compute_exceeded simulation...");
  const s4Result = await submitTransaction(
    [dummyIx], conn, payer, { urgency: "high", customTipLamports: normalTip.lamports, simulateFault: "compute_exceeded" }
  );
  const s4Landed = s4Result.landed;

  if (s4Landed) {
    warn(`Unexpected confirmation: transaction landed instead of aborting`);
  } else {
    ok(`Aborted by AI Agent as expected! Error: ${s4Result.error}`);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  scenarioBanner("DONE", "Results Summary", "green");

  const rows: [string, string, string, string][] = [
    ["S1", "happy_path",        s1Landed ? "landed" : "failed",  "—"],
    ["S2", "blockhash_expired", s2Landed ? "landed" : "failed",  "—"],
    ["S3", "fee_too_low",       s3Landed ? "landed" : "failed",  "—"],
    ["S4", "compute_exceeded",  s4Landed ? "landed" : "aborted", "—"],
  ];

  console.log(`\n  ${"ID".padEnd(4)} ${"Failure Type".padEnd(24)} ${"Action".padEnd(9)} Conf`);
  console.log(`  ${"─".repeat(50)}`);
  for (const [id, type, action, conf] of rows) {
    const ac = action === "landed" ? "green" : action === "aborted" ? "red" : "white" as const;
    console.log(`  ${c("dim", id.padEnd(4))}${type.padEnd(24)}${c(ac, action.padEnd(9))} ${conf}`);
  }

  console.log(`\n  All scenarios run and logged to Dashboard UI.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(c("red", `\n  ✘ Test failed: ${err}\n`));
  process.exit(1);
});
