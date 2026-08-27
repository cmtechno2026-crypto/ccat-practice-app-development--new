# CCAT Web Admin — static SPA. Build context = repo root.
# The Gateway URL is injected at RUNTIME via /config.js (window.__CCAT_GATEWAY__) so one image
# ships to any environment. No secrets in this bundle.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/admin/package.json apps/admin/package.json
RUN pnpm install --filter @ccat/admin... --no-frozen-lockfile
COPY apps/admin ./apps/admin
RUN pnpm --filter @ccat/admin build

FROM nginx:1.27-alpine AS run
COPY apps/admin/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/admin/dist /usr/share/nginx/html
# Runtime gateway URL: entrypoint writes /config.js from $CCAT_GATEWAY_URL before nginx starts.
COPY apps/admin/deploy/entrypoint.sh /docker-entrypoint.d/40-ccat-config.sh
RUN chmod +x /docker-entrypoint.d/40-ccat-config.sh
EXPOSE 80
