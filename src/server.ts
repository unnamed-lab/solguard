import http from "node:http";
import { SolGuard } from "./sdk/solguard.js";
import { logger } from "./util/log.js";

const log = logger("server");
const PORT = Number(process.env.PORT || 3000);

async function main() {
  log.info("Starting SolGuard API Server...", { port: PORT });

  const solguard = new SolGuard();

  // Lazy-start SolGuard background stream manager
  try {
    await solguard.start();
    log.info("SolGuard SDK successfully started in API server mode.");
  } catch (err) {
    log.error("Failed to start SolGuard core stream", { err: String(err) });
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    // Set content type for all endpoints
    res.setHeader("content-type", "application/json");

    const url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);

    // CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // GET /health
    if (req.method === "GET" && url.pathname === "/health") {
      const status = solguard.status();
      res.writeHead(200);
      res.end(
        JSON.stringify({
          status: "healthy",
          initialized: status.initialized,
          streamMetrics: status.stream,
          congestion: status.congestion,
        })
      );
      return;
    }

    // POST /submit
    if (req.method === "POST" && url.pathname === "/submit") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });

      req.on("end", async () => {
        try {
          if (!body) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Missing request body" }));
            return;
          }

          const parsed = JSON.parse(body);
          const { transaction, urgency, customTipLamports } = parsed;

          if (!transaction) {
            res.writeHead(400);
            res.end(
              JSON.stringify({
                error: "Missing required 'transaction' field (base64 or base58 encoded)",
              })
            );
            return;
          }

          log.info("Received transaction submit request via HTTP API");

          const result = await solguard.submit(transaction, {
            urgency,
            customTipLamports,
          });

          if (result.landed) {
            res.writeHead(200);
            res.end(JSON.stringify(result));
          } else {
            res.writeHead(422); // Unprocessable Entity for failed land/retry logic
            res.end(JSON.stringify(result));
          }
        } catch (err) {
          log.error("Error processing submit request", { err: String(err) });
          res.writeHead(500);
          res.end(JSON.stringify({ error: `Internal server error: ${String(err)}` }));
        }
      });
      return;
    }

    // 404 Not Found
    res.writeHead(404);
    res.end(JSON.stringify({ error: `Cannot ${req.method} ${url.pathname}` }));
  });

  server.listen(PORT, () => {
    log.info(`API Server listening on port ${PORT}`);
  });

  const shutdown = async () => {
    log.info("SIGINT/SIGTERM received, shutting down server gracefully...");
    server.close(async () => {
      try {
        await solguard.stop();
        log.info("SolGuard stopped successfully.");
        process.exit(0);
      } catch (err) {
        log.error("Error stopping SolGuard core", { err: String(err) });
        process.exit(1);
      }
    });
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  log.error("Server execution crashed", { err: String(err) });
  process.exit(1);
});
