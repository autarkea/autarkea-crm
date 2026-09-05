#!/bin/bash
# ============================================================================
# upgrade.sh v1.2.0 — движок обновления установленной Printed4U CRM
# Обновляет УЖЕ РАБОТАЮЩУЮ систему клиента (с данными), НЕ пересоздавая базу
# (в отличие от apply-template.sh). Порядок:
#   1. Префлайт   2. Бэкап   3. Schema repair   4. Дельты upgrades/U*.sh
#   5. Код (git pull + доустановка .env-переменных + compose up -d --build)
#   6. setup-bot.sh --no-restart
#   7. Перезапуск   8. diagnose.sh   9. Версия схемы в nc_store
# Ключи:
#   --dry-run --skip-backup --skip-git --skip-compose --skip-bot
#   --skip-diagnose --skip-restart --db-only (только БД-часть, для репетиции на копии)
#   --install-dir PATH --db PATH
# ============================================================================
# Изменения v1.2.0 (v4.34.3):
# - Доустановка недостающих .env-переменных по .env.example (безопасные дефолты;
#   плейсхолдеры your_*/_here и пустые значения НЕ переносятся). Старые .env не
#   содержат новых переменных (MORNING_CRON, REMINDER_CRON, DISK_ALERT_PERCENT,
#   BACKUP_RETENTION_*, TZ, SMTP_HOST/PORT и т.п.) → фичи молча не работали.
#   Синхронизация выполняется до docker compose up, чтобы контейнеры подхватили.
# ============================================================================
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
NOCO_DB="${NOCO_DB:-/mnt/data/nocodb-data/noco.db}"
BACKUP_DIR="${BACKUP_DIR:-/mnt/data/backups}"
LOG_FILE="${LOG_FILE:-/mnt/data/nocodb-data/upgrade.log}"

DRY_RUN=false
SKIP_BACKUP=false
SKIP_GIT=false
SKIP_COMPOSE=false
SKIP_BOT=false
SKIP_DIAGNOSE=false
SKIP_RESTART=false

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)       DRY_RUN=true ;;
        --skip-backup)   SKIP_BACKUP=true ;;
        --skip-git)      SKIP_GIT=true ;;
        --skip-compose)  SKIP_COMPOSE=true ;;
        --skip-bot)      SKIP_BOT=true ;;
        --skip-diagnose) SKIP_DIAGNOSE=true ;;
        --skip-restart)  SKIP_RESTART=true ;;
        --db-only)       SKIP_GIT=true; SKIP_COMPOSE=true; SKIP_BOT=true; SKIP_RESTART=true; SKIP_DIAGNOSE=true ;;
        --install-dir)   INSTALL_DIR="$2"; shift ;;
        --db)            NOCO_DB="$2"; shift ;;
        *) echo "❌ Неизвестный аргумент: $1" >&2; exit 1 ;;
    esac
    shift
done

TEMPLATE="$INSTALL_DIR/template.db"
ENV_FILE="$INSTALL_DIR/.env"
UPGRADES_DIR="$INSTALL_DIR/upgrades"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

log() { echo -e "$*"; echo "[$(date '+%Y-%m-%d %H:%M:%S')] $(echo -e "$*" | sed 's/\x1b\[[0-9;]*m//g')" >> "$LOG_FILE" 2>/dev/null || true; }
err() { log "${RED}❌ $*${NC}"; exit 1; }

# ═══════════════════════════════════════════════════════════════════════════
# 1. ПРЕФЛАЙТ
# ═══════════════════════════════════════════════════════════════════════════
log "${BLUE}═══════════════════════════════════════════════════════════${NC}"
log "${BLUE}🚀 upgrade.sh v1.2.0 — обновление установленной CRM${NC}"
[ "$DRY_RUN" = true ] && log "${YELLOW}   РЕЖИМ ПРОСМОТРА (--dry-run): изменения НЕ применяются${NC}"
log "${BLUE}   INSTALL_DIR: $INSTALL_DIR${NC}"
log "${BLUE}   База:        $NOCO_DB${NC}"
log "${BLUE}═══════════════════════════════════════════════════════════${NC}"

[ -f "$NOCO_DB" ]  || err "База не найдена: $NOCO_DB"
[ -f "$TEMPLATE" ] || err "Эталон не найден: $TEMPLATE (ожидается template.db)"
command -v sqlite3 >/dev/null 2>&1 || err "sqlite3 не установлен"
command -v docker >/dev/null 2>&1 || err "docker не установлен"

CURRENT_VER=$(NOCO_DB="$NOCO_DB" bash "$INSTALL_DIR/modules/version.sh" get)
log "ℹ️ Текущая версия схемы: $CURRENT_VER"

# Список дельт с номером > текущей
APPLY_LIST=()
warn_later=""
for f in "$UPGRADES_DIR"/U*.sh; do
    [ -e "$f" ] || continue
    n=$(basename "$f" | sed -n 's/^U0*\([0-9][0-9]*\)_.*/\1/p')
    if [ -z "$n" ]; then
        warn_later="${warn_later}Пропускаю $f — имя не по шаблону U<NNN>_name.sh\n"
        continue
    fi
    if [ "$n" -gt "$CURRENT_VER" ]; then
        APPLY_LIST+=("$n|$f")
    fi
done
IFS=$'\n' APPLY_LIST=($(printf '%s\n' "${APPLY_LIST[@]}" | sort -t'|' -k1,1n))

[ -n "$warn_later" ] && log "${YELLOW}⚠️ $warn_later${NC}"

if [ ${#APPLY_LIST[@]} -eq 0 ]; then
    log "${GREEN}ℹ️ Дельт для применения нет (версия схемы актуальна).${NC}"
else
    log "ℹ️ Будет применено дельт: ${#APPLY_LIST[@]}"
    for item in "${APPLY_LIST[@]}"; do
        log "   → ${item#*|}"
    done
fi

# ═══════════════════════════════════════════════════════════════════════════
# 1.5 СОХРАНЕНИЕ ПОЛЬЗОВАТЕЛЬСКИХ ФАЙЛОВ (до бэкапа/дельт/git)
# Кастомизированные файлы templates/ (печать организации и т.п.) живут в git и
# будут затёрты reset --hard. Спасаем их в зону данных /mnt/data/noco-static
# ДО любых git-операций + снимаем страховочный архив.
# ═══════════════════════════════════════════════════════════════════════════
log "${BLUE}🖼  Шаг 1.5/9: сохранение пользовательских файлов (печать, кастомизации templates)...${NC}"
if [ "$DRY_RUN" = true ]; then
    log "${YELLOW}   (dry-run: сохранение пропущено)${NC}"
elif [ -f "$INSTALL_DIR/modules/preserve-custom-assets.sh" ]; then
    INSTALL_DIR="$INSTALL_DIR" bash "$INSTALL_DIR/modules/preserve-custom-assets.sh" 2>&1 | sed 's/^/   /' \
        || log "${YELLOW}   ⚠️ preserve-custom-assets.sh завершился с ошибкой (продолжаю обновление)${NC}"
else
    log "${YELLOW}   ⚠️ modules/preserve-custom-assets.sh не найден — пропускаю${NC}"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 2. БЭКАП
# ═══════════════════════════════════════════════════════════════════════════
if [ "$DRY_RUN" = true ]; then
    log "${YELLOW}💾 Шаг 2 (бэкап): будет создан снапшот БД в $BACKUP_DIR${NC}"
elif [ "$SKIP_BACKUP" = true ]; then
    log "${YELLOW}💾 Бэкап пропущен (--skip-backup)${NC}"
else
    mkdir -p "$BACKUP_DIR"
    BAK="$BACKUP_DIR/noco-before-upgrade-$(date '+%Y%m%d-%H%M%S').db"
    log "${BLUE}💾 Шаг 2/9: бэкап базы...${NC}"
    sqlite3 "$NOCO_DB" ".timeout 10000" ".backup '$BAK'"
    log "${GREEN}✅ Бэкап создан: $BAK${NC}"
fi


# ═══════════════════════════════════════════════════════════════════════════
# 3. SCHEMA REPAIR
# ═══════════════════════════════════════════════════════════════════════════
log "${BLUE}🔧 Шаг 3/9: восстановление схемы (переименованные клиентом)...${NC}"
if [ "$DRY_RUN" = true ]; then
    NOCO_DB="$NOCO_DB" TEMPLATE="$TEMPLATE" bash "$INSTALL_DIR/modules/schema-repair.sh" --dry-run || true
else
    NOCO_DB="$NOCO_DB" TEMPLATE="$TEMPLATE" bash "$INSTALL_DIR/modules/schema-repair.sh" || err "schema-repair завершился с ошибкой"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 4. ДЕЛЬТЫ
# ═══════════════════════════════════════════════════════════════════════════
if [ ${#APPLY_LIST[@]} -gt 0 ]; then
    log "${BLUE}📦 Шаг 4/9: применение дельт...${NC}"
    if [ "$DRY_RUN" = true ]; then
        log "${YELLOW}   (dry-run: дельты не выполняются)${NC}"
    else
        for item in "${APPLY_LIST[@]}"; do
            n="${item%%|*}"
            f="${item#*|}"
            log "${GREEN}   ▶ Применяю U$n: $(basename "$f")${NC}"
            NOCO_DB="$NOCO_DB" INSTALL_DIR="$INSTALL_DIR" bash "$f" || {
                log "${RED}❌ Дельта U$n упала. Восстановление:${NC}"
                log "${RED}   cp $BAK $NOCO_DB${NC}"
                err "Остановлено. Дельта: $f"
            }
            LAST_APPLIED="$n"
        done
    fi
else
    log "${BLUE}📦 Шаг 4/9: дельт нет — пропускаю${NC}"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 5. КОД (git pull + пересборка контейнеров)
# ═══════════════════════════════════════════════════════════════════════════
log "${BLUE}🛠  Шаг 5/9: обновление кода...${NC}"
if [ "$DRY_RUN" = true ]; then
    log "${YELLOW}   (dry-run: git pull и docker compose пропущены)${NC}"
else
    cd "$INSTALL_DIR"
    if [ "$SKIP_GIT" = true ]; then
        log "${YELLOW}   git pull пропущен (--skip-git)${NC}"
    elif [ -d .git ]; then
        log "   git pull --ff-only ..."
        if ! git pull --ff-only 2>&1 | sed 's/^/   /'; then
            log "${YELLOW}   ⚠️ git pull не удался (обычно — расходящиеся ветки: публичный репо обновляется forced-push с плоской историей)."
            log "${YELLOW}   Привожу код к origin/main: git fetch + git reset --hard (данные в /mnt/data и .env НЕ трогаются)"
            git fetch origin 2>&1 | sed 's/^/   /'
            git reset --hard origin/main 2>&1 | sed 's/^/   /' || err "git reset --hard origin/main не удался"
            log "${GREEN}   ✅ Код приведён к origin/main"
        fi
    else
        log "${YELLOW}   ⚠️ Это не git-репозиторий — пропускаю pull"
    fi
    if [ "$SKIP_COMPOSE" = true ]; then
        log "${YELLOW}   docker compose пропущен (--skip-compose)${NC}"
    elif [ -f docker-compose.yml ]; then
        # Проблема 108 (v4.33.0): миграция старых систем. Эталонный docker-compose.yml монтирует
        # ${RCLONE_CONF:-/dev/null}:/home/node/.config/rclone/rclone.conf, а RCLONE_CONF живёт в .env
        # (вне git). Без этого после git pull бот пересоздастся без rclone.conf и /backup
        # потеряет облачную секцию.
        # Проблема 109 (v4.34.0): dest в контейнере — /home/node/.config/... (home юзера node,
        # процесс бота идёт от user APP_UID, /root ему недоступен), а НЕ /root/.config.
        if [ -f "$HOME/.config/rclone/rclone.conf" ]; then
            if grep -q '^RCLONE_CONF=' "$ENV_FILE" 2>/dev/null; then
                sed -i "s|^RCLONE_CONF=.*|RCLONE_CONF=$HOME/.config/rclone/rclone.conf|" "$ENV_FILE"
            else
                [ -n "$(tail -c1 "$ENV_FILE")" ] && echo "" >> "$ENV_FILE"
                echo "RCLONE_CONF=$HOME/.config/rclone/rclone.conf" >> "$ENV_FILE"
            fi
            log "${GREEN}   ✅ RCLONE_CONF=$HOME/.config/rclone/rclone.conf"
            # Проблема 109: bind-mount не меняет владельца/права. Конфиг, созданный под root
            # (600 root:root), контейнерный юзер (APP_UID) не прочитает → /backup «не настроено».
            if [ "$(id -u)" = "0" ]; then
                APP_UID_VAL=$(grep -E '^APP_UID=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -dc '0-9')
                APP_UID_VAL="${APP_UID_VAL:-$(id -u)}"
                if chown "$APP_UID_VAL" "$HOME/.config/rclone/rclone.conf" 2>/dev/null; then
                    log "${GREEN}   ✅ rclone.conf передан владельцу APP_UID=$APP_UID_VAL"
                else
                    chmod 644 "$HOME/.config/rclone/rclone.conf" 2>/dev/null || true
                    log "${YELLOW}   ⚠️ Не удалось chown rclone.conf, выставлен chmod 644"
                fi
            fi
        fi
        # ════════════════════════════════════════════════════════════════════
        # v4.34.3: ДОУСТАНОВКА НЕДОСТАЮЩИХ ПЕРЕМЕННЫХ .env
        # Старые .env не содержат переменных из новых версий .env.example
        # (MORNING_CRON, REMINDER_CRON, DISK_ALERT_PERCENT, BACKUP_RETENTION_*,
        # TZ, SMTP_HOST/PORT и т.п.) → новые фичи молча не работают «из коробки».
        # Переносим ТОЛЬКО отсутствующие ключи с безопасными дефолтами.
        # Плейсхолдеры (your_*, *_here) и пустые значения НЕ переносим: они
        # требуют ручного ввода/генерации, а не дефолта.
        # ════════════════════════════════════════════════════════════════════
        if [ -f "$ENV_FILE" ] && [ -f "$INSTALL_DIR/.env.example" ]; then
            ENV_ADDED=0
            while IFS='=' read -r env_key env_val; do
                case "$env_key" in
                    ''|\#*) continue ;;
                esac
                env_key=$(printf '%s' "$env_key" | tr -d '[:space:]')
                # Пропускаем пустые и плейсхолдеры — их место заполняет install.sh/setup-bot.sh
                case "$env_val" in
                    ''|*'your_'*|*'_here'*) continue ;;
                esac
                if ! grep -q "^${env_key}=" "$ENV_FILE"; then
                    # Проблема 107: перевод строки в конце .env ДО дозаписи
                    [ -n "$(tail -c1 "$ENV_FILE")" ] && echo "" >> "$ENV_FILE"
                    echo "${env_key}=${env_val}" >> "$ENV_FILE"
                    log "   + ${env_key}=${env_val}"
                    ENV_ADDED=$((ENV_ADDED+1))
                fi
            done < "$INSTALL_DIR/.env.example"
            if [ "$ENV_ADDED" -gt 0 ]; then
                log "${GREEN}   ✅ В .env добавлено новых переменных: $ENV_ADDED (подхватятся при пересборке ниже)${NC}"
            else
                log "   ℹ️  .env уже содержит все безопасные дефолты из .env.example"
            fi
        fi
        log "   docker compose up -d --build ..."
        docker compose up -d --build 2>&1 | sed 's/^/   /' || err "docker compose up -d --build не удался"
    else
        err "docker-compose.yml не найден в $INSTALL_DIR"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# v4.46.0 (дельта-реконсиляция): новые дельты, приехавшие С КОДОМ (шаг 5).
# Префлайт (шаг 1) сканирует upgrades/ ДО git pull — из СТАРОГО каталога.
# При «большом скачке» (клиент с древней версии) свежие U*.sh физически
# появляются только после pull и в первый проход (шаг 4) не попадают → код
# новый, а схема старая (боевой кейс 05.09.2026: версия схемы 6, код v4.46,
# дельты U007/U008 не применены; upgrade.sh написал «версия не менялась»).
# Второй проход видит обновлённый каталог и догоняет недостающее в том же
# запуске. Идемпотентность дельт (upgrades/README.md) делает повтор безопасным.
# ═══════════════════════════════════════════════════════════════════════════
if [ "$DRY_RUN" = false ]; then
    NEW_LIST=()
    for f in "$UPGRADES_DIR"/U*.sh; do
        [ -e "$f" ] || continue
        n=$(basename "$f" | sed -n 's/^U0*\([0-9][0-9]*\)_.*/\1/p')
        [ -z "$n" ] && continue
        # Пропускаем: уже применённые в шаге 4 (LAST_APPLIED) и старые (<= CURRENT_VER)
        if [ "$n" -gt "$CURRENT_VER" ] && { [ -z "${LAST_APPLIED:-}" ] || [ "$n" -gt "$LAST_APPLIED" ]; }; then
            NEW_LIST+=("$n|$f")
        fi
    done
    if [ ${#NEW_LIST[@]} -gt 0 ]; then
        IFS=$'\n' NEW_LIST=($(printf '%s\n' "${NEW_LIST[@]}" | sort -t'|' -k1,1n))
        log "${BLUE}📦 Шаг 5.5/9: новые дельты после обновления кода (реконсиляция)...${NC}"
        for item in "${NEW_LIST[@]}"; do
            n="${item%%|*}"
            f="${item#*|}"
            log "${GREEN}   ▶ Применяю U$n: $(basename "$f")${NC}"
            NOCO_DB="$NOCO_DB" INSTALL_DIR="$INSTALL_DIR" bash "$f" || {
                log "${RED}❌ Дельта U$n упала. Восстановление:${NC}"
                log "${RED}   cp $BAK $NOCO_DB${NC}"
                err "Остановлено. Дельта: $f"
            }
            LAST_APPLIED="$n"
        done
        log "${GREEN}✅ Реконсиляция завершена (до U$LAST_APPLIED)${NC}"
    else
        log "   ℹ️ Новых дельт после обновления кода нет"
    fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# v4.46.0 (Проблема 117): ДОУСТАНОВКА ХОСТОВОГО МОНИТОРИНГА.
# install.sh ставит health-alert/fix-fs в cron при УСТАНОВКЕ, но инсталляции,
# жившие до v4.24 и обновлявшиеся через upgrade.sh, могли остаться БЕЗ
# мониторинга. Клиентский кейс 05.09.2026: бот «завис», /health отвечал,
# а алерт не ушёл — health-alert в crontab просто не было (в crontab жили
# только бэкапы). Модули идемпотентны (--install) — безопасно на любой версии.
# ═══════════════════════════════════════════════════════════════════════════
if [ "$DRY_RUN" = false ]; then
    for MOD in modules/health-alert.sh modules/fix-fs-structure.sh; do
        if [ -f "$INSTALL_DIR/$MOD" ]; then
            log "${BLUE}   📡 Доустановка ${MOD} (cron, идемпотентно)...${NC}"
            bash "$INSTALL_DIR/$MOD" --install 2>&1 | sed 's/^/   /'
        fi
    done
fi

# ═══════════════════════════════════════════════════════════════════════════
# 6. ТАБЛИЦЫ БОТА (новые TABLE_*)
# ═══════════════════════════════════════════════════════════════════════════
log "${BLUE}🔗 Шаг 6/9: перепривязка таблиц бота (setup-bot.sh)...${NC}"
if [ "$DRY_RUN" = true ]; then
    log "${YELLOW}   (dry-run: setup-bot.sh пропущен)${NC}"
elif [ "$SKIP_BOT" = true ]; then
    log "${YELLOW}   setup-bot.sh пропущен (--skip-bot)${NC}"
elif [ -f "$INSTALL_DIR/setup-bot.sh" ] && grep -q '^NOCO_TOKEN=' "$ENV_FILE" 2>/dev/null; then
    cd "$INSTALL_DIR"
    bash setup-bot.sh --no-restart 2>&1 | sed 's/^/   /' || log "${YELLOW}   ⚠️ setup-bot.sh не прошёл — проверь BASE_ID/NOCO_TOKEN"
else
    log "${YELLOW}   ⚠️ setup-bot.sh или NOCO_TOKEN отсутствуют — пропускаю"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 7. ПЕРЕЗАПУСК (контейнеры с новым .env)
# ═══════════════════════════════════════════════════════════════════════════
if [ "$DRY_RUN" = true ]; then
    log "${YELLOW}🔄 Шаг 7/9: перезапуск контейнеров (dry-run: пропущен)${NC}"
elif [ "$SKIP_RESTART" = true ]; then
    log "${YELLOW}🔄 Шаг 7/9: перезапуск пропущен (--skip-restart)${NC}"
else
    log "${BLUE}🔄 Шаг 7/9: перезапуск контейнеров...${NC}"
    cd "$INSTALL_DIR"
    docker compose up -d 2>&1 | sed 's/^/   /' || log "${YELLOW}   ⚠️ docker compose up -d не удался"
    # v4.46.0 (боевой кейс): дельты пишут схему НАПРЯМУЮ в sqlite (SKIP_RESTART=1),
    # а NocoDB держит метаданные в памяти → без рестарта новые колонки «не видны»
    # в UI/API (симптом: галочка «Отправка документов» не появилась). docker compose
    # up -d nocodb НЕ перезапускает (образ не менялся) — рестартим явно, но ТОЛЬКО
    # если в этом запуске применялись дельты (иначе лишний даунтайм и ложный алерт).
    if [ -n "${LAST_APPLIED:-}" ]; then
        log "${BLUE}   🔄 Перезапуск nocodb (подхват новых колонок после дельт)...${NC}"
        if docker restart nocodb 2>/dev/null || docker restart printed4u-nocodb 2>/dev/null; then
            sleep 3
            log "${GREEN}   ✅ nocodb перезапущен${NC}"
        else
            log "${YELLOW}   ⚠️ Не удалось перезапустить nocodb — сделай вручную: docker restart nocodb${NC}"
        fi
    fi
    log "${GREEN}✅ Контейнеры перезапущены${NC}"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 8. ДИАГНОСТИКА
# ═══════════════════════════════════════════════════════════════════════════
log "${BLUE}🩺 Шаг 8/9: диагностика...${NC}"
if [ "$DRY_RUN" = true ] || [ "$SKIP_DIAGNOSE" = true ]; then
    log "${YELLOW}   (пропущено)${NC}"
elif [ -f "$INSTALL_DIR/diagnose.sh" ]; then
    cd "$INSTALL_DIR"
    bash diagnose.sh 2>&1 | tail -30 | sed 's/^/   /' || log "${YELLOW}   ⚠️ diagnose.sh завершился с ошибкой"
else
    log "${YELLOW}   ⚠️ diagnose.sh не найден — пропускаю"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 9. ВЕРСИЯ СХЕМЫ + ПОСТ-ПРОВЕРКА СИНХРОНИЗАЦИИ
# ═══════════════════════════════════════════════════════════════════════════
# v4.46.0: после апдейта схема ОБЯЗАНА совпадать с кодом (маркер = max-дельта
# нового дерева upgrades/). Раньше рассинхрон (код новый, схема старая — «большой
# скачок») молча проходил как «✅ Обновление завершено». Теперь финальная проверка
# не даёт закрыть глаза: маркер < max-дельты → жёсткая ошибка с инструкцией.
MAX_DELTA=0
for f in "$UPGRADES_DIR"/U*.sh; do
    [ -e "$f" ] || continue
    n=$(basename "$f" | sed -n 's/^U0*\([0-9][0-9]*\)_.*/\1/p')
    [ -n "$n" ] && [ "$n" -gt "$MAX_DELTA" ] && MAX_DELTA="$n"
done

if [ "$DRY_RUN" = true ]; then
    log "${BLUE}🏁 Шаг 9/9: версия схемы будет записана (dry-run: пропущено)${NC}"
    log "   Текущая схема: U$CURRENT_VER | в коде дельт до: U$MAX_DELTA"
else
    if [ -n "${LAST_APPLIED:-}" ]; then
        NOCO_DB="$NOCO_DB" bash "$INSTALL_DIR/modules/version.sh" set "$LAST_APPLIED" | sed 's/^/   /'
        log "${GREEN}✅ Версия схемы обновлена до U$LAST_APPLIED${NC}"
    else
        log "${GREEN}ℹ️ Версия схемы не менялась ($CURRENT_VER)${NC}"
    fi

    # Пост-условие: маркер схемы == max-дельта нового кода.
    FINAL_VER=$(NOCO_DB="$NOCO_DB" bash "$INSTALL_DIR/modules/version.sh" get)
    if [ "$MAX_DELTA" -gt 0 ] && [ "$FINAL_VER" -lt "$MAX_DELTA" ]; then
        log "${RED}❌ Схема отстаёт от кода: в БД U$FINAL_VER, в новом коде дельт до U$MAX_DELTA.${NC}"
        log "${RED}   Часть дельт не применилась (обычно — «большой скачок»). Восстановление:${NC}"
        log "${RED}   cp ${BAK:-<бэкап из шага 2>} $NOCO_DB${NC}"
        log "${RED}   и запусти upgrade.sh повторно (дельты идемпотентны, всё догонится).${NC}"
        err "Схема не синхронна с кодом (U$FINAL_VER < U$MAX_DELTA)"
    fi
    log "${GREEN}✅ Пост-проверка: схема U$FINAL_VER синхронна с кодом (max-дельта U$MAX_DELTA)${NC}"
fi

log ""
log "${GREEN}═══════════════════════════════════════════════════════════${NC}"
log "${GREEN}🎉 Обновление завершено!${NC}"
[ -n "${BAK:-}" ] && log "${YELLOW}💾 Бэкап до обновления: $BAK${NC}"
log "${GREEN}═══════════════════════════════════════════════════════════${NC}"

