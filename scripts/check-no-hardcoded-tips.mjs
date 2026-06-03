#!/usr/bin/env node
/**
 * Guard against the #1 disqualifier: hardcoded tip values in the submission
 * path (FR-9, PRD §12). Scans src/tips and src/bundle for suspicious literal
 * lamport constants. The tip must always be derived from live `tip_floor`.
 *
 * Run in CI: `pnpm lint:tips`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOTS = ["src/tips", "src/bundle"];
// flag integer literals >= this that look like lamport amounts, outside of
// clearly-allowed contexts (ceiling read from config, percentile keys, etc.)
const SUSPICIOUS = /\b(\d{4,})\b/g;
const ALLOW_COMMENT = /no-hardcoded-tip-ok/;

let violations = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // dir may not exist yet in early phases
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if ([".ts", ".js", ".mjs"].includes(extname(p))) scan(p);
  }
}

function scan(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (ALLOW_COMMENT.test(line)) return;
    // ignore pure comments
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
    const matches = code.match(SUSPICIOUS);
    if (!matches) return;
    // ignore lines that only reference config/percentile/year-like values
    if (/config\.|percentile|TTL|ms\b|p25|p50|p75|p95|p99|1000\b/.test(code)) return;
    for (const m of matches) {
      console.error(`✗ ${file}:${i + 1} suspicious numeric literal "${m}" in tip path`);
      console.error(`    ${line.trim()}`);
      violations++;
    }
  });
}

for (const r of ROOTS) walk(r);

if (violations > 0) {
  console.error(`\n${violations} potential hardcoded tip value(s). Derive tips from tip_floor, or annotate the line with // no-hardcoded-tip-ok if it is genuinely safe.`);
  process.exit(1);
}
console.log("✓ no hardcoded tip values detected in submission path");
