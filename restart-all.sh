#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_PID_FILE="/tmp/oliveira_costa_backend.pid"
FRONTEND_PID_FILE="/tmp/oliveira_costa_frontend.pid"
BACKEND_LOG="/tmp/oliveira-costa-backend.log"
FRONTEND_LOG="/tmp/oliveira-costa-frontend.log"

kill_pid_file() {
  local pid_file="$1"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "$pid" ]]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
    rm -f "$pid_file"
  fi
}

echo "[1/6] Stopping current services..."
kill_pid_file "$BACKEND_PID_FILE"
kill_pid_file "$FRONTEND_PID_FILE"
pkill -f '(^|/)realstate_api($| )' >/dev/null 2>&1 || true
pkill -f 'next-server' >/dev/null 2>&1 || true
pkill -f 'next start -p 5173' >/dev/null 2>&1 || true


echo "[2/6] Cleaning caches..."
rm -rf "$FRONTEND_DIR/.next" "$FRONTEND_DIR/tsconfig.tsbuildinfo"
rm -f "$BACKEND_LOG" "$FRONTEND_LOG"


echo "[3/6] Rebuilding backend..."
cd "$BACKEND_DIR"
make clean >/dev/null 2>&1 || true
make >/dev/null


echo "[4/6] Rebuilding frontend..."
cd "$FRONTEND_DIR"
npm install >/dev/null
npm run build >/dev/null

if [[ ! -f "$BACKEND_DIR/.env" ]]; then
  cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
fi
if [[ ! -f "$FRONTEND_DIR/.env.local" ]]; then
  cp "$FRONTEND_DIR/.env.example" "$FRONTEND_DIR/.env.local"
fi


echo "[5/6] Starting backend..."
cd "$BACKEND_DIR"
set -a
# shellcheck disable=SC1091
source "$BACKEND_DIR/.env"
set +a
: "${PORT:=8090}"
setsid -f env PORT="$PORT" "$BACKEND_DIR/realstate_api" >"$BACKEND_LOG" 2>&1 < /dev/null


echo "[6/6] Starting frontend..."
cd "$FRONTEND_DIR"
setsid -f bash -lc "cd '$FRONTEND_DIR' && exec env PORT=5173 npm run start" >"$FRONTEND_LOG" 2>&1 < /dev/null


echo "Waiting for services..."
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:5173/dashboard" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "Backend failed to start. Check $BACKEND_LOG"
  exit 1
fi
if ! curl -fsS "http://127.0.0.1:5173/dashboard" >/dev/null 2>&1; then
  echo "Frontend failed to start. Check $FRONTEND_LOG"
  exit 1
fi

BACK_PID="$(pgrep -n -f "$BACKEND_DIR/realstate_api" || true)"
FRONT_PID="$(pgrep -n -f 'next-server|next start -p 5173' || true)"

if [[ -z "$BACK_PID" ]] || ! kill -0 "$BACK_PID" >/dev/null 2>&1; then
  echo "Backend process not found after startup. Check $BACKEND_LOG"
  exit 1
fi
if [[ -z "$FRONT_PID" ]] || ! kill -0 "$FRONT_PID" >/dev/null 2>&1; then
  echo "Frontend process not found after startup. Check $FRONTEND_LOG"
  exit 1
fi

echo "$BACK_PID" >"$BACKEND_PID_FILE"
echo "$FRONT_PID" >"$FRONTEND_PID_FILE"

sleep 2
if ! curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "Backend became unavailable after startup. Check $BACKEND_LOG"
  exit 1
fi
if ! curl -fsS "http://127.0.0.1:5173/dashboard" >/dev/null 2>&1; then
  echo "Frontend became unavailable after startup. Check $FRONTEND_LOG"
  exit 1
fi

echo ""
echo "Restart complete."
echo "Backend:  http://127.0.0.1:${PORT}"
echo "Frontend: http://127.0.0.1:5173"
echo "Login:    admin@imobiliaria.local / ChangeThisNow123!"
echo ""
echo "PIDs:"
echo "- Backend  $(cat "$BACKEND_PID_FILE")"
echo "- Frontend $(cat "$FRONTEND_PID_FILE")"
