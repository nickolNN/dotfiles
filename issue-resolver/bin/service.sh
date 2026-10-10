#!/usr/bin/env bash
#
# Issue Resolver — локальный подъём/остановка веб-сервиса (backend + frontend).
#
#   ./bin/service.sh start      # поднять backend (:8080) + vite (:5173)
#   ./bin/service.sh stop       # погасить оба процесса
#   ./bin/service.sh restart    # stop && start
#   ./bin/service.sh status     # что слушает/работает
#
# Режим запуска задаётся переменной IR_MODE:
#   IR_MODE=local  (по умолчанию) — pi запускается НАПРЯМУЮ, без docker
#                   (ISSUE_RESOLVER_LOCAL=1; для dev-контейнера без docker).
#   IR_MODE=docker — backend в режиме реальных адаптеров
#                   (ISSUE_RESOLVER_USE_REAL=1 + DOCKER_SOCKET), спавнит
#                   dotfiles-agent-контейнеры на задачу.
#
# PID-файлы и логи — в /tmp (переопределяется IR_PID_DIR / IR_LOG_DIR).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${IR_MODE:-local}"
PID_DIR="${IR_PID_DIR:-/tmp}"
LOG_DIR="${IR_LOG_DIR:-/tmp}"
BACKEND_PID="$PID_DIR/ir-backend.pid"
FRONTEND_PID="$PID_DIR/ir-frontend.pid"
BACKEND_LOG="$LOG_DIR/ir-backend.log"
FRONTEND_LOG="$LOG_DIR/ir-frontend.log"
BACKEND_PORT="${IR_BACKEND_PORT:-8080}"
FRONTEND_PORT="${IR_FRONTEND_PORT:-5173}"

# Экспортирует env-переменные для backend в зависимости от режима.
export_run_env() {
  if [ "$MODE" = "local" ]; then
    export ISSUE_RESOLVER_LOCAL=1
    unset ISSUE_RESOLVER_USE_REAL DOCKER_SOCKET 2>/dev/null || true
  else
    export ISSUE_RESOLVER_USE_REAL=1
    export DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"
    unset ISSUE_RESOLVER_LOCAL 2>/dev/null || true
  fi
}

# dev-образ не содержит ss/lsof/fuser — определяем слушающий порт по
# /proc/net/tcp{,6}. Строка: <sl>: <local_ip>:<local_port> <remote> <state> ...
# слушающий сокет = state 0A (LISTEN) и local_port == искомому.
is_port_open() {
  local port="$1"
  local hex; hex="$(printf '%04X' "$port" 2>/dev/null)"
  awk -v h="$hex" '
    { split($2, a, ":"); if ($4 == "0A" && a[2] == h) found = 1 }
    END { exit !found }
  ' /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

start_backend() {
  if is_port_open "$BACKEND_PORT"; then
    echo "backend уже слушает :$BACKEND_PORT — пропускаю."
    return 0
  fi
  cd "$ROOT/backend" || { echo "нет $ROOT/backend" >&2; return 1; }

  # NOTE: эмпирически стабильно работает `nohup npm run start &` (не setsid):
  # better-sqlite3 (Node 24) падает на exit-time assert при setsid.
  export_run_env
  PORT="$BACKEND_PORT" nohup npm run start > "$BACKEND_LOG" 2>&1 &
  echo $! > "$BACKEND_PID"
  echo "backend  → :$BACKEND_PORT (pid $(cat "$BACKEND_PID")) [$MODE]"
}

start_frontend() {
  if is_port_open "$FRONTEND_PORT"; then
    echo "frontend уже слушает :$FRONTEND_PORT — пропускаю."
    return 0
  fi
  cd "$ROOT/frontend" || { echo "нет $ROOT/frontend" >&2; return 1; }
  nohup npx vite --host 0.0.0.0 --port "$FRONTEND_PORT" \
    > "$FRONTEND_LOG" 2>&1 &
  echo $! > "$FRONTEND_PID"
  echo "frontend → :$FRONTEND_PORT (pid $(cat "$FRONTEND_PID"))"
}

kill_by_pid() {
  local pidfile="$1"
  if [ -f "$pidfile" ]; then
    local pid; pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

stop() {
  # бракет-паттерн ('[t]sx') защищает от pkill, матчащего собственный bash -c.
  kill_by_pid "$FRONTEND_PID"
  pkill -f '[v]ite --host 0.0.0.0' 2>/dev/null || true

  kill_by_pid "$BACKEND_PID"
  pkill -f '[t]sx src/server.ts' 2>/dev/null || true

  echo "остановлено (backend :$BACKEND_PORT, frontend :$FRONTEND_PORT)"
}

status() {
  printf 'mode: %s\n' "$MODE"
  if is_port_open "$BACKEND_PORT"; then echo "backend  :$BACKEND_PORT — UP"; else echo "backend  :$BACKEND_PORT — down"; fi
  if is_port_open "$FRONTEND_PORT"; then echo "frontend :$FRONTEND_PORT — UP"; else echo "frontend :$FRONTEND_PORT — down"; fi
  printf 'логи: %s, %s\n' "$BACKEND_LOG" "$FRONTEND_LOG"
}

case "${1:-}" in
  start)   start_backend; start_frontend
           echo
           echo "Извне контейнера (на хосте): agent-fwd up ${FRONTEND_PORT}:${FRONTEND_PORT}"
           echo "логи: $BACKEND_LOG, $FRONTEND_LOG" ;;
  stop)    stop ;;
  restart) stop; sleep 1; start_backend; start_frontend ;;
  status)  status ;;
  *)       echo "usage: $0 {start|stop|restart|status}" >&2; exit 2 ;;
esac