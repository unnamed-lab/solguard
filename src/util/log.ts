/** Minimal structured logger. Timestamped, level-tagged, JSON-friendly. */

type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? order.info;

function emit(level: Level, scope: string, msg: string, fields?: Record<string, unknown>) {
  if (order[level] < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
    ...(fields ?? {}),
  };
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(JSON.stringify(line) + "\n");
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
