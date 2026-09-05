#!/bin/bash

# ============================================
# МАКСИМАЛЬНАЯ ДИАГНОСТИКА Printed4U CRM
# Версия: 2.1.0 (Умная диагностика + советы)
# Дата: 14 июля 2026
# ============================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   МАКСИМАЛЬНАЯ ДИАГНОСТИКА Printed4U CRM v2.1.0        ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Определяем пути (строго к установленной версии для точности)
INSTALL_DIR="$(pwd)"
DATA_DIR="/mnt/data"
DB_PATH="$DATA_DIR/nocodb-data/noco.db"
ENV_FILE="$INSTALL_DIR/.env"

# ============================================
# 1. КОНТЕЙНЕРЫ
# ============================================
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}📦 1. КОНТЕЙНЕРЫ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

if command -v docker &> /dev/null; then
    echo -e "${GREEN}✅ Docker: $(docker --version)${NC}"
    echo -e "${GREEN}✅ Docker Compose: $(docker compose version)${NC}"
else
    echo -e "${RED}❌ Docker не установлен${NC}"
fi

echo ""
echo "Состояние контейнеров:"
sudo docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" | grep -iE "NAMES|nocodb|printed4u|bot|webhook" || echo -e "  ${YELLOW}⚠️  Контейнеры не найдены${NC}"

echo ""

# ============================================
# 2. БАЗА ДАННЫХ NOCODB
# ============================================
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}🗄️  2. БАЗА ДАННЫХ NOCODB${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

if [ -f "$DB_PATH" ]; then
    echo -e "${GREEN}✅ База данных существует: $DB_PATH${NC}"
    echo "   Размер: $(sudo du -h "$DB_PATH" | cut -f1)"
    echo "   Владелец: $(sudo stat -c '%U:%G' "$DB_PATH")"
else
    echo -e "${RED}❌ База данных не найдена: $DB_PATH${NC}"
fi

echo ""
echo "📊 Основные параметры:"
sudo sqlite3 "$DB_PATH" "SELECT '  Баз: ' || COUNT(*) FROM nc_bases_v2;" 2>/dev/null || echo "  ⚠️  Таблица nc_bases_v2 не найдена"
sudo sqlite3 "$DB_PATH" "SELECT '  Моделей: ' || COUNT(*) FROM nc_models_v2;" 2>/dev/null || echo "  ⚠️  Таблица nc_models_v2 не найдена"
sudo sqlite3 "$DB_PATH" "SELECT '  Workspace: ' || COUNT(*) FROM workspace;" 2>/dev/null || echo "  ⚠️  Таблица workspace не найдена"

echo ""
WS_ID=$(sudo sqlite3 "$DB_PATH" "SELECT id FROM workspace LIMIT 1;" 2>/dev/null || echo "")
if [ -n "$WS_ID" ]; then
    echo -e "${GREEN}  ✅ Workspace ID: $WS_ID${NC}"
else
    echo -e "${RED}  ❌ Workspace не найден${NC}"
fi

echo ""

# ============================================
# 3. API NOCODB (УЛУЧШЕНО)
# ============================================
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}🌐 3. API NOCODB${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

if [ -f "$ENV_FILE" ]; then
    TOKEN=$(grep "^NOCO_TOKEN=" "$ENV_FILE" | cut -d= -f2)
    BASE_ID=$(grep "^BASE_ID=" "$ENV_FILE" | cut -d= -f2)
    
    if [ -n "$TOKEN" ] && [ "$TOKEN" != "your_noco_token_here" ]; then
        echo -e "${GREEN}✅ NOCO_TOKEN установлен${NC}"
        
        RESPONSE_CODE=$(curl -s -o /tmp/api_response.json -w "%{http_code}" "http://localhost:8081/api/v2/meta/bases" -H "xc-token: $TOKEN" 2>/dev/null || echo "000")
        
        if [ "$RESPONSE_CODE" = "200" ]; then
            echo -e "${GREEN}✅ API отвечает (HTTP 200)${NC}"
            BASES_COUNT=$(python3 -c "import json; print(len(json.load(open('/tmp/api_response.json'))['list']))" 2>/dev/null || echo "0")
            echo "   Баз найдено: $BASES_COUNT"
        elif [ "$RESPONSE_CODE" = "401" ]; then
            echo -e "${RED}❌ API вернул 401 (Неверный NOCO_TOKEN)${NC}"
            echo -e "${YELLOW}💡 Совет: запусти 'bash $INSTALL_DIR/setup-bot.sh' для обновления токенов${NC}"
        elif [ "$RESPONSE_CODE" = "000" ]; then
            echo -e "${RED}❌ API недоступен (HTTP 000 - NocoDB не отвечает на порту 8081)${NC}"
            echo -e "${YELLOW}💡 Совет: проверь 'sudo docker logs nocodb'${NC}"
        else
            echo -e "${RED}❌ API вернул неожиданный код: HTTP $RESPONSE_CODE${NC}"
        fi
        
        if [ -n "$BASE_ID" ] && [ "$BASE_ID" != "your_base_id_here" ]; then
            echo -e "${GREEN}✅ BASE_ID установлен: $BASE_ID${NC}"
            TABLES_CODE=$(curl -s -o /tmp/tables_response.json -w "%{http_code}" "http://localhost:8081/api/v2/meta/bases/$BASE_ID/tables" -H "xc-token: $TOKEN" 2>/dev/null || echo "000")
            if [ "$TABLES_CODE" = "200" ]; then
                TABLES_COUNT=$(python3 -c "import json; print(len(json.load(open('/tmp/tables_response.json'))['list']))" 2>/dev/null || echo "0")
                echo -e "${GREEN}✅ Таблицы доступны: $TABLES_COUNT${NC}"
            else
                echo -e "${RED}❌ Таблицы недоступны (HTTP $TABLES_CODE)${NC}"
            fi
        else
            echo -e "${RED}❌ BASE_ID не установлен или является плейсхолдером${NC}"
            echo -e "${YELLOW}💡 Совет: запусти 'bash $INSTALL_DIR/setup-bot.sh'${NC}"
        fi
    else
        echo -e "${RED}❌ NOCO_TOKEN не установлен или является плейсхолдером${NC}"
    fi
else
    echo -e "${RED}❌ .env не найден по пути $ENV_FILE${NC}"
fi

echo ""

# ============================================
# 4. TELEGRAM БОТ
# ============================================
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}🤖 4. TELEGRAM БОТ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

if [ -f "$ENV_FILE" ]; then
    BOT_TOKEN=$(grep "^TELEGRAM_BOT_TOKEN=" "$ENV_FILE" | cut -d= -f2)
    if [ -n "$BOT_TOKEN" ] && [ "$BOT_TOKEN" != "your_bot_token_here" ]; then
        echo -e "${GREEN}✅ TELEGRAM_BOT_TOKEN установлен${NC}"
        BOT_INFO=$(curl -s "https://api.telegram.org/bot$BOT_TOKEN/getMe" 2>/dev/null || echo "{}")
        if echo "$BOT_INFO" | grep -q '"ok":true'; then
            BOT_NAME=$(echo "$BOT_INFO" | python3 -c "import sys, json; print(json.load(sys.stdin)['result']['username'])" 2>/dev/null || echo "unknown")
            echo -e "${GREEN}✅ Бот работает: @$BOT_NAME${NC}"
        else
            echo -e "${RED}❌ Бот не отвечает API Telegram${NC}"
        fi
    else
        echo -e "${RED}❌ TELEGRAM_BOT_TOKEN не установлен${NC}"
    fi
fi
echo ""

# ============================================
# 5. WEBHOOK
# ============================================
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}🔗 5. WEBHOOK${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

WEBHOOK_HEALTH=$(curl -s -w "%{http_code}" "http://localhost:3001/health" -o /dev/null 2>/dev/null || echo "000")
if [ "$WEBHOOK_HEALTH" = "200" ]; then
    echo -e "${GREEN}✅ Webhook отвечает локально (HTTP 200)${NC}"
else
    echo -e "${RED}❌ Webhook не отвечает локально (HTTP $WEBHOOK_HEALTH)${NC}"
fi
echo ""

# ============================================
# 6. ФАЙЛЫ И ПАПКИ
# ============================================
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}📁 6. ФАЙЛЫ И ПАПКИ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

for DIR in projects clients nocodb-data backups noco-static; do
    if [ -d "$DATA_DIR/$DIR" ]; then
        OWNER=$(sudo stat -c '%U:%G' "$DATA_DIR/$DIR" 2>/dev/null || echo "unknown")
        echo -e "  ${GREEN}✅ $DATA_DIR/$DIR/ (владелец: $OWNER)${NC}"
    else
        echo -e "  ${RED}❌ $DATA_DIR/$DIR/ не существует${NC}"
    fi
done
echo ""

# ============================================
# 7. ЛОГИ (ОШИБКИ ЗА ПОСЛЕДНИЕ 5 МИНУТ)
# ============================================
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}📋 7. ЛОГИ (ОШИБКИ ЗА ПОСЛЕДНИЕ 5 МИНУТ)${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

for CONTAINER in nocodb printed4u-bot printed4u-webhook; do
    if sudo docker ps -a --format "{{.Names}}" | grep -q "^${CONTAINER}$"; then
        # Ищем именно слова Error или Exception, игнорируя "no error"
        ERRORS=$(sudo docker logs "$CONTAINER" --since 5m 2>&1 | grep -iE "\berror\b|\bexception\b|\bfail\b" | grep -iv "no error" | wc -l)
        if [ "$ERRORS" = "0" ]; then
            echo -e "  ${GREEN}✅ $CONTAINER: критических ошибок нет${NC}"
        else
            echo -e "  ${RED}❌ $CONTAINER: найдено $ERRORS предупреждений/ошибок${NC}"
        fi
    fi
done
echo ""

# ============================================
# 8. ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ
# ============================================
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}⚙️  8. ПЕРЕМЕННЫЕ ОКРУЖЕНИЯ (.env)${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

if [ -f "$ENV_FILE" ]; then
    for VAR in TELEGRAM_BOT_TOKEN NOCO_TOKEN BASE_ID WEBHOOK_SECRET; do
        VALUE=$(grep "^${VAR}=" "$ENV_FILE" | cut -d= -f2)
        if [ -n "$VALUE" ] && [ "$VALUE" != "your_"* ]; then
            echo -e "  ${GREEN}✅ $VAR: установлен${NC}"
        else
            echo -e "  ${RED}❌ $VAR: не установлен или плейсхолдер${NC}"
        fi
    done
else
    echo -e "${RED}❌ .env не найден${NC}"
fi
echo ""

# ============================================
# 9. DISK SPACE И RAM
# ============================================
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}💽 9. DISK SPACE И RAM${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

df -h /mnt/data 2>/dev/null | tail -1 | awk '{print "  /mnt/data: " $3 " использовано / " $2 " всего (" $5 ")"}'
free -h | grep "Mem:" | awk '{print "  RAM: " $3 " использовано / " $2 " всего"}'
echo ""

# ============================================
# 10. СЕТЕВЫЕ ПОРТЫ (УЛУЧШЕНО: ss вместо netstat)
# ============================================
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}🔌 10. СЕТЕВЫЕ ПОРТЫ${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

for PORT in 8081 3000 3001 80 443; do
    if sudo ss -tlnp 2>/dev/null | grep -q ":$PORT "; then
        PROCESS=$(sudo ss -tlnp 2>/dev/null | grep ":$PORT " | awk '{print $NF}' | sed 's/.*"\(.*\)".*/\1/' | head -1)
        echo -e "  ${GREEN}✅ Порт $PORT: слушает ${PROCESS:-неизвестный процесс}${NC}"
    else
        echo -e "  ${YELLOW}⚠️  Порт $PORT: не слушает${NC}"
    fi
done
echo ""

# ============================================
# 11. GIT СТАТУС
# ============================================
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}📦 11. GIT СТАТУС${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

if [ -d "$INSTALL_DIR/.git" ]; then
    cd "$INSTALL_DIR"
    BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
    LAST_COMMIT=$(git log -1 --format="%h %s (%ar)" 2>/dev/null || echo "unknown")
    echo -e "${GREEN}✅ Git репозиторий существует${NC}"
    echo "   Ветка: $BRANCH"
    echo "   Последний коммит: $LAST_COMMIT"
    
    CHANGES=$(git status --porcelain 2>/dev/null | wc -l)
    if [ "$CHANGES" = "0" ]; then
        echo -e "  ${GREEN}✅ Нет изменений в рабочей директории${NC}"
    else
        echo -e "  ${YELLOW}⚠️  Есть несохранённые изменения: $CHANGES файлов${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Git репозиторий не инициализирован${NC}"
fi
echo ""

# ============================================
# 12. ВЕРСИЯ СХЕМЫ vs КОД (дельты)
# ============================================
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}🔢 12. ВЕРСИЯ СХЕМЫ vs КОД${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"

SCHEMA_VER=$(NOCO_DB="$DB_PATH" bash "$INSTALL_DIR/modules/version.sh" get 2>/dev/null || echo "0")
CODE_MAX=0
for f in "$INSTALL_DIR"/upgrades/U*.sh; do
    [ -e "$f" ] || continue
    n=$(basename "$f" | sed -n 's/^U0*\([0-9][0-9]*\)_.*/\1/p')
    [ -n "$n" ] && [ "$n" -gt "$CODE_MAX" ] && CODE_MAX="$n"
done
echo "   Схема в БД: U$SCHEMA_VER | Дельт в коде: до U$CODE_MAX"
if [ "$CODE_MAX" -gt 0 ] && [ "$SCHEMA_VER" -lt "$CODE_MAX" ]; then
    echo -e "  ${YELLOW}⚠️  Схема отстаёт от кода: в БД U$SCHEMA_VER, код рассчитан до U$CODE_MAX.${NC}"
    echo -e "  ${YELLOW}   Признак незавершённого «большого скачка» (дельты приехали с кодом, но не применились).${NC}"
    echo -e "  ${YELLOW}   Запусти: bash $INSTALL_DIR/upgrade.sh (дельты идемпотентны, всё догонится)${NC}"
else
    echo -e "  ${GREEN}✅ Схема синхронна с кодом${NC}"
fi
echo ""

# ============================================
# ИТОГ
# ============================================
echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   ДИАГНОСТИКА ЗАВЕРШЕНА                                   ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}💡 Быстрые решения:${NC}"
echo "   • Если API не отвечает (401/000) → bash $INSTALL_DIR/setup-bot.sh"
echo "   • Если таблицы не видны → проверь fk_workspace_id в базе"
echo "   • Если webhook не работает → проверь логи: sudo docker logs printed4u-webhook"
echo ""
