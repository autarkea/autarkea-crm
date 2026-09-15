#!/bin/bash
# upgrades/U013_nastroyki-dokumentov-svyazi.sh
# v4.67.0: подписи обратных связей к «Настройки документов» в таблице «Сотрудники».
#
# Зачем: поля назывались «Документы общ. (Подписант|Кладовщик|Водитель)» — читается
# как «какие-то документы вообще» и путается с настоящими документами (там на стороне
# «Сотрудники» поля «Подписант документа» / «Кладовщик документа» / «Водитель документа»
# ссылаются на таблицу «Документы»). По смыслу же это обратные связи таблицы
# «Настройки документов» (дефолтные ответственные за печать), поэтому имя приведено
# к виду «Настройки документов (роль)».
#
# Что меняется: ТОЛЬКО метаданные колонки — `title` + `meta.plural/singular`.
# Не трогаются: физические junction-таблицы (`nc_nw7q___nc_m2m_Настройки докум_Сотрудники*`),
# связи (`nc_col_relations_v2`), данные, `column_name`, порядок/видимость колонок.
# В коде эти поля по имени НЕ читаются (`bot/server.js` берёт из «Настройки документов»
# только «Имя счета»/«Имя акта»; роли документов бот вообще не читает) — правка косметическая.
#
# Идемпотентно: уже переименованные колонки пропускаются. Кастомное имя, данное
# клиентом вручную, НЕ перетирается (правки клиента уважаем).
set -euo pipefail

NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_FILE="/mnt/data/nocodb-data/upgrade.log"

TABLE_TITLE="Сотрудники"
TARGET_TABLE="Настройки документов"   # связанная таблица → meta.plural/singular

# «id из эталона | старое имя | новое имя»
RENAMES=(
    "c5t0nwsjjo7ihbu|Документы общ. (Подписант)|Настройки документов (подписант)"
    "cif2mdteejco2tj|Документы общ. (Кладовщик)|Настройки документов (кладовщик)"
    "c41kehzxdd334tw|Документы общ. (Водитель)|Настройки документов (водитель)"
)

cd "$INSTALL_DIR"

echo "📦 U013: подписи связей «$TABLE_TITLE» ↔ «$TARGET_TABLE» (было «Документы общ. (…)»)"

[ -f "$NOCO_DB" ] || { echo "❌ База не найдена: $NOCO_DB" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "❌ sqlite3 не установлен" >&2; exit 1; }

q() { sqlite3 "$NOCO_DB" ".timeout 5000" "$1" 2>/dev/null || true; }

log() {
    echo "$@"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE" 2>/dev/null || true
}

EMP_MODEL=$(q "SELECT id FROM nc_models_v2 WHERE title='$TABLE_TITLE' AND table_name != '' AND table_name IS NOT NULL LIMIT 1;")
if [ -z "$EMP_MODEL" ]; then
    log "⚠️  Таблица «$TABLE_TITLE» не найдена — дельта пропущена (схема нестандартная?)"
    exit 0
fi

RENAMED=0
SKIPPED=0

# ── Переименование по списку: id-якорь → старое имя → новое имя ───────────────
for ITEM in "${RENAMES[@]}"; do
    IFS='|' read -r COL_ID_REF OLD_TITLE NEW_TITLE <<< "$ITEM"

    # Якорь 1 — id из эталона, якорь 2 — старое имя внутри таблицы
    COL=$(q "SELECT id FROM nc_columns_v2 WHERE id='$COL_ID_REF' AND fk_model_id='$EMP_MODEL' LIMIT 1;")
    if [ -z "$COL" ]; then
        COL=$(q "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$EMP_MODEL' AND title='$OLD_TITLE' AND uidt='LinkToAnotherRecord' LIMIT 1;")
    fi
    if [ -z "$COL" ]; then
        if [ -n "$(q "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$EMP_MODEL' AND title='$NEW_TITLE' LIMIT 1;")" ]; then
            log "   ✅ «$NEW_TITLE» — уже переименовано, пропуск"
        else
            log "   ⚠️  «$OLD_TITLE» не найдена — пропуск (нечего переименовывать)"
        fi
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    CUR_TITLE=$(q "SELECT title FROM nc_columns_v2 WHERE id='$COL' LIMIT 1;")
    if [ "$CUR_TITLE" = "$NEW_TITLE" ]; then
        log "   ✅ «$NEW_TITLE» — уже переименовано, пропуск"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi
    if [ "$CUR_TITLE" != "$OLD_TITLE" ]; then
        log "   ⚠️  Колонка ($COL) названа клиентом «$CUR_TITLE» — имя не трогаем (правки клиента уважаем)"
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    DUP=$(q "SELECT COUNT(*) FROM nc_columns_v2 WHERE fk_model_id='$EMP_MODEL' AND title='$NEW_TITLE' AND id != '$COL';")
    if [ "${DUP:-0}" != "0" ]; then
        echo "❌ В таблице «$TABLE_TITLE» уже есть колонка «$NEW_TITLE» — переименование невозможно." >&2
        exit 1
    fi

    # Контроль ДО: связь и данные junction
    MM_TABLE=$(q "SELECT m.table_name FROM nc_col_relations_v2 r JOIN nc_models_v2 m ON m.id = r.fk_mm_model_id WHERE r.fk_column_id='$COL' AND r.type='om' LIMIT 1;")
    REL_BEFORE=$(q "SELECT COUNT(*) FROM nc_col_relations_v2 WHERE fk_column_id='$COL';")
    if [ -n "$MM_TABLE" ]; then
        ROWS_BEFORE=$(q "SELECT COUNT(*) FROM \"$MM_TABLE\";")
    else
        ROWS_BEFORE="-"
    fi

    log "   ✏️  «$OLD_TITLE» → «$NEW_TITLE»"
    # ⚠️ dot-команды — ВНУТРЬ stdin: sqlite3 с позиционным аргументом stdin НЕ читает
    # (heredoc молча игнорируется → «тихий no-op», который set -e не ловит).
    sqlite3 "$NOCO_DB" <<EOF
.timeout 5000
.bail on
BEGIN TRANSACTION;
UPDATE nc_columns_v2
   SET title = '$NEW_TITLE',
       meta = CASE
                WHEN meta IS NOT NULL AND json_valid(meta)
                     THEN json_set(meta, '\$.plural', '$TARGET_TABLE', '\$.singular', '$TARGET_TABLE')
                ELSE json_object('plural', '$TARGET_TABLE', 'singular', '$TARGET_TABLE')
              END,
       updated_at = datetime('now')
 WHERE id = '$COL';
COMMIT;
EOF

    # Контроль ПОСЛЕ: имя, связь, данные
    NEW_READ=$(q "SELECT title FROM nc_columns_v2 WHERE id='$COL' LIMIT 1;")
    if [ "$NEW_READ" != "$NEW_TITLE" ]; then
        echo "❌ Переименование не применилось (title='$NEW_READ')" >&2
        exit 1
    fi
    REL_AFTER=$(q "SELECT COUNT(*) FROM nc_col_relations_v2 WHERE fk_column_id='$COL';")
    if [ "$REL_AFTER" != "$REL_BEFORE" ]; then
        echo "❌ Связь пострадала: relations было $REL_BEFORE, стало $REL_AFTER" >&2
        exit 1
    fi
    if [ -n "$MM_TABLE" ]; then
        ROWS_AFTER=$(q "SELECT COUNT(*) FROM \"$MM_TABLE\";")
        if [ "$ROWS_AFTER" != "$ROWS_BEFORE" ]; then
            echo "❌ Данные связи пострадали: строк было $ROWS_BEFORE, стало $ROWS_AFTER" >&2
            exit 1
        fi
    fi
    RENAMED=$((RENAMED + 1))
done

log "   ✅ Переименовано: $RENAMED, пропущено: $SKIPPED"
log "   🔄 NocoDB держит метаданные в памяти — нужен рестарт (upgrade.sh делает это сам)"
echo "✅ U013 завершена"
