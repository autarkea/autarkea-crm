#!/bin/bash
# modules/delete-view.sh v1.0.0 — Безопасное удаление view через SQLite NocoDB
#
# Обходит баг NocoDB UI (KnexTimeoutError при удалении view через интерфейс).
# Работает через прямой доступ к SQLite, как остальные модули ядра миграций.
#
# Использование:
#   bash modules/delete-view.sh "ИмяТаблицы" "ИмяView"
#   bash modules/delete-view.sh --id "vwXXXXXXXXXXXX"
#
# Примеры:
#   bash modules/delete-view.sh "Контакты" "Карточки контактов"
#   bash modules/delete-view.sh "Дела" "Календарь"
#   bash modules/delete-view.sh --id "vwp8ucycnpq3c8j2"
#
# Особенности v1.0.0:
#   ✅ Защита от удаления последнего view таблицы (таблица не может остаться без view)
#   ✅ Автопереназначение is_default при удалении дефолтного view
#   ✅ Каскадная очистка: колонки view, фильтры, сортировки
#   ✅ Поддержка всех типов view (grid, gallery, calendar, kanban, form и др.)
#   ✅ Автобэкап БД перед изменениями
#   ✅ .bail on в SQLite для мгновенного прерывания при ошибке
#   ✅ Явный ROLLBACK при сбое транзакции
#   ✅ Флаг SKIP_RESTART=1 для пропуска перезапуска NocoDB

set -e

# === АРГУМЕНТЫ ===
MODE="$1"
ARG2="$2"

# === КОНФИГУРАЦИЯ ===
NOCO_DB="/mnt/data/nocodb-data/noco.db"
LOG_FILE="/mnt/data/nocodb-data/column-migrations.log"
BACKUP_DIR="/mnt/data/backups"

# === ЛОГИРОВАНИЕ ===
log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
    echo "$msg"
    echo "$msg" >> "$LOG_FILE" 2>/dev/null || true
}

# === ВАЛИДАЦИЯ АРГУМЕНТОВ ===
if [ -z "$MODE" ]; then
    echo "❌ Ошибка: Укажите таблицу и view, либо ID view."
    echo ""
    echo "Использование:"
    echo "  bash modules/delete-view.sh \"ИмяТаблицы\" \"ИмяView\""
    echo "  bash modules/delete-view.sh --id \"vwXXXXXXXXXXXX\""
    echo ""
    echo "Примеры:"
    echo "  bash modules/delete-view.sh \"Контакты\" \"Карточки контактов\""
    echo "  bash modules/delete-view.sh \"Дела\" \"Календарь\""
    exit 1
fi

if [ ! -f "$NOCO_DB" ]; then
    echo "❌ Ошибка: Файл БД не найден: $NOCO_DB"
    exit 1
fi

# === АВТОБЭКАП ===
backup_db() {
    mkdir -p "$BACKUP_DIR"
    local backup_file="$BACKUP_DIR/noco-before-view-delete-$(date '+%Y%m%d-%H%M%S').db"
    cp "$NOCO_DB" "$backup_file"
    log "💾 Бэкап создан: $backup_file"
    BACKUP_FILE="$backup_file"
}

# === ПОИСК VIEW ===
if [ "$MODE" = "--id" ]; then
    # Режим поиска по ID view
    VIEW_ID="$ARG2"
    if [ -z "$VIEW_ID" ]; then
        log "❌ Ошибка: Не указан ID view."
        exit 1
    fi
    VIEW_INFO=$(sqlite3 "$NOCO_DB" "SELECT v.id, v.title, v.type, v.is_default, v.fk_model_id, m.title FROM nc_views_v2 v JOIN nc_models_v2 m ON v.fk_model_id = m.id WHERE v.id='$VIEW_ID';")
else
    # Режим поиска по названию таблицы + view
    TABLE_TITLE="$MODE"
    VIEW_TITLE="$ARG2"
    if [ -z "$TABLE_TITLE" ] || [ -z "$VIEW_TITLE" ]; then
        log "❌ Ошибка: Укажите имя таблицы и имя view."
        exit 1
    fi
    VIEW_INFO=$(sqlite3 "$NOCO_DB" "SELECT v.id, v.title, v.type, v.is_default, v.fk_model_id, m.title FROM nc_views_v2 v JOIN nc_models_v2 m ON v.fk_model_id = m.id WHERE m.title='$TABLE_TITLE' AND v.title='$VIEW_TITLE';")
fi

if [ -z "$VIEW_INFO" ]; then
    log "❌ Ошибка: View не найден."
    echo ""
    echo "Доступные views:"
    sqlite3 "$NOCO_DB" "SELECT m.title || ' → ' || v.title FROM nc_views_v2 v JOIN nc_models_v2 m ON v.fk_model_id = m.id ORDER BY m.title, v.title;"
    exit 1
fi

VIEW_ID=$(echo "$VIEW_INFO" | cut -d'|' -f1)
VIEW_TITLE=$(echo "$VIEW_INFO" | cut -d'|' -f2)
VIEW_TYPE=$(echo "$VIEW_INFO" | cut -d'|' -f3)
VIEW_IS_DEFAULT=$(echo "$VIEW_INFO" | cut -d'|' -f4)
MODEL_ID=$(echo "$VIEW_INFO" | cut -d'|' -f5)
TABLE_TITLE=$(echo "$VIEW_INFO" | cut -d'|' -f6)

# Расшифровка типа view
case "$VIEW_TYPE" in
    1) VIEW_TYPE_NAME="Form" ;;
    2) VIEW_TYPE_NAME="Gallery" ;;
    3) VIEW_TYPE_NAME="Grid" ;;
    4) VIEW_TYPE_NAME="Kanban" ;;
    5) VIEW_TYPE_NAME="Map" ;;
    6) VIEW_TYPE_NAME="Calendar" ;;
    7) VIEW_TYPE_NAME="Timeline" ;;
    8) VIEW_TYPE_NAME="Gantt" ;;
    *) VIEW_TYPE_NAME="Unknown($VIEW_TYPE)" ;;
esac

log "🗑️  Удаление view '$VIEW_TITLE' ($VIEW_TYPE_NAME) из таблицы '$TABLE_TITLE'..."
log "   View ID: $VIEW_ID | is_default: $VIEW_IS_DEFAULT"

# === ЗАЩИТА: ПОДСЧЁТ VIEWS У ТАБЛИЦЫ ===
VIEWS_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_views_v2 WHERE fk_model_id='$MODEL_ID';")

if [ "$VIEWS_COUNT" -le 1 ]; then
    log "❌ Ошибка: Это ЕДИНСТВЕННЫЙ view таблицы '$TABLE_TITLE'."
    log "💡 Таблица не может остаться без view. Создайте новый view перед удалением этого."
    exit 1
fi

log "✅ У таблицы '$TABLE_TITLE' найдено views: $VIEWS_COUNT (удаление безопасно)"

# === НАЧАЛО РАБОТЫ ===
backup_db

# === ПЕРЕОПРЕДЕЛЕНИЕ ДЕФОЛТА (если удаляется дефолтный view) ===
REASSIGN_SQL=""
if [ "$VIEW_IS_DEFAULT" = "1" ]; then
    log "⭐ Удаляется ДЕФОЛТНЫЙ view — переназначаю is_default на другой view..."
    
    # Ищем другой grid view той же модели (приоритет), иначе любой view
    NEW_DEFAULT_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_views_v2 WHERE fk_model_id='$MODEL_ID' AND id != '$VIEW_ID' AND type = 3 ORDER BY created_at LIMIT 1;")
    
    if [ -z "$NEW_DEFAULT_ID" ]; then
        NEW_DEFAULT_ID=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_views_v2 WHERE fk_model_id='$MODEL_ID' AND id != '$VIEW_ID' ORDER BY type, created_at LIMIT 1;")
    fi
    
    if [ -n "$NEW_DEFAULT_ID" ]; then
        REASSIGN_SQL="UPDATE nc_views_v2 SET is_default = 1 WHERE id = '$NEW_DEFAULT_ID';"
        NEW_DEFAULT_TITLE=$(sqlite3 "$NOCO_DB" "SELECT title FROM nc_views_v2 WHERE id='$NEW_DEFAULT_ID';")
        log "   ✅ Новый дефолтный view: '$NEW_DEFAULT_TITLE' ($NEW_DEFAULT_ID)"
    else
        log "⚠️  Не найден view для переназначения дефолта"
    fi
fi

# === ГЕНЕРАЦИЯ SQL ДЛЯ УДАЛЕНИЯ ===
# Удаляем колонки view из всех view_columns таблиц (безопасно — если записей нет, DELETE ничего не делает)
GV_DELETE="DELETE FROM nc_grid_view_columns_v2 WHERE fk_view_id='$VIEW_ID';"
GAL_DELETE="DELETE FROM nc_gallery_view_columns_v2 WHERE fk_view_id='$VIEW_ID';"
KAN_DELETE="DELETE FROM nc_kanban_view_columns_v2 WHERE fk_view_id='$VIEW_ID';"
FORM_DELETE="DELETE FROM nc_form_view_columns_v2 WHERE fk_view_id='$VIEW_ID';"
CAL_DELETE="DELETE FROM nc_calendar_view_columns_v2 WHERE fk_view_id='$VIEW_ID';"
MAP_DELETE="DELETE FROM nc_map_view_columns_v2 WHERE fk_view_id='$VIEW_ID';"
TIM_DELETE="DELETE FROM nc_timeline_view_columns_v2 WHERE fk_view_id='$VIEW_ID';"
GANTT_DELETE="DELETE FROM nc_gantt_view_columns_v2 WHERE fk_view_id='$VIEW_ID';"
LIST_DELETE="DELETE FROM nc_list_view_columns_v2 WHERE fk_view_id='$VIEW_ID';"

# Удаляем фильтры и сортировки этого view
FILTER_DELETE="DELETE FROM nc_filter_exp_v2 WHERE fk_view_id='$VIEW_ID';"
SORT_DELETE="DELETE FROM nc_sort_v2 WHERE fk_view_id='$VIEW_ID';"

# Удаляем сам view
VIEW_DELETE="DELETE FROM nc_views_v2 WHERE id='$VIEW_ID';"

# === ВЫПОЛНЕНИЕ ТРАНЗАКЦИИ С .bail on ===
log "🔒 Выполнение транзакции..."
set +e
SQLITE_OUTPUT=$(sqlite3 "$NOCO_DB" 2>&1 <<EOF
.bail on
BEGIN TRANSACTION;

$REASSIGN_SQL
$GV_DELETE
$GAL_DELETE
$KAN_DELETE
$FORM_DELETE
$CAL_DELETE
$MAP_DELETE
$TIM_DELETE
$GANTT_DELETE
$LIST_DELETE
$FILTER_DELETE
$SORT_DELETE
$VIEW_DELETE

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

# === ПРОВЕРКА РЕЗУЛЬТАТА ===
REMAINING=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_views_v2 WHERE id='$VIEW_ID';")
if [ "$REMAINING" -eq 0 ]; then
    log "✅ View '$VIEW_TITLE' полностью удалён из базы"
else
    log "⚠️  View всё ещё присутствует в базе (остатков: $REMAINING)"
fi

# Проверяем что у таблицы остался хотя бы один view
FINAL_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_views_v2 WHERE fk_model_id='$MODEL_ID';")
log "📊 Осталось views у таблицы '$TABLE_TITLE': $FINAL_COUNT"

# Проверяем что есть дефолтный view
DEFAULT_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_views_v2 WHERE fk_model_id='$MODEL_ID' AND is_default = 1;")
if [ "$DEFAULT_COUNT" -ge 1 ]; then
    log "✅ Дефолтный view у таблицы присутствует"
else
    log "⚠️  У таблицы нет дефолтного view — может потребоваться ручное исправление"
fi

# === ПЕРЕЗАПУСК (с возможностью пропуска) ===
if [ "${SKIP_RESTART:-0}" != "1" ]; then
    log "🔄 Перезапуск NocoDB..."
    docker restart nocodb 2>/dev/null || docker restart printed4u-nocodb 2>/dev/null || log "⚠️  Перезапустите NocoDB вручную."
else
    log "⏭️  Пропуск перезапуска (SKIP_RESTART=1)"
fi

log "✅ View '$VIEW_TITLE' ($VIEW_TYPE_NAME) безопасно удалён из '$TABLE_TITLE'!"
log "   📦 Бэкап: $BACKUP_FILE"
log "   📝 Лог: $LOG_FILE"