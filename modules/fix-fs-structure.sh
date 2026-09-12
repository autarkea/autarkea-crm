#!/bin/bash
# ============================================================================
# Printed4U CRM - Watchdog файловой системы (v1.3.0)
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
# 🆕 v1.1.0 (Проблема 128): WINDOWS-SAFE ИМЕНА.
#   Windows (Explorer/Win32) не открывает папки/файлы, имя которых оканчивается
#   точкой или пробелом (срезает хвост → путь не совпадает → «Отказано в доступе»).
#   Клиентский кейс: контакт «Ярошеня С.Н.» → папка проекта с точкой на конце,
#   файлы из Проводника в неё не клались.
#   Что исправлено:
#     - sanitize_name() синхронизирован с webhook (shared/webhook-utils.js →
#       sanitizeFolderName): многоточие обрезки «…» (U+2026), хвост точек/пробелов
#       срезается, пробелы триммятся. Раньше watchdog и webhook считали имена
#       по-разному → папку переименовывали друг за другом (ping-pong);
#     - для контакта применяется '@user' → '(user)' — как в webhook (formatContactName);
#     - имена ссылок в папках клиентов тоже приводятся к Windows-safe виду.
#   Миграция существующих папок = разовый запуск этого модуля (или cron сам за 5 мин).
# ============================================================================
# 🆕 v1.2.0 (Проблема 130): НАДЁЖНОСТЬ ПРАВ.
#   - setgid (бит 2xxx) на всех папках структуры: новые элементы наследуют ГРУППУ
#     родителя, а не GID процесса → папка от вебхука (контейнер) сразу пишется SMB;
#   - чиним ГРУППУ данных (chgrp), если мы владелец папки;
#   - если владелец не мы — предупреждаем с готовой командой (нужен root).
# ============================================================================
# 🆕 v1.3.0 (12.09.2026): ЗАЩИТА ОТ ЗАПУСКА ПОД ROOT.
#   Под `sudo` `id -un` = root → watchdog выставил бы владельцем/группой root и
#   сломал Samba (тот же баг, что нашли смоук-тестом в samba-install.sh). Теперь
#   под root владелец берётся из .env (APP_UID/APP_GID); если данных нет — watchdog
#   просто пропускает проверку (не портит структуру).
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

# Пользователь и группа данных (v1.2.0): группа, которую должны наследовать новые
# папки. В cron USER может быть не задан — берём явно из id.
# ⚠️ v1.3.0 (12.09.2026): под sudo `id -un` = root — тогда watchdog «починил» бы
# права и группу в root и сломал Samba (тот же баг, что нашли смоук-тестом в
# samba-install.sh). Владельца берём как upgrade.sh/backup-install.sh: под root —
# из .env (APP_UID/APP_GID). Нет данных — лучше НЕ трогать структуру, чем портить.
if [ "$(id -u)" -eq 0 ]; then
    ENV_FILE="$INSTALL_DIR/.env"
    APP_UID_VAL=$(grep -E '^APP_UID=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -dc '0-9')
    APP_GID_VAL=$(grep -E '^APP_GID=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -dc '0-9')
    if [ -n "$APP_UID_VAL" ] && [ "$APP_UID_VAL" != "0" ]; then
        CUR_USER="$(id -nu "$APP_UID_VAL" 2>/dev/null || echo "$APP_UID_VAL")"
        DATA_GROUP="$(getent group "${APP_GID_VAL:-$APP_UID_VAL}" | cut -d: -f1)"
    else
        echo "❌ Watchdog запущен от root, а APP_UID в $ENV_FILE нет — пропускаю: иначе он выставил бы владельцем root и сломал Samba." >&2
        exit 0
    fi
else
    CUR_USER=$(id -un)
    DATA_GROUP=$(id -gn)
fi

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

# Санитайзер имён (синхронизирован с webhook: shared/webhook-utils.js → sanitizeFolderName).
# v1.1.0 (Проблема 128): Windows-safe — имя НЕ оканчивается точкой/пробелом;
# многоточие обрезки «…» (U+2026), а не «...». Иначе watchdog и webhook считают
# имена по-разному и переименовывают папку друг за другом (ping-pong).
sanitize_name() {
    local name="$1"
    local max_len="$2"
    local clean
    # Переносы строк/табы → пробел + сжатие пробелов (аналог JS: \s+ → ' ')
    clean=$(printf '%s' "$name" | tr -s '[:space:]' ' ')
    # Удаляем опасные символы (\\ / : * ? < > | @ " '), но НЕ дефис и НЕ пробел
    clean=$(printf '%s' "$clean" | sed 's/[\/\\:*?<>|@"'"'"']//g')
    # Трим (аналог .trim() в JS)
    clean=$(printf '%s' "$clean" | sed 's/^ *//; s/ *$//')
    # Обрезка до max_len: тело без хвостовых пробелов + «…» (как chars.slice(0, max_len-1) + '…')
    if [ "${#clean}" -gt "$max_len" ]; then
        clean="${clean:0:$((max_len-1))}"
        clean=$(printf '%s' "$clean" | sed 's/ *$//')
        clean="${clean}…"
    fi
    # 🪟 Windows-safe: имя не оканчивается точкой/пробелом
    clean=$(printf '%s' "$clean" | sed 's/[. ]*$//')
    # Финальная проверка
    if [ -z "$clean" ] || [ "$clean" = "…" ]; then
        clean="Без названия"
    fi
    echo "$clean"
}

# ────────────────────────────────────────────────────────────────────────────
# Приведение прав папки к целевым (v1.2.0, Проблема 130).
# mode — с битом setgid (2755 / 2775): новая папка наследует ГРУППУ родителя, а не
# GID процесса → папка, созданная вебхуком (контейнер), сразу доступна на запись
# SMB-пользователю. Заодно чиним группу данных (если мы владелец) и предупреждаем,
# если владелец не мы (тогда нужен root: `sudo chown -R $USER:$DATA_GROUP <папка>`).
# ────────────────────────────────────────────────────────────────────────────
fix_dir_perms() {
    local dir="$1" mode="$2"
    [ -d "$dir" ] || return 0

    local cur
    cur=$(stat -c '%a' "$dir" 2>/dev/null)
    if [ "$cur" != "$mode" ]; then
        if [ "$DRY_RUN" = true ]; then
            log "🔍 DRY: права на $dir: $cur → $mode"
        else
            chmod "$mode" "$dir" 2>/dev/null && log "🔧 Права на $dir: $cur → $mode"
        fi
    fi

    if [ "$DRY_RUN" = false ]; then
        if [ -O "$dir" ]; then
            # Группу может менять владелец (если он состоит в этой группе)
            local curg
            curg=$(stat -c '%G' "$dir" 2>/dev/null)
            if [ -n "${DATA_GROUP:-}" ] && [ "$curg" != "$DATA_GROUP" ]; then
                chgrp "$DATA_GROUP" "$dir" 2>/dev/null && log "🔧 Группа $dir: $curg → $DATA_GROUP"
            fi
        else
            log "⚠️  Владелец $dir — не $CUR_USER: запись через Samba может не работать (нужно: sudo chown -R $CUR_USER:'$DATA_GROUP' '$dir')"
        fi
    fi
}

# ────────────────────────────────────────────────────────────────────────────
# Проверка и починка папок проектов
# ────────────────────────────────────────────────────────────────────────────
fix_projects() {
    [ -d "$PROJECTS_ROOT" ] || { log "⚠️  $PROJECTS_ROOT не существует, пропускаю"; return; }

    for folder in "$PROJECTS_ROOT"/*/; do
        [ -d "$folder" ] || continue
        folder_name=$(basename "$folder")
        folder="${folder%/}"   # без хвостового слэша — аккуратные пути в логах

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
            # v1.1.0: как в webhook (formatContactName) — '@user' → '(user)'.
            # Иначе webhook и watchdog считают имя клиента по-разному и
            # переименовывают папку друг за другом каждые 5 минут.
            client_name=$(printf '%s' "$client_name" | sed 's/@\([A-Za-z0-9_]*\)/(\1)/g')
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

        # Права: каркас 2755, «Рабочие» 2775 (setgid — наследование группы, запись для SMB),
        # «Документы» 2755 (v1.2.0, Проблема 130)
        fix_dir_perms "$folder" 2755
        fix_dir_perms "$folder/Рабочие" 2775
        fix_dir_perms "$folder/Документы" 2755
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

        # Права папки клиента: 2755 + setgid (v1.2.0, Проблема 130)
        fix_dir_perms "$folder" 2755

        # Проверяем symlink'и внутри папки клиента
        for link in "$folder"*; do
            [ -L "$link" ] || continue
            link_name=$(basename "$link")

            # 🪟 v1.1.0 (Проблема 128): имя ссылки не должно оканчиваться точкой/пробелом —
            # Windows не откроет такой путь (клиентский кейс: «14 - ...по 20 мм...»).
            safe_link_name=$(printf '%s' "$link_name" | sed 's/[. ]*$//')
            if [ -n "$safe_link_name" ] && [ "$safe_link_name" != "$link_name" ]; then
                if [ "$DRY_RUN" = false ]; then
                    if mv "$link" "$folder$safe_link_name" 2>/dev/null; then
                        log "🪟 Windows-safe: ссылка '$link_name' → '$safe_link_name'"
                        link="$folder$safe_link_name"
                        link_name="$safe_link_name"
                    else
                        log "❌ Не удалось переименовать ссылку '$link_name' (права?)"
                    fi
                else
                    log "🔍 DRY: ссылка '$link_name' → '$safe_link_name' (Windows-safe)"
                fi
            fi

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
        fix_dir_perms "$dir" 2755
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