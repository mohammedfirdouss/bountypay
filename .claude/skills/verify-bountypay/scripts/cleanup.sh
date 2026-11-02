#!/usr/bin/env bash
# Usage: cleanup.sh RUN_DIR
# Stops only the server this run started (its whole process group) and deletes scratch state.
# Keeps RUN_DIR/evidence and RUN_DIR/server.log.
set -uo pipefail

RUN_DIR="${1:?usage: cleanup.sh RUN_DIR}"
if [ -f "$RUN_DIR/pid" ]; then
  PID="$(cat "$RUN_DIR/pid")"
  PGID="$(ps -o pgid= -p "$PID" 2>/dev/null | tr -d ' ')"
  if [ -n "$PGID" ]; then
    kill -TERM -- "-$PGID" 2>/dev/null
    for _ in $(seq 1 10); do kill -0 "$PID" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$PGID" 2>/dev/null
  fi
  rm -f "$RUN_DIR/pid"
fi
rm -rf "$RUN_DIR/chrome" "$RUN_DIR"/bountypay.db*
PORT="$(cat "$RUN_DIR/port" 2>/dev/null)"
if [ -n "$PORT" ] && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "WARN port $PORT still has a listener" >&2
fi
echo "cleaned; evidence kept in $RUN_DIR/evidence"
ls "$RUN_DIR/evidence"
