#!/bin/bash
# ============================================================================
# Printed4U CRM - Локальный бэкап v1.0.0 (часть релиза v4.12.0)
# ============================================================================
# Назначение: Полный локальный бэкап системы в один tar.gz:
#   - Консистентный снапшот noco.db (через sqlite3 .backup — БЕЗОПАСНО на живой базе)
#   - /mnt/data/projects, /mnt/data/clients, /mnt/data/noco-static (PDF)
#   - docker-compose.yml, .env, templates/ (всё для восстановления из одного файла)
#
# Формат файла: nocodb_full_backup_YYYYMMDD_HHMMSS.tar.gz
#   (именно такой префикс читает Telegram-бот в команде /backup)
#
# Вызов:    bash modules/backup-local.sh
#           (из cron, из backup-install.sh или вручную)
#
# Пути можно переопределить переменными окружения (нужно для тестов):
#   DATA_DIR  BACKUP_DIR  DB_FILE  INSTALL_DIR
#
# Ротация: хранится BACKUP_RETENTION_LOCAL последних бэкапов (дефолт 7),
#          настраивается в .env или переменной окружения RETENTION.
# ============================================================================
set -euo pipefail

DATA_DIR="${DATA_DIR:-/mnt/data}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups}"
DB_FILE="${DB_FILE:-$DATA_DIR/nocodb-data/noco.db}"
LOG_FILE="$BACKUP_DIR/backup.log"
RETENTION="${RETENTION:-7}"
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
# Загрузка ротации из .env (BACKUP_RETENTION_LOCAL)
# ----------------------------------------------------------------------------
load_env() {
    local ENV_FILE="$INSTALL_DIR/.env"
    local v
    if [ -f "$ENV_FILE" ]; then
        v=$(grep -E '^BACKUP_RETENTION_LOCAL=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r' || true)
        if [ -n "$v" ] && [[ "$v" =~ ^[0-9]+$ ]] && [ "$v" -gt 0 ]; then
            RETENTION="$v"
        fi
    fi
}

# ----------------------------------------------------------------------------
# Консистентный снапшот базы через sqlite3 .backup.
# Сначала пробуем sqlite3 на хосте, иначе — alpine-контейнер (как в install.sh).
# .backup корректно работает с живой SQLite-базой (в т.ч. WAL-режимом),
# в отличие от слепого cp, который может дать битый дамп.
# ----------------------------------------------------------------------------
snapshot_db() {
    local SNAPSHOT="$BACKUP_DIR/.noco_snapshot.db"

    if [ ! -f "$DB_FILE" ]; then
        log "❌ База не найдена: $DB_FILE"
        return 1
    fi

    rm -f "$SNAPSHOT"

    if command -v sqlite3 >/dev/null 2>&1; then
        sqlite3 "$DB_FILE" ".backup '$SNAPSHOT'"
        chown "$(id -u):$(id -g)" "$SNAPSHOT" 2>/dev/null || true
    else
        docker run --rm \
            -v "$DATA_DIR/nocodb-data":/data \
            -v "$BACKUP_DIR":/backups \
            alpine:3.20 sh -c \
            "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 /data/noco.db '.backup /backups/.noco_snapshot.db' && chown $(id -u):$(id -g) /backups/.noco_snapshot.db"
    fi

    if [ ! -s "$SNAPSHOT" ]; then
        log "❌ Снапшот пустой или не создан"
        return 1
    fi
    echo "$SNAPSHOT"
}

# ----------------------------------------------------------------------------
# Сборка tar.gz
# ----------------------------------------------------------------------------
create_tar() {
    local TS="$1"
    local SNAPSHOT="$2"
    local STAGE="$BACKUP_DIR/.stage_$TS"
    local FILE="$BACKUP_DIR/nocodb_full_backup_$TS.tar.gz"

    mkdir -p "$STAGE"
    mv "$SNAPSHOT" "$STAGE/noco.db"

    tar -czf "$FILE" \
        -C "$STAGE" noco.db \
        -C "$DATA_DIR" projects clients noco-static \
        -C "$INSTALL_DIR" docker-compose.yml .env templates

    rm -rf "$STAGE"
    echo "$FILE"
}

# ----------------------------------------------------------------------------
# Ротация: оставляем последние RETENTION бэкапов
# ----------------------------------------------------------------------------
rotate() {
    local old
    old=$(ls -1t "$BACKUP_DIR"/nocodb_full_backup_*.tar.gz 2>/dev/null | tail -n +$((RETENTION + 1)) || true)
    if [ -n "$old" ]; then
        echo "$old" | xargs -r rm -f
        log "🗑  Ротация: удалено старых бэкапов: $(echo "$old" | wc -l) (храним $RETENTION)"
    fi
}

# ----------------------------------------------------------------------------
# Основной поток
# ----------------------------------------------------------------------------
main() {
    mkdir -p "$BACKUP_DIR"
    load_env

    local TS SNAPSHOT FILE SIZE
    TS="$(date +%Y%m%d_%H%M%S)"
    log "🚀 Запуск локального бэкапа ($TS)..."
    log "   Источник: $DB_FILE | Ротация: $RETENTION"

    if ! SNAPSHOT="$(snapshot_db)"; then
        log "❌ Снапшот базы не удался. Бэкап отменён."
        exit 1
    fi

    FILE="$(create_tar "$TS" "$SNAPSHOT")"
    SIZE=$(du -h "$FILE" | cut -f1)
    log "✅ Создан: $(basename "$FILE") ($SIZE)"

    rotate
    log "✅ Локальный бэкап завершён."
}

main "$@"
