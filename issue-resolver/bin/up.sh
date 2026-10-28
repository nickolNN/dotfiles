#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

source "$ROOT/bin/service.sh" status >/dev/null 2>&1
mkdir -p "$LOG_DIR" "$PID_DIR"

WAIT_SECS="${IR_UP_WAIT_SECS:-15}"
BACKEND_PORT="${IR_BACKEND_PORT:-8080}"
FRONTEND_PORT="${IR_FRONTEND_PORT:-5173}"

backend_ready() {
  is_port_open "$BACKEND_PORT" &&
    curl -fsS --max-time 2 "http://localhost:$BACKEND_PORT/ping" 2>/dev/null |
    grep -q '"ok":true'
}

frontend_ready() {
  is_port_open "$FRONTEND_PORT" &&
    curl -fsS --max-time 2 -o /dev/null "http://localhost:$FRONTEND_PORT/"
}

pre_backend=0
pre_frontend=0
backend_ready && pre_backend=1
frontend_ready && pre_frontend=1

echo "  → npm install (root)…"
(cd "$ROOT" && npm install --prefer-offline) || true

start_out="$("$ROOT/bin/service.sh" start 2>&1)" || true
printf '%s\n' "$start_out" | grep -v 'agent-fwd' || true

deadline=$((SECONDS + WAIT_SECS))
while :; do
  b=0; f=0
  backend_ready && b=1
  frontend_ready && f=1
  [ "$b" = 1 ] && [ "$f" = 1 ] && break
  [ "$SECONDS" -ge "$deadline" ] && break
  sleep 0.5
done

if ! backend_ready || ! frontend_ready; then
  echo >&2
  echo "✗ issue-resolver не поднялся за ${WAIT_SECS}s:" >&2
  if ! backend_ready; then
    echo "  backend  :$BACKEND_PORT — не готов (порт/пинг)" >&2
    echo "  ── tail $BACKEND_LOG ──" >&2
    tail -n 20 "$BACKEND_LOG" >&2 2>/dev/null || true
  fi
  if ! frontend_ready; then
    echo "  frontend :$FRONTEND_PORT — не готов (порт/страница)" >&2
    echo "  ── tail $FRONTEND_LOG ──" >&2
    tail -n 20 "$FRONTEND_LOG" >&2 2>/dev/null || true
  fi
  exit 1
fi

if [ "$pre_backend" = 1 ] && [ "$pre_frontend" = 1 ]; then
  echo
  echo "✅ backend :$BACKEND_PORT и frontend :$FRONTEND_PORT уже слушают — ничего не менял."
else
  echo
  echo "✅ issue-resolver поднят."
fi

cat <<EOF
   backend  (в контейнере): http://localhost:$BACKEND_PORT
   frontend (в контейнере): http://localhost:$FRONTEND_PORT
   режим: $MODE   логи: $BACKEND_LOG, $FRONTEND_LOG

Публикация UI наружу — выполнить НА ХОСТЕ (где есть docker CLI):
   agent-fwd up $FRONTEND_PORT:$FRONTEND_PORT
   → UI: http://<host-IP>:$FRONTEND_PORT
EOF