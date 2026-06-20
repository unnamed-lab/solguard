import type { StreamMetrics } from "../stream/events.js";
import type { CongestionSnapshot } from "../network/congestion.js";
import type { LeaderWindow } from "../network/leader.js";
import type { TipFloor } from "../tips/tipFloor.js";
import { logBuffer, enableFileLogging, disableFileLogging } from "../util/log.js";

/**
 * Terminal dashboard — btop/k9s-style boxed panel layout.
 * Zero external dependencies; pure ANSI escape codes.
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
  computedTipLamports?: number;
  computedTipPercentile?: string;
  bundles: BundleRow[];
  lastDecision?: AgentDecisionRow;
  decisionHistory?: AgentDecisionRow[];
  startedAt?: number;
}

// ── ANSI codes ────────────────────────────────────────────────────────────────
const ESC   = "\x1b[";
const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const DIM   = "\x1b[2m";
const BLINK = "\x1b[5m";

// standard palette
const FG_BLACK   = ESC + "30m";
const FG_RED     = ESC + "31m";
const FG_GREEN   = ESC + "32m";
const FG_YELLOW  = ESC + "33m";
const FG_BLUE    = ESC + "34m";
const FG_MAGENTA = ESC + "35m";
const FG_CYAN    = ESC + "36m";
const FG_WHITE   = ESC + "37m";

// 256-colour helpers
const fg = (n: number) => `${ESC}38;5;${n}m`;
const bg = (n: number) => `${ESC}48;5;${n}m`;

// curated 256-colour palette
const ORANGE    = fg(214);
const TEAL      = fg(87);
const PURPLE    = fg(141);
const PINK      = fg(213);
const LIME      = fg(154);
const SKY       = fg(75);
const SLATE     = fg(240);
const GOLD      = fg(220);
const ROSE      = fg(204);
const INDIGO    = fg(105);

const BG_HEADER = bg(17);   // deep navy for banner
const BG_PANEL  = bg(235);  // very dark grey panel background
const BG_ALERT  = bg(52);   // dark red alert bg

// ── box-drawing ───────────────────────────────────────────────────────────────
const BOX = {
  tl: "╔", tr: "╗", bl: "╚", br: "╝",
  h: "═", v: "║",
  ml: "╠", mr: "╣", mt: "╦", mb: "╩", mx: "╬",
  // light variants for inner lines
  lh: "─", lv: "│",
  ltl: "┌", ltr: "┐", lbl: "└", lbr: "┘",
  lml: "├", lmr: "┤",
};

// ── helpers ───────────────────────────────────────────────────────────────────
function a(text: string, ...codes: string[]): string {
  return codes.join("") + text + RESET;
}

function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function rpad(s: string, n: number, fillChar = " "): string {
  const extra = n - visLen(s);
  return extra > 0 ? s + fillChar.repeat(extra) : s;
}

function lpad(s: string, n: number, fillChar = " "): string {
  const extra = n - visLen(s);
  return extra > 0 ? fillChar.repeat(extra) + s : s;
}

function center(s: string, n: number, fill = " "): string {
  const extra = Math.max(0, n - visLen(s));
  const left  = Math.floor(extra / 2);
  const right = extra - left;
  return fill.repeat(left) + s + fill.repeat(right);
}

function lamports(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(4)} SOL`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(2)}k`;
  return `${n}`;
}

function uptime(startedAt?: number): string {
  if (!startedAt) return "00:00:00";
  const s  = Math.floor((Date.now() - startedAt) / 1000);
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// ── box helpers ───────────────────────────────────────────────────────────────
const PANEL_W = 74; // inner width (excludes ║ borders)
const INNER_W = PANEL_W - 2; // usable content width

function boxTop(title = "", w = PANEL_W, col = TEAL): string {
  const cap = w - 4;
  const t   = title ? ` ${title} ` : "";
  const pad = Math.max(0, cap - visLen(t));
  const lhs = Math.floor(pad / 2);
  const rhs = pad - lhs;
  return (
    a(BOX.tl, col) +
    a(BOX.h.repeat(lhs + 1), col) +
    a(t, BOLD, col) +
    a(BOX.h.repeat(rhs + 1), col) +
    a(BOX.tr, col)
  );
}

function boxBot(w = PANEL_W, col = TEAL): string {
  return a(BOX.bl + BOX.h.repeat(w - 2) + BOX.br, col);
}

function boxMid(w = PANEL_W, col = TEAL): string {
  return a(BOX.ml + BOX.lh.repeat(w - 2) + BOX.mr, col);
}

function boxRow(content: string, w = PANEL_W, col = TEAL): string {
  return a(BOX.v, col) + " " + rpad(content, w - 3) + a(BOX.v, col);
}

function boxEmpty(w = PANEL_W, col = TEAL): string {
  return boxRow("", w, col);
}

// ── sparkline ─────────────────────────────────────────────────────────────────
const SPARK_CHARS = ["▁","▂","▃","▄","▅","▆","▇","█"];

function sparkline(values: number[], width = 12, col = TEAL): string {
  if (values.length === 0) return a("─".repeat(width), DIM);
  const max = Math.max(...values, 1);
  const slice = values.slice(-width);
  const bars  = slice.map((v) => {
    const idx = Math.min(SPARK_CHARS.length - 1, Math.floor((v / max) * SPARK_CHARS.length));
    return SPARK_CHARS[idx]!;
  });
  while (bars.length < width) bars.unshift(a("▁", DIM));
  return a(bars.join(""), col);
}

// ── tip bar chart ─────────────────────────────────────────────────────────────
function tipBar(pct: number, active: boolean, w = 8): string {
  const filled = Math.round(pct * w);
  const bar    = "█".repeat(filled) + "░".repeat(w - filled);
  return active ? a(bar, GOLD) : a(bar, SLATE);
}

// ── leader progress ───────────────────────────────────────────────────────────
function leaderProgress(slots: number, maxSlots = 20, w = 20): string {
  const filled = Math.max(0, w - Math.min(Math.round((slots / maxSlots) * w), w));
  const empty  = w - filled;
  const col    = slots <= 3 ? LIME : slots <= 10 ? FG_YELLOW : SLATE;
  return a("█".repeat(filled), col) + a("░".repeat(empty), SLATE);
}

// ── stage badge ───────────────────────────────────────────────────────────────
function stageBadge(stage: string): string {
  switch (stage) {
    case "finalized":  return a("  FINAL  ", FG_BLACK, bg(34));
    case "confirmed":  return a(" CONFIRM ", FG_BLACK, bg(38));
    case "processed":  return a(" PROCESS ", FG_BLACK, bg(220));
    case "submitted":  return a(" SUBMIT  ", FG_BLACK, bg(27));
    default:           return a("  ??????  ", DIM);
  }
}

// ── action badge ──────────────────────────────────────────────────────────────
function actionBadge(action: string): string {
  switch (action) {
    case "retry": return a("  RETRY  ", FG_BLACK, bg(40));
    case "hold":  return a("  HOLD   ", FG_BLACK, bg(214));
    case "abort": return a("  ABORT  ", FG_BLACK, bg(196));
    default:      return a(`  ${action.toUpperCase()}  `, DIM);
  }
}

// ── confidence meter ─────────────────────────────────────────────────────────
function confidenceMeter(conf: number, w = 10): string {
  const filled = Math.round(conf * w);
  const col = conf >= 0.8 ? LIME : conf >= 0.5 ? FG_YELLOW : ROSE;
  return a("▓".repeat(filled), col) + a("░".repeat(w - filled), SLATE) + a(` ${(conf * 100).toFixed(0)}%`, BOLD, col);
}

// ── multiplier gauge ──────────────────────────────────────────────────────────
function multGauge(mult: number): string {
  // range 1.0 → 3.0, display as 10-char bar
  const pct    = Math.min(1, (mult - 1) / 2);
  const filled = Math.round(pct * 12);
  const col    = mult < 1.4 ? LIME : mult < 2.0 ? FG_YELLOW : mult < 2.6 ? ORANGE : ROSE;
  return (
    a("[", SLATE) +
    a("█".repeat(filled), col) +
    a("░".repeat(12 - filled), SLATE) +
    a("]", SLATE) +
    " " +
    a(`×${mult.toFixed(2)}`, BOLD, col)
  );
}

// ── health indicator ──────────────────────────────────────────────────────────
function healthBadge(mult: number): string {
  if (mult < 1.4) return a(" ● HEALTHY  ", FG_BLACK, bg(34));
  if (mult < 2.0) return a(" ◐ MODERATE ", FG_BLACK, bg(136));
  if (mult < 2.6) return a(" ▲ HIGH     ", FG_BLACK, bg(166));
  return           a(`${BLINK} ● CONGESTED`, FG_BLACK, bg(196)) + RESET;
}

// ── banner ────────────────────────────────────────────────────────────────────
function renderBanner(startedAt?: number): string[] {
  const lines: string[] = [];
  const now = new Date().toLocaleTimeString();

  lines.push(
    a("╔" + "═".repeat(PANEL_W - 2) + "╗", TEAL)
  );

  const logo = a(" SolGuard", BOLD, TEAL) + a(" — Autonomous Bundle Intelligence", SKY);
  const right = a(`  ⏱ ${uptime(startedAt)}   🕐 ${now}  `, SLATE);
  const inner = rpad(logo, PANEL_W - 2 - visLen(right) - 1) + right;
  lines.push(a("║", TEAL) + inner + a("║", TEAL));

  // sub-tagline
  const tag = a(" Yellowstone gRPC › Jito Bundle Engine › AI Agent › Decision Ledger ", SLATE);
  lines.push(a("║", TEAL) + rpad(tag, PANEL_W - 2) + a("║", TEAL));

  lines.push(a("╚" + "═".repeat(PANEL_W - 2) + "╝", TEAL));
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
export class Dashboard {
  private timer?: NodeJS.Timeout;
  private slotHistory:       number[] = [];
  private congHistory:       number[] = [];
  private lastSlot           = 0n;
  private lastSlotAt         = 0;
  private slotsPerSec        = 0;
  private frame              = 0;
  private spinnerFrames      = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

  constructor(
    private readonly getState: () => DashboardState,
    private readonly intervalMs = 1000,
  ) {}

  start(): void {
    if (this.timer) return;
    enableFileLogging();
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    this.timer = setInterval(() => this.render(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    process.stdout.write("\x1b[?25h\x1b[?1049l");
    disableFileLogging();
  }

  render(): void {
    const s   = this.getState();
    const now = Date.now();
    const out: string[] = [];

    this.frame = (this.frame + 1) % this.spinnerFrames.length;
    const spin = this.spinnerFrames[this.frame]!;

    // slot throughput tracking
    const curSlot = BigInt(s.stream.lastProcessedSlot);
    if (curSlot > this.lastSlot && this.lastSlot > 0n) {
      const dtSec = (now - this.lastSlotAt) / 1000;
      this.slotsPerSec = Number(curSlot - this.lastSlot) / Math.max(dtSec, 0.001);
      this.slotHistory.push(Math.round(this.slotsPerSec * 10) / 10);
      if (this.slotHistory.length > 16) this.slotHistory.shift();
    }
    if (curSlot !== this.lastSlot) { this.lastSlot = curSlot; this.lastSlotAt = now; }

    // congestion history
    if (s.congestion) {
      this.congHistory.push(s.congestion.congestionMultiplier);
      if (this.congHistory.length > 16) this.congHistory.shift();
    }

    // ── banner ───────────────────────────────────────────────────────────────
    out.push(...renderBanner(s.startedAt));
    out.push("");

    // ── stream + leader (two-column row) ─────────────────────────────────────
    {
      const LCOL = 36; // left column inner
      const RCOL = PANEL_W - LCOL - 5; // right column inner (5 = borders + gap)

      // left: stream
      const st  = s.stream;
      const connDot = st.connected
        ? a("●", LIME) + a(" connected", FG_GREEN)
        : a("●", ROSE) + a(" disconnected", FG_RED);

      const lLines: string[] = [];
      lLines.push(rpad(`${a("STREAM", BOLD, SKY)}  ${connDot}`, LCOL));
      lLines.push(rpad(
        a("slot ", SLATE) + a(st.lastProcessedSlot, BOLD, FG_WHITE) +
        a(`  ${this.slotsPerSec.toFixed(1)} sl/s`, SLATE), LCOL
      ));
      lLines.push(rpad(
        `${a("throughput  ", SLATE)}${sparkline(this.slotHistory, 14, SKY)}`, LCOL
      ));
      lLines.push(rpad(
        a("reconnects ", SLATE) + a(String(st.reconnects), st.reconnects > 0 ? ORANGE : SLATE) +
        a("  queue ", SLATE) + a(String(st.queueSize), SLATE) +
        (st.droppedEvents > 0 ? a(`  ⚠ dropped=${st.droppedEvents}`, FG_YELLOW) : ""), LCOL
      ));

      // right: leader
      const rLines: string[] = [];
      if (s.leader) {
        const l   = s.leader;
        const win = l.inSubmitWindow;
        rLines.push(rpad(`${a("JITO LEADER", BOLD, PURPLE)}  ${win ? a("▶ IN WINDOW", LIME) : a("▷ waiting", SLATE)}`, RCOL));
        rLines.push(rpad(
          `${leaderProgress(l.slotsUntilJitoLeader)} ${a("in " + l.slotsUntilJitoLeader + " slots", SLATE)}`, RCOL
        ));
        rLines.push(rpad(
          a("next slot  ", SLATE) + a(String(l.nextJitoLeaderSlot), BOLD, FG_WHITE), RCOL
        ));
        rLines.push(rpad(
          a("region     ", SLATE) + a(l.region ?? "unknown", FG_CYAN), RCOL
        ));
      } else {
        rLines.push(rpad(a("JITO LEADER", BOLD, PURPLE), RCOL));
        rLines.push(rpad(a("fetching leader schedule…", SLATE), RCOL));
        rLines.push(rpad("", RCOL));
        rLines.push(rpad("", RCOL));
      }

      const maxR = Math.max(lLines.length, rLines.length);
      while (lLines.length < maxR) lLines.push(" ".repeat(LCOL));
      while (rLines.length < maxR) rLines.push(" ".repeat(RCOL));

      // top border (two boxes joined)
      out.push(
        a(BOX.tl + BOX.h.repeat(LCOL + 2), SKY) +
        a(BOX.mt, SKY) +
        a(BOX.h.repeat(RCOL + 2) + BOX.tr, PURPLE)
      );
      for (let i = 0; i < maxR; i++) {
        out.push(
          a(BOX.v, SKY) + " " + rpad(lLines[i] ?? "", LCOL + 1) +
          a(BOX.lv, SLATE) + " " + rpad(rLines[i] ?? "", RCOL + 1) +
          a(BOX.v, PURPLE)
        );
      }
      out.push(
        a(BOX.bl + BOX.h.repeat(LCOL + 2), SKY) +
        a(BOX.mb, SKY) +
        a(BOX.h.repeat(RCOL + 2) + BOX.br, PURPLE)
      );
    }

    out.push("");

    // ── congestion panel ─────────────────────────────────────────────────────
    out.push(boxTop(" CONGESTION ORACLE ", PANEL_W, ORANGE));
    if (s.congestion) {
      const cong = s.congestion;
      const hb   = healthBadge(cong.congestionMultiplier);
      const mg   = multGauge(cong.congestionMultiplier);

      const skipCol = cong.skipRate < 0.05 ? LIME : cong.skipRate < 0.12 ? FG_YELLOW : ROSE;
      const p50Col  = cong.p2cMsP50 < 400 ? LIME : cong.p2cMsP50 < 800 ? FG_YELLOW : ROSE;
      const p95Col  = cong.p2cMsP95 < 800 ? LIME : cong.p2cMsP95 < 1500 ? FG_YELLOW : ROSE;

      out.push(boxRow(
        `${hb}  ${mg}  ${a("▸", SLATE)} history ${sparkline(this.congHistory, 14, ORANGE)}`,
        PANEL_W, ORANGE
      ));
      out.push(boxRow(
        `${a("skip rate  ", SLATE)}${a((cong.skipRate * 100).toFixed(2) + "%", BOLD, skipCol)}` +
        `  ${a("p2c p50  ", SLATE)}${a(cong.p2cMsP50 + " ms", BOLD, p50Col)}` +
        `  ${a("p95  ", SLATE)}${a(cong.p2cMsP95 + " ms", BOLD, p95Col)}` +
        `  ${a("n=" + cong.sampleCount, SLATE)}`,
        PANEL_W, ORANGE
      ));
    } else {
      out.push(boxRow(a(`${spin} warming up…  waiting for confirmed slot events from Yellowstone`, SLATE), PANEL_W, ORANGE));
    }
    out.push(boxBot(PANEL_W, ORANGE));

    out.push("");

    // ── tip floor panel (percentile chart) ───────────────────────────────────
    out.push(boxTop(" JITO TIP FLOOR ", PANEL_W, GOLD));
    if (s.tipFloor) {
      const tf   = s.tipFloor;
      const keys = ["p25", "p50", "p75", "p95", "p99"] as const;
      const vals = keys.map((k) => tf[k]);
      const max  = Math.max(...vals, 1);

      // line 1: bar chart
      const bars = keys.map((k) => {
        const pct    = tf[k] / max;
        const active = k === s.computedTipPercentile;
        const label  = active ? a(k, BOLD, GOLD) : a(k, SLATE);
        const bar    = tipBar(pct, active, 6);
        return `${label} ${bar}`;
      });
      out.push(boxRow("  " + bars.join("   "), PANEL_W, GOLD));

      // line 2: numeric values
      const nums = keys.map((k) => {
        const active = k === s.computedTipPercentile;
        const val    = a(lamports(tf[k]).padStart(9), active ? BOLD : DIM, active ? FG_WHITE : SLATE);
        return val;
      });
      out.push(boxRow("  " + nums.join("   "), PANEL_W, GOLD));

      // line 3: active tip + EMA
      const age = Math.round((Date.now() - tf.fetchedAt) / 1000);
      if (s.computedTipLamports !== undefined && s.computedTipPercentile) {
        out.push(boxRow(
          `  ${a("▶ active tip  ", SLATE)}` +
          `${a(s.computedTipPercentile, BOLD, GOLD)} ${a("→", SLATE)} ` +
          `${a(lamports(s.computedTipLamports), BOLD, LIME)}` +
          `    ${a("ema ", SLATE)}${a(lamports(tf.ema), SLATE)}` +
          `    ${a(`fetched ${age}s ago`, SLATE)}`,
          PANEL_W, GOLD
        ));
      } else {
        out.push(boxRow(
          `  ${a("ema ", SLATE)}${a(lamports(tf.ema), FG_WHITE)}    ${a(`fetched ${age}s ago`, SLATE)}`,
          PANEL_W, GOLD
        ));
      }
    } else {
      out.push(boxRow(a(`${spin} fetching Jito tip floor from bundles.jito.wtf…`, SLATE), PANEL_W, GOLD));
      out.push(boxEmpty(PANEL_W, GOLD));
      out.push(boxEmpty(PANEL_W, GOLD));
    }
    out.push(boxBot(PANEL_W, GOLD));

    out.push("");

    // ── active bundles panel ──────────────────────────────────────────────────
    out.push(boxTop(` ACTIVE BUNDLES (${s.bundles.length}) `, PANEL_W, INDIGO));
    if (s.bundles.length === 0) {
      out.push(boxRow(a("  no bundles in flight", SLATE), PANEL_W, INDIGO));
    } else {
      // header row
      out.push(boxRow(
        rpad(a("  bundle id", SLATE), 16) +
        rpad(a("attempt", SLATE), 10) +
        rpad(a("stage", SLATE), 14) +
        a("tip", SLATE),
        PANEL_W, INDIGO
      ));
      out.push(boxMid(PANEL_W, INDIGO));
      const sortedBundles = [...s.bundles].reverse();
      for (const b of sortedBundles.slice(0, 4)) {
        const id  = a(b.bundleId.slice(0, 8) + "…", FG_CYAN);
        const att = a(`#${b.attempt}`, b.attempt > 1 ? ORANGE : SLATE);
        const tip = a(lamports(b.tipLamports), LIME);
        out.push(boxRow(
          "  " + rpad(id, 13) + rpad(att, 9) + rpad(stageBadge(b.stage), 22) + tip,
          PANEL_W, INDIGO
        ));
      }
      if (sortedBundles.length > 4) {
        out.push(boxRow(a(`  … ${sortedBundles.length - 4} more bundles`, SLATE), PANEL_W, INDIGO));
      }
    }
    out.push(boxBot(PANEL_W, INDIGO));

    out.push("");

    // ── AI agent panel ────────────────────────────────────────────────────────
    out.push(boxTop(" AI AGENT DECISION ENGINE ", PANEL_W, PINK));
    if (s.lastDecision) {
      const d    = s.lastDecision;
      const conf = confidenceMeter(d.confidence);
      out.push(boxRow(
        `  ${actionBadge(d.action)}  ` +
        `${a("cause  ", SLATE)}${a(d.rootCause, BOLD, ORANGE)}  ` +
        `${a("confidence  ", SLATE)}${conf}` +
        (d.newTipLamports !== undefined ? `  ${a("→ tip ", SLATE)}${a(lamports(d.newTipLamports), LIME)}` : ""),
        PANEL_W, PINK
      ));
      // diagnosis word-wrap at INNER_W - 4
      const diagWidth = INNER_W - 4;
      const words     = d.diagnosis.split(" ");
      const diagLines: string[] = [];
      let cur = "";
      for (const w of words) {
        if (cur.length + w.length + 1 > diagWidth) { diagLines.push(cur); cur = w; }
        else cur = cur ? cur + " " + w : w;
      }
      if (cur) diagLines.push(cur);
      for (let i = 0; i < Math.min(diagLines.length, 2); i++) {
        const prefix = i === 0 ? a("  ╰─ ", SLATE) : a("     ", SLATE);
        out.push(boxRow(prefix + a(diagLines[i]!, DIM), PANEL_W, PINK));
      }
    } else {
      out.push(boxRow(
        `  ${a(spin, FG_CYAN)}  ${a("no agent decisions yet — waiting for a bundle failure", SLATE)}`,
        PANEL_W, PINK
      ));
    }

    // history ring
    const hist = (s.decisionHistory ?? []).slice(-6);
    if (hist.length > 0) {
      out.push(boxMid(PANEL_W, PINK));
      const chain = hist.map((h) => {
        const badge = actionBadge(h.action);
        const cause = a(h.rootCause.slice(0, 8), SLATE);
        return `${badge}${cause}`;
      }).join(a(" → ", SLATE));
      out.push(boxRow(`  ${a("history  ", SLATE)}${chain}`, PANEL_W, PINK));
    }
    out.push(boxBot(PANEL_W, PINK));

    // ── system logs panel ────────────────────────────────────────────────────
    out.push(boxTop(" SYSTEM LOGS ", PANEL_W, SLATE));
    const logs = logBuffer.slice(-4);
    if (logs.length === 0) {
      out.push(boxRow(a("  no logs recorded yet", SLATE), PANEL_W, SLATE));
      out.push(boxEmpty(PANEL_W, SLATE));
      out.push(boxEmpty(PANEL_W, SLATE));
      out.push(boxEmpty(PANEL_W, SLATE));
    } else {
      for (const log of logs) {
        const timeStr = new Date(log.ts).toLocaleTimeString();
        let lvlStr = "";
        switch (log.level) {
          case "debug": lvlStr = a("DEBUG", DIM); break;
          case "info":  lvlStr = a("INFO ", SKY); break;
          case "warn":  lvlStr = a("WARN ", ORANGE); break;
          case "error": lvlStr = a("ERROR", ROSE); break;
        }
        const scopeStr = a(`[${log.scope}]`, PURPLE);
        const msgStr = log.msg;
        const lineContent = `  ${a(timeStr, SLATE)} ${lvlStr} ${scopeStr} ${msgStr}`;
        out.push(boxRow(lineContent, PANEL_W, SLATE));
      }
      for (let i = logs.length; i < 4; i++) {
        out.push(boxEmpty(PANEL_W, SLATE));
      }
    }
    out.push(boxBot(PANEL_W, SLATE));

    // ── footer ────────────────────────────────────────────────────────────────
    out.push("");
    const shortcuts = a("  ctrl-c exit", SLATE) + a("  ·  ", SLATE) + a("pnpm server  POST /submit  GET /health", SLATE);
    const ver       = a("  SolGuard v0.1.0  ", SLATE);
    out.push(rpad(shortcuts, PANEL_W - visLen(ver)) + ver);

    process.stdout.write("\x1b[2J\x1b[H" + out.join("\n") + "\n");
  }
}
