import type { StreamMetrics } from "../stream/events.js";
import type { CongestionSnapshot } from "../network/congestion.js";
import type { LeaderWindow } from "../network/leader.js";
import type { TipFloor } from "../tips/tipFloor.js";

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
  newTipLamports?: number;
}

export interface DashboardState {
  stream: StreamMetrics;
  congestion?: CongestionSnapshot;
  leader?: LeaderWindow;
  tipFloor?: TipFloor;
  /** computed tip for the current congestion snapshot */
  computedTipLamports?: number;
  computedTipPercentile?: string;
  bundles: BundleRow[];
  lastDecision?: AgentDecisionRow;
  /** ring of last N decisions for history panel */
  decisionHistory?: AgentDecisionRow[];
  startedAt?: number;
}

// ── ANSI palette ──────────────────────────────────────────────────────────────
const CLEAR     = "\x1b[2J\x1b[H";
const DIM       = "\x1b[2m";
const BOLD      = "\x1b[1m";
const RESET     = "\x1b[0m";
const GREEN     = "\x1b[32m";
const YELLOW    = "\x1b[33m";
const RED       = "\x1b[31m";
const CYAN      = "\x1b[36m";
const BLUE      = "\x1b[34m";
const MAGENTA   = "\x1b[35m";
const WHITE     = "\x1b[37m";
const BG_DARK   = "\x1b[48;5;234m";
const FG_ORANGE = "\x1b[38;5;214m";
const FG_TEAL   = "\x1b[38;5;80m";

const W = 72; // render width

function c(text: string, ansi: string): string {
  return `${ansi}${text}${RESET}`;
}
function bold(text: string): string { return `${BOLD}${text}${RESET}`; }
function dim(text: string): string  { return `${DIM}${text}${RESET}`; }

function ruler(ch = "─"): string {
  return c(ch.repeat(W), DIM);
}

function pad(s: string, n: number): string {
  // strip ANSI when measuring
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  const needed = n - visible.length;
  return needed > 0 ? s + " ".repeat(needed) : s;
}

function rpad(s: string, n: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "");
  const needed = n - visible.length;
  return needed > 0 ? " ".repeat(needed) + s : s;
}

// ── Congestion colouring ─────────────────────────────────────────────────────
function multColor(mult: number): string {
  if (mult < 1.4) return GREEN;
  if (mult < 2.0) return YELLOW;
  if (mult < 2.6) return FG_ORANGE;
  return RED;
}

function skipColor(rate: number): string {
  if (rate < 0.05) return GREEN;
  if (rate < 0.10) return YELLOW;
  if (rate < 0.15) return FG_ORANGE;
  return RED;
}

function latencyColor(ms: number): string {
  if (ms < 400)  return GREEN;
  if (ms < 700)  return YELLOW;
  if (ms < 1200) return FG_ORANGE;
  return RED;
}

// ── Mini bar chart (5-bar spark) ─────────────────────────────────────────────
function sparkBar(values: number[], width = 5): string {
  const BARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const max = Math.max(...values, 1);
  return values
    .slice(-width)
    .map((v) => {
      const idx = Math.min(BARS.length - 1, Math.floor((v / max) * BARS.length));
      return BARS[idx]!;
    })
    .join("");
}

// ── Lamport → human ──────────────────────────────────────────────────────────
function lamports(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(3)} SOL`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

// ── Stage pill ───────────────────────────────────────────────────────────────
function stagePill(stage: string): string {
  switch (stage) {
    case "finalized":  return c("finalized ", GREEN);
    case "confirmed":  return c("confirmed ", FG_TEAL);
    case "processed":  return c("processed ", YELLOW);
    case "submitted":  return c("submitted ", BLUE);
    default:           return dim(stage.padEnd(10));
  }
}

// ── Action pill ──────────────────────────────────────────────────────────────
function actionPill(action: string): string {
  switch (action) {
    case "retry": return c("retry", GREEN);
    case "hold":  return c("hold ", YELLOW);
    case "abort": return c("abort", RED);
    default:      return dim(action);
  }
}

// ── Uptime ───────────────────────────────────────────────────────────────────
function uptime(startedAt?: number): string {
  if (!startedAt) return "";
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}h ${m}m ${ss}s`;
}

// ── Leader countdown bar ─────────────────────────────────────────────────────
function leaderBar(slotsAway: number, maxShow = 20): string {
  const filled = Math.max(0, maxShow - Math.min(slotsAway, maxShow));
  const bar = "█".repeat(filled) + "░".repeat(maxShow - filled);
  const col = slotsAway <= 4 ? GREEN : slotsAway <= 10 ? YELLOW : DIM;
  return c(`[${bar}]`, col);
}

// ── Tip floor row ─────────────────────────────────────────────────────────────
function tipFloorRow(tf: TipFloor, computed?: number, percentile?: string): string {
  const pctileColor = (key: string) =>
    key === percentile ? c(key, FG_ORANGE) : dim(key);

  const entries = (["p25", "p50", "p75", "p95", "p99"] as const).map((k) => {
    const val = c(lamports(tf[k]).padStart(6), WHITE);
    return `${pctileColor(k)}:${val}`;
  });

  let row = `tips       ${entries.join("  ")}`;
  if (computed !== undefined && percentile) {
    row += `  ${dim("→")}  ${c("using " + percentile, FG_ORANGE)}: ${c(bold(lamports(computed)), CYAN)}`;
  }
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────

export class Dashboard {
  private timer?: NodeJS.Timeout;
  private slotHistory: number[] = [];
  private lastSlot = 0n;
  private lastSlotAt = 0;
  private slotsPerSec = 0;

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
    const now = Date.now();

    // ── header ──────────────────────────────────────────────────────────────
    const title = `${BG_DARK}${BOLD}${CYAN}  SolGuard — Autonomous Bundle Intelligence  ${RESET}`;
    const ageStr = dim(uptime(s.startedAt));
    const titlePad = W - 48; // approximate
    lines.push(`${title}${" ".repeat(Math.max(0, titlePad))}${ageStr}`);
    lines.push(ruler());

    // ── stream panel ─────────────────────────────────────────────────────────
    const st = s.stream;
    const conn = st.connected
      ? c("● connected   ", GREEN)
      : c("● disconnected", RED);

    // slot throughput
    const curSlot = BigInt(st.lastProcessedSlot);
    if (curSlot > this.lastSlot && this.lastSlot > 0n) {
      const dtSec = (now - this.lastSlotAt) / 1000;
      this.slotsPerSec = Number(curSlot - this.lastSlot) / Math.max(dtSec, 0.001);
      this.slotHistory.push(Math.round(this.slotsPerSec));
      if (this.slotHistory.length > 20) this.slotHistory.shift();
    }
    if (curSlot !== this.lastSlot) { this.lastSlot = curSlot; this.lastSlotAt = now; }

    const throughput = this.slotHistory.length > 1
      ? `  ${sparkBar(this.slotHistory)} ${this.slotsPerSec.toFixed(1)} sl/s`
      : "";

    lines.push(
      `stream     ${conn}  slot ${bold(st.lastProcessedSlot)}${throughput}`
    );
    const drops = st.droppedEvents > 0
      ? c(`dropped=${st.droppedEvents}`, YELLOW)
      : dim("dropped=0");
    lines.push(
      dim(`           reconnects=${st.reconnects}  `) +
      drops +
      dim(`  queue=${st.queueSize}  enqueued=${st.enqueued}`)
    );

    // ── congestion panel ─────────────────────────────────────────────────────
    lines.push(ruler("╌"));
    if (s.congestion) {
      const cong = s.congestion;
      const multStr  = c(`×${cong.congestionMultiplier.toFixed(2)}`, multColor(cong.congestionMultiplier));
      const skipStr  = c(`${(cong.skipRate * 100).toFixed(1)}%`, skipColor(cong.skipRate));
      const p50Str   = c(`${cong.p2cMsP50}ms`, latencyColor(cong.p2cMsP50));
      const p95Str   = c(`${cong.p2cMsP95}ms`, latencyColor(cong.p2cMsP95));

      // Health label
      const mult = cong.congestionMultiplier;
      const healthLabel = mult < 1.4
        ? c("● HEALTHY", GREEN)
        : mult < 2.2
          ? c("◐ MODERATE", YELLOW)
          : c("● CONGESTED", RED);

      lines.push(
        `congestion ${healthLabel}   ` +
        `mult=${multStr}  skip=${skipStr}  ` +
        `p2c p50=${p50Str} p95=${p95Str}  ${dim("n=" + cong.sampleCount)}`
      );
    } else {
      lines.push(dim("congestion warming up… (waiting for confirmed slots)"));
    }

    // ── tip floor panel ──────────────────────────────────────────────────────
    lines.push(ruler("╌"));
    if (s.tipFloor) {
      lines.push(tipFloorRow(s.tipFloor, s.computedTipLamports, s.computedTipPercentile));
      const tf = s.tipFloor;
      const age = Math.round((now - tf.fetchedAt) / 1000);
      lines.push(dim(`           ema=${lamports(tf.ema).padStart(6)}  fetched ${age}s ago`));
    } else {
      lines.push(dim("tips       fetching Jito tip floor…"));
    }

    // ── leader window panel ──────────────────────────────────────────────────
    lines.push(ruler("╌"));
    if (s.leader) {
      const l = s.leader;
      const winStatus = l.inSubmitWindow
        ? c("  ▶ IN WINDOW — submit now", GREEN)
        : c("  ▷ waiting for window    ", DIM);
      const bar = leaderBar(l.slotsUntilJitoLeader);
      lines.push(
        `jito       ${bar}  slot ${bold(String(l.nextJitoLeaderSlot))}  ` +
        `${dim("in")} ${bold(String(l.slotsUntilJitoLeader))} ${dim("slots")}` +
        (l.region ? `  ${dim("region=" + l.region)}` : "")
      );
      lines.push(winStatus);
    } else {
      lines.push(dim("jito       leader window unknown (fetching leader schedule…)"));
    }

    // ── active bundles ───────────────────────────────────────────────────────
    lines.push(ruler());
    const bHeader = `${bold("active bundles")} ${dim("(" + s.bundles.length + ")")}`;
    lines.push(bHeader);
    if (s.bundles.length === 0) {
      lines.push(dim("  none"));
    } else {
      for (const b of s.bundles.slice(0, 5)) {
        const id   = c(b.bundleId.slice(0, 8) + "…", DIM);
        const att  = dim(`attempt ${b.attempt}`);
        const pill = stagePill(b.stage);
        const tip  = c(lamports(b.tipLamports), FG_TEAL);
        lines.push(`  ${id}  ${att}  ${pill}  tip=${tip}`);
      }
      if (s.bundles.length > 5) {
        lines.push(dim(`  … and ${s.bundles.length - 5} more`));
      }
    }

    // ── agent decision panel ─────────────────────────────────────────────────
    lines.push(ruler());
    lines.push(bold("ai agent"));
    if (s.lastDecision) {
      const d = s.lastDecision;
      const pill = actionPill(d.action);
      const conf = d.confidence >= 0.8
        ? c(d.confidence.toFixed(2), GREEN)
        : d.confidence >= 0.5
          ? c(d.confidence.toFixed(2), YELLOW)
          : c(d.confidence.toFixed(2), RED);
      lines.push(
        `  ${dim("cause:")} ${c(d.rootCause, FG_ORANGE)}  ` +
        `${dim("action:")} ${pill}  ` +
        `${dim("confidence:")} ${conf}` +
        (d.newTipLamports !== undefined
          ? `  ${dim("→ tip:")} ${c(lamports(d.newTipLamports), CYAN)}`
          : "")
      );
      lines.push(`  ${dim("└")} ${c('"' + truncate(d.diagnosis, W - 6) + '"', DIM)}`);
    } else {
      lines.push(dim("  no agent decisions yet"));
    }

    // ── decision history ring ────────────────────────────────────────────────
    const hist = s.decisionHistory?.slice(-4) ?? [];
    if (hist.length > 0) {
      lines.push(dim("  history: ") + hist.map((h) =>
        `${actionPill(h.action)}${dim("/" + h.rootCause.slice(0, 6))}`
      ).join(dim("  →  ")));
    }

    // ── footer ───────────────────────────────────────────────────────────────
    lines.push(ruler());
    lines.push(
      dim("  ctrl-c to exit") +
      " ".repeat(Math.max(0, W - 30)) +
      dim(new Date().toLocaleTimeString())
    );

    process.stdout.write(CLEAR + lines.join("\n") + "\n");
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
