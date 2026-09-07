#!/bin/bash
# ============================================================================
# Printed4U CRM - Watchdog файловой системы (v1.0.0)
# ============================================================================
# Назначение: Самоисцеление структуры папок. Защита от "кривых рук".
# Что делает (каждые 5 минут через cron):
#   1. Проверяет имена папок проектов против NocoDB (regex ^{ID} - {проект} - {клиент}$)
#   2. Кривые имена — переименовывает обратно (по данным из NocoDB)
#   3. Проверяет папки клиентов (^Имя ([A-Z0-9]{6})$)
#   4. Восстанавливает права: каркас 0755, Рабочие 0775, Документы 0755
#   5. Пересоздаёт битые symlink'и в папках клиентов
#   6. Всё логирует в /mnt/data/logs/fs-fix.log
# ============================================================================
# Использование:
#   bash modules/fix-fs-structure.sh             # разовая проверка
#   bash modules/fix-fs-structure.sh --install   # установить в cron (каждые 5 мин)
#   bash modules/fix-fs-structure.sh --remove    # убрать из cron
#   bash modules/fix-fs-structure.sh --dry-run   # только диагностика (ничего не менять)
# ============================================================================

set -u

LOG_FILE="/mnt/data/logs/fs-fix.log"
PROJECTS_ROOT="/mnt/data/projects"
CLIENTS_ROOT="/mnt/data/clients"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRON_JOB="*/5 * * * * bash $INSTALL_DIR/modules/fix-fs-structure.sh >> $LOG_FILE 2>&1"

# ────────────────────────────────────────────────────────────────────────────
# Цвета и утилиты
# ────────────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    local ts=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$ts] $*" | tee -a "$LOG_FILE"
}

# ────────────────────────────────────────────────────────────────────────────
# Установка/удаление cron
# ────────────────────────────────────────────────────────────────────────────
install_cron() {
    sudo mkdir -p /mnt/data/logs
    if crontab -l 2>/dev/null | grep -q "fix-fs-structure.sh"; then
        echo -e "${YELLOW}ℹ️  Watchdog уже в crontab${NC}"
    else
        (crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -
        echo -e "${GREEN}✅ Watchdog добавлен в crontab (каждые 5 минут)${NC}"
    fi
    echo -e "${GREEN}✅ Лог: $LOG_FILE${NC}"
    exit 0
}

remove_cron() {
    if crontab -l 2>/dev/null | grep -q "fix-fs-structure.sh"; then
        crontab -l 2>/dev/null | grep -v "fix-fs-structure.sh" | crontab -
        echo -e "${GREEN}✅ Watchdog убран из crontab${NC}"
    else
        echo -e "${YELLOW}ℹ️  Watchdog не был установлен${NC}"
    fi
    exit 0
}

# ────────────────────────────────────────────────────────────────────────────
# Загрузка конфигурации из .env
# ────────────────────────────────────────────────────────────────────────────
load_env() {
    ENV_FILE="$INSTALL_DIR/.env"
    if [ ! -f "$ENV_FILE" ]; then
        log "❌ .env не найден ($ENV_FILE). Watchdog пропускает проверку."
        exit 0
    fi

    NOCO_TOKEN=$(grep -E '^NOCO_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
    BASE_ID=$(grep -E '^BASE_ID=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
    TABLE_PROJECTS=$(grep -E '^TABLE_PROJECTS=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
    TABLE_LEGAL=$(grep -E '^TABLE_LEGAL_ENTITIES=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
    TABLE_CONTACTS=$(grep -E '^TABLE_CONTACTS=' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')

    # Внутри Docker адрес nocodb:8080, с хоста — localhost:8081
    NOCO_URL="${NOCO_URL:-http://localhost:8081}"

    if [ -z "$NOCO_TOKEN" ] || [ -z "$BASE_ID" ] || [ -z "$TABLE_PROJECTS" ]; then
        log "❌ Не хватает переменных (.env): NOCO_TOKEN=$NOCO_TOKEN BASE_ID=$BASE_ID TABLE_PROJECTS=$TABLE_PROJECTS. Пропускаем."
        exit 0
    fi
}

# ────────────────────────────────────────────────────────────────────────────
# Получение данных проекта из NocoDB
# ────────────────────────────────────────────────────────────────────────────
get_project() {
    local project_id="$1"
    curl -s --max-time 10 \
        -H "xc-token: $NOCO_TOKEN" \
        "$NOCO_URL/api/v1/db/data/noco/$BASE_ID/$TABLE_PROJECTS/$project_id" 2>/dev/null
}

# Санитайзер имён (синхронизирован с webhook/server.js)
sanitize_name() {
    local name="$1"
    local max_len="$2"
    local clean
    clean=$(echo "$name" | tr -d '\r\n' | tr -s ' ')
    # Удаляем опасные символы (\\ / : * ? < > | @ " '), но НЕ дефис и НЕ пробел
    clean=$(echo "$clean" | sed 's/[\/\\:*?<>|@"'"'"']//g')
    # Сжимаем пробелы
    clean=$(echo "$clean" | tr -s ' ')
    # Обрезаем до max_len
    if [ ${#clean} -gt "$max_len" ]; then
        clean="${clean:0:$((max_len-3))}"
        clean="${clean% }..."
    fi
    # Финальная проверка
    if [ -z "$clean" ] || [ "$clean" = "..." ]; then
        clean="Без названия"
    fi
    echo "$clean"
}

# ────────────────────────────────────────────────────────────────────────────
# Проверка и починка папок проектов
# ────────────────────────────────────────────────────────────────────────────
fix_projects() {
    [ -d "$PROJECTS_ROOT" ] || { log "⚠️  $PROJECTS_ROOT не существует, пропускаю"; return; }

    for folder in "$PROJECTS_ROOT"/*/; do
        [ -d "$folder" ] || continue
        folder_name=$(basename "$folder")

        # Извлекаем ID из префикса "123 - ..."
        project_id=$(echo "$folder_name" | grep -oP '^\d+(?= - )' | head -n1)
        if [ -z "$project_id" ]; then
            log "⚠️  Папка без ID в префиксе: $folder_name — не трогаю (нет данных для восстановления)"
            continue
        fi

        # Получаем данные проекта из NocoDB
        project_json=$(get_project "$project_id")
        if [ -z "$project_json" ] || ! echo "$project_json" | grep -q '"Id"'; then
            log "⚠️  Проект ID=$project_id не найден в NocoDB — пропускаю (возможно, удалён)"
            continue
        fi

        proj_name=$(echo "$project_json" | jq -r '."Что делаем?" // ""' 2>/dev/null)
        [ -z "$proj_name" ] && proj_name="Проект_$project_id"

        # Имя клиента: юрлицо → контакт
        # NocoDB отдаёт relation-поле то объектом {Id:...}, то массивом [{Id:...}]
        # jq-выражение: (.["Юрлицо"] // .["Юрлицо"][0]) → берём Id
        legal_id=$(echo "$project_json" | jq -r '(."Юрлицо" // ."Юрлицо"[0]).Id // empty' 2>/dev/null)
        contact_id=$(echo "$project_json" | jq -r '(."Контакт" // ."Контакт"[0]).Id // empty' 2>/dev/null)

        client_name=""
        if [ -n "$legal_id" ] && [ "$legal_id" != "null" ]; then
            le_json=$(curl -s --max-time 10 -H "xc-token: $NOCO_TOKEN" \
                "$NOCO_URL/api/v1/db/data/noco/$BASE_ID/$TABLE_LEGAL/$legal_id" 2>/dev/null)
            client_name=$(echo "$le_json" | jq -r '(."Краткое Имя" // ."Краткое_Имя") // ."Имя" // ""' 2>/dev/null)
        fi
        if [ -z "$client_name" ] && [ -n "$contact_id" ] && [ "$contact_id" != "null" ]; then
            c_json=$(curl -s --max-time 10 -H "xc-token: $NOCO_TOKEN" \
                "$NOCO_URL/api/v1/db/data/noco/$BASE_ID/$TABLE_CONTACTS/$contact_id" 2>/dev/null)
            client_name=$(echo "$c_json" | jq -r '."Имя" // ""' 2>/dev/null)
        fi
        [ -z "$client_name" ] && client_name="Без клиента"

        safe_proj=$(sanitize_name "$proj_name" 60)
        safe_client=$(sanitize_name "$client_name" 40)
        expected="${project_id} - ${safe_proj} - ${safe_client}"

        if [ "$folder_name" != "$expected" ]; then
            if [ "$DRY_RUN" = true ]; then
                log "🔍 DRY: папка '$folder_name' → должна быть '$expected'"
            else
                # Проверяем, что целевое имя свободно
                if [ ! -e "$PROJECTS_ROOT/$expected" ]; then
                    if mv "$folder" "$PROJECTS_ROOT/$expected" 2>/dev/null; then
                        log "🔧 Переименована папка: '$folder_name' → '$expected'"
                        folder="$PROJECTS_ROOT/$expected"
                    else
                        log "❌ Не удалось переименовать '$folder_name' (права?)"
                    fi
                else
                    log "⚠️  Целевое имя уже занято: '$expected' — пропускаю"
                fi
            fi
        fi

        # Восстанавливаем права (каркас 755, Рабочие 775, Документы 755)
        if [ "$DRY_RUN" = false ]; then
            chmod 0755 "$folder" 2>/dev/null
            if [ -d "$folder/Рабочие" ]; then
                chmod 0775 "$folder/Рабочие" 2>/dev/null
            fi
            if [ -d "$folder/Документы" ]; then
                chmod 0755 "$folder/Документы" 2>/dev/null
            fi
        fi
    done
}

# ────────────────────────────────────────────────────────────────────────────
# Проверка и починка папок клиентов + symlink'ов
# ────────────────────────────────────────────────────────────────────────────
fix_clients() {
    [ -d "$CLIENTS_ROOT" ] || { log "⚠️  $CLIENTS_ROOT не существует, пропускаю"; return; }

    for folder in "$CLIENTS_ROOT"/*/; do
        [ -d "$folder" ] || continue
        folder_name=$(basename "$folder")

        # Проверяем формат "Имя (ABC123)"
        if ! echo "$folder_name" | grep -qP '^.+ \([A-Z0-9]{6}\)$'; then
            log "⚠️  Папка клиента с некорректным именем: '$folder_name' — не трогаю (нет данных для восстановления)"
        fi

        if [ "$DRY_RUN" = false ]; then
            chmod 0755 "$folder" 2>/dev/null
        fi

        # Проверяем symlink'и внутри папки клиента
        for link in "$folder"*; do
            [ -L "$link" ] || continue
            link_name=$(basename "$link")

            if [ ! -e "$link" ]; then
                # Битый symlink: цель не существует. Может, папка проекта переименована?
                project_id=$(echo "$link_name" | grep -oP '^\d+' | head -n1)
                if [ -n "$project_id" ]; then
                    # Ищем реальную папку проекта по префиксу ID
                    target=$(ls -d "$PROJECTS_ROOT"/${project_id}\ -\ * 2>/dev/null | head -n1)
                    if [ -n "$target" ] && [ -d "$target" ]; then
                        if [ "$DRY_RUN" = false ]; then
                            rm "$link" 2>/dev/null
                            ln -s "$target" "$link" 2>/dev/null && \
                                log "🔗 Пересоздан symlink: '$link_name' → '$(basename "$target")'"
                        else
                            log "🔍 DRY: symlink '$link_name' будет пересоздан → '$(basename "$target")'"
                        fi
                    else
                        log "⚠️  Битый symlink '$link_name': папка проекта не найдена"
                    fi
                else
                    log "⚠️  Битый symlink без ID: '$link_name'"
                fi
            fi
        done
    done
}

# ────────────────────────────────────────────────────────────────────────────
# Проверка прав на корневые папки
# ────────────────────────────────────────────────────────────────────────────
fix_roots() {
    for dir in "$PROJECTS_ROOT" "$CLIENTS_ROOT"; do
        if [ -d "$dir" ]; then
            current=$(stat -c '%a' "$dir")
            if [ "$current" != "755" ]; then
                if [ "$DRY_RUN" = false ]; then
                    chmod 0755 "$dir" 2>/dev/null
                    log "🔧 Права на $dir: $current → 755"
                else
                    log "🔍 DRY: права на $dir: $current → 755"
                fi
            fi
        fi
    done
}

# ────────────────────────────────────────────────────────────────────────────
# MAIN
# ────────────────────────────────────────────────────────────────────────────
DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --install) install_cron;;
        --remove)  remove_cron;;
        --dry-run) DRY_RUN=true;;
    esac
done

mkdir -p /mnt/data/logs

log "══════════════════════════════════════════"
log "🚀 Watchdog запуск ($([ "$DRY_RUN" = true ] && echo DRY-RUN || echo проверка))"

load_env
fix_roots
fix_projects
fix_clients

log "✅ Watchdog завершён"