#!/bin/bash
# modules/add-column.sh v4.4.4 — Добавление колонки через прямой доступ к SQLite NocoDB
# 
# Использование:
#   bash modules/add-column.sh "Таблица" "Колонка" "Тип" ["Описание"] ["Дефолт"] ["Ширина"] ["rqd"] ["un"]
#   SKIP_RESTART=1 bash modules/add-column.sh "Таблица" "Колонка" "Тип"  # без перезапуска NocoDB
#
# Типы колонок:
#   TEXT, LONGTEXT, DATE, DATETIME, INTEGER, BOOLEAN, URL, EMAIL, CURRENCY
#   SELECT:Опция1,Опция2,Опция3
#   MULTISELECT:Опция1,Опция2,Опция3
#
# Примеры:
#   bash modules/add-column.sh "Дела" "Что делаем?" "TEXT" "Название задачи"
#   bash modules/add-column.sh "Проекты" "Подробности" "LONGTEXT" "История проекта"
#   bash modules/add-column.sh "Контакты" "Ссылка" "URL" "Telegram"
#   bash modules/add-column.sh "Контакты" "E-mail" "EMAIL"
#   bash modules/add-column.sh "Позиции" "Цена" "CURRENCY" "Цена за единицу" "0" "120px"
#   bash modules/add-column.sh "Проекты" "Приоритет" "SELECT:Высокий,Средний,Низкий" "Приоритет" "Средний" "120px"
#   bash modules/add-column.sh "Дела" "Клиент_ID" "TEXT" "ID" "" "150px" "1" "1"  # required + unique
#
# Особенности v4.4.4:
#   ✅ Правильный uidt: SingleLineText (не varchar!)
#   ✅ Все SQL в одной транзакции через heredoc (откат при ошибке)
#   ✅ .bail on в SQLite для мгновенного прерывания при любой ошибке (Проблема 42)
#   ✅ set +e / set -e для корректного получения exit code (Проблема 44)
#   ✅ Автобэкап БД перед изменениями
#   ✅ Логирование всех действий в файл
#   ✅ Проверка конфликтов по title И column_name
#   ✅ Поддержка 9 типов колонок + SELECT/MULTISELECT
#   ✅ Настраиваемая ширина колонки
#   ✅ Флаги required/unique
#   🆕 v4.4.3: Нормализация order после добавления (защита от дубликатов)
#   🆕 v4.4.4: Флаг SKIP_RESTART для пропуска перезапуска NocoDB

set -e

# === АРГУМЕНТЫ ===
TABLE_TITLE="$1"
COLUMN_TITLE="$2"
COLUMN_TYPE="${3:-TEXT}"
COLUMN_DESCRIPTION="${4:-}"
COLUMN_DEFAULT="${5:-}"
COLUMN_WIDTH="${6:-200px}"
REQUIRED="${7:-0}"
UNIQUE="${8:-0}"

# === КОНФИГУРАЦИЯ ===
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
LOG_FILE="/mnt/data/nocodb-data/column-migrations.log"
BACKUP_DIR="/mnt/data/backups"

# === ВАЛИДАЦИЯ ===
if [ -z "$TABLE_TITLE" ] || [ -z "$COLUMN_TITLE" ]; then
    echo "❌ Ошибка: Укажите имя таблицы и имя колонки."
    echo "Пример: bash modules/add-column.sh \"Дела\" \"Что делаем?\" \"TEXT\""
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
    local backup_file="$BACKUP_DIR/noco-before-$(date '+%Y%m%d-%H%M%S').db"
    cp "$NOCO_DB" "$backup_file"
    log "💾 Бэкап создан: $backup_file"
    BACKUP_FILE="$backup_file"
}

# === НАЧАЛО РАБОТЫ ===
log "🔧 Добавление колонки '$COLUMN_TITLE' ($COLUMN_TYPE) в таблицу '$TABLE_TITLE'..."
backup_db

BASE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_bases_v2 LIMIT 1;")
SOURCE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_sources_v2 WHERE base_id='$BASE_ID' LIMIT 1;")
WORKSPACE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM workspace LIMIT 1;")

if [ -z "$BASE_ID" ] || [ -z "$SOURCE_ID" ] || [ -z "$WORKSPACE_ID" ]; then
    log "❌ Ошибка: Не удалось найти base/source/workspace."
    exit 1
fi
log "✅ Base: $BASE_ID | Source: $SOURCE_ID | Workspace: $WORKSPACE_ID"

MODEL_INFO=$(sqlite3 "$NOCO_DB" "SELECT id, table_name FROM nc_models_v2 WHERE title='$TABLE_TITLE' AND base_id='$BASE_ID';")
if [ -z "$MODEL_INFO" ]; then
    log "❌ Ошибка: Таблица '$TABLE_TITLE' не найдена."
    sqlite3 "$NOCO_DB" "SELECT '  - ' || title FROM nc_models_v2 WHERE base_id='$BASE_ID';"
    exit 1
fi
MODEL_ID=$(echo "$MODEL_INFO" | cut -d'|' -f1)
PHYSICAL_TABLE=$(echo "$MODEL_INFO" | cut -d'|' -f2)
log "✅ Модель: $MODEL_ID | Физическая таблица: $PHYSICAL_TABLE"

COLUMN_ID=$(head /dev/urandom | tr -dc 'a-z0-9' | fold -w 15 | head -n 1)
COLUMN_NAME=$(echo "$COLUMN_TITLE" | tr ' ?!-' '____')

# === ПРОВЕРКА КОНФЛИКТОВ (title И column_name) ===
EXISTING=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_columns_v2 WHERE fk_model_id='$MODEL_ID' AND (title='$COLUMN_TITLE' OR column_name='$COLUMN_NAME');")
if [ -n "$EXISTING" ]; then
    log "⚠️  Колонка '$COLUMN_TITLE' (или '$COLUMN_NAME') уже существует. Пропускаем."
    exit 0
fi

MAX_ORDER=$(sqlite3 "$NOCO_DB" "SELECT COALESCE(MAX(\"order\"), 0) FROM nc_columns_v2 WHERE fk_model_id='$MODEL_ID';")
NEW_ORDER=$(echo "$MAX_ORDER + 1" | bc)

# === ОПРЕДЕЛЕНИЕ ТИПА ===
if [[ "$COLUMN_TYPE" == SELECT:* ]]; then
    BASE_TYPE="SELECT"
    OPTIONS=$(echo "$COLUMN_TYPE" | cut -d':' -f2-)
    SQL_TYPE="TEXT"
    NOCO_UIDT="SingleSelect"
    NOCO_DT="string"
    NOCO_DTX="specificType"
    NOCO_META='{}'
elif [[ "$COLUMN_TYPE" == MULTISELECT:* ]]; then
    BASE_TYPE="MULTISELECT"
    OPTIONS=$(echo "$COLUMN_TYPE" | cut -d':' -f2-)
    SQL_TYPE="TEXT"
    NOCO_UIDT="MultiSelect"
    NOCO_DT="string"
    NOCO_DTX="specificType"
    NOCO_META='{}'
else
    BASE_TYPE="$COLUMN_TYPE"
    OPTIONS=""
    case "$COLUMN_TYPE" in
        DATE)       SQL_TYPE="DATE" ;;
        DATETIME)   SQL_TYPE="DATETIME" ;;
        INTEGER)    SQL_TYPE="INTEGER" ;;
        BOOLEAN)    SQL_TYPE="BOOLEAN" ;;
        LONGTEXT)   SQL_TYPE="TEXT" ;;
        URL)        SQL_TYPE="TEXT" ;;
        EMAIL)      SQL_TYPE="TEXT" ;;
        CURRENCY)   SQL_TYPE="DECIMAL" ;;
        *)          SQL_TYPE="TEXT" ;;
    esac
    case "$COLUMN_TYPE" in
        DATE)
            NOCO_UIDT="Date"; NOCO_DT="date"; NOCO_DTX="specificType"
            NOCO_META='{"date_format":"DD.MM.YYYY"}'
            ;;
        DATETIME)
            NOCO_UIDT="DateTime"; NOCO_DT="datetime"; NOCO_DTX="specificType"
            NOCO_META='{"date_format":"DD.MM.YYYY","time_format":"HH:mm","is12hrFormat":false}'
            ;;
        INTEGER)
            NOCO_UIDT="Number"; NOCO_DT="integer"; NOCO_DTX="specificType"
            NOCO_META='{}'
            ;;
        BOOLEAN)
            NOCO_UIDT="Checkbox"; NOCO_DT="boolean"; NOCO_DTX="specificType"
            NOCO_META='{"iconIdx":1,"icon":{"checked":"mdi-check-circle-outline","unchecked":"mdi-checkbox-blank-circle-outline"},"color":"#777"}'
            ;;
        LONGTEXT)
            NOCO_UIDT="LongText"; NOCO_DT="string"; NOCO_DTX="specificType"
            NOCO_META='{}'
            ;;
        URL)
            NOCO_UIDT="URL"; NOCO_DT="string"; NOCO_DTX="specificType"
            NOCO_META='{}'
            ;;
        EMAIL)
            NOCO_UIDT="Email"; NOCO_DT="string"; NOCO_DTX="specificType"
            NOCO_META='{}'
            ;;
        CURRENCY)
            NOCO_UIDT="Currency"; NOCO_DT="decimal"; NOCO_DTX="specificType"
            NOCO_META='{"currency_code":"BYN","currency_locale":"ru-BY","currency_prefix":"","currency_suffix":" BYN"}'
            ;;
        *)
            # ✅ v4.4.2 — правильный uidt для Single Line Text
            NOCO_UIDT="SingleLineText"; NOCO_DT="string"; NOCO_DTX="specificType"
            NOCO_META='{}'
            ;;
    esac
fi

# === ГЕНЕРАЦИЯ GRID VIEW INSERT ===
GRID_VIEW_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_views_v2 WHERE fk_model_id='$MODEL_ID' AND type=3 LIMIT 1;")
GV_INSERT=""
if [ -n "$GRID_VIEW_ID" ]; then
    log "👁️  Подготовка INSERT в nc_grid_view_columns_v2 (ширина: $COLUMN_WIDTH)..."
    GVC_ID=$(head /dev/urandom | tr -dc 'a-z0-9' | fold -w 15 | head -n 1)
    GV_MAX_ORDER=$(sqlite3 "$NOCO_DB" "SELECT COALESCE(MAX(\"order\"), 0) FROM nc_grid_view_columns_v2 WHERE fk_view_id='$GRID_VIEW_ID';")
    GV_NEW_ORDER=$(echo "$GV_MAX_ORDER + 1" | bc)
    GV_INSERT="INSERT INTO nc_grid_view_columns_v2 (id, fk_view_id, fk_column_id, source_id, base_id, width, show, \"order\", fk_workspace_id, created_at, updated_at) VALUES ('$GVC_ID', '$GRID_VIEW_ID', '$COLUMN_ID', '$SOURCE_ID', '$BASE_ID', '$COLUMN_WIDTH', 1, $GV_NEW_ORDER, '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);"
fi

# === ГЕНЕРАЦИЯ SELECT ОПЦИЙ ===
SELECT_INSERTS=""
if [[ "$BASE_TYPE" == "SELECT" || "$BASE_TYPE" == "MULTISELECT" ]]; then
    log "🎨 Подготовка опций Select..."
    COLORS=("#cfdffe" "#d0f1fd" "#c2f5e8" "#fff9c4" "#ffe0b2" "#ffc9fd" "#ffd5f5" "#e0e0e0" "#b3e5fc" "#dcedc8")
    IFS=',' read -ra OPT_ARRAY <<< "$OPTIONS"
    ORDER=1
    for opt in "${OPT_ARRAY[@]}"; do
        OPT_ID=$(head /dev/urandom | tr -dc 'a-z0-9' | fold -w 15 | head -n 1)
        COLOR=${COLORS[$(( (ORDER-1) % ${#COLORS[@]} ))]}
        SELECT_INSERTS+="INSERT INTO nc_col_select_options_v2 (id, fk_column_id, title, color, \"order\", base_id, fk_workspace_id) VALUES ('$OPT_ID', '$COLUMN_ID', '$opt', '$COLOR', $ORDER, '$BASE_ID', '$WORKSPACE_ID');"$'\n'
        log "  ✅ Опция: $opt (цвет: $COLOR)"
        ORDER=$((ORDER + 1))
    done
fi

# === ВЫПОЛНЕНИЕ ВСЕХ SQL В ОДНОЙ ТРАНЗАКЦИИ ===
# 🆕 v4.4.4: .bail on + set +e/set -e для корректной обработки ошибок
log "🔒 Выполнение транзакции..."
set +e
SQLITE_OUTPUT=$(sqlite3 "$NOCO_DB" 2>&1 <<EOF
.bail on
BEGIN TRANSACTION;

-- ALTER TABLE
ALTER TABLE "$PHYSICAL_TABLE" ADD COLUMN "$COLUMN_NAME" $SQL_TYPE;

-- INSERT в nc_columns_v2
INSERT INTO nc_columns_v2 (id, source_id, base_id, fk_model_id, title, column_name, uidt, dt, dtx, pv, ai, rqd, un, system, "order", meta, description, cdf, fk_workspace_id, created_at, updated_at) 
VALUES ('$COLUMN_ID', '$SOURCE_ID', '$BASE_ID', '$MODEL_ID', '$COLUMN_TITLE', '$COLUMN_NAME', '$NOCO_UIDT', '$NOCO_DT', '$NOCO_DTX', 0, 0, $REQUIRED, $UNIQUE, 0, $NEW_ORDER, '$NOCO_META', '$COLUMN_DESCRIPTION', '$COLUMN_DEFAULT', '$WORKSPACE_ID', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- SELECT опции
$SELECT_INSERTS

-- Grid View
$GV_INSERT

COMMIT;
EOF
)
SQLITE_EXIT=$?
set -e

if [ $SQLITE_EXIT -ne 0 ]; then
    log "❌ Ошибка транзакции: $SQLITE_OUTPUT"
    log "🔄 Откат транзакции..."
    sqlite3 "$NOCO_DB" "ROLLBACK;" 2>/dev/null || true
    exit 1
fi

log "✅ Транзакция успешно завершена"

# ============================================
# 🆕 v4.4.3: НОРМАЛИЗАЦИЯ ORDER
# ============================================
# После добавления колонки пересчитываем order для grid view
# и для nc_columns_v2, чтобы гарантировать отсутствие дубликатов.
# Это защищает от багов NocoDB UI (перетаскивание/скрытие колонок).
if [ -n "$GRID_VIEW_ID" ]; then
    log "📐 Нормализация order в grid view..."
    sqlite3 "$NOCO_DB" "
    DROP TABLE IF EXISTS tmp_norm_gv;
    CREATE TEMP TABLE tmp_norm_gv AS
    SELECT id, ROW_NUMBER() OVER (PARTITION BY fk_view_id ORDER BY \"order\", id) as new_order
    FROM nc_grid_view_columns_v2
    WHERE fk_view_id = '$GRID_VIEW_ID';
    UPDATE nc_grid_view_columns_v2
    SET \"order\" = (SELECT new_order FROM tmp_norm_gv WHERE tmp_norm_gv.id = nc_grid_view_columns_v2.id)
    WHERE fk_view_id = '$GRID_VIEW_ID';
    DROP TABLE IF EXISTS tmp_norm_gv;
    " 2>/dev/null || true

    # Проверяем результат
    DUPES=$(sqlite3 "$NOCO_DB" "
    SELECT COUNT(*) FROM (
        SELECT fk_view_id, \"order\", COUNT(*) as cnt
        FROM nc_grid_view_columns_v2
        WHERE fk_view_id = '$GRID_VIEW_ID'
        GROUP BY fk_view_id, \"order\"
        HAVING cnt > 1
    );" 2>/dev/null || echo "0")

    if [ "$DUPES" -eq 0 ]; then
        log "   ✅ order нормализован, дубликатов: 0"
    else
        log "   ⚠️  После нормализации осталось дубликатов: $DUPES"
    fi
fi

# Нормализация order в nc_columns_v2 (для полноты)
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

log "✅ Колонка '$COLUMN_TITLE' ($NOCO_UIDT) добавлена в '$TABLE_TITLE'!"
log "   📦 Бэкап: $BACKUP_FILE"
log "   📝 Лог: $LOG_FILE"