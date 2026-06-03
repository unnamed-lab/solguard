/**
 * Stream probe — Phase 0 DoD harness (`pnpm stream`).
 *
 * Connects to Yellowstone, prints live slot transitions and rolling metrics,
 * and proves the resilience guarantees: kill the network mid-run and confirm
 * it reconnects, replays from `fromSlot`, and dedupes (no missed/double slots).
 */
import { StreamManager } from "./manager.js";
import { logger } from "../util/log.js";

const log = logger("probe");

async function main() {
  const mgr = new StreamManager();
  await mgr.start();

  // periodic metrics line
  const metricsTimer = setInterval(() => {
    const m = mgr.metrics();
    log.info("metrics", {
      connected: m.connected,
      lastSlot: m.lastProcessedSlot,
      reconnects: m.reconnects,
      dropped: m.droppedEvents,
      queue: m.queueSize,
      enqueued: m.enqueued,
    });
  }, 5000);

  // drain events
  let slots = 0;
  let txs = 0;
  for await (const ev of mgr.queue) {
    if (ev.kind === "slot") {
      slots++;
      if (slots % 50 === 0) log.debug("slot", { slot: ev.slot.toString(), status: ev.status });
    } else {
      txs++;
      log.info("tx", { sig: ev.signature, slot: ev.slot.toString(), failed: ev.failed });
    }
  }

  clearInterval(metricsTimer);
  void txs;
}

process.on("SIGINT", () => {
  log.info("shutting down");
  process.exit(0);
});

main().catch((err) => {
  log.error("probe crashed", { err: String(err) });
  process.exit(1);
});
