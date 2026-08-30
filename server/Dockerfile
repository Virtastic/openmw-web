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
COPY web ./web
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
# tar is used by the dashboard's backup export. busybox tar is present in alpine already,
# but the GNU one handles a data dir changing under it more gracefully.
RUN apk add --no-cache tar
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config.default.toml ./
# The admin dashboard's page and its vendored AdminLTE/Bootstrap assets. Served from disk
# at runtime (see src/net/admin/static.ts), not bundled, so they resolve the same way
# config.default.toml does.
COPY web ./web
COPY docker-entrypoint.sh /usr/local/bin/
# Explicit: a checkout on Windows does not carry the executable bit, so relying on the
# source file's mode would produce an image that fails to start on some machines and not
# others — the worst kind of "works here".
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
USER node
EXPOSE 8080
# busybox wget ships with alpine; /healthz is served on the same port as the WS endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# The entrypoint picks single-world or gateway mode from <data>/.mode, so the dashboard can
# switch a deployment between them with nothing more than a restart.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
