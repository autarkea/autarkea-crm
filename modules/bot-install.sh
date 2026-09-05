#!/bin/bash
# ============================================================================
# modules/bot-install.sh v4.34.3 — Настройка Telegram бота
# ============================================================================
# Запрашивает Bot Token, инструктирует по настройке таблицы "Сотрудники",
# проверяет скрипт автозапуска и вызывает setup-bot.sh
# ============================================================================
# Изменения v4.34.3:
# - bot/start.sh больше НЕ перезаписывается при каждом запуске (это tracked
#   файл репозитория; перезапись heredoc'ом рассинхронизировала код после
#   git pull). Существующий файл не трогаем, heredoc — только fallback для
#   не-git установок, где bot/start.sh отсутствует.
# ============================================================================

set -e

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}🤖 Настройка Telegram бота (v4.34.3)${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Поиск .env
ENV_FILE=""
if [[ -f ".env" ]]; then
    ENV_FILE=".env"
elif [[ -f "$(pwd)/.env" ]]; then
    ENV_FILE="$(pwd)/.env"
else
    echo -e "${RED}❌ .env не найден!${NC}"
    exit 1
fi

# ============================================================================
# Шаг 1: Запрос Bot Token
# ============================================================================
echo -e "${BLUE}[1/5] Получение Telegram Bot Token${NC}"
echo ""
echo -e "${YELLOW}📝 Инструкция:${NC}"
echo -e "   1. Открой Telegram → @BotFather"
echo -e "   2. Отправь /newbot"
echo -e "   3. Придумай имя и username (должен заканчиваться на 'bot')"
echo -e "   4. Скопируй токен (формат: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz)"
echo ""

CURRENT_TOKEN=$(grep TELEGRAM_BOT_TOKEN "$ENV_FILE" 2>/dev/null | cut -d= -f2)
if [[ -n "$CURRENT_TOKEN" && "$CURRENT_TOKEN" != "your_bot_token_here" ]]; then
    echo -e "${GREEN}✅ Текущий токен: ${CURRENT_TOKEN:0:10}...${NC}"
    read -p "Изменить токен? (y/N): " change_token
    if [[ "$change_token" != "y" && "$change_token" != "Y" ]]; then
        echo -e "${GREEN}✅ Используем существующий токен${NC}"
    else
        read -p "Вставь новый Telegram Bot Token: " bot_token
        if [[ -n "$bot_token" ]]; then
            sed -i "s|TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$bot_token|" "$ENV_FILE"
            echo -e "${GREEN}✅ Токен обновлён${NC}"
        fi
    fi
else
    read -p "Вставь Telegram Bot Token: " bot_token
    if [[ -n "$bot_token" ]]; then
        sed -i "s|TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$bot_token|" "$ENV_FILE"
        echo -e "${GREEN}✅ Токен сохранён${NC}"
    else
        echo -e "${RED}❌ Токен не указан!${NC}"
        exit 1
    fi
fi

# ============================================================================
# Шаг 2: Проверка токена через Telegram API
# ============================================================================
echo ""
echo -e "${BLUE}[2/5] Проверка токена через Telegram API...${NC}"

TOKEN=$(grep TELEGRAM_BOT_TOKEN "$ENV_FILE" | cut -d= -f2)
RESPONSE=$(curl -s "https://api.telegram.org/bot${TOKEN}/getMe")

if echo "$RESPONSE" | grep -q '"ok":true'; then
    BOT_NAME=$(echo "$RESPONSE" | grep -o '"first_name":"[^"]*"' | cut -d'"' -f4)
    BOT_USERNAME=$(echo "$RESPONSE" | grep -o '"username":"[^"]*"' | cut -d'"' -f4)
    echo -e "${GREEN}✅ Бот найден: $BOT_NAME (@$BOT_USERNAME)${NC}"
else
    echo -e "${RED}❌ Токен неверный!${NC}"
    echo -e "${YELLOW}Ответ API: $RESPONSE${NC}"
    exit 1
fi

# ============================================================================
# Шаг 3: Настройка доступа через таблицу "Сотрудники" (v4.1.0+)
# ============================================================================
echo ""
echo -e "${BLUE}[3/5] Настройка доступа через NocoDB (Таблица 'Сотрудники')${NC}"
echo ""
echo -e "${YELLOW}⚠️  ВАЖНО! Начиная с v4.1.0, доступ управляется через базу данных.${NC}"
echo -e "${YELLOW}Переменная TELEGRAM_USER_ID в .env больше не используется!${NC}"
echo ""
echo -e "${GREEN}📝 Что нужно сделать прямо сейчас:${NC}"
echo -e "   1. Открой NocoDB UI в браузере"
echo -e "   2. Перейди в таблицу 'Сотрудники'"
echo -e "   3. Создай новую запись о себе:"
echo -e "      • ФИО: Твоё имя"
echo -e "      • Telegram_ID: Число из @userinfobot (например, 123456789)"
echo -e "      • Роль: Админ"
echo -e "      • E-mail: Твоя почта (⚠️ поле в NocoDB называется строго 'E-mail' с дефисом!)"
echo -e "   4. Бот автоматически подхватит тебя в течение 1 минуты."
echo ""
read -p "Я добавил себя в таблицу 'Сотрудники'. Нажми Enter для продолжения..."

# ============================================================================
# Шаг 4: Создание скрипта автозапуска server.js + bot.js
# ============================================================================
echo ""
echo -e "${BLUE}[4/5] Настройка автозапуска PDF-генератора и бота...${NC}"

# v4.34.3: bot/start.sh — ЭТАЛОННЫЙ tracked-файл репозитория. Раньше модуль
# ПЕРЕЗАПИСЫВАЛ его heredoc'ом при каждом запуске → два источника правды
# расходились после git pull/upgrade.sh (модуль старого релиза мог откатить
# свежий start.sh). Теперь существующий файл НЕ трогаем; heredoc остался только
# как fallback для не-git установок, где bot/start.sh отсутствует вовсе.
if [ ! -f "bot/start.sh" ]; then
    echo -e "${YELLOW}⚠️  bot/start.sh отсутствует — создаю (не-git установка)...${NC}"
    cat << 'EOF' > bot/start.sh
#!/bin/sh
echo "🚀 Запуск сервера документов (server.js) на порту 3000..."
node server.js > /tmp/server.log 2>&1 &
SERVER_PID=$!
sleep 2
if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "❌ server.js упал при старте!"
    cat /tmp/server.log
    exit 1
fi
echo "✅ server.js запущен (PID: $SERVER_PID)"
echo "🤖 Запуск Telegram-бота (bot.js)..."
exec node bot.js
EOF
fi
chmod +x bot/start.sh 2>/dev/null || true
echo -e "${GREEN}✅ Скрипт автозапуска bot/start.sh на месте${NC}"

# Обновляем Dockerfile, чтобы он использовал start.sh
if grep -q 'CMD \["node", "bot.js"\]' bot/Dockerfile 2>/dev/null; then
    echo -e "${BLUE}🔄 Обновляю bot/Dockerfile для автозапуска...${NC}"
    # Добавляем COPY start.sh перед CMD
    sed -i '/COPY bot\/server.js bot\/bot.js bot\/config.js \.\//a COPY bot/start.sh .\nRUN chmod +x start.sh' bot/Dockerfile
    # Заменяем CMD на запуск скрипта
    sed -i 's|CMD \["node", "bot.js"\]|CMD ["./start.sh"]|' bot/Dockerfile
    echo -e "${GREEN}✅ bot/Dockerfile обновлён${NC}"
else
    echo -e "${YELLOW}ℹ️  bot/Dockerfile уже настроен на использование start.sh${NC}"
fi

# ============================================================================
# Шаг 5: Перезапуск бота и заполнение TABLE_*
# ============================================================================
echo ""
echo -e "${BLUE}[5/5] Перезапуск контейнера и заполнение ID таблиц...${NC}"

# Ищем директорию с docker-compose.yml
COMPOSE_DIR=""
if [[ -f "docker-compose.yml" ]]; then
    COMPOSE_DIR="."
elif [[ -f "$(pwd)/docker-compose.yml" ]]; then
    COMPOSE_DIR="$(pwd)"
fi

if [[ -n "$COMPOSE_DIR" ]]; then
    cd "$COMPOSE_DIR"
    # Пересоздаём контейнер, чтобы подхватил новые переменные и Dockerfile
    sudo docker compose down bot 2>/dev/null || true
    sudo docker compose up -d --build bot 2>/dev/null || sudo docker compose up -d --build 2>/dev/null
    echo -e "${GREEN}✅ Контейнер бота пересобран и перезапущен${NC}"
else
    echo -e "${YELLOW}⚠️  docker-compose.yml не найден — перезапусти бота вручную${NC}"
fi

# Ждём 5 секунд, пока бот запустится
sleep 5

# Заполняем TABLE_* через setup-bot.sh
echo ""
echo -e "${BLUE}📋 Заполнение ID таблиц (TABLE_*) через NocoDB API...${NC}"
if [[ -f "setup-bot.sh" ]]; then
    bash setup-bot.sh --no-restart
elif [[ -f "$(pwd)/setup-bot.sh" ]]; then
    bash "$(pwd)/setup-bot.sh" --no-restart
else
    echo -e "${YELLOW}⚠️  setup-bot.sh не найден — TABLE_* не заполнены${NC}"
    echo -e "${YELLOW}💡 Запусти позже: bash setup-bot.sh${NC}"
fi

# ============================================================================
# Финальное сообщение
# ============================================================================
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Настройка бота завершена успешно!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}📋 Проверка:${NC}"
echo -e "   sudo docker logs printed4u-bot --tail 15"
echo ""
echo -e "${BLUE}📱 Тест в Telegram:${NC}"
echo -e "   Напиши боту /start"
echo -e "   Если бот отвечает — доступ настроен верно через таблицу 'Сотрудники'."
echo ""