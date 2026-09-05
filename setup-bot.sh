#!/bin/bash
# ============================================================================
# Printed4U CRM - setup-bot.sh v4.8.0
# Автоматическое заполнение TABLE_* в .env через NocoDB Meta API v2
# ============================================================================
# Можно запускать отдельно (если TABLE_* потерялись) или из install.sh.
#
# Использование:
#   bash setup-bot.sh              # Запуск с перезапуском контейнеров
#   bash setup-bot.sh --no-restart # Без перезапуска контейнеров
# ============================================================================
set -e

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Флаги
NO_RESTART=false
if [[ "$1" == "--no-restart" ]]; then
    NO_RESTART=true
fi

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}🤖 setup-bot.sh v4.8.0 — Заполнение TABLE_* в .env${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# ============================================================================
# Шаг 1: Проверка зависимостей
# ============================================================================
echo -e "${BLUE}[1/7] Проверяю зависимости...${NC}"
for cmd in curl jq docker; do
    if ! command -v $cmd &> /dev/null; then
        echo -e "${RED}❌ Не найден: $cmd${NC}"
        echo -e "${YELLOW}💡 Установи: sudo apt install $cmd${NC}"
        exit 1
    fi
done
echo -e "${GREEN}✅ curl, jq, docker найдены${NC}"
echo ""

# ============================================================================
# Шаг 2: Поиск .env файла
# ============================================================================
echo -e "${BLUE}[2/7] Ищу .env файл...${NC}"
ENV_FILE=""
if [[ -f ".env" ]]; then
    ENV_FILE=".env"
elif [[ -f "$(pwd)/.env" ]]; then
    ENV_FILE="$(pwd)/.env"
elif [[ -f "$HOME/printed4u-crm/.env" ]]; then
    ENV_FILE="$HOME/printed4u-crm/.env"
else
    echo -e "${RED}❌ .env не найден!${NC}"
    exit 1
fi
echo -e "${GREEN}✅ .env найден: $ENV_FILE${NC}"
echo ""

# ============================================================================
# Шаг 3: Чтение переменных из .env
# ============================================================================
echo -e "${BLUE}[3/7] Читаю переменные из .env...${NC}"
get_env_var() {
    local var_name=$1
    grep -E "^${var_name}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

BASE_ID=$(get_env_var "BASE_ID")
NOCO_TOKEN=$(get_env_var "NOCO_TOKEN")
NOCO_URL_RAW=$(get_env_var "NOCO_URL")

# Адаптируем NOCO_URL для запросов с хост-машины
# Если в .env указан внутренний docker-адрес, принудительно ставим хост-порт 8081
if [[ "$NOCO_URL_RAW" == *"nocodb"* ]]; then
    NOCO_API_URL="http://localhost:8081"
elif [[ -n "$NOCO_URL_RAW" ]]; then
    NOCO_API_URL="$NOCO_URL_RAW"
else
    NOCO_API_URL="http://localhost:8081"
fi

if [[ -z "$BASE_ID" || "$BASE_ID" == "your_base_id_here" ]]; then
    echo -e "${RED}❌ BASE_ID не заполнен в .env!${NC}"
    exit 1
fi

if [[ -z "$NOCO_TOKEN" || "$NOCO_TOKEN" == "your_noco_token_here" ]]; then
    echo -e "${RED}❌ NOCO_TOKEN не заполнен в .env!${NC}"
    exit 1
fi

echo -e "${GREEN}✅ BASE_ID: $BASE_ID${NC}"
echo -e "${GREEN}✅ NOCO_API_URL: $NOCO_API_URL${NC}"
echo -e "${GREEN}✅ NOCO_TOKEN: ${NOCO_TOKEN:0:10}...${NC}"
echo ""

# ============================================================================
# Шаг 4: Ожидание запуска NocoDB
# ============================================================================
echo -e "${BLUE}[4/7] Ожидаю запуска NocoDB...${NC}"
MAX_ATTEMPTS=30
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
        "${NOCO_API_URL}/api/v2/meta/bases/${BASE_ID}/tables" \
        -H "xc-token: $NOCO_TOKEN" \
        --connect-timeout 2 \
        --max-time 5 2>/dev/null || echo "000")
    
    if [[ "$RESPONSE" == "200" ]]; then
        echo -e "${GREEN}✅ NocoDB Meta API отвечает (попытка $((ATTEMPT+1))/${MAX_ATTEMPTS})${NC}"
        break
    fi
    
    ATTEMPT=$((ATTEMPT+1))
    echo -e "${YELLOW}⏳ Ожидание... (попытка $ATTEMPT/$MAX_ATTEMPTS, статус: $RESPONSE)${NC}"
    sleep 2
done

if [[ "$RESPONSE" != "200" ]]; then
    echo -e "${RED}❌ NocoDB не отвечает после $MAX_ATTEMPTS попыток!${NC}"
    exit 1
fi
echo ""

# ============================================================================
# Шаг 5: Получение списка таблиц
# ============================================================================
echo -e "${BLUE}[5/7] Получаю список таблиц из NocoDB...${NC}"
TABLES_JSON=$(curl -s "${NOCO_API_URL}/api/v2/meta/bases/${BASE_ID}/tables" \
    -H "xc-token: $NOCO_TOKEN")

if ! echo "$TABLES_JSON" | jq -e '.list' &> /dev/null; then
    echo -e "${RED}❌ Не удалось получить список таблиц!${NC}"
    echo -e "${YELLOW}Ответ API: ${TABLES_JSON:0:200}${NC}"
    exit 1
fi

TABLE_COUNT=$(echo "$TABLES_JSON" | jq -r '.list | length')
echo -e "${GREEN}✅ Найдено таблиц в базе: $TABLE_COUNT${NC}"
echo ""

# ============================================================================
# Шаг 6: Поиск ID таблиц по именам
# ============================================================================
echo -e "${BLUE}[6/7] Ищу ID таблиц по именам...${NC}"

# Маппинг: переменная .env → возможные имена таблицы (первое — основное, как в v4.8.0)
declare -A TABLE_MAP=(
    ["TABLE_CONTACTS"]="Контакты|Clients|Клиенты"
    ["TABLE_PROJECTS"]="Проекты|Projects"
    ["TABLE_TASKS"]="Дела|Задачи|Tasks"
    ["TABLE_DOCUMENTS"]="Документы|Documents"
    ["TABLE_ITEMS"]="Позиции заказа|Items|Позиции"
    ["TABLE_LEGAL_ENTITIES"]="Юрлица|Legal Entities|Организации"
    ["TABLE_MY_DETAILS"]="Мои реквизиты|My Details|Реквизиты"
    ["TABLE_EMPLOYEES"]="Сотрудники|Employees"
    ["TABLE_DOC_SETTINGS"]="Настройки документов|Doc Settings"
)

# Обязательные таблицы для работы ядра системы v4.8.0
REQUIRED_TABLES=("TABLE_CONTACTS" "TABLE_PROJECTS" "TABLE_TASKS" "TABLE_DOC_SETTINGS")

find_table_id() {
    local names=$1
    IFS='|' read -ra NAME_ARRAY <<< "$names"
    
    for name in "${NAME_ARRAY[@]}"; do
        local id=$(echo "$TABLES_JSON" | jq -r --arg name "$name" \
            '.list[] | select(.title == $name) | .id' | head -1)
        if [[ -n "$id" && "$id" != "null" ]]; then
            echo "$id"
            return 0
        fi
    done
    
    echo ""
    return 1
}

FOUND=0
MISSING=0
MISSING_LIST=""

for VAR_NAME in "${!TABLE_MAP[@]}"; do
    NAMES="${TABLE_MAP[$VAR_NAME]}"
    TABLE_ID=$(find_table_id "$NAMES")
    
    if [[ -n "$TABLE_ID" ]]; then
        if grep -q "^${VAR_NAME}=" "$ENV_FILE"; then
            sed -i "s|^${VAR_NAME}=.*|${VAR_NAME}=${TABLE_ID}|" "$ENV_FILE"
        else
            # Проблема 107: перевод строки в конце .env ДО дозаписи (иначе строки склеиваются)
            [ -n "$(tail -c1 "$ENV_FILE")" ] && echo "" >> "$ENV_FILE"
            echo "${VAR_NAME}=${TABLE_ID}" >> "$ENV_FILE"
        fi
        
        echo -e "${GREEN}✅ $VAR_NAME = $TABLE_ID${NC}"
        FOUND=$((FOUND+1))
    else
        IS_REQUIRED=false
        for REQ in "${REQUIRED_TABLES[@]}"; do
            if [[ "$REQ" == "$VAR_NAME" ]]; then
                IS_REQUIRED=true
                break
            fi
        done
        
        if $IS_REQUIRED; then
            echo -e "${RED}❌ $VAR_NAME — НЕ НАЙДЕНА (обязательная для v4.8.0!)${NC}"
            MISSING_LIST="$MISSING_LIST $VAR_NAME"
            MISSING=$((MISSING+1))
        else
            echo -e "${YELLOW}⚠️  $VAR_NAME — не найдена (опциональная)${NC}"
        fi
    fi
done

echo ""
echo -e "${BLUE}📊 Итог: найдено $FOUND, пропущено $MISSING${NC}"

if [[ $MISSING -gt 0 ]]; then
    echo -e "${RED}❌ Не найдены обязательные таблицы:$MISSING_LIST${NC}"
    echo -e "${YELLOW}💡 Проверь, что эти таблицы созданы в NocoDB UI с точными именами.${NC}"
    exit 1
fi
echo ""

# ============================================================================
# Шаг 7: Перезапуск контейнеров
# ============================================================================
if $NO_RESTART; then
    echo -e "${YELLOW}⏭️  Перезапуск пропущен (флаг --no-restart)${NC}"
else
    echo -e "${BLUE}[7/7] Перезапускаю контейнеры...${NC}"
    
    COMPOSE_DIR=""
    if [[ -f "docker-compose.yml" ]]; then
        COMPOSE_DIR="."
    elif [[ -f "$(pwd)/docker-compose.yml" ]]; then
        COMPOSE_DIR="$(pwd)"
    elif [[ -f "$HOME/printed4u-crm/docker-compose.yml" ]]; then
        COMPOSE_DIR="$HOME/printed4u-crm"
    fi
    
    if [[ -n "$COMPOSE_DIR" ]]; then
        cd "$COMPOSE_DIR"
        sudo docker compose down &> /dev/null
        sudo docker compose up -d --build &> /dev/null
        echo -e "${GREEN}✅ Контейнеры перезапущены с новыми переменными окружения${NC}"
        
        sleep 5
        
        if sudo docker ps --format "{{.Names}}" | grep -q "printed4u-bot"; then
            echo -e "${GREEN}✅ printed4u-bot успешно запущен${NC}"
        else
            echo -e "${YELLOW}⚠️  printed4u-bot не запущен — проверь логи:${NC}"
            echo -e "${YELLOW}   sudo docker logs printed4u-bot --tail 20${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  docker-compose.yml не найден — перезапусти контейнеры вручную${NC}"
    fi
fi

# ============================================================================
# Финальное сообщение
# ============================================================================
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ setup-bot.sh v4.8.0 завершён успешно!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}📋 Что сделано:${NC}"
echo -e "   • Получен список таблиц из NocoDB Meta API v2"
echo -e "   • Найдено и обновлено $FOUND переменных TABLE_*"
echo -e "   • Данные сохранены в: $ENV_FILE"
if ! $NO_RESTART; then
    echo -e "   • Docker-контейнеры перезапущены"
fi
echo ""
echo -e "${BLUE}🔍 Быстрая проверка:${NC}"
echo -e "   grep TABLE_ $ENV_FILE"
echo -e "   sudo docker logs printed4u-bot --tail 10"
echo ""