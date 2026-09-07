#!/bin/bash
# ============================================================================
# modules/schema-repair.sh v1.0.0 — восстановление схемы (schema repair)
# ============================================================================
# Отвечает на вопрос «что, если клиент переименовал наши колонки кривыми руками?».
#
# Принцип:
#   - бот и вебхук обращаются к колонкам по СТРОКОВЫМ названиям (Data API v1);
#   - переименование колонки в UI меняет title, НО стабильный id остаётся;
#   - значит, сверяем живую базу с эталоном (template.db) ПО id и возвращаем title.
#
# Правила:
#   ✅ чинит ТОЛЬКО переименованные таблицы/колонки (id найден, title отличается);
#   ✅ чужие колонки/таблицы клиента НЕ трогает (их id нет в эталоне);
#   ✅ ничего НЕ создаёт и НЕ удаляет (это работа дельт upgrades/U*.sh);
#   ⚠️ дубликаты title в одной таблице невозможны через UI (валидация NocoDB),
#      поэтому конфликт имён практически исключён — на всякий случай warning.
#
# Использование:
#   bash modules/schema-repair.sh                    # выполнить починку
#   bash modules/schema-repair.sh --dry-run          # показать план без изменений
#   NOCO_DB=/path/to.db bash modules/schema-repair.sh  # другая база
# ============================================================================
set -euo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${TEMPLATE:-$INSTALL_DIR/template.db}"
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
LOG_FILE="/mnt/data/nocodb-data/upgrade.log"
DRY_RUN=false

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        *) echo "❌ Неизвестный аргумент: $arg" >&2; exit 1 ;;
    esac
done

# --- Цвета ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo -e "$msg"
    echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
}

warn() {
    echo -e "${YELLOW}⚠️  $*${NC}"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ⚠️  $*" >> "$LOG_FILE" 2>/dev/null || true
}

err() {
    echo -e "${RED}❌ $*${NC}" >&2
    exit 1
}

# --- Проверки ---
[ -f "$NOCO_DB" ]  || err "Файл живой БД не найден: $NOCO_DB"
[ -f "$TEMPLATE" ] || err "Эталон template.db не найден: $TEMPLATE"

# --- SQL-хелперы ---
q() {  # q <db> <sql> — запрос (вывод)
    sqlite3 "$1" ".timeout 5000" "$2" 2>/dev/null || true
}

x() {  # x <db> <sql> — выполнение
    sqlite3 "$1" ".timeout 5000" "$2" >/dev/null 2>&1 || true
}

esc() { echo "${1//\'/\'\'}"; }

# --- Вспомогательная: проверить дубликаты title ---
check_dupes() {
    local db="$1" kind="$2" mid="$3" title="$4" self_id="${5:-}"
    local cnt
    if [ "$kind" = "table" ]; then
        cnt=$(q "$db" "SELECT COUNT(*) FROM nc_models_v2 WHERE title='$(esc "$title")' AND id != '$mid';")
    else
        cnt=$(q "$db" "SELECT COUNT(*) FROM nc_columns_v2 WHERE fk_model_id='$mid' AND title='$(esc "$title")' AND id != '$self_id';")
    fi
    if [ -n "$cnt" ] && [ "$cnt" -gt 0 ]; then
        warn "ВНИМАНИЕ: '$title' уже занято другой сущностью (id=$mid) — проверь вручную"
    fi
    return 0
}

FIXED_TABLES=0
FIXED_COLUMNS=0
MISSING_TABLES=0
MISSING_COLUMNS=0

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}🔧 schema-repair.sh v1.0.0${NC}"
[ "$DRY_RUN" = true ] && echo -e "${YELLOW}   РЕЖИМ ПРОСМОТРА (--dry-run): изменения НЕ применяются${NC}"
echo -e "${BLUE}   База:   $NOCO_DB${NC}"
echo -e "${BLUE}   Эталон: $TEMPLATE${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"


# ═══════════════════════════════════════════════════════════════════════════
# 1. ТАБЛИЦЫ (модели)
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BLUE}📋 Шаг 1/2: проверяю названия таблиц...${NC}"

while IFS='|' read -r mid mtitle; do
    [ -z "$mid" ] && continue
    # Якорь 1: id из эталона (свежие установки — ID совпадают)
    live_title=$(q "$NOCO_DB" "SELECT title FROM nc_models_v2 WHERE id='$mid' LIMIT 1;")
    if [ -z "$live_title" ]; then
        # Якорь 2: title (старые установки — ID другие, ищем по имени)
        live_title=$(q "$NOCO_DB" "SELECT title FROM nc_models_v2 WHERE title='$(esc "$mtitle")' AND table_name != '' AND table_name IS NOT NULL LIMIT 1;")
    fi
    if [ -z "$live_title" ]; then
        # Таблицы нет в живой базе — это работа дельт (не чиним, только считаем)
        MISSING_TABLES=$((MISSING_TABLES + 1))
        continue
    fi
    if [ "$live_title" != "$mtitle" ]; then
        FIXED_TABLES=$((FIXED_TABLES + 1))
        echo -e "  ${YELLOW}🔄 Таблица: '$live_title' → '$mtitle'${NC}"
        if [ "$DRY_RUN" = false ]; then
            check_dupes "$NOCO_DB" "table" "$mid" "$mtitle"
            x "$NOCO_DB" "UPDATE nc_models_v2 SET title='$(esc "$mtitle")', updated_at=datetime('now') WHERE id='$mid';"
            log "🔧 Таблица переименована обратно: $mid → '$mtitle'"
        fi
    fi
done < <(q "$TEMPLATE" "
    SELECT id, title FROM nc_models_v2
    WHERE title NOT LIKE 'nc\_%' ESCAPE '\\'
      AND title NOT LIKE 'xc\_%' ESCAPE '\\'
      AND title != 'workspace'
      AND table_name != '' AND table_name IS NOT NULL
      AND mm != 1
    ORDER BY title;")

# ═══════════════════════════════════════════════════════════════════════════
# 2. КОЛОНКИ
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BLUE}📋 Шаг 2/2: проверяю названия колонок...${NC}"

while IFS='|' read -r cid mtitle ctitle ccolname; do
    [ -z "$cid" ] && continue
    # Якорь 1: id из эталона (свежие установки — ID совпадают)
    live_row=$(q "$NOCO_DB" "SELECT id||'|'||title FROM nc_columns_v2 WHERE id='$cid' LIMIT 1;")
    if [ -z "$live_row" ]; then
        # Якорь 2: column_name (старые установки — ID другие, column_name = слаг названия).
        # Привязку к таблице делаем через её title (её клиенты переименовывают редко).
        live_model_id=$(q "$NOCO_DB" "SELECT id FROM nc_models_v2 WHERE title='$(esc "$mtitle")' AND table_name != '' AND table_name IS NOT NULL LIMIT 1;")
        if [ -n "$live_model_id" ]; then
            live_row=$(q "$NOCO_DB" "SELECT id||'|'||title FROM nc_columns_v2 WHERE fk_model_id='$live_model_id' AND column_name='$(esc "$ccolname")' LIMIT 1;")
        fi
    fi
    if [ -z "$live_row" ]; then
        # Колонки нет в живой базе (ни по id, ни по column_name) — работа дельт
        MISSING_COLUMNS=$((MISSING_COLUMNS + 1))
        continue
    fi
    live_col_id=$(echo "$live_row" | cut -d'|' -f1)
    live_title=$(echo "$live_row" | cut -d'|' -f2)
    if [ "$live_title" != "$ctitle" ]; then
        FIXED_COLUMNS=$((FIXED_COLUMNS + 1))
        echo -e "  ${YELLOW}🔄 Колонка [таблица: $mtitle]: '$live_title' → '$ctitle'${NC}"
        if [ "$DRY_RUN" = false ]; then
            live_model_id=$(q "$NOCO_DB" "SELECT fk_model_id FROM nc_columns_v2 WHERE id='$live_col_id' LIMIT 1;")
            check_dupes "$NOCO_DB" "column" "$live_model_id" "$ctitle" "$live_col_id"
            x "$NOCO_DB" "UPDATE nc_columns_v2 SET title='$(esc "$ctitle")', updated_at=datetime('now') WHERE id='$live_col_id';"
            log "🔧 Колонка переименована обратно: $live_col_id → '$ctitle' (таблица $mtitle)"
        fi
    fi
done < <(q "$TEMPLATE" "
    SELECT c.id, m.title, c.title, c.column_name
    FROM nc_columns_v2 c
    JOIN nc_models_v2 m ON c.fk_model_id = m.id
    WHERE m.title NOT LIKE 'nc\_%' ESCAPE '\\'
      AND m.title NOT LIKE 'xc\_%' ESCAPE '\\'
      AND m.title != 'workspace'
      AND m.table_name != '' AND m.table_name IS NOT NULL
      AND m.mm != 1
      AND c.title IS NOT NULL AND c.title != ''
      AND c.uidt IS NOT NULL
      AND c.column_name IS NOT NULL AND c.column_name != ''
    ORDER BY m.title, c.\"order\";")

# ═══════════════════════════════════════════════════════════════════════════
# ИТОГ
# ═══════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}🔍 План: переименовать таблиц — $FIXED_TABLES, колонок — $FIXED_COLUMNS${NC}"
    echo -e "${YELLOW}   (режим просмотра — ничего не изменено)${NC}"
else
    if [ "$FIXED_TABLES" -eq 0 ] && [ "$FIXED_COLUMNS" -eq 0 ]; then
        echo -e "${GREEN}✅ Схема в порядке: переименований не найдено${NC}"
    else
        echo -e "${GREEN}✅ Восстановлено: таблиц — $FIXED_TABLES, колонок — $FIXED_COLUMNS${NC}"
        warn "После ремонта NocoDB может держать кэш метаданных — перезапусти контейнер nocodb (upgrade.sh сделает это сам)"
    fi
fi
if [ "$MISSING_TABLES" -gt 0 ] || [ "$MISSING_COLUMNS" -gt 0 ]; then
    echo -e "${YELLOW}   ⚠️ Отсутствует в живой базе: таблиц — $MISSING_TABLES, колонок — $MISSING_COLUMNS${NC}"
    echo -e "${YELLOW}   Это НЕ ошибка ремонта — недостающее добавляется дельтами (upgrades/U*.sh)${NC}"
fi
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

