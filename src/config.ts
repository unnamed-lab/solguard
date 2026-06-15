import "dotenv/config";

/**
 * Central, typed configuration. Every value comes from the environment
 * (NFR-6). No secrets and — critically — no tip *values* are hardcoded here;
 * TIP_CEILING_LAMPORTS is a safety rail, not a tip (FR-9).
 */

function req(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${v}"`);
  return n;
}

function list(name: string): string[] {
  const v = process.env[name];
  if (!v) return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export type Cluster = "mainnet-beta" | "devnet";

export const config = {
  cluster: opt("SOLANA_CLUSTER", "mainnet-beta") as Cluster,

  rpc: {
    http: req("RPC_HTTP_URL"),
    ws: opt("RPC_WS_URL", ""),
  },

  solinfra: {
    apiKey: opt("SOLINFRA_API_KEY", ""),
  },

  yellowstone: {
    url: req("YELLOWSTONE_GRPC_URL"),
    xToken: opt("YELLOWSTONE_X_TOKEN", ""),
  },

  jito: {
    blockEngineUrl: req("JITO_BLOCK_ENGINE_URL"),
    fallbacks: list("JITO_BLOCK_ENGINE_FALLBACKS"),
    tipFloorUrl: opt("JITO_TIP_FLOOR_URL", "https://bundles.jito.wtf/api/v1/bundles/tip_floor"),
  },

  wallet: {
    secretKey: opt("WALLET_SECRET_KEY", ""), // optional until Phase 2
  },

  anthropic: {
    apiKey: opt("ANTHROPIC_API_KEY", ""), // required for the AI decision agent
    model: opt("ANTHROPIC_MODEL", "claude-opus-4-8"),
  },

  tips: {
    // Safety ceiling only. The actual tip is always derived from tip_floor.
    ceilingLamports: num("TIP_CEILING_LAMPORTS", 100_000),
  },

  stream: {
    queueMax: num("STREAM_QUEUE_MAX", 10_000),
    replayWindowSlots: num("STREAM_REPLAY_WINDOW_SLOTS", 150),
    pingIntervalMs: num("STREAM_PING_INTERVAL_MS", 15_000),
  },

  congestion: {
    ringSize: num("CONGESTION_RING_SIZE", 64),
  },
} as const;

export type Config = typeof config;
