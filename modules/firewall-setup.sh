#!/bin/bash
# ============================================================================
# Printed4U CRM - Модуль изоляции сервисов от интернета v1.0.0 (релиз v4.40.0)
# ============================================================================
# Назначение: "по умолчанию сервисы НЕ доступны из интернета".
#   NocoDB UI (8081), PDF-генератор (3000), Webhook (3001) разрешаются ТОЛЬКО:
#     - локальной сети сервера (офис/дом, вариант доступа 1 в install.sh)
#     - Tailscale (100.64.0.0/10, вариант доступа 2 в install.sh)
#   Всё остальное входящее — закрыто (default deny).
#   HTTPS/Cloudflare НЕ открываются по умолчанию: ручная опция --https
#   вызывается модулями setup-https.sh / setup-cloudflare.sh при их запуске.
#
# ВАЖНО (Проблема 114): ufw фильтрует INPUT, а порты docker идут через
#   PREROUTING DNAT -> FORWARD (цепочка DOCKER-USER), поэтому правила ufw
#   docker-порты НЕ закрывают (проверено на живом сервере: ufw active,
#   а 8081/3001 открыты в интернет). Реальный контроль — через iptables
#   в DOCKER-USER: отдельная цепочка PRINTED4U-FW + jump из DOCKER-USER.
#   ufw настраивается для не-docker-сервисов (SSH и пр.) и персистентен сам.
#   Правила DOCKER-USER docker сбрасывает при рестарте -> systemd-юнит
#   printed4u-firewall.service пересоздаёт их после docker.service.
#
# Запуск:   sudo bash modules/firewall-setup.sh [--https] [--public] [--status] [--boot]
#   --https   дополнительно открыть 80/443 (ручная настройка HTTPS/Cloudflare)
#   --public  ОПАСНО: открыть 8081/3000/3001 для всех (только VPS-тест без Tailscale)
#   --status  показать текущие правила (без изменений)
#   --boot    тихий режим для systemd (только DOCKER-USER, без ufw enable)
# Идемпотентен: повторный запуск безопасен.
# ============================================================================
set -euo pipefail

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORTS="8081,3000,3001"   # NocoDB UI, PDF-генератор, Webhook
HTTP_PORTS="80,443"

MODE_HTTPS=false
MODE_PUBLIC=false
MODE_BOOT=false
MODE_STATUS=false
for arg in "$@"; do
    case "$arg" in
        --https)  MODE_HTTPS=true ;;
        --public) MODE_PUBLIC=true ;;
        --boot)   MODE_BOOT=true ;;
        --status) MODE_STATUS=true ;;
    esac
done

# ─────────────────────────── Определение параметров ───────────────────────────
SSH_PORT=22
if [ -f /etc/ssh/sshd_config ]; then
    P=$(awk '/^[[:space:]]*Port[[:space:]]+/{print $2; exit}' /etc/ssh/sshd_config)
    [ -n "${P:-}" ] && SSH_PORT="$P"
fi

TS_ACTIVE=false
if ip -4 addr show dev tailscale0 >/dev/null 2>&1; then TS_ACTIVE=true; fi

log()  { echo -e "${GREEN}$1${NC}"; }
warn() { echo -e "${YELLOW}$1${NC}"; }
err()  { echo -e "${RED}$1${NC}"; }

# ─────────────────────────── Статус (read-only) ───────────────────────────
if [ "$MODE_STATUS" = true ]; then
    echo "--- ufw: SSH=$SSH_PORT, порты $PORTS ---"
    if command -v ufw >/dev/null 2>&1; then ufw status verbose 2>/dev/null | grep -E "$SSH_PORT|$PORTS|80|443|Status" || echo "(ufw недоступен без root)"; fi
    echo "--- DOCKER-USER (PRINTED4U-FW) ---"
    sudo -n iptables -S PRINTED4U-FW 2>/dev/null || iptables -S PRINTED4U-FW 2>/dev/null || echo "(нет доступа к iptables)"
    sudo -n ip6tables -S PRINTED4U-FW 2>/dev/null || ip6tables -S PRINTED4U-FW 2>/dev/null || echo "(нет доступа к ip6tables)"
    exit 0
fi

# ─────────────────────────── Проверка прав ───────────────────────────
if [ "$(id -u)" -ne 0 ]; then
    err "⛔ Нужны права root. Запусти так:"
    echo "   sudo bash modules/firewall-setup.sh $*"
    exit 1
fi

# Разрешённые подсети для сервисных портов: ЛЮБЫЕ приватные сети (RFC1918) + Tailscale.
# Это делает поведение одинаковым на любом сервере: какая бы подсеть ни была у клиента
# (офис, дом, несколько подсетей, переезд в другую сеть) — локальный доступ работает,
# а из интернета закрыто (внешние IP в RFC1918 не входят → DROP).
ALLOW_NETS=("10.0.0.0/8" "172.16.0.0/12" "192.168.0.0/16")
if [ "$TS_ACTIVE" = true ]; then ALLOW_NETS+=("100.64.0.0/10"); fi

# ─────────────────────────── UFW (не-docker сервисы) ───────────────────────────
if command -v ufw >/dev/null 2>&1; then
    if [ "$MODE_BOOT" = false ]; then
        log "🔥 UFW: default deny incoming + allow SSH($SSH_PORT)..."
        ufw --force enable >/dev/null
        ufw default deny incoming >/dev/null
        ufw default allow outgoing >/dev/null
        ufw allow "$SSH_PORT"/tcp >/dev/null 2>&1 || ufw allow "$SSH_PORT" >/dev/null 2>&1 || true
        if [ "$MODE_PUBLIC" = true ]; then
            warn "⚠️  Режим --public: открываю $PORTS для ВСЕХ (только VPS-тест!)"
            ufw allow proto tcp to any port "${PORTS//,/}" >/dev/null 2>&1 || ufw allow "$PORTS"/tcp >/dev/null 2>&1 || true
        else
            for net in "${ALLOW_NETS[@]}"; do
                ufw allow from "$net" to any port "$PORTS" proto tcp >/dev/null 2>&1 || true
            done
        fi
        if [ "$MODE_HTTPS" = true ]; then
            log "🌍 HTTPS/Cloudflare: открываю 80/443"
            ufw allow 80/tcp >/dev/null 2>&1 || true
            ufw allow 443/tcp >/dev/null 2>&1 || true
        fi
    fi
else
    warn "⚠️  ufw не установлен — управление не-docker-доступом пропущено (docker-порты закроет iptables ниже)"
fi

# ─────────────────────────── DOCKER-USER (реальный контроль docker) ───────────────────────────
# Отдельная цепочка PRINTED4U-FW (наши правила), чтобы не трогать чужие в DOCKER-USER.
# Применяется и для IPv4 (iptables), и для IPv6 (ip6tables): docker-proxy слушает на :: тоже.
apply_docker_user() {
    local ipt="$1"; shift
    local -a nets=("$@")   # разрешённые подсети (для ip6tables — пусто: IPv6-доступ закрыт целиком)
    if ! "$ipt" -L DOCKER-USER -n >/dev/null 2>&1; then
        warn "⚠️  $ipt: цепочка DOCKER-USER не найдена (docker не запущен?). Запусти после: docker compose up -d"
        return 1
    fi
    log "🛡 $ipt DOCKER-USER: закрываю $PORTS для интернета..."
    "$ipt" -N PRINTED4U-FW 2>/dev/null || true
    "$ipt" -F PRINTED4U-FW
    "$ipt" -D DOCKER-USER -j PRINTED4U-FW 2>/dev/null || true

    if [ "$MODE_PUBLIC" = true ]; then
        "$ipt" -A PRINTED4U-FW -j RETURN
    else
        # 1) разрешённые подсети — первыми (для ip6tables список пуст → IPv6 сервисы закрыты для всех)
        for net in "${nets[@]}"; do
            "$ipt" -A PRINTED4U-FW -p tcp -s "$net" -m multiport --dports "$PORTS" -j ACCEPT
            log "   ✅ разрешено: $net → $PORTS"
        done
        # 2) всё остальное на сервисные порты — DROP
        "$ipt" -A PRINTED4U-FW -p tcp -m multiport --dports "$PORTS" -j DROP
        # 3) прочее — не трогаем
        "$ipt" -A PRINTED4U-FW -j RETURN
    fi
    "$ipt" -I DOCKER-USER 1 -j PRINTED4U-FW
    return 0
}
apply_docker_user iptables "${ALLOW_NETS[@]}"
if command -v ip6tables >/dev/null 2>&1; then
    # IPv6: подсети не передаём — Tailscale/LAN IPv4, IPv6-доступ к сервисам не нужен по умолчанию
    apply_docker_user ip6tables
fi

# ─────────────────────────── systemd-юнит (персистентность после рестарта docker) ───────────────────────────
if [ "$MODE_BOOT" = false ]; then
    UNIT=/etc/systemd/system/printed4u-firewall.service
    log "⚙️  Устанавливаю systemd-юнит: $UNIT"
    cat > "$UNIT" <<EOF
[Unit]
Description=Printed4U CRM firewall (DOCKER-USER rules)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$SCRIPT_DIR/firewall-setup.sh --boot
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload >/dev/null 2>&1 || true
    systemctl enable printed4u-firewall.service >/dev/null 2>&1 || true
fi

# ─────────────────────────── Итог ───────────────────────────
echo ""
log "═══════════════════════════════════════════════════════════"
log "✅ Firewall применён"
if [ "$MODE_PUBLIC" = true ]; then
    warn "   Режим --public: порты $PORTS открыты для ВСЕХ (небезопасно без HTTPS!)"
else
    echo "   Доступ к $PORTS разрешён только из локальных (приватных) сетей:"
    for net in "${ALLOW_NETS[@]}"; do echo "     • $net"; done
    if [ "$MODE_HTTPS" = true ]; then echo "   Плюс открыты 80/443 (HTTPS/Cloudflare)"; fi
    echo "   (Из интернета порты закрыты. Удалённый доступ — через Tailscale: bash modules/tailscale-install.sh)"
fi
echo "   SSH: порт $SSH_PORT открыт"
echo "   Проверка снаружи: http://<IP>:8081 должен НЕ отвечать из интернета"
echo ""
