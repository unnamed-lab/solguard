import http from "node:http";
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

async function main() {
  log.info("Starting SolGuard API Server...", { port: PORT });

  const solguard = new SolGuard();

  try {
    await solguard.start();
    log.info("SolGuard SDK started — stream connected.");
  } catch (err) {
    log.error("Failed to start SolGuard core stream", { err: String(err) });
    process.exit(1);
  }

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

  bridge.on("bundle_event", (data) => ssePush(bundleSseClients, "bundle_event", data));
  bridge.on("decision_event", (data) => ssePush(decisionSseClients, "decision_event", data));

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
          const { transaction, urgency, customTipLamports } = JSON.parse(body);
          if (!transaction) {
            res.writeHead(400).end(
              JSON.stringify({ error: "Missing required 'transaction' field (base64 or base58)" })
            );
            return;
          }
          log.info("Received /submit request");
          const result = await solguard.submit(transaction, { urgency, customTipLamports });
          res.writeHead(result.landed ? 200 : 422).end(JSON.stringify(result));
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

    // Send current snapshot immediately so the UI doesn't wait for the first slot
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
      } catch { /* client may disconnect before first send */ }
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

  bridge.on("telemetry", (data) => {
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
  });

  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "", "http://localhost").pathname;
    if (path === "/ws/stream") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, () => {
    log.info(`API Server listening on http://localhost:${PORT}`);
    log.info("  GET  /health");
    log.info("  POST /submit");
    log.info("  GET  /sse/bundles");
    log.info("  GET  /sse/decisions");
    log.info("  WS   /ws/stream");
  });

  const shutdown = async () => {
    log.info("Graceful shutdown initiated...");
    wss.close();
    for (const res of bundleSseClients) { try { res.end(); } catch { /* ignore */ } }
    for (const res of decisionSseClients) { try { res.end(); } catch { /* ignore */ } }
    server.close(async () => {
      try {
        await solguard.stop();
        log.info("SolGuard stopped.");
        process.exit(0);
      } catch (err) {
        log.error("Error stopping SolGuard", { err: String(err) });
        process.exit(1);
      }
    });
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  log.error("Server crashed", { err: String(err) });
  process.exit(1);
});
