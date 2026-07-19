# openmw-mp — multiplayer server for OpenMW-Web (see server/README.md).
# Multi-stage: deps -> build (typecheck+test+bundle) -> prod-deps -> tiny runtime.
# The deploy workflow builds --target test first as a hard gate, then the default target.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json esbuild.mjs ./
COPY src ./src
COPY test ./test
COPY config.default.toml ./
RUN npm run build

# Test gate: `docker build --target test` fails the deploy if typecheck or tests fail.
FROM build AS test
RUN npm test

# Production node_modules: only runtime deps (esbuild bundles everything except the
# native @node-rs/argon2 module, which must be present at runtime).
FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config.default.toml ./
USER node
EXPOSE 8080
# busybox wget ships with alpine; /healthz is served on the same port as the WS endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# Heap cap well under the compose mem_limit so the process degrades (GC pressure) rather
# than getting OOM-killed mid-flush.
CMD ["node", "--max-old-space-size=256", "dist/server.mjs", "--data", "/data"]
