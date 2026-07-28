# syntax=docker/dockerfile:1.7
#
# Targets:
#   test     — run unit + integration suite (no host Node required)
#   build    — compile TypeScript
#   runtime  — production open-core / commercial-saas image
#   smoke    — runtime + auto-seeded local git fixture for API smoke

FROM node:22-bookworm-slim AS base
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    HELM_MODE=open-core \
    MAIN_REPO_PATH=/app/main_repo \
    WORKSPACES_PATH=/app/workspaces
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
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
# test — full source + devDependencies; isolated from host node_modules
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS test
ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=test
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      git \
    && rm -rf /var/lib/apt/lists/* \
    && git config --system --add safe.directory '*' \
    && git config --system user.email "test@helmcode.app" \
    && git config --system user.name "HelmCode Test"
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
# Default: typecheck + full suite. Override with `docker run ... npm run test:unit`.
CMD ["sh", "-c", "npm run typecheck && npm test"]

# ---------------------------------------------------------------------------
# deps / build / runtime
# ---------------------------------------------------------------------------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev=false

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
WORKDIR /app
RUN mkdir -p /app/main_repo /app/workspaces /app/remote.git \
    && useradd --system --uid 10001 --home /app --shell /usr/sbin/nologin helm \
    && chown -R helm:helm /app
COPY --from=build --chown=helm:helm /app/package.json /app/package.json
COPY --from=build --chown=helm:helm /app/node_modules /app/node_modules
COPY --from=build --chown=helm:helm /app/dist /app/dist
USER helm
EXPOSE 8080
# open-core serves /health; commercial-saas is outbound-only (process liveness).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const m=process.env.HELM_MODE||'open-core'; if(m!=='open-core') process.exit(0); fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/entrypoint.js"]

# ---------------------------------------------------------------------------
# smoke — API smoke with an in-container git fixture (no host repo mount)
# ---------------------------------------------------------------------------
FROM runtime AS smoke
# Stay root for entrypoint: volume mounts need chown + content wipe (not rmdir).
# Script drops privileges to `helm` before starting Node.
USER root
COPY scripts/docker-smoke-init.sh /app/docker-smoke-init.sh
RUN chmod +x /app/docker-smoke-init.sh
ENV GITHUB_TOKEN=smoke-local-token
ENTRYPOINT ["/app/docker-smoke-init.sh"]