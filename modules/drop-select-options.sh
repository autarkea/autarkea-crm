#!/bin/bash
# modules/drop-select-options.sh v1.0.0 — Удаление опций из существующего SELECT/MULTISELECT через прямой доступ к SQLite NocoDB
# 
# Использование:
#   bash modules/drop-select-options.sh "Таблица" "Колонка" "Опция1,Опция2"
#   SKIP_RESTART=1 bash modules/drop-select-options.sh "Таблица" "Колонка" "Опция1"  # без перезапуска NocoDB
#   NOCO_DB=/путь/к/noco.db bash modules/drop-select-options.sh "Таблица" "Колонка" "Опция1"  # тест на копии БД
#
# Примеры:
#   bash modules/drop-select-options.sh "Проекты" "Статус" "Отменён"
#   bash modules/drop-select-options.sh "Документы" "Тип документа" "Акт сверки"
#   bash modules/drop-select-options.sh "Позиции заказа" "Тип" "Услуга,Материал"
#
# Особенности v1.0.0:
#   ✅ Работает ТОЛЬКО с колонками SingleSelect/MultiSelect (иначе — отказ)
#   ✅ Идемпотентность: несуществующие опции пропускаются с предупреждением
#   ✅ ⚠️ Предупреждение о данных: считает записи с удаляемой опцией. Данные в
#      строках НЕ удаляются — значение останется, но перестанет быть опцией селекта
#   ✅ Автобэкап БД перед изменениями (правило 7)
#   ✅ Все SQL в одной транзакции через heredoc с .bail on (откат при ошибке, Проблема 42)
#   ✅ set +e / set -e для корректного получения exit code (Проблема 44)
#   ✅ Экранирование одинарных кавычек и LIKE-символов в названиях опций
#   ✅ Нормализация order после удаления (без «дырок» 1,2,4,5)
#   ✅ Логирование всех действий в /mnt/data/nocodb-data/column-migrations.log
#   ✅ Флаг SKIP_RESTART и переопределение NOCO_DB/LOG_FILE/BACKUP_DIR для тестов
#
# Ограничение: опции разделяются запятой (как в add-select-options.sh) — запятая
# внутри названия опции не поддерживается.

set -e

# === АРГУМЕНТЫ ===
TABLE_TITLE="$1"
COLUMN_TITLE="$2"
REMOVE_OPTIONS="${3:-}"

# === КОНФИГУРАЦИЯ ===
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
LOG_FILE="${LOG_FILE:-/mnt/data/nocodb-data/column-migrations.log}"
BACKUP_DIR="${BACKUP_DIR:-/mnt/data/backups}"

# === ВАЛИДАЦИЯ ===
if [ -z "$TABLE_TITLE" ] || [ -z "$COLUMN_TITLE" ] || [ -z "$REMOVE_OPTIONS" ]; then
    echo "❌ Ошибка: Укажите таблицу, колонку и список опций через запятую."
    echo "Пример: bash modules/drop-select-options.sh \"Проекты\" \"Статус\" \"Отменён\""
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
    local backup_file="$BACKUP_DIR/noco-before-drop-select-$(date '+%Y%m%d-%H%M%S').db"
    cp "$NOCO_DB" "$backup_file"
    log "💾 Бэкап создан: $backup_file"
    BACKUP_FILE="$backup_file"
}

# === НАЧАЛО РАБОТЫ ===
log "🗑️  Удаление опций из '$COLUMN_TITLE' ($TABLE_TITLE): $REMOVE_OPTIONS..."
backup_db

BASE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_bases_v2 LIMIT 1;")
SOURCE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_sources_v2 WHERE base_id='$BASE_ID' LIMIT 1;")
WORKSPACE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM workspace LIMIT 1;")

if [ -z "$BASE_ID" ] || [ -z "$SOURCE_ID" ]; then
    log "❌ Ошибка: Не удалось найти base/source."
    exit 1
fi
if [ -z "$WORKSPACE_ID" ]; then
    log "⚠️  Workspace не найден (очищен в эталоне template.db). Для удаления опций workspace не требуется."
fi
log "✅ Base: $BASE_ID | Source: $SOURCE_ID | Workspace: ${WORKSPACE_ID:-нет}"

MODEL_INFO=$(sqlite3 "$NOCO_DB" "SELECT id, table_name FROM nc_models_v2 WHERE title='$TABLE_TITLE' AND base_id='$BASE_ID' LIMIT 1;")
if [ -z "$MODEL_INFO" ]; then
    log "❌ Ошибка: Таблица '$TABLE_TITLE' не найдена."
    sqlite3 "$NOCO_DB" "SELECT '  - ' || title FROM nc_models_v2 WHERE base_id='$BASE_ID';"
    exit 1
fi
MODEL_ID=$(echo "$MODEL_INFO" | cut -d'|' -f1)
PHYSICAL_TABLE=$(echo "$MODEL_INFO" | cut -d'|' -f2)

# === ПОИСК КОЛОНКИ ===
COLUMN_INFO=$(sqlite3 "$NOCO_DB" "SELECT id, column_name, uidt FROM nc_columns_v2 WHERE fk_model_id='$MODEL_ID' AND (title='$COLUMN_TITLE' OR column_name='$COLUMN_TITLE') LIMIT 1;")
if [ -z "$COLUMN_INFO" ]; then
    log "❌ Ошибка: Колонка '$COLUMN_TITLE' не найдена в таблице '$TABLE_TITLE'."
    exit 1
fi

COLUMN_ID=$(echo "$COLUMN_INFO" | cut -d'|' -f1)
COLUMN_NAME=$(echo "$COLUMN_INFO" | cut -d'|' -f2)
COLUMN_UIDT=$(echo "$COLUMN_INFO" | cut -d'|' -f3)

log "✅ Колонка найдена: ID=$COLUMN_ID, name=$COLUMN_NAME, type=$COLUMN_UIDT, таблица: $PHYSICAL_TABLE"

# === ВАЛИДАЦИЯ ТИПА ===
if [[ "$COLUMN_UIDT" != "SingleSelect" && "$COLUMN_UIDT" != "MultiSelect" ]]; then
    log "❌ Ошибка: Колонка '$COLUMN_TITLE' имеет тип $COLUMN_UIDT, а не SingleSelect/MultiSelect."
    log "   Удаление опций возможно только в полях-селектах."
    exit 1
fi

# === ТЕКУЩИЕ ОПЦИИ ===
CURRENT_OPTIONS=$(sqlite3 "$NOCO_DB" "SELECT title FROM nc_col_select_options_v2 WHERE fk_column_id='$COLUMN_ID' ORDER BY \"order\";")
if [ -n "$CURRENT_OPTIONS" ]; then
    log "📋 Текущие опции:"
    echo "$CURRENT_OPTIONS" | while IFS= read -r o; do log "   • $o"; done
else
    log "📋 Текущих опций нет (селект пустой)."
fi

# === РАЗБОР ОПЦИЙ И ПРОВЕРКА СУЩЕСТВОВАНИЯ ===
DELETE_STATEMENTS=""
TO_DELETE=0
SKIPPED=0

IFS=',' read -ra OPT_ARRAY <<< "$REMOVE_OPTIONS"
for opt in "${OPT_ARRAY[@]}"; do
    # Обрезаем пробелы по краям
    opt=$(echo "$opt" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    if [ -z "$opt" ]; then
        continue
    fi

    # Идемпотентность: несуществующая опция — пропускаем
    if ! echo "$CURRENT_OPTIONS" | grep -Fxq "$opt"; then
        log "⏭️  Опция '$opt' не существует — пропускаем."
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    # Экранирование для SQL (одинарные кавычки)
    opt_sql=$(echo "$opt" | sed "s/'/''/g")

    # ⚠️ Подсчёт записей с этой опцией (ДАННЫЕ НЕ УДАЛЯЮТСЯ)
    # SingleSelect: точное совпадение. MultiSelect: значение может быть строкой,
    # списком через запятую или JSON-массивом — покрываем все варианты.
    if [[ "$COLUMN_UIDT" == "SingleSelect" ]]; then
        ROW_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM \"$PHYSICAL_TABLE\" WHERE \"$COLUMN_NAME\" = '$opt_sql';" 2>/dev/null || echo "?")
    else
        # Экранирование LIKE-символов для MultiSelect-паттернов
        like_opt=$(echo "$opt" | sed 's/[%_]/\\&/g' | sed "s/'/''/g")
        ROW_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM \"$PHYSICAL_TABLE\" WHERE \"$COLUMN_NAME\" = '$opt_sql' OR \"$COLUMN_NAME\" LIKE '$like_opt,%' OR \"$COLUMN_NAME\" LIKE '%,$like_opt' OR \"$COLUMN_NAME\" LIKE '%,$like_opt,%' OR INSTR(\"$COLUMN_NAME\", '\"$opt_sql\"') > 0;" 2>/dev/null || echo "?")
    fi

    if [ -n "$ROW_COUNT" ] && [ "$ROW_COUNT" -gt 0 ] 2>/dev/null; then
        log "   ⚠️  Опция '$opt' используется в $ROW_COUNT записи(ях). Данные в строках НЕ удаляются — значение останется, но перестанет быть опцией селекта."
    else
        log "   ℹ️  Опция '$opt' не используется в записях."
    fi

    DELETE_STATEMENTS+="DELETE FROM nc_col_select_options_v2 WHERE fk_column_id='$COLUMN_ID' AND title='$opt_sql';"$'\n'
    log "  ✅ Удаляю опцию: $opt"
    TO_DELETE=$((TO_DELETE + 1))
done

if [ "$TO_DELETE" -eq 0 ]; then
    log "⏭️  Нет существующих опций для удаления. БД не менялась."
    exit 0
fi

# === ВЫПОЛНЕНИЕ ТРАНЗАКЦИИ С .bail on ===
log "🔒 Выполнение транзакции ($TO_DELETE на удаление, $SKIPPED пропущено)..."
set +e
SQLITE_OUTPUT=$(sqlite3 "$NOCO_DB" 2>&1 <<EOF
.bail on
BEGIN TRANSACTION;

$DELETE_STATEMENTS

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

# === НОРМАЛИЗАЦИЯ ORDER (без «дырок» 1,2,4,5) ===
log "📐 Нормализация order оставшихся опций..."
sqlite3 "$NOCO_DB" "
DROP TABLE IF EXISTS tmp_opt_norm;
CREATE TEMP TABLE tmp_opt_norm AS
SELECT id, ROW_NUMBER() OVER (PARTITION BY fk_column_id ORDER BY \"order\", id) as new_order
FROM nc_col_select_options_v2
WHERE fk_column_id = '$COLUMN_ID';
UPDATE nc_col_select_options_v2
SET \"order\" = (SELECT new_order FROM tmp_opt_norm WHERE tmp_opt_norm.id = nc_col_select_options_v2.id)
WHERE fk_column_id = '$COLUMN_ID';
DROP TABLE IF EXISTS tmp_opt_norm;
" 2>/dev/null || log "   ⚠️  Нормализация не выполнена (не критично — останутся «дырки» в порядке)."

log "✅ Транзакция успешно завершена: удалено опций: $TO_DELETE, пропущено: $SKIPPED"

# === ПЕРЕЗАПУСК (с возможностью пропуска) ===
if [ "${SKIP_RESTART:-0}" != "1" ]; then
    log "🔄 Перезапуск NocoDB..."
    docker restart nocodb 2>/dev/null || docker restart printed4u-nocodb 2>/dev/null || log "⚠️  Перезапустите NocoDB вручную."
else
    log "⏭️  Пропуск перезапуска (SKIP_RESTART=1)"
fi

log "✅ Опции удалены из '$COLUMN_TITLE' ($TABLE_TITLE)! Колонка: $COLUMN_NAME"
log "   📦 Бэкап: $BACKUP_FILE"
log "   📝 Лог: $LOG_FILE"
