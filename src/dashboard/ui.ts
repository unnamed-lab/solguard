import type { StreamMetrics } from "../stream/events.js";
import type { CongestionSnapshot } from "../network/congestion.js";
import type { LeaderWindow } from "../network/leader.js";

/**
 * Terminal dashboard (plan §5.10 / NFR-3). Dependency-free ANSI renderer that
 * repaints on an interval. Shows the live slot ticker, congestion reading,
 * next Jito leader countdown, active bundles, the latest agent decision, and
 * the dropped-events / reconnect counters.
 */

export interface BundleRow {
  bundleId: string;
  attempt: number;
  stage: string;
  tipLamports: number;
}

export interface AgentDecisionRow {
  rootCause: string;
  action: string;
  confidence: number;
  diagnosis: string;
}

export interface DashboardState {
  stream: StreamMetrics;
  congestion?: CongestionSnapshot;
  leader?: LeaderWindow;
  bundles: BundleRow[];
  lastDecision?: AgentDecisionRow;
}

const CLEAR = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";

function color(v: string, c: string): string {
  return `${c}${v}${RESET}`;
}

function congestionColor(mult: number): string {
  if (mult < 1.4) return GREEN;
  if (mult < 2.2) return YELLOW;
  return RED;
}

export class Dashboard {
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly getState: () => DashboardState,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.render(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  render(): void {
    const s = this.getState();
    const lines: string[] = [];

    lines.push(color(`${BOLD}SolGuard — Autonomous Bundle Intelligence${RESET}`, CYAN));
    lines.push(color("─".repeat(64), DIM));

    // stream
    const st = s.stream;
    const conn = st.connected ? color("●  connected", GREEN) : color("●  disconnected", RED);
    lines.push(`stream     ${conn}   slot ${BOLD}${st.lastProcessedSlot}${RESET}`);
    lines.push(
      `           reconnects=${st.reconnects}  ` +
        `${st.droppedEvents > 0 ? color(`dropped=${st.droppedEvents}`, YELLOW) : `dropped=0`}  ` +
        `queue=${st.queueSize}  enq=${st.enqueued}`,
    );

    // congestion
    if (s.congestion) {
      const c = s.congestion;
      const mult = color(`×${c.congestionMultiplier.toFixed(2)}`, congestionColor(c.congestionMultiplier));
      lines.push(
        `congestion mult=${mult}  skip=${(c.skipRate * 100).toFixed(1)}%  ` +
          `p2c p50=${c.p2cMsP50}ms p95=${c.p2cMsP95}ms  (n=${c.sampleCount})`,
      );
    } else {
      lines.push(color("congestion warming up…", DIM));
    }

    // leader
    if (s.leader) {
      const l = s.leader;
      const win = l.inSubmitWindow ? color("IN WINDOW", GREEN) : color("waiting", DIM);
      lines.push(
        `jito       next leader slot ${l.nextJitoLeaderSlot} ` +
          `(in ${l.slotsUntilJitoLeader} slots)  ${win}` +
          (l.region ? `  region=${l.region}` : ""),
      );
    } else {
      lines.push(color("jito       leader window unknown", DIM));
    }

    lines.push(color("─".repeat(64), DIM));

    // bundles
    lines.push(`${BOLD}active bundles${RESET} (${s.bundles.length})`);
    if (s.bundles.length === 0) {
      lines.push(color("  none", DIM));
    } else {
      for (const b of s.bundles.slice(0, 6)) {
        lines.push(
          `  ${b.bundleId.slice(0, 8)}…  attempt ${b.attempt}  ` +
            `${b.stage.padEnd(10)} tip=${b.tipLamports}`,
        );
      }
    }

    lines.push(color("─".repeat(64), DIM));

    // latest agent decision
    if (s.lastDecision) {
      const d = s.lastDecision;
      const actColor = d.action === "abort" ? RED : d.action === "hold" ? YELLOW : GREEN;
      lines.push(`${BOLD}latest agent decision${RESET}`);
      lines.push(
        `  root_cause=${d.rootCause}  action=${color(d.action, actColor)}  ` +
          `confidence=${d.confidence.toFixed(2)}`,
      );
      lines.push(color(`  "${truncate(d.diagnosis, 58)}"`, DIM));
    } else {
      lines.push(color("no agent decisions yet", DIM));
    }

    process.stdout.write(CLEAR + lines.join("\n") + "\n");
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
