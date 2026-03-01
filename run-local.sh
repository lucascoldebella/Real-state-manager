#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_PID=""
RUN_MODE="${RUN_MODE:-start}"

cleanup() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
    echo ""
    echo "Stopping backend (PID $BACKEND_PID)..."
    kill "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

if [[ ! -f "$BACKEND_DIR/.env" ]]; then
  cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
fi

if [[ ! -f "$FRONTEND_DIR/.env.local" ]]; then
  cp "$FRONTEND_DIR/.env.example" "$FRONTEND_DIR/.env.local"
fi

echo "Building backend..."
cd "$BACKEND_DIR"
make >/dev/null

echo "Starting backend on http://127.0.0.1:8090 ..."
set -a
# shellcheck disable=SC1091
source "$BACKEND_DIR/.env"
set +a
PORT="${PORT:-8090}" ./realstate_api >/tmp/oliveira-costa-backend.log 2>&1 &
BACKEND_PID="$!"

echo "Waiting for backend health check..."
for _ in $(seq 1 20); do
  if curl -sS "http://127.0.0.1:${PORT:-8090}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.4
done

if ! curl -sS "http://127.0.0.1:${PORT:-8090}/health" >/dev/null 2>&1; then
  echo "Backend failed to start. Check: /tmp/oliveira-costa-backend.log"
  exit 1
fi

echo "Installing frontend dependencies if needed..."
cd "$FRONTEND_DIR"
npm install >/dev/null

if [[ "$RUN_MODE" == "start" ]]; then
  echo "Building frontend for stable local run..."
  npm run build >/dev/null
fi

echo ""
echo "Backend:  http://127.0.0.1:${PORT:-8090}"
echo "Frontend: http://127.0.0.1:5173"
echo "Login:    admin@imobiliaria.local / ChangeThisNow123!"
echo ""
if [[ "$RUN_MODE" == "dev" ]]; then
  echo "Starting frontend dev server (RUN_MODE=dev)..."
  NEXT_DISABLE_DEVTOOLS=1 npm run dev -- --hostname 127.0.0.1
else
  echo "Starting frontend production server (stable mode)..."
  npm run start
fi
