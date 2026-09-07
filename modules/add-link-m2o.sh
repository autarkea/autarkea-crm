#!/bin/bash
# modules/add-link-m2o.sh v1.0.0 — Создание связи Many-to-One через прямой доступ к SQLite NocoDB
# 
# Использование:
#   bash modules/add-link-m2o.sh "ТаблицаОткуда" "КолонкаОткуда" "ТаблицаКуда" "КолонкаКуда"
#
# Примеры:
#   bash modules/add-link-m2o.sh "Дела" "Какой проект" "Проекты" "Дела"
#   bash modules/add-link-m2o.sh "Документы" "Проект" "Проекты" "Документы"
#   bash modules/add-link-m2o.sh "Контакты" "Организация" "Юрлица" "Контакты"
#
# Особенности v1.0.0:
#   ✅ Создаёт полную связь M2O с промежуточной M2M таблицей (как это делает NocoDB)
#   ✅ Все SQL в одной транзакции с .bail on (мгновенный откат при ошибке)
#   ✅ Автобэкап БД перед изменениями
#   ✅ Безопасный поиск Primary Key (title='Id' AND uidt='ID' AND ai=1)
#   ✅ Проверка отсутствия дубликатов колонок
#   ✅ Создание физической M2M таблицы и её модели (с флагом mm=1)
#   ✅ Создание 4 колонок в M2M (2 ForeignKey + 2 LinkToAnotherRecord)
#   ✅ Создание Grid View для M2M таблицы
#   ✅ Создание 2 колонок LinkToAnotherRecord в основных таблицах
#   ✅ Создание 4 записей в nc_col_relations_v2 (mo, om, hm, hm)

set -e

# === АРГУМЕНТЫ ===
TABLE_FROM="$1"
COLUMN_FROM="$2"
TABLE_TO="$3"
COLUMN_TO="$4"

# === КОНФИГУРАЦИЯ ===
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
LOG_FILE="/mnt/data/nocodb-data/link-migrations.log"
BACKUP_DIR="/mnt/data/backups"

# === ВАЛИДАЦИЯ ===
if [ -z "$TABLE_FROM" ] || [ -z "$COLUMN_FROM" ] || [ -z "$TABLE_TO" ] || [ -z "$COLUMN_TO" ]; then
    echo "❌ Ошибка: Укажите все 4 параметра."
    echo "Пример: bash modules/add-link-m2o.sh \"Дела\" \"Какой проект\" \"Проекты\" \"Дела\""
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
    local backup_file="$BACKUP_DIR/noco-before-link-$(date '+%Y%m%d-%H%M%S').db"
    cp "$NOCO_DB" "$backup_file"
    log "💾 Бэкап создан: $backup_file"
    BACKUP_FILE="$backup_file"
}

# === ГЕНЕРАЦИЯ ID (15 символов, как в NocoDB) ===
gen_id() {
    head /dev/urandom | tr -dc 'a-z0-9' | fold -w 15 | head -n 1
}

# === НАЧАЛО РАБОТЫ ===
log "🔗 Создание связи M2O: $TABLE_FROM.$COLUMN_FROM ↔ $TABLE_TO.$COLUMN_TO..."
backup_db

BASE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_bases_v2 LIMIT 1;")
SOURCE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_sources_v2 WHERE base_id='$BASE_ID' LIMIT 1;")
WORKSPACE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM workspace LIMIT 1;")

if [ -z "$BASE_ID" ] || [ -z "$SOURCE_ID" ] || [ -z "$WORKSPACE_ID" ]; then
    log "❌ Ошибка: Не удалось найти base/source/workspace."
    exit 1
fi

# === ПОЛУЧЕНИЕ ИНФОРМАЦИИ О ТАБЛИЦАХ ===
MODEL_FROM_INFO=$(sqlite3 "$NOCO_DB" "SELECT id, table_name FROM nc_models_v2 WHERE title='$TABLE_FROM' AND base_id='$BASE_ID';")
if [ -z "$MODEL_FROM_INFO" ]; then
    log "❌ Ошибка: Таблица '$TABLE_FROM' не найдена."
    exit 1
fi
MODEL_FROM_ID=$(echo "$MODEL_FROM_INFO" | cut -d'|' -f1)
TABLE_FROM_PHYS=$(echo "$MODEL_FROM_INFO" | cut -d'|' -f2)

MODEL_TO_INFO=$(sqlite3 "$NOCO_DB" "SELECT id, table_name FROM nc_models_v2 WHERE title='$TABLE_TO' AND base_id='$BASE_ID';")
if [ -z "$MODEL_TO_INFO" ]; then
    log "❌ Ошибка: Таблица '$TABLE_TO' не найдена."
    exit 1
fi
MODEL_TO_ID=$(echo "$MODEL_TO_INFO" | cut -d'|' -f1)
TABLE_TO_PHYS=$(echo "$MODEL_TO_INFO" | cut -d'|' -f2)

log "✅ Таблица FROM: $MODEL_FROM_ID ($TABLE_FROM_PHYS)"
log "✅ Таблица TO: $MODEL_TO_ID ($TABLE_TO_PHYS)"

# === ПОЛУЧЕНИЕ ID КОЛОНОК Id (Primary Key) ===
# Исправление: ищем строго по title='Id' AND uidt='ID' AND ai=1 (избегаем дубликатов)
ID_COL_FROM=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$MODEL_FROM_ID' AND title='Id' AND uidt='ID' AND ai=1 LIMIT 1;")
ID_COL_TO=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$MODEL_TO_ID' AND title='Id' AND uidt='ID' AND ai=1 LIMIT 1;")

if [ -z "$ID_COL_FROM" ] || [ -z "$ID_COL_TO" ]; then
    log "❌ Ошибка: Не удалось найти Primary Key колонки (title='Id' AND uidt='ID' AND ai=1)."
    exit 1
fi
log "✅ PK FROM: $ID_COL_FROM | PK TO: $ID_COL_TO"

# === ПРОВЕРКА СУЩЕСТВОВАНИЯ КОЛОНОК ===
EXISTING_FROM=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$MODEL_FROM_ID' AND title='$COLUMN_FROM';")
if [ -n "$EXISTING_FROM" ]; then
    log "⚠️  Колонка '$COLUMN_FROM' уже существует в '$TABLE_FROM'. Пропускаем."
    exit 0
fi

EXISTING_TO=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$MODEL_TO_ID' AND title='$COLUMN_TO';")
if [ -n "$EXISTING_TO" ]; then
    log "⚠️  Колонка '$COLUMN_TO' уже существует в '$TABLE_TO'. Пропускаем."
    exit 0
fi

# === ГЕНЕРАЦИЯ ID ДЛЯ ВСЕХ ОБЪЕКТОВ ===
M2M_MODEL_ID=$(gen_id)
M2M_VIEW_ID=$(gen_id)
M2M_FK_COL_TO_ID=$(gen_id)
M2M_FK_COL_FROM_ID=$(gen_id)
M2M_LINK_COL_TO_ID=$(gen_id)
M2M_LINK_COL_FROM_ID=$(gen_id)

COL_FROM_ID=$(gen_id)
COL_TO_ID=$(gen_id)

REL_MO_ID=$(gen_id)
REL_OM_ID=$(gen_id)
REL_HM_1_ID=$(gen_id)
REL_HM_2_ID=$(gen_id)

GVC_M2M_1_ID=$(gen_id)
GVC_M2M_2_ID=$(gen_id)
GVC_M2M_3_ID=$(gen_id)
GVC_M2M_4_ID=$(gen_id)
GVC_FROM_ID=$(gen_id)
GVC_TO_ID=$(gen_id)

# === ИМЕНА M2M ТАБЛИЦЫ (заменяем пробелы на _ для безопасности) ===
TABLE_FROM_SAFE="${TABLE_FROM// /_}"
TABLE_TO_SAFE="${TABLE_TO// /_}"
M2M_TABLE_NAME="nc_nw7q___nc_m2m_${TABLE_FROM_SAFE}_${TABLE_TO_SAFE}"

# === ОБРАБОТКА КОЛЛИЗИИ ИМЕНИ M2M (если таблица/модель уже существует — суффикс 1,2,...) ===
M2M_SUFFIX=""
while sqlite3 "$NOCO_DB" "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$M2M_TABLE_NAME' UNION ALL SELECT 1 FROM nc_models_v2 WHERE table_name='$M2M_TABLE_NAME' LIMIT 1;" 2>/dev/null | grep -q 1; do
    M2M_SUFFIX=$((M2M_SUFFIX + 1))
    M2M_TABLE_NAME="nc_nw7q___nc_m2m_${TABLE_FROM_SAFE}_${TABLE_TO_SAFE}${M2M_SUFFIX}"
    if [ "$M2M_SUFFIX" -gt 10 ]; then
        log "❌ Не удалось подобрать уникальное имя M2M-таблицы"
        exit 1
    fi
done
M2M_MODEL_TITLE="$M2M_TABLE_NAME"
FK_COL_TO_NAME="nc_nw7q___${TABLE_TO_SAFE}_id"
FK_COL_FROM_NAME="nc_nw7q___${TABLE_FROM_SAFE}_id"

log "📦 M2M таблица: $M2M_TABLE_NAME"

# === ПОЛУЧЕНИЕ MAX ORDER ===
MAX_ORDER_MODELS=$(sqlite3 "$NOCO_DB" "SELECT COALESCE(MAX(\"order\"), 0) FROM nc_models_v2 WHERE base_id='$BASE_ID';")
NEW_ORDER_MODELS=$(echo "$MAX_ORDER_MODELS + 1" | bc)

MAX_ORDER_COLS_FROM=$(sqlite3 "$NOCO_DB" "SELECT COALESCE(MAX(\"order\"), 0) FROM nc_columns_v2 WHERE fk_model_id='$MODEL_FROM_ID';")
NEW_ORDER_COLS_FROM=$(echo "$MAX_ORDER_COLS_FROM + 1" | bc)

MAX_ORDER_COLS_TO=$(sqlite3 "$NOCO_DB" "SELECT COALESCE(MAX(\"order\"), 0) FROM nc_columns_v2 WHERE fk_model_id='$MODEL_TO_ID';")
NEW_ORDER_COLS_TO=$(echo "$MAX_ORDER_COLS_TO + 1" | bc)

MAX_ORDER_GV_FROM=$(sqlite3 "$NOCO_DB" "SELECT COALESCE(MAX(\"order\"), 0) FROM nc_grid_view_columns_v2 WHERE fk_view_id IN (SELECT id FROM nc_views_v2 WHERE fk_model_id='$MODEL_FROM_ID' AND type=3 LIMIT 1);")
NEW_ORDER_GV_FROM=$(echo "$MAX_ORDER_GV_FROM + 1" | bc)

MAX_ORDER_GV_TO=$(sqlite3 "$NOCO_DB" "SELECT COALESCE(MAX(\"order\"), 0) FROM nc_grid_view_columns_v2 WHERE fk_view_id IN (SELECT id FROM nc_views_v2 WHERE fk_model_id='$MODEL_TO_ID' AND type=3 LIMIT 1);")
NEW_ORDER_GV_TO=$(echo "$MAX_ORDER_GV_TO + 1" | bc)

# === ПОЛУЧЕНИЕ VIEW ID ===
VIEW_FROM_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_views_v2 WHERE fk_model_id='$MODEL_FROM_ID' AND type=3 LIMIT 1;")
VIEW_TO_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_views_v2 WHERE fk_model_id='$MODEL_TO_ID' AND type=3 LIMIT 1;")

# === ВЫПОЛНЕНИЕ ТРАНЗАКЦИИ ===
log "🔒 Выполнение транзакции..."
SQLITE_OUTPUT=$(sqlite3 "$NOCO_DB" 2>&1 <<EOF
.bail on
BEGIN TRANSACTION;

-- 1. Создание физической M2M таблицы
CREATE TABLE "$M2M_TABLE_NAME" (
    "$FK_COL_TO_NAME" INTEGER NOT NULL,
    "$FK_COL_FROM_NAME" INTEGER NOT NULL,
    PRIMARY KEY ("$FK_COL_TO_NAME", "$FK_COL_FROM_NAME")
);

-- 2. Создание модели M2M таблицы в nc_models_v2 (флаг mm=1)
INSERT INTO nc_models_v2 (id, source_id, base_id, table_name, title, type, mm, enabled, "order", fk_workspace_id, created_at, updated_at)
VALUES ('$M2M_MODEL_ID', '$SOURCE_ID', '$BASE_ID', '$M2M_TABLE_NAME', '$M2M_MODEL_TITLE', 'table', 1, 1, $NEW_ORDER_MODELS, '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 3. Создание 4 колонок в M2M таблице
-- 3.1. ForeignKey для Projects_id
INSERT INTO nc_columns_v2 (id, source_id, base_id, fk_model_id, title, column_name, uidt, dt, dtx, pv, ai, rqd, un, system, "order", meta, fk_workspace_id, created_at, updated_at)
VALUES ('$M2M_FK_COL_TO_ID', '$SOURCE_ID', '$BASE_ID', '$M2M_MODEL_ID', '$FK_COL_TO_NAME', '$FK_COL_TO_NAME', 'ForeignKey', 'integer', '', 0, 1, 1, 1, 0, 1, '{}', '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 3.2. ForeignKey для Tasks_id
INSERT INTO nc_columns_v2 (id, source_id, base_id, fk_model_id, title, column_name, uidt, dt, dtx, pv, ai, rqd, un, system, "order", meta, fk_workspace_id, created_at, updated_at)
VALUES ('$M2M_FK_COL_FROM_ID', '$SOURCE_ID', '$BASE_ID', '$M2M_MODEL_ID', '$FK_COL_FROM_NAME', '$FK_COL_FROM_NAME', 'ForeignKey', 'integer', '', 0, 1, 1, 1, 0, 2, '{}', '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 3.3. LinkToAnotherRecord для Projects (system=1)
INSERT INTO nc_columns_v2 (id, source_id, base_id, fk_model_id, title, column_name, uidt, dt, dtx, pv, ai, rqd, un, system, "order", meta, fk_workspace_id, created_at, updated_at)
VALUES ('$M2M_LINK_COL_TO_ID', '$SOURCE_ID', '$BASE_ID', '$M2M_MODEL_ID', '$TABLE_TO', '', 'LinkToAnotherRecord', '', '', 0, 0, 0, 0, 1, 3, '{"custom":false}', '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 3.4. LinkToAnotherRecord для Tasks (system=1)
INSERT INTO nc_columns_v2 (id, source_id, base_id, fk_model_id, title, column_name, uidt, dt, dtx, pv, ai, rqd, un, system, "order", meta, fk_workspace_id, created_at, updated_at)
VALUES ('$M2M_LINK_COL_FROM_ID', '$SOURCE_ID', '$BASE_ID', '$M2M_MODEL_ID', '$TABLE_FROM', '', 'LinkToAnotherRecord', '', '', 0, 0, 0, 0, 1, 4, '{"custom":false}', '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 4. Создание Grid View для M2M таблицы
INSERT INTO nc_views_v2 (id, fk_model_id, type, title, fk_workspace_id, created_at, updated_at)
VALUES ('$M2M_VIEW_ID', '$M2M_MODEL_ID', 3, '$M2M_TABLE_NAME', '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 5. Добавление колонок в Grid View M2M таблицы
INSERT INTO nc_grid_view_columns_v2 (id, fk_view_id, fk_column_id, source_id, base_id, width, show, "order", fk_workspace_id, created_at, updated_at)
VALUES 
    ('$GVC_M2M_1_ID', '$M2M_VIEW_ID', '$M2M_FK_COL_TO_ID', '$SOURCE_ID', '$BASE_ID', '200px', 1, 1, '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('$GVC_M2M_2_ID', '$M2M_VIEW_ID', '$M2M_FK_COL_FROM_ID', '$SOURCE_ID', '$BASE_ID', '200px', 1, 2, '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('$GVC_M2M_3_ID', '$M2M_VIEW_ID', '$M2M_LINK_COL_TO_ID', '$SOURCE_ID', '$BASE_ID', '200px', 1, 3, '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('$GVC_M2M_4_ID', '$M2M_VIEW_ID', '$M2M_LINK_COL_FROM_ID', '$SOURCE_ID', '$BASE_ID', '200px', 1, 4, '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 6. Создание колонки LinkToAnotherRecord в таблице FROM
INSERT INTO nc_columns_v2 (id, source_id, base_id, fk_model_id, title, column_name, uidt, dt, dtx, pv, ai, rqd, un, system, "order", meta, fk_workspace_id, created_at, updated_at)
VALUES ('$COL_FROM_ID', '$SOURCE_ID', '$BASE_ID', '$MODEL_FROM_ID', '$COLUMN_FROM', '', 'LinkToAnotherRecord', '', '', 0, 0, 0, 0, 0, $NEW_ORDER_COLS_FROM, '{"plural":"${TABLE_TO}s","singular":"$TABLE_TO","defaultViewColOrder":$NEW_ORDER_GV_FROM,"defaultViewColVisibility":1}', '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 7. Создание колонки LinkToAnotherRecord в таблице TO
INSERT INTO nc_columns_v2 (id, source_id, base_id, fk_model_id, title, column_name, uidt, dt, dtx, pv, ai, rqd, un, system, "order", meta, fk_workspace_id, created_at, updated_at)
VALUES ('$COL_TO_ID', '$SOURCE_ID', '$BASE_ID', '$MODEL_TO_ID', '$COLUMN_TO', '', 'LinkToAnotherRecord', '', '', 0, 0, 0, 0, 0, $NEW_ORDER_COLS_TO, '{"plural":"${TABLE_FROM}s","singular":"$TABLE_FROM","defaultViewColOrder":$NEW_ORDER_GV_TO,"defaultViewColVisibility":1}', '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 8. Добавление колонок в Grid Views основных таблиц
INSERT INTO nc_grid_view_columns_v2 (id, fk_view_id, fk_column_id, source_id, base_id, width, show, "order", fk_workspace_id, created_at, updated_at)
VALUES 
    ('$GVC_FROM_ID', '$VIEW_FROM_ID', '$COL_FROM_ID', '$SOURCE_ID', '$BASE_ID', '200px', 1, $NEW_ORDER_GV_FROM, '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    ('$GVC_TO_ID', '$VIEW_TO_ID', '$COL_TO_ID', '$SOURCE_ID', '$BASE_ID', '200px', 1, $NEW_ORDER_GV_TO, '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- 9. Создание 4 записей в nc_col_relations_v2
-- 9.1. mo: Основная связь (Tasks → Projects)
INSERT INTO nc_col_relations_v2 (id, type, virtual, fk_column_id, fk_related_model_id, fk_child_column_id, fk_parent_column_id, fk_mm_model_id, fk_mm_child_column_id, fk_mm_parent_column_id, ur, dr, base_id, fk_workspace_id, created_at, updated_at, version)
VALUES ('$REL_MO_ID', 'mo', 1, '$COL_FROM_ID', '$MODEL_TO_ID', '$ID_COL_FROM', '$ID_COL_TO', '$M2M_MODEL_ID', '$M2M_FK_COL_FROM_ID', '$M2M_FK_COL_TO_ID', 'NO ACTION', 'NO ACTION', '$BASE_ID', '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 2);

-- 9.2. om: Обратная связь (Projects → Tasks)
INSERT INTO nc_col_relations_v2 (id, type, virtual, fk_column_id, fk_related_model_id, fk_child_column_id, fk_parent_column_id, fk_mm_model_id, fk_mm_child_column_id, fk_mm_parent_column_id, ur, dr, base_id, fk_workspace_id, created_at, updated_at, version)
VALUES ('$REL_OM_ID', 'om', 1, '$COL_TO_ID', '$MODEL_FROM_ID', '$ID_COL_TO', '$ID_COL_FROM', '$M2M_MODEL_ID', '$M2M_FK_COL_TO_ID', '$M2M_FK_COL_FROM_ID', 'NO ACTION', 'NO ACTION', '$BASE_ID', '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 2);

-- 9.3. hm: M2M → Projects
INSERT INTO nc_col_relations_v2 (id, type, virtual, fk_column_id, fk_related_model_id, fk_child_column_id, fk_parent_column_id, base_id, fk_workspace_id, created_at, updated_at, version)
VALUES ('$REL_HM_1_ID', 'hm', 1, '$M2M_LINK_COL_TO_ID', '$M2M_MODEL_ID', '$M2M_FK_COL_TO_ID', '$ID_COL_TO', '$BASE_ID', '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 2);

-- 9.4. hm: M2M → Tasks
INSERT INTO nc_col_relations_v2 (id, type, virtual, fk_column_id, fk_related_model_id, fk_child_column_id, fk_parent_column_id, base_id, fk_workspace_id, created_at, updated_at, version)
VALUES ('$REL_HM_2_ID', 'hm', 1, '$M2M_LINK_COL_FROM_ID', '$M2M_MODEL_ID', '$M2M_FK_COL_FROM_ID', '$ID_COL_FROM', '$BASE_ID', '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 2);

COMMIT;
EOF
)
SQLITE_EXIT=$?

if [ $SQLITE_EXIT -ne 0 ]; then
    log "❌ Ошибка транзакции: $SQLITE_OUTPUT"
    log "🔄 Выполняется откат (ROLLBACK)..."
    sqlite3 "$NOCO_DB" "ROLLBACK;" 2>/dev/null || true
    exit 1
fi

log "✅ Транзакция успешно завершена"

# === ПЕРЕЗАПУСК ===
log "🔄 Перезапуск NocoDB..."
docker restart nocodb 2>/dev/null || docker restart printed4u-nocodb 2>/dev/null || log "⚠️  Перезапустите NocoDB вручную."

log "✅ Связь M2O создана: $TABLE_FROM.$COLUMN_FROM ↔ $TABLE_TO.$COLUMN_TO"
log "   📦 M2M таблица: $M2M_TABLE_NAME"
log "   📦 Бэкап: $BACKUP_FILE"
log "   📝 Лог: $LOG_FILE"