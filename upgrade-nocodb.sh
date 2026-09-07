#!/bin/bash
# ============================================================================
# Printed4U CRM - Безопасное обновление образа NocoDB (upgrade-nocodb.sh v1.0.0)
# ============================================================================
# Полу-автомат безопасного обновления образа NocoDB (версия движка).
# Обновляет ТОЛЬКО образ
# nocodb/nocodb (версию движка), НЕ трогает код CRM (это upgrade.sh) и НЕ
# трогает данные клиента: перед обновлением — консистентный бэкап БД
# (sqlite3 .backup на живой базе), при провале — авто-откат на прежнюю версию.
#
# ⚠️ Правило readme №1: обновление версии NocoDB — только с согласия владельца.
#    Версия пинится тегом в docker-compose.yml (никогда :latest).
#
# Использование:
#   bash upgrade-nocodb.sh --check                       # проверить версии
#   bash upgrade-nocodb.sh --dry-run --to 2026.08.2      # показать план
#   bash upgrade-nocodb.sh --to 2026.08.2 --yes          # выполнить без вопросов
#   bash upgrade-nocodb.sh --to 2026.08.2                # выполнить (спросит подтверждение)
#   bash upgrade-nocodb.sh                               # в --to подставится последняя стабильная
#
# Ключи:
#   --check        проверить версии и выйти (как modules/nocodb-check-version.sh)
#   --dry-run      показать план, ничего не менять
#   --to X.Y.Z     целевая версия (по умолчанию — последняя стабильная)
#   --yes          не задавать вопросов подтверждения
#   --skip-backup  ⚠️ ОПАСНО: без бэкапа (только для репетиции на копии/VM)
#   --skip-diagnose  не запускать diagnose-upgrade.sh после успеха
#
# Переменные окружения: INSTALL_DIR, NOCO_DB, BACKUP_DIR (для тестов/VM).
# Выходной код: 0 успех, 2 обновление не требуется/отменено, 1 ошибка.
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
BACKUP_DIR="${BACKUP_DIR:-/mnt/data/backups}"
LOG_FILE="${LOG_FILE:-/mnt/data/nocodb-data/upgrade.log}"

DO_CHECK=false
DRY_RUN=false
SKIP_BACKUP=false
SKIP_DIAGNOSE=false
ASSUME_YES=false
TARGET_VER=""

while [ $# -gt 0 ]; do
    case "$1" in
        --check)         DO_CHECK=true ;;
        --dry-run)       DRY_RUN=true ;;
        --skip-backup)   SKIP_BACKUP=true ;;
        --skip-diagnose) SKIP_DIAGNOSE=true ;;
        --yes)           ASSUME_YES=true ;;
        --to)            TARGET_VER="$2"; shift ;;
        *) echo "❌ Неизвестный аргумент: $1" >&2; exit 1 ;;
    esac
    shift
done

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'

log() { echo -e "$*"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $(echo -e "$*" | sed 's/\x1b\[[0-9;]*m//g')" >> "$LOG_FILE" 2>/dev/null || true; }
err() { log "${RED}❌ $*${NC}"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
version_gt() { # $1 > $2
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ] && [ "$1" != "$2" ]
}
valid_version() { # формат YYYY.MM.P
    echo "$1" | grep -qE '^[0-9]{4}\.[0-9]{1,2}\.[0-9]{1,2}$'
}

# ─────────────────────────────────────────────────────────────────────────────
get_compose_version() {
    local v
    v=$(grep -m1 'image: nocodb/nocodb:' "$COMPOSE_FILE" | sed -n 's/.*nocodb\/nocodb:\([^ "]*\).*/\1/p')
    [ -n "$v" ] && echo "$v" || echo ""
}
get_container_version() {
    local v
    v=$(docker exec nocodb sh -c 'cat /usr/src/app/package.json 2>/dev/null | grep -m1 "\"version\""' 2>/dev/null | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    [ -n "$v" ] && echo "$v" || echo ""
}
latest_stable() { # последняя стабильная: GitHub, fallback — рекомендация NocoDB API
    local gh api
    gh=$(bash "$INSTALL_DIR/modules/nocodb-check-version.sh" --latest-only 2>/dev/null || true)
    [ -n "$gh" ] && { echo "$gh"; return; }
    api=$(curl -s --max-time 5 "http://localhost:8081/api/v1/version" 2>/dev/null | jq -r '.releaseVersion // empty' 2>/dev/null || true)
    [ -n "$api" ] && { echo "$api"; return; }
    echo ""
}
# ─────────────────────────────────────────────────────────────────────────────
# Ожидание healthy контейнера nocodb (таймаут в секундах = $1, дефолт 240)
# ─────────────────────────────────────────────────────────────────────────────
wait_healthy() {
    local timeout="${1:-240}" i state health
    for i in $(seq 1 "$((timeout / 5))"); do
        state=$(docker inspect --format '{{.State.Status}}' nocodb 2>/dev/null || echo "missing")
        if [ "$state" = "running" ]; then
            health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' nocodb 2>/dev/null || echo "none")
            if [ "$health" = "healthy" ]; then
                return 0
            fi
        elif [ "$state" != "restarting" ]; then
            log "   ...статус контейнера: $state (жду запуска)"
        fi
        sleep 5
    done
    return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# --check: делегируем чекеру
# ─────────────────────────────────────────────────────────────────────────────
if [ "$DO_CHECK" = true ]; then
    bash "$INSTALL_DIR/modules/nocodb-check-version.sh"
    exit $?
fi

# ─────────────────────────────────────────────────────────────────────────────
# ПРЕФЛАЙТ
# ─────────────────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || err "docker не установлен"
command -v sqlite3 >/dev/null 2>&1 || err "sqlite3 не установлен"
command -v curl >/dev/null 2>&1 || err "curl не установлен"
command -v jq >/dev/null 2>&1 || err "jq не установлен"
[ -f "$COMPOSE_FILE" ] || err "docker-compose.yml не найден: $COMPOSE_FILE"
[ -f "$NOCO_DB" ] || err "База NocoDB не найдена: $NOCO_DB"

grep -q 'nocodb:' "$COMPOSE_FILE" || err "В docker-compose.yml не найден сервис nocodb"
docker ps --format '{{.Names}}' | grep -qx 'nocodb' || err "Контейнер nocodb не запущен — сначала установи/подними CRM (bash install.sh)"

CURRENT=$(get_compose_version)
[ -n "$CURRENT" ] || err "Не удалось прочитать версию NocoDB из $COMPOSE_FILE"
log "${BLUE}───────────────────────────────────────────────────────────${NC}"
log "${BLUE}🔄 upgrade-nocodb.sh v1.0.0 — обновление образа NocoDB${NC}"
log "${BLUE}   Текущая (compose): ${GREEN}$CURRENT${NC}"

# Фактическая версия контейнера — если отличается от compose, это уже рассинхрон
CONTAINER_VER=$(get_container_version)
if [ -n "$CONTAINER_VER" ] && [ "$CONTAINER_VER" != "$CURRENT" ]; then
    log "${YELLOW}⚠️  Рассинхрон: контейнер = $CONTAINER_VER, docker-compose.yml = $CURRENT${NC}"
    log "   Обновление начнётся от compose-версии $CURRENT → целевой."
fi

if [ -z "$TARGET_VER" ]; then
    TARGET_VER=$(latest_stable)
    [ -n "$TARGET_VER" ] || err "Не удалось определить последнюю версию (нет сети?). Укажи --to X.Y.Z"
    log "   Целевая (последняя стабильная): ${GREEN}$TARGET_VER${NC}"
else
    valid_version "$TARGET_VER" || err "Неверный формат версии: $TARGET_VER (ожидается YYYY.MM.P, например 2026.08.2)"
    log "   Целевая (--to): ${GREEN}$TARGET_VER${NC}"
fi

if [ "$TARGET_VER" = "$CURRENT" ]; then
    log "${GREEN}✅ Версия $CURRENT уже актуальна — обновление не требуется.${NC}"
    exit 2
fi

if version_gt "$CURRENT" "$TARGET_VER"; then
    log "${RED}⚠️  Это DOWNGRADE: $CURRENT → $TARGET_VER.${NC}"
    log "   NocoDB мигрирует мета-схему вперёд — откат версии образа может не подняться"
    log "   на уже мигрированной БД. Downgrade не поддерживается этим скриптом."
    err "Остановлено (для даунгрейда: восстанови из бэкапа modules/backup-local.sh)"
fi

# Диск: нужно минимум ~2 ГБ свободного (образ NocoDB ~ сотни МБ)
FREE_MB=$(df -Pk "$(dirname "$NOCO_DB")" | awk 'NR==2 {print $4/1024}')
if [ "${FREE_MB%.*}" -lt 2048 ]; then
    err "Мало места на диске: ${FREE_MB%.*} МБ (нужно ≥ 2048 МБ)"
fi

log "${BLUE}───────────────────────────────────────────────────────────${NC}"
log "ℹ️  План обновления NocoDB:"
log "   1. Бэкап БД   → sqlite3 .backup (консистентно, на живой базе)"
log "   2. Бэкап      → docker-compose.yml (в папку бэкапа)"
log "   3. Правка     → image: nocodb/nocodb:$CURRENT → $TARGET_VER"
log "   4. Pull       → docker compose pull nocodb"
log "   5. Запуск     → docker compose up -d nocodb (пересоздание контейнера)"
log "   6. Ожидание   → healthcheck NocoDB (до 4 мин)"
log "   7. Проверки   → версия, целостность БД, workspace, связи, nc_sources_v2"
log "   8. Диагностика → diagnose-upgrade.sh"
log "   При провале  → авто-откат на $CURRENT (compose, при необходимости — БД из бэкапа)"
log ""

if [ "$DRY_RUN" = true ]; then
    log "${YELLOW}Режим просмотра (--dry-run): изменения НЕ применяются.${NC}"
    log "Для выполнения без вопросов: bash upgrade-nocodb.sh --to $TARGET_VER --yes"
    exit 0
fi

if [ "$SKIP_BACKUP" = true ]; then
    log "${RED}⚠️  ВНИМАНИЕ: бэкап ОТКЛЮЧЁН (--skip-backup). Допустимо только на копии/VM.${NC}"
    if [ "$ASSUME_YES" != true ]; then
        read -r -p "Точно продолжаем без бэкапа? (yes/N): " ans
        [ "$ans" = "yes" ] || { log "Отменено."; exit 2; }
    fi
elif [ "$ASSUME_YES" != true ]; then
    log "Подтверди обновление NocoDB ${YELLOW}$CURRENT → $TARGET_VER${NC}"
    read -r -p "Продолжить? (y/N): " ans
    case "$ans" in y|Y|yes|Yes|YES) ;; *) log "Отменено."; exit 2 ;; esac
fi


# ─────────────────────────────────────────────────────────────────────────────
# БЭКАП (шаги 1-2). Копия docker-compose.yml делается ВСЕГДА (нужна для
# отката даже при --skip-backup), снапшот БД — по умолчанию, кроме --skip-backup.
# ─────────────────────────────────────────────────────────────────────────────
TS=$(date +%Y%m%d_%H%M%S)
UPGRADE_ROOT="$BACKUP_DIR/nocodb-upgrade"
mkdir -p "$UPGRADE_ROOT"
PRE="$UPGRADE_ROOT/pre-${CURRENT}-to-${TARGET_VER}-${TS}"
mkdir -p "$PRE"
echo "$CURRENT" > "$PRE/from-version.txt"
cp "$COMPOSE_FILE" "$PRE/docker-compose.yml"

if [ "$SKIP_BACKUP" != true ]; then
    log "💾 Шаг 1-2: бэкап БД и docker-compose.yml..."
    sqlite3 "$NOCO_DB" ".backup '$PRE/noco.db'" || err "Не удалось создать бэкап БД"
    CHECK_BCK=$(sqlite3 "$PRE/noco.db" 'PRAGMA integrity_check;')
    [ "$CHECK_BCK" = "ok" ] || err "Бэкап БД повреждён (integrity_check ≠ ok) — обновление остановлено"
    log "   ✅ Бэкап: $PRE"
    log "      noco.db ($(du -h "$PRE/noco.db" | cut -f1), integrity_check: ok)"
else
    log "${YELLOW}💾 Бэкап БД пропущен (--skip-backup); docker-compose.yml сохранён в $PRE${NC}"
fi

# ─────────────────────────────────────────────────────────────────────────────
# ВАЛИДАЦИЯ после обновления (шаг 7): критические проверки совместимости.
# Любой FAIL → возврат 1 (вызовет авто-откат).
# ─────────────────────────────────────────────────────────────────────────────
validate_upgrade() {
    local fails=0 note
    note() { log "${YELLOW}   ⚠️  $1${NC}"; }

    log "   🔍 Проверки после обновления..."

    # a. Контейнер healthy
    if docker inspect --format '{{.State.Health.Status}}' nocodb 2>/dev/null | grep -q healthy; then
        log "   ✅ Контейнер nocodb healthy"
    else
        log "${RED}   ❌ nocodb не healthy${NC}"; fails=$((fails+1))
    fi

    # b. API версии (даём API до 30 сек на прогрев после healthy)
    local api_ver="" i
    for i in $(seq 1 6); do
        api_ver=$(curl -s --max-time 5 "http://localhost:8081/api/v1/version" 2>/dev/null | jq -r '.currentVersion // empty' 2>/dev/null || true)
        [ -n "$api_ver" ] && break
        sleep 5
    done
    if [ "$api_ver" = "$TARGET_VER" ]; then
        log "   ✅ API версия: $api_ver"
    else
        log "${RED}   ❌ API версия: '${api_ver:-пусто}' ≠ $TARGET_VER${NC}"; fails=$((fails+1))
    fi

    # c. Целостность БД
    local integ
    integ=$(sqlite3 "$NOCO_DB" 'PRAGMA integrity_check;')
    if [ "$integ" = "ok" ]; then
        log "   ✅ integrity_check: ok"
    else
        log "${RED}   ❌ integrity_check: $integ${NC}"; fails=$((fails+1))
    fi

    # d. Критичные системные таблицы (наш стек завязан на них)
    local ws bc
    ws=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM workspace;" 2>/dev/null || echo "?")
    if [ "$ws" != "?" ] && [ "${ws:-0}" -gt 0 ]; then
        log "   ✅ workspace: $ws"
    else
        log "${RED}   ❌ workspace недоступна (ответ: '$ws')${NC}"; fails=$((fails+1))
    fi

    bc=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_bases_v2;" 2>/dev/null || echo "?")
    if [ "$bc" != "?" ] && [ "${bc:-0}" -gt 0 ]; then
        log "   ✅ nc_bases_v2: $bc"
    else
        log "${RED}   ❌ nc_bases_v2 недоступна (ответ: '$bc')${NC}"; fails=$((fails+1))
    fi

    local ws_models
    ws_models=$(sqlite3 "$NOCO_DB" "SELECT COUNT(*) FROM nc_models_v2 WHERE fk_workspace_id IS NOT NULL;" 2>/dev/null || echo "?")
    if [ "$ws_models" != "?" ] && [ "${ws_models:-0}" -gt 0 ]; then
        log "   ✅ nc_models_v2 с fk_workspace_id: $ws_models"
    else
        log "${RED}   ❌ fk_workspace_id не заполнен в моделях (ответ: '$ws_models')${NC}"; fails=$((fails+1))
    fi

    # e. Конфиги источников (nc_sources_v2.config) — валидный JSON, формат не сломан
    local bad_src=0 cfg
    while IFS= read -r cfg; do
        [ -z "$cfg" ] && continue
        echo "$cfg" | jq -e . >/dev/null 2>&1 || bad_src=$((bad_src+1))
    done < <(sqlite3 "$NOCO_DB" "SELECT COALESCE(config,'{}') FROM nc_sources_v2;" 2>/dev/null || true)
    if [ "$bad_src" -eq 0 ]; then
        log "   ✅ nc_sources_v2.config: JSON корректен"
    else
        log "${RED}   ❌ nc_sources_v2.config: $bad_src повреждённых JSON${NC}"; fails=$((fails+1))
    fi

    # f. Опции селектов (ядро миграций add-select-options опирается на таблицу)
    if sqlite3 "$NOCO_DB" "SELECT name FROM sqlite_master WHERE type='table' AND name='nc_col_select_options_v2';" | grep -q nc_col_select_options_v2; then
        log "   ✅ nc_col_select_options_v2 существует"
    else
        log "${YELLOW}   ⚠️  nc_col_select_options_v2 отсутствует (возможно, новая версия переименовала таблицу опций)${NC}"
    fi

    [ "$fails" -eq 0 ] || return 1
    return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# АВТО-ОТКАТ: вернуть docker-compose.yml → старый образ. Если старый образ не
# поднялся (БД уже мигрирована вперёд) — восстановить БД из снапшота.
# ─────────────────────────────────────────────────────────────────────────────
rollback() {
    log "${RED}───────────────────────────────────────────────────────────${NC}"
    log "${RED}🔄 ОТКАТ на версию $CURRENT${NC}"

    if [ ! -f "$PRE/docker-compose.yml" ]; then
        log "${RED}❌ Бэкап docker-compose.yml не найден ($PRE). Откат вручную:${NC}"
        log "   1. Верни image: nocodb/nocodb:$CURRENT в docker-compose.yml"
        log "   2. docker compose up -d nocodb"
        exit 1
    fi

    cp "$PRE/docker-compose.yml" "$COMPOSE_FILE"
    log "   ✅ docker-compose.yml восстановлен (тег $CURRENT)"
    docker compose -f "$COMPOSE_FILE" stop nocodb >/dev/null 2>&1 || true
    docker compose -f "$COMPOSE_FILE" up -d nocodb || true

    if wait_healthy 180 && [ "$(get_container_version)" = "$CURRENT" ]; then
        log "   ✅ Откат успешен: NocoDB $CURRENT healthy"
        return 0
    fi

    log "   ⚠️  Старый образ не поднялся на текущей БД — восстанавливаю БД из снапшота..."
    if [ ! -f "$PRE/noco.db" ]; then
        log "${RED}❌ Снапшот БД не найден ($PRE/noco.db). Нужен ручной разбор:${NC}"
        log "   bash diagnose-upgrade.sh; смотри docker logs nocodb --tail 50"
        return 1
    fi
    docker compose -f "$COMPOSE_FILE" stop nocodb >/dev/null 2>&1 || true
    cp "$PRE/noco.db" "$NOCO_DB"
    rm -f "$NOCO_DB-wal" "$NOCO_DB-shm"
    log "   ✅ noco.db восстановлен из снапшота"
    docker compose -f "$COMPOSE_FILE" up -d nocodb || true
    if wait_healthy 180 && [ "$(get_container_version)" = "$CURRENT" ]; then
        log "   ✅ Откат успешен (БД восстановлена): NocoDB $CURRENT healthy"
        return 0
    fi
    log "${RED}❌ Откат не завершился автоматически. Ручной разбор:${NC}"
    log "   docker logs nocodb --tail 50; bash diagnose-upgrade.sh"
    return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# ПРИМЕНЕНИЕ (шаги 3-5): смена тега → pull → up
# ─────────────────────────────────────────────────────────────────────────────
log "${BLUE}───────────────────────────────────────────────────────────${NC}"

# 3. Меняем тег в docker-compose.yml (ровно одна строка image: nocodb/nocodb:*)
LINE_COUNT=$(grep -c 'image: nocodb/nocodb:' "$COMPOSE_FILE" || true)
[ "$LINE_COUNT" -eq 1 ] || err "Ожидалась ровно одна строка image: nocodb/nocodb: в $COMPOSE_FILE (найдено: $LINE_COUNT)"
sed -i "s|^\(\s*image: nocodb/nocodb:\)[0-9][0-9.]*$|\1${TARGET_VER}|" "$COMPOSE_FILE"
NEW_TAG=$(grep -m1 'image: nocodb/nocodb:' "$COMPOSE_FILE" | sed -n 's/.*nocodb\/nocodb:\([^ "]*\).*/\1/p')
[ "$NEW_TAG" = "$TARGET_VER" ] || err "Правка docker-compose.yml не применилась (тег: $NEW_TAG)"
log "   ✅ docker-compose.yml: image: nocodb/nocodb:${GREEN}$TARGET_VER${NC}"

# 4. Скачиваем новый образ
log "   ⏬ docker compose pull nocodb (может занять 1-5 мин)..."
docker compose -f "$COMPOSE_FILE" pull nocodb || err "docker compose pull nocodb не удался"

# 5. Пересоздаём контейнер NocoDB (бот/webhook не трогаем — только сервис nocodb)
log "   🚀 docker compose up -d nocodb ..."
docker compose -f "$COMPOSE_FILE" up -d nocodb || { log "${RED}up не удался — пробую откат...${NC}"; rollback; exit 1; }

# 6. Ждём healthcheck
log "   ⏳ Ожидание healthy (до 4 мин)..."
if ! wait_healthy 240; then
    log "${RED}❌ NocoDB не стала healthy за 4 минуты после обновления.${NC}"
    docker logs nocodb --tail 40 2>&1 | sed 's/^/   /' || true
    rollback
    exit 1
fi
log "   ✅ Контейнер nocodb: healthy"

# 7. Проверка фактической версии внутри контейнера
RUNNING_VER=$(get_container_version)
if [ "$RUNNING_VER" != "$TARGET_VER" ]; then
    log "${RED}❌ Запущенная версия ($RUNNING_VER) ≠ целевой ($TARGET_VER).${NC}"
    rollback
    exit 1
fi
log "   ✅ Версия контейнера: $RUNNING_VER"

# ─────────────────────────────────────────────────────────────────────────────
# ПОСТ-ПРОВЕРКИ (шаг 7-8): validate_upgrade → при провале авто-откат
# ─────────────────────────────────────────────────────────────────────────────
if ! validate_upgrade; then
    log "${RED}❌ Критические проверки после обновления не пройдены — выполняю откат.${NC}"
    rollback
    exit 1
fi

# Бот и webhook живы? (просто информируем)
for svc in printed4u-bot printed4u-webhook; do
    if docker ps --format '{{.Names}}' | grep -qx "$svc"; then
        log "   ✅ $svc запущен"
    else
        log "${YELLOW}   ⚠️  $svc не запущен (если он нужен — docker compose up -d)${NC}"
    fi
done

log ""
log "${GREEN}═══════════════════════════════════════════════════════════${NC}"
log "${GREEN}🎉 NocoDB успешно обновлена: $CURRENT → $TARGET_VER${NC}"
log "${GREEN}   Бэкап (на случай ручного отката): $PRE${NC}"
log "${GREEN}═══════════════════════════════════════════════════════════${NC}"
log "${BLUE}Дальше (вручную, по инструкции обновления проекта):${NC}"
log "   ${YELLOW}1.${NC} bash diagnose-upgrade.sh     — полная диагностика после обновления"
log "   ${YELLOW}2.${NC} bash diagnose.sh             — общая диагностика CRM"
log "   ${YELLOW}3.${NC} Проверь в браузере :8081 — таблицы, поля, API-токены"
log "   ${YELLOW}4.${NC} Проверь бота (Telegram), PDF-генерацию, отправку email"
log "   ${YELLOW}5.${NC} Если NocoDB меняла мета-схему — перевыпусти template.db"
log "      (bash export-template.sh) и прогони смоук-сценарии чистой установки"
log "   ${YELLOW}6.${NC} Зафиксируй обновление: лог обновлений, статус версии, историю версий"
log ""

