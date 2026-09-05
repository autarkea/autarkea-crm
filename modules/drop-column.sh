#!/bin/bash
# modules/drop-column.sh v1.0.3 — Безопасное удаление колонки через SQLite NocoDB
# 
# Использование:
#   bash modules/drop-column.sh "ИмяТаблицы" "ИмяКолонки"
#
# Примеры:
#   bash modules/drop-column.sh "Проекты" "Тестовое поле"
#   bash modules/drop-column.sh "Дела" "Приоритет"
#   SKIP_RESTART=1 bash modules/drop-column.sh "Дела" "Тест"  # без перезапуска NocoDB
#
# Особенности v1.0.3:
#   ✅ Абсолютная защита от удаления Primary Key (uidt='ID' или column_name='id')
#   ✅ Защита от удаления системных колонок (system='1')
#   ✅ Защита от удаления Primary Value колонки
#   ✅ .bail on в SQLite для мгновенного прерывания при любой ошибке
#   ✅ Явный ROLLBACK при сбое транзакции
#   ✅ Автобэкап БД перед изменениями
#   ✅ Очистка всех зависимостей (Grid View, Select Options, Filters, Sorts)
#   🆕 v1.0.2: Нормализация order после удаления (закрытие "дыр" в последовательности)
#   🆕 v1.0.3: Флаг SKIP_RESTART для пропуска перезапуска NocoDB

set -e

# === АРГУМЕНТЫ ===
TABLE_TITLE="$1"
COLUMN_TITLE="$2"

# === КОНФИГУРАЦИЯ ===
NOCO_DB="/mnt/data/nocodb-data/noco.db"
LOG_FILE="/mnt/data/nocodb-data/column-migrations.log"
BACKUP_DIR="/mnt/data/backups"

# === ВАЛИДАЦИЯ ===
if [ -z "$TABLE_TITLE" ] || [ -z "$COLUMN_TITLE" ]; then
    echo "❌ Ошибка: Укажите имя таблицы и имя колонки."
    echo "Пример: bash modules/drop-column.sh \"Проекты\" \"Тестовое поле\""
    exit 1
fi

if [ ! -f "$NOCO_DB" ]; then
    echo "❌ Ошибка: Файл БД не найден: $NOCO_DB"
    exit 1
fi

# === ЛОГИРОВАНИЕ ===
log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$msg"
    echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
}

# === АВТОБЭКАП ===
backup_db() {
    mkdir -p "$BACKUP_DIR"
    local backup_file="$BACKUP_DIR/noco-before-drop-$(date '+%Y%m%d-%H%M%S').db"
    cp "$NOCO_DB" "$backup_file"
    log "💾 Бэкап создан: $backup_file"
    BACKUP_FILE="$backup_file"
}

# === НАЧАЛО РАБОТЫ ===
log "🗑️  Удаление колонки '$COLUMN_TITLE' из таблицы '$TABLE_TITLE'..."
backup_db

BASE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_bases_v2 LIMIT 1;")
SOURCE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_sources_v2 WHERE base_id='$BASE_ID' LIMIT 1;")
WORKSPACE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM workspace LIMIT 1;")

if [ -z "$BASE_ID" ] || [ -z "$SOURCE_ID" ] || [ -z "$WORKSPACE_ID" ]; then
    log "❌ Ошибка: Не удалось найти base/source/workspace."
    exit 1
fi

MODEL_INFO=$(sqlite3 "$NOCO_DB" "SELECT id, table_name FROM nc_models_v2 WHERE title='$TABLE_TITLE' AND base_id='$BASE_ID';")
if [ -z "$MODEL_INFO" ]; then
    log "❌ Ошибка: Таблица '$TABLE_TITLE' не найдена."
    exit 1
fi
MODEL_ID=$(echo "$MODEL_INFO" | cut -d'|' -f1)
PHYSICAL_TABLE=$(echo "$MODEL_INFO" | cut -d'|' -f2)

# === ПОИСК И ПРОВЕРКА КОЛОНКИ ===
COLUMN_INFO=$(sqlite3 "$NOCO_DB" "SELECT id, column_name, uidt, system FROM nc_columns_v2 WHERE fk_model_id='$MODEL_ID' AND (title='$COLUMN_TITLE' OR column_name='$COLUMN_TITLE');")
if [ -z "$COLUMN_INFO" ]; then
    log "❌ Ошибка: Колонка '$COLUMN_TITLE' не найдена в таблице '$TABLE_TITLE'."
    exit 1
fi

COLUMN_ID=$(echo "$COLUMN_INFO" | cut -d'|' -f1)
COLUMN_NAME=$(echo "$COLUMN_INFO" | cut -d'|' -f2)
COLUMN_UIDT=$(echo "$COLUMN_INFO" | cut -d'|' -f3)
COLUMN_SYSTEM=$(echo "$COLUMN_INFO" | cut -d'|' -f4)

log "✅ Колонка найдена: ID=$COLUMN_ID, name=$COLUMN_NAME, type=$COLUMN_UIDT, system=$COLUMN_SYSTEM"

# === 🔒 АБСОЛЮТНАЯ ЗАЩИТА ОТ УДАЛЕНИЯ PK И СИСТЕМНЫХ КОЛОНОК ===
if [[ "$COLUMN_UIDT" == "ID" || "$COLUMN_NAME" == "id" || "$COLUMN_SYSTEM" == "1" ]]; then
    log "❌ Ошибка: Нельзя удалять Primary Key или системную колонку '$COLUMN_TITLE'."
    log "💡 Это критически важно для целостности базы данных."
    exit 1
fi

# === ЗАЩИТА ОТ УДАЛЕНИЯ PRIMARY VALUE ===
PV_CHECK=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_columns_v2 WHERE id='$COLUMN_ID' AND pv=1;")
if [ "$PV_CHECK" -gt 0 ]; then
    log "❌ Ошибка: Нельзя удалять колонку '$COLUMN_TITLE' — она является Primary Value."
    exit 1
fi

# === ГЕНЕРАЦИЯ SQL ДЛЯ УДАЛЕНИЯ ===
GV_DELETE="DELETE FROM nc_grid_view_columns_v2 WHERE fk_column_id='$COLUMN_ID';"

SO_DELETE=""
if [[ "$COLUMN_UIDT" == "SingleSelect" || "$COLUMN_UIDT" == "MultiSelect" ]]; then
    SO_DELETE="DELETE FROM nc_col_select_options_v2 WHERE fk_column_id='$COLUMN_ID';"
    log "🎨 Будут удалены опции Select/MultiSelect"
fi

FILTER_DELETE="DELETE FROM nc_filter_exp_v2 WHERE fk_column_id='$COLUMN_ID';"
SORT_DELETE="DELETE FROM nc_sort_v2 WHERE fk_column_id='$COLUMN_ID';"
COL_DELETE="DELETE FROM nc_columns_v2 WHERE id='$COLUMN_ID';"

# === ВЫПОЛНЕНИЕ ТРАНЗАКЦИИ С .bail on ===
log "🔒 Выполнение транзакции..."
set +e
SQLITE_OUTPUT=$(sqlite3 "$NOCO_DB" 2>&1 <<EOF
.bail on
BEGIN TRANSACTION;

$GV_DELETE
$SO_DELETE
$FILTER_DELETE
$SORT_DELETE
$COL_DELETE

ALTER TABLE "$PHYSICAL_TABLE" DROP COLUMN "$COLUMN_NAME";

COMMIT;
EOF
)
SQLITE_EXIT=$?
set -e

if [ $SQLITE_EXIT -ne 0 ]; then
    log "❌ Ошибка транзакции: $SQLITE_OUTPUT"
    log "🔄 Выполняется откат (ROLLBACK)..."
    sqlite3 "$NOCO_DB" "ROLLBACK;" 2>/dev/null || true
    exit 1
fi

log "✅ Транзакция успешно завершена"

# ============================================
# 🆕 v1.0.2: НОРМАЛИЗАЦИЯ ORDER
# ============================================
# После удаления колонки в nc_grid_view_columns_v2 и nc_columns_v2
# остаётся "дыра" в последовательности order. Нормализуем, чтобы
# порядок был чистым (1, 2, 3...) и не было дубликатов.

# Нормализация order в nc_grid_view_columns_v2 для всех grid views модели
log "📐 Нормализация order в grid views..."
GRID_VIEW_IDS=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_views_v2 WHERE fk_model_id='$MODEL_ID' AND type=3;")

if [ -n "$GRID_VIEW_IDS" ]; then
    echo "$GRID_VIEW_IDS" | while IFS= read -r VIEW_ID; do
        if [ -n "$VIEW_ID" ]; then
            sqlite3 "$NOCO_DB" "
            DROP TABLE IF EXISTS tmp_norm_gv;
            CREATE TEMP TABLE tmp_norm_gv AS
            SELECT id, ROW_NUMBER() OVER (PARTITION BY fk_view_id ORDER BY \"order\", id) as new_order
            FROM nc_grid_view_columns_v2
            WHERE fk_view_id = '$VIEW_ID';
            UPDATE nc_grid_view_columns_v2
            SET \"order\" = (SELECT new_order FROM tmp_norm_gv WHERE tmp_norm_gv.id = nc_grid_view_columns_v2.id)
            WHERE fk_view_id = '$VIEW_ID';
            DROP TABLE IF EXISTS tmp_norm_gv;
            " 2>/dev/null || true
        fi
    done
    log "   ✅ order нормализован в grid views"
fi

# Нормализация order в nc_columns_v2
log "📐 Нормализация order в nc_columns_v2..."
sqlite3 "$NOCO_DB" "
DROP TABLE IF EXISTS tmp_norm_col;
CREATE TEMP TABLE tmp_norm_col AS
SELECT id, ROW_NUMBER() OVER (PARTITION BY fk_model_id ORDER BY \"order\", id) as new_order
FROM nc_columns_v2
WHERE fk_model_id = '$MODEL_ID';
UPDATE nc_columns_v2
SET \"order\" = (SELECT new_order FROM tmp_norm_col WHERE tmp_norm_col.id = nc_columns_v2.id)
WHERE fk_model_id = '$MODEL_ID';
DROP TABLE IF EXISTS tmp_norm_col;
" 2>/dev/null || true

log "✅ order нормализован"

# === ПЕРЕЗАПУСК (с возможностью пропуска) ===
if [ "${SKIP_RESTART:-0}" != "1" ]; then
    log "🔄 Перезапуск NocoDB..."
    docker restart nocodb 2>/dev/null || docker restart printed4u-nocodb 2>/dev/null || log "⚠️  Перезапустите NocoDB вручную."
else
    log "⏭️  Пропуск перезапуска (SKIP_RESTART=1)"
fi

log "✅ Колонка '$COLUMN_TITLE' ($COLUMN_UIDT) безопасно удалена из '$TABLE_TITLE'!"
log "   📦 Бэкап: $BACKUP_FILE"
log "   📝 Лог: $LOG_FILE"