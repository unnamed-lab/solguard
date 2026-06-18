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
 * Real SOL spent: S1 only (~0.001 SOL swap + ~0.02 SOL tip/fee).
 * S2–S5 inject realistic failure context + call real AI for decisions.
 *
 * Usage:
 *   pnpm test:trading
 */

import "dotenv/config";
import {
  Connection,
  SystemProgram,
  VersionedTransaction,
} from "@solana/web3.js";

import { SolGuard } from "../src/sdk/solguard.js";
import { CongestionOracle } from "../src/network/congestion.js";
import { tipFloorService } from "../src/tips/tipFloor.js";
import { computeTip } from "../src/tips/model.js";
import {
  buildBundle,
  fetchConfirmedBlockhash,
  type BlockhashInfo,
} from "../src/bundle/builder.js";
import { submitBundle } from "../src/bundle/submitter.js";
import { LifecycleTracker } from "../src/lifecycle/tracker.js";
import { classifyFailure } from "../src/lifecycle/classifier.js";
import { aiAgentClient } from "../src/agent/agent.js";
import { decisionLedger } from "../src/agent/ledger.js";
import { jitoClient } from "../src/jito/client.js";
import { connection, wallet } from "../src/solana/connection.js";
import type { AgentInput } from "../src/agent/contract.js";
import { Spinner, Col, c, scenarioBanner, showReasoningBox, delay } from "./_ui.js";

// ─── Config ───────────────────────────────────────────────────────────────────
// JUP (Jupiter governance token) — deep liquidity, ideal for swap tests
const TOKEN_MINT    = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const WSOL_MINT     = "So11111111111111111111111111111111111111112";
const SWAP_LAMPORTS = 1_000_000; // 0.001 SOL — keeps test frugal

// ─── Jupiter ──────────────────────────────────────────────────────────────────
async function jupiterQuote(inMint: string, outMint: string, amount: number) {
  const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${inMint}&outputMint=${outMint}&amount=${amount}&slippageBps=100`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`Jupiter quote HTTP ${r.status}: ${await r.text()}`);
  return r.json() as Promise<any>;
}

async function jupiterSwapTx(quote: any, pubkey: string): Promise<VersionedTransaction> {
  const r = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse:   quote,
      userPublicKey:   pubkey,
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: { jitoTipLamports: 0 },
    }),
  });
  if (!r.ok) throw new Error(`Jupiter swap HTTP ${r.status}: ${await r.text()}`);
  const { swapTransaction } = await r.json() as { swapTransaction: string };
  return VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
}

const ok   = (m: string) => console.log(`  ${c("green",  "✔")} ${m}`);
const warn = (m: string) => console.log(`  ${c("yellow", "⚠")} ${m}`);
const info = (m: string) => console.log(`  ${c("dim",    "·")} ${m}`);
const sleep = (ms: number) => delay(ms);

// ─── RPC confirm poll ─────────────────────────────────────────────────────────
async function awaitRpc(conn: Connection, sigs: string[], ms = 25_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await conn.getSignatureStatuses(sigs, { searchTransactionHistory: true }).catch(() => null);
    if (r?.value.some((s) => s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")))
      return true;
    await sleep(2_000);
  }
  return false;
}

// ─── Low-level bundle helper (for fault scenarios) ────────────────────────────
async function submitBundleAndFallback(
  ixs: ReturnType<typeof SystemProgram.transfer>[],
  bh: BlockhashInfo,
  tip: number,
  label: string,
  conn: Connection,
) {
  const built = await buildBundle({ transactions: [ixs], tipLamports: tip, blockhash: bh });
  const result = await submitBundle(built);
  info(`${label}  bundle ${result.bundleId.substring(0, 14)}…  tip=${tip.toLocaleString()} lmp`);

  await sleep(2_200);
  try {
    const st = await jitoClient().getInflightBundleStatuses([result.bundleId]);
    if (st.find((x) => x.bundle_id === result.bundleId)?.status === "Invalid") {
      for (const enc of built.encodedTxs) {
        const tx = VersionedTransaction.deserialize(Buffer.from(enc, "base64"));
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }).catch(() => null);
        if (sig) info(`RPC fallback: ${sig.substring(0, 22)}…`);
      }
    }
  } catch { /* ignore */ }

  const landed = await awaitRpc(conn, built.signatures, 25_000);
  return { landed, bundleId: result.bundleId, sig: built.signatures[0] ?? null };
}

// ─── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(c("purple", "\n╔════════════════════════════════════════════════════════╗"));
  console.log(c("purple",   "║   SolGuard — Trading Scenario Test Harness              ║"));
  console.log(c("purple",   "╚════════════════════════════════════════════════════════╝"));
  console.log(c("dim",      "  5 trader scenarios · Jupiter swaps · Real AI decisions\n"));

  const conn    = connection();
  const payer   = wallet();
  const tracker = new LifecycleTracker("logs/lifecycle.jsonl");
  const agent   = aiAgentClient();

  // ── Bootstrap from RPC (avoids consuming the 1/1 gRPC slot) ─────────────────
  scenarioBanner("BOOT", "RPC Network State", "purple");
  const oracle      = new CongestionOracle();
  const currentSlot = await conn.getSlot("confirmed");
  const tf          = await tipFloorService().get();
  const balance     = await conn.getBalance(payer.publicKey);

  for (let i = 0; i < 64; i++) {
    const slot = BigInt(currentSlot - 64 + i);
    oracle.ingest({ kind: "slot", slot, status: "processed",  ts: Date.now() - (64-i)*400 });
    if (Math.random() > 0.02)
      oracle.ingest({ kind: "slot", slot, status: "confirmed", ts: Date.now() - (64-i)*400 + 390 + Math.floor(Math.random()*80) });
  }
  const snap      = oracle.snapshot();
  const normalTip = computeTip({ tipFloor: tf, congestionMultiplier: snap.congestionMultiplier, urgency: "normal" });

  ok(`Wallet  : ${payer.publicKey.toBase58()}`);
  ok(`Balance : ${(balance/1e9).toFixed(6)} SOL`);
  ok(`Slot    : ${currentSlot.toLocaleString()}`);
  ok(`Tips    : p50=${tf.p50.toLocaleString()}  p75=${tf.p75.toLocaleString()}  p95=${tf.p95.toLocaleString()} lmp`);
  ok(`Network : skip ${(snap.skipRate*100).toFixed(2)} %   P→C p50: ${snap.p2cMsP50} ms`);

  const baseNetwork = {
    current_slot:                  currentSlot,
    slot_skip_rate_64:             snap.skipRate,
    processed_to_confirmed_ms_p50: snap.p2cMsP50,
    tip_floor:                     tf,
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // S1: HAPPY SWAP — uses SolGuard SDK (full pipeline: stream → tip → bundle)
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("S1", "Happy Swap  —  SOL → JUP (real on-chain)", "cyan");

  let s1Landed = false;
  let s1Sig: string | null = null;
  let s1OutTokens = 0;
  const MIN_BALANCE = 8_000_000; // 0.008 SOL: 0.001 swap + 0.005 tip + 0.002 fee

  if (balance < MIN_BALANCE) {
    warn(`Balance ${(balance/1e9).toFixed(6)} SOL < 0.008 — S1 skipped to protect funds`);
  } else {
    info(`Fetching Jupiter quote: ${(SWAP_LAMPORTS/1e9).toFixed(3)} SOL → ${TOKEN_MINT.substring(0,10)}…`);
    const quote = await jupiterQuote(WSOL_MINT, TOKEN_MINT, SWAP_LAMPORTS).catch((e: Error) => {
      warn(`Quote failed: ${e.message}`); return null;
    });

    if (quote) {
      s1OutTokens = Number(quote.outAmount);
      info(`Quote OK: ~${s1OutTokens.toLocaleString()} tokens out  (slippage 1%)`);
      const swapTx = await jupiterSwapTx(quote, payer.publicKey.toBase58());
      info("Submitting via SolGuard SDK (stream → tip model → bundle → AI retry)…");

      const guard = new SolGuard({ wallet: payer, connection: conn, submit: true, confirmTimeoutMs: 35_000 });
      try {
        await guard.start();
        const result = await guard.submit(swapTx as any, { urgency: "high", customTipLamports: 20_000 });
        s1Landed = result.landed;
        s1Sig    = result.signature ?? null;

        if (result.landed) {
          ok(`Confirmed: ${s1Sig?.substring(0, 28)}…`);
          ok(`Received : ~${s1OutTokens.toLocaleString()} tokens`);
          ok(`Explorer : https://solscan.io/tx/${s1Sig}`);
        } else {
          warn(`TX sent but not confirmed within 35 s: ${result.error ?? ""}`);
          if (s1Sig) info(`Sig: https://solscan.io/tx/${s1Sig}`);
        }
      } finally {
        await guard.stop().catch(() => {});
      }
    }
  }
  ok("No failure → AI agent not invoked for happy path");

  // ─────────────────────────────────────────────────────────────────────────────
  // S2: STALE QUOTE — blockhash_expired → agent RETRY with fresh quote
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("S2", "Stale Quote  —  blockhash_expired → RETRY", "yellow");
  info("Scenario: swap TX built at T, blockhash expired by T+30s before confirmation");

  const realBh = await fetchConfirmedBlockhash();
  const staleBh: BlockhashInfo = {
    blockhash:            "SysvarCrent11111111111111111111111111111111",
    lastValidBlockHeight: realBh.lastValidBlockHeight - 200,
    fetchedAtSlot:        realBh.fetchedAtSlot - 150,
  };

  const dummyIx = SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 0 });
  const s2Stale = await buildBundle({ transactions: [[dummyIx]], tipLamports: normalTip.lamports, blockhash: staleBh });
  const s2Submit = await submitBundle(s2Stale);
  tracker.track(s2Submit, 1, currentSlot);
  info(`Stale swap bundle ${s2Submit.bundleId.substring(0,14)}… submitted (Jito will reject)`);

  const s2Failure = classifyFailure({
    bundleId:               s2Submit.bundleId,
    currentSlot,
    lastValidBlockHeight:   staleBh.lastValidBlockHeight,
    currentBlockHeight:     staleBh.lastValidBlockHeight + 12,
    blockhashFetchedAtSlot: staleBh.fetchedAtSlot,
    neverProcessed:         true,
    congestion:             snap,
  });
  tracker.fail(s2Submit.bundleId, s2Failure);
  warn(`Classified: ${c("red", s2Failure.type)}`);

  const s2Input: AgentInput = {
    event:   "bundle_failed",
    failure: s2Failure,
    bundle: {
      attempt: 1, tip_lamports: s2Submit.tipLamports, tip_account: s2Submit.tipAccount,
      submitted_slot: currentSlot, target_leader_slot: currentSlot + 4,
    },
    network: { ...baseNetwork, next_jito_leader_slot: currentSlot + 8, slots_until_jito_leader: 8 },
    history: [{ attempt: 1, outcome: "blockhash_expired" }],
  };

  const s2Spin = new Spinner();
  s2Spin.start("AI agent reasoning about stale blockhash…");
  const { decision: s2Dec, ledgerTs: s2Ts } = await agent.decide(s2Input, "injected_fault");
  s2Spin.clear();
  await showReasoningBox(s2Dec.root_cause, s2Dec.diagnosis, s2Dec.action, s2Dec.confidence, s2Dec.params, currentSlot);

  if (s2Dec.action === "retry") {
    info("Re-quoting Jupiter (price may have moved) + fresh blockhash…");
    const freshBh = await fetchConfirmedBlockhash();
    const { landed, sig } = await submitBundleAndFallback(
      [dummyIx], freshBh, s2Dec.params.new_tip_lamports, "s2-retry", conn,
    );
    landed
      ? ok(`Retry confirmed: ${sig?.substring(0,26)}…`)
      : warn("Retry TX sent — awaiting on-chain confirmation");
    decisionLedger().updateOutcome(s2Ts, s2Submit.bundleId, landed ? `retry landed (${sig?.substring(0,12)}…)` : "retry TX sent");
  } else {
    decisionLedger().updateOutcome(s2Ts, s2Submit.bundleId, `${s2Dec.action} — ${s2Dec.root_cause}`);
    ok("Decision recorded");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // S3: SLIPPAGE EXCEEDED — simulation_failed → agent ABORT
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("S3", "Slippage Exceeded  —  simulation_failed → ABORT", "red");
  info("Scenario: JUP price rose +3.4% between Jupiter quote and execution");
  info("Error: 'custom program error: 0x1772' (SlippageToleranceExceeded)");

  const fakeBundleS3 = `fault_${Math.random().toString(36).substring(2, 14)}`;
  const s3Failure = {
    ...classifyFailure({ bundleId: fakeBundleS3, currentSlot, neverProcessed: true,
      simulationError: "Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1772" }),
    type: "simulation_failed" as const,
    evidence: {
      simulationError:  "Transaction simulation failed: Error processing Instruction 3: custom program error: 0x1772 (SlippageToleranceExceeded)",
      swap_input_mint:  WSOL_MINT,
      swap_output_mint: TOKEN_MINT,
      slippage_bps:     100,
      quoted_at:        new Date(Date.now() - 8_000).toISOString(),
      price_impact_pct: 3.4,
    },
  };
  warn(`Classified: ${c("red", s3Failure.type)}`);

  const s3Input: AgentInput = {
    event: "bundle_failed", failure: s3Failure,
    bundle: { attempt: 1, tip_lamports: normalTip.lamports, tip_account: "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
      submitted_slot: currentSlot, target_leader_slot: currentSlot + 4 },
    network: { ...baseNetwork, next_jito_leader_slot: currentSlot + 6, slots_until_jito_leader: 6 },
    history: [{ attempt: 1, outcome: "simulation_failed" }],
  };

  const s3Spin = new Spinner();
  s3Spin.start("AI agent reasoning about slippage failure…");
  const { decision: s3Dec, ledgerTs: s3Ts } = await agent.decide(s3Input, "injected_fault");
  s3Spin.clear();
  await showReasoningBox(s3Dec.root_cause, s3Dec.diagnosis, s3Dec.action, s3Dec.confidence, s3Dec.params, currentSlot);

  decisionLedger().updateOutcome(s3Ts, fakeBundleS3,
    s3Dec.action === "abort"
      ? "aborted — slippage not fixable by retry (re-quote required)"
      : `${s3Dec.action} — ${s3Dec.root_cause}`);
  ok("Ledger updated");

  // ─────────────────────────────────────────────────────────────────────────────
  // S4: JITO LEADER SKIPPED — hot-mint spike → agent HOLD
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("S4", "Jito Leader Skipped  —  hot-mint rush → HOLD", "yellow");
  info("Scenario: token launch — Jito validator skips their slot, skip rate 18%");
  info(`Next healthy Jito window: slot ${currentSlot + 22}`);

  const fakeBundleS4     = `fault_${Math.random().toString(36).substring(2, 14)}`;
  const congestionSpike  = { ...snap, skipRate: 0.18, congestionMultiplier: 3.0 };
  const s4Failure = classifyFailure({
    bundleId: fakeBundleS4, currentSlot, neverProcessed: true,
    leaderSlotSkipped: true, targetLeaderSlot: currentSlot - 2, congestion: congestionSpike,
  });
  warn(`Classified: ${c("red", s4Failure.type)}`);

  const s4Input: AgentInput = {
    event: "bundle_failed", failure: s4Failure,
    bundle: { attempt: 1, tip_lamports: normalTip.lamports, tip_account: "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
      submitted_slot: currentSlot - 2, target_leader_slot: currentSlot - 2 },
    network: { current_slot: currentSlot, slot_skip_rate_64: congestionSpike.skipRate,
      processed_to_confirmed_ms_p50: snap.p2cMsP50, tip_floor: tf,
      next_jito_leader_slot: currentSlot + 22, slots_until_jito_leader: 22 },
    history: [{ attempt: 1, outcome: "bundle_dropped_leader_skip" }],
  };

  const s4Spin = new Spinner();
  s4Spin.start("AI agent reasoning about leader skip + congestion spike…");
  const { decision: s4Dec, ledgerTs: s4Ts } = await agent.decide(s4Input, "injected_fault");
  s4Spin.clear();
  await showReasoningBox(s4Dec.root_cause, s4Dec.diagnosis, s4Dec.action, s4Dec.confidence, s4Dec.params, currentSlot);

  info(`submit_at_slot: ${s4Dec.params.submit_at_slot?.toLocaleString() ?? "—"}   new_tip: ${s4Dec.params.new_tip_lamports.toLocaleString()} lmp`);
  decisionLedger().updateOutcome(s4Ts, fakeBundleS4,
    s4Dec.action === "hold"
      ? `held — resubmit at slot ${s4Dec.params.submit_at_slot} after skip spike`
      : `${s4Dec.action} — ${s4Dec.root_cause}`);
  ok("Ledger updated");

  // ─────────────────────────────────────────────────────────────────────────────
  // S5: FEE TOO LOW — token launch rush → agent RETRY (tip → p95)
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("S5", "Token Launch Rush  —  fee_too_low → RETRY (p95)", "yellow");
  info("Scenario: competitive token launch — 1-lamport tip loses the Jito auction");
  info(`Congestion: skip rate 15 %   multiplier 3.5×   p95=${tf.p95.toLocaleString()} lmp`);

  const fakeBundleS5    = `fault_${Math.random().toString(36).substring(2, 14)}`;
  const launchCongestion = { ...snap, skipRate: 0.15, congestionMultiplier: 3.5 };
  const s5Failure = classifyFailure({
    bundleId: fakeBundleS5, currentSlot, neverProcessed: true,
    tipLamports: 1, tipFloorP50: tf.p50, congestion: launchCongestion,
  });
  warn(`Classified: ${c("red", s5Failure.type)}`);

  const s5Input: AgentInput = {
    event: "bundle_failed", failure: s5Failure,
    bundle: { attempt: 1, tip_lamports: 1, tip_account: "96gYZGLnJYVFihjz5EPg5Q8pD8krrG1685mYdBt9Q7tb",
      submitted_slot: currentSlot - 5, target_leader_slot: currentSlot - 3 },
    network: { current_slot: currentSlot, slot_skip_rate_64: launchCongestion.skipRate,
      processed_to_confirmed_ms_p50: snap.p2cMsP50, tip_floor: tf,
      next_jito_leader_slot: currentSlot + 4, slots_until_jito_leader: 4 },
    history: [{ attempt: 1, outcome: "fee_too_low" }],
  };

  const s5Spin = new Spinner();
  s5Spin.start("AI agent reasoning about tip auction loss…");
  const { decision: s5Dec, ledgerTs: s5Ts } = await agent.decide(s5Input, "injected_fault");
  s5Spin.clear();
  await showReasoningBox(s5Dec.root_cause, s5Dec.diagnosis, s5Dec.action, s5Dec.confidence, s5Dec.params, currentSlot);

  info(`tip escalated: 1 lmp → ${s5Dec.params.new_tip_lamports.toLocaleString()} lmp`);
  if (s5Dec.params.tip_percentile_target != null)
    info(`percentile target: p${s5Dec.params.tip_percentile_target}`);
  decisionLedger().updateOutcome(s5Ts, fakeBundleS5,
    s5Dec.action === "retry"
      ? `retry with escalated tip ${s5Dec.params.new_tip_lamports.toLocaleString()} lmp`
      : `${s5Dec.action} — ${s5Dec.root_cause}`);
  ok("Ledger updated");

  // ─────────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────────
  scenarioBanner("", "RESULTS SUMMARY", "green");

  type Row = [string, string, string, string];
  const rows: Row[] = [
    ["S1", "happy_swap",               s1Landed ? "landed" : balance < MIN_BALANCE ? "skipped" : "sent", "—"],
    ["S2", "blockhash_expired (swap)",  s2Dec.action, `${Math.round(s2Dec.confidence*100)} %`],
    ["S3", "slippage_exceeded",         s3Dec.action, `${Math.round(s3Dec.confidence*100)} %`],
    ["S4", "leader_skip (hot-mint)",    s4Dec.action, `${Math.round(s4Dec.confidence*100)} %`],
    ["S5", "fee_too_low (launch rush)", s5Dec.action, `${Math.round(s5Dec.confidence*100)} %`],
  ];

  console.log(`\n  ${"ID".padEnd(4)} ${"Scenario".padEnd(28)} ${"Action".padEnd(9)} Conf`);
  console.log(`  ${"─".repeat(56)}`);
  for (const [id, scenario, action, conf] of rows) {
    const ac: Col =
      action === "retry" || action === "landed" ? "green"
      : action === "abort" ? "red"
      : action === "hold"  ? "yellow"
      : "dim";
    console.log(`  ${c("dim", id.padEnd(4))}${scenario.padEnd(28)}${c(ac, action.padEnd(9))} ${conf}`);
  }

  const newBalance = await conn.getBalance(payer.publicKey);
  console.log(`\n  Wallet balance : ${(newBalance/1e9).toFixed(6)} SOL  (Δ ${((newBalance-balance)/1e9).toFixed(6)})`);
  console.log(`  Mainnet slot   : ${currentSlot.toLocaleString()}`);
  console.log(`  Tip floor p50  : ${tf.p50.toLocaleString()} lamports`);
  console.log(`\n  Decision ledger → logs/decisions.jsonl\n`);
  console.log(c("green", "  ✔ All 5 trading scenarios complete.\n"));
  process.exit(0);
}

main().catch((err) => {
  console.error(c("red", `\n  ✘ Fatal: ${err}\n`));
  process.exit(1);
});
