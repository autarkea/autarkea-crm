#!/bin/bash
# ============================================================================
# Printed4U CRM — Деинсталлятор v4.3.1 (Полная зачистка, включая Samba + UFW)
# ============================================================================
# Полная очистка сервера от CRM-системы. 
# Возвращает сервер в состояние "как после установки Ubuntu".
# ============================================================================
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

INSTALL_DIR="$HOME/printed4u-crm"
DATA_DIR="/mnt/data"
CURRENT_USER=$(whoami)

echo -e "${RED}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${RED}║   Printed4U CRM — ПОЛНАЯ ОЧИСТКА СЕРВЕРА (HARD RESET)   ║${NC}"
echo -e "${RED}║   Версия: 4.3.1 (полное удаление Samba, UFW, следов)    ║${NC}"
echo -e "${RED}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ============================================
# ПРЕДУПРЕЖДЕНИЕ И СОГЛАСИЕ
# ============================================
echo -e "${YELLOW}⚠️  ВНИМАНИЕ! Это действие НЕОБРАТИМО и удалит:${NC}"
echo "   ❌ Все Docker-контейнеры CRM (NocoDB, бот, webhook)"
echo "   ❌ Docker-образы, volumes и networks проекта"
echo "   ❌ Папку $DATA_DIR (база данных, проекты, клиенты, бэкапы, PDF)"
echo "   ❌ Папку $INSTALL_DIR (весь код CRM, включая .env с секретами)"
echo "   ❌ Nginx конфиги и SSL сертификаты Let's Encrypt"
echo "   ❌ Cron задачи и systemd сервисы, связанные с CRM"
echo "   ❌ Конфигурацию, пользователей, пакеты Samba и правила UFW"
echo "   ❌ Временные файлы в /tmp/"
echo ""
echo -e "${GREEN}✅ Останется только:${NC}"
echo "   ✅ Ubuntu Server, Docker, Git, Tailscale (если был установлен)"
echo ""

read -p "Продолжить? (y/N): " confirm
if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
    echo -e "${YELLOW}Отменено. Сервер не тронут.${NC}"
    exit 0
fi

echo ""

# ============================================
# ШАГ 1: ОПЦИОНАЛЬНЫЙ БЭКАП
# ============================================
echo -e "${BLUE}💾 Шаг 1/12: Бэкап данных (настоятельно рекомендуется)...${NC}"
read -p "Сделать бэкап $DATA_DIR и .env перед удалением? (y/N): " do_backup
BACKUP_DIR=""
if [ "$do_backup" = "y" ] || [ "$do_backup" = "Y" ]; then
    BACKUP_DIR="/tmp/crm_backup_$(date +%Y%m%d_%H%M%S)"
    echo -e "${BLUE}   📦 Создаю бэкап в $BACKUP_DIR...${NC}"
    sudo mkdir -p "$BACKUP_DIR"
    if [ -d "$DATA_DIR" ]; then
        sudo cp -r "$DATA_DIR" "$BACKUP_DIR/" 2>/dev/null || echo -e "${YELLOW}   ⚠️  Не удалось скопировать $DATA_DIR${NC}"
    fi
    if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/.env" ]; then
        sudo cp "$INSTALL_DIR/.env" "$BACKUP_DIR/" 2>/dev/null || true
    fi
    echo -e "${GREEN}   ✅ Бэкап создан: $BACKUP_DIR${NC}"
else
    echo -e "${YELLOW}   ⏭️  Бэкап пропущен. Данные будут уничтожены.${NC}"
fi
echo ""

# ============================================
# ШАГ 2: СОХРАНЯЕМ uninstall.sh
# ============================================
echo -e "${BLUE}💾 Шаг 2/12: Сохраняю uninstall.sh в /tmp...${NC}"
if [ -f "$INSTALL_DIR/uninstall.sh" ]; then
    sudo cp "$INSTALL_DIR/uninstall.sh" /tmp/uninstall.sh
    sudo chmod +x /tmp/uninstall.sh
    echo -e "${GREEN}   ✅ Сохранено: /tmp/uninstall.sh${NC}"
else
    echo -e "${YELLOW}   ⚠️  uninstall.sh не найден${NC}"
fi
echo ""

# ============================================
# ШАГ 3: ОСТАНОВКА КОНТЕЙНЕРОВ
# ============================================
echo -e "${BLUE}🛑 Шаг 3/12: Останавливаю контейнеры через docker compose...${NC}"
if [ -d "$INSTALL_DIR" ] && [ -f "$INSTALL_DIR/docker-compose.yml" ]; then
    cd "$INSTALL_DIR"
    docker compose down --volumes --remove-orphans 2>/dev/null || true
    echo -e "${GREEN}   ✅ Контейнеры и их volumes остановлены и удалены${NC}"
else
    echo -e "${YELLOW}   ⏭️  docker-compose.yml не найден, пропускаю${NC}"
fi
echo ""

# ============================================
# ШАГ 4: ПРИНУДИТЕЛЬНОЕ УДАЛЕНИЕ КОНТЕЙНЕРОВ
# ============================================
echo -e "${BLUE}🗑️  Шаг 4/12: Гарантированное удаление всех контейнеров CRM...${NC}"
CONTAINERS=("nocodb" "printed4u-bot" "printed4u-webhook" "pdf-generator" "project-webhook")
for container in "${CONTAINERS[@]}"; do
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${container}$"; then
        docker rm -f "$container" 2>/dev/null || true
        echo -e "${GREEN}   ✅ $container удалён${NC}"
    fi
done
echo ""

# ============================================
# ШАГ 5: УДАЛЕНИЕ ОБРАЗОВ, VOLUMES И NETWORKS
# ============================================
echo -e "${BLUE}🧹 Шаг 5/12: Зачищаю Docker-образы, volumes и networks...${NC}"
IMAGES=("printed4u-crm-bot" "printed4u-crm-webhook" "nocodb/nocodb:2026.06.2" "nocodb/nocodb:latest")
for image in "${IMAGES[@]}"; do
    if docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -q "^${image}$"; then
        docker rmi -f "$image" 2>/dev/null || true
        echo -e "${GREEN}   ✅ Образ $image удалён${NC}"
    fi
done

echo -e "${BLUE}   🗂️  Удаляю Docker volumes...${NC}"
VOLUMES=$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -E "printed4u|nocodb|crm" || true)
[ -n "$VOLUMES" ] && echo "$VOLUMES" | xargs -r docker volume rm 2>/dev/null || echo -e "${YELLOW}   ⏭️  Volumes не найдены${NC}"

echo -e "${BLUE}   🌐 Удаляю Docker networks...${NC}"
NETWORKS=$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -E "printed4u|crm" || true)
[ -n "$NETWORKS" ] && echo "$NETWORKS" | xargs -r docker network rm 2>/dev/null || echo -e "${YELLOW}   ⏭️  Networks не найдены${NC}"
echo ""

# ============================================
# ШАГ 6: NGINX И SSL
# ============================================
echo -e "${BLUE}🌐 Шаг 6/12: Удаляю Nginx конфиги и SSL сертификаты...${NC}"
sudo rm -f /etc/nginx/sites-available/nocodb /etc/nginx/sites-enabled/nocodb 2>/dev/null || true
sudo rm -f /etc/nginx/sites-available/webhook.printed4u.by /etc/nginx/sites-enabled/webhook.printed4u.by 2>/dev/null || true
sudo rm -f /etc/nginx/sites-available/crm.* /etc/nginx/sites-enabled/crm.* 2>/dev/null || true

if command -v certbot &> /dev/null; then
    for domain in noco.printed4u.by webhook.printed4u.by crm.printed4u.by dev.crm.printed4u.by; do
        sudo certbot delete --cert-name "$domain" --non-interactive 2>/dev/null || true
    done
fi

if [ -x "$(command -v nginx)" ]; then
    sudo nginx -t >/dev/null 2>&1 && sudo systemctl reload nginx 2>/dev/null || true
fi
echo -e "${GREEN}   ✅ Nginx и SSL очищены${NC}"
echo ""

# ============================================
# ШАГ 7: CRON И SYSTEMD
# ============================================
echo -e "${BLUE}⏰ Шаг 7/12: Удаляю cron задачи и systemd сервисы...${NC}"
crontab -l 2>/dev/null | grep -v "backup-nocodb\|backup-to-cloud\|backup-local\|backup-cloud\|printed4u\|crm" | crontab - 2>/dev/null || true
sudo rm -f /etc/cron.d/backup-nocodb /etc/cron.d/backup-to-cloud /etc/cron.d/printed4u /etc/cron.d/crm 2>/dev/null || true

sudo rm -f /etc/systemd/system/backup-*.service /etc/systemd/system/printed4u-*.service 2>/dev/null || true
sudo systemctl daemon-reload 2>/dev/null || true
echo -e "${GREEN}   ✅ Cron и Systemd очищены${NC}"
echo ""

# ============================================
# ШАГ 8: ПОЛНАЯ ЗАЧИСТКА SAMBA + UFW (v4.3.1)
# ============================================
echo -e "${BLUE}📂 Шаг 8/12: Полная зачистка Samba (пакеты, конфиги, пользователи, UFW)...${NC}"
if command -v smbd &> /dev/null; then
    echo -e "${YELLOW}   ⚠️  Удаляю пользователя $CURRENT_USER из базы Samba...${NC}"
    sudo pdbedit -x "$CURRENT_USER" 2>/dev/null || true
    
    echo -e "${YELLOW}   ⚠️  Останавливаю службы Samba...${NC}"
    sudo systemctl stop smbd nmbd 2>/dev/null || true
    
    echo -e "${YELLOW}   ⚠️  Полностью удаляю пакеты Samba и все следы конфигурации...${NC}"
    sudo apt-get purge -y samba samba-common-bin smbclient 2>/dev/null || true
    sudo apt-get autoremove -y 2>/dev/null || true
    
    # Удаляем все папки и файлы, связанные с Samba
    sudo rm -rf /etc/samba /var/lib/samba /var/cache/samba /var/log/samba 2>/dev/null || true
    
    # Удаляем резервные копии smb.conf.backup.* (созданные samba-install.sh)
    sudo rm -f /etc/samba/smb.conf.backup.* 2>/dev/null || true
    
    echo -e "${GREEN}   ✅ Samba полностью вычищена из системы${NC}"
else
    echo -e "${YELLOW}   ⏭️  Samba не установлена, пропускаю${NC}"
fi

# Удаляем правила UFW для Samba (если UFW активен)
if command -v ufw &> /dev/null; then
    if sudo ufw status 2>/dev/null | grep -q "Status: active"; then
        echo -e "${YELLOW}   ⚠️  Удаляю правила UFW для Samba...${NC}"
        sudo ufw delete allow Samba 2>/dev/null || true
        sudo ufw delete allow 137:139/tcp 2>/dev/null || true
        sudo ufw delete allow 445/tcp 2>/dev/null || true
        echo -e "${GREEN}   ✅ Правила UFW для Samba удалены${NC}"
    else
        echo -e "${YELLOW}   ⏭️  UFW не активен, пропускаю${NC}"
    fi
fi
echo ""

# ============================================
# ШАГ 9: RCLONE И PM2 (Legacy)
# ============================================
echo -e "${BLUE}🔄 Шаг 9/12: Очищаю rclone и PM2 (если использовались)...${NC}"
if command -v pm2 &> /dev/null; then
    pm2 delete printed4u-bot project-webhook pdf-generator nocodb 2>/dev/null || true
    pm2 save --force 2>/dev/null || true
fi

RCLONE_CONFIG="$HOME/.config/rclone/rclone.conf"
if [ -f "$RCLONE_CONFIG" ] && grep -q "grive\|google-drive\|printed4u" "$RCLONE_CONFIG" 2>/dev/null; then
    read -p "   Удалить rclone конфигурацию? (y/N): " remove_rclone
    if [[ "$remove_rclone" == "y" || "$remove_rclone" == "Y" ]]; then
        rm -f "$RCLONE_CONFIG"
        echo -e "${GREEN}   ✅ rclone конфигурация удалена${NC}"
    fi
fi
echo ""

# ============================================
# ШАГ 10: УДАЛЕНИЕ ПАПОК ДАННЫХ И КОДА
# ============================================
echo -e "${BLUE}📁 Шаг 10/12: Удаляю папки данных и кода...${NC}"

if [ -d "$DATA_DIR" ]; then
    echo -e "${YELLOW}   ⚠️  Удаляю $DATA_DIR (это займет время, если там много файлов)...${NC}"
    sudo rm -rf "$DATA_DIR"
    echo -e "${GREEN}   ✅ $DATA_DIR удалена${NC}"
fi

if [[ "$(pwd)" == "$INSTALL_DIR" ]]; then
    echo -e "${YELLOW}⚠️  Ты находишься в папке установки. Удалить код? (y/N)${NC}"
    read -p "> " answer
    if [[ "$answer" == "y" || "$answer" == "Y" ]]; then
        cd /
        sudo rm -rf "$INSTALL_DIR"
        echo -e "${GREEN}   ✅ Код удалён${NC}"
    else
        echo -e "${YELLOW}   ⏭️  Код сохранён${NC}"
    fi
elif [ -d "$INSTALL_DIR" ]; then
    sudo rm -rf "$INSTALL_DIR"
    echo -e "${GREEN}   ✅ $INSTALL_DIR удалена${NC}"
fi
echo ""

# ============================================
# ШАГ 11: ОЧИСТКА ВРЕМЕННЫХ ФАЙЛОВ
# ============================================
echo -e "${BLUE}🧹 Шаг 11/12: Удаляю временные файлы...${NC}"
TEMP_FILES=("/tmp/noco_sync_fix.db" "/tmp/noco_debug.db" "/tmp/noco_check.db")
for temp_file in "${TEMP_FILES[@]}"; do
    if [ -f "$temp_file" ]; then
        sudo rm -f "$temp_file" 2>/dev/null || true
        echo -e "${GREEN}   ✅ Удалён: $temp_file${NC}"
    fi
done
echo ""

# ============================================
# ШАГ 12: ФИНАЛЬНАЯ ПРОВЕРКА
# ============================================
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "${MAGENTA}🔍 Финальная проверка чистоты...${NC}"
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"

REMAINING_CONTAINERS=$(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E "nocodb|printed4u|pdf-generator|project-webhook|crm" || true)
[ -z "$REMAINING_CONTAINERS" ] && echo -e "${GREEN}✅ Docker контейнеры: чисты${NC}" || echo -e "${YELLOW}⚠️  Остались контейнеры: $REMAINING_CONTAINERS${NC}"

[ ! -d "$DATA_DIR" ] && echo -e "${GREEN}✅ Папка $DATA_DIR: удалена${NC}" || echo -e "${YELLOW}⚠️  Папка $DATA_DIR: существует${NC}"
[ ! -d "$INSTALL_DIR" ] && echo -e "${GREEN}✅ Папка $INSTALL_DIR: удалена${NC}" || echo -e "${YELLOW}⚠️  Папка $INSTALL_DIR: существует${NC}"

# Проверяем Samba
if command -v smbd &> /dev/null; then
    echo -e "${YELLOW}⚠️  Samba: всё ещё установлена${NC}"
else
    echo -e "${GREEN}✅ Samba: полностью удалена${NC}"
fi

# Проверяем UFW правила
if command -v ufw &> /dev/null; then
    if sudo ufw status 2>/dev/null | grep -qi "samba\|445"; then
        echo -e "${YELLOW}⚠️  UFW: остались правила для Samba${NC}"
    else
        echo -e "${GREEN}✅ UFW: правила для Samba удалены${NC}"
    fi
fi

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   ✅ Сервер полностью очищен и готов к переустановке!     ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}📋 Для быстрой переустановки выполни:${NC}"
echo "   cd ~ && git clone https://github.com/autarkea/autarkea-crm.git printed4u-crm"
echo "   cd printed4u-crm && bash install.sh"
echo ""

if [ -n "$BACKUP_DIR" ]; then
    echo -e "${BLUE}💾 Твой бэкап безопасно сохранён в: $BACKUP_DIR${NC}"
fi