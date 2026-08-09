#!/usr/bin/env sh
# Run the full test suite inside Docker (no host Node required).
set -eu
cd "$(dirname "$0")/.."

TARGET="${1:-test}"

case "$TARGET" in
  test|all)
    docker compose run --rm --build test
    ;;
  unit)
    docker compose run --rm --build test-unit
    ;;
  integration)
    docker compose run --rm --build test-integration
    ;;
  smoke)
    echo "Starting smoke API on http://127.0.0.1:18080 ..."
    docker compose up --build -d smoke
    echo "Waiting for health..."
    i=0
    until curl -sf http://127.0.0.1:18080/health >/dev/null 2>&1; do
      i=$((i + 1))
      if [ "$i" -gt 30 ]; then
        echo "smoke did not become healthy in time" >&2
        docker compose logs smoke >&2 || true
        exit 1
      fi
      sleep 1
    done
    echo "OK — try:"
    echo "  curl -s http://127.0.0.1:18080/health | jq"
    echo "  curl -s http://127.0.0.1:18080/v1/status | jq"
    echo "Stop with: docker compose down"
    ;;
  smoke-down)
    docker compose down
    ;;
  *)
    echo "Usage: $0 [test|unit|integration|smoke|smoke-down]" >&2
    exit 2
    ;;
esac
