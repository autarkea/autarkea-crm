#!/bin/bash
# diagnose-upgrade.sh v1.1.0 — Полная диагностика после обновления NocoDB
# v1.1.0: Убран автотест миграций (зависал), добавлена проверка KnexTimeoutError
# Запуск: bash diagnose-upgrade.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS=0
FAIL=0
WARN=0

pass() { echo -e "${GREEN}✅ $1${NC}"; PASS=$((PASS + 1)); }
fail() { echo -e "${RED}❌ $1${NC}"; FAIL=$((FAIL + 1)); }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; WARN=$((WARN + 1)); }
info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
section() { echo -e "\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${CYAN}  $1${NC}"; echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  🔍 ПОЛНАЯ ДИАГНОСТИКА ПОСЛЕ ОБНОВЛЕНИЯ NocoDB v1.1.0     ║${NC}"
echo -e "${BLUE}║  printed4u-crm — dev-сервер                              ║${NC}"
echo -e "${BLUE}║  $(date '+%Y-%m-%d %H:%M:%S')                             ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"

NOCO_DB="/mnt/data/nocodb-data/noco.db"

# ═══════════════════════════════════════════════════════
# 1. КОНТЕЙНЕРЫ И СЕРВИСЫ
# ═══════════════════════════════════════════════════════
section "1. КОНТЕЙНЕРЫ И СЕРВИСЫ"

if docker ps --format '{{.Names}}' | grep -q "nocodb"; then
    NOCO_STATUS=$(docker ps --format '{{.Status}}' --filter name=nocodb)
    if echo "$NOCO_STATUS" | grep -q "healthy\|Up"; then
        pass "NocoDB запущен: $NOCO_STATUS"
    else
        fail "NocoDB работает некорректно: $NOCO_STATUS"
    fi
else
    fail "NocoDB контейнер не найден"
fi

if docker ps --format '{{.Names}}' | grep -q "bot"; then
    BOT_STATUS=$(docker ps --format '{{.Status}}' --filter name=bot)
    if echo "$BOT_STATUS" | grep -q "Up"; then
        pass "Bot запущен: $BOT_STATUS"
    else
        warn "Bot работает с проблемами: $BOT_STATUS"
    fi
else
    warn "Bot контейнер не найден (не установлен)"
fi

if docker ps --format '{{.Names}}' | grep -q "webhook"; then
    WH_STATUS=$(docker ps --format '{{.Status}}' --filter name=webhook)
    if echo "$WH_STATUS" | grep -q "Up"; then
        pass "Webhook запущен: $WH_STATUS"
    else
        warn "Webhook работает с проблемами: $WH_STATUS"
    fi
else
    warn "Webhook контейнер не найден (не установлен)"
fi

# ═══════════════════════════════════════════════════════
# 2. ВЕРСИЯ NocoDB
# ═══════════════════════════════════════════════════════
section "2. ВЕРСИЯ NocoDB"

NOCO_VERSION=$(curl -s http://localhost:8081/api/v1/version 2>/dev/null || echo "недоступен")
if [ "$NOCO_VERSION" != "недоступен" ]; then
    CURRENT=$(echo "$NOCO_VERSION" | jq -r '.currentVersion' 2>/dev/null || echo "?")
    RELEASE=$(echo "$NOCO_VERSION" | jq -r '.releaseVersion' 2>/dev/null || echo "?")
    info "Текущая версия API: $CURRENT"
    info "Актуальная версия: $RELEASE"
    
    if [ "$CURRENT" != "2026.06.2" ]; then
        pass "Версия обновлена: $CURRENT (была 2026.06.2)"
    else
        warn "Версия не изменилась: $CURRENT"
    fi
else
    fail "NocoDB API недоступен на localhost:8081"
fi

IMAGE_VERSION=$(docker inspect nocodb --format '{{.Config.Image}}' 2>/dev/null || echo "?")
info "Docker образ: $IMAGE_VERSION"

# ═══════════════════════════════════════════════════════
# 3. БАЗА ДАННЫХ — СТРУКТУРА
# ═══════════════════════════════════════════════════════
section "3. БАЗА ДАННЫХ — СТРУКТУРА"

if [ -f "$NOCO_DB" ]; then
    pass "Файл базы найден: $NOCO_DB"
    DB_SIZE=$(du -h "$NOCO_DB" | cut -f1)
    info "Размер базы: $DB_SIZE"
    
    WORKSPACE_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM workspace;" 2>/dev/null || echo "0")
    if [ "$WORKSPACE_COUNT" -gt 0 ]; then
        pass "Workspace существует: $WORKSPACE_COUNT"
    else
        fail "Workspace отсутствует"
    fi
    
    BASES_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_bases_v2;" 2>/dev/null || echo "0")
    if [ "$BASES_COUNT" -gt 0 ]; then
        pass "Базы: $BASES_COUNT"
    else
        fail "Базы отсутствуют"
    fi
    
    MODELS_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_models_v2 WHERE mm=0;" 2>/dev/null || echo "0")
    info "Бизнес-моделей: $MODELS_COUNT"
    
    TABLES_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'nc_nw7q___%';" 2>/dev/null || echo "0")
    info "Физических таблиц CRM: $TABLES_COUNT"
else
    fail "Файл базы не найден: $NOCO_DB"
fi

# ═══════════════════════════════════════════════════════
# 4. ДУБЛИКАТЫ ORDER В GRID VIEWS
# ═══════════════════════════════════════════════════════
section "4. ДУБЛИКАТЫ ORDER В GRID VIEWS"

ORDER_DUPES=$(sqlite3 "$NOCO_DB" "
SELECT COUNT(*) FROM (
    SELECT fk_view_id, \"order\", COUNT(*) as cnt
    FROM nc_grid_view_columns_v2
    GROUP BY fk_view_id, \"order\"
    HAVING cnt > 1
);" 2>/dev/null || echo "0")

if [ "$ORDER_DUPES" -eq 0 ]; then
    pass "Дубликатов order в grid views: 0"
else
    fail "Дубликатов order: $ORDER_DUPES (это ломает UI при перетаскивании колонок)"
    echo -e "   ${YELLOW}Детали:${NC}"
    sqlite3 "$NOCO_DB" "
    SELECT m.table_name, v.title, gvc.\"order\", COUNT(*) as cnt
    FROM nc_grid_view_columns_v2 gvc
    JOIN nc_views_v2 v ON gvc.fk_view_id = v.id
    JOIN nc_models_v2 m ON v.fk_model_id = m.id
    GROUP BY gvc.fk_view_id, gvc.\"order\"
    HAVING cnt > 1
    LIMIT 5;" 2>/dev/null
fi

echo -e "   ${BLUE}Последовательность order в grid views:${NC}"
sqlite3 "$NOCO_DB" "
SELECT m.table_name, COUNT(gvc.id) as cols,
       MIN(gvc.\"order\") as min_o, MAX(gvc.\"order\") as max_o,
       CASE WHEN MIN(gvc.\"order\") = 1 AND MAX(gvc.\"order\") = COUNT(gvc.id) 
            THEN '✅' ELSE '❌' END as status
FROM nc_views_v2 v
JOIN nc_models_v2 m ON v.fk_model_id = m.id
JOIN nc_grid_view_columns_v2 gvc ON gvc.fk_view_id = v.id
WHERE v.type = 3 AND m.mm = 0
GROUP BY v.id
ORDER BY m.table_name;" 2>/dev/null | while IFS='|' read -r table cols min_o max_o status; do
    echo "      $status $table: $cols колонок, order [$min_o..$max_o]"
done

# ═══════════════════════════════════════════════════════
# 5. is_default У VIEWS
# ═══════════════════════════════════════════════════════
section "5. ДЕФОЛТНЫЕ VIEWS (is_default)"

DEFAULT_VIEWS=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_views_v2 WHERE is_default = 1;" 2>/dev/null || echo "0")
TOTAL_GRID_MODELS=$(sqlite3 "$NOCO_DB" "SELECT COUNT(DISTINCT fk_model_id) FROM nc_views_v2 WHERE type = 3;" 2>/dev/null || echo "0")

if [ "$DEFAULT_VIEWS" -ge "$TOTAL_GRID_MODELS" ] && [ "$TOTAL_GRID_MODELS" -gt 0 ]; then
    pass "Дефолтных views: $DEFAULT_VIEWS из $TOTAL_GRID_MODELS моделей"
else
    fail "Дефолтных views: $DEFAULT_VIEWS из $TOTAL_GRID_MODELS моделей (должно быть ≥)"
    echo -e "   ${YELLOW}Это может ломать удаление view через UI${NC}"
fi

# ═══════════════════════════════════════════════════════
# 6. ХУКИ (WEBHOOKS)
# ═══════════════════════════════════════════════════════
section "6. ХУКИ (WEBHOOKS)"

HOOKS_COUNT=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_hooks_v2;" 2>/dev/null || echo "0")
if [ "$HOOKS_COUNT" -eq 0 ]; then
    pass "Хуков нет (чистый шаблон)"
else
    warn "Хуков: $HOOKS_COUNT"
    echo -e "   ${BLUE}Активные хуки:${NC}"
    sqlite3 "$NOCO_DB" "SELECT title, active FROM nc_hooks_v2;" 2>/dev/null
fi

# ═══════════════════════════════════════════════════════
# 7. СИСТЕМНЫЕ ДАННЫЕ
# ═══════════════════════════════════════════════════════
section "7. СИСТЕМНЫЕ ДАННЫЕ"

COMMENTS=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_comments;" 2>/dev/null || echo "0")
if [ "$COMMENTS" -eq 0 ]; then
    pass "Комментариев: 0"
else
    warn "Комментариев: $COMMENTS (должно быть 0 в чистом шаблоне)"
fi

REACTIONS=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_comment_reactions;" 2>/dev/null || echo "0")
if [ "$REACTIONS" -eq 0 ]; then
    pass "Реакций: 0"
else
    warn "Реакций: $REACTIONS"
fi

USERS=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_users_v2;" 2>/dev/null || echo "0")
info "Пользователей NocoDB: $USERS (должен быть 1 — админ)"

# ═══════════════════════════════════════════════════════
# 8. ОСИРОТЕВШИЕ ЗАПИСИ
# ═══════════════════════════════════════════════════════
section "8. ОСИРОТЕВШИЕ ЗАПИСИ"

ORPHAN_COLS=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_columns_v2 WHERE fk_model_id NOT IN (SELECT id FROM nc_models_v2);" 2>/dev/null || echo "0")
ORPHAN_VIEWS=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_views_v2 WHERE fk_model_id NOT IN (SELECT id FROM nc_models_v2);" 2>/dev/null || echo "0")
ORPHAN_GRID=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_grid_view_columns_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);" 2>/dev/null || echo "0")
ORPHAN_RELATIONS=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_col_relations_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);" 2>/dev/null || echo "0")
ORPHAN_FILTERS=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_filter_exp_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);" 2>/dev/null || echo "0")
ORPHAN_SORTS=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_sort_v2 WHERE fk_column_id NOT IN (SELECT id FROM nc_columns_v2);" 2>/dev/null || echo "0")

ORPHAN_TOTAL=$((ORPHAN_COLS + ORPHAN_VIEWS + ORPHAN_GRID + ORPHAN_RELATIONS + ORPHAN_FILTERS + ORPHAN_SORTS))

if [ "$ORPHAN_TOTAL" -eq 0 ]; then
    pass "Осиротевших записей: 0"
else
    fail "Осиротевших записей: $ORPHAN_TOTAL"
    echo "   Колонки → модели: $ORPHAN_COLS"
    echo "   Views → модели: $ORPHAN_VIEWS"
    echo "   Grid → колонки: $ORPHAN_GRID"
    echo "   Relations → колонки: $ORPHAN_RELATIONS"
    echo "   Filters → колонки: $ORPHAN_FILTERS"
    echo "   Sorts → колонки: $ORPHAN_SORTS"
fi

# ═══════════════════════════════════════════════════════
# 9. WORKSPACE_ID
# ═══════════════════════════════════════════════════════
section "9. WORKSPACE_ID"

WS_MODELS=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_models_v2 WHERE fk_workspace_id IS NOT NULL;" 2>/dev/null || echo "0")

if [ "$WS_MODELS" -gt 0 ]; then
    pass "fk_workspace_id установлен в моделях: $WS_MODELS"
else
    warn "fk_workspace_id NULL в моделях"
fi

# ═══════════════════════════════════════════════════════
# 10. NocoDB API — РАБОТОСПОСОБНОСТЬ
# ═══════════════════════════════════════════════════════
section "10. NocoDB API — РАБОТОСПОСОБНОСТЬ"

if [ -f ".env" ]; then
    NOCO_TOKEN=$(grep "^NOCO_TOKEN=" .env | cut -d= -f2)
    BASE_ID=$(grep "^BASE_ID=" .env | cut -d= -f2)
    
    if [ -n "$NOCO_TOKEN" ] && [ -n "$BASE_ID" ]; then
        info "Токен и BASE_ID найдены в .env"
        
        FIRST_TABLE=$(sqlite3 "$NOCO_DB" "SELECT id FROM nc_models_v2 WHERE mm=0 LIMIT 1;" 2>/dev/null)
        if [ -n "$FIRST_TABLE" ]; then
            API_TEST=$(curl -s -w "%{http_code}" -o /dev/null \
                "http://localhost:8081/api/v1/db/data/noco/$BASE_ID/$FIRST_TABLE?limit=1" \
                -H "xc-token: $NOCO_TOKEN" 2>/dev/null)
            
            if [ "$API_TEST" = "200" ]; then
                pass "Data API v1 работает (HTTP 200)"
            else
                fail "Data API v1 вернул HTTP $API_TEST"
            fi
        fi
    else
        warn "Токен или BASE_ID не найдены в .env"
    fi
else
    fail ".env файл не найден"
fi

# ═══════════════════════════════════════════════════════
# 11. KnexTimeoutError В ЛОГАХ (ГЛАВНАЯ ПРОВЕРКА!)
# ═══════════════════════════════════════════════════════
section "11. KnexTimeoutError В ЛОГАХ NocoDB"

# Это главная причина обновления — проверяем, исчез ли баг с пулом соединений
KNOX_ERRORS=$(docker logs nocodb 2>&1 | grep -ci "KnexTimeoutError\|Timeout acquiring a connection" || echo "0")
FAILED_DELETES=$(docker logs nocodb 2>&1 | grep -ci "Failed to permanently delete" || echo "0")

if [ "$KNOX_ERRORS" -eq 0 ] && [ "$FAILED_DELETES" -eq 0 ]; then
    pass "KnexTimeoutError в логах: 0 (отлично!)"
    pass "Failed to permanently delete: 0"
    echo -e "   ${GREEN}🎉 Похоже, обновление решило проблему с пулом соединений!${NC}"
else
    warn "KnexTimeoutError в логах: $KNOX_ERRORS"
    warn "Failed to permanently delete: $FAILED_DELETES"
    echo -e "   ${YELLOW}Баг с пулом соединений может повторяться.${NC}"
    echo -e "   ${YELLOW}Попробуй удалить view через UI и проверь логи:${NC}"
    echo -e "   ${CYAN}   docker logs nocodb --since 2m 2>&1 | grep -iE 'error|timeout|Knex'${NC}"
fi

# ═══════════════════════════════════════════════════════
# 12. БОТ (TELEGRAM)
# ═══════════════════════════════════════════════════════
section "12. БОТ (TELEGRAM)"

if docker ps --format '{{.Names}}' | grep -q "bot"; then
    BOT_ERRORS=$(docker logs printed4u-bot 2>&1 | grep -ciE "error|fail|exception" || echo "0")
    
    if [ "$BOT_ERRORS" -eq 0 ]; then
        pass "Ошибок в логах бота: 0"
    else
        warn "Ошибок в логах бота: $BOT_ERRORS"
    fi
    
    if docker logs printed4u-bot 2>&1 | grep -q "polling_error"; then
        fail "Обнаружен polling_error в логах бота"
    else
        pass "polling_error не обнаружен"
    fi
    
    if docker logs printed4u-bot 2>&1 | grep -q "Кэш сотрудников"; then
        CACHE_COUNT=$(docker logs printed4u-bot 2>&1 | grep "Кэш сотрудников" | tail -1 | grep -oE '[0-9]+' | head -1)
        info "Кэш сотрудников: ${CACHE_COUNT:-?} записей"
    fi
else
    warn "Bot не установлен"
fi

# ═══════════════════════════════════════════════════════
# 13. WEBHOOK (ПАПКИ ПРОЕКТОВ)
# ═══════════════════════════════════════════════════════
section "13. WEBHOOK (ПАПКИ ПРОЕКТОВ)"

if docker ps --format '{{.Names}}' | grep -q "webhook"; then
    WH_ERRORS=$(docker logs printed4u-webhook 2>&1 | grep -ciE "error|fail" || echo "0")
    
    if [ "$WH_ERRORS" -eq 0 ]; then
        pass "Ошибок в логах webhook: 0"
    else
        warn "Ошибок в логах webhook: $WH_ERRORS"
    fi
    
    if docker inspect printed4u-webhook 2>/dev/null | grep -q "/mnt/data/noco-static"; then
        pass "Volume noco-static подключён"
    else
        fail "Volume noco-static НЕ подключён (PDF не попадут в папки проектов)"
    fi
else
    warn "Webhook не установлен"
fi

if [ -d "/mnt/data/projects" ]; then
    PROJECTS_COUNT=$(find /mnt/data/projects -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
    info "Папок проектов: $PROJECTS_COUNT"
else
    warn "Папка /mnt/data/projects не существует"
fi

# ═══════════════════════════════════════════════════════
# 14. БЕЗОПАСНОСТЬ
# ═══════════════════════════════════════════════════════
section "14. БЕЗОПАСНОСТЬ"

if [ -f ".env" ]; then
    WEBHOOK_SECRET=$(grep "^WEBHOOK_SECRET=" .env | cut -d= -f2)
    if [ -n "$WEBHOOK_SECRET" ] && [ "$WEBHOOK_SECRET" != "your_secret_here" ]; then
        pass "WEBHOOK_SECRET установлен (${#WEBHOOK_SECRET} символов)"
    else
        fail "WEBHOOK_SECRET не установлен или дефолтный"
    fi
    
    JWT_SECRET=$(grep "^JWT_SECRET=" .env | cut -d= -f2)
    # v4.27.3: проверяем также реальный дефолт из docker-compose.yml (default_jwt_secret_change_this),
    # а не только плейсхолдер auto_generated_base64_string из старой документации
    if [ -n "$JWT_SECRET" ] && [ "$JWT_SECRET" != "auto_generated_base64_string" ] && [ "$JWT_SECRET" != "default_jwt_secret_change_this" ]; then
        pass "JWT_SECRET установлен (${#JWT_SECRET} символов)"
    else
        fail "JWT_SECRET не установлен или дефолтный"
    fi
fi

if docker ps --format '{{.Names}}' | grep -q "bot"; then
    ZOMBIE=$(docker exec printed4u-bot ps aux 2>/dev/null | grep -c "chrome.*defunct" || echo "0")
    if [ "$ZOMBIE" -eq 0 ]; then
        pass "Zombie Chrome процессов: 0"
    else
        fail "Zombie Chrome процессов: $ZOMBIE"
    fi
fi

# ═══════════════════════════════════════════════════════
# 15. UI ТЕСТ — УДАЛЕНИЕ VIEW
# ═══════════════════════════════════════════════════════
section "15. UI ТЕСТ — УДАЛЕНИЕ VIEW"

NON_DEFAULT_VIEW=$(sqlite3 "$NOCO_DB" "
SELECT v.id, v.title, m.table_name
FROM nc_views_v2 v
JOIN nc_models_v2 m ON v.fk_model_id = m.id
WHERE v.is_default = 0 AND v.type IN (2, 6)
LIMIT 1;" 2>/dev/null)

if [ -n "$NON_DEFAULT_VIEW" ]; then
    VIEW_ID=$(echo "$NON_DEFAULT_VIEW" | cut -d'|' -f1)
    VIEW_TITLE=$(echo "$NON_DEFAULT_VIEW" | cut -d'|' -f2)
    VIEW_TABLE=$(echo "$NON_DEFAULT_VIEW" | cut -d'|' -f3)
    
    info "Найден view для теста: \"$VIEW_TITLE\" (ID: $VIEW_ID) в таблице \"$VIEW_TABLE\""
    echo -e "   ${YELLOW}👉 Открой NocoDB UI и попробуй удалить этот view${NC}"
    echo -e "   ${YELLOW}👉 Потом запусти: docker logs nocodb --since 2m 2>&1 | grep -iE 'error|timeout|Knex'${NC}"
    echo -e "   ${YELLOW}👉 Если KnexTimeoutError НЕ появляется — обновление решило проблему${NC}"
else
    info "Все views дефолтные — для теста создай gallery/calendar view в UI и удали его"
fi

# ═══════════════════════════════════════════════════════
# 16. ЯДРО МИГРАЦИЙ — РУЧНОЙ ТЕСТ
# ═══════════════════════════════════════════════════════
section "16. ЯДРО МИГРАЦИЙ — РУЧНОЙ ТЕСТ"

echo -e "   ${YELLOW}Автотест миграций убран (вызывал зависание из-за docker restart).${NC}"
echo -e "   ${YELLOW}Протестируй вручную:${NC}"
echo ""
echo -e "   ${CYAN}# 1. Добавить тестовую колонку${NC}"
echo "   bash modules/add-column.sh \"Дела\" \"Тест_$(date +%s)\" \"TEXT\" \"Тест обновления\""
echo ""
echo -e "   ${CYAN}# 2. Проверить дубликаты order${NC}"
echo "   sqlite3 $NOCO_DB \"SELECT COUNT(*) FROM (SELECT fk_view_id, \\\"order\\\", COUNT(*) c FROM nc_grid_view_columns_v2 GROUP BY fk_view_id, \\\"order\\\" HAVING c > 1);\""
echo ""
echo -e "   ${CYAN}# 3. Удалить тестовую колонку${NC}"
echo "   bash modules/drop-column.sh \"Дела\" \"Тест_...\""
echo ""
echo -e "   ${CYAN}# Если оба скрипта работают и дубликатов order нет — ядро миграций совместимо с новой версией${NC}"

# ═══════════════════════════════════════════════════════
# ИТОГ
# ═══════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  📊 ИТОГ ДИАГНОСТИКИ${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "   ${GREEN}✅ Пройдено: $PASS${NC}"
echo -e "   ${RED}❌ Провалено: $FAIL${NC}"
echo -e "   ${YELLOW}⚠️  Предупреждений: $WARN${NC}"
echo ""

if [ "$FAIL" -eq 0 ]; then
    echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║   ✅ ОБНОВЛЕНИЕ ПРОШЛО УСПЕШНО!                          ║${NC}"
    echo -e "${GREEN}║   Все критические проверки пройдены.                     ║${NC}"
    echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
elif [ "$FAIL" -le 2 ]; then
    echo -e "${YELLOW}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${YELLOW}║   ⚠️  ЕСТЬ НЕБОЛЬШИЕ ПРОБЛЕМЫ                            ║${NC}"
    echo -e "${YELLOW}║   Система работает, но требует внимания.                 ║${NC}"
    echo -e "${YELLOW}╚═══════════════════════════════════════════════════════════╝${NC}"
else
    echo -e "${RED}╔═══════════════════════════════════════════════════════════╗${NC}"
    echo -e "${RED}║   ❌ КРИТИЧЕСКИЕ ПРОБЛЕМЫ                                ║${NC}"
    echo -e "${RED}║   Рекомендуется откат на 2026.06.2                       ║${NC}"
    echo -e "${RED}╚═══════════════════════════════════════════════════════════╝${NC}"
fi

echo ""
echo -e "${BLUE}📋 Дальнейшие шаги:${NC}"
echo "   1. Если есть FAIL — разбери каждый пункт"
echo "   2. Протестируй UI: удаление view, перетаскивание колонок"
echo "   3. Протестируй миграции вручную (раздел 16)"
echo "   4. Проверь бота в Telegram: /today, /new, /project"
echo "   5. Сгенерируй PDF: открой документ в NocoDB UI"
echo "   6. Отправь email через форму отправки"
echo "   7. Если всё работает — коммить template.db с новой версией"
echo ""