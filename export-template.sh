#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Экспорт рабочей базы в шаблон template.db v3.0.3     ║${NC}"
echo -e "${BLUE}║   🆕 Нормализация order + установка is_default        ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

DB_PATH="/mnt/data/nocodb-data/noco.db"
TEMPLATE="template.db"
BACKUP="/tmp/noco_export_backup_$(date +%Y%m%d_%H%M%S).db"

# Проверка, что NocoDB запущен
if ! sudo docker ps | grep -q nocodb; then
    echo -e "${RED}❌ NocoDB не запущен!${NC}"
    exit 1
fi

# ============================================
# ШАГ 1: Бэкап текущей рабочей базы
# ============================================
echo -e "${BLUE}📦 Шаг 1/12: Делаю бэкап рабочей базы...${NC}"
sudo cp "$DB_PATH" "$BACKUP"
echo -e "${GREEN}✅ Бэкап создан: $BACKUP${NC}"
echo ""

# ============================================
# ШАГ 2: Останавливаем NocoDB
# ============================================
echo -e "${BLUE}🛑 Шаг 2/12: Останавливаю NocoDB...${NC}"
sudo docker stop nocodb
sleep 3
echo -e "${GREEN}✅ NocoDB остановлен${NC}"
echo ""

# ============================================
# ШАГ 3: Копируем базу в template.db
# ============================================
echo -e "${BLUE}📋 Шаг 3/12: Копирую базу в template.db...${NC}"
cp "$DB_PATH" "$TEMPLATE"
chmod 644 "$TEMPLATE"
echo -e "${GREEN}✅ Скопировано${NC}"
echo ""

# ============================================
# ШАГ 4: Удаляем workspace и пользователей
# ============================================
echo -e "${BLUE}🗑️  Шаг 4/12: Удаляю workspace и пользователей...${NC}"
sqlite3 "$TEMPLATE" "DELETE FROM workspace;" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM workspace_user;" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM nc_org;" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM nc_org_users;" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM nc_users_v2;"
sqlite3 "$TEMPLATE" "DELETE FROM nc_user_refresh_tokens;"
sqlite3 "$TEMPLATE" "DELETE FROM nc_api_tokens;"
sqlite3 "$TEMPLATE" "DELETE FROM nc_base_users_v2;"
echo -e "${GREEN}✅ Удалено${NC}"
echo ""

# ============================================
# ШАГ 5: Удаляем секреты
# ============================================
echo -e "${BLUE}🔑 Шаг 5/12: Удаляю секреты...${NC}"
sqlite3 "$TEMPLATE" "DELETE FROM nc_store WHERE key IN ('NC_DEFAULT_WORKSPACE_ID', 'nc_auth_jwt_secret', 'nc_server_id');" 2>/dev/null || true
echo -e "${GREEN}✅ Удалено${NC}"
echo ""

# ============================================
# ШАГ 6: Удаляем старые базы (УНИВЕРСАЛЬНО, без хардкода)
# ============================================
echo -e "${BLUE}🗑️  Шаг 6/12: Удаляю старые базы и их метаданные...${NC}"

CRM_BASE_ID=$(sqlite3 "$TEMPLATE" "SELECT id FROM nc_bases_v2 LIMIT 1;")
if [ -z "$CRM_BASE_ID" ]; then
    echo -e "${RED}❌ База CRM не найдена!${NC}"
    sudo docker start nocodb
    exit 1
fi
echo "   CRM Base ID: $CRM_BASE_ID"

sqlite3 "$TEMPLATE" "DELETE FROM nc_bases_v2 WHERE id != '$CRM_BASE_ID';"
sqlite3 "$TEMPLATE" "DELETE FROM nc_sources_v2 WHERE base_id != '$CRM_BASE_ID';"
sqlite3 "$TEMPLATE" "DELETE FROM nc_models_v2 WHERE base_id != '$CRM_BASE_ID';"
sqlite3 "$TEMPLATE" "DELETE FROM nc_models_v2 WHERE table_name = '' OR table_name IS NULL;"

echo -e "${GREEN}✅ Удалено${NC}"
echo ""

# ============================================
# ШАГ 7: Удаляем физические таблицы других баз (ИСПРАВЛЕНО!)
# ============================================
echo -e "${BLUE}🗑️  Шаг 7/12: Удаляю физические таблицы других баз...${NC}"

VALID_TABLES=$(sqlite3 "$TEMPLATE" "SELECT table_name FROM nc_models_v2 WHERE table_name IS NOT NULL AND table_name != '';")
ALL_NC_TABLES=$(sqlite3 "$TEMPLATE" "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'nc_%' AND INSTR(name, '___') > 0;")

DELETED_COUNT=0
echo "$ALL_NC_TABLES" | while IFS= read -r TABLE; do
    if [ -n "$TABLE" ]; then
        if ! echo "$VALID_TABLES" | grep -qF "$TABLE"; then
            sqlite3 "$TEMPLATE" "DROP TABLE IF EXISTS \"$TABLE\";"
            echo "   🗑️  Удалена: $TABLE"
            DELETED_COUNT=$((DELETED_COUNT + 1))
        fi
    fi
done
echo -e "${GREEN}✅ Удалено физических таблиц: $DELETED_COUNT${NC}"
echo ""

# ============================================
# ШАГ 8: 🔥 Чистим ВСЕ сиротские записи
# ============================================
echo -e "${BLUE}🧹 Шаг 8/12: Очищаю сиротские записи...${NC}"

# 8.1. Сиротские колонки
sqlite3 "$TEMPLATE" "DELETE FROM nc_columns_v2 WHERE fk_model_id NOT IN (SELECT id FROM nc_models_v2);"

# 8.2. Сиротские views
sqlite3 "$TEMPLATE" "DELETE FROM nc_views_v2 WHERE fk_model_id NOT IN (SELECT id FROM nc_models_v2);"

# 8.3. Сиротские связи
sqlite3 "$TEMPLATE" "DELETE FROM nc_col_relations_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);"
sqlite3 "$TEMPLATE" "DELETE FROM nc_col_relations_v2 WHERE fk_related_model_id NOT IN (SELECT id FROM nc_models_v2);"

# 8.4. Сиротские колонки в views (ВСЕ 9 типов views)
for VIEW_TABLE in nc_grid_view_columns_v2 nc_gallery_view_columns_v2 nc_kanban_view_columns_v2 \
                  nc_form_view_columns_v2 nc_calendar_view_columns_v2 nc_map_view_columns_v2 \
                  nc_timeline_view_columns_v2 nc_gantt_view_columns_v2 nc_list_view_columns_v2; do
    sqlite3 "$TEMPLATE" "DELETE FROM $VIEW_TABLE WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);" 2>/dev/null || true
    sqlite3 "$TEMPLATE" "DELETE FROM $VIEW_TABLE WHERE fk_view_id NOT IN (SELECT id FROM nc_views_v2);" 2>/dev/null || true
done

# 8.5. Сиротские фильтры и сортировки
sqlite3 "$TEMPLATE" "DELETE FROM nc_filter_exp_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM nc_filter_exp_v2 WHERE fk_view_id NOT IN (SELECT id FROM nc_views_v2);" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM nc_sort_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM nc_sort_v2 WHERE fk_view_id NOT IN (SELECT id FROM nc_views_v2);" 2>/dev/null || true

# 8.6. Сиротские опции Select
sqlite3 "$TEMPLATE" "DELETE FROM nc_col_select_options_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);" 2>/dev/null || true

# 8.7. Сиротские хуки
sqlite3 "$TEMPLATE" "DELETE FROM nc_hooks_v2 WHERE fk_model_id NOT IN (SELECT id FROM nc_models_v2);" 2>/dev/null || true

# 8.8. Сиротские формулы, lookup, rollup, barcode, button, qrcode
for COL_TABLE in nc_col_formula_v2 nc_col_lookup_v2 nc_col_rollup_v2 nc_col_barcode_v2 nc_col_button_v2 nc_col_qrcode_v2 nc_col_long_text_v2; do
    sqlite3 "$TEMPLATE" "DELETE FROM $COL_TABLE WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);" 2>/dev/null || true
done

# ============================================
# 🆕 ШАГ 8.9: НОРМАЛИЗАЦИЯ ORDER В VIEW-КОЛОНКАХ
# ============================================
# После удаления сиротских записей нормализуем order,
# чтобы каждая колонка в каждом view имела уникальную
# последовательную позицию (1, 2, 3...).
# Это предотвращает баг NocoDB UI с дубликатами order,
# из-за которого невозможно перетаскивать/скрывать/удалять.
echo -e "${BLUE}   📐 Подшаг 8.9: Нормализация order в view-колонках...${NC}"

for VIEW_TABLE in nc_grid_view_columns_v2 nc_gallery_view_columns_v2 nc_kanban_view_columns_v2 \
                  nc_form_view_columns_v2 nc_calendar_view_columns_v2 nc_map_view_columns_v2 \
                  nc_timeline_view_columns_v2 nc_gantt_view_columns_v2 nc_list_view_columns_v2; do
    sqlite3 "$TEMPLATE" "
    DROP TABLE IF EXISTS tmp_norm;
    CREATE TEMP TABLE tmp_norm AS
    SELECT id, ROW_NUMBER() OVER (PARTITION BY fk_view_id ORDER BY \"order\", id) as new_order
    FROM $VIEW_TABLE;
    UPDATE $VIEW_TABLE
    SET \"order\" = (SELECT new_order FROM tmp_norm WHERE tmp_norm.id = $VIEW_TABLE.id);
    DROP TABLE IF EXISTS tmp_norm;
    " 2>/dev/null || true
done

# Проверяем результат нормализации
ORDER_DUPES_AFTER=$(sqlite3 "$TEMPLATE" "
SELECT COUNT(*) FROM (
    SELECT fk_view_id, \"order\", COUNT(*) as cnt
    FROM nc_grid_view_columns_v2
    GROUP BY fk_view_id, \"order\"
    HAVING cnt > 1
);" 2>/dev/null || echo "0")

if [ "$ORDER_DUPES_AFTER" -eq 0 ]; then
    echo -e "${GREEN}   ✅ order нормализован, дубликатов: 0${NC}"
else
    echo -e "${YELLOW}   ⚠️  После нормализации осталось дубликатов order: $ORDER_DUPES_AFTER${NC}"
fi

# ============================================
# 🆕 ШАГ 8.10: УСТАНОВКА is_default ДЛЯ VIEWS
# ============================================
# Каждая модель должна иметь хотя бы один дефолтный view.
# Ставим is_default=1 на первый grid view (type=3) каждой модели.
# Без этого NocoDB UI может некорректно работать с views.
echo -e "${BLUE}   ⭐ Подшаг 8.10: Установка is_default для views...${NC}"

sqlite3 "$TEMPLATE" "
UPDATE nc_views_v2 SET is_default = 0;

UPDATE nc_views_v2 SET is_default = 1
WHERE id IN (
    SELECT v.id FROM nc_views_v2 v
    INNER JOIN (
        SELECT fk_model_id, MIN(created_at) as min_created
        FROM nc_views_v2
        WHERE type = 3
        GROUP BY fk_model_id
    ) first_grid ON v.fk_model_id = first_grid.fk_model_id AND v.created_at = first_grid.min_created
    WHERE v.type = 3
);
" 2>/dev/null || true

DEFAULT_COUNT=$(sqlite3 "$TEMPLATE" "SELECT COUNT(*) FROM nc_views_v2 WHERE is_default = 1;")
echo -e "${GREEN}   ✅ Дефолтных views: $DEFAULT_COUNT${NC}"

echo -e "${GREEN}✅ Сиротские записи удалены, order нормализован, is_default установлен${NC}"
echo ""

# ============================================
# ШАГ 9: Заполняем nc_sources_v2.config
# ============================================
echo -e "${BLUE}🔧 Шаг 9/12: Заполняю nc_sources_v2.config...${NC}"
sqlite3 "$TEMPLATE" "UPDATE nc_sources_v2 SET config = '{\"client\":\"sqlite3\",\"connection\":{\"client\":\"sqlite3\",\"filename\":\"/usr/app/data/noco.db\"}}' WHERE type = 'sqlite3';"
echo -e "${GREEN}✅ config заполнен${NC}"
echo ""

# ============================================
# ШАГ 10: Полная очистка fk_workspace_id
# ============================================
echo -e "${BLUE}🔧 Шаг 10/12: Очищаю fk_workspace_id во всех таблицах...${NC}"

for TABLE in nc_bases_v2 nc_sources_v2 nc_models_v2 nc_columns_v2 nc_views_v2 \
             nc_grid_view_columns_v2 nc_gallery_view_columns_v2 nc_kanban_view_columns_v2 \
             nc_form_view_columns_v2 nc_calendar_view_columns_v2 nc_map_view_columns_v2 \
             nc_timeline_view_columns_v2 nc_gantt_view_columns_v2 nc_list_view_columns_v2 \
             nc_col_relations_v2 nc_col_select_options_v2 nc_filter_exp_v2 nc_sort_v2 nc_hooks_v2; do
    sqlite3 "$TEMPLATE" "UPDATE $TABLE SET fk_workspace_id = NULL;" 2>/dev/null || true
done

echo -e "${GREEN}✅ fk_workspace_id очищен во всех таблицах${NC}"
echo ""

# ============================================
# ШАГ 11: Очищаем данные и логи, делаем VACUUM
# ============================================
echo -e "${BLUE}🧹 Шаг 11/12: Очищаю данные, логи и делаю VACUUM...${NC}"

sqlite3 "$TEMPLATE" "DELETE FROM \"nc_nw7q___Сотрудники\";" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM \"nc_nw7q___nc_m2m_Дела_Сотрудники\";" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM \"nc_nw7q___nc_m2m_Проекты_Сотрудники\";" 2>/dev/null || true

sqlite3 "$TEMPLATE" "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'nc_nw7q___%';" | while IFS= read -r TABLE; do
    if [ -n "$TABLE" ]; then
        sqlite3 "$TEMPLATE" "DELETE FROM \"$TABLE\";"
    fi
done

sqlite3 "$TEMPLATE" "DELETE FROM nc_audit_v2;" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM nc_operation_logs;" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM nc_hook_logs_v2;" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM nc_automation_executions;" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM sqlite_sequence;" 2>/dev/null || true

echo -e "${GREEN}✅ Данные и логи очищены${NC}"
echo ""

# ============================================
# ШАГ 12: Очистка системных данных NocoDB (комментарии, реакции, уведомления)
# ============================================
echo -e "${BLUE}🧹 Шаг 12/12: Очищаю системные данные NocoDB (комментарии, реакции, уведомления)...${NC}"

sqlite3 "$TEMPLATE" "DELETE FROM nc_comments;" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM nc_comment_reactions;" 2>/dev/null || true
sqlite3 "$TEMPLATE" "DELETE FROM nc_user_comment_notifications_preference;" 2>/dev/null || true

echo -e "${GREEN}✅ Системные данные NocoDB очищены${NC}"
echo ""

# ============================================
# VACUUM для уменьшения размера (после всех удалений)
# ============================================
echo -e "${BLUE}📦 Сжимаю базу (VACUUM)...${NC}"
sqlite3 "$TEMPLATE" "VACUUM;"
echo -e "${GREEN}✅ База сжата${NC}"
echo ""

# ============================================
# Запускаем NocoDB обратно
# ============================================
echo -e "${BLUE}🚀 Запускаю NocoDB обратно...${NC}"
sudo docker start nocodb
sleep 5
echo -e "${GREEN}✅ NocoDB запущен${NC}"
echo ""

# ============================================
# Финальная валидация
# ============================================
echo -e "${BLUE}🔍 Финальная валидация:${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"

sqlite3 "$TEMPLATE" "SELECT '📦 Базы: ' || COUNT(*) FROM nc_bases_v2;"
sqlite3 "$TEMPLATE" "SELECT '🔌 Источники: ' || COUNT(*) FROM nc_sources_v2;"
sqlite3 "$TEMPLATE" "SELECT '📊 Модели CRM: ' || COUNT(*) FROM nc_models_v2;"
sqlite3 "$TEMPLATE" "SELECT '📋 Колонки: ' || COUNT(*) FROM nc_columns_v2;"
sqlite3 "$TEMPLATE" "SELECT '👁️  Views: ' || COUNT(*) FROM nc_views_v2;"
sqlite3 "$TEMPLATE" "SELECT '🏢 Workspace: ' || COUNT(*) FROM workspace;"
sqlite3 "$TEMPLATE" "SELECT '👤 Пользователи: ' || COUNT(*) FROM nc_users_v2;"
sqlite3 "$TEMPLATE" "SELECT '💬 Комментарии: ' || COUNT(*) FROM nc_comments;"
sqlite3 "$TEMPLATE" "SELECT '📁 Физ. таблицы CRM: ' || COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'nc_nw7q___%';"

echo ""
echo -e "${YELLOW}🔗 Проверка сиротских записей:${NC}"
sqlite3 "$TEMPLATE" "SELECT '   Сиротских связей: ' || COUNT(*) FROM nc_col_relations_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);"
sqlite3 "$TEMPLATE" "SELECT '   Сиротских в grid: ' || COUNT(*) FROM nc_grid_view_columns_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);"
sqlite3 "$TEMPLATE" "SELECT '   Сиротских в gallery: ' || COUNT(*) FROM nc_gallery_view_columns_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);"
sqlite3 "$TEMPLATE" "SELECT '   Сиротских в kanban: ' || COUNT(*) FROM nc_kanban_view_columns_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);"
sqlite3 "$TEMPLATE" "SELECT '   Сиротских filters: ' || COUNT(*) FROM nc_filter_exp_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);"
sqlite3 "$TEMPLATE" "SELECT '   Сиротских sorts: ' || COUNT(*) FROM nc_sort_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);"

echo ""
echo -e "${YELLOW}📊 Проверка дубликатов order:${NC}"
ORDER_DUPES_TOTAL=$(sqlite3 "$TEMPLATE" "
SELECT COUNT(*) FROM (
    SELECT fk_view_id, \"order\", COUNT(*) as cnt
    FROM nc_grid_view_columns_v2
    GROUP BY fk_view_id, \"order\"
    HAVING cnt > 1
);" 2>/dev/null || echo "0")
echo "   Дубликатов order в grid views: $ORDER_DUPES_TOTAL"

echo ""
echo -e "${YELLOW}⭐ Проверка дефолтных views:${NC}"
DEFAULT_VIEWS=$(sqlite3 "$TEMPLATE" "SELECT COUNT(*) FROM nc_views_v2 WHERE is_default = 1;")
TOTAL_GRID_MODELS=$(sqlite3 "$TEMPLATE" "SELECT COUNT(DISTINCT fk_model_id) FROM nc_views_v2 WHERE type = 3;")
echo "   Дефолтных views: $DEFAULT_VIEWS из $TOTAL_GRID_MODELS моделей с grid views"

echo ""
echo -e "${YELLOW}📦 Проверка config и workspace:${NC}"
sqlite3 "$TEMPLATE" "SELECT '   config: ' || CASE WHEN config IS NULL OR config = '' THEN '❌ ПУСТОЙ' ELSE '✅ заполнен' END FROM nc_sources_v2 LIMIT 1;"
sqlite3 "$TEMPLATE" "SELECT '   fk_workspace_id: ' || CASE WHEN fk_workspace_id IS NULL OR fk_workspace_id = '' THEN '✅ NULL' ELSE '❌ ' || fk_workspace_id END FROM nc_models_v2 LIMIT 1;"

echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Проверка на ошибки
ORPHAN_TOTAL=$(sqlite3 "$TEMPLATE" "
SELECT 
    (SELECT COUNT(*) FROM nc_col_relations_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2)) +
    (SELECT COUNT(*) FROM nc_grid_view_columns_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2)) +
    (SELECT COUNT(*) FROM nc_gallery_view_columns_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2)) +
    (SELECT COUNT(*) FROM nc_kanban_view_columns_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2)) +
    (SELECT COUNT(*) FROM nc_filter_exp_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2)) +
    (SELECT COUNT(*) FROM nc_sort_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2));
")

COMMENTS_TOTAL=$(sqlite3 "$TEMPLATE" "SELECT COUNT(*) FROM nc_comments;" 2>/dev/null || echo "0")

if [ "$ORPHAN_TOTAL" -eq 0 ] && [ "$COMMENTS_TOTAL" -eq 0 ] && [ "$ORDER_DUPES_TOTAL" -eq 0 ] && [ "$DEFAULT_VIEWS" -ge "$TOTAL_GRID_MODELS" ]; then
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║   ✅ Шаблон template.db ГОТОВ и ЧИСТ!                    ║${NC}"
    echo -e "${GREEN}║   ✅ Комментарии NocoDB удалены                          ║${NC}"
    echo -e "${GREEN}║   ✅ Order нормализован (дубликатов: 0)                  ║${NC}"
    echo -e "${GREEN}║   ✅ is_default установлен ($DEFAULT_VIEWS/$TOTAL_GRID_MODELS)                    ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
else
    if [ "$ORPHAN_TOTAL" -gt 0 ]; then
        echo -e "${YELLOW}⚠️  Осталось сиротских записей: $ORPHAN_TOTAL${NC}"
    fi
    if [ "$COMMENTS_TOTAL" -gt 0 ]; then
        echo -e "${YELLOW}⚠️  Осталось комментариев: $COMMENTS_TOTAL${NC}"
    fi
    if [ "$ORDER_DUPES_TOTAL" -gt 0 ]; then
        echo -e "${YELLOW}⚠️  Осталось дубликатов order: $ORDER_DUPES_TOTAL${NC}"
    fi
    if [ "$DEFAULT_VIEWS" -lt "$TOTAL_GRID_MODELS" ]; then
        echo -e "${YELLOW}⚠️  Дефолтных views меньше чем моделей: $DEFAULT_VIEWS/$TOTAL_GRID_MODELS${NC}"
    fi
    echo -e "${YELLOW}   Проверьте вручную перед коммитом${NC}"
fi

echo ""
echo -e "${BLUE}📤 Следующие шаги:${NC}"
echo "   git add template.db export-template.sh"
echo '   git commit -m "🔧 export-template.sh v3.0.3 + нормализация order + is_default + чистый template.db"'
echo "   git push origin main"
echo ""
echo -e "${YELLOW}💾 Бэкап сохранён: $BACKUP${NC}"