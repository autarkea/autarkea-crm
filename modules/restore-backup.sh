#!/bin/bash
# ============================================================================
# Printed4U CRM - Восстановление из полного бэкапа v1.0.0 (релиз v4.50.0)
# ============================================================================
# Назначение: восстановление системы из локального бэкапа
#   nocodb_full_backup_*.tar.gz (формат modules/backup-local.sh).
#
# Что восстанавливает (ДАННЫЕ, а не код):
#   - noco.db       → /mnt/data/nocodb-data/noco.db
#   - projects/     → /mnt/data/projects
#   - clients/      → /mnt/data/clients
#   - noco-static/  → /mnt/data/noco-static  (PDF, печать организации)
# Сознательно НЕ трогает: .env, docker-compose.yml, templates/, /mnt/data/logs,
# /mnt/data/backups. Причины: (1) .env из старого бэкапа потеряет новые переменные
# и может содержать устаревшие секреты; (2) шаблоны документов живут в git —
# актуальный код вернёт git pull; (3) очередь/логи (v4.49.0+) — отдельная зона.
#
# Сценарии применения:
#   1. Повреждена база (integrity_check ≠ ok / NocoDB не стартует).
#   2. Случайно удалены/испорчены папки проектов/клиентов/PDF.
#   3. Полная потеря данных после переустановки (install.sh прошёл → restore).
#
# Использование:
#   bash modules/restore-backup.sh                  # интерактивно, последний бэкап
#   bash modules/restore-backup.sh --list           # список локальных бэкапов
#   bash modules/restore-backup.sh --latest         # последний (спросит подтверждение)
#   bash modules/restore-backup.sh <файл.tar.gz>    # конкретный бэкап
#   bash modules/restore-backup.sh --yes            # без интерактивных вопросов
#   bash modules/restore-backup.sh --apply-upgrade  # после restore догнать схему дельтами
#
# Безопасность: перед применением снaпшот проверяется (PRAGMA integrity_check),
# текущая база страхуется в backups/pre-restore-*.db, NocoDB останавливается
# на время замены файлов.
#
# Переопределяемые переменные: DATA_DIR BACKUP_DIR DB_FILE INSTALL_DIR
# ============================================================================
set -uo pipefail

DATA_DIR="${DATA_DIR:-/mnt/data}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups}"
DB_FILE="${DB_FILE:-$DATA_DIR/nocodb-data/noco.db}"
INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
LOG_FILE="$BACKUP_DIR/restore.log"
BACKUP_MASK="nocodb_full_backup_*.tar.gz"

YES=0
CHECK=0
APPLY_UPGRADE=0
SELECTED_BACKUP=""

# --- Цвета ---
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

err() {
    echo -e "${RED}❌ $*${NC}" | tee -a "$LOG_FILE"
    exit 1
}

# ----------------------------------------------------------------------------
# Безопасный загрузчик .env (значения с пробелами/звёздочками — как health-alert).
# ----------------------------------------------------------------------------
load_env() {
    local file="$INSTALL_DIR/.env" key val
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

# ----------------------------------------------------------------------------
# Предусловия
# ----------------------------------------------------------------------------
check_prereqs() {
    if ! command -v sqlite3 >/dev/null 2>&1; then
        err "sqlite3 не найден на хосте — нужен для проверки снапшота (apt install sqlite3)"
    fi
    if ! command -v docker >/dev/null 2>&1; then
        err "docker не найден"
    fi
    [ -f "$INSTALL_DIR/docker-compose.yml" ] || err "docker-compose.yml не найден в $INSTALL_DIR"
    [ -d "$DATA_DIR" ] || err "Каталог данных $DATA_DIR не найден"
    if [ ! -w "$DATA_DIR" ]; then
        err "Нет прав на запись в $DATA_DIR — запусти под юзером-владельцем установки (или sudo)"
    fi
}

# ----------------------------------------------------------------------------
# Список локальных бэкапов (новые сверху)
# ----------------------------------------------------------------------------
find_backups() {
    ls -1t "$BACKUP_DIR"/$BACKUP_MASK 2>/dev/null || true
}

list_backups() {
    local baks
    baks=$(find_backups)
    if [ -z "$baks" ]; then
        echo -e "${YELLOW}ℹ️  В $BACKUP_DIR нет бэкапов ($BACKUP_MASK)${NC}"
        return 1
    fi
    echo -e "${BLUE}Доступные бэкапы в $BACKUP_DIR:${NC}"
    local i=0
    while IFS= read -r f; do
        [ -z "$f" ] && continue
        i=$((i + 1))
        local size datepart
        size=$(du -h "$f" 2>/dev/null | cut -f1)
        datepart=$(basename "$f" | sed -n 's/^nocodb_full_backup_\([0-9]\{8\}_[0-9]\{6\}\)\.tar\.gz$/\1/p')
        local pretty="${datepart:0:4}-${datepart:4:2}-${datepart:6:2} ${datepart:9:2}:${datepart:11:2}"
        printf '   %s) %s  (%s)  %s\n' "$i" "$(basename "$f")" "$size" "$pretty"
    done <<< "$baks"
    return 0
}

# ----------------------------------------------------------------------------
# Проверка целостности снапшота ДО применения (битый бэкап не разворачиваем)
# ----------------------------------------------------------------------------
verify_snapshot() {
    local db="$1"
    local res
    res=$(sqlite3 "$db" 'PRAGMA integrity_check;' 2>&1)
    if [ "$res" != "ok" ]; then
        err "Снапшот в бэкапе ПОВРЕЖДЁН (integrity_check: $res). Восстановление отменено."
    fi
    echo -e "${GREEN}✅ Снапшот цел (PRAGMA integrity_check = ok)${NC}"
}

# ----------------------------------------------------------------------------
# Максимальный номер дельты в коде (upgrades/U*.sh)
# ----------------------------------------------------------------------------
max_delta() {
    local m=0 n
    for f in "$INSTALL_DIR"/upgrades/U*.sh; do
        [ -e "$f" ] || continue
        n=$(basename "$f" | sed -n 's/^U0*\([0-9][0-9]*\)_.*/\1/p')
        [ -n "$n" ] && [ "$n" -gt "$m" ] && m="$n"
    done
    echo "$m"
}

# ----------------------------------------------------------------------------
# Идентификация базы в восстановленном noco.db (по title='CRM', как install.sh)
# ----------------------------------------------------------------------------
restored_base_id() {
    local db="$1"
    sqlite3 "$db" "SELECT id FROM nc_bases_v2 WHERE deleted=0 AND TRIM(title)='CRM' ORDER BY created_at LIMIT 1;" 2>/dev/null || true
}

# ----------------------------------------------------------------------------
# Страховка текущего состояния ПЕРЕД заменой
# ----------------------------------------------------------------------------
backup_current_db() {
    if [ -f "$DB_FILE" ]; then
        local pre="$BACKUP_DIR/pre-restore-$(date '+%Y%m%d-%H%M%S').db"
        log "💾 Страхую текущую базу: $pre"
        # Живая база → консистентный снапшот; битая → просто копия для разбора.
        sqlite3 "$DB_FILE" ".timeout 5000" ".backup '$pre'" 2>/dev/null \
            || cp -f "$DB_FILE" "$pre"
    fi
}

# ----------------------------------------------------------------------------
# Остановка NocoDB перед заменой файлов
# ----------------------------------------------------------------------------
stop_nocodb() {
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'nocodb'; then
        log "⏹ Останавливаю контейнер nocodb..."
        (cd "$INSTALL_DIR" && docker compose stop nocodb) 2>&1 | tail -2 || true
        sleep 2
    else
        log "ℹ️ Контейнер nocodb не запущен — заменяю файлы напрямую"
    fi
}

start_and_wait_nocodb() {
    log "🚀 Запускаю контейнеры (docker compose up -d)..."
    (cd "$INSTALL_DIR" && docker compose up -d) 2>&1 | tail -3 || true

    log "⏳ Ожидаю готовность NocoDB (до 120 секунд)..."
    local attempt=0
    while [ "$attempt" -lt 40 ]; do
        if curl -fsS -m 3 -o /dev/null "http://localhost:8081/" 2>/dev/null; then
            log "✅ NocoDB снова доступен (попытка $((attempt + 1)))"
            sleep 5 # дать доинициализироваться (применение WAL, кэши)
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 3
    done
    err "NocoDB не поднялся за 120 секунд — смотри: docker compose logs nocodb"
}


# ----------------------------------------------------------------------------
# Замена данных из распакованного бэкапа (STAGE) на живые каталоги
# ----------------------------------------------------------------------------
apply_data() {
    local stage="$1"

    # 1. База: убираем старые WAL/SHM (от «убитой» сессии) и кладём снапшот.
    log "📄 Восстанавливаю noco.db..."
    rm -f "$DB_FILE-wal" "$DB_FILE-shm" 2>/dev/null || true
    cp -f "$stage/noco.db" "$DB_FILE" || err "Не удалось скопировать noco.db"
    chown "$(id -u):$(id -g)" "$DB_FILE" 2>/dev/null || true

    # 2. Папки данных: замена содержимого каталогов из архива.
    for d in projects clients noco-static; do
        if [ -d "$stage/$d" ]; then
            log "📁 Восстанавливаю /mnt/data/$d из бэкапа..."
            rm -rf "$DATA_DIR/$d" 2>/dev/null || true
            mv "$stage/$d" "$DATA_DIR/$d" || err "Не удалось восстановить $DATA_DIR/$d"
            chown -R "$(id -u):$(id -g)" "$DATA_DIR/$d" 2>/dev/null || true
        else
            log "ℹ️ В бэкапе нет каталога $d — пропускаю"
        fi
    done

    # 3. Права как в install.sh (безопасный каркас).
    chmod 0755 "$DATA_DIR/projects" 2>/dev/null || true
    chmod 0755 "$DATA_DIR/clients" 2>/dev/null || true
    chmod 0755 "$DATA_DIR/noco-static" 2>/dev/null || true
    chmod 0775 "$DATA_DIR/noco-static/pdfs" 2>/dev/null || true
    chmod 0755 "$DATA_DIR/nocodb-data" 2>/dev/null || true
}

# ----------------------------------------------------------------------------
# Пост-проверки после старта
# ----------------------------------------------------------------------------
post_checks() {
    # 1. Целостность живой базы
    local res
    res=$(sqlite3 "$DB_FILE" 'PRAGMA integrity_check;' 2>&1)
    if [ "$res" = "ok" ]; then
        echo -e "${GREEN}✅ База после восстановления цела (integrity_check = ok)${NC}"
    else
        err "База после восстановления повреждена (integrity_check: $res)!"
    fi

    # 2. Версия схемы vs дельты в коде
    local curver maxd
    curver=$(NOCO_DB="$DB_FILE" bash "$INSTALL_DIR/modules/version.sh" get)
    maxd=$(max_delta)
    log "ℹ️ Версия схемы восстановленной базы: U$curver (в коде дельт до: U$maxd)"
    if [ -n "$maxd" ] && [ "$maxd" -gt "$curver" ]; then
        echo -e "${YELLOW}⚠️  Схема восстановленной базы отстаёт от кода: U$curver < U$maxd.${NC}"
        echo -e "${YELLOW}   Новые колонки/фичи могут не работать, пока дельты не применены.${NC}"
        if [ "$APPLY_UPGRADE" -eq 1 ]; then
            echo -e "${BLUE}   Запускаю bash upgrade.sh (догон дельт)...${NC}"
            (cd "$INSTALL_DIR" && bash upgrade.sh) 2>&1 | tail -15 || true
        else
            echo -e "${YELLOW}   Догони вручную:  bash upgrade.sh${NC}"
            echo -e "${YELLOW}   (или с авто-догоном: bash modules/restore-backup.sh ... --apply-upgrade)${NC}"
        fi
    else
        echo -e "${GREEN}✅ Версия схемы актуальна (U$curver)${NC}"
    fi

    # 3. BASE_ID в .env vs фактическая база в восстановленном noco.db
    local real_base env_base
    real_base=$(restored_base_id "$DB_FILE")
    env_base=""
    if [ -f "$INSTALL_DIR/.env" ]; then
        env_base=$(grep -E '^BASE_ID=' "$INSTALL_DIR/.env" | cut -d= -f2- | tr -d '\r' || true)
    fi
    if [ -z "$real_base" ]; then
        echo -e "${YELLOW}⚠️  Не удалось определить базу 'CRM' в восстановленном noco.db — проверь BASE_ID вручную${NC}"
    elif [ -n "$env_base" ] && [ "$env_base" = "$real_base" ]; then
        echo -e "${GREEN}✅ BASE_ID совпадает с восстановленной базой ($real_base)${NC}"
    else
        echo -e "${YELLOW}⚠️  BASE_ID в .env ($env_base) НЕ совпадает с базой в бэкапе ($real_base).${NC}"
        echo -e "${YELLOW}   Обновляю .env и перезаполняю TABLE_* через setup-bot.sh...${NC}"
        sed -i "s|^BASE_ID=.*|BASE_ID=$real_base|" "$INSTALL_DIR/.env"
        if [ -f "$INSTALL_DIR/setup-bot.sh" ]; then
            (cd "$INSTALL_DIR" && bash setup-bot.sh --no-restart) 2>&1 | tail -8 || \
                echo -e "${YELLOW}   ⚠️ setup-bot.sh не прошёл — запусти вручную: bash setup-bot.sh${NC}"
        fi
    fi

    # 4. NOCO_TOKEN из .env валиден в восстановленной базе? (v4.51.2, кейс R10)
    # Restore на «новое железо»: .env содержит токен от СВЕЖЕЙ установки, а база из
    # архива — токены старого сервера. restore их не синхронизирует → Data API
    # отвечает 401 → бот/webhook молчат с непонятной ошибкой. Не прерываем restore
    # (данные уже восстановлены), но предупреждаем явно и даём лечение.
    local tok probe_tbl status
    tok=$(grep -E '^NOCO_TOKEN=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r' || true)
    probe_tbl=$(grep -E '^TABLE_PROJECTS=' "$INSTALL_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r' || true)
    if [ -n "$tok" ] && [ -n "$probe_tbl" ] && command -v curl >/dev/null 2>&1; then
        status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 6 \
            -H "xc-token: $tok" \
            "http://localhost:8081/api/v1/db/data/noco/${real_base}/${probe_tbl}?limit=1" 2>/dev/null || echo 000)
        if [ "$status" = "200" ]; then
            echo -e "${GREEN}✅ NOCO_TOKEN из .env валиден в восстановленной базе (API 200)${NC}"
        else
            echo -e "${YELLOW}⚠️  NOCO_TOKEN из .env НЕ валиден в восстановленной базе (API $status).${NC}"
            echo -e "${YELLOW}   Типично при restore на «новое железо»: токен свежей установки ≠ токенам в архиве.${NC}"
            echo -e "${YELLOW}   Лечение (1 минута): войди в NocoDB UI (http://<IP>:8081) под аккаунтом из архива,${NC}"
            echo -e "${YELLOW}   создай токен (Account Settings → Tokens → New Token) и обнови .env:${NC}"
            echo -e "${YELLOW}   sed -i 's|^NOCO_TOKEN=.*|NOCO_TOKEN=<новый_токен>|' $INSTALL_DIR/.env${NC}"
            echo -e "${YELLOW}   docker compose -f $INSTALL_DIR/docker-compose.yml up -d bot webhook${NC}"
        fi
    fi
}


# ----------------------------------------------------------------------------
# Основной поток
# ----------------------------------------------------------------------------
main() {
    mkdir -p "$BACKUP_DIR"
    load_env
    check_prereqs

    # Список бэкапов / выбор файла
    if [ "$SELECTED_BACKUP" = "latest" ]; then
        SELECTED_BACKUP=$(find_backups | head -1)
        [ -z "$SELECTED_BACKUP" ] && err "Нет бэкапов в $BACKUP_DIR"
    elif [ -z "$SELECTED_BACKUP" ]; then
        list_backups || exit 1
        SELECTED_BACKUP=$(find_backups | head -1)
        [ -z "$SELECTED_BACKUP" ] && err "Нет бэкапов в $BACKUP_DIR"
        echo ""
        echo -e "${BLUE}Выбран последний бэкап: $(basename "$SELECTED_BACKUP")${NC}"
    fi
    [ -f "$SELECTED_BACKUP" ] || err "Бэкап не найден: $SELECTED_BACKUP"

    log "===== 🚀 Restore из: $(basename "$SELECTED_BACKUP") ====="

    # 1. Распаковка в рабочий каталог и проверка снапшота
    local stage="$BACKUP_DIR/.restore_stage_$$"
    rm -rf "$stage" 2>/dev/null || true
    mkdir -p "$stage"
    echo -e "${BLUE}📦 Распаковываю бэкап...${NC}"
    tar -xzf "$SELECTED_BACKUP" -C "$stage" || { rm -rf "$stage"; err "Не удалось распаковать бэкап"; }
    [ -f "$stage/noco.db" ] || { rm -rf "$stage"; err "В бэкапе нет noco.db — архив повреждён"; }
    verify_snapshot "$stage/noco.db"

    # Режим --check: проверка архива без применения (диагностика)
    if [ "$CHECK" -eq 1 ]; then
        echo -e "${GREEN}✅ Бэкап проверен и готов к восстановлению (ничего не изменено)${NC}"
        rm -rf "$stage"
        exit 0
    fi

    # 2. Подтверждение (если не --yes)
    echo ""
    echo -e "${YELLOW}⚠️  План восстановления:${NC}"
    echo -e "   • будет остановлен контейнер nocodb на время замены файлов;"
    echo -e "   • заменятся: noco.db, projects/, clients/, noco-static/;"
    echo -e "   • текущая база сохранится в backups/pre-restore-*.db;"
    echo -e "   • .env, docker-compose.yml и код НЕ меняются."
    if [ "$YES" -ne 1 ]; then
        read -r -p "Восстановить из этого бэкапа? (y/N): " ans
        [[ "$ans" =~ ^[yY]$ ]] || { rm -rf "$stage"; echo -e "${YELLOW}Отменено${NC}"; exit 0; }
    fi

    # 3. Стоп → страховка → замена → старт
    backup_current_db
    stop_nocodb
    apply_data "$stage"
    rm -rf "$stage"
    start_and_wait_nocodb

    # 4. Пост-проверки
    post_checks

    echo ""
    echo -e "${GREEN}✅ Восстановление завершено. Лог: $LOG_FILE${NC}"
    echo -e "${YELLOW}💡 Проверь систему: docker ps, http://localhost:8081, bash diagnose.sh, тесты в боте (node --test tests/ на хосте разработки).${NC}"
    exit 0
}

# --- Разбор аргументов ---
for a in "$@"; do
    case "$a" in
        --list) list_backups; exit $? ;;
        --latest) SELECTED_BACKUP="latest" ;;
        --check|--verify) CHECK=1; SELECTED_BACKUP="latest" ;;
        --yes|-y) YES=1 ;;
        --apply-upgrade) APPLY_UPGRADE=1 ;;
        -*) echo "Неизвестный флаг: $a" >&2; exit 1 ;;
        *) SELECTED_BACKUP="$a" ;;
    esac
done

main

