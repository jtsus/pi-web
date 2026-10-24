#!/bin/sh
# Start the pull-request-enabled Pi Web build on its own port.
#
# The published @agegr/pi-web is prebuilt and cannot be patched, so this fork
# runs beside it and shares ~/.pi/agent (sessions, settings, models).
set -e
cd "$(dirname "$0")/.."

PORT="${PI_WEB_PR_PORT:-30143}"
HOST="${PI_WEB_PR_HOST:-0.0.0.0}"
LOG="${PI_WEB_PR_LOG:-$PWD/.pr-web.log}"
PIDFILE="${PI_WEB_PR_PIDFILE:-$PWD/.pr-web.pid}"

if [ ! -f .next/BUILD_ID ]; then
  echo "No build found. Run: npm install && npm run build" >&2
  exit 1
fi

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Pi Web (PR fork) is already running: pid $(cat "$PIDFILE"), http://$HOST:$PORT"
  exit 0
fi

# setsid + nohup: the server must outlive the shell that started it.
: > "$LOG"
setsid nohup node_modules/.bin/next start -H "$HOST" -p "$PORT" >>"$LOG" 2>&1 &
echo $! > "$PIDFILE"
echo "Started Pi Web (PR fork): pid $(cat "$PIDFILE"), http://$HOST:$PORT, log $LOG"
