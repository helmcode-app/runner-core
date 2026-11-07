# syntax=docker/dockerfile:1.7
#
# Monorepo layout:
#   services/runner  — Node.js agent orchestrator
#   services/vfs     — Go helm-vfs binary
#
# Targets: test | build | runtime | smoke

FROM node:26-bookworm-slim AS base
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    HELM_MODE=open-core \
    MAIN_REPO_PATH=/app/main_repo \
    WORKSPACES_PATH=/app/workspaces
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      bash \
      openssh-client \
      python3 \
      build-essential \
      golang-go \
      rustc \
      cargo \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*' \
    && git config --system user.email "agent@helmcode.app" \
    && git config --system user.name "HelmCode Agent"

# ---------------------------------------------------------------------------
# test — Node suite (+ optional helm-vfs binary for VFS bridge tests)
# ---------------------------------------------------------------------------
FROM node:26-bookworm-slim AS test
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=test
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
      python3 \
      build-essential \
      golang-go \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*' \
    && git config --system user.email "test@helmcode.app" \
    && git config --system user.name "HelmCode Test"
WORKDIR /src
COPY package.json package-lock.json* ./
COPY services/runner/package.json services/runner/package.json
RUN npm ci
COPY services/runner services/runner
COPY services/vfs services/vfs
WORKDIR /src/services/vfs
RUN go build -o bin/helm-vfs ./cmd/helm-vfs
WORKDIR /src
ENV HELM_VFS_BIN=/src/services/vfs/bin/helm-vfs
CMD ["sh", "-c", "npm run typecheck -w @helmcode/runner && npm test -w @helmcode/runner"]

# ---------------------------------------------------------------------------
# deps / build (runner)
# ---------------------------------------------------------------------------
# base sets NODE_ENV=production (runtime default). For compile we need
# devDependencies (typescript → tsc). Install with development, then prune.
FROM base AS deps
WORKDIR /src
ENV NODE_ENV=development
COPY package.json package-lock.json* ./
COPY services/runner/package.json services/runner/package.json
RUN npm ci

FROM deps AS build
COPY services/runner/tsconfig.json services/runner/tsconfig.json
COPY services/runner/src services/runner/src
# Ensure workspace node_modules path exists for runtime COPY (npm often hoists to /src/node_modules).
RUN npm run build -w @helmcode/runner \
    && npm prune --omit=dev -w @helmcode/runner \
    && mkdir -p /src/services/runner/node_modules

# ---------------------------------------------------------------------------
# go-build (helm-vfs)
# ---------------------------------------------------------------------------
FROM golang:1.26-alpine AS go-build
WORKDIR /src
COPY services/vfs/go.mod services/vfs/go.sum ./
RUN go mod download
COPY services/vfs/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/helm-vfs ./cmd/helm-vfs

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM base AS runtime
WORKDIR /app
ENV HELM_VFS_BIN=/app/bin/helm-vfs \
    VFS_ENABLED=true
# OpenCode is NOT baked into the image. When SESSIONS_ENABLED, the runner
# installs opencode-ai at boot into /app/.opencode (HOME=/app). Prefix must
# be writable by `helm`. Override install knobs in harness settings.ts.
RUN mkdir -p /app/main_repo /app/workspaces /app/remote.git /app/bin /app/.opencode \
    && useradd --system --uid 10001 --home /app --shell /usr/sbin/nologin helm \
    && chown -R helm:helm /app
COPY --from=build --chown=helm:helm /src/services/runner/package.json /app/package.json
COPY --from=build --chown=helm:helm /src/node_modules /app/node_modules
COPY --from=build --chown=helm:helm /src/services/runner/dist /app/dist
# workspace install may nest runner deps — also copy package node_modules if present
COPY --from=build --chown=helm:helm /src/services/runner/node_modules /app/node_modules_runner
RUN if [ -d /app/node_modules_runner ] && [ "$(ls -A /app/node_modules_runner 2>/dev/null)" ]; then \
      cp -a /app/node_modules_runner/. /app/node_modules/ 2>/dev/null || true; \
    fi \
    && rm -rf /app/node_modules_runner
COPY --from=go-build --chown=helm:helm /out/helm-vfs /app/bin/helm-vfs
USER helm
EXPOSE 8080
# Longer start_period: managed OpenCode may npm-install on first boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=5 \
  CMD node -e "const m=process.env.HELM_MODE||'open-core'; if(m!=='open-core') process.exit(0); fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/entrypoint.js"]

# ---------------------------------------------------------------------------
# smoke
# ---------------------------------------------------------------------------
FROM runtime AS smoke
USER root
COPY scripts/docker-smoke-init.sh /app/docker-smoke-init.sh
RUN chmod +x /app/docker-smoke-init.sh
ENTRYPOINT ["/app/docker-smoke-init.sh"]
