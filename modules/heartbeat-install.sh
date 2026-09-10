#!/usr/bin/env bash
# ============================================================================
# modules/heartbeat-install.sh — внешний мониторинг healthchecks.io (v4.52.0)
# ============================================================================
# Проблема (Волна 3 безотказности): все локальные алерты (health-alert,
# boot-отчёты, beacon) крутятся НА САМОМ сервере. Если пропало электричество
# или интернет — сервер молчит по определению, и владелец узнаёт о простое
# только когда подойдёт или позвонит клиент.
#
# Решение — ИСХОДЯЩИЙ heartbeat (healthchecks.io):
#   - сервер каждые 5 минут шлёт curl на уникальный URL пинга (встраивается
#     в health-alert.sh run_checks — отдельный cron НЕ нужен);
#   - если пинги пропали дольше grace-периода (~15-20 мин) — healthchecks.io
#     шлёт алерт на email/Telegram («сервер недоступен»); когда пинги
#     возобновились — «снова на связи»;
#   - порты наружу открывать НЕ нужно (исходящий запрос), второй сервер не
#     нужен, бесплатно до ~20 проверок.
#
# Использование:
#   # Интерактивно: вставить готовый Ping URL ИЛИ создать чек по API-ключу:
#   bash modules/heartbeat-install.sh
#   # Неинтерактивно — вставить готовый URL (чек уже создан вручную):
#   bash modules/heartbeat-install.sh --url https://hc-ping.com/<uuid>
#   # Неинтерактивно — создать чек автоматически через healthchecks.io API
#   # (централизованный аккаунт интегратора, установка «под ключ»):
#   bash modules/heartbeat-install.sh --api-key <PROJECT_API_KEY> [--name "CRM <клиент>"]
#   # Отключить (убрать из .env; с --api-key дополнительно удалит чек на healthchecks.io,
#   # чтобы тот не слал ложный «Down» после отключения):
#   bash modules/heartbeat-install.sh --remove [--api-key <PROJECT_API_KEY>]
#
# Модель использования (решение владельца, 09.09.2026):
#   - установки «под ключ»  → чек создаётся в ЦЕНТРАЛЬНОМ аккаунте Аутаркеи
#     (один аккаунт healthchecks.io, чек на каждый сервер клиента). Интегратор
#     видит статусы всех клиентских серверов на одном дашборде — это сервисный
#     инструмент поддержки. Алерты — интегратору (Telegram/email), по желанию
#     клиента добавляется его email в integrations чека.
#   - сами ставящие по публичному репо → регистрируются сами (инструкция ниже).
#   ⚠️ API-ключ проекта healthchecks.io в .env НЕ хранится (даёт доступ ко ВСЕМ
#   чекам проекта) — передаётся только в момент создания/удаления чека.
#   В .env пишется только HEALTHCHECKS_URL (секрет пинга, тоже вне git).
#
# Куда писать: HEALTHCHECKS_URL записывается в .env (вне git). health-alert.sh
# читает .env при каждом cron-тике — перезапуск контейнеров НЕ нужен.
# ============================================================================

set -e

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$INSTALL_DIR/.env"

BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

ACTION="install"
URL_ARG=""
API_KEY=""
CHECK_NAME=""
HC_API="https://healthchecks.io/api/v3"

while [ $# -gt 0 ]; do
    case "$1" in
        --url)      URL_ARG="${2:-}"; shift 2 ;;
        --api-key)  API_KEY="${2:-}"; shift 2 ;;
        --name)     CHECK_NAME="${2:-}"; shift 2 ;;
        --remove)   ACTION="remove"; shift ;;
        *) echo "Неизвестный аргумент: $1" >&2; exit 2 ;;
    esac
done

if [ ! -f "$ENV_FILE" ]; then
    echo -e "${RED}❌ .env не найден: $ENV_FILE${NC}"
    echo -e "${YELLOW}   Запускай из каталога установки CRM (там, где лежит .env)${NC}"
    exit 1
fi

# set_or_append — обновить ключ или дописать с гарантией перевода строки
# (Проблема 107: дозапись в .env без финального \n склеивает строки).
set_or_append() {
    local key="$1" value="$2" file="$3"
    if grep -q "^${key}=" "$file"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    else
        [ -n "$(tail -c1 "$file")" ] && echo "" >> "$file"
        echo "${key}=${value}" >> "$file"
    fi
}

# Текущий HEALTHCHECKS_URL из .env (если есть)
current_url() {
    grep -E '^HEALTHCHECKS_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r' || true
}

# ── healthchecks.io API (v3) ─────────────────────────────────────────────────
# API-ключ проекта: Project Settings → API Access. Даёт доступ ко ВСЕМ чекам
# проекта — поэтому НЕ хранится в .env, передаётся только на время операции.

# Поиск чека по имени. Печатает ping_url, если найден.
api_find_by_name() {
    local key="$1" name="$2"
    curl -fsS -m 15 -H "X-Api-Key: $key" "$HC_API/checks/" 2>/dev/null \
        | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for ch in data.get('checks', []):
    if ch.get('name') == '$name':
        print(ch.get('ping_url', ''))
        break
"
}

# Создание чека. ⚠️ Для интервальных (simple) чеков healthchecks.io v3 ожидает
# поле timeout (как часто ждать пинг), а НЕ period (period — для cron-расписаний).
# Наш пинг раз в 5 минут (health-alert cron) → timeout=300, grace=1200 (20 мин = 4 пропуска).
# Баг v4.52.1 (найден живым прогоном Р12): отправляли "period" → сервер молча
# ставил timeout=86400 (пинг раз в сутки), down наступал бы только через 24 ч.
api_create_check() {
    local key="$1" name="$2"
    curl -fsS -m 20 -X POST -H "X-Api-Key: $key" \
        -H "Content-Type: application/json" \
        -d "{\"name\": \"$name\", \"timeout\": 300, \"grace\": 1200}" \
        "$HC_API/checks/" 2>/dev/null \
        | python3 -c "import sys, json; print(json.load(sys.stdin).get('ping_url', ''))"
}

# Удаление чека по URL (код = последний сегмент пути).
# ⚠️ healthchecks.io v3: DELETE /checks/<code>/ со слэшем возвращает 404,
# без слэша — 200 (проверено живым прогоном Р12, 09.09.2026).
api_delete_by_url() {
    local key="$1" url="$2"
    local code
    code=$(echo "$url" | sed 's|.*/||')
    [ -z "$code" ] && return 1
    curl -fsS -m 15 -X DELETE -H "X-Api-Key: $key" "$HC_API/checks/$code" >/dev/null 2>&1
}

remove_heartbeat() {
    local url
    url=$(current_url)
    if [ -z "$url" ]; then
        echo -e "${YELLOW}ℹ️  HEALTHCHECKS_URL и так не задан — внешний мониторинг выключен${NC}"
        return 0
    fi
    sed -i "/^HEALTHCHECKS_URL=/d" "$ENV_FILE"
    echo -e "${GREEN}✅ HEALTHCHECKS_URL убран из .env — внешний мониторинг выключен${NC}"
    if [ -n "$API_KEY" ]; then
        if api_delete_by_url "$API_KEY" "$url"; then
            echo -e "${GREEN}✅ Чек на healthchecks.io удалён (по URL из .env)${NC}"
        else
            echo -e "${YELLOW}⚠️  Не удалось удалить чек на healthchecks.io (проверь API-ключ)${NC}"
            echo -e "${YELLOW}   Чек останется и будет слать ложный «Down» — удали вручную в UI.${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  Чек на healthchecks.io НЕ удалён (не передан --api-key).${NC}"
        echo -e "${YELLOW}   Пока чек жив — пинги пропадут, и придёт ложный «Down».${NC}"
        echo -e "${YELLOW}   Удали чек вручную в UI или повтори: bash modules/heartbeat-install.sh --remove --api-key <ключ>${NC}"
    fi
}

print_banner() {
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}💓 Внешний мониторинг healthchecks.io (Волна 3)${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
    echo ""
}

# Инструкция для самостоятельной регистрации (сами ставящие по публичному репо)
print_guide_self() {
    echo -e "${YELLOW}Как включить позже самостоятельно (2 минуты):${NC}"
    echo "  1. Зарегистрируйся: https://healthchecks.io (бесплатно, ~20 проверок)"
    echo "  2. Add Check → Name: 'CRM <сервер>' → Period: 5 min → Grace: 20 min"
    echo "     (пинг раз в 5 минут = наш health-alert cron; grace 20 = 4 пропуска)"
    echo "     Уведомления (email/Telegram) настрой в Integrations."
    echo "  3. Скопируй Ping URL вида: https://hc-ping.com/<uuid>"
    echo "  4. На сервере: bash modules/heartbeat-install.sh --url https://hc-ping.com/<uuid>"
    echo ""
    echo -e "${YELLOW}ВАЖНО: URL пинга — СЕКРЕТ (по нему можно слать ложные «жив»).${NC}"
    echo -e "${YELLOW}Хранится только в .env (вне git), как и остальные токены.${NC}"
    echo ""
}

test_ping() {
    local url="$1"
    echo -e "${BLUE}📡 Тестовый пинг...${NC}"
    if curl -fsS -m 10 "$url" >/dev/null 2>&1; then
        echo -e "${GREEN}✅ Пинг принят (HTTP 200) — healthchecks.io видит сервер${NC}"
    else
        echo -e "${RED}❌ Пинг не прошёл. Проверь URL и доступ в интернет.${NC}"
        exit 1
    fi
}

save_and_finish() {
    local url="$1"
    test_ping "$url"
    echo -e "${BLUE}🔧 Записываю HEALTHCHECKS_URL в .env...${NC}"
    set_or_append "HEALTHCHECKS_URL" "$url" "$ENV_FILE"
    echo -e "${GREEN}✅ HEALTHCHECKS_URL сохранён в .env${NC}"
    echo ""
    echo -e "${GREEN}✅ Готово! health-alert.sh будет пинговать при каждом тике (каждые 5 мин).${NC}"
    echo -e "${YELLOW}   Проверка: bash modules/health-alert.sh${NC}"
    echo -e "${YELLOW}   Отключить: bash modules/heartbeat-install.sh --remove${NC}"
}

# ── Основной поток ───────────────────────────────────────────────────────────
if [ "$ACTION" = "remove" ]; then
    remove_heartbeat
    exit 0
fi

print_banner

# Режим: создать/найти чек через API (центральный аккаунт интегратора)
if [ -n "$API_KEY" ]; then
    NAME="${CHECK_NAME:-CRM $(hostname)}"
    echo -e "${BLUE}🔎 Ищу существующий чек «$NAME» в проекте healthchecks.io...${NC}"
    URL=$(api_find_by_name "$API_KEY" "$NAME")
    if [ -n "$URL" ]; then
        echo -e "${GREEN}✅ Чек «$NAME» уже есть — использую его (идемпотентно, дубль не создаю)${NC}"
    else
        echo -e "${BLUE}➕ Создаю чек «$NAME» (timeout 5 min, grace 20 min)...${NC}"
        URL=$(api_create_check "$API_KEY" "$NAME")
    fi
    if [ -z "$URL" ]; then
        echo -e "${RED}❌ Не удалось создать/найти чек. Проверь API-ключ проекта (Project Settings → API Access).${NC}"
        exit 1
    fi
    save_and_finish "$URL"
    exit 0
fi

# Режим: вставить готовый Ping URL
if [ -n "$URL_ARG" ]; then
    save_and_finish "$URL_ARG"
    exit 0
fi

# Интерактивный режим (install.sh «под ключ» или ручная настройка)
echo -e "${BLUE}Как настроить внешний мониторинг?${NC}"
echo -e "  1) У меня уже есть Ping URL (чек создан вручную на healthchecks.io)"
echo -e "  2) Создать чек автоматически (API-ключ проекта healthchecks.io)"
echo -e "     — вариант для установок «под ключ» (чек в аккаунте интегратора)"
echo -e "  3) Пропустить — покажу инструкцию для самостоятельной регистрации"
read -r -p "Выбери вариант (1/2/3, по умолчанию 3): " choice
choice=${choice:-3}

case "$choice" in
    1)
        read -r -p "Вставь Ping URL (https://hc-ping.com/...): " URL
        case "$URL" in
            https://*|http://*) ;;
            *) echo -e "${RED}❌ Похоже, это не URL. Ожидается: https://hc-ping.com/<uuid>${NC}"; exit 1 ;;
        esac
        if [ -z "$URL" ]; then
            echo -e "${YELLOW}ℹ️  Пусто — внешний мониторинг не включён${NC}"
            exit 0
        fi
        save_and_finish "$URL"
        ;;
    2)
        echo -e "${YELLOW}API-ключ проекта (Project Settings → API Access).${NC}"
        echo -e "${YELLOW}Даёт доступ ко ВСЕМ чекам проекта — в .env НЕ сохраняется.${NC}"
        read -r -s -p "API-ключ: " API_KEY
        echo ""
        if [ -z "$API_KEY" ]; then
            echo -e "${YELLOW}ℹ️  Пусто — внешний мониторинг не включён${NC}"
            exit 0
        fi
        NAME="${CHECK_NAME:-CRM $(hostname)}"
        echo -e "${BLUE}🔎 Ищу существующий чек «$NAME»...${NC}"
        URL=$(api_find_by_name "$API_KEY" "$NAME")
        if [ -n "$URL" ]; then
            echo -e "${GREEN}✅ Чек «$NAME» уже есть — использую его${NC}"
        else
            echo -e "${BLUE}➕ Создаю чек «$NAME» (timeout 5 min, grace 20 min)...${NC}"
            URL=$(api_create_check "$API_KEY" "$NAME")
        fi
        if [ -z "$URL" ]; then
            echo -e "${RED}❌ Не удалось создать/найти чек. Проверь API-ключ.${NC}"
            exit 1
        fi
        save_and_finish "$URL"
        ;;
    *)
        echo -e "${YELLOW}ℹ️  Пропускаю (можно включить позже).${NC}"
        print_guide_self
        ;;
esac
