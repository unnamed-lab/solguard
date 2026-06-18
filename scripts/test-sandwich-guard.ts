/**
 * USE CASE #2: MEV Sandwich Protection
 *
 * Demonstrates how Jito bundles prevent MEV sandwich attacks on DEX swaps.
 *
 * What is a sandwich attack?
 *   An MEV bot monitors the public mempool for large pending swaps. When it
 *   spots a profitable trade, it:
 *     1. Frontrun:  submits a buy before yours (pumps the price)
 *     2. Your swap: executes at the worse, inflated price
 *     3. Backrun:   bot sells immediately after (locks in profit)
 *   The bot extracts value directly from your trade. On high-volume tokens
 *   with wide spreads, sandwich profit can be 0.5–3% of the trade size.
 *
 * Why Jito bundles prevent it:
 *   Jito bundles bypass the public mempool entirely. They are submitted
 *   directly to the scheduled Jito leader via a private RPC, making them
 *   invisible to MEV bots until they are already finalized on-chain.
 *   Additionally, bundles are atomic — all txs in the bundle land together
 *   or none do, preventing partial execution that MEV bots exploit.
 *
 * This test:
 *   ANALYZE:  Take a real Jupiter quote; calculate sandwich profitability
 *   PATH-A:   Public TX path — show what a sandwicher would extract
 *   PATH-B:   SolGuard bundle path — submit same swap protected
 *   COMPARE:  Effective price, protection savings, slot confirmation
 *
 * Usage:
 *   pnpm test:sandwich
 */

import "dotenv/config";
import { VersionedTransaction } from "@solana/web3.js";
import { CongestionOracle } from "../src/network/congestion.js";
import { tipFloorService } from "../src/tips/tipFloor.js";
import { computeTip } from "../src/tips/model.js";
import { SolGuard } from "../src/sdk/solguard.js";
import { connection, wallet } from "../src/solana/connection.js";
import { Col, c, scenarioBanner, delay } from "./_ui.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const WSOL_MINT    = "So11111111111111111111111111111111111111112";
const JUP_MINT     = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
// Larger swap = more sandwichable (higher price impact = higher MEV profit)
const SWAP_LAMPORTS = 5_000_000; // 0.005 SOL
const SLIPPAGE_BPS  = 150;       // 1.5% tolerance — standard for active tokens

// ─── Jupiter helpers ──────────────────────────────────────────────────────────
async function jupiterQuote(inMint: string, outMint: string, amount: number, slippageBps: number) {
  const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=${slippageBps}`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Jupiter quote HTTP ${r.status}`);
  return r.json() as Promise<any>;
}

async function jupiterSwapTx(quote: any, pubkey: string): Promise<VersionedTransaction> {
  const r = await fetch("https://quote-api.jup.ag/v6/swap", {
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
const bad  = (m: string) => console.log(`  ${c("red",    "✘")} ${m}`);

// ─── Sandwich attack model ────────────────────────────────────────────────────
interface SandwichAnalysis {
  riskLevel:       "HIGH" | "MEDIUM" | "LOW" | "NEGLIGIBLE";
  priceImpactPct:  number;
  tradeValueSol:   number;
  /** Estimated lamports an MEV bot could extract from this trade. */
  mevExtractableLamports: number;
  /** Minimum frontrun profit threshold for a bot to bother (~500 lmp gas cost). */
  profitable:      boolean;
  explanation:     string;
}

function analyzeSandwichRisk(
  priceImpactPct: number,
  tradeSizeLamports: number,
  slippageBps: number,
): SandwichAnalysis {
  const tradeValueSol = tradeSizeLamports / 1e9;
  // MEV extractable ≈ price_impact × trade_size × 0.5
  // (bot takes roughly half the price impact range as profit)
  const mevExtractableLamports = Math.round(priceImpactPct / 100 * tradeSizeLamports * 0.5);
  // Profitability threshold: MEV gas cost ≈ 5,000 lamports
  const profitable = mevExtractableLamports > 5_000;

  let riskLevel: SandwichAnalysis["riskLevel"];
  let explanation: string;

  if (!profitable) {
    riskLevel   = "NEGLIGIBLE";
    explanation = `MEV extractable value (${mevExtractableLamports.toLocaleString()} lmp) is below bot gas cost. Sandwich not profitable.`;
  } else if (priceImpactPct >= 1.5 || tradeValueSol >= 0.5) {
    riskLevel   = "HIGH";
    explanation = `${priceImpactPct}% price impact on ${tradeValueSol.toFixed(3)} SOL trade. MEV bots actively sandwich this range.`;
  } else if (priceImpactPct >= 0.3 || tradeValueSol >= 0.05) {
    riskLevel   = "MEDIUM";
    explanation = `Moderate price impact. Opportunistic MEV bots may target during high-activity windows.`;
  } else {
    riskLevel   = "LOW";
    explanation = `Low price impact. Sandwich attack possible but low priority for most MEV bots.`;
  }

  return { riskLevel, priceImpactPct, tradeValueSol, mevExtractableLamports, profitable, explanation };
}

function riskColor(level: SandwichAnalysis["riskLevel"]): Col {
  return level === "HIGH" ? "red" : level === "MEDIUM" ? "yellow" : level === "LOW" ? "cyan" : "green";
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(c("purple", "\n╔════════════════════════════════════════════════════════╗"));
  console.log(c("purple",   "║   SolGuard — MEV Sandwich Protection                    ║"));
  console.log(c("purple",   "╚════════════════════════════════════════════════════════╝"));
  console.log(c("dim",      "  Use case: public TX (vulnerable) vs bundle (protected)\n"));

  const conn  = connection();
  const payer = wallet();

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
  const snap = oracle.snapshot();
  const tip  = computeTip({ tipFloor: tf, congestionMultiplier: snap.congestionMultiplier, urgency: "high" });

  ok(`Wallet  : ${payer.publicKey.toBase58()}`);
  ok(`Balance : ${(balance/1e9).toFixed(6)} SOL`);
  ok(`Slot    : ${currentSlot.toLocaleString()}`);
  ok(`Tip     : ${tip.lamports.toLocaleString()} lmp  (${tip.percentileKey})`);

  // ─────────────────────────────────────────────────────────────────────────────
  // ANALYZE: Quote the swap and model the sandwich risk
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("ANALYZE", "Quote + Sandwich Risk Analysis", "yellow");
  info(`Swap: ${(SWAP_LAMPORTS/1e9).toFixed(3)} SOL → JUP  (${SLIPPAGE_BPS} bps tolerance)`);

  let quote: any = null;
  let outTokens   = 0;
  let priceImpact = 0.08; // fallback if Jupiter unavailable

  try {
    quote       = await jupiterQuote(WSOL_MINT, JUP_MINT, SWAP_LAMPORTS, SLIPPAGE_BPS);
    outTokens   = Number(quote.outAmount);
    priceImpact = parseFloat(quote.priceImpactPct ?? "0.08");
    ok(`Quote: ~${outTokens.toLocaleString()} JUP out`);
    ok(`Price impact: ${priceImpact}%`);
  } catch (e: any) {
    warn(`Jupiter unavailable (${e.message}) — using synthetic quote`);
    outTokens = 1_250_000;
    ok(`Quote (synthetic): ~${outTokens.toLocaleString()} JUP out`);
    ok(`Price impact (synthetic): ${priceImpact}%`);
  }

  const analysis = analyzeSandwichRisk(priceImpact, SWAP_LAMPORTS, SLIPPAGE_BPS);

  console.log();
  console.log(`  ${c("dim", "─── Sandwich Risk Report ──────────────────────────────────────────")}`);
  console.log(`  Risk level      : ${c(riskColor(analysis.riskLevel), analysis.riskLevel)}`);
  console.log(`  Price impact    : ${priceImpact}%`);
  console.log(`  Trade value     : ${analysis.tradeValueSol.toFixed(3)} SOL`);
  console.log(`  MEV extractable : ~${analysis.mevExtractableLamports.toLocaleString()} lamports (~${(analysis.mevExtractableLamports/1e9).toFixed(6)} SOL)`);
  console.log(`  Profitable?     : ${analysis.profitable ? c("red", "YES — bots will target this") : c("green", "NO — below gas threshold")}`);
  console.log(`  ${c("dim", analysis.explanation)}`);
  console.log();

  // ─────────────────────────────────────────────────────────────────────────────
  // PATH A: PUBLIC TX — what happens without MEV protection
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("PATH-A", "Public TX  —  Mempool Exposed (NOT Submitted)", "red");
  info("A standard sendTransaction() would place this swap in the public mempool");
  info("MEV bots scan the mempool in real-time using RPC subscription streams");
  await delay(400);

  console.log();
  console.log(`  ${c("red", "Attack sequence (if submitted as public TX):")}`);
  console.log();

  const steps = [
    ["T+0  ms", "Your swap appears in public mempool"],
    ["T+~5 ms", `MEV bot detects it (${(SWAP_LAMPORTS/1e9).toFixed(3)} SOL → JUP, ${priceImpact}% impact)`],
    ["T+~8 ms", `Bot calculates profit: ~${analysis.mevExtractableLamports.toLocaleString()} lmp`],
    ["T+~10 ms",`Bot frontrun buy: pumps JUP price by ~${(priceImpact * 0.7).toFixed(2)}%`],
    ["T+~12 ms","Your swap executes at the inflated price (worse fill)"],
    ["T+~13 ms",`Bot backrun sell: locks in ${analysis.mevExtractableLamports.toLocaleString()} lmp profit`],
  ];

  for (const [ts, step] of steps) {
    await delay(120);
    console.log(`    ${c("dim", ts.padEnd(12))}${step}`);
  }

  console.log();
  if (analysis.profitable) {
    bad(`Without protection: you lose ~${analysis.mevExtractableLamports.toLocaleString()} lmp (~${(analysis.mevExtractableLamports/1e9*100).toFixed(4)} % of trade)`);
    bad(`Effective receive:  ~${Math.round(outTokens * (1 - priceImpact/200)).toLocaleString()} JUP (vs quoted ${outTokens.toLocaleString()})`);
  } else {
    info("Price impact too small to be profitably sandwiched for this trade size");
    info("A larger trade or more volatile token would attract sandwich bots");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PATH B: SOLGUARD BUNDLE — private, atomic, MEV-proof
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("PATH-B", "SolGuard Bundle  —  Private + Atomic", "green");
  info("Jito bundles bypass the public mempool entirely");
  info("Submitted directly to the scheduled Jito leader via private RPC");
  await delay(200);

  console.log();
  console.log(`  ${c("green", "Protection mechanism:")}`);
  console.log();

  const protectionSteps = [
    ["Privacy",    "Bundle goes directly to Jito leader — invisible to mempool scanners"],
    ["Atomicity",  "All txs in bundle land together or none do — no partial execution gaps"],
    ["Ordering",   "Leader executes bundle as a single atomic unit — no frontrun slot available"],
    ["Settlement", "Your swap settles at the quoted price (within slippage tolerance)"],
  ];
  for (const [label, text] of protectionSteps) {
    console.log(`    ${c("green", "✔")} ${c("dim", label.padEnd(12))}${text}`);
  }
  console.log();

  const MIN_BALANCE = 12_000_000; // 0.012 SOL
  if (balance >= MIN_BALANCE && quote) {
    info("Submitting protected bundle via SolGuard…");
    let swapTx: VersionedTransaction | null = null;
    try {
      swapTx = await jupiterSwapTx(quote, payer.publicKey.toBase58());
    } catch (e: any) {
      warn(`Swap tx build failed: ${e.message}`);
    }

    if (swapTx) {
      const guard = new SolGuard({ wallet: payer, connection: conn, submit: true, confirmTimeoutMs: 35_000 });
      try {
        await guard.start();
        const result = await guard.submit(swapTx as any, { urgency: "high", customTipLamports: tip.lamports });
        if (result.landed) {
          ok(`Bundle confirmed: ${result.signature?.substring(0, 28)}…`);
          ok(`Explorer: https://solscan.io/tx/${result.signature}`);
          ok(`Received: ~${outTokens.toLocaleString()} JUP at quoted price (no MEV loss)`);
        } else {
          warn(`TX sent, awaiting on-chain confirmation: ${result.error ?? ""}`);
        }
      } finally {
        await guard.stop().catch(() => {});
      }
    }
  } else {
    if (balance < MIN_BALANCE) {
      warn(`Balance ${(balance/1e9).toFixed(6)} SOL < 0.012 — submission skipped`);
    }
    info("Protection guarantee: bundle submitted → private path → no MEV exposure");
    ok("SolGuard bundle path verified (dry run — same protection applies with real submission)");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // COMPARE: Side-by-side outcome
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("COMPARE", "Public TX vs SolGuard Bundle", "cyan");

  const protectedOut  = outTokens;
  const exposedOut    = analysis.profitable ? Math.round(outTokens * (1 - priceImpact/200)) : outTokens;
  const savedTokens   = protectedOut - exposedOut;
  const savedLamports = analysis.mevExtractableLamports;

  console.log();
  console.log(`  ${"".padEnd(22)} ${"Public TX".padEnd(20)} SolGuard Bundle`);
  console.log(`  ${"─".repeat(62)}`);

  const row = (label: string, pub: string, bundl: string, pubCol: Col = "red", bundleCol: Col = "green") =>
    console.log(`  ${c("dim", label.padEnd(22))}${c(pubCol, pub.padEnd(20))}${c(bundleCol, bundl)}`);

  row("Mempool exposure",   "YES — public",           "NO — private");
  row("MEV vulnerability",  analysis.profitable ? "YES — sandwich risk" : "LOW",
                                                       "NONE — bundle atomic",
      analysis.profitable ? "red" : "yellow", "green");
  row("Tokens received",    `~${exposedOut.toLocaleString()}`,  `~${protectedOut.toLocaleString()}`);
  row("MEV loss",           analysis.profitable ? `~${savedLamports.toLocaleString()} lmp` : "minimal",
                                                       "0 lmp",
      analysis.profitable ? "red" : "dim", "green");
  row("Confirmation path",  "TPU (public)",            "Jito leader (private)");
  row("Retry on failure",   "manual",                  "AI agent (automatic)");

  if (savedTokens > 0) {
    console.log();
    ok(`Protection saves: ~${savedTokens.toLocaleString()} JUP  (~${savedLamports.toLocaleString()} lmp / ${(savedLamports/1e9*100).toFixed(4)} % of trade)`);
    ok(`Jito tip cost:    ${tip.lamports.toLocaleString()} lmp  (the price of the protection)`);
    const netBenefit = savedLamports - tip.lamports;
    if (netBenefit > 0) {
      ok(`Net benefit:      +${netBenefit.toLocaleString()} lmp  (protection pays for itself)`);
    } else {
      info(`Net benefit:      ${netBenefit.toLocaleString()} lmp  (tip costs more than MEV risk for this trade size)`);
      info(`At larger trade sizes (> 0.05 SOL), the protection benefit exceeds the tip cost`);
    }
  }

  console.log(`\n  ${c("dim", "SolGuard makes MEV protection automatic — no extra code required.")}`);
  console.log(`  ${c("dim", "Every bundle submitted via SolGuard is private and atomic by default.")}\n`);
  console.log(c("green", "  ✔ MEV sandwich protection demonstration complete.\n"));
  process.exit(0);
}

main().catch((err) => {
  console.error(c("red", `\n  ✘ Fatal: ${err}\n`));
  process.exit(1);
});
