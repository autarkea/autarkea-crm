#!/bin/bash
# ============================================================================
# Printed4U CRM - Главный установщик v4.43.1 (ЛИНЕЙНЫЙ И МОДУЛЬНЫЙ)
# ============================================================================
# Установка в текущую директорию (~/printed4u-crm)
# Данные хранятся в /mnt/data/ (отдельно от кода)
# ============================================================================
# Изменения v4.34.3:
# - Guard повторного запуска: если CRM уже установлена (.env с реальными
#   BASE_ID/NOCO_TOKEN + noco.db на месте) — установщик ПРЕДУПРЕЖДАЕТ и не
#   перезаписывает базу шаблоном (защита от «кривых рук»). Обновление — через
#   upgrade.sh; полный сброс — только с явным флагом --force + подтверждением.
# - Страховочный снапшот живой базы в /mnt/data/backups перед apply-template.sh.
# - BASE_ID ищется по title='CRM' с контролем единственности (вместо LIMIT 1,
#   который на сервере с несколькими базами мог выбрать чужую).
# - Бейдж версии актуализирован (был v4.12.0 при продукте v4.34.x).
# ============================================================================
# Изменения v4.40.0:
# - ШАГ 9: Firewall. «По умолчанию сервисы НЕ доступны из интернета»: сервисные
#   порты (NocoDB UI 8081, PDF-генератор 3000, Webhook 3001) разрешаются ТОЛЬКО
#   локальной сети и Tailscale, остальное входящее закрыто (modules/firewall-setup.sh).
#   HTTPS/Cloudflare по умолчанию не открываются — только ручной запуск
#   setup-https.sh / setup-cloudflare.sh с явным --https.
#   VPS без Tailscale спрашивает про открытие портов (--public, небезопасно без HTTPS).
# ============================================================================
# Изменения v4.12.0:
# - Модуль настройки бэкапов (modules/backup-install.sh): локальные по
#   расписанию (дни + время) + облачные (Google Drive через rclone)
# - Бейдж версии синхронизирован с docs (ранее рассогласование v4.8.1)
# - NocoDB CE 2026.08.0 (актуализирован бейдж)
# ============================================================================
# Изменения v4.8.1:
# - SMTP вынесен в отдельный модуль modules/email-install.sh
# - Шаг 4 теперь содержит только базовую конфигурацию .env
# - Email настраивается через "Дополнительные компоненты" в финале
# ============================================================================
set -e

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Printed4U CRM - Установка v4.43.1                    ║${NC}"
echo -e "${BLUE}║   Бэкапы + Watchdog FS + Роли + Документы (B2B/B2C)    ║${NC}"
echo -e "${BLUE}║   NocoDB CE 2026.08.0 (Зафиксированная версия)         ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ============================================================================
# Определение IP и типа сервера
# ============================================================================
LOCAL_IP=$(hostname -I | awk '{print $1}')
PUBLIC_IP=$(curl -s ifconfig.me 2>/dev/null || echo "не определён")

if [[ "$LOCAL_IP" == "192.168."* ]] || [[ "$LOCAL_IP" == "10."* ]] || [[ "$LOCAL_IP" == "172."* ]]; then
    SERVER_TYPE="local"
    ACCESS_IP="$LOCAL_IP"
else
    SERVER_TYPE="vps"
    ACCESS_IP="$PUBLIC_IP"
fi

echo -e "${BLUE}🌐 Тип сервера: $SERVER_TYPE${NC}"
echo -e "${BLUE}📡 Локальный IP: $LOCAL_IP${NC}"
if [[ "$SERVER_TYPE" == "vps" ]]; then
    echo -e "${BLUE}🌍 Публичный IP: $PUBLIC_IP${NC}"
fi
echo ""

# ============================================================================
# ШАГ 1: Проверка и установка Docker
# ============================================================================
echo -e "${BLUE}📦 Шаг 1/8: Проверка и установка Docker...${NC}"
if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}⚠️  Docker не установлен. Устанавливаю...${NC}"
    curl -fsSL https://get.docker.com | bash
    sudo usermod -aG docker $USER
    echo -e "${GREEN}✅ Docker установлен${NC}"
    echo -e "${YELLOW}⚠️  Перезайди в систему (или выполни: newgrp docker) и запусти скрипт снова${NC}"
    exit 0
else
    echo -e "${GREEN}✅ Docker: $(docker --version)${NC}"
fi

if ! docker compose version &> /dev/null; then
    echo -e "${RED}❌ Docker Compose не установлен${NC}"
    exit 1
else
    echo -e "${GREEN}✅ Docker Compose: $(docker compose version)${NC}"
fi

for cmd in git curl jq; do
    if ! command -v $cmd &> /dev/null; then
        sudo apt-get update -qq
        sudo apt-get install -y -qq $cmd
        echo -e "${GREEN}✅ $cmd установлен${NC}"
    fi
done
echo ""

# ============================================================================
# ШАГ 2: Создание папок для данных
# ============================================================================
echo -e "${BLUE}📁 Шаг 2/8: Создание папок для данных...${NC}"
DATA_DIR="/mnt/data"
sudo mkdir -p $DATA_DIR/{projects,clients,noco-static/pdfs,backups,nocodb-data}
sudo chown -R $USER:$USER $DATA_DIR

# 🔒 v4.12.0: Безопасные права на каркас файловой системы
# projects/clients = 0755: владелец (вебхук) пишет, SMB-пользователь только читает
# это защищает от переименования/удаления папок проектов через Samba
sudo chmod 0755 $DATA_DIR/projects
sudo chmod 0755 $DATA_DIR/clients
sudo chmod 0755 $DATA_DIR/noco-static
sudo chmod 0775 $DATA_DIR/noco-static/pdfs  # PDF пишут контейнеры
sudo chmod 0700 $DATA_DIR/backups
sudo chmod 0755 $DATA_DIR/nocodb-data

# 🖼 v4.31.0: Папка пользовательской печати организации.
# Своя печать кладётся в /mnt/data/noco-static/img/stamp.png — это зона ДАННЫХ (вне git-кода),
# поэтому обновления (в т.ч. git reset --hard) её не затирают. Эталонная заглушка
# templates/img/stamp.png копируется сюда один раз как стартовая точка.
sudo mkdir -p $DATA_DIR/noco-static/img
if [ -f "templates/img/stamp.png" ] && [ ! -f "$DATA_DIR/noco-static/img/stamp.png" ]; then
    sudo cp templates/img/stamp.png $DATA_DIR/noco-static/img/stamp.png
fi
sudo chown -R $USER:$USER $DATA_DIR/noco-static/img
sudo chmod 0755 $DATA_DIR/noco-static/img
echo -e "${GREEN}✅ Папки созданы в /mnt/data/ (с безопасными правами)${NC}"
echo ""

# ============================================================================
# ШАГ 3: Проверка шаблона и кода
# ============================================================================
echo -e "${BLUE}📦 Шаг 3/8: Проверка файлов...${NC}"
INSTALL_DIR="$(pwd)"
if [ ! -f "template.db" ] || [ ! -f "docker-compose.yml" ]; then
    echo -e "${RED}❌ Отсутствуют template.db или docker-compose.yml!${NC}"
    echo -e "${YELLOW}💡 Убедись, что ты в папке printed4u-crm${NC}"
    exit 1
fi

# 🆕 v4.8.1: Проверка наличия критических скриптов (включая email-install.sh)
# v4.12.0: добавлен modules/backup-install.sh
CRITICAL_SCRIPTS=(
    "setup-bot.sh"
    "apply-template.sh"
    "modules/setup-formulas.sh"
    "modules/email-install.sh"
    "modules/bot-install.sh"
    "modules/samba-install.sh"
    "modules/backup-install.sh"
    "modules/health-alert.sh"
)
for script in "${CRITICAL_SCRIPTS[@]}"; do
    if [ ! -f "$script" ]; then
        echo -e "${RED}❌ Критический скрипт отсутствует: $script${NC}"
        exit 1
    fi
done
echo -e "${GREEN}✅ Файлы и скрипты на месте (${#CRITICAL_SCRIPTS[@]} скриптов проверено)${NC}"
echo ""

# ============================================================================
# ШАГ 3.5: ЗАЩИТА ОТ ПОВТОРНОГО ЗАПУСКА НА УСТАНОВЛЕННОЙ CRM
# install.sh применяет template.db ПОВЕРХ живой базы — случайный запуск на
# рабочей системе уничтожит данные клиента (проекты, контакты, документы).
# Обновление установленной CRM — только через upgrade.sh.
# ============================================================================
FORCE=false
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=true ;;
        *) echo -e "${YELLOW}⚠️  Неизвестный аргумент: $arg (игнорирую)${NC}" ;;
    esac
done

is_installed() {
    [ -f ".env" ] || return 1
    local b t
    b=$(grep -E '^BASE_ID=' .env | head -1 | cut -d= -f2- | tr -d '[:space:]')
    t=$(grep -E '^NOCO_TOKEN=' .env | head -1 | cut -d= -f2- | tr -d '[:space:]')
    # Плейсхолдеры — значит установка не завершена, продолжаем
    [ -n "$b" ] && [ "$b" != "your_base_id_here" ] || return 1
    [ -n "$t" ] && [ "$t" != "your_noco_token_here" ] || return 1
    [ -f "/mnt/data/nocodb-data/noco.db" ] || return 1
    return 0
}

if is_installed; then
    echo ""
    echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${RED}⚠️  Обнаружена УЖЕ УСТАНОВЛЕННАЯ CRM!${NC}"
    echo -e "${RED}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${YELLOW}   Повторный запуск install.sh ПЕРЕЗАПИШЕТ базу шаблоном и${NC}"
    echo -e "${YELLOW}   уничтожит данные клиента. Обновление делается иначе.${NC}"
    echo ""
    if [ "$FORCE" = true ]; then
        echo -e "${RED}   Запущено с --force: полная переустановка с нуля.${NC}"
        echo -e "${RED}   Перед этим будет создан снапшот базы в /mnt/data/backups.${NC}"
        read -p "   Точно перезаписать базу шаблоном? (y/N): " force_confirm
        if [[ "$force_confirm" != "y" && "$force_confirm" != "Y" ]]; then
            echo -e "${GREEN}✅ Отменено. Данные не тронуты.${NC}"
            exit 0
        fi
    else
        read -p "   Выйти (Enter) или запустить upgrade.sh? (u): " upd
        if [[ "$upd" == "u" || "$upd" == "U" ]]; then
            bash upgrade.sh
            exit $?
        fi
        echo -e "${YELLOW}ℹ️  Выход. Для обновления установленной CRM: bash upgrade.sh${NC}"
        exit 0
    fi
fi
echo ""

# ============================================================================
# ШАГ 4: Базовая конфигурация (.env) — БЕЗ SMTP!
# ============================================================================
echo -e "${BLUE}⚙️  Шаг 4/8: Базовая конфигурация .env...${NC}"
ENV_FILE="$INSTALL_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    echo -e "${YELLOW}⚠️  .env уже существует${NC}"
    read -p "Перезаписать? (y/N): " answer
    if [[ "$answer" == "y" || "$answer" == "Y" ]]; then
        cp .env.example .env
        echo -e "${GREEN}✅ .env перезаписан из .env.example${NC}"
    else
        echo -e "${YELLOW}ℹ️  Оставляем существующий .env${NC}"
    fi
else
    cp .env.example .env
    echo -e "${GREEN}✅ .env создан из .env.example${NC}"
fi

echo ""
echo -e "${BLUE}🔐 Генерирую секреты и системные переменные...${NC}"

# ═══════════════════════════════════════════════════════════════════════════
# v4.27.3 (секреты): раньше была только замена через `sed`, а sed НЕ создаёт
# отсутствующие строки. Если в .env не было JWT_SECRET (его никогда не было
# в .env.example!) — переменная не появлялась, и docker-compose подставлял
# публично известный дефолт. Аналогично терялся WEBHOOK_SECRET на старых .env.
# Теперь: строка есть → заменяем, нет → дописываем в конец файла.
# ═══════════════════════════════════════════════════════════════════════════
set_or_append() {
    local key="$1" value="$2" file="$3"
    if grep -q "^${key}=" "$file"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    else
        # Проблема 107: дозапись в .env, который не заканчивается переводом строки,
        # склеивает строки (APP_GID=1000BACKUP_RETENTION_LOCAL=7 → docker падает).
        # [ -n "$(tail -c1 f)" ] true, только когда последний байт НЕ перевод строки.
        [ -n "$(tail -c1 "$file")" ] && echo "" >> "$file"
        echo "${key}=${value}" >> "$file"
    fi
}

set_or_append "JWT_SECRET"     "$(openssl rand -base64 32)" ".env"
set_or_append "WEBHOOK_SECRET" "$(openssl rand -hex 32)"    ".env"
set_or_append "APP_UID"        "$(id -u)"                   ".env"
set_or_append "APP_GID"        "$(id -g)"                   ".env"
# Устанавливаем дефолтный WEBHOOK_HOST на локальный IP (будет перезаписан, если выбран Tailscale)
set_or_append "WEBHOOK_HOST"   "$LOCAL_IP"                  ".env"

# ═══════════════════════════════════════════════════════════════════════════
# Проверка: секреты должны быть сгенерированы, а не пустые/плейсхолдеры.
# Иначе сервисы поднимутся с известным дефолтом (или закроются fail-closed).
# ═══════════════════════════════════════════════════════════════════════════
NEW_JWT=$(grep "^JWT_SECRET=" .env | cut -d= -f2)
NEW_WS=$(grep "^WEBHOOK_SECRET=" .env | cut -d= -f2)
if [ -z "$NEW_JWT" ] || [ "$NEW_JWT" = "auto_generated_base64_string" ]; then
    echo -e "${RED}❌ JWT_SECRET не сгенерирован — прерываю установку. Проверь права на запись .env.${NC}"
    exit 1
fi
if [ -z "$NEW_WS" ] || [ "$NEW_WS" = "your_secret_here" ]; then
    echo -e "${RED}❌ WEBHOOK_SECRET не сгенерирован — прерываю установку. Проверь права на запись .env.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Секреты сгенерированы и записаны в .env (JWT: ${#NEW_JWT} симв., WEBHOOK: ${#NEW_WS} симв.)${NC}"

echo -e "${GREEN}✅ Базовая конфигурация готова${NC}"
echo -e "${YELLOW}💡 SMTP (email-отправка) настроим позже в разделе 'Дополнительные компоненты'${NC}"
echo ""

# ============================================================================
# ШАГ 5: Запуск контейнеров и ожидание NocoDB
# ============================================================================
echo -e "${BLUE}🐳 Шаг 5/8: Запуск контейнеров (это займёт 2-5 минут)...${NC}"
docker compose up -d --build
echo -e "${GREEN}✅ Контейнеры запущены${NC}"

echo -e "${BLUE}⏳ Шаг 6/8: Ожидание запуска NocoDB...${NC}"
MAX_ATTEMPTS=30
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:8081" --connect-timeout 2 --max-time 5 2>/dev/null || echo "000")
    if [[ "$RESPONSE" == "200" || "$RESPONSE" == "302" ]]; then
        echo -e "${GREEN}✅ NocoDB отвечает (попытка $((ATTEMPT+1))/${MAX_ATTEMPTS})${NC}"
        break
    fi
    ATTEMPT=$((ATTEMPT+1))
    sleep 2
done
if [[ "$RESPONSE" != "200" && "$RESPONSE" != "302" ]]; then
    echo -e "${RED}❌ NocoDB не отвечает!${NC}"
    echo -e "${YELLOW}💡 Проверь логи: docker logs printed4u-nocodb${NC}"
    exit 1
fi
echo ""

# ============================================================================
# ШАГ 7: Настройка NocoDB и применение шаблона
# ============================================================================
echo -e "${BLUE}🔧 Шаг 7/8: Настройка NocoDB...${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}⚠️  ВАЖНО! Выполни 3 шага в браузере:${NC}"
echo -e "${YELLOW}1. Открой: http://$ACCESS_IP:8081${NC}"
echo -e "${YELLOW}2. Зарегистрируйся (создай аккаунт)${NC}"
echo -e "${YELLOW}3. СОЗДАЙ НОВУЮ БАЗУ (кнопка 'New base' → назови 'temp')${NC}"
echo -e "${YELLOW}4. Скопируй API Token (Account Settings → Tokens → New Token)${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
read -p "Когда создашь базу и скопируешь токен, нажми Enter..."

read -p "Вставь NocoDB API Token: " noco_token
if [ -z "$noco_token" ]; then
    echo -e "${RED}❌ Токен не может быть пустым!${NC}"
    exit 1
fi
sed -i "s|NOCO_TOKEN=.*|NOCO_TOKEN=$noco_token|" .env
sed -i "s|NOCO_URL=.*|NOCO_URL=http://nocodb:8080|" .env

# ⚠️ v4.34.3: страховочный снапшот живой базы ПЕРЕД применением шаблона.
# apply-template.sh перезаписывает noco.db — при --force/переустановке свежая
# копия остаётся в /mnt/data/backups (переживает перезагрузку, в отличие от /tmp).
if [ -f "/mnt/data/nocodb-data/noco.db" ]; then
    sudo mkdir -p /mnt/data/backups
    BAK_FILE="/mnt/data/backups/noco-before-template-$(date +%Y%m%d_%H%M%S).db"
    if command -v sqlite3 &> /dev/null; then
        sqlite3 /mnt/data/nocodb-data/noco.db ".backup '$BAK_FILE'" 2>/dev/null \
            && echo -e "${GREEN}✅ Страховочный снапшот базы: $BAK_FILE${NC}" \
            || echo -e "${YELLOW}⚠️  Не удалось снять снапшот базы (продолжаю)${NC}"
    else
        docker run --rm \
            -v /mnt/data/nocodb-data:/data \
            -v /mnt/data/backups:/backups \
            alpine:latest sh -c "apk add --no-cache sqlite >/dev/null 2>&1 && sqlite3 /data/noco.db '.backup /backups/$(basename "$BAK_FILE")'" 2>/dev/null \
            && echo -e "${GREEN}✅ Страховочный снапшот базы: $BAK_FILE${NC}" \
            || echo -e "${YELLOW}⚠️  Не удалось снять снапшот базы (продолжаю)${NC}"
    fi
fi

echo -e "${BLUE}🔄 Останавливаю NocoDB для применения шаблона...${NC}"
docker compose stop nocodb
sleep 3

echo -e "${BLUE}📦 Применяю шаблон базы данных...${NC}"
bash apply-template.sh

echo -e "${BLUE}🚀 Запускаю NocoDB...${NC}"
docker compose start nocodb
sleep 15

echo -e "${BLUE}🔧 Устанавливаю BASE_ID...${NC}"
# v4.34.3: ищем базу по title='CRM' (эталон из template.db) с контролем
# единственности. Раньше LIMIT 1 молча брал первую запись — на сервере с
# несколькими базами это мог быть чужой workspace/база.
BASE_ID=""
BASE_LIST=$(docker run --rm -v /mnt/data/nocodb-data:/data alpine:latest sh -c '
apk add --no-cache sqlite >/dev/null 2>&1
sqlite3 /data/noco.db "SELECT id || char(124) || title FROM nc_bases_v2 WHERE deleted=0 ORDER BY created_at;"
' 2>/dev/null || true)
BASE_COUNT=$(printf '%s\n' "$BASE_LIST" | grep -c '|' || true)

# Сначала строгий поиск по названию 'CRM' (без учёта пробелов вокруг)
BASE_ID=$(printf '%s\n' "$BASE_LIST" | awk -F'|' '{gsub(/[[:space:]]/,"",$2); if($2=="CRM"){print $1; exit}}')
# Если CRM не найдена, а база ровно одна — берём её (шаблон могли переименовать)
if [ -z "$BASE_ID" ] && [ "$BASE_COUNT" -eq 1 ]; then
    BASE_ID=$(printf '%s\n' "$BASE_LIST" | head -1 | cut -d'|' -f1)
    echo -e "${YELLOW}ℹ️  База 'CRM' не найдена, но есть единственная — беру её${NC}"
fi
# Несколько баз и ни одной 'CRM' — не угадываем, просим выбрать
if [ -z "$BASE_ID" ] && [ "$BASE_COUNT" -gt 1 ]; then
    echo -e "${YELLOW}⚠️  Не удалось однозначно определить базу CRM. Найдены базы:${NC}"
    printf '%s\n' "$BASE_LIST" | sed 's/^/   • /'
    read -p "Введи id нужной базы (Enter — пропустить): " manual_base
    if [ -n "$manual_base" ]; then
        BASE_ID="$manual_base"
    fi
fi
if [ ! -z "$BASE_ID" ]; then
    sed -i "s|BASE_ID=.*|BASE_ID=$BASE_ID|" .env
    echo -e "${GREEN}✅ BASE_ID установлен: $BASE_ID${NC}"
else
    echo -e "${YELLOW}⚠️  База CRM не найдена, установи BASE_ID вручную${NC}"
fi
echo ""

# ============================================================================
# ИНИЦИАЛИЗАЦИЯ ВЕРСИИ СХЕМЫ (nc_store)
# Новый клиент из template.db уже содержит все фичи — ставим версию = max дельт,
# чтобы первый upgrade.sh не гонял дельты впустую (и не плодил бэкапы).
# ============================================================================
echo -e "${BLUE}🔢 Инициализирую версию схемы...${NC}"
MAX_DELTA=0
for f in upgrades/U*.sh; do
    [ -e "$f" ] || continue
    n=$(basename "$f" | sed -n 's/^U0*\([0-9][0-9]*\)_.*/\1/p')
    [ -n "$n" ] && [ "$n" -gt "$MAX_DELTA" ] && MAX_DELTA="$n"
done
if [ "$MAX_DELTA" -gt 0 ]; then
    NOCO_DB="/mnt/data/nocodb-data/noco.db" bash modules/version.sh set "$MAX_DELTA"
    echo -e "${GREEN}✅ Версия схемы инициализирована: $MAX_DELTA${NC}"
else
    echo -e "${YELLOW}⚠️  Дельт в каталоге upgrades/ нет — версия схемы не инициализирована${NC}"
fi
echo ""

# ============================================================================
# ШАГ 8: Заполнение TABLE_* и выбор способа доступа
# ============================================================================
echo -e "${BLUE}📋 Шаг 8/8: Заполнение ID таблиц и настройка доступа...${NC}"
if [ -f "setup-bot.sh" ]; then
    bash setup-bot.sh --no-restart
else
    echo -e "${YELLOW}⚠️  setup-bot.sh не найден${NC}"
fi

echo ""
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "${MAGENTA}🌐 Как планируешь получать доступ к CRM?${NC}"
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}1) Только локальная сеть (офис/дом)${NC}"
echo -e "${BLUE}2) Через Tailscale (удалённо, безопасно, без белого IP)${NC}"
read -p "Выбери вариант (1/2, по умолчанию 1): " access_mode
access_mode=${access_mode:-1}

if [[ "$access_mode" == "2" ]]; then
    echo -e "${BLUE}🦎 Запускаю установку Tailscale...${NC}"
    if [ -f "modules/tailscale-install.sh" ]; then
        bash modules/tailscale-install.sh
    else
        echo -e "${YELLOW}⚠️  modules/tailscale-install.sh не найден${NC}"
    fi
else
    echo -e "${GREEN}✅ Оставляем доступ по локальной сети.${NC}"
    # Принудительно ставим локальный IP, чтобы избежать 127.0.0.1
    sed -i "s|^WEBHOOK_HOST=.*|WEBHOOK_HOST=$LOCAL_IP|" .env
    echo -e "${BLUE}   WEBHOOK_HOST установлен в: $LOCAL_IP${NC}"
fi

echo ""
echo -e "${BLUE}🔧 Синхронизирую формулы кнопок в NocoDB с актуальными данными...${NC}"
echo -e "${YELLOW}   (Этот шаг выполнится ОДИН раз, используя финальный WEBHOOK_HOST из .env)${NC}"
if [ -f "modules/setup-formulas.sh" ]; then
    bash modules/setup-formulas.sh
else
    echo -e "${YELLOW}⚠️  modules/setup-formulas.sh не найден${NC}"
fi

# ============================================================================
# ФИНАЛЬНЫЙ РАЗДЕЛ: Дополнительные компоненты (модули)
# ============================================================================
echo ""
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "${MAGENTA}🔧 Дополнительные компоненты (можно настроить позже)${NC}"
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"

# --- 1. Telegram бот ---
echo ""
echo -e "${BLUE}🤖 [1/4] Настроить Telegram бота?${NC}"
read -p "(y/n, по умолчанию y): " install_bot
install_bot=${install_bot:-y}
if [[ "$install_bot" == "y" || "$install_bot" == "Y" ]]; then
    if [ -f "modules/bot-install.sh" ]; then
        bash modules/bot-install.sh
    else
        echo -e "${YELLOW}⚠️  modules/bot-install.sh не найден${NC}"
    fi
fi

# --- 2. Samba + Защита файловой системы ---
echo ""
echo -e "${BLUE}📂 [2/4] Настроить сетевые папки Samba (доступ из Windows)?${NC}"
echo -e "${YELLOW}   Вместе с Samba установится watchdog — автопочинка структуры папок (cron, каждые 5 минут)${NC}"
read -p "(y/n, по умолчанию y): " install_samba
install_samba=${install_samba:-y}
if [[ "$install_samba" == "y" || "$install_samba" == "Y" ]]; then
    if [ -f "modules/samba-install.sh" ]; then
        bash modules/samba-install.sh
        # 🛡️ v4.12.0: Watchdog — самоисцеление файловой системы (защита от "кривых рук")
        if [ -f "modules/fix-fs-structure.sh" ]; then
            bash modules/fix-fs-structure.sh --install
        else
            echo -e "${YELLOW}⚠️  modules/fix-fs-structure.sh не найден${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  modules/samba-install.sh не найден${NC}"
    fi
else
    echo -e "${YELLOW}ℹ️  Samba пропущена. Watchdog тоже не установлен.${NC}"
    echo -e "${YELLOW}   Позже можно установить: bash modules/samba-install.sh && bash modules/fix-fs-structure.sh --install${NC}"
fi

# --- 3. Email (SMTP) — НОВЫЙ МОДУЛЬ v4.8.1 ---
echo ""
echo -e "${BLUE}📧 [3/4] Настроить Email-отправку (SMTP)?${NC}"
echo -e "${YELLOW}   Нужна для отправки PDF-документов клиентам.${NC}"
echo -e "${YELLOW}   Если пропустишь — сможешь настроить позже:${NC}"
echo -e "${CYAN}   bash modules/email-install.sh${NC}"
read -p "(y/n, по умолчанию y): " install_email
install_email=${install_email:-y}
if [[ "$install_email" == "y" || "$install_email" == "Y" ]]; then
    if [ -f "modules/email-install.sh" ]; then
        bash modules/email-install.sh
    else
        echo -e "${RED}❌ modules/email-install.sh не найден!${NC}"
        echo -e "${YELLOW}💡 Убедись, что модуль создан и имеет права на выполнение.${NC}"
    fi
fi

# --- 4. Бэкапы (локальные + облачные) — НОВЫЙ МОДУЛЬ v4.12.0 ---
echo ""
echo -e "${BLUE}💾 [4/4] Настроить резервное копирование (локальное + облачное)?${NC}"
echo -e "${YELLOW}   Локальные: полный снапшот (база + проекты + клиенты + PDF) по расписанию.${NC}"
echo -e "${YELLOW}   Облачные: Google Drive через rclone. Статус — в Telegram: /backup.${NC}"
echo -e "${YELLOW}   Если пропустишь — сможешь настроить позже:${NC}"
echo -e "${CYAN}   bash modules/backup-install.sh${NC}"
read -p "(y/n, по умолчанию y): " install_backup
install_backup=${install_backup:-y}
if [[ "$install_backup" == "y" || "$install_backup" == "Y" ]]; then
    if [ -f "modules/backup-install.sh" ]; then
        bash modules/backup-install.sh
    else
        echo -e "${RED}❌ modules/backup-install.sh не найден!${NC}"
        echo -e "${YELLOW}💡 Убедись, что модуль создан и имеет права на выполнение.${NC}"
    fi
fi

# 🛡 v4.24.0: Health-мониторинг сервисов + алерт Руководителю (безотказность)
if [ -f "modules/health-alert.sh" ]; then
    bash modules/health-alert.sh --install
else
    echo -e "${YELLOW}⚠️  modules/health-alert.sh не найден${NC}"
fi

# ============================================================================
# ФИНАЛЬНЫЙ ШАГ: Применение обновлённых переменных окружения
# ============================================================================
echo ""
echo -e "${BLUE}🔄 Применяю обновлённый .env (BASE_ID, WEBHOOK_HOST, секреты, SMTP)...${NC}"

# Пересоздаём контейнеры с новыми переменными окружения
# (docker compose up -d перечитывает .env и пересоздаёт контейнеры)
docker compose up -d --build

echo "   ✅ Контейнеры перезапущены с актуальными переменными"
echo ""

# ============================================================================
# ШАГ 9: Firewall (v4.40.0) — сервисы НЕ публикуются в интернет по умолчанию
# ============================================================================
echo -e "${BLUE}🔥 Шаг 9/9: Настройка firewall (закрываем сервисы от интернета)...${NC}"
FW_ARGS=""
if [ "$SERVER_TYPE" == "vps" ] && [ "$access_mode" != "2" ]; then
    echo -e "${YELLOW}⚠️  VPS без Tailscale. Открыть 8081/3000/3001 в интернет?${NC}"
    echo -e "${YELLOW}   НЕБЕЗОПАСНО без HTTPS! Лучше настрой Tailscale: bash modules/tailscale-install.sh${NC}"
    read -p "Открыть сервисные порты в интернет? (y/N): " pub_open
    if [[ "$pub_open" == "y" || "$pub_open" == "Y" ]]; then
        FW_ARGS="--public"
    fi
fi
if [ -f "modules/firewall-setup.sh" ]; then
    sudo bash modules/firewall-setup.sh $FW_ARGS || echo -e "${YELLOW}⚠️  firewall-setup.sh не прошёл — запусти позже: sudo bash modules/firewall-setup.sh${NC}"
else
    echo -e "${YELLOW}⚠️  modules/firewall-setup.sh не найден${NC}"
fi

# ============================================================================
# ФИНАЛЬНОЕ СООБЩЕНИЕ
# ============================================================================
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}🎉 Printed4U CRM v4.43.1 УСТАНОВЛЕНА!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}🌐 NocoDB UI:       http://$ACCESS_IP:8081${NC}"
echo -e "${BLUE}🤖 Bot Server:      http://$ACCESS_IP:3000${NC}"
echo -e "${BLUE}🔗 Webhook:         http://$ACCESS_IP:3001${NC}"
if [[ "$access_mode" == "2" ]] && command -v tailscale &> /dev/null; then
    TS_IP=$(tailscale ip -4 2>/dev/null || echo "Tailscale IP")
    echo -e "${BLUE}🦎 Tailscale:       http://$TS_IP:8081${NC}"
fi
echo ""
echo -e "${YELLOW}📋 Полезные команды:${NC}"
echo -e "   ${CYAN}bash diagnose.sh${NC}           — диагностика системы"
echo -e "   ${CYAN}bash modules/email-install.sh${NC} — (пере)настроить email"
echo -e "   ${CYAN}bash modules/bot-install.sh${NC}  — (пере)настроить бота"
echo -e "   ${CYAN}bash modules/samba-install.sh${NC} — (пере)настроить Samba"
echo -e "   ${CYAN}bash modules/backup-install.sh${NC} — (пере)настроить бэкапы (локальные + облачные)"
echo -e "   ${CYAN}bash modules/fix-fs-structure.sh --install${NC} — установить watchdog файловой системы"
echo -e "   ${CYAN}bash modules/fix-fs-structure.sh${NC} — разовая проверка структуры папок"
echo -e "   ${CYAN}bash modules/health-alert.sh --install${NC} — установить health-мониторинг + алерт Руководителю"
echo ""
echo -e "${YELLOW}📚 Документация:${NC}"
echo -e "   Подробная документация по установке и эксплуатации — по запросу у автора (см. README.md)"
echo ""
echo -e "${GREEN}✅ Готово! Открой NocoDB UI и начинай работать.${NC}"
echo ""