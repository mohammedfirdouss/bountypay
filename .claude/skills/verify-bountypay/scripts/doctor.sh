#!/usr/bin/env bash
# Usage: doctor.sh RUN_DIR
# Read-only: is this instance ours, up, and worth driving? Exit 0 only if every check passes.
set -uo pipefail

RUN_DIR="${1:?usage: doctor.sh RUN_DIR}"
PORT="$(cat "$RUN_DIR/port")"
PID="$(cat "$RUN_DIR/pid")"
REPO="$(cd "$(dirname "$0")/../../../.." && pwd)"
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }

check "server process $PID is alive" "kill -0 $PID"
check "port $PORT is owned by a process in our group" "lsof -nP -iTCP:$PORT -sTCP:LISTEN -t | xargs -I{} ps -o pgid= -p {} | grep -qw \"\$(ps -o pgid= -p $PID | tr -d ' ')\""
check "dashboard renders at http://localhost:$PORT/" "curl -fsS http://localhost:$PORT/ | grep -q BountyPay"
check "webhook rejects a bad signature with 401" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-GitHub-Event: pull_request' -H 'X-Hub-Signature-256: sha256=00' -d '{}' http://localhost:$PORT/api/github)\" = 401 ]"
check "demo mode is on (server log shows no GitHub token use)" "! grep -q 'GitHub /repos' $RUN_DIR/server.log"

for key in ANTHROPIC_API_KEY PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET; do
  if [ -n "${!key:-}" ] || grep -Eq "^$key=.+" "$REPO/.env.local" 2>/dev/null; then
    echo "info $key present (real external calls will run)"
  else
    echo "info $key absent (external calls fail closed: judge -> held/judge_failed, approve -> PayPal OAuth 401)"
  fi
done
exit $fail
