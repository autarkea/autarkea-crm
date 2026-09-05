#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Printed4U CRM — Настройка Cloudflare Tunnel            ║${NC}"
echo -e "${BLUE}║   Версия: 1.0 (HTTPS без проброса портов)               ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ============================================
# ПРОВЕРКА ПРАВ
# ============================================
if [[ $EUID -ne 0 ]]; then
    echo -e "${RED}❌ Запусти скрипт с sudo: sudo bash $0${NC}"
    exit 1
fi

# ============================================
# ШАГ 0: ЧЕК-ЛИСТ ТРЕБОВАНИЙ
# ============================================
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "${MAGENTA}📋 ТРЕБОВАНИЯ ПЕРЕД УСТАНОВКОЙ${NC}"
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${YELLOW}Для работы Cloudflare Tunnel нужно:${NC}"
echo "   ✅ Бесплатный аккаунт Cloudflare (https://dash.cloudflare.com)"
echo "   ✅ Домен, добавленный в Cloudflare (NS записи настроены)"
echo "   ✅ Интернет-соединение (исходящее)"
echo ""
echo -e "${GREEN}✅ Преимущества Cloudflare Tunnel:${NC}"
echo "   ✅ НЕ нужен белый IP"
echo "   ✅ НЕ нужно пробрасывать порты на роутере"
echo "   ✅ Автоматический HTTPS (SSL от Cloudflare)"
echo "   ✅ Бесплатно"
echo "   ✅ Работает через исходящие соединения"
echo ""
echo -e "${YELLOW}💡 Если чего-то не хватает:${NC}"
echo "   • Аккаунт Cloudflare — зарегистрируйся на https://dash.cloudflare.com"
echo "   • Домен в Cloudflare — добавь домен и настрой NS записи у регистратора"
echo "   • Инструкция: https://developers.cloudflare.com/fundamentals/setup/manage-domains/"
echo ""
read -p "Всё готово? Продолжить? (y/N): " ready
if [[ "$ready" != "y" && "$ready" != "Y" ]]; then
    echo -e "${YELLOW}⏸️  Установка отменена. Настрой требования и запусти скрипт снова.${NC}"
    exit 0
fi
echo ""

# ============================================
# ШАГ 1: Установка cloudflared
# ============================================
echo -e "${BLUE}📦 Шаг 1/8: Установка cloudflared...${NC}"
if command -v cloudflared &> /dev/null; then
    echo -e "${GREEN}✅ cloudflared уже установлен: $(cloudflared --version)${NC}"
else
    echo -e "${YELLOW}⚠️  cloudflared не установлен. Устанавливаю...${NC}"
    
    # Определяем архитектуру
    ARCH=$(uname -m)
    if [ "$ARCH" = "x86_64" ]; then
        CLOUDFLARED_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    elif [ "$ARCH" = "aarch64" ]; then
        CLOUDFLARED_URL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
    else
        echo -e "${RED}❌ Неподдерживаемая архитектура: $ARCH${NC}"
        exit 1
    fi
    
    curl -L "$CLOUDFLARED_URL" -o /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared
    
    if command -v cloudflared &> /dev/null; then
        echo -e "${GREEN}✅ cloudflared установлен: $(cloudflared --version)${NC}"
    else
        echo -e "${RED}❌ Не удалось установить cloudflared${NC}"
        exit 1
    fi
fi
echo ""

# ============================================
# ШАГ 2: Авторизация в Cloudflare
# ============================================
echo -e "${BLUE}🔐 Шаг 2/8: Авторизация в Cloudflare...${NC}"
echo ""
echo -e "${YELLOW}⚠️  ВАЖНО! Сейчас откроется ссылка в браузере:${NC}"
echo "   1. Скопируй ссылку ниже"
echo "   2. Открой её в браузере"
echo "   3. Войди в аккаунт Cloudflare"
echo "   4. Выбери домен, который хочешь использовать"
echo "   5. Нажми 'Authorize'"
echo ""
echo -e "${YELLOW}💡 Если скрипт завис — нажми Ctrl+C и запусти снова${NC}"
echo ""

# Авторизация (интерактивная)
cloudflared tunnel login

echo -e "${GREEN}✅ Авторизация успешна${NC}"
echo ""

# ============================================
# ШАГ 3: Ввод доменов
# ============================================
echo -e "${BLUE}🌐 Шаг 3/8: Настройка доменов...${NC}"
echo ""
echo -e "${YELLOW}Выбери режим:${NC}"
echo "   1) Один домен для всего (NocoDB + webhook через /webhook/)"
echo "      Пример: crm.client.by + crm.client.by/webhook/"
echo "   2) Два отдельных домена"
echo "      Пример: crm.client.by + webhook.client.by"
echo ""
read -p "Выбор (1/2): " mode

if [ "$mode" = "1" ]; then
    SINGLE_DOMAIN=true
    read -p "🌐 Основной домен (например, crm.client.by): " MAIN_DOMAIN
    WEBHOOK_DOMAIN="$MAIN_DOMAIN"
    WEBHOOK_PATH="/webhook"
else
    SINGLE_DOMAIN=false
    read -p "🌐 Домен для NocoDB (например, crm.client.by): " MAIN_DOMAIN
    read -p "🌐 Домен для webhook (например, webhook.client.by): " WEBHOOK_DOMAIN
    WEBHOOK_PATH=""
fi

# Валидация домена
if [[ ! "$MAIN_DOMAIN" =~ ^[a-zA-Z0-9.-]+\.[a-z]{2,}$ ]]; then
    echo -e "${RED}❌ Неверный формат домена. Пример: crm.client.by${NC}"
    exit 1
fi
if [ "$SINGLE_DOMAIN" = false ] && [[ ! "$WEBHOOK_DOMAIN" =~ ^[a-zA-Z0-9.-]+\.[a-z]{2,}$ ]]; then
    echo -e "${RED}❌ Неверный формат домена webhook${NC}"
    exit 1
fi

echo ""
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}📋 Конфигурация:${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo "   Режим:           $([ "$SINGLE_DOMAIN" = true ] && echo 'Один домен' || echo 'Два домена')"
echo "   Основной домен:  $MAIN_DOMAIN"
if [ "$SINGLE_DOMAIN" = false ]; then
echo "   Webhook домен:   $WEBHOOK_DOMAIN"
fi
echo ""
echo ""

# ============================================
# ШАГ 4: Создание туннеля
# ============================================
echo -e "${BLUE}🚇 Шаг 4/8: Создание туннеля...${NC}"
TUNNEL_NAME="printed4u-crm"

# Проверяем, есть ли уже туннель с таким именем
if cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
    echo -e "${YELLOW}⚠️  Туннель '$TUNNEL_NAME' уже существует${NC}"
    read -p "Удалить и создать новый? (y/N): " recreate
    if [[ "$recreate" = "y" || "$recreate" = "Y" ]]; then
        TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
        cloudflared tunnel delete "$TUNNEL_NAME"
        echo -e "${GREEN}✅ Старый туннель удалён${NC}"
    else
        echo -e "${YELLOW}⏸️  Используем существующий туннель${NC}"
        TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
    fi
else
    cloudflared tunnel create "$TUNNEL_NAME"
    TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
fi

echo -e "${GREEN}✅ Туннель создан: $TUNNEL_ID${NC}"
echo ""

# ============================================
# ШАГ 5: Создание конфига туннеля
# ============================================
echo -e "${BLUE}📝 Шаг 5/8: Создание конфига туннеля...${NC}"

CONFIG_FILE="/etc/cloudflared/config.yml"
mkdir -p /etc/cloudflared

cat > "$CONFIG_FILE" <<EOF
tunnel: $TUNNEL_ID
credentials-file: /root/.cloudflared/$TUNNEL_ID.json

ingress:
  # HTML шаблоны (статика)
  - hostname: $MAIN_DOMAIN
    path: "*.html"
    service: file:///mnt/data/noco-static
    originRequest:
      noTLSVerify: true
  
  # PDF файлы (статика)
  - hostname: $MAIN_DOMAIN
    path: "/pdfs/*"
    service: file:///mnt/data/noco-static/pdfs
    originRequest:
      noTLSVerify: true
  
  # PDF Generator (Node.js, порт 3000)
  - hostname: $MAIN_DOMAIN
    path: "/generate-pdf"
    service: http://localhost:3000
  
  - hostname: $MAIN_DOMAIN
    path: "/send-email"
    service: http://localhost:3000
EOF

# Если режим одного домена — добавляем webhook через /webhook/
if [ "$SINGLE_DOMAIN" = true ]; then
    cat >> "$CONFIG_FILE" <<EOF
  
  # Webhook через путь /webhook/
  - hostname: $MAIN_DOMAIN
    path: "/webhook/*"
    service: http://localhost:3001
    originRequest:
      noTLSVerify: true
EOF
fi

# NocoDB (должен быть ПОСЛЕДНИМ, чтобы ловить всё остальное)
cat >> "$CONFIG_FILE" <<EOF
  
  # NocoDB (порт 8081) — ловит всё остальное
  - hostname: $MAIN_DOMAIN
    service: http://localhost:8081
EOF

# Если два домена — добавляем отдельный webhook домен
if [ "$SINGLE_DOMAIN" = false ]; then
    cat >> "$CONFIG_FILE" <<EOF
  
  # Webhook (отдельный домен, порт 3001)
  - hostname: $WEBHOOK_DOMAIN
    service: http://localhost:3001
EOF
fi

# Catch-all (обязательно в конце)
cat >> "$CONFIG_FILE" <<EOF
  
  # Catch-all (обязательно в конце!)
  - service: http_status:404
EOF

echo -e "${GREEN}✅ Конфиг создан: $CONFIG_FILE${NC}"
echo ""

# ============================================
# ШАГ 6: Настройка DNS
# ============================================
echo -e "${BLUE}🌐 Шаг 6/8: Настройка DNS записей...${NC}"

# Создаём DNS записи для основного домена
cloudflared tunnel route dns "$TUNNEL_NAME" "$MAIN_DOMAIN"
echo -e "${GREEN}✅ DNS запись создана: $MAIN_DOMAIN${NC}"

# Если два домена — создаём DNS для webhook
if [ "$SINGLE_DOMAIN" = false ]; then
    cloudflared tunnel route dns "$TUNNEL_NAME" "$WEBHOOK_DOMAIN"
    echo -e "${GREEN}✅ DNS запись создана: $WEBHOOK_DOMAIN${NC}"
fi

echo ""

# ============================================
# ШАГ 7: Создание systemd service
# ============================================
echo -e "${BLUE}🔧 Шаг 7/8: Создание systemd service...${NC}"

SERVICE_FILE="/etc/systemd/system/cloudflared.service"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Cloudflare Tunnel for Printed4U CRM
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=notify
TimeoutStartSec=0
ExecStart=/usr/local/bin/cloudflared --no-autoupdate tunnel run
Restart=on-failure
RestartSec=5
User=root
Group=root
Environment=HOME=/root

[Install]
WantedBy=multi-user.target
EOF

# Перезагружаем systemd
systemctl daemon-reload
systemctl enable cloudflared
systemctl start cloudflared

# Проверяем статус
sleep 3
if systemctl is-active --quiet cloudflared; then
    echo -e "${GREEN}✅ Cloudflare Tunnel запущен и работает${NC}"
else
    echo -e "${RED}❌ Не удалось запустить Cloudflare Tunnel${NC}"
    echo -e "${YELLOW}Проверь логи: sudo journalctl -u cloudflared -n 50${NC}"
    exit 1
fi

echo ""

# ============================================
# ШАГ 8: Обновление формул в NocoDB
# ============================================
echo -e "${BLUE}🔄 Шаг 8/8: Обновление формул в NocoDB...${NC}"

# Определяем URL для webhook в формулах
if [ "$SINGLE_DOMAIN" = true ]; then
    WEBHOOK_BASE_URL="https://$MAIN_DOMAIN/webhook"
else
    WEBHOOK_BASE_URL="https://$WEBHOOK_DOMAIN"
fi

# Ищем .env в стандартных местах
ENV_FILE=""
for path in "$(pwd)/.env" "/home/$SUDO_USER/printed4u-crm/.env" "./.env"; do
    if [ -f "$path" ]; then
        ENV_FILE="$path"
        break
    fi
done

if [ -z "$ENV_FILE" ]; then
    echo -e "${YELLOW}⚠️  .env не найден. Формулы нужно обновить вручную.${NC}"
    echo -e "${YELLOW}   Webhook URL: $WEBHOOK_BASE_URL${NC}"
else
    echo -e "${GREEN}✅ .env найден: $ENV_FILE${NC}"
    echo ""
    echo -e "${YELLOW}💡 Формулы нужно обновить вручную в NocoDB UI:${NC}"
    echo -e "   Замени старые URL на новые:"
    echo -e "   ${YELLOW}Старый webhook URL → $WEBHOOK_BASE_URL${NC}"
    echo -e "   ${YELLOW}Старый NocoDB URL → https://$MAIN_DOMAIN${NC}"
    echo ""
    echo -e "${BLUE}📋 Примеры для замены:${NC}"
    echo "   Было: https://webhook.printed4u.by/create-folder?docId="
    echo "   Стало: $WEBHOOK_BASE_URL/create-folder?docId="
    echo ""
    echo "   Было: https://noco.printed4u.by/schet.html?doc="
    echo "   Стало: https://$MAIN_DOMAIN/schet.html?doc="
fi

echo ""

# ============================================
# ШАГ 9: Firewall (v4.40.0) — закрываем прямые порты (доступ только через туннель)
# ============================================
echo -e "${BLUE}🔥 Шаг 9/9: Firewall — закрываю сервисы от интернета (доступ только через Cloudflare Tunnel)...${NC}"
MODULES_DIR_FW="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$MODULES_DIR_FW/firewall-setup.sh" ]; then
    bash "$MODULES_DIR_FW/firewall-setup.sh" || echo -e "${YELLOW}⚠️  firewall-setup.sh не прошёл — запусти позже: sudo bash modules/firewall-setup.sh${NC}"
else
    echo -e "${YELLOW}⚠️  modules/firewall-setup.sh не найден${NC}"
fi
echo ""

# ============================================
# ФИНАЛЬНОЕ СООБЩЕНИЕ
# ============================================
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ✅ Cloudflare Tunnel настроен!                         ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}🌐 Доступ к системе:${NC}"
echo "   NocoDB:     https://$MAIN_DOMAIN"
if [ "$SINGLE_DOMAIN" = true ]; then
echo "   Webhook:    https://$MAIN_DOMAIN/webhook/"
else
echo "   Webhook:    https://$WEBHOOK_DOMAIN"
fi
echo "   PDF:        https://$MAIN_DOMAIN/pdfs/"
echo ""
echo -e "${BLUE}📋 Обновлённые URL для формул NocoDB:${NC}"
echo "   Создать папку:    $WEBHOOK_BASE_URL/create-folder?docId={Id}&secret={SECRET}"
echo "   Обновить файлы:   $WEBHOOK_BASE_URL/refresh-files?docId={Id}&secret={SECRET}"
echo "   Счёт:             https://$MAIN_DOMAIN/schet.html?doc={Id}"
echo "   Акт:              https://$MAIN_DOMAIN/act.html?doc={Id}"
echo "   Накладная:        https://$MAIN_DOMAIN/nakladnaya.html?doc={Id}"
echo ""
echo -e "${BLUE}📋 Полезные команды:${NC}"
echo "   sudo systemctl status cloudflared    # Статус туннеля"
echo "   sudo systemctl restart cloudflared   # Перезапуск туннеля"
echo "   sudo journalctl -u cloudflared -f    # Логи туннеля"
echo "   cloudflared tunnel list              # Список туннелей"
echo "   cat /etc/cloudflared/config.yml      # Конфиг туннеля"
echo ""
echo -e "${YELLOW}💡 Cloudflare Tunnel работает автоматически через systemd.${NC}"
echo -e "${YELLOW}   При перезагрузке сервера туннель запустится сам.${NC}"
echo ""
echo -e "${YELLOW}⚠️  ВАЖНО! Обнови формулы в NocoDB (таблица Проекты):${NC}"
echo "   Замени старые URL на новые из списка выше."
echo ""
