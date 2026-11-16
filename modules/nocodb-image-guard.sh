#!/bin/bash
# ============================================================================
# modules/nocodb-image-guard.sh — «какой образ NocoDB просит compose»
# ============================================================================
# Зачем. Клиент обновляется через upgrade.sh, а тот делает `docker compose up`.
# Если тег образа NocoDB в docker-compose.yml новее запущенного контейнера,
# compose ПЕРЕСОЗДАСТ nocodb: NocoDB при старте мигрирует мета-схему, а бэкап,
# пост-проверки и авто-откат делает ТОЛЬКО upgrade-nocodb.sh. Без этой проверки
# обновление кода обошло бы безопасную процедуру и могло оставить клиента на
# мигрированной БД без автоматического отката (аналогия: «залил прошивку мимо
# калибровки стола»).
#
# Использование:
#   bash modules/nocodb-image-guard.sh --compose docker-compose.yml
#   bash modules/nocodb-image-guard.sh --compose FILE --running 2026.08.2
#   bash modules/nocodb-image-guard.sh --compose FILE --quiet
#
# Коды возврата:
#   0  — пересоздавать безопасно: тег в compose совпадает с запущенным образом
#        (или определить нельзя: нет compose/контейнера/docker — не блокируем);
#   10 — в compose ДРУГОЙ тег: сервис nocodb пересоздавать нельзя, обновление
#        NocoDB выполняется отдельно через upgrade-nocodb.sh;
#   2  — ошибка аргументов.
#
# Вывод (если не --quiet): одна строка «compose=<тег> running=<версия>».
# ============================================================================
set -uo pipefail

COMPOSE_FILE=""
RUNNING=""
QUIET=false

while [ $# -gt 0 ]; do
    case "$1" in
        --compose) COMPOSE_FILE="${2:-}"; shift ;;
        --running) RUNNING="${2:-}"; shift ;;
        --quiet)   QUIET=true ;;
        -h|--help)
            sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "❌ Неизвестный аргумент: $1" >&2; exit 2 ;;
    esac
    shift
done

say() { [ "$QUIET" = true ] || echo "$*"; }

# Тег из docker-compose.yml (ровно одна строка image: nocodb/nocodb:<тег>).
compose_tag() {
    [ -n "$COMPOSE_FILE" ] && [ -f "$COMPOSE_FILE" ] || return 1
    local tag
    tag=$(grep -m1 'image: nocodb/nocodb:' "$COMPOSE_FILE" 2>/dev/null \
        | sed -n 's/.*nocodb\/nocodb:\([^ "]*\).*/\1/p')
    [ -n "$tag" ] || return 1
    printf '%s' "$tag"
}

# Версия запущенного контейнера: явный --running важнее docker (тестируемость).
running_tag() {
    if [ -n "$RUNNING" ]; then
        printf '%s' "${RUNNING#nocodb/nocodb:}"
        return 0
    fi
    command -v docker >/dev/null 2>&1 || return 1
    local img
    img=$(docker inspect nocodb --format '{{.Config.Image}}' 2>/dev/null) || return 1
    [ -n "$img" ] || return 1
    printf '%s' "${img#nocodb/nocodb:}"
}

CTAG=$(compose_tag) || { say "compose=unknown running=-"; exit 0; }
RTAG=$(running_tag) || { say "compose=$CTAG running=unknown"; exit 0; }

say "compose=$CTAG running=$RTAG"

if [ "$CTAG" = "latest" ]; then
    # Правило проекта: версия всегда тегом, никогда :latest.
    [ "$QUIET" = true ] || echo "⚠️  в compose образ :latest — версия не зафиксирована" >&2
    exit 10
fi

[ "$CTAG" = "$RTAG" ] && exit 0
exit 10
