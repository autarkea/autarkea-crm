#!/bin/bash
# ============================================================================
# Printed4U CRM - Чекер новых версий NocoDB (v1.0.0)
# ============================================================================
# Назначение: отвечает на вопрос «вышла ли новая версия NocoDB?»:
#   - официальная рекомендация образа от самого NocoDB (/api/v1/version →
#     releaseVersion), если API доступен;
#   - GitHub releases (nocodb/nocodb) — последние стабильные теги + даты;
#   - сверка с текущей УСТАНОВЛЕННОЙ версией (контейнер → docker-compose.yml).
#
# Использование:
#   bash modules/nocodb-check-version.sh            # отчёт
#   bash modules/nocodb-check-version.sh --latest-only  # только номер (для скриптов)
#   bash modules/nocodb-check-version.sh --quiet    # без вывода: только лог + exit-код
#
# Выходной код:
#   0 — актуально (обновлений нет)
#   2 — есть новая стабильная версия
#   1 — ошибка (нет сети/не удалось определить)
#
# Переменные окружения: GITHUB_TOKEN (опционально, поднимает rate-limit API),
#   INSTALL_DIR (по умолчанию — корень репозитория).
# ============================================================================
set -uo pipefail

INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_FILE="${LOG_FILE:-/mnt/data/backups/nocodb-version.log}"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"

LATEST_ONLY=false
QUIET=false
for a in "$@"; do
    case "$a" in
        --latest-only) LATEST_ONLY=true ;;
        --quiet)       QUIET=true ;;
        *) echo "❌ Неизвестный аргумент: $a" >&2; exit 1 ;;
    esac
done

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE" 2>/dev/null || true
}
out() {
    if [ "$QUIET" = false ]; then echo -e "$*"; fi
    log "$(echo -e "$*" | sed 's/\x1b\[[0-9;]*m//g')"
}

# ─────────────────────────────────────────────────────────────────────────────
# Текущая установленная версия: контейнер (факт) → docker-compose.yml (пин)
# ─────────────────────────────────────────────────────────────────────────────
get_container_version() {
    command -v docker >/dev/null 2>&1 || return 1
    docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'nocodb' || return 1
    local v
    v=$(docker exec nocodb sh -c 'cat /usr/src/app/package.json 2>/dev/null | grep -m1 "\"version\""' 2>/dev/null | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    [ -n "$v" ] && echo "$v" || return 1
}

get_compose_version() {
    [ -f "$COMPOSE_FILE" ] || return 1
    local v
    v=$(grep -m1 'image: nocodb/nocodb:' "$COMPOSE_FILE" | sed -n 's/.*nocodb\/nocodb:\([^ "]*\).*/\1/p')
    [ -n "$v" ] && echo "$v" || return 1
}

# Сравнение версий вида YYYY.MM.P через sort -V
version_gt() { # $1 > $2
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ] && [ "$1" != "$2" ]
}

# ─────────────────────────────────────────────────────────────────────────────
# Последние стабильные версии с GitHub (реальный источник дат/анонсов)
# ─────────────────────────────────────────────────────────────────────────────
fetch_github_releases() {
    local auth=() url data
    [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
    url="https://api.github.com/repos/nocodb/nocodb/releases?per_page=15"
    data=$(curl -s --max-time 20 "${auth[@]}" "$url") || return 1
    # Фильтр: только стабильные релизы с версией вида 2026.08.2
    echo "$data" | jq -r '.[] | select(.prerelease == false) | [.tag_name, .published_at] | @tsv' 2>/dev/null \
        | awk -F'\t' '$1 ~ /^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}$/ {print}' | head -8
}

# Официальная рекомендация от самого NocoDB (мета-сервис /api/v1/version)
api_release_version() {
    local api
    api=$(curl -s --max-time 5 "http://localhost:8081/api/v1/version" 2>/dev/null) || return 1
    echo "$api" | jq -r '.releaseVersion // empty' 2>/dev/null
}

days_since() { # ISO-дата → целое число дней
    local d
    d=$(date -d "$1" +%s 2>/dev/null) || return 1
    echo $(( ($(date +%s) - d) / 86400 ))
}

# ─────────────────────────────────────────────────────────────────────────────
CURRENT=""
CONTAINER_VER=""
if CONTAINER_VER=$(get_container_version); then
    CURRENT="$CONTAINER_VER"
    CURRENT_SRC="контейнер nocodb"
else
    CURRENT=$(get_compose_version) || CURRENT="?"
    CURRENT_SRC="docker-compose.yml"
fi

API_RELEASE=""
API_RELEASE=$(api_release_version || true)

if [ "$LATEST_ONLY" = true ]; then
    LATEST=$(fetch_github_releases | head -1 | cut -f1)
    if [ -n "$LATEST" ]; then
        echo "$LATEST"
        exit 0
    fi
    if [ -n "$API_RELEASE" ] && [ "$API_RELEASE" != "$CURRENT" ]; then
        echo "$API_RELEASE"
        exit 0
    fi
    echo "❌ Не удалось определить последнюю версию (нет сети/GitHub API)" >&2
    exit 1
fi

out ""
out "${BLUE}🔎 Проверка версий NocoDB${NC}"
out "   Текущая: ${GREEN}${CURRENT}${NC} (источник: $CURRENT_SRC)"
[ -n "$API_RELEASE" ] && out "   NocoDB рекомендует: ${GREEN}${API_RELEASE}${NC} (/api/v1/version)"

mapfile -t RELEASES < <(fetch_github_releases)
if [ ${#RELEASES[@]} -eq 0 ]; then
    out "${YELLOW}⚠️  GitHub releases недоступны (нет сети или rate-limit). Полагаюсь только на рекомендацию NocoDB.${NC}"
else
    out ""
    out "   Последние стабильные релизы (GitHub):"
    i=0
    for line in "${RELEASES[@]}"; do
        i=$((i+1))
        ver="${line%%$'\t'*}"
        pub="${line#*$'\t'}"
        days=$(days_since "$pub" || echo "?")
        mark=""
        [ "$ver" = "$CURRENT" ] && mark=" ← текущая"
        if [ "$i" -eq 1 ]; then
            out "   ${GREEN}● $ver  (${days} дн. назад)${NC}${mark}   ← последняя стабильная"
        else
            out "     $ver  (${days} дн. назад)${mark}"
        fi
    done
fi

# Итог: обновление есть?
LATEST_GH=""
[ ${#RELEASES[@]} -gt 0 ] && LATEST_GH="${RELEASES[0]%%$'\t'*}"
LATEST_CANDIDATE=""
if [ -n "$LATEST_GH" ]; then LATEST_CANDIDATE="$LATEST_GH"; fi
if [ -n "$API_RELEASE" ]; then
    if [ -z "$LATEST_CANDIDATE" ] || version_gt "$API_RELEASE" "$LATEST_CANDIDATE"; then
        LATEST_CANDIDATE="$API_RELEASE"
    fi
fi

out ""
if [ "$CURRENT" = "?" ]; then
    out "${RED}❌ Не удалось определить текущую версию NocoDB${NC}"
    log "ОШИБКА: не удалось определить текущую версию (контейнер и compose недоступны)"
    exit 1
fi

if [ -z "$LATEST_CANDIDATE" ]; then
    out "${RED}❌ Не удалось определить последнюю доступную версию (проверь сеть)${NC}"
    exit 1
fi

if version_gt "$LATEST_CANDIDATE" "$CURRENT"; then
    out "   ${YELLOW}➜ Есть обновление: ${CURRENT} → ${LATEST_CANDIDATE}${NC}"
    out "   ${BLUE}➜ Обновление: bash upgrade-nocodb.sh --to ${LATEST_CANDIDATE}${NC}"
    log "ОБНОВЛЕНИЕ ДОСТУПНО: ${CURRENT} -> ${LATEST_CANDIDATE}"
    exit 2
elif version_gt "$CURRENT" "$LATEST_CANDIDATE"; then
    out "   ${YELLOW}⚠️  Установленная версия НОВЕЕ последнего стабильного релиза (нестандартная ситуация).${NC}"
    log "ВНИМАНИЕ: установлена ${CURRENT}, новее стабильной ${LATEST_CANDIDATE}"
    exit 0
else
    out "   ${GREEN}✅ Актуально: установлена последняя стабильная версия ${CURRENT}${NC}"
    log "АКТУАЛЬНО: ${CURRENT}"
    exit 0
fi
