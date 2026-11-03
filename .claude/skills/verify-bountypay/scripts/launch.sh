#!/usr/bin/env bash
# Usage: launch.sh [RUN_ID]
# Starts one BountyPay dev server in demo mode with a fresh SQLite file and prints the run directory.
# BOUNTYPAY_DEMO=offline in the environment launches offline mode with the Claude and PayPal keys blanked.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
RUN_ID="${1:-$(date +%Y%m%d-%H%M%S)}"
RUN_DIR="${BOUNTYPAY_VERIFY_ROOT:-/tmp/bountypay-verify}/$RUN_ID"
PORT="${BOUNTYPAY_VERIFY_PORT:-3100}"
SECRET="${GITHUB_WEBHOOK_SECRET:-bountypay-demo-secret}"
DEMO="${BOUNTYPAY_DEMO:-1}"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use; refusing to drive an instance this run did not start" >&2
  exit 1
fi
if pgrep -f "next dev" >/dev/null 2>&1 && [ -e "$REPO/.next/dev/lock" ]; then
  echo "another 'next dev' holds $REPO/.next/dev; stop it first (one dev server per checkout)" >&2
  exit 1
fi

mkdir -p "$RUN_DIR/evidence"
echo "$PORT" > "$RUN_DIR/port"
echo "$SECRET" > "$RUN_DIR/secret"
echo "$DEMO" > "$RUN_DIR/mode"
if [ "$DEMO" = offline ]; then
  # Next lets a variable already in the environment, even an empty one, win over .env.local.
  export ANTHROPIC_API_KEY="" PAYPAL_CLIENT_ID="" PAYPAL_CLIENT_SECRET=""
fi

cd "$REPO"
set -m  # job control: the server gets its own process group, so cleanup can stop exactly it
BOUNTYPAY_DEMO="$DEMO" \
BOUNTYPAY_DB="$RUN_DIR/bountypay.db" \
GITHUB_WEBHOOK_SECRET="$SECRET" \
DASHBOARD_TOKEN="${DASHBOARD_TOKEN:-}" \
  npx next dev -p "$PORT" >"$RUN_DIR/server.log" 2>&1 < /dev/null &
echo $! > "$RUN_DIR/pid"

for _ in $(seq 1 90); do
  if curl -fsS "http://localhost:$PORT/" 2>/dev/null | grep -q "BountyPay"; then
    echo "$RUN_DIR"
    exit 0
  fi
  sleep 1
done
echo "server did not become ready in 90s; see $RUN_DIR/server.log" >&2
exit 1
