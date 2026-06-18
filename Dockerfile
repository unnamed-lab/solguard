# ── Backend ────────────────────────────────────────────────────────────────
# Runs the SolGuard HTTP API server (src/server.ts) via tsx.
# All configuration is injected at runtime via environment variables.
FROM node:20-alpine

WORKDIR /app

# Enable corepack so the pnpm version declared in package.json is used
RUN corepack enable

# Install deps first (layer-cached until package files change)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# Copy the rest of the source (excluding what is in .dockerignore)
COPY . .

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1

CMD ["npx", "tsx", "src/server.ts"]
