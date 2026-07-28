#!/bin/sh
# Initialize an isolated local git fixture (when MAIN_REPO is empty) then start the runner.
# Used by the Docker "smoke" target so the host needs no Node/git setup.
#
# IMPORTANT: MAIN_REPO_PATH / BARE_PATH / WORKSPACES_PATH may be Docker volume *mount
# points*. Never `rm -rf` the directories themselves (→ "Device or resource busy").
# Only clear their *contents*.
set -eu

MAIN_REPO_PATH="${MAIN_REPO_PATH:-/app/main_repo}"
WORKSPACES_PATH="${WORKSPACES_PATH:-/app/workspaces}"
BARE_PATH="${BARE_PATH:-/app/remote.git}"

# Clear directory contents without removing the mount point.
clear_dir() {
  dir="$1"
  mkdir -p "$dir"
  # shellcheck disable=SC2039
  find "$dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
}

repo_ready() {
  # Regular clone has .git/; bare repo has HEAD at root.
  [ -d "$MAIN_REPO_PATH/.git" ] || [ -f "$MAIN_REPO_PATH/HEAD" ]
}

# Volume mounts are often root-owned; fix ownership when we start as root.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$MAIN_REPO_PATH" "$WORKSPACES_PATH" "$BARE_PATH"
  chown -R helm:helm "$MAIN_REPO_PATH" "$WORKSPACES_PATH" "$BARE_PATH" || true
fi

if ! repo_ready; then
  echo "[smoke-init] seeding local git fixture at $MAIN_REPO_PATH"
  clear_dir "$BARE_PATH"
  clear_dir "$MAIN_REPO_PATH"

  git init --bare "$BARE_PATH"
  # Clone into existing empty directory (volume mount).
  git clone "$BARE_PATH" "$MAIN_REPO_PATH"

  cd "$MAIN_REPO_PATH"
  git checkout -b main
  printf '# smoke fixture\n' > README.md
  printf 'hello\n' > hello.txt
  git add -A
  git -c user.email=agent@helmcode.app -c user.name="HelmCode Agent" \
    commit -m "initial"
  git push -u origin main
  git fetch origin
  cd /app

  if [ "$(id -u)" = "0" ]; then
    chown -R helm:helm "$MAIN_REPO_PATH" "$WORKSPACES_PATH" "$BARE_PATH" || true
  fi
  echo "[smoke-init] fixture ready (branch main → origin)"
else
  echo "[smoke-init] using existing repo at $MAIN_REPO_PATH"
fi

export GITHUB_TOKEN="${GITHUB_TOKEN:-smoke-local-token}"
export HELM_MODE="${HELM_MODE:-open-core}"
export MAIN_REPO_PATH
export WORKSPACES_PATH

echo "[smoke-init] starting runner-core (HELM_MODE=$HELM_MODE)"

# Drop to non-root for the long-running process when possible.
if [ "$(id -u)" = "0" ] && command -v runuser >/dev/null 2>&1; then
  exec runuser -u helm -- node /app/dist/entrypoint.js
fi
if [ "$(id -u)" = "0" ] && command -v su >/dev/null 2>&1; then
  exec su -s /bin/sh helm -c "exec node /app/dist/entrypoint.js"
fi
exec node /app/dist/entrypoint.js
