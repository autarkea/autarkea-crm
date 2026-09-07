#!/bin/bash
# ============================================================================
# Printed4U CRM - Health-мониторинг сервисов + алерт Руководителю (v1.0.0)
# ============================================================================
# Назначение: Каждые 5 минут (cron) проверяет живость nocodb / bot / webhook
#   с хоста. При падении — шлёт алерт в Telegram Руководителю (без дублей:
#   флаг-файл на время простоя). При восстановлении — шлёт «восстановлен».
#
# Использование:
#   bash modules/health-alert.sh             # разовая проверка + алерты
#   bash modules/health-alert.sh --install   # установить в cron (каждые 5 мин)
#   bash modules/health-alert.sh --remove    # убрать из cron
# ============================================================================

set -u

LOG_FILE="/mnt/data/logs/health-alert.log"
FLAG_DIR="/mnt/data/logs"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRON_JOB="*/5 * * * * bash $INSTALL_DIR/modules/health-alert.sh >> $LOG_FILE 2>&1"

# Загружаем переменные из .env.
# ⚠️ v4.28.5: НЕ используем `source .env` — он ломается на значениях с пробелами
# и звёздочками (cron: MORNING_CRON=0 10 * * * -> «.env: line N: 10: command not found»).
# Безопасный построчный парсер: снимает кавычки, игнорирует комментарии/пустые строки.
load_env() {
    local file="$1" key val
    [ -f "$file" ] || return 1
    while IFS='=' read -r key val; do
        case "$key" in
            ''|\#*) continue ;;
        esac
        key=$(printf '%s' "$key" | tr -d '[:space:]')
        if [ "${val#\"}" != "$val" ] && [ "${val%\"}" != "$val" ]; then
            val=${val#\"}
            val=${val%\"}
        fi
        export "$key=$val"
    done < "$file"
}
if [ -f "$INSTALL_DIR/.env" ]; then
    load_env "$INSTALL_DIR/.env"
fi

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

log() {
    local ts
    ts=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$ts] $*" | tee -a "$LOG_FILE"
}

# ────────────────────────────────────────────────────────────────────────────
# Отправка сообщения в Telegram (без parse_mode — нечего экранировать)
# ────────────────────────────────────────────────────────────────────────────
send_tg() {
    local chat_id="$1" text="$2"
    curl -fsS -m 10 "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        --data-urlencode "chat_id=$chat_id" \
        --data-urlencode "text=$text" >/dev/null 2>&1
}

# ────────────────────────────────────────────────────────────────────────────
# Telegram_ID Руководителя: из таблицы «Сотрудники» (Роль=Руководитель).
# С хоста NocoDB доступна по localhost:8081 (docker проброс), а не по NOCO_URL
# (внутренний docker-адрес http://nocodb:8080).
# ────────────────────────────────────────────────────────────────────────────
get_admin_chat_id() {
    [ -z "${NOCO_TOKEN:-}" ] && { log "⚠️ NOCO_TOKEN пуст — Руководителя не определить"; return 1; }
    python3 - "$BASE_ID" "$TABLE_EMPLOYEES" "$NOCO_TOKEN" <<'PY'
import sys, json, urllib.request
base_id, table, token = sys.argv[1], sys.argv[2], sys.argv[3]
if not base_id or not table or not token:
    sys.exit(1)
url = f"http://localhost:8081/api/v1/db/data/noco/{base_id}/{table}?limit=100"
req = urllib.request.Request(url, headers={'xc-token': token})
try:
    data = json.load(urllib.request.urlopen(req, timeout=10))
except Exception:
    sys.exit(1)
for emp in data.get('list', []):
    if emp.get('Роль') == 'Руководитель' and emp.get('Telegram_ID'):
        print(emp['Telegram_ID'])
        sys.exit(0)
sys.exit(1)
PY
}

# ────────────────────────────────────────────────────────────────────────────
# Telegram_ID получателя алертов: Руководитель из NocoDB, а если NocoDB лежит
# (упал весь стек — перезагрузка, диск, docker down) — fallback на
# TELEGRAM_USER_ID из .env (v4.46.0, Проблема 117: раньше алерт «немел» ровно
# в момент полного падения, т.к. адресат определялся только через NocoDB).
# ────────────────────────────────────────────────────────────────────────────
resolve_admin_chat_id() {
    local cid
    cid=$(get_admin_chat_id)
    if [ -z "$cid" ] && [ -n "${TELEGRAM_USER_ID:-}" ]; then
        cid=$(printf '%s' "$TELEGRAM_USER_ID" | tr -d '"')
    fi
    printf '%s' "$cid"
}

# ────────────────────────────────────────────────────────────────────────────
# Проверка одного сервиса: up/down + алерт/восстановление (без дублей)
# ────────────────────────────────────────────────────────────────────────────
check_service() {
    local svc="$1" url="$2" name="$3"
    local flag="$FLAG_DIR/health-down-$svc"

    if curl -fsS -m 5 -o /dev/null "$url" 2>/dev/null; then
        if [ -f "$flag" ]; then
            rm -f "$flag"
            local cid
            cid=$(resolve_admin_chat_id)
            log "🟢 $name восстановлен"
            [ -n "$cid" ] && send_tg "$cid" "🟢 Printed4U CRM: $name снова доступен."
        fi
        return 0
    fi

    if [ ! -f "$flag" ]; then
        touch "$flag"
        local cid hostname
        cid=$(resolve_admin_chat_id)
        hostname=$(hostname)
        log "🔴 $name недоступен"
        if [ -n "$cid" ]; then
            send_tg "$cid" "🔴 Printed4U CRM: $name недоступен!\nСервер: $hostname\nВремя: $(date '+%d.%m.%Y %H:%M')\n\nПроверь: docker compose ps / docker compose logs"
        else
            log "⚠️ Не найден Telegram_ID Руководителя — алерт не отправлен"
        fi
    fi
    return 1
}

# ────────────────────────────────────────────────────────────────────────────
# Проверка очереди Telegram (v4.46.0, Проблема 117): бот может «зависнуть»,
# пока /health (:3000, server.js) отвечает 200 — поллинг умер, а мониторинг
# молчит. Индикатор — pending_update_count (апдейты, которые Telegram держит
# в очереди, потому что бот за ними не приходит). Если порог превышен — алерт
# без дублей (флаг-файл, как у сервисов). Если сам Telegram недоступен —
# пропускаем (это ловит check_service по локальным портам + алерт уйдёт по
# fallback-адресату TELEGRAM_USER_ID).
# ────────────────────────────────────────────────────────────────────────────
TG_PENDING_ALERT="${TG_PENDING_ALERT:-10}"
check_tg_pending() {
    local flag="$FLAG_DIR/health-down-botpoll"
    local token="${TELEGRAM_BOT_TOKEN:-}"
    [ -z "$token" ] && return 0

    local pending
    pending=$(curl -fsS -m 10 "https://api.telegram.org/bot${token}/getWebhookInfo" 2>/dev/null \
        | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('pending_update_count',0))" 2>/dev/null)
    [ -z "$pending" ] && return 0 # Telegram недоступен/не парсится — не наш сигнал

    if [ "$pending" -ge "$TG_PENDING_ALERT" ]; then
        if [ ! -f "$flag" ]; then
            touch "$flag"
            local cid hostname
            cid=$(resolve_admin_chat_id)
            hostname=$(hostname)
            log "🔴 Telegram-поллинг: накоплено $pending невостребованных апдейтов (бот не забирает)"
            if [ -n "$cid" ]; then
                send_tg "$cid" "🔴 Printed4U CRM: Telegram-поллинг бота не забирает апдейты!
Очередь: $pending сообщений
Сервер: $hostname
Время: $(date '+%d.%m.%Y %H:%M')

/health (:3000) при этом может отвечать — проверь:
  docker logs printed4u-bot | grep polling_error
  docker restart printed4u-bot"
            else
                log "⚠️ Не найден Telegram_ID Руководителя — алерт не отправлен"
            fi
        fi
        return 1
    fi

    if [ -f "$flag" ]; then
        rm -f "$flag"
        local cid
        cid=$(resolve_admin_chat_id)
        log "🟢 Telegram-поллинг: очередь апдейтов в норме ($pending)"
        [ -n "$cid" ] && send_tg "$cid" "🟢 Printed4U CRM: Telegram-поллинг снова забирает апдейты (очередь: $pending)."
    fi
    return 0
}

# ────────────────────────────────────────────────────────────────────────────
# Установка/удаление cron
# ────────────────────────────────────────────────────────────────────────────
install_cron() {
    mkdir -p /mnt/data/logs 2>/dev/null || true
    if crontab -l 2>/dev/null | grep -q "health-alert.sh"; then
        echo -e "${YELLOW}ℹ️  Health-мониторинг уже в crontab${NC}"
    else
        (crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -
        echo -e "${GREEN}✅ Health-мониторинг добавлен в crontab (каждые 5 минут)${NC}"
    fi
    echo -e "${GREEN}✅ Лог: $LOG_FILE${NC}"
    run_checks
    exit 0
}

remove_cron() {
    if crontab -l 2>/dev/null | grep -q "health-alert.sh"; then
        crontab -l 2>/dev/null | grep -v "health-alert.sh" | crontab -
        echo -e "${GREEN}✅ Health-мониторинг убран из crontab${NC}"
    else
        echo -e "${YELLOW}ℹ️  Health-мониторинг и так не в crontab${NC}"
    fi
    exit 0
}

# ────────────────────────────────────────────────────────────────────────────
# Проверка свободного места на диске (v4.28.2)
# Заполненный /mnt/data (база, проекты, PDF, бэкапы) МОЛЧА убивает SQLite:
# NocoDB падает без явной причины, бэкапы не создаются. Алерт без дублей
# (флаг-файл, как у сервисов). Порог: DISK_ALERT_PERCENT (дефолт 90%).
# ────────────────────────────────────────────────────────────────────────────
DISK_PERCENT="${DISK_ALERT_PERCENT:-90}"
check_disk() {
    local flag="$FLAG_DIR/health-disk-high"
    local pct
    pct=$(df -P /mnt/data 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
    if [ -z "$pct" ]; then
        log "⚠️ Не удалось прочитать df /mnt/data — пропускаю проверку диска"
        return 1
    fi

    if [ "$pct" -ge "$DISK_PERCENT" ]; then
        if [ ! -f "$flag" ]; then
            touch "$flag"
            local cid hostname free_gb
            cid=$(resolve_admin_chat_id)
            hostname=$(hostname)
            free_gb=$(df -h -P /mnt/data 2>/dev/null | awk 'NR==2 {print $4}')
            log "🔴 Диск заполнен на ${pct}% (свободно $free_gb) — порог ${DISK_PERCENT}%"
            if [ -n "$cid" ]; then
                send_tg "$cid" "🔴 Printed4U CRM: диск заполнен на ${pct}%!
Сервер: $hostname
Свободно: $free_gb
Время: $(date '+%d.%m.%Y %H:%M')

Почисти /mnt/data: бэкапы (/mnt/data/backups), проекты (/mnt/data/projects), PDF (/mnt/data/noco-static)."
            else
                log "⚠️ Не найден Telegram_ID Руководителя — алерт не отправлен"
            fi
        fi
        return 1
    fi

    if [ -f "$flag" ]; then
        rm -f "$flag"
        local cid
        cid=$(resolve_admin_chat_id)
        log "🟢 Диск снова в норме (${pct}%)"
        [ -n "$cid" ] && send_tg "$cid" "🟢 Printed4U CRM: диск снова в норме (${pct}% занято)."
    fi
    return 0
}

# ────────────────────────────────────────────────────────────────────────────
# Разовая проверка всех сервисов
# ────────────────────────────────────────────────────────────────────────────
run_checks() {
    mkdir -p /mnt/data/logs 2>/dev/null || true
    check_service nocodb  "http://localhost:8081/"   "NocoDB"
    check_service bot     "http://localhost:3000/health" "Telegram-бот"
    check_tg_pending   # v4.46.0 (Проблема 117): очередь апдейтов — поллинг жив?
    check_service webhook "http://localhost:3001/health" "Webhook"
    check_disk
}

# ────────────────────────────────────────────────────────────────────────────
case "${1:-}" in
    --install) install_cron ;;
    --remove)  remove_cron  ;;
    *)         run_checks   ;;
esac
