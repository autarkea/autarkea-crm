#!/bin/bash
# ============================================================================
# Printed4U CRM - Облачный бэкап v1.0.0 (часть релиза v4.12.0)
# ============================================================================
# Назначение: Заливка последнего локального бэкапа в Google Drive через rclone.
#
#   Локальный → rclone copy → grive:nocodb-backups/
#
# - Remote называется строго `grive`, папка `nocodb-backups` —
#   именно их читает Telegram-бот в команде /backup (см. bot/bot.js).
# - Конфиг rclone: ~/.config/rclone/rclone.conf (стандартный путь).
#
# Вызов:    bash modules/backup-cloud.sh
#           (из cron, из backup-install.sh или вручную)
#
# Ротация: хранится BACKUP_RETENTION_CLOUD последних бэкапов (дефолт 14),
#          настраивается в .env или переменной окружения RETENTION.
# ============================================================================
set -euo pipefail

DATA_DIR="${DATA_DIR:-/mnt/data}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups}"
LOG_FILE="$BACKUP_DIR/backup.log"
RETENTION="${RETENTION:-14}"
RCLONE_REMOTE="${RCLONE_REMOTE:-grive:nocodb-backups}"
INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# --- Цвета ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# ----------------------------------------------------------------------------
# Загрузка ротации из .env (BACKUP_RETENTION_CLOUD)
# ----------------------------------------------------------------------------
load_env() {
    local ENV_FILE="$INSTALL_DIR/.env"
    local v
    if [ -f "$ENV_FILE" ]; then
        v=$(grep -E '^BACKUP_RETENTION_CLOUD=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r' || true)
        if [ -n "$v" ] && [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -gt 0 ]; then
            RETENTION="$v"
        fi
    fi
}

# ----------------------------------------------------------------------------
# Ротация облачных бэкапов: оставляем последние RETENTION в grive:nocodb-backups
# ----------------------------------------------------------------------------
rotate_cloud() {
    local old file
    # rclone lsl: '<size> <modtime> <path>'; сортируем по имени файла (там дата)
    old=$(rclone lsl "$RCLONE_REMOTE/" 2>/dev/null \
          | awk '{print $3}' \
          | grep '^nocodb_full_backup_.*\.tar\.gz$' \
          | sort \
          | head -n -"$RETENTION" || true)

    if [ -n "$old" ]; then
        echo "$old" | while read -r file; do
            rclone delete "$RCLONE_REMOTE/$file" >>"$LOG_FILE" 2>&1
            log "🗑  Облачная ротация: удалён $file"
        done
    fi
}

# ----------------------------------------------------------------------------
# Основной поток
# ----------------------------------------------------------------------------
main() {
    mkdir -p "$BACKUP_DIR"
    load_env

    if ! command -v rclone >/dev/null 2>&1; then
        log "❌ rclone не установлен. Запусти: bash modules/backup-install.sh"
        exit 1
    fi

    if ! rclone listremotes 2>/dev/null | grep -q '^grive:$'; then
        log "❌ Remote 'grive' не настроен в rclone. Запусти: bash modules/backup-install.sh"
        exit 1
    fi

    local latest
    latest=$(ls -1t "$BACKUP_DIR"/nocodb_full_backup_*.tar.gz 2>/dev/null | head -1 || true)
    if [ -z "$latest" ]; then
        log "❌ Локальных бэкапов нет. Запусти сначала modules/backup-local.sh"
        exit 1
    fi

    log "🚀 Заливка в облако: $(basename "$latest") → $RCLONE_REMOTE/"
    if rclone copy "$latest" "$RCLONE_REMOTE/" >>"$LOG_FILE" 2>&1; then
        log "✅ Облачный бэкап загружен."
    else
        log "❌ Ошибка загрузки в облако. Смотри лог выше."
        exit 1
    fi

    rotate_cloud
    log "✅ Облачный бэкап завершён."
}

main "$@"
