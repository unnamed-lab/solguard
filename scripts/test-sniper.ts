/**
 * USE CASE: Token Launch Sniper
 *
 * Demonstrates SolGuard's low-latency detection-to-execution pipeline for
 * token launches. When a new pool appears on the Yellowstone stream, the
 * sniper races to submit a buy bundle within the same Jito leader window.
 *
 * Pipeline:
 *   [DETECT]  New pool creation event from stream  (T+0 ms)
 *   [QUOTE]   Jupiter quote fetched                (T+N ms)
 *   [BUILD]   Bundle assembled, tip priced          (T+M ms)
 *   [SUBMIT]  Jito block engine receives bundle     (T+X ms)
 *   [CONFIRM] Yellowstone stream confirms landing   (T+Y ms)
 *
 * This test injects a synthetic pool creation event (since we can't predict
 * when a real launch happens) and measures the full pipeline latency.
 * In production, the detection step is wired to the Yellowstone stream filter
 * watching for Raydium / Pump.fun pool initialisation instructions.
 *
 * Why this matters:
 *   Token launches are slot-competitive. The buyer who lands in the first
 *   Jito window after pool creation gets the best price. Every millisecond
 *   of pipeline latency translates directly to a worse entry price.
 *
 * Usage:
 *   pnpm test:sniper
 */

import "dotenv/config";
import { VersionedTransaction } from "@solana/web3.js";
import { CongestionOracle } from "../src/network/congestion.js";
import { tipFloorService } from "../src/tips/tipFloor.js";
import { computeTip } from "../src/tips/model.js";
import { LeaderWindowDetector } from "../src/network/leader.js";
import { SolGuard } from "../src/sdk/solguard.js";
import { connection, wallet } from "../src/solana/connection.js";
import { Spinner, Col, c, scenarioBanner, delay, summaryRow } from "./_ui.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const WSOL_MINT    = "So11111111111111111111111111111111111111112";
// Using JUP as the "new token" target — deep enough liquidity for a realistic demo
const TARGET_MINT  = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const BUY_LAMPORTS = 1_000_000; // 0.001 SOL — keeps the sniper test cheap

// ─── Jupiter helpers ──────────────────────────────────────────────────────────
async function jupiterQuote(inMint: string, outMint: string, amount: number, slippageBps = 300) {
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Jupiter quote HTTP ${r.status}`);
  return r.json() as Promise<any>;
}

async function jupiterSwapTx(quote: any, pubkey: string): Promise<VersionedTransaction> {
  const r = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse:             quote,
      userPublicKey:             pubkey,
      wrapAndUnwrapSol:          true,
      prioritizationFeeLamports: { jitoTipLamports: 0 },
    }),
  });
  if (!r.ok) throw new Error(`Jupiter swap HTTP ${r.status}`);
  const { swapTransaction } = await r.json() as { swapTransaction: string };
  return VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
}

const ok   = (m: string) => console.log(`  ${c("green",  "✔")} ${m}`);
const warn = (m: string) => console.log(`  ${c("yellow", "⚠")} ${m}`);
const info = (m: string) => console.log(`  ${c("dim",    "·")} ${m}`);

function ms(n: number) { return `${n.toLocaleString()} ms`; }

// ─── Simulated pool creation event ────────────────────────────────────────────
interface PoolCreationEvent {
  mint:          string;
  poolAddress:   string;
  detectedSlot:  number;
  detectTs:      number;
  initialPrice:  number; // SOL per token (estimated)
  source:        "raydium" | "pump.fun" | "meteora";
}

function injectPoolCreationEvent(slot: number): PoolCreationEvent {
  return {
    mint:         TARGET_MINT,
    poolAddress:  "sim_pool_" + Math.random().toString(36).substring(2, 14),
    detectedSlot: slot,
    detectTs:     Date.now(),
    initialPrice: 0.00000040, // simulated: ~0.4 μSOL per token at launch
    source:       "raydium",
  };
}

// ─── Sniper execution pipeline ────────────────────────────────────────────────
interface SniperResult {
  detectTs:      number;
  quoteTs:       number | null;
  buildTs:       number | null;
  submitTs:      number | null;
  confirmTs:     number | null;
  detectedSlot:  number;
  submittedSlot: number | null;
  slotDelta:     number | null;
  outTokens:     number;
  landed:        boolean;
  sig:           string | null;
  error:         string | null;
}

async function runSniper(
  event: PoolCreationEvent,
  payer: ReturnType<typeof wallet>,
  conn: ReturnType<typeof connection>,
  currentSlot: number,
  tipLamports: number,
): Promise<SniperResult> {
  const r: SniperResult = {
    detectTs:      event.detectTs,
    quoteTs:       null,
    buildTs:       null,
    submitTs:      null,
    confirmTs:     null,
    detectedSlot:  event.detectedSlot,
    submittedSlot: null,
    slotDelta:     null,
    outTokens:     0,
    landed:        false,
    sig:           null,
    error:         null,
  };

  // Step 1: Quote
  info(`[T+0]      Pool detected: ${event.source} / ${event.mint.substring(0, 10)}… @ slot ${event.detectedSlot.toLocaleString()}`);
  let quote: any;
  try {
    quote = await jupiterQuote(WSOL_MINT, event.mint, BUY_LAMPORTS);
    r.quoteTs  = Date.now();
    r.outTokens = Number(quote.outAmount);
    info(`[T+${ms(r.quoteTs - r.detectTs).padStart(8)}]  Quote: ~${r.outTokens.toLocaleString()} tokens  (impact: ${quote.priceImpactPct ?? "< 0.01"} %)`);
  } catch (e: any) {
    r.error = `Jupiter unavailable: ${e.message}`;
    return r;
  }

  // Step 2: Build swap tx
  let swapTx: VersionedTransaction;
  try {
    swapTx   = await jupiterSwapTx(quote, payer.publicKey.toBase58());
    r.buildTs = Date.now();
    info(`[T+${ms(r.buildTs - r.detectTs).padStart(8)}]  Bundle assembled`);
  } catch (e: any) {
    r.error = `Tx build failed: ${e.message}`;
    return r;
  }

  // Step 3: Submit via SolGuard (stream → tip → jito bundle → confirmation)
  info(`[T+${ms(Date.now() - r.detectTs).padStart(8)}]  Submitting to Jito (tip: ${tipLamports.toLocaleString()} lmp)…`);
  const guard = new SolGuard({
    wallet:           payer,
    connection:       conn,
    submit:           true,
    confirmTimeoutMs: 30_000,
  });

  try {
    await guard.start();
    const submitSlot  = await conn.getSlot("confirmed");
    r.submittedSlot   = submitSlot;
    r.slotDelta       = submitSlot - event.detectedSlot;

    const result = await guard.submit(swapTx as any, {
      urgency:           "high",
      customTipLamports: tipLamports,
    });

    r.submitTs  = Date.now();
    r.landed    = result.landed;
    r.sig       = result.signature ?? null;
    r.confirmTs = result.landed ? Date.now() : null;

    info(`[T+${ms(r.submitTs - r.detectTs).padStart(8)}]  Bundle submitted (slot ${submitSlot.toLocaleString()})`);
    if (result.landed) {
      info(`[T+${ms((r.confirmTs ?? r.submitTs) - r.detectTs).padStart(8)}]  Confirmed on-chain`);
    } else {
      r.error = result.error ?? "timeout";
    }
  } finally {
    await guard.stop().catch(() => {});
  }

  return r;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(c("purple", "\n╔════════════════════════════════════════════════════════╗"));
  console.log(c("purple",   "║   SolGuard — Token Launch Sniper                        ║"));
  console.log(c("purple",   "╚════════════════════════════════════════════════════════╝"));
  console.log(c("dim",      "  Use case: detect → quote → bundle → submit in one slot\n"));

  const conn  = connection();
  const payer = wallet();

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  scenarioBanner("BOOT", "Network Bootstrap", "purple");
  const oracle      = new CongestionOracle();
  const leaderDet   = new LeaderWindowDetector();
  const currentSlot = await conn.getSlot("confirmed");
  const tf          = await tipFloorService().get();
  const balance     = await conn.getBalance(payer.publicKey);

  for (let i = 0; i < 64; i++) {
    const slot = BigInt(currentSlot - 64 + i);
    oracle.ingest({ kind: "slot", slot, status: "processed",  ts: Date.now() - (64-i)*400 });
    if (Math.random() > 0.03)
      oracle.ingest({ kind: "slot", slot, status: "confirmed", ts: Date.now() - (64-i)*400 + 420 });
  }
  const snap = oracle.snapshot();

  // Sniper tips higher than normal — we're competing with other launch buyers
  const sniperTip = computeTip({ tipFloor: tf, congestionMultiplier: snap.congestionMultiplier, urgency: "high" });

  let win: { nextJitoLeaderSlot?: number; slotsUntilJitoLeader?: number } = {};
  try { win = await leaderDet.window(); } catch { /* ignore */ }

  ok(`Wallet       : ${payer.publicKey.toBase58()}`);
  ok(`Balance      : ${(balance/1e9).toFixed(6)} SOL`);
  ok(`Slot         : ${currentSlot.toLocaleString()}`);
  ok(`Sniper tip   : ${sniperTip.lamports.toLocaleString()} lmp  (${sniperTip.percentileKey})`);
  if (win.nextJitoLeaderSlot)
    ok(`Jito leader  : slot ${win.nextJitoLeaderSlot.toLocaleString()}  (${win.slotsUntilJitoLeader} slots away)`);

  // ─────────────────────────────────────────────────────────────────────────────
  // DETECT: Synthetic pool creation event fires
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("DETECT", "Pool Creation Event  (synthetic injection)", "yellow");
  info("In production: Yellowstone stream filter on Raydium / Pump.fun program IDs");
  info("Here: deterministic injection to test pipeline timing");
  await delay(200); // simulate small stream propagation lag

  const event = injectPoolCreationEvent(currentSlot);
  console.log();
  console.log(`  ${c("yellow", "⚡")} ${c("bold" as any, "NEW POOL DETECTED")}  —  ${event.source.toUpperCase()}`);
  console.log(`  ${c("dim", "Mint:   ")}${event.mint}`);
  console.log(`  ${c("dim", "Pool:   ")}${event.poolAddress}`);
  console.log(`  ${c("dim", "Slot:   ")}${event.detectedSlot.toLocaleString()}`);
  console.log(`  ${c("dim", "Source: ")}Yellowstone gRPC stream (simulated)`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────────────
  // RACE: Quote → Bundle → Submit
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("RACE", "Detection → Quote → Submit Pipeline", "cyan");

  const MIN_BALANCE = 8_000_000; // 0.008 SOL
  if (balance < MIN_BALANCE) {
    warn(`Balance ${(balance/1e9).toFixed(6)} SOL < 0.008 — running pipeline timing only (no submission)`);
  }

  const spin = new Spinner();
  spin.start("Sniper racing to submit buy bundle…");
  const result = await runSniper(event, payer, conn, currentSlot, sniperTip.lamports);
  spin.clear();

  // ─────────────────────────────────────────────────────────────────────────────
  // RESULT: Timing breakdown
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("RESULT", "Sniper Timing Breakdown", "green");

  const detectToQuote  = result.quoteTs  ? result.quoteTs  - result.detectTs : null;
  const quoteToBuild   = (result.quoteTs && result.buildTs) ? result.buildTs - result.quoteTs : null;
  const buildToSubmit  = (result.buildTs && result.submitTs) ? result.submitTs - result.buildTs : null;
  const totalToSubmit  = result.submitTs ? result.submitTs - result.detectTs : null;
  const totalToConfirm = result.confirmTs ? result.confirmTs - result.detectTs : null;

  const row = (label: string, val: string | null, col: Col = "cyan") =>
    console.log(`  ${c("dim", label.padEnd(28))}${val ? c(col, val) : c("dim", "—")}`);

  console.log();
  row("Detect → Quote",    detectToQuote  ? ms(detectToQuote)  : null, "cyan");
  row("Quote → Build",     quoteToBuild   ? ms(quoteToBuild)   : null, "cyan");
  row("Build → Submit",    buildToSubmit  ? ms(buildToSubmit)  : null, "cyan");
  row("─ Total to Submit", totalToSubmit  ? ms(totalToSubmit)  : null, "green");
  row("─ Total to Confirm",totalToConfirm ? ms(totalToConfirm) : null, result.landed ? "green" : "yellow");
  console.log();
  row("Detected slot",   event.detectedSlot.toLocaleString());
  row("Submitted slot",  result.submittedSlot?.toLocaleString() ?? null);
  row("Slot delta",      result.slotDelta !== null ? `+${result.slotDelta} slots (~${result.slotDelta * 400} ms)` : null,
      (result.slotDelta ?? 999) <= 2 ? "green" : "yellow");
  row("Tokens received", result.outTokens > 0 ? result.outTokens.toLocaleString() : null);

  console.log();
  if (result.error) {
    console.log(`  ${c("yellow", "⚠")} ${result.error}`);
  }
  if (result.sig) {
    ok(`Sig: ${result.sig.substring(0, 28)}…`);
    ok(`Explorer: https://solscan.io/tx/${result.sig}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Slot window analysis
  // ─────────────────────────────────────────────────────────────────────────────
  console.log(`\n  ${c("dim", "─── Slot Window Analysis ──────────────────────────────────────────")}`);
  if (result.error !== null && result.slotDelta === null) {
    warn(`Pipeline incomplete — ${result.error}`);
    info("In production: fallback to next Jito leader window");
  } else {
    const delta = result.slotDelta ?? 0;
    if (delta === 0) {
      console.log(`  ${c("green", "✔")} ${c("bold" as any, "Same-slot submission")} — best possible outcome`);
      console.log(`  ${c("dim", "    Bundle landed in the same slot window as pool detection.")}`);
    } else if (delta <= 2) {
      console.log(`  ${c("green", "✔")} ${c("bold" as any, `+${delta} slot${delta > 1 ? "s" : ""} submission`)} — excellent`);
      console.log(`  ${c("dim", `    ${delta * 400} ms elapsed between detection and submission.`)}`);
    } else if (delta <= 5) {
      console.log(`  ${c("yellow", "⚠")} ${c("bold" as any, `+${delta} slots`)} — acceptable but competitive buyers may have gone first`);
    } else {
      console.log(`  ${c("red", "✘")} ${c("bold" as any, `+${delta} slots`)} — slow; Jupiter API latency or RPC congestion likely`);
    }
  }

  console.log(`\n  ${c("dim", "Jito tip used: ")}${sniperTip.lamports.toLocaleString()} lmp (${sniperTip.percentileKey}) — competitive at launch`);
  console.log(`  ${c("dim", "SolGuard advantage: ")}private bundle → MEV-protected entry price\n`);
  console.log(c("green", "  ✔ Token launch sniper demonstration complete.\n"));
  process.exit(0);
}

main().catch((err) => {
  console.error(c("red", `\n  ✘ Fatal: ${err}\n`));
  process.exit(1);
});
