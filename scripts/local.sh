#!/usr/bin/env bash
# Oliveira Costa — unified local dev orchestrator.
#
# Usage:
#   ./scripts/local.sh [start|stop|status|logs] [--dev]
#
# Commands:
#   start   (default) — stop, rebuild, start backend + frontend; run health checks
#   stop              — stop backend + frontend
#   status            — show running processes and ports
#   logs              — tail backend + frontend logs
#
# Flags:
#   --dev             — run frontend in `next dev` mode (hot reload); default is prod build

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_PID_FILE="/tmp/oc_backend.pid"
FRONTEND_PID_FILE="/tmp/oc_frontend.pid"
BACKEND_LOG="/tmp/oc-backend.log"
FRONTEND_LOG="/tmp/oc-frontend.log"

# Colors (fallback to empty if non-tty)
if [[ -t 1 ]]; then
  C_B=$'\033[1m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_D=$'\033[2m'; C_N=$'\033[0m'
else
  C_B=""; C_G=""; C_Y=""; C_R=""; C_D=""; C_N=""
fi

CMD="${1:-start}"
MODE="prod"
for arg in "$@"; do
  [[ "$arg" == "--dev" ]] && MODE="dev"
done

step()  { echo "${C_B}${C_G}▸${C_N} ${C_B}$*${C_N}"; }
info()  { echo "${C_D}  $*${C_N}"; }
warn()  { echo "${C_Y}⚠${C_N} $*"; }
fail()  { echo "${C_R}✗${C_N} $*"; exit 1; }

port_pid() {
  ss -tnlpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1 || true
}

kill_processes() {
  local found=0
  local pid
  for port in 8090 5173; do
    pid=$(port_pid "$port")
    [[ -n "$pid" ]] && kill -TERM "$pid" 2>/dev/null && found=1 || true
  done
  sleep 1
  for port in 8090 5173; do
    pid=$(port_pid "$port")
    [[ -n "$pid" ]] && kill -9 "$pid" 2>/dev/null || true
  done
  pkill -f 'realstate_api' >/dev/null 2>&1 || true
  pkill -f 'next-server\|next dev -p 5173\|next start -p 5173' >/dev/null 2>&1 || true
  rm -f "$BACKEND_PID_FILE" "$FRONTEND_PID_FILE"
  [[ $found -eq 1 ]] && info "stopped existing processes"
  return 0
}

ensure_env() {
  [[ -f "$BACKEND_DIR/.env" ]] || cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
  [[ -f "$FRONTEND_DIR/.env.local" ]] || cp "$FRONTEND_DIR/.env.example" "$FRONTEND_DIR/.env.local"
}

wait_health() {
  local url="$1" name="$2" tries="${3:-60}"
  for _ in $(seq 1 "$tries"); do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  fail "$name failed health check: $url — tail log with: $0 logs"
}

cmd_stop() {
  step "stopping services"
  kill_processes
  echo "${C_G}✓ stopped${C_N}"
}

cmd_status() {
  step "service status"
  local back front
  back=$(port_pid 8090)
  front=$(port_pid 5173)
  if [[ -n "$back" ]]; then
    echo "  ${C_G}●${C_N} backend  ${C_D}pid=$back  port=8090${C_N}"
  else
    echo "  ${C_R}○${C_N} backend  ${C_D}not running${C_N}"
  fi
  if [[ -n "$front" ]]; then
    echo "  ${C_G}●${C_N} frontend ${C_D}pid=$front  port=5173${C_N}"
  else
    echo "  ${C_R}○${C_N} frontend ${C_D}not running${C_N}"
  fi
}

cmd_logs() {
  step "tailing logs (Ctrl+C to exit)"
  tail -f "$BACKEND_LOG" "$FRONTEND_LOG" 2>/dev/null
}

cmd_start() {
  step "stopping existing services"
  kill_processes

  step "ensuring env files"
  ensure_env

  step "rebuilding backend"
  (cd "$BACKEND_DIR" && make >/dev/null) || fail "backend build failed"

  if [[ "$MODE" == "prod" ]]; then
    step "installing frontend dependencies"
    (cd "$FRONTEND_DIR" && npm install --silent >/dev/null 2>&1)
    step "building frontend (prod)"
    (cd "$FRONTEND_DIR" && npm run build >/dev/null 2>&1) || fail "frontend build failed"
  else
    step "installing frontend dependencies (dev mode)"
    (cd "$FRONTEND_DIR" && npm install --silent >/dev/null 2>&1)
  fi

  rm -f "$BACKEND_LOG" "$FRONTEND_LOG"

  step "starting backend on :8090"
  cd "$BACKEND_DIR"
  set -a; source "$BACKEND_DIR/.env"; set +a
  : "${PORT:=8090}"
  setsid -f env PORT="$PORT" "$BACKEND_DIR/realstate_api" >"$BACKEND_LOG" 2>&1 < /dev/null
  wait_health "http://127.0.0.1:${PORT}/health" "backend" 40
  local back_pid; back_pid="$(pgrep -n -f "$BACKEND_DIR/realstate_api" || true)"
  echo "$back_pid" >"$BACKEND_PID_FILE"
  info "backend up (pid=$back_pid)"

  step "starting frontend on :5173 (${MODE})"
  cd "$FRONTEND_DIR"
  if [[ "$MODE" == "dev" ]]; then
    setsid -f bash -lc "cd '$FRONTEND_DIR' && exec npm run dev -- --hostname 127.0.0.1" >"$FRONTEND_LOG" 2>&1 < /dev/null
  else
    setsid -f bash -lc "cd '$FRONTEND_DIR' && exec npm run start" >"$FRONTEND_LOG" 2>&1 < /dev/null
  fi
  wait_health "http://127.0.0.1:5173" "frontend" 80
  local front_pid; front_pid="$(pgrep -n -f 'next-server|next dev -p 5173|next start -p 5173' || true)"
  echo "$front_pid" >"$FRONTEND_PID_FILE"
  info "frontend up (pid=$front_pid)"

  echo ""
  echo "${C_B}${C_G}═══ Environment ready (${MODE}) ═══${C_N}"
  echo ""
  printf "  ${C_B}Backend${C_N}           %s\n" "http://127.0.0.1:8090"
  printf "  ${C_B}Frontend${C_N}          %s\n" "http://127.0.0.1:5173"
  printf "  ${C_B}Admin portal${C_N}      %s\n" "http://127.0.0.1:5173/login"
  printf "  ${C_B}Client portal${C_N}     %s\n" "http://127.0.0.1:5173/client/login"
  echo ""
  echo "  ${C_B}Credentials${C_N}"
  printf "    ${C_D}admin${C_N}    %s  /  %s\n"  "admin@realstate.com" "ChangeThisNow123!"
  printf "    ${C_D}tenant${C_N}   %s  /  %s   ${C_D}(set via admin panel first)${C_N}\n" "marina@example.com" "Tenant123!"
  echo ""
  echo "  ${C_B}Logs${C_N}               $BACKEND_LOG  |  $FRONTEND_LOG"
  echo "  ${C_B}Commands${C_N}           $0 [start|stop|status|logs] [--dev]"
  echo ""
}

case "$CMD" in
  start|restart) cmd_start ;;
  stop)          cmd_stop ;;
  status)        cmd_status ;;
  logs)          cmd_logs ;;
  *)             fail "unknown command: $CMD (use: start|stop|status|logs)" ;;
esac
