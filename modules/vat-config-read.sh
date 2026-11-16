#!/bin/bash
# ============================================================================
# modules/vat-config-read.sh — «Тип НДС» и «Ставка НДС» из «Мои реквизиты»
# ============================================================================
# Зачем. В SQLite имена колонок — с подчёркиванием (`Тип_НДС`, `Ставка_НДС`),
# а в UI NocoDB заголовки — с пробелом («Тип НДС», «Ставка НДС»). Запрос
# `SELECT "Тип НДС"` не падает: SQLite трактует неизвестный double-quoted
# identifier как СТРОКОВЫЙ ЛИТЕРАЛ и возвращает сам текст «Тип НДС». Из-за этого
# диагностика показывала ложное «Неизвестный Тип НДС → генерация ЗАБЛОКИРОВАНА»
# (на самом деле в базе было «Начисляется сверху» / 20).
#
# Поэтому колонку ищем по метаданным (title → column_name), а не по заголовку.
#
# Использование:
#   bash modules/vat-config-read.sh --db /path/noco.db
#   bash modules/vat-config-read.sh --db /path/noco.db --json
#   bash modules/vat-config-read.sh --db /path/noco.db --table "Мои реквизиты"
#
# Коды возврата:
#   0 — прочитано (значения могут быть пустыми — это штатно для свежей базы);
#   3 — база/таблица/колонки не найдены (вызывающий пропускает проверку);
#   2 — ошибка аргументов.
#
# Вывод по умолчанию: TYPE=<значение> и RATE=<значение> (по строке).
# ============================================================================
set -uo pipefail

DB=""
TABLE_TITLE="Мои реквизиты"
JSON=false

while [ $# -gt 0 ]; do
    case "$1" in
        --db) DB="${2:-}"; shift ;;
        --table) TABLE_TITLE="${2:-}"; shift ;;
        --json) JSON=true ;;
        -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "❌ Неизвестный аргумент: $1" >&2; exit 2 ;;
    esac
    shift
done

[ -n "$DB" ] && [ -f "$DB" ] || { echo "❌ база не найдена: ${DB:-<пусто>}" >&2; exit 3; }
command -v sqlite3 >/dev/null 2>&1 || { echo "❌ sqlite3 не установлен" >&2; exit 3; }

q() { sqlite3 "$DB" "$1" 2>/dev/null; }
# Идентификатор в кавычках: внутренние кавычки удваиваются (имена приходят из
# мета-схемы, но экранируем — правило безопасного SQL).
ident() { printf '"%s"' "$(printf '%s' "$1" | sed 's/"/""/g')"; }

MODEL_ID=$(q "SELECT id FROM nc_models_v2 WHERE title='$TABLE_TITLE' ORDER BY id LIMIT 1;")
[ -n "$MODEL_ID" ] || exit 3
TABLE_NAME=$(q "SELECT table_name FROM nc_models_v2 WHERE id='$MODEL_ID';")
[ -n "$TABLE_NAME" ] || exit 3

col_by_title() {
    q "SELECT column_name FROM nc_columns_v2 WHERE fk_model_id='$MODEL_ID' AND title='$1' LIMIT 1;"
}
TYPE_COL=$(col_by_title 'Тип НДС')
RATE_COL=$(col_by_title 'Ставка НДС')
[ -n "$TYPE_COL" ] && [ -n "$RATE_COL" ] || exit 3

VAT_TYPE=$(q "SELECT COALESCE($(ident "$TYPE_COL"),'') FROM $(ident "$TABLE_NAME") LIMIT 1;")
VAT_RATE=$(q "SELECT COALESCE($(ident "$RATE_COL"),'') FROM $(ident "$TABLE_NAME") LIMIT 1;")

if [ "$JSON" = true ]; then
    # jq безопасно собирает JSON (значения могут содержать кавычки/юникод).
    if command -v jq >/dev/null 2>&1; then
        jq -nc --arg t "$VAT_TYPE" --arg r "$VAT_RATE" '{type:$t, rate:$r}'
    else
        printf '{"type":"%s","rate":"%s"}\n' "$VAT_TYPE" "$VAT_RATE"
    fi
else
    printf 'TYPE=%s\nRATE=%s\n' "$VAT_TYPE" "$VAT_RATE"
fi
