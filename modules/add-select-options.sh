#!/bin/bash
# modules/add-select-options.sh v1.1.0 — Добавление опций в существующий SELECT/MULTISELECT через прямой доступ к SQLite NocoDB
# 
# Использование:
#   bash modules/add-select-options.sh "Таблица" "Колонка" "Опция1,Опция2,Опция3"
#   bash modules/add-select-options.sh "Таблица" "Колонка" "Опция1:#RRGGBB,Опция2,Опция3:#RRGGBBAA"
#   SKIP_RESTART=1 bash modules/add-select-options.sh "Таблица" "Колонка" "Опция1"  # без перезапуска NocoDB
#   NOCO_DB=/путь/к/noco.db bash modules/add-select-options.sh "Таблица" "Колонка" "Опция1"  # тест на копии БД
#
# Примеры:
#   bash modules/add-select-options.sh "Проекты" "Статус" "Пауза,Отменён"
#   bash modules/add-select-options.sh "Проекты" "Статус" "Пауза:#f57c00,Отменён:#d32f2f,В работе"
#   bash modules/add-select-options.sh "Документы" "Тип документа" "Акт сверки:#1565c0"
#   bash modules/add-select-options.sh "Позиции заказа" "Тип" "Услуга,Материал"
#
# Цвет опции (опционально): указывается через двоеточие "Опция:#RRGGBB" или
# "Опция:#RRGGBBAA" (в базе встречаются оба формата). Без цвета — авто-цвет
# из палитры по кругу (как в add-column.sh). Смешивать можно свободно.
#
# Особенности v1.1.0:
#   ✅ Индивидуальный цвет опции: "Опция:#RRGGBB" / "Опция:#RRGGBBAA" (v1.1.0)
#   ✅ Валидация hex-цвета: ":#" без корректного hex — явная ошибка + exit 1
#   ✅ Работает ТОЛЬКО с колонками SingleSelect/MultiSelect (иначе — отказ)
#   ✅ Идемпотентность: уже существующие опции пропускаются с предупреждением
#   ✅ Автобэкап БД перед изменениями (правило 7)
#   ✅ Все SQL в одной транзакции через heredoc с .bail on (откат при ошибке, Проблема 42)
#   ✅ set +e / set -e для корректного получения exit code (Проблема 44)
#   ✅ Экранирование одинарных кавычек в названиях опций
#   ✅ Порядок продолжается с MAX(order)+1, автоцвета из палитры (как в add-column.sh)
#   ✅ Логирование всех действий в /mnt/data/nocodb-data/column-migrations.log
#   ✅ Флаг SKIP_RESTART и переопределение NOCO_DB для тестов
#
# Ограничение: опции разделяются запятой (как в add-column.sh) — запятая внутри
# названия опции не поддерживается. Название не может содержать ":##hex" в конце
# (воспринимается как цвет).

set -e

# === АРГУМЕНТЫ ===
TABLE_TITLE="$1"
COLUMN_TITLE="$2"
NEW_OPTIONS="${3:-}"

# === КОНФИГУРАЦИЯ ===
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
LOG_FILE="${LOG_FILE:-/mnt/data/nocodb-data/column-migrations.log}"
BACKUP_DIR="${BACKUP_DIR:-/mnt/data/backups}"

# === ВАЛИДАЦИЯ ===
if [ -z "$TABLE_TITLE" ] || [ -z "$COLUMN_TITLE" ] || [ -z "$NEW_OPTIONS" ]; then
    echo "❌ Ошибка: Укажите таблицу, колонку и список опций через запятую."
    echo "Пример: bash modules/add-select-options.sh \"Проекты\" \"Статус\" \"Пауза,Отменён\""
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
    local backup_file="$BACKUP_DIR/noco-before-add-select-$(date '+%Y%m%d-%H%M%S').db"
    cp "$NOCO_DB" "$backup_file"
    log "💾 Бэкап создан: $backup_file"
    BACKUP_FILE="$backup_file"
}

# === НАЧАЛО РАБОТЫ ===
log "🔧 Добавление опций в '$COLUMN_TITLE' ($TABLE_TITLE): $NEW_OPTIONS..."
backup_db

BASE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_bases_v2 LIMIT 1;")
SOURCE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_sources_v2 WHERE base_id='$BASE_ID' LIMIT 1;")
WORKSPACE_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM workspace LIMIT 1;")

if [ -z "$BASE_ID" ] || [ -z "$SOURCE_ID" ]; then
    log "❌ Ошибка: Не удалось найти base/source."
    exit 1
fi
if [ -n "$WORKSPACE_ID" ]; then
    WS_SQL="'$WORKSPACE_ID'"
    log "✅ Base: $BASE_ID | Source: $SOURCE_ID | Workspace: $WORKSPACE_ID"
else
    # Эталон (template.db) очищен export-template.sh: workspace пуст.
    # По конвенции шаблона fk_workspace_id=NULL (как у остальных опций в template.db).
    WS_SQL="NULL"
    log "⚠️  Workspace не найден (очищен в эталоне template.db) — fk_workspace_id=NULL (конвенция шаблона)."
fi

MODEL_INFO=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_models_v2 WHERE title='$TABLE_TITLE' AND base_id='$BASE_ID' LIMIT 1;")
if [ -z "$MODEL_INFO" ]; then
    log "❌ Ошибка: Таблица '$TABLE_TITLE' не найдена."
    sqlite3 "$NOCO_DB" "SELECT '  - ' || title FROM nc_models_v2 WHERE base_id='$BASE_ID';"
    exit 1
fi
MODEL_ID="$MODEL_INFO"

# === ПОИСК КОЛОНКИ ===
COLUMN_INFO=$(sqlite3 "$NOCO_DB" "SELECT id, column_name, uidt FROM nc_columns_v2 WHERE fk_model_id='$MODEL_ID' AND (title='$COLUMN_TITLE' OR column_name='$COLUMN_TITLE') LIMIT 1;")
if [ -z "$COLUMN_INFO" ]; then
    log "❌ Ошибка: Колонка '$COLUMN_TITLE' не найдена в таблице '$TABLE_TITLE'."
    exit 1
fi

COLUMN_ID=$(echo "$COLUMN_INFO" | cut -d'|' -f1)
COLUMN_NAME=$(echo "$COLUMN_INFO" | cut -d'|' -f2)
COLUMN_UIDT=$(echo "$COLUMN_INFO" | cut -d'|' -f3)

log "✅ Колонка найдена: ID=$COLUMN_ID, name=$COLUMN_NAME, type=$COLUMN_UIDT"

# === ВАЛИДАЦИЯ ТИПА ===
if [[ "$COLUMN_UIDT" != "SingleSelect" && "$COLUMN_UIDT" != "MultiSelect" ]]; then
    log "❌ Ошибка: Колонка '$COLUMN_TITLE' имеет тип $COLUMN_UIDT, а не SingleSelect/MultiSelect."
    log "   Добавление опций возможно только в поля-селекты."
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

# === РАЗБОР НОВЫХ ОПЦИЙ И ПРОВЕРКА ДУБЛИКАТОВ ===
COLORS=("#cfdffe" "#d0f1fd" "#c2f5e8" "#fff9c4" "#ffe0b2" "#ffc9fd" "#ffd5f5" "#e0e0e0" "#b3e5fc" "#dcedc8")
MAX_ORDER=$(sqlite3 "$NOCO_DB" "SELECT COALESCE(MAX(\"order\"), 0) FROM nc_col_select_options_v2 WHERE fk_column_id='$COLUMN_ID';")

SELECT_INSERTS=""
TO_ADD=0
SKIPPED=0

IFS=',' read -ra OPT_ARRAY <<< "$NEW_OPTIONS"
for opt in "${OPT_ARRAY[@]}"; do
    # Обрезаем пробелы по краям (чтобы "Опция1, Опция2" работало)
    opt=$(echo "$opt" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    if [ -z "$opt" ]; then
        continue
    fi

    # Разбор необязательного цвета: "Опция:#RRGGBB" или "Опция:#RRGGBBAA"
    opt_title="$opt"
    opt_color=""
    if [[ "$opt" =~ ^(.*):(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?)$ ]]; then
        opt_title="${BASH_REMATCH[1]}"
        opt_color="${BASH_REMATCH[2]}"
        opt_title=$(echo "$opt_title" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
        if [ -z "$opt_title" ]; then
            log "❌ Ошибка: задан цвет, но пустое название опции: '$opt'"
            exit 1
        fi
    elif [[ "$opt" =~ ^.*:#.*$ ]]; then
        # Есть ":#", но это не валидный hex — молча записать в title нельзя
        log "❌ Ошибка: некорректный цвет в '$opt'. Формат: Опция:#RRGGBB или Опция:#RRGGBBAA"
        exit 1
    fi

    # Идемпотентность: пропускаем уже существующие (точное совпадение по title)
    if echo "$CURRENT_OPTIONS" | grep -Fxq "$opt_title"; then
        log "⏭️  Опция '$opt_title' уже существует — пропускаем."
        SKIPPED=$((SKIPPED + 1))
        continue
    fi

    # Экранирование одинарных кавычек для SQL
    opt_sql=$(echo "$opt_title" | sed "s/'/''/g")

    OPT_ID=$(head /dev/urandom | tr -dc 'a-z0-9' | fold -w 15 | head -n 1)
    if [ -n "$opt_color" ]; then
        COLOR="$opt_color"
    else
        COLOR=${COLORS[$(( TO_ADD % ${#COLORS[@]} ))]}
    fi
    NEW_ORDER=$(echo "$MAX_ORDER + $TO_ADD + 1" | bc)

    SELECT_INSERTS+="INSERT INTO nc_col_select_options_v2 (id, fk_column_id, title, color, \"order\", base_id, fk_workspace_id) VALUES ('$OPT_ID', '$COLUMN_ID', '$opt_sql', '$COLOR', $NEW_ORDER, '$BASE_ID', $WS_SQL);"$'\n'
    log "  ✅ Новая опция: $opt_title (цвет: $COLOR, порядок: $NEW_ORDER)"
    TO_ADD=$((TO_ADD + 1))
done

if [ "$TO_ADD" -eq 0 ]; then
    log "⏭️  Нет новых опций для добавления — все уже существуют. БД не менялась."
    exit 0
fi

# === ВЫПОЛНЕНИЕ ТРАНЗАКЦИИ С .bail on ===
log "🔒 Выполнение транзакции ($TO_ADD новых, $SKIPPED пропущено)..."
set +e
SQLITE_OUTPUT=$(sqlite3 "$NOCO_DB" 2>&1 <<EOF
.bail on
BEGIN TRANSACTION;

$SELECT_INSERTS

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

log "✅ Транзакция успешно завершена: добавлено опций: $TO_ADD, пропущено: $SKIPPED"

# === ПЕРЕЗАПУСК (с возможностью пропуска) ===
if [ "${SKIP_RESTART:-0}" != "1" ]; then
    log "🔄 Перезапуск NocoDB..."
    docker restart nocodb 2>/dev/null || docker restart printed4u-nocodb 2>/dev/null || log "⚠️  Перезапустите NocoDB вручную."
else
    log "⏭️  Пропуск перезапуска (SKIP_RESTART=1)"
fi

log "✅ Опции добавлены в '$COLUMN_TITLE' ($TABLE_TITLE)! Колонка: $COLUMN_NAME"
log "   📦 Бэкап: $BACKUP_FILE"
log "   📝 Лог: $LOG_FILE"
