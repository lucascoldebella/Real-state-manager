#!/usr/bin/env bash
# Oliveira Costa Real Estate — Database Sync Script
# Syncs SQLite database between VPS and local machine.
#
# Usage:
#   ./scripts/db-sync.sh pull       # Pull VPS database → local (default)
#   ./scripts/db-sync.sh push       # Push local database → VPS
#   ./scripts/db-sync.sh --backup   # Only download VPS backup, don't overwrite local

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

VPS="coldnb-vps"
VPS_DB="/opt/realstate/backend/data/realstate.db"
VPS_SERVICE="realstate-backend"
LOCAL_DB="$ROOT_DIR/backend/data/realstate.db"
BACKUP_DIR="$ROOT_DIR/dumps"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[db-sync]${NC} $1"; }
ok()    { echo -e "${GREEN}[db-sync]${NC} $1"; }
warn()  { echo -e "${YELLOW}[db-sync]${NC} $1"; }
fail()  { echo -e "${RED}[db-sync]${NC} $1"; exit 1; }

ACTION="${1:-pull}"
BACKUP_ONLY=false
[ "$1" = "--backup" ] && BACKUP_ONLY=true && ACTION="pull"

mkdir -p "$BACKUP_DIR"
mkdir -p "$(dirname "$LOCAL_DB")"

verify_local_db() {
    local db_path="$1"
    if ! command -v sqlite3 >/dev/null 2>&1; then
        warn "sqlite3 not found locally; skipping integrity check for $db_path"
        return 0
    fi

    local result
    result="$(sqlite3 "$db_path" "PRAGMA integrity_check;" 2>/dev/null || true)"
    [ "$result" = "ok" ] || fail "SQLite integrity check failed for $db_path"
}

verify_remote_db() {
    local db_path="$1"
    local result
    result="$(ssh "$VPS" "sqlite3 '$db_path' 'PRAGMA integrity_check;'" 2>/dev/null || true)"
    [ "$result" = "ok" ] || fail "SQLite integrity check failed on VPS for $db_path"
}

echo ""
echo "========================================"
echo "  Real Estate Database Sync"
echo "========================================"
echo ""

case "$ACTION" in
    pull)
        info "Downloading VPS database..."
        BACKUP_FILE="$BACKUP_DIR/realstate-$TIMESTAMP.db"

        # Download from VPS
        scp "$VPS:$VPS_DB" "$BACKUP_FILE"
        verify_local_db "$BACKUP_FILE"
        DUMP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
        ok "Backup saved: $BACKUP_FILE ($DUMP_SIZE)"

        if $BACKUP_ONLY; then
            ok "Backup-only mode. File at: $BACKUP_FILE"
            exit 0
        fi

        warn "This will OVERWRITE your local database!"
        read -p "Continue? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            info "Aborted. Backup is still saved at: $BACKUP_FILE"
            exit 0
        fi

        # Backup current local DB first
        if [ -f "$LOCAL_DB" ]; then
            cp "$LOCAL_DB" "$BACKUP_DIR/realstate-local-before-sync-$TIMESTAMP.db"
            info "Local DB backed up before overwrite"
        fi

        cp "$BACKUP_FILE" "$LOCAL_DB"
        verify_local_db "$LOCAL_DB"
        ok "Local database synced from VPS"
        ;;

    push)
        warn "This will OVERWRITE the VPS database with your local copy!"
        read -p "Are you sure? (y/N) " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            fail "Aborted."
        fi

        if [ ! -f "$LOCAL_DB" ]; then
            fail "Local database not found at: $LOCAL_DB"
        fi

        verify_local_db "$LOCAL_DB"

        # Backup VPS DB first
        info "Backing up VPS database..."
        ssh "$VPS" "cp $VPS_DB ${VPS_DB}.bak-$TIMESTAMP"

        REMOTE_INCOMING="/tmp/realstate.db.incoming-$TIMESTAMP"

        # Upload local DB to a temp file first
        info "Uploading local database to VPS temp path..."
        scp "$LOCAL_DB" "$VPS:$REMOTE_INCOMING"
        verify_remote_db "$REMOTE_INCOMING"

        info "Replacing VPS database atomically..."
        ssh "$VPS" "mv '$REMOTE_INCOMING' '$VPS_DB'"

        # Restart the API to pick up new DB
        info "Restarting Real Estate API..."
        ssh "$VPS" "bash -lc \"systemctl restart $VPS_SERVICE && systemctl is-active --quiet $VPS_SERVICE && curl -fsS http://127.0.0.1:8090/health >/dev/null\""

        ok "VPS database synced from local"
        ;;

    *)
        echo "Usage: ./scripts/db-sync.sh [pull|push|--backup]"
        exit 1
        ;;
esac

# Cleanup old backups (keep last 5)
ls -t "$BACKUP_DIR"/realstate-*.db 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true

echo ""
ok "Done!"
echo ""
