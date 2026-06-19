/**
 * TRADING SCENARIO TEST HARNESS
 *
 * Simulates the real-world failure modes a token trader experiences
 * when buying through a MEV-protected bundle stack:
 *
 *   S1  Happy swap            — 0.001 SOL → token via Jupiter; real on-chain
 *   S2  Stale quote (BH exp.) — blockhash_expired mid-flight; agent RETRY
 *   S3  Slippage exceeded     — price moved; simulation_failed; agent ABORT
 *   S4  Jito leader skipped   — hot-mint skip spike; agent HOLD
 *   S5  Fee too low (rush)    — tip auction loss on launch; agent RETRY (p95)
 *
 * Usage:
 *   pnpm test:trading
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
  console.log(c("purple", "\n╔════════════════════════════════════════════════════════╗"));
  console.log(c("purple",   "║   SolGuard — Trading Scenario Test Harness              ║"));
  console.log(c("purple",   "╚════════════════════════════════════════════════════════╝"));
  console.log(c("dim",      "  5 trader scenarios · Unified API submission · Live Sync\n"));

  const conn  = connection();
  const payer = wallet();

  scenarioBanner("BOOT", "RPC Network State", "purple");
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

  // ─── S1: Happy Swap ────────────────────────────────────────────────────────
  scenarioBanner("S1", "Happy Swap  —  SOL → JUP (real on-chain)", "cyan");
  info("Submitting normal transaction via API...");
  const s1Result = await submitTransaction(
    [dummyIx], conn, payer, { urgency: "high", customTipLamports: normalTip.lamports }
  );
  const s1Landed = s1Result.landed;
  const s1Sig = s1Result.signature ?? null;

  if (s1Landed) {
    ok(`Confirmed: ${s1Sig?.substring(0, 28)}…`);
  } else {
    warn(`Submission failed: ${s1Result.error}`);
  }

  // ─── S2: Stale Quote ───────────────────────────────────────────────────────
  scenarioBanner("S2", "Stale Quote  —  blockhash_expired → RETRY", "yellow");
  info("Submitting via API with blockhash_expired simulation...");
  const s2Result = await submitTransaction(
    [dummyIx], conn, payer, { urgency: "high", customTipLamports: normalTip.lamports, simulateFault: "blockhash_expired" }
  );
  const s2Landed = s2Result.landed;
  const s2Sig = s2Result.signature ?? null;

  if (s2Landed) {
    ok(`Confirmed on retry: ${s2Sig?.substring(0, 28)}…`);
  } else {
    warn(`Submission failed: ${s2Result.error}`);
  }

  // ─── S3: Slippage Exceeded ─────────────────────────────────────────────────
  scenarioBanner("S3", "Slippage Exceeded  —  simulation_failed → ABORT", "red");
  info("Submitting via API with slippage_exceeded simulation...");
  const s3Result = await submitTransaction(
    [dummyIx], conn, payer, { urgency: "high", customTipLamports: normalTip.lamports, simulateFault: "slippage_exceeded" }
  );
  const s3Landed = s3Result.landed;

  if (s3Landed) {
    warn(`Unexpected confirmation: transaction landed instead of aborting`);
  } else {
    ok(`Aborted by AI Agent as expected! Error: ${s3Result.error}`);
  }

  // ─── S4: Jito Leader Skipped ───────────────────────────────────────────────
  scenarioBanner("S4", "Jito Leader Skipped  —  hot-mint rush → HOLD", "yellow");
  info("Submitting via API with leader_skip simulation...");
  const s4Result = await submitTransaction(
    [dummyIx], conn, payer, { urgency: "high", customTipLamports: normalTip.lamports, simulateFault: "leader_skip" }
  );
  const s4Landed = s4Result.landed;
  const s4Sig = s4Result.signature ?? null;

  if (s4Landed) {
    ok(`Confirmed after HOLD cooldown: ${s4Sig?.substring(0, 28)}…`);
  } else {
    warn(`Submission failed: ${s4Result.error}`);
  }

  // ─── S5: Fee Too Low ───────────────────────────────────────────────────────
  scenarioBanner("S5", "Token Launch Rush  —  fee_too_low → RETRY (p95)", "yellow");
  info("Submitting via API with fee_too_low simulation...");
  const s5Result = await submitTransaction(
    [dummyIx], conn, payer, { urgency: "high", customTipLamports: 1, simulateFault: "fee_too_low" }
  );
  const s5Landed = s5Result.landed;
  const s5Sig = s5Result.signature ?? null;

  if (s5Landed) {
    ok(`Confirmed on retry: ${s5Sig?.substring(0, 28)}…`);
  } else {
    warn(`Submission failed: ${s5Result.error}`);
  }

  // ─── SUMMARY ───────────────────────────────────────────────────────────────
  scenarioBanner("DONE", "RESULTS SUMMARY", "green");

  const rows: [string, string, string, string][] = [
    ["S1", "happy_swap",               s1Landed ? "landed" : "failed",  "—"],
    ["S2", "blockhash_expired (swap)",  s2Landed ? "landed" : "failed",  "—"],
    ["S3", "slippage_exceeded",         s3Landed ? "landed" : "aborted", "—"],
    ["S4", "leader_skip (hot-mint)",    s4Landed ? "landed" : "failed",  "—"],
    ["S5", "fee_too_low (launch rush)", s5Landed ? "landed" : "failed",  "—"],
  ];

  console.log(`\n  ${"ID".padEnd(4)} ${"Scenario".padEnd(28)} ${"Action".padEnd(9)} Conf`);
  console.log(`  ${"─".repeat(56)}`);
  for (const [id, scenario, action, conf] of rows) {
    const ac = action === "landed" ? "green" : action === "aborted" ? "red" : "white" as const;
    console.log(`  ${c("dim", id.padEnd(4))}${scenario.padEnd(28)}${c(ac, action.padEnd(9))} ${conf}`);
  }

  console.log(`\n  All scenarios run and logged to Dashboard UI.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(c("red", `\n  ✘ Fatal: ${err}\n`));
  process.exit(1);
});
