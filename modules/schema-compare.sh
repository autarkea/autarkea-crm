#!/bin/bash
# ============================================================================
# modules/schema-compare.sh v1.0.0 — удалённая диагностика расхождений схемы
# ============================================================================
# Запускается НА СЕРВЕРЕ КЛИЕНТА (рядом с template.db) и сравнивает живую базу
# с эталоном. Выводит ТОЛЬКО МЕТАДАННЫЕ (имена таблиц/колонок/опций) — без
# данных клиента. Это NDA-безопасный способ понять, что доработать клиенту:
# отчёт присылается интегратору текстом, дельты пишутся по нему.
#
# Использование:
#   bash modules/schema-compare.sh                  # на сервере клиента
#   bash modules/schema-compare.sh --json          # машинно-читаемый вывод
#   NOCO_DB=/path/to.db TEMPLATE=/path/to.db bash modules/schema-compare.sh
#
# Что показывает:
#   - версию схемы (nc_store) и каталог дельт в репо;
#   - таблицы, отсутствующие в живой базе;
#   - колонки, отсутствующие в живой базе (по имени в таблице);
#   - селекты: недостающие/лишние опции и расхождения цветов.
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TEMPLATE="${TEMPLATE:-$INSTALL_DIR/template.db}"
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
UPGRADES_DIR="$INSTALL_DIR/upgrades"
JSON=false

for arg in "$@"; do
    case "$arg" in
        --json) JSON=true ;;
        *) echo "❌ Неизвестный аргумент: $arg" >&2; exit 1 ;;
    esac
done

[ -f "$NOCO_DB" ]  || { echo "❌ Живая база не найдена: $NOCO_DB" >&2; exit 1; }
[ -f "$TEMPLATE" ] || { echo "❌ Эталон не найден: $TEMPLATE" >&2; exit 1; }

q() { sqlite3 "$1" ".timeout 5000" "$2" 2>/dev/null || true; }
esc() { echo "${1//\'/\'\'}"; }

out() { if [ "$JSON" = true ]; then echo "$1"; else echo -e "$1"; fi; }

out "═══════════════════════════════════════════════════════════"
out "🔍 schema-compare.sh v1.0.0 — расхождения с эталоном"
out "   База:   $NOCO_DB"
out "   Эталон: $TEMPLATE"
out "═══════════════════════════════════════════════════════════"

# --- 1. ВЕРСИЯ СХЕМЫ И ДЕЛЬТЫ В РЕПО ---
SCHEMA_VER=$(NOCO_DB="$NOCO_DB" bash "$INSTALL_DIR/modules/version.sh" get 2>/dev/null || echo "?")
MAX_DELTA=0
for f in "$UPGRADES_DIR"/U*.sh; do
    [ -e "$f" ] || continue
    n=$(basename "$f" | sed -n 's/^U0*\([0-9][0-9]*\)_.*/\1/p')
    [ -n "$n" ] && [ "$n" -gt "$MAX_DELTA" ] && MAX_DELTA="$n"
done
out ""
out "ℹ️ Версия схемы: $SCHEMA_VER (в репо дельт до: U$(printf '%03d' "$MAX_DELTA"))"
if [ "$SCHEMA_VER" != "0" ] && [ -n "$SCHEMA_VER" ] && [ "$SCHEMA_VER" -lt "$MAX_DELTA" ]; then
    out "   → отставание: U$((SCHEMA_VER + 1))..U$(printf '%03d' "$MAX_DELTA") (запусти: bash upgrade.sh)"
fi

# --- 2. ТАБЛИЦЫ ---
out ""
out "📋 ТАБЛИЦЫ"
missing_t=0
while IFS='|' read -r mtitle; do
    [ -z "$mtitle" ] && continue
    found=$(q "$NOCO_DB" "SELECT COUNT(*) FROM nc_models_v2 WHERE title='$(esc "$mtitle")' AND table_name!='' AND table_name IS NOT NULL AND mm!=1;")
    if [ -z "$found" ] || [ "$found" -eq 0 ]; then
        missing_t=$((missing_t + 1))
        out "  ⚠️ [MISSING] таблица: $mtitle"
    fi
done < <(q "$TEMPLATE" "SELECT title FROM nc_models_v2 WHERE title NOT LIKE 'nc\_%' ESCAPE '\\' AND title != 'workspace' AND table_name!='' AND table_name IS NOT NULL AND mm!=1 ORDER BY title;")
[ "$missing_t" -eq 0 ] && out "  ✅ таблицы совпадают"


# --- 3. КОЛОНКИ ---
out ""
out "🗂  КОЛОНКИ"
missing_c=0
while IFS='|' read -r mtitle ctitle uidt; do
    [ -z "$mtitle" ] || [ -z "$ctitle" ] && continue
    found=$(q "$NOCO_DB" "SELECT COUNT(*) FROM nc_columns_v2 c JOIN nc_models_v2 m ON c.fk_model_id=m.id WHERE m.title='$(esc "$mtitle")' AND c.title='$(esc "$ctitle")' AND c.uidt IS NOT NULL;")
    if [ -z "$found" ] || [ "$found" -eq 0 ]; then
        missing_c=$((missing_c + 1))
        out "  ⚠️ [MISSING] колонка: $mtitle.$ctitle ($uidt)"
    fi
done < <(q "$TEMPLATE" "SELECT m.title, c.title, c.uidt FROM nc_columns_v2 c JOIN nc_models_v2 m ON c.fk_model_id=m.id WHERE m.title NOT LIKE 'nc\_%' ESCAPE '\\' AND m.title!='workspace' AND c.uidt IS NOT NULL AND c.title NOT IN ('Id','CreatedAt','UpdatedAt','nc_created_by','nc_updated_by') AND c.title NOT LIKE 'nc\_%' ESCAPE '\\' ORDER BY m.title, c.title;")
[ "$missing_c" -eq 0 ] && out "  ✅ колонки совпадают"

# --- 4. СЕЛЕКТЫ ---
out ""
out "🎨 СЕЛЕКТЫ (опции и цвета)"
sel_missing=0; sel_extra=0; sel_color=0
while IFS='|' read -r mtitle ctitle; do
    [ -z "$mtitle" ] || [ -z "$ctitle" ] && continue
    while IFS='|' read -r otitle ocolor; do
        [ -z "$otitle" ] && continue
        live=$(q "$NOCO_DB" "SELECT o.title||'|'||COALESCE(o.color,'') FROM nc_col_select_options_v2 o JOIN nc_columns_v2 c ON o.fk_column_id=c.id JOIN nc_models_v2 m ON c.fk_model_id=m.id WHERE m.title='$(esc "$mtitle")' AND c.title='$(esc "$ctitle")' AND o.title='$(esc "$otitle")' LIMIT 1;")
        if [ -z "$live" ]; then
            sel_missing=$((sel_missing + 1))
            out "  ⚠️ [MISSING] опция: $mtitle.$ctitle = «$otitle» (цвет $ocolor)"
        else
            live_color=$(echo "$live" | cut -d'|' -f2)
            if [ -n "$ocolor" ] && [ "$live_color" != "$ocolor" ]; then
                sel_color=$((sel_color + 1))
                out "  🟠 [COLOR] $mtitle.$ctitle «$otitle»: $live_color → $ocolor"
            fi
        fi
    done < <(q "$TEMPLATE" "SELECT o.title, o.color FROM nc_col_select_options_v2 o JOIN nc_columns_v2 c ON o.fk_column_id=c.id JOIN nc_models_v2 m ON c.fk_model_id=m.id WHERE m.title='$(esc "$mtitle")' AND c.title='$(esc "$ctitle")' ORDER BY o.rowid;")
    while IFS='|' read -r otitle; do
        [ -z "$otitle" ] && continue
        et=$(q "$TEMPLATE" "SELECT COUNT(*) FROM nc_col_select_options_v2 o JOIN nc_columns_v2 c ON o.fk_column_id=c.id JOIN nc_models_v2 m ON c.fk_model_id=m.id WHERE m.title='$(esc "$mtitle")' AND c.title='$(esc "$ctitle")' AND o.title='$(esc "$otitle")';")
        if [ -z "$et" ] || [ "$et" -eq 0 ]; then
            sel_extra=$((sel_extra + 1))
            out "  ℹ️ [EXTRA] опция клиента: $mtitle.$ctitle = «$otitle» (не трогаем)"
        fi
    done < <(q "$NOCO_DB" "SELECT o.title FROM nc_col_select_options_v2 o JOIN nc_columns_v2 c ON o.fk_column_id=c.id JOIN nc_models_v2 m ON c.fk_model_id=m.id WHERE m.title='$(esc "$mtitle")' AND c.title='$(esc "$ctitle")' ORDER BY o.rowid;")
done < <(q "$TEMPLATE" "SELECT m.title, c.title FROM nc_columns_v2 c JOIN nc_models_v2 m ON c.fk_model_id=m.id WHERE c.uidt IN ('SingleSelect','MultiSelect') AND m.title NOT LIKE 'nc\_%' ESCAPE '\\' AND m.title!='workspace' ORDER BY m.title, c.title;")
if [ "$sel_missing" -eq 0 ] && [ "$sel_extra" -eq 0 ] && [ "$sel_color" -eq 0 ]; then
    out "  ✅ селекты совпадают"
fi

# --- ИТОГ ---
out ""
out "═══════════════════════════════════════════════════════════"
out "📊 Итог: таблиц MISSING=$missing_t, колонок MISSING=$missing_c,"
out "        опций MISSING=$sel_missing, EXTRA=$sel_extra, COLOR=$sel_color"
if [ "$missing_c" -gt 0 ] || [ "$sel_missing" -gt 0 ]; then
    out "💡 Недостающее добавится дельтами: bash upgrade.sh --dry-run → bash upgrade.sh"
fi
out "═══════════════════════════════════════════════════════════"
