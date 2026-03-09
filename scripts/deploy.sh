#!/usr/bin/env bash
# Oliveira Costa Real Estate — One-Command Deploy Script
# Pushes local changes to GitHub, pulls on VPS, rebuilds what changed, restarts services.
#
# Usage:
#   ./scripts/deploy.sh              # Auto-detect what changed and deploy
#   ./scripts/deploy.sh --frontend   # Force frontend rebuild only
#   ./scripts/deploy.sh --backend    # Force backend rebuild only
#   ./scripts/deploy.sh --full       # Force full rebuild (frontend + backend)
#   ./scripts/deploy.sh --skip-push  # Deploy without pushing (VPS pulls latest from GitHub)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VPS="coldnb-vps"
VPS_PUBLIC_IP="${VPS_PUBLIC_IP:-134.209.44.188}"
VPS_DOMAIN="${VPS_DOMAIN:-oc.coldnb.com}"
VPS_PROJECT="/opt/realstate"
VPS_FRONTEND="$VPS_PROJECT/frontend"
VPS_BACKEND="$VPS_PROJECT/backend"
BACKEND_SERVICE="realstate-backend"
FRONTEND_PROCESS="realstate-frontend"

LOCAL_ONLY_PATHS=(
    "backend/.env"
    "frontend/.env.local"
    "backend/data"
    "backend/generated"
    "data"
    "dumps"
    "generated"
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[deploy]${NC} $1"; }
ok()    { echo -e "${GREEN}[deploy]${NC} $1"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $1"; }
fail()  { echo -e "${RED}[deploy]${NC} $1"; exit 1; }

is_local_only_path() {
    local path="$1"
    case "$path" in
        backend/.env|frontend/.env.local|backend/data/*|backend/generated/*|data/*|dumps/*|generated/*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Parse flags
FORCE_FRONTEND=false
FORCE_BACKEND=false
SKIP_PUSH=false

for arg in "$@"; do
    case $arg in
        --frontend)  FORCE_FRONTEND=true ;;
        --backend)   FORCE_BACKEND=true ;;
        --full)      FORCE_FRONTEND=true; FORCE_BACKEND=true ;;
        --skip-push) SKIP_PUSH=true ;;
        --help)
            echo "Usage: ./scripts/deploy.sh [--frontend] [--backend] [--full] [--skip-push]"
            exit 0
            ;;
    esac
done

echo ""
echo "========================================"
echo "  Real Estate Deploy to Production"
echo "========================================"
echo ""

# Step 1: Commit local changes if any
info "Checking local git status..."
cd "$ROOT_DIR"

if [ -n "$(git status --porcelain)" ]; then
    warn "Uncommitted changes:"
    git status --short
    echo ""

    info "Auto-staging code changes while leaving local DB/config files untouched..."
    git add -u -- . ":(exclude)backend/.env" ":(exclude)frontend/.env.local" ":(exclude)backend/data" ":(exclude)backend/generated"

    SAFE_UNTRACKED=()
    while IFS= read -r path; do
        [ -z "$path" ] && continue
        if ! is_local_only_path "$path"; then
            SAFE_UNTRACKED+=("$path")
        fi
    done < <(git ls-files --others --exclude-standard)

    if [ "${#SAFE_UNTRACKED[@]}" -gt 0 ]; then
        git add -- "${SAFE_UNTRACKED[@]}"
    fi

    if ! git diff --cached --quiet; then
        echo "Staged changes:"
        git diff --cached --stat
        echo ""

        read -r -p "Commit message: " COMMIT_MSG
        if [ -z "$COMMIT_MSG" ]; then
            fail "Aborted. No commit message entered."
        fi

        git commit -m "$COMMIT_MSG"
        ok "Changes committed"
    else
        warn "Only local-only files changed. No code/config changes were auto-committed."
    fi

    LOCAL_ONLY_STATUS="$(git status --short -- "${LOCAL_ONLY_PATHS[@]}" || true)"
    if [ -n "$LOCAL_ONLY_STATUS" ]; then
        warn "Left out of the deploy commit on purpose:"
        echo "$LOCAL_ONLY_STATUS"
        echo ""
    fi
else
    info "Working tree clean — pushing latest commit"
fi

# Step 2: Detect what changed since last deploy tag
LAST_DEPLOY=$(git tag -l 'rs-deploy-*' --sort=-version:refname | head -1)
if [ -n "$LAST_DEPLOY" ]; then
    CHANGED_FILES=$(git diff --name-only "$LAST_DEPLOY"..HEAD 2>/dev/null || echo "")
else
    CHANGED_FILES=$(git diff --name-only HEAD~1..HEAD 2>/dev/null || echo "all")
fi

# Auto-detect what needs rebuilding
NEED_FRONTEND=false
NEED_BACKEND=false

if echo "$CHANGED_FILES" | grep -q "frontend/"; then
    NEED_FRONTEND=true
fi
if echo "$CHANGED_FILES" | grep -q "backend/"; then
    NEED_BACKEND=true
fi

# Apply force flags
$FORCE_FRONTEND && NEED_FRONTEND=true
$FORCE_BACKEND && NEED_BACKEND=true

# If nothing detected, default to full
if ! $NEED_FRONTEND && ! $NEED_BACKEND; then
    warn "No changes detected or first deploy — doing full rebuild"
    NEED_FRONTEND=true
    NEED_BACKEND=true
fi

info "Deploy plan:"
$NEED_BACKEND  && echo "  - Backend:  rebuild + restart"
$NEED_FRONTEND && echo "  - Frontend: rebuild + restart"
echo ""

# Step 3: Push to GitHub
if ! $SKIP_PUSH; then
    info "Pushing to GitHub..."
    git push origin main 2>&1 | tail -3
    ok "Pushed to GitHub"
else
    warn "Skipping push (--skip-push)"
fi

# Step 4: Pull on VPS
info "Pulling latest code on VPS..."
ssh "$VPS" "cd $VPS_PROJECT && git pull origin main 2>&1 | tail -5"
ok "VPS code updated"

# Step 5: Rebuild backend if needed
if $NEED_BACKEND; then
    info "Rebuilding C backend..."
    ssh "$VPS" "bash -lc \"cd '$VPS_BACKEND' && make clean >/dev/null 2>&1 || true && make && systemctl restart $BACKEND_SERVICE && systemctl is-active --quiet $BACKEND_SERVICE && curl -fsS http://127.0.0.1:8090/health >/dev/null && echo 'Backend restarted'\""
    ok "Backend deployed"
fi

# Step 6: Rebuild frontend if needed
if $NEED_FRONTEND; then
    info "Rebuilding Next.js frontend (this takes ~30s)..."
    ssh "$VPS" "bash -lc \"cd '$VPS_FRONTEND' && npm install && NEXT_TELEMETRY_DISABLED=1 npm run build && pm2 restart $FRONTEND_PROCESS && curl -fsS http://127.0.0.1:5173/ >/dev/null && echo 'Frontend restarted'\""
    ok "Frontend deployed"
fi

# Step 7: Tag this deploy
DEPLOY_TAG="rs-deploy-$(date +%Y%m%d-%H%M%S)"
git tag "$DEPLOY_TAG" 2>/dev/null || true

# Step 8: Quick health check
info "Health check..."
sleep 3
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "https://$VPS_DOMAIN/" 2>/dev/null || echo "000")
API_CODE=$(ssh "$VPS" "curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:8090/health" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "307" ]; then
    ok "Health check passed: Frontend=$HTTP_CODE API=$API_CODE"
else
    warn "Health check: Frontend=$HTTP_CODE API=$API_CODE (may still be starting)"
fi

echo ""
ok "Deploy complete! Tagged as $DEPLOY_TAG"
echo ""
