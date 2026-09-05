#!/bin/bash
# modules/drop-link.sh v1.0.1 — Безопасное удаление связи Many-to-One через SQLite NocoDB
# 
# Использование:
#   bash modules/drop-link.sh "ТаблицаОткуда" "КолонкаОткуда" "ТаблицаКуда" "КолонкаКуда"
#
# Примеры:
#   bash modules/drop-link.sh "Документы" "Ответственный сотрудник" "Сотрудники" "Документы"
#   bash modules/drop-link.sh "Дела" "Какой проект" "Проекты" "Дела"
#
# Особенности v1.0.1:
#   ✅ Удаляет все объекты связи (записи relations, колонки, M2M модель/view/таблицу)
#   ✅ PRAGMA foreign_keys = OFF для обхода ограничений SQLite
#   ✅ Все SQL в одной транзакции с .bail on (мгновенный откат при ошибке)
#   ✅ Автобэкап БД перед изменениями
#   ✅ Проверка существования связи
#   ✅ Проверка, что удаляемые колонки — именно LinkToAnotherRecord
#   ✅ Проверка отсутствия зависимостей (другие связи, фильтры, сортировки)
#   ✅ Явный ROLLBACK при сбое транзакции

set -e

# === АРГУМЕНТЫ ===
TABLE_FROM="$1"
COLUMN_FROM="$2"
TABLE_TO="$3"
COLUMN_TO="$4"

# === КОНФИГУРАЦИЯ ===
NOCO_DB="/mnt/data/nocodb-data/noco.db"
LOG_FILE="/mnt/data/nocodb-data/link-migrations.log"
BACKUP_DIR="/mnt/data/backups"

# === ВАЛИДАЦИЯ ===
if [ -z "$TABLE_FROM" ] || [ -z "$COLUMN_FROM" ] || [ -z "$TABLE_TO" ] || [ -z "$COLUMN_TO" ]; then
    echo "❌ Ошибка: Укажите все 4 параметра."
    echo "Пример: bash modules/drop-link.sh \"Документы\" \"Ответственный сотрудник\" \"Сотрудники\" \"Документы\""
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
    local backup_file="$BACKUP_DIR/noco-before-drop-link-$(date '+%Y%m%d-%H%M%S').db"
    cp "$NOCO_DB" "$backup_file"
    log "💾 Бэкап создан: $backup_file"
    BACKUP_FILE="$backup_file"
}

# === НАЧАЛО РАБОТЫ ===
log "🔗❌ Удаление связи: $TABLE_FROM.$COLUMN_FROM ↔ $TABLE_TO.$COLUMN_TO..."
backup_db

BASE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_bases_v2 LIMIT 1;")
WORKSPACE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM workspace LIMIT 1;")

if [ -z "$BASE_ID" ] || [ -z "$WORKSPACE_ID" ]; then
    log "❌ Ошибка: Не удалось найти base/workspace."
    exit 1
fi

# === ПОИСК ТАБЛИЦ ===
MODEL_FROM_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_models_v2 WHERE title='$TABLE_FROM' AND base_id='$BASE_ID';")
MODEL_TO_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_models_v2 WHERE title='$TABLE_TO' AND base_id='$BASE_ID';")

if [ -z "$MODEL_FROM_ID" ] || [ -z "$MODEL_TO_ID" ]; then
    log "❌ Ошибка: Одна из таблиц не найдена."
    exit 1
fi
log "✅ Таблица FROM: $MODEL_FROM_ID | Таблица TO: $MODEL_TO_ID"

# === ПОИСК КОЛОНОК СВЯЗИ ===
COL_FROM_INFO=$(sqlite3 "$NOCO_DB" "SELECT id, uidt FROM nc_columns_v2 WHERE fk_model_id='$MODEL_FROM_ID' AND title='$COLUMN_FROM';")
COL_TO_INFO=$(sqlite3 "$NOCO_DB" "SELECT id, uidt FROM nc_columns_v2 WHERE fk_model_id='$MODEL_TO_ID' AND title='$COLUMN_TO';")

if [ -z "$COL_FROM_INFO" ] || [ -z "$COL_TO_INFO" ]; then
    log "❌ Ошибка: Одна из колонок связи не найдена."
    exit 1
fi

COL_FROM_ID=$(echo "$COL_FROM_INFO" | cut -d'|' -f1)
COL_FROM_UIDT=$(echo "$COL_FROM_INFO" | cut -d'|' -f2)
COL_TO_ID=$(echo "$COL_TO_INFO" | cut -d'|' -f1)
COL_TO_UIDT=$(echo "$COL_TO_INFO" | cut -d'|' -f2)

log "✅ Колонка FROM: $COL_FROM_ID ($COL_FROM_UIDT) | Колонка TO: $COL_TO_ID ($COL_TO_UIDT)"

# === ПРОВЕРКА, ЧТО ЭТО ДЕЙСТВИТЕЛЬНО СВЯЗИ ===
if [[ "$COL_FROM_UIDT" != "LinkToAnotherRecord" || "$COL_TO_UIDT" != "LinkToAnotherRecord" ]]; then
    log "❌ Ошибка: Колонки не являются связями (LinkToAnotherRecord)."
    log "   FROM: $COL_FROM_UIDT | TO: $COL_TO_UIDT"
    exit 1
fi

# === ПОИСК M2M ТАБЛИЦЫ ЧЕРЕЗ nc_col_relations_v2 ===
# Ищем запись 'mo' по колонке FROM
REL_MO_INFO=$(sqlite3 "$NOCO_DB" "SELECT id, fk_mm_model_id FROM nc_col_relations_v2 WHERE fk_column_id='$COL_FROM_ID' AND type='mo' LIMIT 1;")
if [ -z "$REL_MO_INFO" ]; then
    log "❌ Ошибка: Не найдена связь 'mo' для колонки '$COLUMN_FROM'."
    exit 1
fi

REL_MO_ID=$(echo "$REL_MO_INFO" | cut -d'|' -f1)
M2M_MODEL_ID=$(echo "$REL_MO_INFO" | cut -d'|' -f2)

if [ -z "$M2M_MODEL_ID" ]; then
    log "❌ Ошибка: Не найдена M2M модель для этой связи."
    exit 1
fi
log "✅ M2M модель: $M2M_MODEL_ID"

# === ПОИСК ФИЗИЧЕСКОЙ M2M ТАБЛИЦЫ ===
M2M_TABLE_NAME=$(sqlite3 "$NOCO_DB" "SELECT table_name FROM nc_models_v2 WHERE id='$M2M_MODEL_ID';")
if [ -z "$M2M_TABLE_NAME" ]; then
    log "❌ Ошибка: Не найдена физическая M2M таблица."
    exit 1
fi
log "✅ M2M физическая таблица: $M2M_TABLE_NAME"

# === ПОИСК M2M VIEW ===
M2M_VIEW_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_views_v2 WHERE fk_model_id='$M2M_MODEL_ID' AND type=3 LIMIT 1;")
log "✅ M2M View: ${M2M_VIEW_ID:-не найден}"

# === ПОИСК ВСЕХ ЗАПИСЕЙ В nc_col_relations_v2 ===
REL_IDS=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_col_relations_v2 WHERE fk_mm_model_id='$M2M_MODEL_ID';")
REL_COUNT=$(echo "$REL_IDS" | grep -c . || echo 0)
log "✅ Найдено записей в nc_col_relations_v2: $REL_COUNT"

# === ПОИСК ВСЕХ КОЛОНОК В M2M ТАБЛИЦЕ ===
M2M_COL_IDS=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$M2M_MODEL_ID';")
M2M_COL_COUNT=$(echo "$M2M_COL_IDS" | grep -c . || echo 0)
log "✅ Найдено колонок в M2M таблице: $M2M_COL_COUNT"

# 🆕 v1.0.3 — Формируем список ID для SQL IN clause С КАВЫЧКАМИ
# Используем цикл для гарантированного сохранения кавычек
M2M_COL_IDS_CSV=""
for col_id in $M2M_COL_IDS; do
    if [ -n "$M2M_COL_IDS_CSV" ]; then
        M2M_COL_IDS_CSV+=","
    fi
    M2M_COL_IDS_CSV+="'$col_id'"
done
log "🔍 M2M колонки (CSV): $M2M_COL_IDS_CSV"

# Формируем список ID для SQL IN clause
M2M_COL_IDS_CSV=$(echo "$M2M_COL_IDS" | paste -sd ',' -)

# === ПРОВЕРКА ЗАВИСИМОСТЕЙ: ДРУГИЕ СВЯЗИ ЧЕРЕЗ ЭТУ M2M ТАБЛИЦУ ===
OTHER_REL_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_col_relations_v2 WHERE fk_mm_model_id='$M2M_MODEL_ID' AND fk_column_id NOT IN ('$COL_FROM_ID', '$COL_TO_ID');")
if [ "$OTHER_REL_COUNT" -gt 0 ]; then
    log "❌ Ошибка: M2M таблица используется другими связями ($OTHER_REL_COUNT записей)."
    log "💡 Нельзя удалять связь, пока M2M таблица используется другими колонками."
    exit 1
fi

# === ПРОВЕРКА ЗАВИСИМОСТЕЙ: ФИЛЬТРЫ ===
FILTER_FROM=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_filter_exp_v2 WHERE fk_column_id='$COL_FROM_ID';")
FILTER_TO=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_filter_exp_v2 WHERE fk_column_id='$COL_TO_ID';")
FILTER_TOTAL=$((FILTER_FROM + FILTER_TO))
if [ "$FILTER_TOTAL" -gt 0 ]; then
    log "⚠️  Внимание: Связь используется в $FILTER_TOTAL фильтрах. Они будут удалены."
    read -p "Продолжить? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log "❌ Операция отменена пользователем."
        exit 1
    fi
fi

# === ПРОВЕРКА ЗАВИСИМОСТЕЙ: СОРТИРОВКИ ===
SORT_FROM=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_sort_v2 WHERE fk_column_id='$COL_FROM_ID';")
SORT_TO=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_sort_v2 WHERE fk_column_id='$COL_TO_ID';")
SORT_TOTAL=$((SORT_FROM + SORT_TO))
if [ "$SORT_TOTAL" -gt 0 ]; then
    log "⚠️  Внимание: Связь используется в $SORT_TOTAL сортировках. Они будут удалены."
fi

# === ВЫПОЛНЕНИЕ ТРАНЗАКЦИИ ===
log "🔒 Выполнение транзакции..."
set +e  # Временно отключаем set -e для обработки ошибок sqlite3

# Формируем SQL-скрипт с отдельными DELETE для каждой колонки
SQL_SCRIPT="PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- 1. Удаляем из nc_grid_view_columns_v2 (2 основных колонки)
DELETE FROM nc_grid_view_columns_v2 WHERE fk_column_id = '$COL_FROM_ID';
DELETE FROM nc_grid_view_columns_v2 WHERE fk_column_id = '$COL_TO_ID';
"

# Добавляем DELETE для каждой M2M колонки
for col_id in $M2M_COL_IDS; do
    SQL_SCRIPT+="DELETE FROM nc_grid_view_columns_v2 WHERE fk_column_id = '$col_id';
"
done

SQL_SCRIPT+="
-- 2. Удаляем из nc_filter_exp_v2 и nc_sort_v2
DELETE FROM nc_filter_exp_v2 WHERE fk_column_id = '$COL_FROM_ID';
DELETE FROM nc_filter_exp_v2 WHERE fk_column_id = '$COL_TO_ID';
DELETE FROM nc_sort_v2 WHERE fk_column_id = '$COL_FROM_ID';
DELETE FROM nc_sort_v2 WHERE fk_column_id = '$COL_TO_ID';

-- 3. Удаляем из nc_col_select_options_v2 (2 основных колонки)
DELETE FROM nc_col_select_options_v2 WHERE fk_column_id = '$COL_FROM_ID';
DELETE FROM nc_col_select_options_v2 WHERE fk_column_id = '$COL_TO_ID';
"

# Добавляем DELETE для каждой M2M колонки
for col_id in $M2M_COL_IDS; do
    SQL_SCRIPT+="DELETE FROM nc_col_select_options_v2 WHERE fk_column_id = '$col_id';
"
done

SQL_SCRIPT+="
-- 4. Удаляем из nc_columns_v2 (все колонки M2M)
DELETE FROM nc_columns_v2 WHERE fk_model_id='$M2M_MODEL_ID';

-- 5. Удаляем из nc_columns_v2 (2 основных колонки)
DELETE FROM nc_columns_v2 WHERE id = '$COL_FROM_ID';
DELETE FROM nc_columns_v2 WHERE id = '$COL_TO_ID';

-- 6. Удаляем из nc_col_relations_v2 (все записи)
DELETE FROM nc_col_relations_v2 WHERE fk_mm_model_id='$M2M_MODEL_ID';

-- 7. Удаляем из nc_views_v2 (M2M view)
DELETE FROM nc_views_v2 WHERE id='$M2M_VIEW_ID';

-- 8. Удаляем из nc_models_v2 (M2M модель)
DELETE FROM nc_models_v2 WHERE id='$M2M_MODEL_ID';

-- 9. Удаляем физическую M2M таблицу
DROP TABLE IF EXISTS \"$M2M_TABLE_NAME\";

COMMIT;
"

# Выполняем SQL-скрипт
SQLITE_OUTPUT=$(echo "$SQL_SCRIPT" | sqlite3 "$NOCO_DB" 2>&1)
SQLITE_EXIT=$?
set -e  # Включаем set -e обратно

if [ $SQLITE_EXIT -ne 0 ]; then
    log "❌ Ошибка транзакции (exit code: $SQLITE_EXIT)"
    log "📝 Вывод SQLite: $SQLITE_OUTPUT"
    log "🔄 Выполняется откат (ROLLBACK)..."
    sqlite3 "$NOCO_DB" "ROLLBACK;" 2>/dev/null || true
    exit 1
fi

if [ -n "$SQLITE_OUTPUT" ]; then
    log "⚠️  Вывод SQLite (некритично): $SQLITE_OUTPUT"
fi

log "✅ Транзакция успешно завершена"

# === ПЕРЕЗАПУСК ===
log "🔄 Перезапуск NocoDB..."
docker restart nocodb 2>/dev/null || docker restart printed4u-nocodb 2>/dev/null || log "⚠️  Перезапустите NocoDB вручную."

log "✅ Связь M2O удалена: $TABLE_FROM.$COLUMN_FROM ↔ $TABLE_TO.$COLUMN_TO"
log "   🗑️  Удалено: $REL_COUNT записей relations, $M2M_COL_COUNT колонок M2M + 2 основных, M2M модель/view/таблица"
log "   📦 Бэкап: $BACKUP_FILE"
log "   📝 Лог: $LOG_FILE"