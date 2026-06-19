import http from "node:http";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";
import { SolGuard } from "./sdk/solguard.js";
import { bridge } from "./events/bridge.js";
import { logger } from "./util/log.js";

const log = logger("server");
const PORT = Number(process.env.PORT || 3000);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

export function startServer(solguard: SolGuard, port = PORT) {
  // ── SSE client registries ──────────────────────────────────────────────────
  const bundleSseClients = new Set<http.ServerResponse>();
  const decisionSseClients = new Set<http.ServerResponse>();

  function ssePush(clients: Set<http.ServerResponse>, eventName: string, data: unknown) {
    if (clients.size === 0) return;
    const frame = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      try {
        res.write(frame);
      } catch {
        clients.delete(res);
      }
    }
  }

  const bundleHandler = (data: any) => ssePush(bundleSseClients, "bundle_event", data);
  const decisionHandler = (data: any) => ssePush(decisionSseClients, "decision_event", data);

  bridge.on("bundle_event", bundleHandler);
  bridge.on("decision_event", decisionHandler);

  // ── HTTP server ────────────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);

    const url = new URL(req.url ?? "", `http://localhost`);

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    // ── GET /health ──────────────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/health") {
      const s = solguard.status();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "healthy",
          initialized: s.initialized,
          streamMetrics: s.stream,
          congestion: s.congestion,
        })
      );
      return;
    }

    // ── GET /sse/bundles ─────────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/sse/bundles") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...CORS_HEADERS,
      });
      res.write("retry: 5000\n\n");
      bundleSseClients.add(res);
      log.info("SSE bundle client connected", { total: bundleSseClients.size });
      req.on("close", () => {
        bundleSseClients.delete(res);
        log.info("SSE bundle client disconnected", { total: bundleSseClients.size });
      });
      return;
    }

    // ── GET /sse/decisions ───────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname === "/sse/decisions") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...CORS_HEADERS,
      });
      res.write("retry: 5000\n\n");
      decisionSseClients.add(res);
      log.info("SSE decision client connected", { total: decisionSseClients.size });
      req.on("close", () => {
        decisionSseClients.delete(res);
        log.info("SSE decision client disconnected", { total: decisionSseClients.size });
      });
      return;
    }

    // ── POST /submit ─────────────────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/submit") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        res.setHeader("content-type", "application/json");
        try {
          if (!body) {
            res.writeHead(400).end(JSON.stringify({ error: "Missing request body" }));
            return;
          }
          const { transaction, urgency, customTipLamports, simulateFault, remainingTipBudgetLamports } = JSON.parse(body);
          if (!transaction) {
            res.writeHead(400).end(
              JSON.stringify({ error: "Missing required 'transaction' field (base64 or base58)" })
            );
            return;
          }
          log.info("Received /submit request");
          const result = await solguard.submit(transaction, { urgency, customTipLamports, simulateFault, remainingTipBudgetLamports });
          res.writeHead(200).end(JSON.stringify(result));
        } catch (err) {
          log.error("Error in /submit", { err: String(err) });
          res.writeHead(500).end(JSON.stringify({ error: `Internal server error: ${String(err)}` }));
        }
      });
      return;
    }

    // ── 404 ──────────────────────────────────────────────────────────────────
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Cannot ${req.method} ${url.pathname}` }));
  });

  // ── WebSocket server on /ws/stream ────────────────────────────────────────
  const wss = new WebSocketServer({ noServer: true });
  const wsClients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    log.info("WS client connected", { total: wsClients.size });

    const snap = solguard.status();
    if (snap.congestion) {
      try {
        ws.send(
          JSON.stringify({
            type: "network_update",
            skipRate: snap.congestion.skipRate * 100,
            pcDelta: snap.congestion.p2cMsP50,
            jitoLeaderSlot: null,
          })
        );
      } catch { /* ignore */ }
    }

    ws.on("close", () => {
      wsClients.delete(ws);
      log.info("WS client disconnected", { total: wsClients.size });
    });
    ws.on("error", (err) => {
      log.warn("WS client error", { err: String(err) });
      wsClients.delete(ws);
    });
  });

  function wsBroadcast(msg: string) {
    for (const ws of wsClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(msg); } catch { wsClients.delete(ws); }
      }
    }
  }

  const telemetryHandler = (data: any) => {
    wsBroadcast(JSON.stringify({ type: "slot_update", slot: data.slot }));
    wsBroadcast(
      JSON.stringify({
        type: "network_update",
        skipRate: data.skipRate,
        pcDelta: data.pcDelta,
        jitoLeaderSlot: data.jitoLeaderSlot,
      })
    );
    if (data.tipFloor) {
      wsBroadcast(JSON.stringify({ type: "tip_update", tipFloor: data.tipFloor }));
    }
  };

  bridge.on("telemetry", telemetryHandler);

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "", "http://localhost").pathname;
    if (path === "/ws/stream") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  server.listen(port, () => {
    log.info(`API Server listening on http://localhost:${port}`);
    log.info("  GET  /health");
    log.info("  POST /submit");
    log.info("  GET  /sse/bundles");
    log.info("  GET  /sse/decisions");
    log.info("  WS   /ws/stream");
  });

  const shutdown = async () => {
    log.info("Graceful API Server shutdown initiated...");
    wss.close();
    bridge.off("bundle_event", bundleHandler);
    bridge.off("decision_event", decisionHandler);
    bridge.off("telemetry", telemetryHandler);
    for (const res of bundleSseClients) { try { res.end(); } catch { /* ignore */ } }
    for (const res of decisionSseClients) { try { res.end(); } catch { /* ignore */ } }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  };

  return { server, shutdown };
}

async function main() {
  log.info("Starting SolGuard API Server standalone...", { port: PORT });

  const solguard = new SolGuard();

  try {
    await solguard.start();
    log.info("SolGuard SDK started — stream connected.");
  } catch (err) {
    log.error("Failed to start SolGuard core stream", { err: String(err) });
    process.exit(1);
  }

  const { shutdown } = startServer(solguard, PORT);

  const handleShutdown = async () => {
    log.info("Graceful shutdown initiated...");
    await shutdown();
    await solguard.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void handleShutdown());
  process.on("SIGTERM", () => void handleShutdown());
}

const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    const mainPath = realpathSync(process.argv[1]);
    const thisPath = fileURLToPath(import.meta.url);
    return mainPath === thisPath || 
           process.argv[1].endsWith("server.ts") || 
           process.argv[1].endsWith("server.js");
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    log.error("Server crashed", { err: String(err) });
    process.exit(1);
  });
}
