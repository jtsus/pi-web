#!/bin/sh
# Stop the server started by start-pr-web.sh.
#
# Exact pid from the pidfile only: never a pattern match, which would also match
# the shell running this script.
set -e
cd "$(dirname "$0")/.."

PIDFILE="${PI_WEB_PR_PIDFILE:-$PWD/.pr-web.pid}"

if [ ! -f "$PIDFILE" ]; then
  echo "No pidfile at $PIDFILE; nothing to stop."
  exit 0
fi

PID="$(cat "$PIDFILE")"
if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  echo "Process $PID is not running; removing stale pidfile."
  rm -f "$PIDFILE"
  exit 0
fi

if [ "$PID" = "$$" ] || [ "$PID" = "$PPID" ]; then
  echo "Refusing to kill the calling shell (pid $PID)." >&2
  exit 1
fi

CMD="$(ps -p "$PID" -o args= 2>/dev/null || true)"
case "$CMD" in
  *"next start"*) ;;
  *) echo "Pid $PID does not look like the Pi Web server ($CMD); refusing." >&2; exit 1 ;;
esac

kill "$PID"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
kill -0 "$PID" 2>/dev/null && kill -TERM "$PID" || true
rm -f "$PIDFILE"
echo "Stopped Pi Web (PR fork), pid $PID."
