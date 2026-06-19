/** Minimal structured logger. Timestamped, level-tagged, JSON-friendly. */

import * as fs from "node:fs";
import * as path from "node:path";

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? order.info;

export interface LogEntry {
  ts: string;
  level: Level;
  scope: string;
  msg: string;
  fields?: Record<string, unknown>;
}

export const logBuffer: LogEntry[] = [];
const MAX_BUFFER_LOGS = 100;

let logFd: number | undefined;
let fileLoggingEnabled = false;

export function enableFileLogging(): void {
  if (fileLoggingEnabled) return;
  try {
    const logDir = path.join(process.cwd(), "logs");
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    logFd = fs.openSync(path.join(logDir, "solguard.log"), "a");
    fileLoggingEnabled = true;
  } catch {
    // Fallback to console
  }
}

export function disableFileLogging(): void {
  fileLoggingEnabled = false;
  if (logFd !== undefined) {
    try {
      fs.closeSync(logFd);
    } catch {}
    logFd = undefined;
  }
}

let consoleLoggingDisabled = false;
export function disableConsoleLogging(): void {
  consoleLoggingDisabled = true;
}

function emit(level: Level, scope: string, msg: string, fields?: Record<string, unknown>) {
  if (order[level] < threshold) return;
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(fields ?? {}),
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_LOGS) {
    logBuffer.shift();
  }

  const str = JSON.stringify(entry) + "\n";

  if (fileLoggingEnabled && logFd !== undefined) {
    try {
      fs.writeSync(logFd, str);
      return;
    } catch {
      // Fallback
    }
  }

  if (consoleLoggingDisabled) return;

  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(str);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", scope, msg, fields),
    info: (msg: string, fields?: Record<string, unknown>) => emit("info", scope, msg, fields),
    warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", scope, msg, fields),
    error: (msg: string, fields?: Record<string, unknown>) => emit("error", scope, msg, fields),
  };
}

export type Logger = ReturnType<typeof logger>;
