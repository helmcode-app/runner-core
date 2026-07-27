# syntax=docker/dockerfile:1.7

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
RUN mkdir -p /app/main_repo /app/workspaces \
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
