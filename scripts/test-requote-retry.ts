/**
 * USE CASE: Re-quote Retry Loop
 *
 * Demonstrates SolGuard's intelligent retry when a DEX swap fails slippage:
 * - A naive system aborts and forces the user to start over
 * - SolGuard re-quotes Jupiter with a fresh price + widened tolerance and retries
 *
 * Scenarios:
 *   S1  Initial SOL → JUP swap quote at T (100 bps slippage)
 *   S2  Slippage exceeded simulation via API (fails, agent recommends abort/re-quote)
 *   S3  Re-quote loop: fresh Jupiter price + 200 bps slippage → new bundle → submitted
 *   S4  Compare: naive abort vs SolGuard re-quote path
 *
 * Usage:
 *   pnpm test:requote
 */

import "dotenv/config";
import { SystemProgram, VersionedTransaction, TransactionMessage } from "@solana/web3.js";
import { tipFloorService } from "../src/tips/tipFloor.js";
import { connection, wallet } from "../src/solana/connection.js";
import { Spinner, c, scenarioBanner, delay, submitTransaction } from "./_ui.js";

const WSOL_MINT       = "So11111111111111111111111111111111111111112";
const JUP_MINT        = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const SWAP_LAMPORTS   = 2_000_000;   // 0.002 SOL
const INITIAL_SLIP    = 100;          // 1% slippage
const RETRY_SLIP      = 200;          // 2% slippage
const MIN_SOL_BALANCE = 10_000_000;   // 0.01 SOL

async function jupiterQuote(inMint: string, outMint: string, amount: number, slippageBps: number) {
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
      quoteResponse:              quote,
      userPublicKey:              pubkey,
      wrapAndUnwrapSol:           true,
      prioritizationFeeLamports:  { jitoTipLamports: 0 },
    }),
  });
  if (!r.ok) throw new Error(`Jupiter swap HTTP ${r.status}`);
  const { swapTransaction } = await r.json() as { swapTransaction: string };
  return VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
}

const ok   = (m: string) => console.log(`  ${c("green",  "✔")} ${m}`);
const warn = (m: string) => console.log(`  ${c("yellow", "⚠")} ${m}`);
const info = (m: string) => console.log(`  ${c("dim",    "·")} ${m}`);

async function main() {
  console.log(c("purple", "\n╔════════════════════════════════════════════════════════╗"));
  console.log(c("purple",   "║   SolGuard — Re-quote Retry Loop                        ║"));
  console.log(c("purple",   "╚════════════════════════════════════════════════════════╝"));
  console.log(c("dim",      "  Use case: slippage failure → re-quote → land\n"));
  console.log(c("bold" as any, "  DESCRIPTION:"));
  console.log("    Demonstrates SolGuard's intelligent recovery when a token's price");
  console.log("    moves beyond your slippage limit. Instead of just failing or naive-retrying");
  console.log("    with a stale price, SolGuard fetches a fresh quote and resubmits.");
  console.log();
  console.log(c("dim",      "  STEPS:"));
  console.log("    1. Fetches an initial quote from Jupiter (SOL -> JUP) at 1% slippage.");
  console.log("    2. Submits the transaction simulating a slippage_exceeded fault.");
  console.log("    3. AI Agent aborts the stale transaction to protect your fill price.");
  console.log("    4. Client re-quotes Jupiter, widens slippage to 2%, and lands a new bundle.");
  console.log();

  const conn   = connection();
  const payer  = wallet();

  scenarioBanner("BOOT", "Network Bootstrap", "purple");
  const currentSlot = await conn.getSlot("confirmed");
  const tf          = await tipFloorService().get();
  const balance     = await conn.getBalance(payer.publicKey);

  ok(`Wallet  : ${payer.publicKey.toBase58()}`);
  ok(`Balance : ${(balance/1e9).toFixed(6)} SOL`);
  ok(`Slot    : ${currentSlot.toLocaleString()}`);

  // ─── S1: INITIAL QUOTE ─────────────────────────────────────────────────────
  scenarioBanner("S1", "Initial Jupiter Quote  (100 bps slippage)", "cyan");
  let initialQuote: any = null;
  let initialOutAmount = 0;

  try {
    initialQuote = await jupiterQuote(WSOL_MINT, JUP_MINT, SWAP_LAMPORTS, INITIAL_SLIP);
    initialOutAmount = Number(initialQuote.outAmount);
    ok(`Quote received: ~${initialOutAmount.toLocaleString()} JUP out`);
  } catch (e: any) {
    warn(`Jupiter unavailable: ${e.message}`);
    initialOutAmount = 2_500_000;
    initialQuote = { outAmount: String(initialOutAmount), priceImpactPct: "0.08" };
  }

  // ─── S2: SLIPPAGE FAILURE ──────────────────────────────────────────────────
  scenarioBanner("S2", "Slippage Exceeded  —  AI classifies simulation_failed", "red");
  info("Submitting swap transaction via API simulating slippage failure...");

  let initialTx: VersionedTransaction;
  try {
    initialTx = await jupiterSwapTx(initialQuote, payer.publicKey.toBase58());
  } catch {
    const dummyIx = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 });
    initialTx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: "SysvarCrent11111111111111111111111111111111", instructions: [dummyIx] }).compileToV0Message());
  }

  const s2Result = await submitTransaction(initialTx, conn, payer, {
    urgency: "high",
    customTipLamports: tf.p50,
    simulateFault: "slippage_exceeded"
  });

  if (s2Result.landed) {
    warn(`Unexpected confirmation: transaction landed instead of aborting`);
  } else {
    ok(`AI Agent aborted stale transaction as expected: ${s2Result.error}`);
  }

  // ─── S3: RE-QUOTE LOOP ─────────────────────────────────────────────────────
  scenarioBanner("S3", "Re-quote Loop  —  Fresh Price + 200 bps Slippage", "green");
  info("Fetching fresh Jupiter quote (T+8s) and submitting...");

  let s3Landed = false;
  let s3Sig: string | null = null;
  let reQuoteOut = 0;

  if (balance < MIN_SOL_BALANCE) {
    warn(`Balance ${(balance/1e9).toFixed(6)} SOL < 0.01 — S3 real submission skipped`);
  } else {
    try {
      const freshQuote = await jupiterQuote(WSOL_MINT, JUP_MINT, SWAP_LAMPORTS, RETRY_SLIP);
      reQuoteOut = Number(freshQuote.outAmount);
      ok(`Re-quote:  ~${reQuoteOut.toLocaleString()} JUP at ${RETRY_SLIP} bps slippage`);

      const freshTx = await jupiterSwapTx(freshQuote, payer.publicKey.toBase58());
      const result = await submitTransaction(freshTx, conn, payer, {
        urgency: "high",
        customTipLamports: tf.p75,
        confirmTimeoutMs: 35_000
      });

      s3Landed = result.landed;
      s3Sig    = result.signature ?? null;
      if (s3Landed) {
        ok(`Confirmed : ${s3Sig?.substring(0, 28)}…`);
        ok(`Explorer  : https://solscan.io/tx/${s3Sig}`);
      } else {
        warn(`Submission failed: ${result.error}`);
      }
    } catch (e: any) {
      warn(`Jupiter/API failed: ${e.message}`);
    }
  }

  // ─── S4: COMPARISON ────────────────────────────────────────────────────────
  scenarioBanner("S4", "Naive Abort vs SolGuard Re-quote", "cyan");

  console.log(`\n  ${"Approach".padEnd(28)} ${"Outcome".padEnd(22)} Notes`);
  console.log(`  ${"─".repeat(70)}`);
  console.log(`  ${c("red",   "Naive retry (same tx)".padEnd(28))}${"fails again".padEnd(22)}${c("dim", "stale price → deterministic fail")}`);
  console.log(`  ${c("red",   "Naive abort".padEnd(28))}${"user starts over".padEnd(22)}${c("dim", "misses the window entirely")}`);
  console.log(`  ${c("green", "SolGuard re-quote".padEnd(28))}${(s3Landed ? "landed ✔" : "submitted").padEnd(22)}${c("dim", `fresh price · ${RETRY_SLIP} bps · new bundle`)}`);

  console.log(`\n  Decision ledger → logs/decisions.jsonl\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error(c("red", `\n  ✘ Fatal: ${err}\n`));
  process.exit(1);
});
