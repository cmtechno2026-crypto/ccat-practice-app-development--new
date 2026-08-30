# CCAT Gateway — the sole student-data boundary. Node 22, Fastify, run via tsx.
# Build context = repo root:  docker build -f apps/gateway/Dockerfile -t ccat-gateway .
FROM node:22-slim AS deps
RUN corepack enable
WORKDIR /repo
# Workspace manifests first (better layer caching)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/shared/package.json packages/shared/package.json
# Only the gateway subgraph is needed at runtime.
RUN pnpm install --filter @ccat/gateway... --prod=false --frozen-lockfile

FROM node:22-slim AS run
RUN corepack enable
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/gateway/node_modules ./apps/gateway/node_modules
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY packages/api-client ./packages/api-client
COPY packages/shared ./packages/shared
COPY apps/gateway ./apps/gateway
WORKDIR /repo/apps/gateway
EXPOSE 8080
# Secrets (DATABASE_URL with service-role/DB creds, GATEWAY_HMAC_SECRET, PIN_PEPPER) are injected
# at runtime by the host — never baked into the image. Apply migrations out-of-band (see runbook),
# not on boot, so a rolling deploy never races schema changes.
CMD ["npx","tsx","src/server.ts"]
