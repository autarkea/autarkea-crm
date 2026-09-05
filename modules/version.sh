#!/bin/bash
# ============================================================================
# modules/version.sh v1.0.0 — версия схемы установки Printed4U CRM
# ============================================================================
# Хранит номер последней применённой миграции (дельты) в системной таблице
# NocoDB `nc_store` (ключ printed4u_schema_version).
#
# Почему nc_store:
#   - таблица входит в noco.db → версия переживает бэкапы и восстановление;
#   - не видна в UI (системная, а не бизнес-таблица);
#   - проект уже опирается на nc_store (apply-template.sh переносит секреты);
#   - сам NocoDB хранит там NC_MIGRATION_JOBS — мы повторяем его паттерн.
#
# Использование:
#   bash modules/version.sh get                    # текущая версия (число, дефолт 0)
#   bash modules/version.sh set 5                  # записать версию 5 (upsert)
#   bash modules/version.sh init                   # если ключа нет — записать 0
#   NOCO_DB=/path/to.db bash modules/version.sh get  # указать другую базу
# ============================================================================
set -euo pipefail

NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
KEY="printed4u_schema_version"

if [ ! -f "$NOCO_DB" ]; then
    echo "❌ Ошибка: Файл БД не найден: $NOCO_DB" >&2
    exit 1
fi

get_version() {
    sqlite3 "$NOCO_DB" ".timeout 5000" \
        "SELECT value FROM nc_store WHERE key='$KEY' AND (base_id IS NULL OR base_id='') LIMIT 1;" 2>/dev/null || echo ""
}

set_version() {
    local ver="$1"
    sqlite3 "$NOCO_DB" ".timeout 5000" \
        "BEGIN; \
DELETE FROM nc_store WHERE key='$KEY' AND (base_id IS NULL OR base_id=''); \
INSERT INTO nc_store (type, key, value, db_alias, created_at, updated_at) \
VALUES ('printed4u', '$KEY', '$ver', 'db', datetime('now'), datetime('now')); \
COMMIT;"
}

cmd_get() {
    local ver
    ver=$(get_version)
    if [ -z "$ver" ]; then
        echo "0"
    else
        echo "$ver"
    fi
}

cmd_set() {
    local ver="${1:-}"
    if [ -z "$ver" ] || ! [[ "$ver" =~ ^[0-9]+$ ]]; then
        echo "❌ Ошибка: укажите числовую версию: bash modules/version.sh set 5" >&2
        exit 1
    fi
    set_version "$ver"
    echo "✅ Версия схемы записана: $ver"
}

cmd_init() {
    local ver
    ver=$(get_version)
    if [ -z "$ver" ]; then
        set_version "0"
        echo "✅ Инициализирована версия схемы: 0"
    else
        echo "ℹ️ Версия уже есть: $ver"
    fi
}

case "${1:-}" in
    get) cmd_get ;;
    set) cmd_set "${2:-}" ;;
    init) cmd_init ;;
    *)
        echo "Использование: bash modules/version.sh {get|set N|init}" >&2
        echo "  NOCO_DB=/path/to.db — указать другую базу" >&2
        exit 1
        ;;
esac
