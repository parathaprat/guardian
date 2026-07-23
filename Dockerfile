# guard[ai]n, one image that can run as either the API or the worker; the
# compose command picks the entrypoint. Runs via `tsx` rather than `tsc`
# because `moduleResolution: bundler` with extensionless imports has no
# runnable Node ESM output without a bundler in front of it.

# ── build: install everything, compile the console ─────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

# Vite's root is src/web, so index.html comes along with the source tree.
COPY tsconfig.json vite.config.ts ./
COPY src ./src

# Typecheck here rather than at deploy time. A broken build should fail the
# image, not the rollout.
RUN npx tsc --noEmit
RUN npm run build

# ── runtime: production deps only ──────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# dumb-init reaps zombies and forwards SIGTERM, which is what makes the
# engine's shutdown flush actually run when a container is stopped.
RUN apk add --no-cache dumb-init

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY --from=build /app/dist ./dist

# Never run as root.
RUN addgroup -g 1001 -S app && adduser -u 1001 -S app -G app \
 && mkdir -p /app/data && chown -R app:app /app
USER app

EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "src/server/index.ts"]
