/**
 * Terminal UI helpers for test harnesses — spinner + AI reasoning box.
 * Used by test-agent-mainnet.ts and test-trading-scenarios.ts.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE  = "\r\x1b[2K";

// ─── ANSI palette ──────────────────────────────────────────────────────────────
export const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m",
  red: "\x1b[31m", purple: "\x1b[35m", white: "\x1b[97m",
} as const;
export type Col = keyof typeof C;
export const c = (col: Col, t: string) => `${C[col]}${t}${C.reset}`;

// ─── Spinner ────────────────────────────────────────────────────────────────────
export class Spinner {
  private fi = 0;
  private iv: ReturnType<typeof setInterval> | null = null;
  private label = "";

  start(label: string) {
    this.label = label;
    process.stdout.write(HIDE_CURSOR);
    this.iv = setInterval(() => {
      const frame = FRAMES[this.fi++ % FRAMES.length];
      process.stdout.write(`${CLEAR_LINE}  ${C.cyan}${frame}${C.reset}  ${this.label}`);
    }, 80);
  }

  update(label: string) {
    this.label = label;
  }

  succeed(msg: string) {
    this._stop(`  ${C.green}✔${C.reset}  ${msg}\n`);
  }

  fail(msg: string) {
    this._stop(`  ${C.red}✘${C.reset}  ${msg}\n`);
  }

  clear() {
    this._stop("");
  }

  private _stop(final: string) {
    if (this.iv) { clearInterval(this.iv); this.iv = null; }
    process.stdout.write(CLEAR_LINE);
    process.stdout.write(SHOW_CURSOR);
    if (final) process.stdout.write(final);
  }
}

// ─── AI Reasoning box ──────────────────────────────────────────────────────────
const BOX_WIDTH = 66;

function boxTop(title: string, col: Col = "cyan") {
  const dash = "─".repeat(BOX_WIDTH - title.length - 3);
  return `  ${C[col]}┌─ ${title} ${dash}┐${C.reset}`;
}
function boxBot(col: Col = "cyan") {
  return `  ${C[col]}└${"─".repeat(BOX_WIDTH)}┘${C.reset}`;
}
function boxLine(text: string, col: Col = "cyan") {
  const padded = text.slice(0, BOX_WIDTH - 2).padEnd(BOX_WIDTH - 2);
  return `  ${C[col]}│${C.reset} ${padded} ${C[col]}│${C.reset}`;
}

/** Wrap text into ≤(BOX_WIDTH-4) char lines. */
function wrapText(text: string, maxW = BOX_WIDTH - 4): string[] {
  const lines: string[] = [];
  const words = text.split(" ");
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > maxW) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Slowly "type out" the AI reasoning box — gives the sense of the agent thinking. */
export async function showReasoningBox(
  failureType: string,
  diagnosis: string,
  action: string,
  confidence: number,
  params: { new_tip_lamports?: number; submit_at_slot?: number; tip_percentile_target?: number; refresh_blockhash?: boolean },
  slot: number,
): Promise<void> {
  const acCol: Col = action === "retry" ? "green" : action === "abort" ? "red" : "yellow";

  const contextLines = [
    `  Failure  : ${c("red", failureType)}`,
    `  Slot     : ${slot.toLocaleString()}`,
    `  Decision : ${c(acCol, action.toUpperCase())}  (confidence ${Math.round(confidence * 100)} %)`,
  ];
  const paramParts: string[] = [];
  if (params.new_tip_lamports)     paramParts.push(`tip → ${params.new_tip_lamports.toLocaleString()} lmp`);
  if (params.submit_at_slot)       paramParts.push(`submit @ slot ${params.submit_at_slot.toLocaleString()}`);
  if (params.tip_percentile_target) paramParts.push(`p${params.tip_percentile_target}`);
  if (params.refresh_blockhash)    paramParts.push(`refresh BH`);
  if (paramParts.length) contextLines.push(`  Params   : ${paramParts.join("  ·  ")}`);

  // print context lines first (instant)
  console.log();
  for (const l of contextLines) console.log(l);

  // print the box with word-by-word typewriter for the diagnosis
  console.log();
  console.log(boxTop("AI REASONING", "cyan"));
  console.log(boxLine("", "cyan"));

  const wrapped = wrapText(diagnosis);
  for (const textLine of wrapped) {
    // type each character
    process.stdout.write(`  ${C.cyan}│${C.reset} `);
    for (const ch of textLine) {
      process.stdout.write(ch);
      await delay(8); // ~8ms per char → ~125 chars/s, visually readable
    }
    const pad = " ".repeat(Math.max(0, BOX_WIDTH - 4 - textLine.length));
    process.stdout.write(pad + ` ${C.cyan}│${C.reset}\n`);
  }

  console.log(boxLine("", "cyan"));
  console.log(boxBot("cyan"));
  console.log();
}

/** Scenario header banner. */
export function scenarioBanner(
  id: string,
  title: string,
  col: Col = "cyan",
) {
  const bar = "═".repeat(54);
  console.log(`\n  ${C[col]}╔${bar}╗${C.reset}`);
  console.log(`  ${C[col]}║  ${id.padEnd(4)} ${title.padEnd(48)} ║${C.reset}`);
  console.log(`  ${C[col]}╚${bar}╝${C.reset}`);
}

/** Small inline delay. */
export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Print a scenario step result row for the summary table. */
export function summaryRow(id: string, scenario: string, action: string, conf: string) {
  const ac: Col =
    action === "retry" || action === "landed" ? "green"
    : action === "abort" ? "red"
    : action === "hold"  ? "yellow"
    : "dim";
  console.log(`  ${c("dim", id.padEnd(4))}${scenario.padEnd(30)}${c(ac, action.padEnd(9))} ${conf}`);
}
