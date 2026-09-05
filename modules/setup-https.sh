#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Printed4U CRM — Настройка HTTPS (Nginx + Let's Encrypt)║${NC}"
echo -e "${BLUE}║   Версия: 2.0 (универсальная для клиентов)              ║${NC}"
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
echo -e "${YELLOW}Для работы HTTPS нужно:${NC}"
echo "   ✅ Белый (публичный) IP-адрес от провайдера"
echo "   ✅ Зарегистрированный домен (например, crm.client.by)"
echo "   ✅ A-запись в DNS, указывающая на IP сервера"
echo "   ✅ Проброс портов 80 и 443 на этом сервере в роутере"
echo "   ✅ Порты 80/443 не заняты другими сервисами"
echo ""
echo -e "${YELLOW}💡 Если чего-то не хватает:${NC}"
echo "   • Белый IP — запроси у провайдера (обычно 5-15 BYN/мес)"
echo "   • Домен — купи на reg.by, hoster.by, namecheap.com (~20-40 BYN/год)"
echo "   • DNS — добавь A-запись в панели регистратора"
echo "   • Роутер — зайди в админку (обычно 192.168.1.1) → Port Forwarding"
echo ""
read -p "Всё готово? Продолжить? (y/N): " ready
if [[ "$ready" != "y" && "$ready" != "Y" ]]; then
    echo -e "${YELLOW}⏸️  Установка отменена. Настрой требования и запусти скрипт снова.${NC}"
    exit 0
fi
echo ""

# ============================================
# АВТОПРОВЕРКА: Белый IP
# ============================================
echo -e "${BLUE}📡 Проверяю белый IP...${NC}"
PUBLIC_IP=$(curl -s --connect-timeout 5 ifconfig.me || curl -s --connect-timeout 5 ipinfo.io/ip || echo "")
if [ -z "$PUBLIC_IP" ]; then
    echo -e "${RED}❌ Не удалось определить публичный IP. Проверь интернет.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Публичный IP: $PUBLIC_IP${NC}"

# Проверяем, не серый ли IP
LOCAL_IP=$(hostname -I | awk '{print $1}')
if [[ "$LOCAL_IP" == "10."* ]] || [[ "$LOCAL_IP" == "172.16."* ]] || [[ "$LOCAL_IP" == "192.168."* ]]; then
    if [[ "$PUBLIC_IP" == "$LOCAL_IP" ]]; then
        echo -e "${RED}❌ У тебя СЕРЫЙ IP ($LOCAL_IP). Let's Encrypt НЕ сработает!${NC}"
        echo -e "${YELLOW}💡 Решение: используй Cloudflare Tunnel (setup-cloudflare.sh)${NC}"
        exit 1
    fi
fi
echo ""

# ============================================
# АВТОПРОВЕРКА: Порты 80/443 свободны
# ============================================
echo -e "${BLUE}🔍 Проверяю порты 80 и 443...${NC}"
PORTS_BUSY=false
if ss -tlnp 2>/dev/null | grep -qE ":80\s"; then
    echo -e "${RED}❌ Порт 80 уже занят!${NC}"
    ss -tlnp | grep ":80\s"
    PORTS_BUSY=true
fi
if ss -tlnp 2>/dev/null | grep -qE ":443\s"; then
    echo -e "${RED}❌ Порт 443 уже занят!${NC}"
    ss -tlnp | grep ":443\s"
    PORTS_BUSY=true
fi
if [ "$PORTS_BUSY" = true ]; then
    echo ""
    echo -e "${YELLOW}💡 Решение: останови занятый сервис (nginx/apache) или выбери другой порт.${NC}"
    read -p "Продолжить несмотря на конфликт? (y/N): " force
    if [[ "$force" != "y" && "$force" != "Y" ]]; then
        exit 1
    fi
else
    echo -e "${GREEN}✅ Порты 80 и 443 свободны${NC}"
fi
echo ""

# ============================================
# ВВОД ДОМЕНА
# ============================================
echo -e "${BLUE}🌐 Настройка доменов${NC}"
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

# Email для сертификата
read -p "📧 Email для уведомлений Let's Encrypt (Enter = admin@$MAIN_DOMAIN): " CERT_EMAIL
if [ -z "$CERT_EMAIL" ]; then
    # Берём домен второго уровня для email
    BASE_DOMAIN=$(echo "$MAIN_DOMAIN" | awk -F. '{print $(NF-1)"."$NF}')
    CERT_EMAIL="admin@${BASE_DOMAIN}"
fi

echo ""
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}📋 Конфигурация:${NC}"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
echo "   Публичный IP:    $PUBLIC_IP"
echo "   Режим:           $([ "$SINGLE_DOMAIN" = true ] && echo 'Один домен' || echo 'Два домена')"
echo "   Основной домен:  $MAIN_DOMAIN"
if [ "$SINGLE_DOMAIN" = false ]; then
echo "   Webhook домен:   $WEBHOOK_DOMAIN"
fi
echo "   Email:           $CERT_EMAIL"
echo ""
echo -e "${YELLOW}⚠️  ПРОВЕРЬ DNS:${NC}"
echo "   Создай A-записи в панели регистратора:"
echo "   $MAIN_DOMAIN → $PUBLIC_IP"
if [ "$SINGLE_DOMAIN" = false ]; then
echo "   $WEBHOOK_DOMAIN → $PUBLIC_IP"
fi
echo ""
echo -e "${YELLOW}⚠️  ПРОВЕРЬ РОУТЕР:${NC}"
echo "   Пробрось порты на этот сервер ($LOCAL_IP):"
echo "   80 → $LOCAL_IP:80"
echo "   443 → $LOCAL_IP:443"
echo ""
read -p "DNS и роутер настроены? (y/N): " dns_ok
if [[ "$dns_ok" != "y" && "$dns_ok" != "Y" ]]; then
    echo -e "${RED}❌ Настрой DNS и роутер, затем запусти скрипт снова.${NC}"
    exit 1
fi

# ============================================
# АВТОПРОВЕРКА: DNS резолвится в наш IP
# ============================================
echo ""
echo -e "${BLUE}🔍 Проверяю DNS-записи...${NC}"
DNS_OK=true
for domain in "$MAIN_DOMAIN" "$WEBHOOK_DOMAIN"; do
    RESOLVED_IP=$(dig +short "$domain" A 2>/dev/null | tail -1 || host "$domain" 2>/dev/null | grep "has address" | awk '{print $NF}' || echo "")
    if [ -z "$RESOLVED_IP" ]; then
        echo -e "${RED}❌ Домен $domain не резолвится. Проверь DNS.${NC}"
        DNS_OK=false
    elif [ "$RESOLVED_IP" != "$PUBLIC_IP" ]; then
        echo -e "${RED}❌ Домен $domain указывает на $RESOLVED_IP, а не на $PUBLIC_IP${NC}"
        DNS_OK=false
    else
        echo -e "${GREEN}✅ $domain → $RESOLVED_IP${NC}"
    fi
done

if [ "$DNS_OK" = false ]; then
    echo ""
    echo -e "${YELLOW}💡 DNS обновляется до 24 часов. Подожди и запусти скрипт снова.${NC}"
    read -p "Продолжить несмотря на ошибку DNS? (y/N): " force_dns
    if [[ "$force_dns" != "y" && "$force_dns" != "Y" ]]; then
        exit 1
    fi
fi
echo ""

# ============================================
# ШАГ 1: Установка Nginx + Certbot
# ============================================
echo -e "${BLUE}📦 Шаг 1/6: Установка Nginx + Certbot...${NC}"
apt update -y > /dev/null
apt install -y nginx certbot python3-certbot-nginx dnsutils > /dev/null 2>&1
echo -e "${GREEN}✅ Nginx и Certbot установлены${NC}"
echo ""

# ============================================
# ШАГ 2: Создание конфигов Nginx
# ============================================
echo -e "${BLUE}📝 Шаг 2/6: Создание конфигов Nginx...${NC}"

# Удаляем дефолтный сайт
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

# Конфиг для основного домена (NocoDB + PDF + HTML)
cat > /etc/nginx/sites-available/$MAIN_DOMAIN <<EOF
server {
    listen 80;
    server_name $MAIN_DOMAIN;

    # HTML шаблоны (статика)
    location ~* \.html$ {
        root /mnt/data/noco-static;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    # PDF файлы (статика, через symlinks)
    location /pdfs/ {
        alias /mnt/data/noco-static/pdfs/;
        disable_symlinks off;
        add_header Cache-Control "no-cache, no-store, must-revalidate";
    }

    # PDF Generator (Node.js, порт 3000)
    location ~ ^/(generate-pdf|send-email)$ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
EOF

# Если режим одного домена — добавляем webhook через /webhook/
if [ "$SINGLE_DOMAIN" = true ]; then
    cat >> /etc/nginx/sites-available/$MAIN_DOMAIN <<EOF

    # Webhook через путь /webhook/
    location /webhook/ {
        rewrite ^/webhook/(.*)\$ /\$1 break;
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
EOF
fi

# NocoDB (должен быть ПОСЛЕДНИМ, чтобы ловить всё остальное)
cat >> /etc/nginx/sites-available/$MAIN_DOMAIN <<EOF

    # NocoDB (порт 8081) — ловит всё остальное
    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_cache_bypass \$http_upgrade;
    }

    client_max_body_size 50M;
}
EOF

ln -sf /etc/nginx/sites-available/$MAIN_DOMAIN /etc/nginx/sites-enabled/$MAIN_DOMAIN
echo -e "${GREEN}✅ Конфиг для $MAIN_DOMAIN создан${NC}"

# Если два домена — создаём отдельный конфиг для webhook
if [ "$SINGLE_DOMAIN" = false ]; then
    cat > /etc/nginx/sites-available/$WEBHOOK_DOMAIN <<EOF
server {
    listen 80;
    server_name $WEBHOOK_DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
}
EOF
    ln -sf /etc/nginx/sites-available/$WEBHOOK_DOMAIN /etc/nginx/sites-enabled/$WEBHOOK_DOMAIN
    echo -e "${GREEN}✅ Конфиг для $WEBHOOK_DOMAIN создан${NC}"
fi

# Проверяем синтаксис
if ! nginx -t > /dev/null 2>&1; then
    echo -e "${RED}❌ Ошибка в конфиге Nginx:${NC}"
    nginx -t
    exit 1
fi
systemctl reload nginx
echo ""

# ============================================
# ШАГ 3: Получение SSL сертификатов
# ============================================
echo -e "${BLUE}🔒 Шаг 3/6: Получение SSL-сертификатов...${NC}"

DOMAINS_FOR_CERTBOT="-d $MAIN_DOMAIN"
if [ "$SINGLE_DOMAIN" = false ]; then
    DOMAINS_FOR_CERTBOT="$DOMAINS_FOR_CERTBOT -d $WEBHOOK_DOMAIN"
fi

certbot --nginx \
    $DOMAINS_FOR_CERTBOT \
    --email "$CERT_EMAIL" \
    --agree-tos \
    --no-eff-email \
    --non-interactive \
    --redirect > /dev/null 2>&1

echo -e "${GREEN}✅ SSL-сертификаты получены${NC}"
echo ""

# ============================================
# ШАГ 4: Firewall
# ============================================
echo -e "${BLUE}🔥 Шаг 4/6: Настройка firewall (сервисы закрыты, открываем 80/443 для HTTPS)...${NC}"
MODULES_DIR_FW="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$MODULES_DIR_FW/firewall-setup.sh" ]; then
    bash "$MODULES_DIR_FW/firewall-setup.sh" --https || echo -e "${YELLOW}⚠️  firewall-setup.sh не прошёл — запусти позже: sudo bash modules/firewall-setup.sh --https${NC}"
elif command -v ufw &> /dev/null; then
    ufw allow 80/tcp > /dev/null 2>&1 || true
    ufw allow 443/tcp > /dev/null 2>&1 || true
    echo -e "${GREEN}✅ UFW: порты 80/443 открыты${NC}"
else
    echo -e "${YELLOW}⚠️  UFW не установлен. Убедись, что порты открыты в роутере.${NC}"
fi
echo ""

# ============================================
# ШАГ 5: Автообновление формул в NocoDB
# ============================================
echo -e "${BLUE}🔄 Шаг 5/6: Обновление формул в NocoDB...${NC}"

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
    # Читаем секреты из .env
    source <(grep -E '^(NOCO_TOKEN|NOCO_URL|BASE_ID|WEBHOOK_SECRET)=' "$ENV_FILE")
    
    # Если NOCO_URL — это docker-адрес, меняем на localhost для доступа с хоста
    NOCO_API="http://127.0.0.1:8081"
    
    if [ -n "$NOCO_TOKEN" ] && [ -n "$BASE_ID" ]; then
        # Получаем ID таблицы Проекты
        TABLES_JSON=$(curl -s -H "xc-token: $NOCO_TOKEN" "$NOCO_API/api/v2/meta/bases/$BASE_ID/tables" 2>/dev/null || echo "")
        
        if [ -n "$TABLES_JSON" ]; then
            # Ищем таблицу "Проекты"
            PROJECTS_TABLE_ID=$(echo "$TABLES_JSON" | grep -o '"id":"[^"]*","title":"Проекты"' | head -1 | cut -d'"' -f4)
            
            if [ -n "$PROJECTS_TABLE_ID" ]; then
                # Получаем колонки таблицы
                COLUMNS_JSON=$(curl -s -H "xc-token: $NOCO_TOKEN" "$NOCO_API/api/v2/meta/bases/$BASE_ID/tables/$PROJECTS_TABLE_ID/columns" 2>/dev/null || echo "")
                
                # Ищем колонки с формулами, содержащими webhook
                UPDATED=0
                
                # Функция обновления колонки
                update_column() {
                    local col_id=$1
                    local col_title=$2
                    local old_formula=$3
                    local new_formula=$4
                    
                    # Заменяем старые URL на новые
                    local final_formula="$new_formula"
                    
                    # Обновляем колонку через API
                    curl -s -X PATCH \
                        -H "xc-token: $NOCO_TOKEN" \
                        -H "Content-Type: application/json" \
                        -d "{\"title\":\"$col_title\",\"uidt\":\"formula\",\"colOptions\":{\"formula\":\"$final_formula\"}}" \
                        "$NOCO_API/api/v2/meta/bases/$BASE_ID/tables/$PROJECTS_TABLE_ID/columns/$col_id" > /dev/null 2>&1
                    
                    echo -e "${GREEN}   ✅ Обновлена колонка: $col_title${NC}"
                    UPDATED=$((UPDATED + 1))
                }
                
                # Находим все формульные колонки и обновляем их
                # (Простая реализация — обновляем известные колонки)
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
            else
                echo -e "${YELLOW}⚠️  Таблица 'Проекты' не найдена. Обнови формулы вручную.${NC}"
            fi
        else
            echo -e "${YELLOW}⚠️  Не удалось получить таблицы. Обнови формулы вручную.${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  NOCO_TOKEN или BASE_ID не найдены в .env. Обнови формулы вручную.${NC}"
    fi
fi
echo ""

# ============================================
# ШАГ 6: Проверка автообновления
# ============================================
echo -e "${BLUE}🔄 Шаг 6/6: Проверка автообновления сертификата...${NC}"
if certbot renew --dry-run > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Автообновление работает корректно${NC}"
else
    echo -e "${YELLOW}⚠️  Dry-run не прошёл. Проверь: sudo certbot renew --dry-run${NC}"
fi
echo ""

# ============================================
# ФИНАЛЬНОЕ СООБЩЕНИЕ
# ============================================
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ✅ HTTPS настроен!                                     ║${NC}"
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
echo "   sudo nginx -t                  # Проверить конфиг"
echo "   sudo systemctl reload nginx    # Перезагрузить Nginx"
echo "   sudo certbot certificates      # Список сертификатов"
echo "   sudo certbot renew --dry-run   # Тест автообновления"
echo ""
echo -e "${YELLOW}💡 Сертификат обновляется автоматически (certbot.timer).${NC}"
echo -e "${YELLOW}   Ручное обновление: sudo certbot renew --force-renewal${NC}"
echo ""
echo -e "${YELLOW}⚠️  ВАЖНО! Обнови формулы в NocoDB (таблица Проекты):${NC}"
echo "   Замени старые URL на новые из списка выше."
echo ""
