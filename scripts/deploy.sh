#!/bin/bash
# Oliveira Costa Real Estate — One-Command Deploy Script
# Pushes local changes to GitHub, pulls on VPS, rebuilds what changed, restarts services.
#
# Usage:
#   ./scripts/deploy.sh              # Auto-detect what changed and deploy
#   ./scripts/deploy.sh --frontend   # Force frontend rebuild only
#   ./scripts/deploy.sh --backend    # Force backend rebuild only
#   ./scripts/deploy.sh --full       # Force full rebuild (frontend + backend)
#   ./scripts/deploy.sh --skip-push  # Deploy without pushing (VPS pulls latest from GitHub)

set -e

VPS="coldnb-vps"
VPS_PUBLIC_IP="${VPS_PUBLIC_IP:-64.225.9.178}"
VPS_PROJECT="/opt/realstate"
VPS_FRONTEND="$VPS_PROJECT/frontend"
VPS_BACKEND="$VPS_PROJECT/backend"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[deploy]${NC} $1"; }
ok()    { echo -e "${GREEN}[deploy]${NC} $1"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $1"; }
fail()  { echo -e "${RED}[deploy]${NC} $1"; exit 1; }

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

# Step 1: Check for uncommitted changes
info "Checking local git status..."
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
    warn "You have uncommitted changes:"
    git status --short
    echo ""
    read -p "Continue deploying only committed changes? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        fail "Aborted. Commit your changes first."
    fi
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
    ssh "$VPS" "cd '$VPS_BACKEND' && make clean && make 2>&1 | tail -3 && systemctl restart realstate-api && echo 'Backend restarted'"
    ok "Backend deployed"
fi

# Step 6: Rebuild frontend if needed
if $NEED_FRONTEND; then
    info "Rebuilding Next.js frontend (this takes ~30s)..."
    ssh "$VPS" "cd '$VPS_FRONTEND' && npm install 2>&1 | tail -2 && NEXT_TELEMETRY_DISABLED=1 npm run build 2>&1 | tail -5 && pm2 restart realstate-frontend && echo 'Frontend restarted'"
    ok "Frontend deployed"
fi

# Step 7: Tag this deploy
DEPLOY_TAG="rs-deploy-$(date +%Y%m%d-%H%M%S)"
git tag "$DEPLOY_TAG" 2>/dev/null || true

# Step 8: Quick health check
info "Health check..."
sleep 3
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://$VPS_PUBLIC_IP:8081/" 2>/dev/null || echo "000")
API_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://$VPS_PUBLIC_IP:8081/health" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "307" ]; then
    ok "Health check passed: Frontend=$HTTP_CODE API=$API_CODE"
else
    warn "Health check: Frontend=$HTTP_CODE API=$API_CODE (may still be starting)"
fi

echo ""
ok "Deploy complete! Tagged as $DEPLOY_TAG"
echo ""
