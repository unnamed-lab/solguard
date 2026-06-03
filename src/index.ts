/**
 * SolGuard orchestrator (plan §3 `index.ts`).
 *
 * Phase 0 wires only the Stream Manager. Later phases attach the Congestion
 * Oracle, Leader Window Detector, Lifecycle Tracker, Tip model, Bundle
 * pipeline, AI Agent, and Dashboard as consumers of the same event queue.
 */
import { StreamManager } from "./stream/manager.js";
import { logger } from "./util/log.js";

const log = logger("orchestrator");

async function main() {
  log.info("SolGuard starting", { phase: 0 });

  const stream = new StreamManager();
  await stream.start();

  // TODO(phase-1): const oracle = new CongestionOracle();
  // TODO(phase-1): const leader = new LeaderWindowDetector();
  // TODO(phase-3): const lifecycle = new LifecycleTracker();

  for await (const ev of stream.queue) {
    // TODO: fan out to oracle / leader / lifecycle consumers
    if (ev.kind === "tx") {
      log.debug("tx event", { sig: ev.signature, slot: ev.slot.toString() });
    }
  }
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
