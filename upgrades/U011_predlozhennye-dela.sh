#!/bin/bash
# upgrades/U011_predlozhennye-dela.sh
# v4.67.0: подпись связи «Делаs» → «Предложенные дела» в таблице «Сотрудники».
#
# Зачем: обратная связь к `Дела.Кто предложил` (дельта U006) создавалась с сырым
# именем «Делаs» — `add-link-m2o.sh` собирал подпись как «<таблица>» + «s»
# («Дела» + «s»). В UI это читалось как опечатка, а у парного поля на стороне
# «Дела» человеческое имя — «Кто предложил» → симметричное «Предложенные дела».
#
# ⚠️ Переименовать просто в «Дела» НЕЛЬЗЯ: в таблице «Сотрудники» это имя уже
# занято обратной связью `Дела.Исполнитель` (NocoDB не допускает дублей title
# в пределах таблицы). Дельта это проверяет и падает с понятной ошибкой.
#
# Что меняется: ТОЛЬКО метаданные колонки — `title` и `meta.plural/singular`.
# Не трогаются: физическая M2M-таблица (`nc_nw7q___nc_m2m_Дела_Сотрудники1`),
# связи (`nc_col_relations_v2`), данные «кто предложил», порядок/видимость колонок.
# В коде это поле по имени не читается: бот работает со стороной «Дела»
# (`task['Кто предложил']`), `shared/columns.js` адресует колонки по стабильным id.
#
# Идемпотентно: повторный запуск не делает ничего (колонка уже переименована).
# Кастомное имя, данное клиентом вручную, НЕ перетирается (уважаем правки клиента).
set -euo pipefail

NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_FILE="/mnt/data/nocodb-data/upgrade.log"

TABLE_TITLE="Сотрудники"
OLD_TITLE="Делаs"
NEW_TITLE="Предложенные дела"
NEW_SINGULAR="Предложенное дело"
COL_ID_REF="c7xldtfg1e2qds0"   # id колонки в эталоне template.db (свежие установки)

cd "$INSTALL_DIR"

echo "📦 U011: подпись связи «$OLD_TITLE» → «$NEW_TITLE» (таблица «$TABLE_TITLE»)"

[ -f "$NOCO_DB" ] || { echo "❌ База не найдена: $NOCO_DB" >&2; exit 1; }
command -v sqlite3 >/dev/null 2>&1 || { echo "❌ sqlite3 не установлен" >&2; exit 1; }

q() { sqlite3 "$NOCO_DB" ".timeout 5000" "$1" 2>/dev/null || true; }

log() {
    echo "$@"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE" 2>/dev/null || true
}

# ── 1. Таблица «Сотрудники» ──────────────────────────────────────────────────
EMP_MODEL=$(q "SELECT id FROM nc_models_v2 WHERE title='$TABLE_TITLE' AND table_name != '' AND table_name IS NOT NULL LIMIT 1;")
if [ -z "$EMP_MODEL" ]; then
    log "⚠️  Таблица «$TABLE_TITLE» не найдена — дельта пропущена (схема нестандартная?)"
    exit 0
fi

# ── 2. Колонка: якорь 1 — id из эталона, якорь 2 — старое имя в этой таблице ──
COL=$(q "SELECT id FROM nc_columns_v2 WHERE id='$COL_ID_REF' AND fk_model_id='$EMP_MODEL' LIMIT 1;")
if [ -z "$COL" ]; then
    COL=$(q "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$EMP_MODEL' AND title='$OLD_TITLE' AND uidt='LinkToAnotherRecord' LIMIT 1;")
fi

if [ -z "$COL" ]; then
    if [ -n "$(q "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$EMP_MODEL' AND title='$NEW_TITLE' LIMIT 1;")" ]; then
        log "✅ Колонка уже называется «$NEW_TITLE» — пропуск"
    else
        log "⚠️  Колонка «$OLD_TITLE» в «$TABLE_TITLE» не найдена — пропуск (нечего переименовывать)"
    fi
    exit 0
fi

CUR_TITLE=$(q "SELECT title FROM nc_columns_v2 WHERE id='$COL' LIMIT 1;")
if [ "$CUR_TITLE" = "$NEW_TITLE" ]; then
    log "✅ Колонка уже называется «$NEW_TITLE» — пропуск"
    exit 0
fi
if [ "$CUR_TITLE" != "$OLD_TITLE" ]; then
    log "⚠️  Колонка ($COL) названа клиентом «$CUR_TITLE» — имя не трогаем (правки клиента уважаем)"
    exit 0
fi

# ── 3. Защита от дубля title в таблице (NocoDB его не допускает) ──────────────
DUP=$(q "SELECT COUNT(*) FROM nc_columns_v2 WHERE fk_model_id='$EMP_MODEL' AND title='$NEW_TITLE' AND id != '$COL';")
if [ "${DUP:-0}" != "0" ]; then
    echo "❌ В таблице «$TABLE_TITLE» уже есть колонка «$NEW_TITLE» — переименование невозможно." >&2
    exit 1
fi

# ── 4. Контроль ДО: связь и данные «кто предложил» ───────────────────────────
MM_TABLE=$(q "SELECT m.table_name FROM nc_col_relations_v2 r JOIN nc_models_v2 m ON m.id = r.fk_mm_model_id WHERE r.fk_column_id='$COL' AND r.type='om' LIMIT 1;")
REL_BEFORE=$(q "SELECT COUNT(*) FROM nc_col_relations_v2 WHERE fk_column_id='$COL';")
if [ -n "$MM_TABLE" ]; then
    ROWS_BEFORE=$(q "SELECT COUNT(*) FROM \"$MM_TABLE\";")
else
    ROWS_BEFORE="-"
fi

# ── 5. Переименование (только метаданные, одна транзакция) ───────────────────
log "   ✏️  Переименовываю: title + meta.plural/singular..."
# ⚠️ .timeout — ВНУТРИ скрипта: sqlite3 с позиционным аргументом stdin НЕ читает
# (heredoc молча игнорируется → «тихий no-op»), поэтому dot-команды идут в stdin.
sqlite3 "$NOCO_DB" <<EOF
.timeout 5000
.bail on
BEGIN TRANSACTION;
UPDATE nc_columns_v2
   SET title = '$NEW_TITLE',
       meta = CASE
                WHEN meta IS NOT NULL AND json_valid(meta)
                     THEN json_set(meta, '\$.plural', '$NEW_TITLE', '\$.singular', '$NEW_SINGULAR')
                ELSE json_object('plural', '$NEW_TITLE', 'singular', '$NEW_SINGULAR')
              END,
       updated_at = datetime('now')
 WHERE id = '$COL';
COMMIT;
EOF

# ── 6. Контроль ПОСЛЕ: имя, связь, данные ────────────────────────────────────
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
    log "   🔗 Связь цела: junction=$MM_TABLE, связей=$REL_AFTER, строк «кто предложил»=$ROWS_AFTER"
fi

log "   🔄 NocoDB держит метаданные в памяти — нужен рестарт (upgrade.sh делает это сам)"
echo "✅ U011 завершена: «$TABLE_TITLE».«$OLD_TITLE» → «$NEW_TITLE»"
