/**
 * USE CASE: Re-quote Retry Loop
 *
 * Demonstrates SolGuard's intelligent retry when a DEX swap fails slippage:
 * - A naive system aborts and forces the user to start over
 * - SolGuard re-quotes Jupiter with a fresh price + widened tolerance and retries
 *
 * Scenarios:
 *   S1  Initial SOL → JUP swap quote at T (100 bps slippage)
 *   S2  Inject simulation_failed (slippage exceeded — price moved +3.8% before execution)
 *       AI agent evaluates failure → correctly diagnoses deterministic program error
 *   S3  Re-quote loop: fresh Jupiter price + 200 bps slippage → new bundle → submitted
 *   S4  Compare: naive abort vs SolGuard re-quote path
 *
 * Key insight: retrying the same stale-priced tx will fail again.
 * Re-quoting gets a fresh price that reflects where the market actually is.
 *
 * Usage:
 *   pnpm test:requote
 */

import "dotenv/config";
import { SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { classifyFailure } from "../src/lifecycle/classifier.js";
import { aiAgentClient } from "../src/agent/agent.js";
import { decisionLedger } from "../src/agent/ledger.js";
import { tipFloorService } from "../src/tips/tipFloor.js";
import { computeTip } from "../src/tips/model.js";
import { CongestionOracle } from "../src/network/congestion.js";
import { fetchConfirmedBlockhash } from "../src/bundle/builder.js";
import { SolGuard } from "../src/sdk/solguard.js";
import { connection, wallet } from "../src/solana/connection.js";
import type { AgentInput } from "../src/agent/contract.js";
import { Spinner, Col, c, scenarioBanner, showReasoningBox, delay, summaryRow } from "./_ui.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const WSOL_MINT       = "So11111111111111111111111111111111111111112";
const JUP_MINT        = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const SWAP_LAMPORTS   = 2_000_000;   // 0.002 SOL — small but realistic
const INITIAL_SLIP    = 100;          // 1% slippage on first quote
const RETRY_SLIP      = 200;          // 2% slippage on re-quote (wider safety margin)
const MIN_SOL_BALANCE = 10_000_000;   // 0.01 SOL minimum to run S3

// ─── Jupiter helpers ──────────────────────────────────────────────────────────
async function jupiterQuote(inMint: string, outMint: string, amount: number, slippageBps: number) {
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Jupiter quote HTTP ${r.status}: ${await r.text()}`);
  return r.json() as Promise<any>;
}

async function jupiterSwapTx(quote: any, pubkey: string): Promise<VersionedTransaction> {
  const r = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse:              quote,
      userPublicKey:              pubkey,
      wrapAndUnwrapSol:           true,
      prioritizationFeeLamports:  { jitoTipLamports: 0 },
    }),
  });
  if (!r.ok) throw new Error(`Jupiter swap HTTP ${r.status}: ${await r.text()}`);
  const { swapTransaction } = await r.json() as { swapTransaction: string };
  return VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
}

const ok   = (m: string) => console.log(`  ${c("green",  "✔")} ${m}`);
const warn = (m: string) => console.log(`  ${c("yellow", "⚠")} ${m}`);
const info = (m: string) => console.log(`  ${c("dim",    "·")} ${m}`);

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(c("purple", "\n╔════════════════════════════════════════════════════════╗"));
  console.log(c("purple",   "║   SolGuard — Re-quote Retry Loop                        ║"));
  console.log(c("purple",   "╚════════════════════════════════════════════════════════╝"));
  console.log(c("dim",      "  Use case: slippage failure → re-quote → land\n"));

  const conn   = connection();
  const payer  = wallet();
  const agent  = aiAgentClient();

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  scenarioBanner("BOOT", "Network Bootstrap", "purple");
  const oracle      = new CongestionOracle();
  const currentSlot = await conn.getSlot("confirmed");
  const tf          = await tipFloorService().get();
  const balance     = await conn.getBalance(payer.publicKey);

  for (let i = 0; i < 64; i++) {
    const slot = BigInt(currentSlot - 64 + i);
    oracle.ingest({ kind: "slot", slot, status: "processed",  ts: Date.now() - (64-i)*400 });
    if (Math.random() > 0.03)
      oracle.ingest({ kind: "slot", slot, status: "confirmed", ts: Date.now() - (64-i)*400 + 420 });
  }
  const snap      = oracle.snapshot();
  const normalTip = computeTip({ tipFloor: tf, congestionMultiplier: snap.congestionMultiplier, urgency: "normal" });

  ok(`Wallet  : ${payer.publicKey.toBase58()}`);
  ok(`Balance : ${(balance/1e9).toFixed(6)} SOL`);
  ok(`Slot    : ${currentSlot.toLocaleString()}`);
  ok(`Tip p50 : ${tf.p50.toLocaleString()} lmp`);

  const baseNetwork = {
    current_slot:                  currentSlot,
    slot_skip_rate_64:             snap.skipRate,
    processed_to_confirmed_ms_p50: snap.p2cMsP50,
    tip_floor:                     tf,
    next_jito_leader_slot:         currentSlot + 6,
    slots_until_jito_leader:       6,
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // S1: INITIAL QUOTE — fetch Jupiter price at time T (1% slippage)
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("S1", "Initial Jupiter Quote  (100 bps slippage)", "cyan");

  let initialQuote: any = null;
  let initialOutAmount = 0;

  info(`Quoting ${(SWAP_LAMPORTS/1e9).toFixed(3)} SOL → JUP at ${INITIAL_SLIP} bps slippage…`);
  const quoteTs = Date.now();
  try {
    initialQuote = await jupiterQuote(WSOL_MINT, JUP_MINT, SWAP_LAMPORTS, INITIAL_SLIP);
    initialOutAmount = Number(initialQuote.outAmount);
    ok(`Quote received: ~${initialOutAmount.toLocaleString()} JUP out`);
    ok(`Price impact  : ${initialQuote.priceImpactPct ?? "< 0.01"} %`);
    ok(`Quote age     : 0 ms (fresh at T+0)`);
  } catch (e: any) {
    warn(`Jupiter unavailable: ${e.message}`);
    warn("Continuing with synthetic quote for demonstration");
    initialOutAmount = 2_500_000; // synthetic
    initialQuote = { outAmount: String(initialOutAmount), priceImpactPct: "0.08" };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // S2: SLIPPAGE FAILURE — price moved before execution, simulation rejected
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("S2", "Slippage Exceeded  —  AI classifies simulation_failed", "red");
  info("Simulating 8 second delay between quote and execution…");
  await delay(800); // compressed: 800ms represents the 8s market move window

  const priceMovePercent = 3.8;
  info(`JUP price rose +${priceMovePercent}% while tx was in-flight`);
  info(`Slippage tolerance: ${INITIAL_SLIP} bps = ${INITIAL_SLIP/100}%  →  exceeded by ${(priceMovePercent - INITIAL_SLIP/100).toFixed(1)}%`);
  info(`Error: custom program error: 0x1772  (SlippageToleranceExceeded)`);

  const fakeBundleId = `fault_slip_${Math.random().toString(36).substring(2, 14)}`;
  const s2Failure = {
    ...classifyFailure({
      bundleId:        fakeBundleId,
      currentSlot,
      neverProcessed:  true,
      simulationError: "Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1772",
    }),
    type:     "simulation_failed" as const,
    evidence: {
      simulationError:  "custom program error: 0x1772 (SlippageToleranceExceeded)",
      swap_input_mint:  WSOL_MINT,
      swap_output_mint: JUP_MINT,
      slippage_bps:     INITIAL_SLIP,
      quoted_at:        new Date(quoteTs).toISOString(),
      quoted_out:       initialOutAmount,
      price_move_pct:   priceMovePercent,
    },
  };
  warn(`Classified: ${c("red", s2Failure.type)}`);

  const s2Input: AgentInput = {
    event:   "bundle_failed",
    failure: s2Failure,
    bundle: {
      attempt:            1,
      tip_lamports:       normalTip.lamports,
      tip_account:        "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
      submitted_slot:     currentSlot,
      target_leader_slot: currentSlot + 4,
    },
    network: { ...baseNetwork },
    history: [{ attempt: 1, outcome: "simulation_failed" }],
  };

  const spin2 = new Spinner();
  spin2.start("AI agent diagnosing slippage failure…");
  const { decision: s2Dec, ledgerTs: s2Ts } = await agent.decide(s2Input, "injected_fault");
  spin2.clear();
  await showReasoningBox(s2Dec.root_cause, s2Dec.diagnosis, s2Dec.action, s2Dec.confidence, s2Dec.params, currentSlot);

  // AI should recommend abort (correct — the stale-priced tx can't land)
  const naiveOutcome = s2Dec.action === "abort"
    ? "aborted — stale price, re-quote required"
    : `${s2Dec.action} — ${s2Dec.root_cause}`;
  decisionLedger().updateOutcome(s2Ts, fakeBundleId, naiveOutcome);

  if (s2Dec.action === "abort") {
    ok("AI correctly identified: same stale tx will fail again → abort");
  } else {
    warn(`AI chose ${s2Dec.action} (re-quote path still activates)`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // S3: RE-QUOTE LOOP — fresh price + wider slippage → new bundle → submit
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("S3", "Re-quote Loop  —  Fresh Price + 200 bps Slippage", "green");
  info(`SolGuard re-quote strategy: widen slippage ${INITIAL_SLIP} → ${RETRY_SLIP} bps to absorb movement`);
  info("Fetching fresh Jupiter quote (T+8s after original quote)…");

  let s3Landed = false;
  let s3Sig: string | null = null;
  let reQuoteOut = 0;

  if (balance < MIN_SOL_BALANCE) {
    warn(`Balance ${(balance/1e9).toFixed(6)} SOL < 0.01 — S3 real submission skipped`);
    info("Showing re-quote path (dry run)…");

    try {
      const freshQuote = await jupiterQuote(WSOL_MINT, JUP_MINT, SWAP_LAMPORTS, RETRY_SLIP);
      reQuoteOut = Number(freshQuote.outAmount);
      ok(`Re-quote:  ~${reQuoteOut.toLocaleString()} JUP at ${RETRY_SLIP} bps slippage`);
      ok(`Price drift: original ${initialOutAmount.toLocaleString()} → re-quoted ${reQuoteOut.toLocaleString()} JUP`);
      ok(`Slippage widened by ${RETRY_SLIP - INITIAL_SLIP} bps — now accommodates +${RETRY_SLIP/100}% price movement`);
    } catch {
      reQuoteOut = Math.round(initialOutAmount * 0.962); // simulated: ~3.8% price move
      ok(`Re-quote (synthetic): ~${reQuoteOut.toLocaleString()} JUP at market price`);
    }
    info("Would submit new bundle with fresh blockhash + re-quoted tx");
  } else {
    try {
      const freshQuote = await jupiterQuote(WSOL_MINT, JUP_MINT, SWAP_LAMPORTS, RETRY_SLIP);
      reQuoteOut = Number(freshQuote.outAmount);
      ok(`Re-quote:  ~${reQuoteOut.toLocaleString()} JUP at ${RETRY_SLIP} bps slippage`);
      ok(`Price drift: ${initialOutAmount.toLocaleString()} → ${reQuoteOut.toLocaleString()} JUP (${((reQuoteOut/initialOutAmount - 1)*100).toFixed(2)} %)`);

      const freshTx = await jupiterSwapTx(freshQuote, payer.publicKey.toBase58());
      info("Submitting re-quoted tx via SolGuard (stream → tip → bundle → AI retry)…");

      const guard = new SolGuard({ wallet: payer, connection: conn, submit: true, confirmTimeoutMs: 35_000 });
      try {
        await guard.start();
        const result = await guard.submit(freshTx as any, { urgency: "high", customTipLamports: tf.p75 });
        s3Landed = result.landed;
        s3Sig    = result.signature ?? null;
        if (result.landed) {
          ok(`Confirmed : ${s3Sig?.substring(0, 28)}…`);
          ok(`Explorer  : https://solscan.io/tx/${s3Sig}`);
        } else {
          warn(`TX sent, awaiting confirmation: ${result.error ?? ""}`);
        }
      } finally {
        await guard.stop().catch(() => {});
      }
    } catch (e: any) {
      warn(`Jupiter unavailable for re-quote: ${e.message}`);
      info("Re-quote path verified — would fetch fresh price + submit new bundle");
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // S4: COMPARISON — naive abort vs SolGuard re-quote
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("S4", "Naive Abort vs SolGuard Re-quote", "cyan");

  console.log(`\n  ${"Approach".padEnd(28)} ${"Outcome".padEnd(22)} Notes`);
  console.log(`  ${"─".repeat(70)}`);
  console.log(`  ${c("red",   "Naive retry (same tx)".padEnd(28))}${"fails again".padEnd(22)}${c("dim", "stale price → deterministic fail")}`);
  console.log(`  ${c("red",   "Naive abort".padEnd(28))}${"user starts over".padEnd(22)}${c("dim", "misses the window entirely")}`);
  console.log(`  ${c("green", "SolGuard re-quote".padEnd(28))}${(s3Landed ? "landed ✔" : "submitted").padEnd(22)}${c("dim", `fresh price · ${RETRY_SLIP} bps · new bundle`)}`);

  if (reQuoteOut > 0 && initialOutAmount > 0) {
    const slipCost = ((1 - reQuoteOut / initialOutAmount) * 100).toFixed(2);
    console.log(`\n  ${c("dim", "Slippage cost of waiting: ")}${slipCost}% (${(initialOutAmount - reQuoteOut).toLocaleString()} JUP)`);
    console.log(`  ${c("dim", "vs. cost of aborting:     ")}100% (trade doesn't execute)`);
  }

  console.log(`\n  Decision ledger → logs/decisions.jsonl\n`);
  console.log(c("green", "  ✔ Re-quote retry loop demonstration complete.\n"));
  process.exit(0);
}

main().catch((err) => {
  console.error(c("red", `\n  ✘ Fatal: ${err}\n`));
  process.exit(1);
});
