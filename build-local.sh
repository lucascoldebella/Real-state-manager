#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "[1/3] Building backend..."
cd "$ROOT_DIR/backend"
make

echo "[2/3] Installing frontend dependencies..."
cd "$ROOT_DIR/frontend"
npm install

echo "[3/3] Building frontend..."
npm run build

echo ""
echo "Build finished successfully."
echo "Run ./run-local.sh to start the app."
