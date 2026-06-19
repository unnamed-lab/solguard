/**
 * SolGuard orchestrator (plan §3 `index.ts`).
 *
 * Runs the unified stack: instantiates and starts the SolGuard SDK (Yellowstone
 * stream, oracle, leader detector, lifecycle tracker, AI agent) and starts the
 * developer REST API server in the same process to avoid gRPC connection conflicts.
 * Renders the terminal dashboard for live observability.
 */
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { walletPubkey } from "./solana/connection.js";
import { Dashboard, type DashboardState, type AgentDecisionRow } from "./dashboard/ui.js";
import { tipFloorService, type TipFloor } from "./tips/tipFloor.js";
import type { LeaderWindow } from "./network/leader.js";
import { computeTip } from "./tips/model.js";
import { logger } from "./util/log.js";
import { SolGuard } from "./sdk/solguard.js";
import { startServer } from "./server.js";
import { bridge } from "./events/bridge.js";

export { SolGuard } from "./sdk/solguard.js";

const log = logger("orchestrator");
const PORT = Number(process.env.PORT || 3000);

async function main() {
  const useDashboard = process.env.DASHBOARD !== "0";
  log.info("SolGuard starting", { phases: "0-3" });

  // Instantiate unified SDK
  const solguard = new SolGuard({ submit: true });
  await solguard.start();

  const stream = solguard.getStream()!;
  const oracle = solguard.getOracle()!;
  const leader = solguard.getLeader()!;
  const lifecycle = solguard.getLifecycle()!;

  // Follow our own signer's transactions for landing confirmation (FR-2)
  const me = walletPubkey();
  if (me) stream.trackAccounts([me]);

  const startedAt = Date.now();
  const tipSvc = solguard.getStream() ? solguard.getLifecycle() ? (solguard as any).tipFloor : null : null; 
  // Wait, let's get the tipFloorService from tipFloorService() directly as it's a singleton!
  // Yes, tipFloorService() returns the global singleton, so we can just use that.
  const tipSvcInstance = (solguard as any).tipFloor || tipFloorService();

  // Start the HTTP API Server in the same process
  const apiServer = startServer(solguard, PORT);
  log.info("Unified API Server started.");

  // Poll the Jito leader window on a light cadence
  let leaderWindow: LeaderWindow | undefined;
  const leaderTimer = setInterval(async () => {
    try {
      leaderWindow = await leader.window();
    } catch (err) {
      log.debug("leader window poll failed", { err: String(err) });
    }
  }, 1500);

  // Poll the tip floor every 30 s
  let lastTipFloor: TipFloor | undefined;
  let computedTipLamports: number | undefined;
  let computedTipPercentile: string | undefined;
  const tipTimer = setInterval(async () => {
    try {
      lastTipFloor = await tipSvcInstance.get();
      const snap = oracle.snapshot();
      if (lastTipFloor && snap) {
        const td = computeTip({
          tipFloor: lastTipFloor,
          congestionMultiplier: snap.congestionMultiplier,
          urgency: "normal",
        });
        computedTipLamports = td.lamports;
        computedTipPercentile = td.percentileKey;
      }
    } catch (err) {
      log.debug("tip floor poll failed", { err: String(err) });
    }
  }, 30_000);
  // Warm-start tip floor fetch
  void tipSvcInstance.get().then((tf: TipFloor) => { lastTipFloor = tf; }).catch(() => {});

  // Rolling 10-entry decision history for the dashboard
  const decisionHistory: AgentDecisionRow[] = [];

  // Listen to the bridge to capture agent decisions and update the dashboard history
  bridge.on("decision_event", (data: any) => {
    decisionHistory.push({
      rootCause: data.rootCause,
      action: data.action,
      confidence: data.confidence,
      diagnosis: data.diagnosis,
      newTipLamports: data.newTipLamports,
    });
    if (decisionHistory.length > 10) {
      decisionHistory.shift();
    }
  });

  // Dashboard
  const dash = useDashboard
    ? new Dashboard((): DashboardState => ({
        stream: stream.metrics(),
        congestion: oracle.snapshot(),
        leader: leaderWindow,
        tipFloor: lastTipFloor,
        computedTipLamports,
        computedTipPercentile,
        bundles: lifecycle.active().map((e) => ({
          bundleId: e.bundle_id,
          attempt: e.attempt,
          stage: latestStage(e.stages),
          tipLamports: e.tip_lamports,
        })),
        lastDecision: decisionHistory[decisionHistory.length - 1],
        decisionHistory: [...decisionHistory],
        startedAt,
      }))
    : undefined;
  dash?.start();

  // Teardown logic
  const cleanup = async () => {
    clearInterval(leaderTimer);
    clearInterval(tipTimer);
    dash?.stop();
    await apiServer.shutdown();
    await solguard.stop();
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
}

function latestStage(stages: Record<string, unknown>): string {
  for (const s of ["finalized", "confirmed", "processed", "submitted"]) {
    if (stages[s]) return s;
  }
  return "submitted";
}

// Check if this module is being run directly as a script
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const mainPath = realpathSync(process.argv[1]);
    const thisPath = fileURLToPath(import.meta.url);
    return mainPath === thisPath || 
           process.argv[1].endsWith("index.ts") || 
           process.argv[1].endsWith("index.js");
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    log.error("fatal", { err: String(err) });
    process.exit(1);
  });
}
