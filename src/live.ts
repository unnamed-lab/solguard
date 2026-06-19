/**
 * SolGuard LIVE orchestrator (`pnpm live`).
 *
 * This is the FULL pipeline wired end-to-end against the real network — the
 * piece `pnpm start` (observability, Phases 0-3) deliberately leaves out:
 *
 *   stream → oracle → leader window → SUBMIT bundle (dynamic tip)
 *          → confirm via stream → on failure: classify → AI AGENT decides
 *          → retry / hold / abort → resubmit → lifecycle log + decision ledger
 *
 * The AI agent (Phase 4) runs here on REAL failures (`trigger: real_failure`),
 * not just the injected ones in the fault-test harness — satisfying AGENT.md §7.
 *
 * SAFETY: defaults to DRY-RUN (builds + signs, never sends to Jito, no SOL
 * spent). Pass `--submit` to actually broadcast bundles on mainnet. A max-attempt
 * cap and the configured tip ceiling bound cost either way.
 *
 *   pnpm live              # full loop, dry-run (no submission)
 *   pnpm live --submit     # full loop, REAL submissions (spends SOL)
 */
import { SystemProgram } from "@solana/web3.js";
import { config } from "./config.js";
import { StreamManager } from "./stream/manager.js";
import { wallet, walletPubkey } from "./solana/connection.js";
import { CongestionOracle, type CongestionSnapshot } from "./network/congestion.js";
import { LeaderWindowDetector, type LeaderWindow } from "./network/leader.js";
import { LifecycleTracker } from "./lifecycle/tracker.js";
import { classifyFailure } from "./lifecycle/classifier.js";
import { tipFloorService } from "./tips/tipFloor.js";
import { computeTip } from "./tips/model.js";
import {
  buildBundle,
  fetchConfirmedBlockhash,
  type BlockhashInfo,
} from "./bundle/builder.js";
import { submitBundle } from "./bundle/submitter.js";
import { jitoClient } from "./jito/client.js";
import { aiAgentClient } from "./agent/agent.js";
import { decisionLedger } from "./agent/ledger.js";
import type { AgentInput } from "./agent/contract.js";
import { Dashboard, type DashboardState } from "./dashboard/ui.js";
import { logger } from "./util/log.js";

const log = logger("live");

const SUBMIT = process.argv.includes("--submit");
const MAX_ATTEMPTS = Number(process.env.LIVE_MAX_ATTEMPTS ?? 3);
// How long we wait for stream confirmation before treating a bundle as failed.
const CONFIRM_TIMEOUT_MS = Number(process.env.LIVE_CONFIRM_TIMEOUT_MS ?? 30_000);
// Minimum gap between submit attempts so we don't spam the block engine.
const SUBMIT_COOLDOWN_MS = Number(process.env.LIVE_SUBMIT_COOLDOWN_MS ?? 20_000);

interface AttemptCtx {
  attempt: number;
  history: Array<{ attempt: number; outcome: string }>;
}

async function main() {
  log.info("SolGuard LIVE starting", {
    mode: SUBMIT ? "SUBMIT (real bundles, spends SOL)" : "DRY-RUN (no submission)",
    maxAttempts: MAX_ATTEMPTS,
  });

  const stream = new StreamManager();
  const oracle = new CongestionOracle();
  const leader = new LeaderWindowDetector();
  const lifecycle = new LifecycleTracker();
  const tipFloor = tipFloorService();
  const agent = aiAgentClient(); // hard-fails fast if ANTHROPIC_API_KEY is missing
  const jito = jitoClient();

  // Follow our own signer so the tracker confirms landing from the stream (FR-2/16).
  const me = walletPubkey();
  if (!me) throw new Error("WALLET_SECRET_KEY required for the live pipeline.");
  stream.trackAccounts([me]);

  await stream.start();

  // Poll the Jito leader window on a light cadence.
  let leaderWindow: LeaderWindow | undefined;
  const leaderTimer = setInterval(async () => {
    try {
      leaderWindow = await leader.window();
    } catch (err) {
      log.debug("leader window poll failed", { err: String(err) });
    }
  }, 1500);

  // Dashboard.
  let lastCongestion: CongestionSnapshot | undefined;
  const useDashboard = process.env.DASHBOARD !== "0";
  const dash = useDashboard
    ? new Dashboard((): DashboardState => ({
        stream: stream.metrics(),
        congestion: lastCongestion,
        leader: leaderWindow,
        bundles: lifecycle.active().map((e) => ({
          bundleId: e.bundle_id,
          attempt: e.attempt,
          stage: latestStage(e.stages),
          tipLamports: e.tip_lamports,
        })),
      }))
    : undefined;
  dash?.start();

  // ---- the submit/decide loop runs alongside stream consumption -----------
  let busy = false;
  let lastSubmitAt = 0;
  const loopTimer = setInterval(() => {
    if (busy) return;
    const w = leaderWindow;
    if (!w || !w.inSubmitWindow) return;
    if (Date.now() - lastSubmitAt < SUBMIT_COOLDOWN_MS) return;
    busy = true;
    lastSubmitAt = Date.now();
    runOneBundle({ attempt: 1, history: [] }, w)
      .catch((err) => log.error("bundle cycle failed", { err: String(err) }))
      .finally(() => {
        busy = false;
      });
  }, 1000);

  // Fan out stream events (same as the orchestrator).
  const cleanup = async () => {
    clearInterval(leaderTimer);
    clearInterval(loopTimer);
    dash?.stop();
    await stream.stop();
  };

  let shuttingDown = false;
  const handleShutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down...`);
    await cleanup();
    process.exit(0);
  };

  process.on("SIGINT", () => void handleShutdown("SIGINT"));
  process.on("SIGTERM", () => void handleShutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    dash?.stop();
    console.error("Uncaught Exception:", err);
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    dash?.stop();
    console.error("Unhandled Rejection:", reason);
    process.exit(1);
  });

  // Drain the stream so the oracle/lifecycle stay live. This runs forever.
  (async () => {
    for await (const ev of stream.queue) {
      if (ev.kind === "slot") {
        oracle.ingest(ev);
        lifecycle.onSlotStatus(Number(ev.slot), ev.status, ev.ts);
        if (ev.status === "confirmed") lastCongestion = oracle.snapshot();
      } else {
        lifecycle.onTxEvent(ev, "processed");
      }
    }
    void cleanup();
  })();

  // -------------------------------------------------------------------------
  // One full bundle attempt: build → submit → await stream confirmation →
  // on failure, classify → ask the agent → apply its decision → recurse.
  // -------------------------------------------------------------------------
  async function runOneBundle(ctx: AttemptCtx, win: LeaderWindow, override?: AgentOverride): Promise<void> {
    const tf = await tipFloor.get();
    const congestion = oracle.snapshot();

    // Tip is ALWAYS derived from live tip_floor × congestion (FR-9). The agent
    // may override the percentile/amount on a retry, but never a literal.
    const tip = override?.newTipLamports != null
      ? clampTip(override.newTipLamports, tf.p25)
      : computeTip({
          tipFloor: tf,
          congestionMultiplier: congestion.congestionMultiplier,
          urgency: "normal",
        }).lamports;

    const blockhash: BlockhashInfo = await fetchConfirmedBlockhash();

    const payer = wallet();
    const noopIx = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: 0,
    });

    const built = await buildBundle({
      transactions: [[noopIx]],
      tipLamports: tip,
      blockhash,
    });

    const submittedSlot = win.currentSlot;
    const targetLeaderSlot = win.nextJitoLeaderSlot;

    if (!SUBMIT) {
      log.info("DRY-RUN: built + signed bundle (not submitted)", {
        attempt: ctx.attempt,
        tip,
        targetLeaderSlot,
        blockhash: built.blockhash,
      });
      // In dry-run we can't observe a real landing, so we stop here. The fault
      // path below is exercised live only under --submit.
      return;
    }

    const result = await submitBundle(built);
    lifecycle.track(result, ctx.attempt, submittedSlot);
    log.info("bundle submitted live", {
      bundleId: result.bundleId,
      attempt: ctx.attempt,
      tip,
      targetLeaderSlot,
    });

    // Confirm via the stream (FR-16). Reconcile with Jito status as a secondary
    // signal only (FR-17) to decide whether it truly failed.
    const landed = await awaitConfirmation(result.bundleId);
    if (landed) {
      log.info("bundle confirmed via stream", { bundleId: result.bundleId });
      return;
    }

    // ---- FAILURE PATH: classify → agent → apply decision ------------------
    if (ctx.attempt >= MAX_ATTEMPTS) {
      lifecycle.fail(result.bundleId, classifyTimeout(result.bundleId, win, tip, tf.p50, congestion));
      log.warn("max attempts reached; giving up", { bundleId: result.bundleId, attempt: ctx.attempt });
      return;
    }

    const failure = classifyTimeout(result.bundleId, win, tip, tf.p50, congestion);
    lifecycle.fail(result.bundleId, failure);
    log.warn("bundle failed; routing to AI agent", {
      bundleId: result.bundleId,
      type: failure.type,
    });

    const agentInput: AgentInput = {
      event: "bundle_failed",
      failure,
      bundle: {
        attempt: ctx.attempt,
        tip_lamports: tip,
        tip_account: result.tipAccount,
        submitted_slot: submittedSlot,
        target_leader_slot: targetLeaderSlot,
      },
      network: {
        current_slot: leaderWindow?.currentSlot ?? submittedSlot,
        slot_skip_rate_64: congestion.skipRate,
        processed_to_confirmed_ms_p50: congestion.p2cMsP50,
        tip_floor: tf,
        next_jito_leader_slot: leaderWindow?.nextJitoLeaderSlot ?? targetLeaderSlot,
        slots_until_jito_leader: leaderWindow?.slotsUntilJitoLeader ?? 0,
      },
      history: ctx.history,
    };

    // REAL failure → real agent decision in the ledger.
    const { decision, ledgerTs } = await agent.decide(agentInput, "real_failure");
    log.info("agent decision", {
      action: decision.action,
      rootCause: decision.root_cause,
      newTip: decision.params.new_tip_lamports,
      confidence: decision.confidence,
    });

    const nextHistory = [
      ...ctx.history,
      { attempt: ctx.attempt, outcome: failure.type },
    ];

    if (decision.action === "abort") {
      decisionLedger().updateOutcome(ledgerTs, result.bundleId, `aborted — ${decision.root_cause}`);
      return;
    }

    if (decision.action === "hold") {
      decisionLedger().updateOutcome(ledgerTs, result.bundleId, "held — re-evaluating next window");
      return; // the loop will pick the next window naturally
    }

    // retry: apply the agent's tip; refresh blockhash happens implicitly since
    // runOneBundle fetches a fresh confirmed blockhash each call.
    const freshWindow = leaderWindow ?? win;
    const outcome = await runOneBundleAndReport(
      { attempt: ctx.attempt + 1, history: nextHistory },
      freshWindow,
      { newTipLamports: decision.params.new_tip_lamports },
    );
    decisionLedger().updateOutcome(ledgerTs, result.bundleId, outcome);
  }

  // Wrapper that returns a human outcome string for the ledger.
  async function runOneBundleAndReport(ctx: AttemptCtx, win: LeaderWindow, override?: AgentOverride): Promise<string> {
    try {
      await runOneBundle(ctx, win, override);
      return `retry attempt ${ctx.attempt} executed`;
    } catch (err) {
      return `retry attempt ${ctx.attempt} errored: ${String(err)}`;
    }
  }

  /** Wait for the lifecycle tracker to mark this bundle confirmed (stream-primary). */
  async function awaitConfirmation(bundleId: string): Promise<boolean> {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const entry = lifecycle.get(bundleId);
      if (entry?.stages.confirmed) return true;
      if (entry?.failure) return false;
      await sleep(500);
    }
    // Secondary reconciliation: did Jito see it land even if the stream lagged?
    try {
      const statuses = await jito.getBundleStatuses([bundleId]);
      const s = statuses.find((x) => x.bundle_id === bundleId);
      if (s && (s.confirmation_status === "confirmed" || s.confirmation_status === "finalized")) {
        lifecycle.reconcile(bundleId, s.confirmation_status, s.slot);
        return true;
      }
    } catch (err) {
      log.debug("status reconciliation failed", { err: String(err) });
    }
    return false;
  }

}

interface AgentOverride {
  newTipLamports?: number;
}

/**
 * Build a failure record for a bundle that never confirmed within the deadline.
 * Uses the live blockhash/leader/congestion context the classifier expects.
 */
function classifyTimeout(
  bundleId: string,
  win: LeaderWindow,
  tipLamports: number,
  tipFloorP50: number,
  congestion: CongestionSnapshot,
) {
  return classifyFailure({
    bundleId,
    currentSlot: win.currentSlot,
    neverProcessed: true,
    targetLeaderSlot: win.nextJitoLeaderSlot,
    tipLamports,
    tipFloorP50,
    congestion,
  });
}

/** Clamp an agent-chosen tip to [tip_floor.p25, ceiling] — never a literal tip. */
function clampTip(lamports: number, floor: number): number {
  return Math.min(config.tips.ceilingLamports, Math.max(floor, Math.round(lamports)));
}

function latestStage(stages: Record<string, unknown>): string {
  for (const s of ["finalized", "confirmed", "processed", "submitted"]) {
    if (stages[s]) return s;
  }
  return "submitted";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  log.error("fatal", { err: String(err) });
  process.exit(1);
});
