# Control plane + web SPA in one image (M0 staging). The control plane serves the
# built SPA from WEB_DIST and the API under /api.
FROM node:24-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY services/control/package.json services/control/
RUN pnpm install --frozen-lockfile --filter @gridzero/web --filter @gridzero/control
COPY apps/web apps/web
COPY services/control services/control
RUN pnpm --filter @gridzero/web run build \
 && pnpm --filter @gridzero/control deploy --prod --legacy /out/control

FROM node:24-slim
ENV NODE_ENV=production \
    WEB_DIST=/app/web \
    SEMANTIC_DIR=/app/semantic
# The semantic engine (definitions: scan, checks, questions) is Python with sqlglot.
COPY services/semantic /app/semantic
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip \
 && pip3 install --no-cache-dir --break-system-packages -r /app/semantic/requirements.txt \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/control
COPY --from=build /out/control ./
COPY --from=build /repo/apps/web/dist /app/web
EXPOSE 8787
CMD ["node", "src/server.ts"]
