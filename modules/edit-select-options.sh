#!/bin/bash
# modules/edit-select-options.sh v1.0.0 — Редактирование опции SELECT/MULTISELECT (название и/или цвет) через прямой доступ к SQLite NocoDB
# 
# Использование:
#   bash modules/edit-select-options.sh "Таблица" "Колонка" "СтароеНазвание" ["НовоеНазвание"] ["#RRGGBB"]
#   SKIP_RESTART=1 bash modules/edit-select-options.sh "Таблица" "Колонка" "Старое" "Новое"  # без перезапуска NocoDB
#   NOCO_DB=/путь/к/noco.db bash modules/edit-select-options.sh "Таблица" "Колонка" "Старое" "Новое"  # тест на копии БД
#
# Примеры:
#   # Переименовать опцию (данные в строках обновятся автоматически)
#   bash modules/edit-select-options.sh "Проекты" "Статус" "Мимо" "Провален"
#   # Переименовать + перекрасить
#   bash modules/edit-select-options.sh "Проекты" "Статус" "Мимо" "Провален" "#d32f2f"
#   # Только перекрасить (новое название пустое "")
#   bash modules/edit-select-options.sh "Контакты" "Мессенджер" "Иное" "" "#9e9e9e"
#
# Цвет (опционально): "#RRGGBB" или "#RRGGBBAA" (как в add-select-options.sh).
#
# Особенности v1.0.0:
#   ✅ Переименование ОБНОВЛЯЕТ данные в строках (SingleSelect — точное совпадение;
#      MultiSelect — замена токена в строке через запятую + JSON-страховка)
#   ✅ Предупреждение о количестве записей до изменения ("Будет обновлено N записей")
#   ✅ Защита от конфликтов: новое название не должно существовать (exit 1)
#   ✅ Работает ТОЛЬКО с колонками SingleSelect/MultiSelect (иначе — отказ)
#   ✅ Валидация hex-цвета (как в add-select-options.sh)
#   ✅ Автобэкап БД перед изменениями (правило 7)
#   ✅ Все SQL в одной транзакции через heredoc с .bail on (откат при ошибке, Проблема 42)
#   ✅ set +e / set -e для корректного получения exit code (Проблема 44)
#   ✅ Экранирование одинарных кавычек и LIKE-символов
#   ✅ Логирование всех действий в /mnt/data/nocodb-data/column-migrations.log
#   ✅ Флаг SKIP_RESTART и переопределение NOCO_DB/LOG_FILE/BACKUP_DIR для тестов
#
# Ограничение: если запись в физической таблице хранит значение в нестандартном
# формате (не строка и не список через запятую) — данные не обновятся, останутся
# «осиротевшими» (модуль это фиксирует в предупреждении о количестве записей).

set -e

# === АРГУМЕНТЫ ===
TABLE_TITLE="$1"
COLUMN_TITLE="$2"
OLD_NAME="${3:-}"
NEW_NAME="${4:-}"
NEW_COLOR="${5:-}"

# === КОНФИГУРАЦИЯ ===
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
LOG_FILE="${LOG_FILE:-/mnt/data/nocodb-data/column-migrations.log}"
BACKUP_DIR="${BACKUP_DIR:-/mnt/data/backups}"

# === ВАЛИДАЦИЯ ===
if [ -z "$TABLE_TITLE" ] || [ -z "$COLUMN_TITLE" ] || [ -z "$OLD_NAME" ]; then
    echo "❌ Ошибка: Укажите таблицу, колонку и текущее название опции."
    echo "Пример: bash modules/edit-select-options.sh \"Проекты\" \"Статус\" \"Мимо\" \"Провален\""
    exit 1
fi

# === ЧТО МЕНЯЕМ (хотя бы одно из двух) ===
DO_RENAME=0
if [ -n "$NEW_NAME" ] && [ "$NEW_NAME" != "$OLD_NAME" ]; then
    DO_RENAME=1
fi
DO_RECOLOR=0
if [ -n "$NEW_COLOR" ]; then
    DO_RECOLOR=1
fi
if [ "$DO_RENAME" -eq 0 ] && [ "$DO_RECOLOR" -eq 0 ]; then
    echo "❌ Ошибка: Ничего не меняется. Задай новое название или цвет."
    echo "Пример: bash modules/edit-select-options.sh \"Проекты\" \"Статус\" \"Мимо\" \"Провален\" \"#d32f2f\""
    exit 1
fi

# === ВАЛИДАЦИЯ ЦВЕТА ===
if [ "$DO_RECOLOR" -eq 1 ] && [[ ! "$NEW_COLOR" =~ ^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$ ]]; then
    echo "❌ Ошибка: Некорректный цвет '$NEW_COLOR'. Формат: #RRGGBB или #RRGGBBAA"
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
    local backup_file="$BACKUP_DIR/noco-before-edit-select-$(date '+%Y%m%d-%H%M%S').db"
    cp "$NOCO_DB" "$backup_file"
    log "💾 Бэкап создан: $backup_file"
    BACKUP_FILE="$backup_file"
}

# === НАЧАЛО РАБОТЫ ===
if [ "$DO_RENAME" -eq 1 ]; then
    log "✏️  Редактирование опции '$OLD_NAME' → '$NEW_NAME' ($TABLE_TITLE/$COLUMN_TITLE)..."
else
    log "🎨 Перекраска опции '$OLD_NAME' → $NEW_COLOR ($TABLE_TITLE/$COLUMN_TITLE)..."
fi
backup_db

BASE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_bases_v2 LIMIT 1;")
SOURCE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_sources_v2 WHERE base_id='$BASE_ID' LIMIT 1;")
WORKSPACE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM workspace LIMIT 1;")

if [ -z "$BASE_ID" ] || [ -z "$SOURCE_ID" ]; then
    log "❌ Ошибка: Не удалось найти base/source."
    exit 1
fi
if [ -z "$WORKSPACE_ID" ]; then
    log "⚠️  Workspace не найден (очищен в эталоне template.db). Для редактирования опций workspace не требуется."
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
    log "   Редактирование опций возможно только в полях-селектах."
    exit 1
fi

# === ПОИСК РЕДАКТИРУЕМОЙ ОПЦИИ ===
OPT_EXISTS=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_col_select_options_v2 WHERE fk_column_id='$COLUMN_ID' AND title='$OLD_NAME' LIMIT 1;")
if [ -z "$OPT_EXISTS" ]; then
    log "❌ Ошибка: Опция '$OLD_NAME' не найдена в '$COLUMN_TITLE' ($TABLE_TITLE)."
    sqlite3 "$NOCO_DB" "SELECT '  - ' || title FROM nc_col_select_options_v2 WHERE fk_column_id='$COLUMN_ID' ORDER BY \"order\";"
    exit 1
fi
log "✅ Опция найдена: $OLD_NAME"

# === ПРОВЕРКА КОНФЛИКТА НОВОГО НАЗВАНИЯ ===
if [ "$DO_RENAME" -eq 1 ]; then
    CONFLICT=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_col_select_options_v2 WHERE fk_column_id='$COLUMN_ID' AND title='$NEW_NAME' LIMIT 1;")
    if [ -n "$CONFLICT" ]; then
        log "❌ Ошибка: Опция '$NEW_NAME' уже существует в '$COLUMN_TITLE' ($TABLE_TITLE). Дубликаты недопустимы."
        exit 1
    fi
    log "✅ Конфликтов нет: '$NEW_NAME' свободно."
fi

# === ЭКРАНИРОВАНИЕ ДЛЯ SQL ===
old_sql=$(echo "$OLD_NAME" | sed "s/'/''/g")
new_sql=$(echo "$NEW_NAME" | sed "s/'/''/g")
old_like=$(echo "$OLD_NAME" | sed 's/[%_]/\\&/g' | sed "s/'/''/g")

# === СБОРКА UPDATE: опция (title/color) ===
SET_PARTS=""
if [ "$DO_RENAME" -eq 1 ]; then
    SET_PARTS="title='$new_sql'"
fi
if [ "$DO_RECOLOR" -eq 1 ]; then
    if [ -n "$SET_PARTS" ]; then SET_PARTS="$SET_PARTS, "; fi
    SET_PARTS="${SET_PARTS}color='$NEW_COLOR'"
fi
OPT_UPDATE="UPDATE nc_col_select_options_v2 SET ${SET_PARTS} WHERE fk_column_id='$COLUMN_ID' AND title='$old_sql';"

# === СБОРКА UPDATE: данные в строках (только при переименовании) ===
DATA_UPDATE=""
if [ "$DO_RENAME" -eq 1 ]; then
    if [[ "$COLUMN_UIDT" == "SingleSelect" ]]; then
        ROW_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM \"$PHYSICAL_TABLE\" WHERE \"$COLUMN_NAME\" = '$old_sql';" 2>/dev/null || echo "?")
        DATA_UPDATE="UPDATE \"$PHYSICAL_TABLE\" SET \"$COLUMN_NAME\"='$new_sql' WHERE \"$COLUMN_NAME\"='$old_sql';"
    else
        # MultiSelect: замена токена в строке через запятую + JSON-страховка
        ROW_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM \"$PHYSICAL_TABLE\" WHERE \"$COLUMN_NAME\" = '$old_sql' OR \"$COLUMN_NAME\" LIKE '$old_like,%' OR \"$COLUMN_NAME\" LIKE '%,$old_like' OR \"$COLUMN_NAME\" LIKE '%,$old_like,%' OR INSTR(\"$COLUMN_NAME\", '\"$old_sql\"') > 0;" 2>/dev/null || echo "?")
        DATA_UPDATE=""
        # 1. точное совпадение (одно значение)
        DATA_UPDATE+="UPDATE \"$PHYSICAL_TABLE\" SET \"$COLUMN_NAME\"='$new_sql' WHERE \"$COLUMN_NAME\"='$old_sql';"
        # 2. середина списка: ,old,
        DATA_UPDATE+="UPDATE \"$PHYSICAL_TABLE\" SET \"$COLUMN_NAME\"=REPLACE(\"$COLUMN_NAME\", ',$old_sql,', ',$new_sql,') WHERE \"$COLUMN_NAME\" LIKE '%,$old_like,%';"
        # 3. начало списка: old,
        DATA_UPDATE+="UPDATE \"$PHYSICAL_TABLE\" SET \"$COLUMN_NAME\"=REPLACE(\"$COLUMN_NAME\", '$old_sql,', '$new_sql,') WHERE \"$COLUMN_NAME\" LIKE '$old_like,%';"
        # 4. конец списка: ,old
        DATA_UPDATE+="UPDATE \"$PHYSICAL_TABLE\" SET \"$COLUMN_NAME\"=REPLACE(\"$COLUMN_NAME\", ',$old_sql', ',$new_sql') WHERE \"$COLUMN_NAME\" LIKE '%,$old_like';"
        # 5. JSON-страховка: "old"
        DATA_UPDATE+="UPDATE \"$PHYSICAL_TABLE\" SET \"$COLUMN_NAME\"=REPLACE(\"$COLUMN_NAME\", '\"$old_sql\"', '\"$new_sql\"') WHERE INSTR(\"$COLUMN_NAME\", '\"$old_sql\"') > 0;"
    fi
    if [ -n "$ROW_COUNT" ] && [ "$ROW_COUNT" -gt 0 ] 2>/dev/null; then
        log "   ⚠️  Переименование затронет данные: $ROW_COUNT записей будет обновлено."
    else
        log "   ℹ️  Записей с этим значением нет — только сама опция."
    fi
fi

# === ВЫПОЛНЕНИЕ ТРАНЗАКЦИИ С .bail on ===
log "🔒 Выполнение транзакции..."
set +e
SQLITE_OUTPUT=$(sqlite3 "$NOCO_DB" 2>&1 <<EOF
.bail on
BEGIN TRANSACTION;

$OPT_UPDATE

$DATA_UPDATE

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

log "✅ Транзакция успешно завершена."

# === ПЕРЕЗАПУСК (с возможностью пропуска) ===
if [ "${SKIP_RESTART:-0}" != "1" ]; then
    log "🔄 Перезапуск NocoDB..."
    docker restart nocodb 2>/dev/null || docker restart printed4u-nocodb 2>/dev/null || log "⚠️  Перезапустите NocoDB вручную."
else
    log "⏭️  Пропуск перезапуска (SKIP_RESTART=1)"
fi

if [ "$DO_RENAME" -eq 1 ]; then
    log "✅ Опция переименована: '$OLD_NAME' → '$NEW_NAME' ($TABLE_TITLE/$COLUMN_TITLE)"
else
    log "✅ Опция перекрашена: '$OLD_NAME' → $NEW_COLOR ($TABLE_TITLE/$COLUMN_TITLE)"
fi
log "   📦 Бэкап: $BACKUP_FILE"
log "   📝 Лог: $LOG_FILE"

