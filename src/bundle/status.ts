import { jitoClient } from "../jito/client.js";
import { logger } from "../util/log.js";
import type { LifecycleTracker } from "../lifecycle/tracker.js";
import type { Commitment } from "../stream/events.js";

const log = logger("status");

/**
 * Bundle-status reconciliation (plan §5.5, FR-17).
 *
 * SECONDARY signal only — landing is confirmed from the stream (FR-16). This
 * polls `getInflightBundleStatuses` early, then `getBundleStatuses`, and feeds
 * any stages the stream hasn't already provided into the tracker via
 * `tracker.reconcile`. It must never be the sole confirmation path.
 */
export class StatusReconciler {
  constructor(
    private readonly tracker: LifecycleTracker,
    private readonly jito = jitoClient(),
  ) {}

  /**
   * Poll a bundle until it lands/fails or the deadline passes. Returns the last
   * observed inflight status. Designed to run alongside (not instead of) the
   * stream-based tracker.
   */
  async poll(bundleId: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const intervalMs = opts.intervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    let last = "Pending";

    while (Date.now() < deadline) {
      try {
        const [inflight] = await this.jito.getInflightBundleStatuses([bundleId]);
        if (inflight) {
          last = inflight.status;
          if (inflight.status === "Landed") {
            await this.reconcileFinal(bundleId);
            return last;
          }
          if (inflight.status === "Failed" || inflight.status === "Invalid") {
            return last;
          }
        }
      } catch (err) {
        log.warn("inflight poll error", { bundleId, err: String(err) });
      }
      await sleep(intervalMs);
    }
    return last;
  }

  /** Pull detailed statuses and reconcile confirmation level into the tracker. */
  private async reconcileFinal(bundleId: string): Promise<void> {
    try {
      const [status] = await this.jito.getBundleStatuses([bundleId]);
      if (!status) return;
      const commitment = mapConfirmation(status.confirmation_status);
      if (commitment) {
        this.tracker.reconcile(bundleId, commitment, status.slot);
        log.debug("reconciled via status api", { bundleId, commitment, slot: status.slot });
      }
    } catch (err) {
      log.warn("getBundleStatuses error", { bundleId, err: String(err) });
    }
  }
}

function mapConfirmation(c: string | null): Commitment | undefined {
  if (c === "processed" || c === "confirmed" || c === "finalized") return c;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
