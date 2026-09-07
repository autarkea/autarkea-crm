#!/bin/bash
set -e
BLUE='\033[0;34m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}🦎 Настройка Tailscale (Secure Mesh VPN)${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

if ! command -v tailscale &> /dev/null; then
    echo -e "${YELLOW}⚠️  Tailscale не найден. Устанавливаю...${NC}"
    curl -fsSL https://tailscale.com/install.sh | sh
else
    echo -e "${GREEN}✅ Tailscale уже установлен${NC}"
fi

echo ""
echo -e "${YELLOW}💡 Сейчас откроется ссылка для авторизации.${NC}"
echo -e "${YELLOW}   Залогинься через Google/GitHub и разреши доступ.${NC}"
echo ""

echo -e "${BLUE}🔄 Активирую Tailscale...${NC}"
sudo tailscale up --accept-routes --accept-dns=false

TAILSCALE_IP=$(tailscale ip -4 | awk '{print $1}')

if [ -z "$TAILSCALE_IP" ] || [[ "$TAILSCALE_IP" == *"Error"* ]]; then
    echo -e "${RED}❌ Не удалось получить Tailscale IP. Проверь авторизацию.${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Tailscale активен!${NC}"
echo -e "${GREEN}   Твой IP в сети: $TAILSCALE_IP${NC}"
echo ""

echo -e "${BLUE}🔧 Обновляю конфигурацию (.env)...${NC}"

# v4.34.3: set_or_append — работает и когда строки WEBHOOK_HOST нет в .env
# (старые .env): дозапись с гарантией перевода строки (Проблема 107).
# Раньше sed обновлял только существующую строку — иначе тихий пропуск.
set_or_append() {
    local key="$1" value="$2" file="$3"
    if grep -q "^${key}=" "$file"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    else
        [ -n "$(tail -c1 "$file")" ] && echo "" >> "$file"
        echo "${key}=${value}" >> "$file"
    fi
}
set_or_append "WEBHOOK_HOST" "$TAILSCALE_IP" ".env"
echo -e "${GREEN}✅ WEBHOOK_HOST обновлён на $TAILSCALE_IP${NC}"
echo ""

echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   🎉 Tailscale настроен!                                  ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}📱 Теперь установи Tailscale на телефон/ноутбук и войди в аккаунт.${NC}"
echo -e "${BLUE}🌐 Доступ к CRM: http://$TAILSCALE_IP:8081${NC}"
echo ""
echo -e "${YELLOW}⚠️  WEBHOOK_HOST изменился: контейнеры читают .env при старте, а формулы${NC}"
echo -e "${YELLOW}   кнопок в NocoDB содержат старый адрес (их синхронизирует setup-formulas.sh).${NC}"
echo -e "${YELLOW}   При установке через install.sh это произойдёт автоматически дальше.${NC}"
read -p "Перезапустить контейнеры и синхронизировать формулы сейчас? (y/N): " restart_now
if [[ "$restart_now" == "y" || "$restart_now" == "Y" ]]; then
    if [ -f "docker-compose.yml" ]; then
        docker compose up -d --build 2>&1 \
            && echo -e "${GREEN}✅ Контейнеры перезапущены с новым WEBHOOK_HOST${NC}" \
            || echo -e "${YELLOW}⚠️  Не удалось перезапустить: docker compose up -d --build${NC}"
    fi
    if [ -f "modules/setup-formulas.sh" ]; then
        bash modules/setup-formulas.sh || echo -e "${YELLOW}⚠️  setup-formulas.sh не прошёл — запусти позже вручную${NC}"
    fi
else
    echo -e "${YELLOW}ℹ️  Применится позже:${NC}"
    echo -e "${YELLOW}   docker compose up -d --build && bash modules/setup-formulas.sh${NC}"
fi
echo ""

# v4.40.0: после настройки Tailscale переприменяем firewall — разрешаем tailnet (100.64.0.0/10)
echo -e "${BLUE}🔥 Применяю firewall (доступ к CRM — только через Tailscale и локальную сеть)...${NC}"
if [ -f "modules/firewall-setup.sh" ]; then
    sudo bash modules/firewall-setup.sh || echo -e "${YELLOW}⚠️  firewall-setup.sh не прошёл — запусти позже: sudo bash modules/firewall-setup.sh${NC}"
else
    echo -e "${YELLOW}⚠️  modules/firewall-setup.sh не найден${NC}"
fi
