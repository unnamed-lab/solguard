/**
 * SolGuard orchestrator (plan §3 `index.ts`).
 *
 * Phases 0–3 wired: the Stream Manager feeds the Congestion Oracle and the
 * Lifecycle Tracker; the Leader Window Detector is polled on an interval; the
 * Dashboard renders the live state. The bundle pipeline (builder/submitter/
 * status) and the AI agent (Phase 4) attach as consumers of these same parts.
 */
import { StreamManager } from "./stream/manager.js";
import { walletPubkey } from "./solana/connection.js";
import { CongestionOracle, type CongestionSnapshot } from "./network/congestion.js";
import { LeaderWindowDetector, type LeaderWindow } from "./network/leader.js";
import { LifecycleTracker } from "./lifecycle/tracker.js";
import { Dashboard, type DashboardState } from "./dashboard/ui.js";
import { logger } from "./util/log.js";

const log = logger("orchestrator");

async function main() {
  const useDashboard = process.env.DASHBOARD !== "0";
  log.info("SolGuard starting", { phases: "0-3" });

  const stream = new StreamManager();
  const oracle = new CongestionOracle();
  const leader = new LeaderWindowDetector();
  const lifecycle = new LifecycleTracker();

  // follow our own signer's transactions for landing confirmation (FR-2)
  const me = walletPubkey();
  if (me) stream.trackAccounts([me]);

  await stream.start();

  // poll the Jito leader window on a light cadence
  let leaderWindow: LeaderWindow | undefined;
  const leaderTimer = setInterval(async () => {
    try {
      leaderWindow = await leader.window();
    } catch (err) {
      log.debug("leader window poll failed", { err: String(err) });
    }
  }, 1500);

  // dashboard
  let lastCongestion: CongestionSnapshot | undefined;
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

  // fan out stream events
  const cleanup = () => {
    clearInterval(leaderTimer);
    dash?.stop();
  };

  for await (const ev of stream.queue) {
    if (ev.kind === "slot") {
      oracle.ingest(ev);
      lifecycle.onSlotStatus(Number(ev.slot), ev.status, ev.ts);
      // refresh congestion snapshot cheaply on confirmed transitions
      if (ev.status === "confirmed") lastCongestion = oracle.snapshot();
    } else {
      // tx subscription runs at PROCESSED commitment; slot-status promotes it
      lifecycle.onTxEvent(ev, "processed");
    }
  }

  cleanup();
}

function latestStage(stages: Record<string, unknown>): string {
  for (const s of ["finalized", "confirmed", "processed", "submitted"]) {
    if (stages[s]) return s;
  }
  return "submitted";
}

let shuttingDown = false;
async function shutdown(stream?: StreamManager) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutting down");
  await stream?.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch((err) => {
  log.error("fatal", { err: String(err) });
  process.exit(1);
});
