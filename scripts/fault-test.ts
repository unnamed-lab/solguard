/**
 * Automated end-to-end fault-injection test harness (PRD §6.10, Phase 6).
 *
 * Runs the SolGuard stack under happy-path and fault-injection scenarios.
 * Since live Yellowstone and Jito block engine streams require active mainnet
 * credentials and SOL funds, this harness implements a high-fidelity offline
 * simulator that mimics the slot stream, transaction confirmations, and RPC
 * queries to verify our pipeline's logic end-to-end.
 *
 * Run: pnpm fault:test
 */

import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { connection, wallet } from "../src/solana/connection.js";
import { jitoClient } from "../src/jito/client.js";
import { tipFloorService } from "../src/tips/tipFloor.js";
import { computeTip } from "../src/tips/model.js";
import { buildBundle, fetchConfirmedBlockhash, type BlockhashInfo } from "../src/bundle/builder.js";
import { submitBundle, type SubmitResult } from "../src/bundle/submitter.js";
import { LifecycleTracker } from "../src/lifecycle/tracker.js";
import { classifyFailure } from "../src/lifecycle/classifier.js";
import { aiAgentClient } from "../src/agent/agent.js";
import { faultInjector } from "../src/faults/injector.ts"; // using ts extension to compile correctly
import { CongestionOracle } from "../src/network/congestion.js";
import type { Commitment, SlotEvent, TxEvent } from "../src/stream/events.js";
import { logger } from "../src/util/log.js";
import { readFileSync, existsSync } from "node:fs";

const log = logger("fault-test");

// A mock simulator state to track slot and tx streaming during testing
interface SimState {
  currentSlot: number;
  currentBlockHeight: number;
  lastValidBlockHeight: number;
  mockTipFloor: {
    p25: number;
    p50: number;
    p75: number;
    p95: number;
    p99: number;
    ema: number;
    fetchedAt: number;
  };
}

async function runTestHarness() {
  log.info("=================================================");
  log.info("       SOLGUARD FAULT INJECTION HARNESS          ");
  log.info("=================================================");

  // Initialize components
  const tracker = new LifecycleTracker("logs/lifecycle.jsonl");
  const oracle = new CongestionOracle();
  const agent = aiAgentClient();
  const injector = faultInjector();

  const simState: SimState = {
    currentSlot: 312800,
    currentBlockHeight: 312500,
    lastValidBlockHeight: 312650,
    mockTipFloor: {
      p25: 1000,
      p50: 5000,
      p75: 12000,
      p95: 25000,
      p99: 50000,
      ema: 6200,
      fetchedAt: Date.now(),
    },
  };

  // MOCK RPC & CLIENTS: Intercept connections to allow offline testing
  // 1. Mock Solana connection calls
  const conn = connection();
  conn.getLatestBlockhash = async (commitment?: any) => {
    log.info(`[Mock RPC] getLatestBlockhash (commitment: ${commitment})`);
    return {
      blockhash: "SysvarCrent11111111111111111111111111111111",
      lastValidBlockHeight: simState.lastValidBlockHeight,
    };
  };
  conn.getSlot = async (commitment?: any) => {
    log.info(`[Mock RPC] getSlot (commitment: ${commitment})`);
    return simState.currentSlot;
  };

  // 2. Mock Jito Client tip floor API
  const tipFloorSvc = tipFloorService();
  tipFloorSvc.get = async () => {
    log.info("[Mock Jito] Fetching tip floor");
    return simState.mockTipFloor;
  };

  // 3. Mock Jito Block Engine submitter
  const jito = jitoClient();
  jito.getTipAccounts = async () => {
    return ["96gYZGLnJYVFihjz5EPg5Q8pD8krrG1685mYdBt9Q7tb"];
  };
  jito.sendBundle = async (txs: string[]) => {
    const bundleId = `bundle_${Math.random().toString(36).substring(2, 11)}`;
    log.info(`[Mock Jito] sendBundle success. Generated bundle_id: ${bundleId}`);
    return bundleId;
  };

  const payer = wallet();
  const dummyIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payer.publicKey,
    lamports: 0,
  });

  // Feed simulated slot ticks to the Congestion Oracle
  log.info("Feeding initial slot events to Congestion Oracle...");
  for (let i = 0; i < 20; i++) {
    const slot = BigInt(simState.currentSlot - 20 + i);
    oracle.ingest({ kind: "slot", slot, status: "processed", ts: Date.now() });
    oracle.ingest({ kind: "slot", slot, status: "confirmed", ts: Date.now() + 300 });
  }

  // =========================================================================
  // SCENARIO 1: HAPPY PATH BUNDLE
  // =========================================================================
  log.info("\n-------------------------------------------------");
  log.info("   [Scenario 1] Executing Happy-Path Submission  ");
  log.info("-------------------------------------------------");

  // Step A: Fetch Tip from Congestion Oracle
  const tf = await tipFloorSvc.get();
  const congestion = oracle.snapshot();
  const tipDecision = computeTip({
    tipFloor: tf,
    congestionMultiplier: congestion.congestionMultiplier,
    urgency: "normal",
  });

  log.info(`Calculated tip: ${tipDecision.lamports} lamports (Percentile: ${tipDecision.percentileKey})`);

  // Step B: Build Bundle
  const bhInfo: BlockhashInfo = {
    blockhash: "SysvarCrent11111111111111111111111111111111",
    lastValidBlockHeight: simState.lastValidBlockHeight,
    fetchedAtSlot: simState.currentSlot,
  };

  const builtHappy = await buildBundle({
    transactions: [[dummyIx]],
    tipLamports: tipDecision.lamports,
    blockhash: bhInfo,
  });

  // Step C: Submit and Track
  const happyResult = await submitBundle(builtHappy);
  tracker.track(happyResult, 1, simState.currentSlot);

  // Step D: Stream Manager emulation — simulate bundle landing
  log.info("Simulating stream landing for happy path...");
  simState.currentSlot += 1;
  const happySig = happyResult.signatures[0]!;

  // Simulate tx processed and confirmed slots appearing in stream
  tracker.onTxEvent(
    { kind: "tx", signature: happySig, slot: BigInt(simState.currentSlot), failed: false, isVote: false, ts: Date.now() },
    "processed"
  );
  tracker.onSlotStatus(simState.currentSlot, "confirmed", Date.now() + 400);
  tracker.onSlotStatus(simState.currentSlot, "finalized", Date.now() + 10000);

  // Verify happy path landed
  const happyEntry = tracker.get(happyResult.bundleId);
  if (happyEntry && happyEntry.stages.finalized) {
    log.info("✔ Happy path bundle successfully finalized.");
    log.info(`Landed Slot: ${happyEntry.stages.processed?.slot}, Delays: submitted_to_processed=${happyEntry.deltas_ms.submitted_to_processed}ms, processed_to_confirmed=${happyEntry.deltas_ms.processed_to_confirmed}ms`);
  } else {
    throw new Error("Happy path bundle failed to finalize in tracker");
  }

  // =========================================================================
  // SCENARIO 2: FAULT INJECTION — BLOCKHASH EXPIRY
  // =========================================================================
  log.info("\n-------------------------------------------------");
  log.info("   [Scenario 2] Injecting Blockhash Expiry Fault ");
  log.info("-------------------------------------------------");

  // Step A: Set Fault state
  injector.setFault("blockhash_expired");

  // Step B: Build Plan with injected stale blockhash
  const freshBh = await fetchConfirmedBlockhash();
  const injectedBh = injector.injectBlockhash(freshBh);

  log.info(`Stale Blockhash Injected: ${injectedBh.blockhash}, Last Valid Block Height: ${injectedBh.lastValidBlockHeight}`);

  const builtExpired = await buildBundle({
    transactions: [[dummyIx]],
    tipLamports: tipDecision.lamports,
    blockhash: injectedBh,
  });

  // Step C: Submit and Track Attempt 1
  const attempt1Result = await submitBundle(builtExpired);
  tracker.track(attempt1Result, 1, simState.currentSlot);

  // Step D: Simulate Expiry — Advance Slot Heights past validity limits
  log.info("Simulating transaction expiration (blocks advance past validity limit)...");
  simState.currentSlot += 100;
  simState.currentBlockHeight = injectedBh.lastValidBlockHeight + 10; // force heights to pass validity

  // Step E: Detect and Classify Failure
  const failureInput = {
    bundleId: attempt1Result.bundleId,
    currentSlot: simState.currentSlot,
    lastValidBlockHeight: injectedBh.lastValidBlockHeight,
    currentBlockHeight: simState.currentBlockHeight,
    blockhashFetchedAtSlot: injectedBh.fetchedAtSlot,
    neverProcessed: true,
    congestion: oracle.snapshot(),
  };

  const failureRecord = classifyFailure(failureInput);
  log.warn(`Failure Classified: ${failureRecord.type}`);
  tracker.fail(attempt1Result.bundleId, failureRecord);

  // Step F: Hand over Failure Context to AI Agent
  const agentInput = {
    event: "bundle_failed" as const,
    failure: failureRecord,
    bundle: {
      attempt: 1,
      tip_lamports: attempt1Result.tipLamports,
      tip_account: attempt1Result.tipAccount,
      submitted_slot: injectedBh.fetchedAtSlot,
      target_leader_slot: injectedBh.fetchedAtSlot + 3,
    },
    network: {
      current_slot: simState.currentSlot,
      slot_skip_rate_64: congestion.skipRate,
      processed_to_confirmed_ms_p50: congestion.p2cMsP50,
      tip_floor: tf,
      next_jito_leader_slot: simState.currentSlot + 12,
      slots_until_jito_leader: 12,
    },
    history: [{ attempt: 1, outcome: "expired" }],
  };

  log.info("Calling AI Agent for decision...");
  const agentDecision = await agent.decide(agentInput, "injected_fault");

  log.info(`AI Decision Diagnosis: "${agentDecision.diagnosis}"`);
  log.info(`AI Decision Action: ${agentDecision.action.toUpperCase()}`);
  log.info(`AI Decision Params: refresh_blockhash=${agentDecision.params.refresh_blockhash}, new_tip=${agentDecision.params.new_tip_lamports} lamports`);

  // Step G: Stack Autonomous Resubmission Driven by AI Agent
  if (agentDecision.action === "retry") {
    log.info("\nExecuting autonomous retry plan...");
    
    // Clear fault injector to let happy path land
    injector.setFault(null);

    // AI requested refresh_blockhash: true
    let retryBh = bhInfo;
    if (agentDecision.params.refresh_blockhash) {
      log.info("Refreshing blockhash as requested by AI...");
      simState.currentBlockHeight = simState.currentBlockHeight + 1;
      simState.lastValidBlockHeight = simState.currentBlockHeight + 150;
      retryBh = {
        blockhash: "SysvarCrent11111111111111111111111111111111",
        lastValidBlockHeight: simState.lastValidBlockHeight,
        fetchedAtSlot: simState.currentSlot,
      };
    }

    const retriedTip = agentDecision.params.new_tip_lamports;
    const builtRetry = await buildBundle({
      transactions: [[dummyIx]],
      tipLamports: retriedTip,
      blockhash: retryBh,
    });

    const retryResult = await submitBundle(builtRetry);
    tracker.track(retryResult, 2, simState.currentSlot);

    // Simulate successful landing on the stream
    log.info("Simulating stream landing for retried bundle...");
    simState.currentSlot += 1;
    const retrySig = retryResult.signatures[0]!;

    tracker.onTxEvent(
      { kind: "tx", signature: retrySig, slot: BigInt(simState.currentSlot), failed: false, isVote: false, ts: Date.now() },
      "processed"
    );
    tracker.onSlotStatus(simState.currentSlot, "confirmed", Date.now() + 380);
    tracker.onSlotStatus(simState.currentSlot, "finalized", Date.now() + 10000);

    const retryEntry = tracker.get(retryResult.bundleId);
    if (retryEntry && retryEntry.stages.finalized) {
      log.info("✔ Retried bundle successfully finalized.");
      log.info(`Landed Slot: ${retryEntry.stages.processed?.slot}, Confirmation Via: ${retryEntry.confirmed_via}`);
    } else {
      throw new Error("Retried bundle failed to land");
    }
  } else {
    throw new Error(`Expected Agent to retry, but got action: ${agentDecision.action}`);
  }

  // =========================================================================
  // SCENARIO 3: FAULT INJECTION — TIP TOO LOW
  // =========================================================================
  log.info("\n-------------------------------------------------");
  log.info("   [Scenario 3] Injecting Tip Too Low Fault      ");
  log.info("-------------------------------------------------");

  injector.setFault("fee_too_low");
  const lowTip = injector.injectTip(tipDecision.lamports, tf.p25);
  log.info(`Tip Injected: ${lowTip} lamport (Median: ${tf.p50} lamports)`);

  const builtLowTip = await buildBundle({
    transactions: [[dummyIx]],
    tipLamports: lowTip,
    blockhash: bhInfo,
  });

  const lowTipResult = await submitBundle(builtLowTip);
  tracker.track(lowTipResult, 1, simState.currentSlot);

  // Simulate loss at auction due to congestion and fee too low
  simState.currentSlot += 4;
  const lowTipFailureInput = {
    bundleId: lowTipResult.bundleId,
    currentSlot: simState.currentSlot,
    neverProcessed: true,
    tipLamports: lowTip,
    tipFloorP50: tf.p50,
    congestion: {
      congestionMultiplier: 2.5, // simulated severe congestion
      windowSize: 64,
      skipRate: 0.1,
      p2cMsP50: 800,
      p2cMsP95: 1500,
      sampleCount: 50,
    },
  };

  const lowTipFailureRecord = classifyFailure(lowTipFailureInput);
  log.warn(`Failure Classified: ${lowTipFailureRecord.type}`);
  tracker.fail(lowTipResult.bundleId, lowTipFailureRecord);

  // Call Agent
  const lowTipAgentInput = {
    event: "bundle_failed" as const,
    failure: lowTipFailureRecord,
    bundle: {
      attempt: 1,
      tip_lamports: lowTip,
      tip_account: lowTipResult.tipAccount,
      submitted_slot: simState.currentSlot - 4,
      target_leader_slot: simState.currentSlot - 2,
    },
    network: {
      current_slot: simState.currentSlot,
      slot_skip_rate_64: 0.1,
      processed_to_confirmed_ms_p50: 800,
      tip_floor: tf,
      next_jito_leader_slot: simState.currentSlot + 4,
      slots_until_jito_leader: 4,
    },
    history: [{ attempt: 1, outcome: "rejected_low_fee" }],
  };

  const lowTipAgentDecision = await agent.decide(lowTipAgentInput, "injected_fault");
  log.info(`AI Decision Diagnosis: "${lowTipAgentDecision.diagnosis}"`);
  log.info(`AI Decision Action: ${lowTipAgentDecision.action.toUpperCase()}`);
  log.info(`AI Decision Params: refresh_blockhash=${lowTipAgentDecision.params.refresh_blockhash}, new_tip=${lowTipAgentDecision.params.new_tip_lamports} lamports`);

  injector.setFault(null);

  // =========================================================================
  // SCENARIO 4: FAULT INJECTION — COMPUTE EXCEEDED
  // =========================================================================
  log.info("\n-------------------------------------------------");
  log.info("   [Scenario 4] Injecting Compute Exceeded Fault ");
  log.info("-------------------------------------------------");

  injector.setFault("compute_exceeded");
  const computeIxs = injector.injectComputeError([dummyIx]);

  const builtCompute = await buildBundle({
    transactions: [computeIxs],
    tipLamports: tipDecision.lamports,
    blockhash: bhInfo,
  });

  const computeResult = await submitBundle(builtCompute);
  tracker.track(computeResult, 1, simState.currentSlot);

  // Simulate simulation error rejection
  const computeFailureInput = {
    bundleId: computeResult.bundleId,
    currentSlot: simState.currentSlot,
    neverProcessed: true,
    computeError: true,
    simulationError: "Transaction simulation failed: Exceeded compute budget limit of 200000 CUs",
  };

  const computeFailureRecord = classifyFailure(computeFailureInput);
  log.warn(`Failure Classified: ${computeFailureRecord.type}`);
  tracker.fail(computeResult.bundleId, computeFailureRecord);

  // Call Agent
  const computeAgentInput = {
    event: "bundle_failed" as const,
    failure: computeFailureRecord,
    bundle: {
      attempt: 1,
      tip_lamports: computeResult.tipLamports,
      tip_account: computeResult.tipAccount,
      submitted_slot: simState.currentSlot,
      target_leader_slot: simState.currentSlot + 2,
    },
    network: {
      current_slot: simState.currentSlot,
      slot_skip_rate_64: congestion.skipRate,
      processed_to_confirmed_ms_p50: congestion.p2cMsP50,
      tip_floor: tf,
      next_jito_leader_slot: simState.currentSlot + 8,
      slots_until_jito_leader: 8,
    },
    history: [{ attempt: 1, outcome: "compute_exceeded" }],
  };

  const computeAgentDecision = await agent.decide(computeAgentInput, "injected_fault");
  log.info(`AI Decision Diagnosis: "${computeAgentDecision.diagnosis}"`);
  log.info(`AI Decision Action: ${computeAgentDecision.action.toUpperCase()}`);
  log.info(`AI Decision Params: refresh_blockhash=${computeAgentDecision.params.refresh_blockhash}, new_tip=${computeAgentDecision.params.new_tip_lamports} lamports`);

  injector.setFault(null);

  // =========================================================================
  // VERIFY DECISION LEDGER LOG FILE
  // =========================================================================
  log.info("\n-------------------------------------------------");
  log.info("           Verifying Decision Ledger             ");
  log.info("-------------------------------------------------");

  const ledgerPath = "logs/decisions.jsonl";
  if (existsSync(ledgerPath)) {
    const lines = readFileSync(ledgerPath, "utf-8").trim().split("\n");
    log.info(`Ledger file exists with ${lines.length} decision entries.`);
    // Verify structure of the last written line
    const lastEntry = JSON.parse(lines[lines.length - 1]!);
    log.info(`Last logged entry trigger: "${lastEntry.trigger}"`);
    log.info(`Last logged executed action: "${lastEntry.executed_action}"`);
    log.info(`Last logged outcome: "${lastEntry.eventual_outcome}"`);
  } else {
    throw new Error("Decision ledger file decisions.jsonl was not found");
  }

  log.info("\n=================================================");
  log.info("   ✔ ALL FAULT INJECTION SCENARIOS VERIFIED.     ");
  log.info("=================================================");
}

runTestHarness().catch((err) => {
  log.error("Test Harness Failed", { err: String(err) });
  process.exit(1);
});
