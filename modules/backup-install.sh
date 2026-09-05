#!/bin/bash
# ============================================================================
# Printed4U CRM - Модуль настройки бэкапов v1.5.0 (релиз v4.34.0, фиксы Проблема 109)
# ============================================================================
# Назначение: Настройка резервного копирования:
#   1. Локальные бэкапы (полный снапшот: база + проекты + клиенты + PDF + конфиг)
#      — настраиваемое расписание: дни недели + время
#   2. Облачные бэкапы в Google Drive (rclone, remote 'grive', папка 'nocodb-backups')
#   3. Интеграция с Telegram-ботом (команда /backup): монтирование папок в контейнер
#
# Запуск:   bash modules/backup-install.sh
#           (вручную в любой момент ИЛИ автоматически из install.sh)
# ============================================================================
# Изменения v1.0.0:
# - Настраиваемое расписание локальных бэкапов (дни + время)
# - Облако: Google Drive через rclone (как захардкожено в bot.js)
# - Первый локальный бэкап выполняется сразу при настройке
# - Тестовая заливка в облако
# - Идемпотентность: повторный запуск безопасен
#
# Изменения v1.1.0:
# - FIX (Проблема 103): не хватало закрывающего fi после первого локального бэкапа —
#   из-за этого ШАГИ 5-7 (облако/rclone, монтирование в бот, ротация в .env) считались
#   частью else-ветки и МОЛЧА пропускались при успешном первом бэкапе. Облачные бэкапы
#   фактически не настраивались в штатном сценарии.
# - Понятные пошаговые подсказки при подключении Google Drive: шпаргалка ответов мастера
#   rclone, как получить токен на ПК с браузером, что делать при «Google hasn't verified».
#
# Изменения v1.2.0:
# - FIX (Проблема 104, боевой кейс): `rclone config create grive drive` на rclone из
#   Ubuntu apt (1.60.1) НЕ задаёт вопросов — берёт дефолты и уходит в локальный OAuth
#   listener (http://127.0.0.1:53682, «Waiting for code...»), который на headless-сервере
#   виснет вечно. Убран вызов config create.
# - Headless-флоу: пользователь получает токен на ПК (`rclone authorize "drive"`), скрипт
#   принимает JSON и сам пишет секцию [grive] в ~/.config/rclone/rclone.conf
#   (проверено на rclone 1.60.1: конфиг читается, remote виден без сети/зависаний).
# - Проверка соединения обёрнута в timeout 25 — битый remote больше не подвешивает скрипт.
#
# Изменения v1.3.0:
# - FIX (Проблема 105): перезапуск бота шёл по container_name (printed4u-bot), а docker
#   compose принимает имя СЕРВИСА (bot) → «no such service», контейнер не перезапускался,
#   rclone.conf не монтировался, /backup показывал ошибку облака. Теперь имя сервиса
#   вычисляется из docker-compose.yml (по container_name: printed4u-bot, fallback bot),
#   а при неудаче перезапуска выводится ❌ с ручной командой вместо ложного «✅».
#
# Изменения v1.4.0:
# - FIX (Проблема 107): дозапись в .env без финального перевода строки склеивала строки
#   (реальный кейс: APP_GID=1000BACKUP_RETENTION_LOCAL=7 → docker не стартует: unable to find
#   group). Гарантия \n теперь ПЕРЕД любой дозаписью + автопочинка APP_UID/APP_GID.
# - FIX (Проблема 108): монтирование rclone.conf в бот больше НЕ локальный патч tracked-файла
#   docker-compose.yml (терялся при git pull/upgrade.sh). Путь RCLONE_CONF пишется в .env (вне
#   git), эталонный docker-compose.yml монтирует ${RCLONE_CONF:-/dev/null}. При изменении —
#   форсируется перезапуск бота.
#
# Изменения v1.5.0:
# - FIX (Проблема 109, боевой кейс): dest монтирования rclone.conf в контейнер был
#   /root/.config/rclone/rclone.conf, а процесс бота идёт от юзера node (user: ${APP_UID:-1000},
#   HOME=/home/node, /root закрыт). bot.js зовёт rclone через ~/.config/... → реальный путь
#   /home/node/.config/... → файл «не найден» → /backup всегда показывал «❌ Облако: не настроено»
#   ДАЖЕ при корректном RCLONE_CONF в .env (подтверждено на клиентском сервере: конфиг на месте,
#   облачные бэкапы идут, бот не видит). Новый dest — /home/node/.config/rclone/rclone.conf.
#   Fallback-патч (для не-git установок) распознаёт старый формат :/root/.config/... и приводит
#   к новому пути; под root дополнительно chown rclone.conf на APP_UID (иначе контейнерный
#   юзер не прочитает root-файл 600).
# ============================================================================
set -e

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m'

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="/mnt/data/backups"
LOG_FILE="$BACKUP_DIR/backup.log"

echo -e "${BLUE}═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   💾 Настройка бэкапов v1.5.0 (локальные + облачные)   ║${NC}"
echo -e "${BLUE}║   Локально: полный снапшот по расписанию                ║${NC}"
echo -e "${BLUE}║   Облако:   Google Drive (rclone → grive:nocodb-backups)║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ============================================================================
# ШАГ 0: Проверка наличия .env
# ============================================================================
if [ ! -f "$INSTALL_DIR/.env" ]; then
    echo -e "${RED}❌ Файл .env не найден!${NC}"
    echo -e "${YELLOW}💡 Запусти сначала install.sh${NC}"
    exit 1
fi

# ============================================================================
# ШАГ 1: Пропустить настройку?
# ============================================================================
echo -e "${YELLOW}ℹ️  Бэкапы — это страховка от потери данных клиентов и документов.${NC}"
echo -e "${YELLOW}   Статус бэкапов можно смотреть в Telegram командой /backup.${NC}"
echo -e "${CYAN}   Настроить можно в любой момент: bash modules/backup-install.sh${NC}"
echo ""
read -p "Настроить бэкапы сейчас? (y/n, по умолчанию y): " setup_now
setup_now=${setup_now:-y}

if [[ "$setup_now" != "y" && "$setup_now" != "Y" ]]; then
    echo -e "${GREEN}✅ Пропускаем настройку бэкапов.${NC}"
    exit 0
fi

# ============================================================================
# ШАГ 2: Расписание ЛОКАЛЬНЫХ бэкапов
# ============================================================================
echo ""
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "${MAGENTA}🗓  Расписание локальных бэкапов${NC}"
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}   Выбери периодичность:${NC}"
echo -e "${BLUE}1) Ежедневно${NC}"
echo -e "${BLUE}2) По будням (Пн-Пт)${NC}"
echo -e "${BLUE}3) Раз в неделю (выбрать день)${NC}"
echo -e "${BLUE}4) Свои дни (через запятую, 1=Пн ... 7=Вс)${NC}"
echo ""
read -p "Выбери вариант (1-4, по умолчанию 1): " freq
freq=${freq:-1}

case "$freq" in
    1)
        CRON_DAYS="*"
        FREQ_TEXT="ежедневно"
        ;;
    2)
        CRON_DAYS="1-5"
        FREQ_TEXT="по будням (Пн-Пт)"
        ;;
    3)
        echo ""
        echo -e "${YELLOW}   Выбери день недели:${NC}"
        echo -e "${BLUE}1) Понедельник   2) Вторник   3) Среда${NC}"
        echo -e "${BLUE}4) Четверг       5) Пятница   6) Суббота${NC}"
        echo -e "${BLUE}7) Воскресенье${NC}"
        read -p "День (1-7, по умолчанию 1): " week_day
        week_day=${week_day:-1}
        if ! [[ "$week_day" =~ ^[1-7]$ ]]; then
            echo -e "${RED}❌ Неверный день: $week_day${NC}"
            exit 1
        fi
        CRON_DAYS="$week_day"
        FREQ_TEXT="раз в неделю (день $week_day)"
        ;;
    4)
        echo ""
        read -p "Дни (например: 1,3,5): " custom_days
        if ! [[ "$custom_days" =~ ^[1-7](,[1-7])*$ ]]; then
            echo -e "${RED}❌ Неверный формат дней: $custom_days (нужно: 1,3,5)${NC}"
            exit 1
        fi
        CRON_DAYS="$custom_days"
        FREQ_TEXT="дни недели: $custom_days"
        ;;
    *)
        echo -e "${RED}❌ Неверный выбор${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${YELLOW}   Укажи время запуска (серверное):${NC}"
read -p "Время (ЧЧ:ММ, по умолчанию 02:00): " backup_time
backup_time=${backup_time:-02:00}
if ! [[ "$backup_time" =~ ^([01]?[0-9]|2[0-3]):[0-5][0-9]$ ]]; then
    echo -e "${RED}❌ Неверное время: $backup_time (нужно ЧЧ:ММ, например 02:30)${NC}"
    exit 1
fi
CRON_MIN=$(echo "$backup_time" | cut -d: -f2 | sed 's/^0//')
CRON_HOUR=$(echo "$backup_time" | cut -d: -f1 | sed 's/^0//')

CRON_LOCAL="$CRON_MIN $CRON_HOUR * * $CRON_DAYS bash $INSTALL_DIR/modules/backup-local.sh >> $LOG_FILE 2>&1"
echo ""
echo -e "${GREEN}✅ Расписание локальных бэкапов: $FREQ_TEXT в $backup_time${NC}"
echo -e "${CYAN}   Cron: $CRON_LOCAL${NC}"


# ============================================================================
# ШАГ 3: Установка расписания в crontab (идемпотентно)
# ============================================================================
echo ""
echo -e "${BLUE}⏰ Добавляю задачу в crontab...${NC}"
# Убираем старую строку локального бэкапа (если была) и добавляем новую
crontab -l 2>/dev/null | grep -v "backup-local\.sh" | crontab - 2>/dev/null || true
(crontab -l 2>/dev/null; echo "$CRON_LOCAL") | crontab -
echo -e "${GREEN}✅ Локальные бэкапы добавлены в crontab${NC}"
echo -e "${CYAN}   Просмотр: crontab -l | Ручной запуск: bash modules/backup-local.sh${NC}"

# ============================================================================
# ШАГ 4: Первый локальный бэкап сразу
# ============================================================================
echo ""
echo -e "${BLUE}📦 Выполняю первый локальный бэкап (проверка работы)...${NC}"
if bash "$INSTALL_DIR/modules/backup-local.sh"; then
    echo -e "${GREEN}✅ Первый бэкап создан:${NC}"
    ls -lh /mnt/data/backups/nocodb_full_backup_*.tar.gz | tail -1
else
    echo -e "${RED}❌ Первый бэкап не удался! Проверь логи: $LOG_FILE${NC}"
    echo -e "${YELLOW}   Локальная настройка завершена, но облако настраивать смысла нет.${NC}"
    read -p "Продолжить с облаком всё равно? (y/N): " force_cloud
    force_cloud=${force_cloud:-n}
    if [[ "$force_cloud" != "y" && "$force_cloud" != "Y" ]]; then
        exit 1
    fi
fi

# ============================================================================
# ШАГ 5: Облачные бэкапы (Google Drive через rclone)
# ============================================================================
echo ""
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "${MAGENTA}☁️  Облачные бэкапы в Google Drive (rclone)${NC}"
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "${YELLOW}   Облачная копия защитит данные даже если сервер сгорит.${NC}"
echo -e "${YELLOW}   Файлы будут лежать в Google Drive, папка 'nocodb-backups'.${NC}"
echo ""
read -p "Настроить облачные бэкапы? (y/n, по умолчанию y): " setup_cloud
setup_cloud=${setup_cloud:-y}

if [[ "$setup_cloud" == "y" || "$setup_cloud" == "Y" ]]; then
    # --- 5.1: Установка rclone ---
    echo ""
    echo -e "${BLUE}🔧 Проверяю rclone...${NC}"
    if ! command -v rclone >/dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  rclone не установлен. Устанавливаю...${NC}"
        sudo apt-get update -qq
        sudo apt-get install -y -qq rclone
        if ! command -v rclone >/dev/null 2>&1; then
            echo -e "${RED}❌ Не удалось установить rclone. Облачные бэкапы пропущены.${NC}"
            setup_cloud="n"
        else
            echo -e "${GREEN}✅ rclone установлен: $(rclone version | head -1)${NC}"
        fi
    else
        echo -e "${GREEN}✅ rclone: $(rclone version | head -1)${NC}"
    fi
fi

if [[ "$setup_cloud" == "y" || "$setup_cloud" == "Y" ]]; then
    # --- 5.2: Настройка remote 'grive' (идемпотентно) ---
    if rclone listremotes 2>/dev/null | grep -q '^grive:$'; then
        echo -e "${GREEN}✅ Remote 'grive' уже настроен${NC}"
    else
        echo ""
        echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
        echo -e "${YELLOW}☁️  Подключение Google Drive — один раз, ~5 минут${NC}"
        echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
        echo -e "${NC}   Сервер будет класть копии бэкапов в папку 'nocodb-backups'"
        echo -e "${NC}   твоего Google Диска. Сейчас нужно один раз разрешить доступ."
        echo ""
        echo -e "${YELLOW}   Что понадобится:${NC}"
        echo -e "   • Google-аккаунт"
        echo -e "   • Компьютер с браузером (сервер без браузера — токен делаем на ПК)"
        echo ""
        echo -e "${YELLOW}   ШАГ 1. Получи токен на СВОЁМ компьютере:${NC}"
        echo -e "  а) Поставь rclone на ПК, если его нет:"
        echo -e "     Windows: ${CYAN}rclone.org/downloads${NC} → скачать zip → распаковать"
        echo -e "     macOS:   ${CYAN}brew install rclone${NC}"
        echo -e "     Linux:   ${CYAN}sudo apt-get install -y rclone${NC}"
        echo -e "  б) Выполни в терминале ПК:"
        echo -e "     ${CYAN}rclone authorize \"drive\"${NC}"
        echo -e "  в) Откроется браузер → войди в Google → нажми «Разрешить»"
        echo -e "     Если Google ругается «Google hasn't verified this app» —"
        echo -e "     нажми ${CYAN}Advanced → Go to ... (unsafe)${NC}"
        echo -e "  г) В терминале ПК появится блок вида:"
        echo -e "     ${CYAN}Paste the following into your remote machine --->${NC}"
        echo -e "     ${CYAN}{\"access_token\":\"...\",\"refresh_token\":\"...\",...}${NC}"
        echo -e "     ${CYAN}<---End paste${NC}"
        echo -e "     Скопируй ВСЮ длинную строку между ---> и <---."
        echo ""
        echo -e "${YELLOW}   ШАГ 2. Вставь её сюда (одной строкой):${NC}"
        read -r -p "   Токен: " gdrive_token
        gdrive_token="$(printf '%s' "$gdrive_token" | tr -d '\r')"
        if [ -z "$gdrive_token" ]; then
            echo -e "${RED}❌ Токен пустой. Запусти настройку заново:${NC}"
            echo -e "${CYAN}   bash modules/backup-install.sh${NC}"
            exit 1
        fi
        echo ""
        echo -e "${BLUE}   Сохраняю подключение 'grive' в rclone...${NC}"
        RCLONE_CONF_DIR="$HOME/.config/rclone"
        RCLONE_CONF="$RCLONE_CONF_DIR/rclone.conf"
        mkdir -p "$RCLONE_CONF_DIR"
        touch "$RCLONE_CONF"
        # Если секция [grive] уже есть (повторный запуск/битый remote) — заменяем её
        if grep -q '^\[grive\]' "$RCLONE_CONF" 2>/dev/null; then
            awk 'BEGIN{skip=0} /^\[grive\]/{skip=1; next} skip && /^\[/{skip=0} !skip{print}' "$RCLONE_CONF" > "$RCLONE_CONF.tmp" && mv "$RCLONE_CONF.tmp" "$RCLONE_CONF"
        fi
        {
            echo ""
            echo "[grive]"
            echo "type = drive"
            echo "scope = drive"
            printf 'token = %s\n' "$gdrive_token"
        } >> "$RCLONE_CONF"
        echo -e "${GREEN}✅ Remote 'grive' сохранён${NC}"
        echo -e "${YELLOW}   Если Google пишет «Access blocked»: общий ключ rclone отключают"
        echo -e "${YELLOW}   в 2026 — создай свой OAuth client_id (rclone.org/drive), получи"
        echo -e "${YELLOW}   токен заново и повтори настройку${NC}"
    fi

    # --- 5.3: Проверка соединения + создание папки ---
    echo ""
    echo -e "${BLUE}🌐 Проверяю соединение с Google Drive...${NC}"
    # timeout: на headless-сервере rclone без валидного токена пытается открыть
    # браузерный OAuth (127.0.0.1:53682) и виснет — режем по времени
    if timeout 25 rclone mkdir "grive:nocodb-backups" 2>>"$LOG_FILE" && timeout 25 rclone lsd grive: >/dev/null 2>&1; then
        echo -e "${GREEN}✅ Google Drive доступен, папка 'nocodb-backups' готова${NC}"
    else
        echo -e "${RED}❌ Не удалось подключиться к Google Drive.${NC}"
        echo -e "${YELLOW}   Проверь авторизацию: rclone lsd grive:${NC}"
        echo -e "${YELLOW}   Если remote 'grive' есть, но не работает (битый токен) — удали и повтори:${NC}"
        echo -e "${CYAN}   rclone config delete grive && bash modules/backup-install.sh${NC}"
        read -p "Продолжить без облачных бэкапов? (y/N): " skip_cloud
        skip_cloud=${skip_cloud:-n}
        if [[ "$skip_cloud" != "y" && "$skip_cloud" != "Y" ]]; then
            exit 1
        fi
        setup_cloud="n"
    fi
fi

if [[ "$setup_cloud" == "y" || "$setup_cloud" == "Y" ]]; then
    # --- 5.4: Cron для облака (локальное время + 1 час) ---
    CLOUD_HOUR=$(( (CRON_HOUR + 1) % 24 ))
    CRON_CLOUD="$CRON_MIN $CLOUD_HOUR * * $CRON_DAYS bash $INSTALL_DIR/modules/backup-cloud.sh >> $LOG_FILE 2>&1"
    crontab -l 2>/dev/null | grep -v "backup-cloud\.sh" | crontab - 2>/dev/null || true
    (crontab -l 2>/dev/null; echo "$CRON_CLOUD") | crontab -
    echo -e "${GREEN}✅ Облачные бэкапы: $FREQ_TEXT в $(printf '%02d:%02d' "$CLOUD_HOUR" "$CRON_MIN")${NC}"
    echo -e "${CYAN}   Cron: $CRON_CLOUD${NC}"

    # --- 5.5: Тестовая заливка последнего бэкапа ---
    echo ""
    echo -e "${BLUE}☁️  Заливаю последний бэкап в облако (проверка)...${NC}"
    if bash "$INSTALL_DIR/modules/backup-cloud.sh"; then
        echo -e "${GREEN}✅ Тестовая заливка успешна!${NC}"
    else
        echo -e "${RED}❌ Тестовая заливка не удалась. Проверь лог: $LOG_FILE${NC}"
    fi
fi


# ============================================================================
# ШАГ 6: Интеграция с ботом — монтирование папок в контейнер printed4u-bot
# ============================================================================
echo ""
echo -e "${BLUE}🔌 Настраиваю команду /backup в Telegram-боте...${NC}"

COMPOSE_FILE="$INSTALL_DIR/docker-compose.yml"
COMPOSE_CHANGED=0

# 6.1: /mnt/data/backups (чтение статуса локальных бэкапов)
if ! grep -q '/mnt/data/backups:/mnt/data/backups' "$COMPOSE_FILE" 2>/dev/null; then
    awk -v home="$HOME" '
        /^  bot:/ {inbot=1}
        /^  webhook:/ {inbot=0}
        inbot && /\/mnt\/data\/noco-static/ && !added {
            print "      - /mnt/data/backups:/mnt/data/backups:ro"
            added=1
        }
        {print}
    ' "$COMPOSE_FILE" > "$COMPOSE_FILE.tmp" && mv "$COMPOSE_FILE.tmp" "$COMPOSE_FILE"
    COMPOSE_CHANGED=1
    echo -e "${GREEN}✅ В бот смонтирована папка /mnt/data/backups (ro)${NC}"
else
    echo -e "${GREEN}✅ Папка /mnt/data/backups уже смонтирована в бот${NC}"
fi

# 6.2: rclone.conf (чтение статуса облачных бэкапов)
RCLONE_CONFIG="$HOME/.config/rclone/rclone.conf"
# Проблема 109: контейнерный dest — /home/node/.config/rclone/rclone.conf (home юзера node в
# образе node:18-slim; процесс бота идёт от user ${APP_UID:-1000}, HOME=/home/node, а /root для
# него закрыт). НЕ /root/.config — старый путь делал /backup «Облако: не настроено» даже при
# корректном RCLONE_CONF (Проблема 109).
RCLONE_DEST="/home/node/.config/rclone/rclone.conf"

if [ -f "$RCLONE_CONFIG" ]; then
    # (a) Старый dest /root/... (эталон v4.33.0 или локальный патч v4.32.х) → новый путь.
    # Замена идемпотентная: повторный запуск ничего не меняет.
    if grep -q ':/root/.config/rclone/rclone.conf' "$COMPOSE_FILE" 2>/dev/null; then
        sed -i 's|:/root/.config/rclone/rclone.conf|:'"$RCLONE_DEST"'|' "$COMPOSE_FILE"
        COMPOSE_CHANGED=1
        echo -e "${GREEN}✅ В боте dest rclone.conf приведён к $RCLONE_DEST (Проблема 109)${NC}"
    fi

    # (b) Строки монтирования нет вовсе (не-git установка / очень старый compose) — добавить
    if ! grep -qF ":$RCLONE_DEST" "$COMPOSE_FILE" 2>/dev/null; then
        awk -v rconf="$RCLONE_CONFIG" -v dest="$RCLONE_DEST" '
            /^  bot:/ {inbot=1}
            /^  webhook:/ {inbot=0}
            inbot && /\/mnt\/data\/noco-static/ && !added {
                print "      - " rconf ":" dest ":ro"
                added=1
            }
            {print}
        ' "$COMPOSE_FILE" > "$COMPOSE_FILE.tmp" && mv "$COMPOSE_FILE.tmp" "$COMPOSE_FILE"
        COMPOSE_CHANGED=1
        echo -e "${GREEN}✅ В бот смонтирован rclone.conf (ro)${NC}"
    else
        echo -e "${GREEN}✅ rclone.conf уже смонтирован в бот (compose из git или прошлый патч)${NC}"
    fi
fi

# Проблема 108: путь к rclone.conf — в .env (вне git). Эталонный docker-compose.yml монтирует
# ${RCLONE_CONF:-/dev/null}:$RCLONE_DEST; локальный патч tracked-файла
# затирался при git pull/upgrade.sh → /backup «отваливался». Пишем ДО перезапуска (6.3),
# чтобы docker compose up подхватил реальный файл. Если значение изменилось — форсируем
# перезапуск бота (COMPOSE_CHANGED=1), иначе новый volume не применится.
if [ -f "$RCLONE_CONFIG" ]; then
    ENV_FILE="$INSTALL_DIR/.env"
    CURRENT_RCLONE_CONF=$(grep '^RCLONE_CONF=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)
    if [ "$CURRENT_RCLONE_CONF" = "$RCLONE_CONFIG" ]; then
        echo -e "${GREEN}✅ RCLONE_CONF в .env актуален${NC}"
    else
        [ -n "$(tail -c1 "$ENV_FILE")" ] && echo "" >> "$ENV_FILE"
        if grep -q '^RCLONE_CONF=' "$ENV_FILE" 2>/dev/null; then
            sed -i "s|^RCLONE_CONF=.*|RCLONE_CONF=$RCLONE_CONFIG|" "$ENV_FILE"
        else
            echo "RCLONE_CONF=$RCLONE_CONFIG" >> "$ENV_FILE"
        fi
        COMPOSE_CHANGED=1
        echo -e "${GREEN}✅ RCLONE_CONF записан в .env (монтирование rclone.conf в бот)${NC}"
    fi

    # Проблема 109: bind-mount НЕ меняет хост-владельца/права файла. Если rclone.conf создан под
    # root (установка через sudo, обычно 600 root:root) — контейнерный юзер (APP_UID) его не
    # прочитает, и /backup снова скажет «не настроено». Под root передаём файл владельцу APP_UID.
    if [ "$(id -u)" = "0" ]; then
        APP_UID_VAL=$(grep -E '^APP_UID=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -dc '0-9')
        APP_UID_VAL="${APP_UID_VAL:-$(id -u)}"
        if chown "$APP_UID_VAL" "$RCLONE_CONFIG" 2>/dev/null; then
            echo -e "${GREEN}✅ rclone.conf передан владельцу APP_UID=$APP_UID_VAL (читаем из контейнера)${NC}"
        else
            chmod 644 "$RCLONE_CONFIG" 2>/dev/null || true
            echo -e "${YELLOW}⚠️  Не удалось chown rclone.conf, выставлен chmod 644${NC}"
        fi
    fi
fi

# 6.3: Имя сервиса бота — docker compose принимает имя СЕРВИСА, а не container_name.
# (Проблема 105: хардкод printed4u-bot давал «no such service» → бот не перезапускался,
# rclone.conf не монтировался, /backup показывал ошибку облака)
BOT_SERVICE=$(awk '/^  [A-Za-z0-9_-]+:/{svc=$1; sub(":","",svc)} /container_name: printed4u-bot/{print svc; exit}' "$COMPOSE_FILE")
BOT_SERVICE="${BOT_SERVICE:-bot}"

if [ "$COMPOSE_CHANGED" == "1" ]; then
    echo -e "${BLUE}🔄 Перезапускаю контейнер бота ($BOT_SERVICE) с новыми настройками...${NC}"
    if docker compose -f "$COMPOSE_FILE" up -d "$BOT_SERVICE" 2>&1; then
        echo -e "${GREEN}✅ Контейнер бота перезапущен${NC}"
    else
        echo -e "${RED}❌ Не удалось перезапустить бот (сервис '$BOT_SERVICE').${NC}"
        echo -e "${YELLOW}   Сделай вручную: cd $INSTALL_DIR && docker compose up -d $BOT_SERVICE${NC}"
        echo -e "${YELLOW}   Иначе команда /backup не увидит облачные бэкапы.${NC}"
    fi
else
    echo -e "${GREEN}✅ docker-compose.yml в актуальном состоянии, перезапуск не нужен${NC}"
fi

# ============================================================================
# ШАГ 7: Переменные ротации в .env
# ============================================================================
ENV_FILE="$INSTALL_DIR/.env"

# Проблема 107: автопочинка, если .env уже повреждён дозаписью без перевода строки
# (реальный кейс: APP_GID=1000BACKUP_RETENTION_LOCAL=7 → docker: unable to find group).
# Значения APP_UID/APP_GID обязаны быть только цифрами.
if grep -qE '^APP_[UG]ID=.*[^0-9]' "$ENV_FILE" 2>/dev/null; then
    echo -e "${YELLOW}⚠️  В .env склеились строки APP_UID/APP_GID (не хватало перевода строки). Восстанавливаю...${NC}"
    sed -i "s|^APP_UID=.*|APP_UID=$(id -u)|; s|^APP_GID=.*|APP_GID=$(id -g)|" "$ENV_FILE"
    echo -e "${GREEN}✅ APP_UID/APP_GID восстановлены ($(id -u):$(id -g))${NC}"
fi

# Проблема 107: перевод строки в конце .env — ДО любой дозаписи.
# ВАЖНО: [ -n "$(tail -c1 f)" ] — true, только если последний байт НЕ перевод строки.
# (старая идиома `tail -c1 f | grep -q $'\n'` матчится всегда → \n не добавлялся → склейка строк)
[ -n "$(tail -c1 "$ENV_FILE")" ] && echo "" >> "$ENV_FILE"
grep -q '^BACKUP_RETENTION_LOCAL=' "$ENV_FILE" || echo 'BACKUP_RETENTION_LOCAL=7' >> "$ENV_FILE"
grep -q '^BACKUP_RETENTION_CLOUD=' "$ENV_FILE" || echo 'BACKUP_RETENTION_CLOUD=14' >> "$ENV_FILE"
echo -e "${GREEN}✅ Ротация записана в .env: BACKUP_RETENTION_LOCAL / BACKUP_RETENTION_CLOUD${NC}"

# ============================================================================
# ФИНАЛ
# ============================================================================
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Настройка бэкапов завершена!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "   Локальные:   ${CYAN}$FREQ_TEXT в $backup_time (cron: $CRON_LOCAL)${NC}"
if [ -n "${CRON_CLOUD:-}" ]; then
    echo -e "   Облачные:    ${CYAN}$FREQ_TEXT в $(printf '%02d:%02d' "$CLOUD_HOUR" "$CRON_MIN") (Google Drive)${NC}"
fi
echo -e "   Файлы:       ${CYAN}/mnt/data/backups/nocodb_full_backup_*.tar.gz${NC}"
echo -e "   Лог:         ${CYAN}$LOG_FILE${NC}"
echo ""
echo -e "${YELLOW}📋 Статус бэкапов смотри в Telegram: /backup (только для Руководителя)${NC}"
echo -e "${YELLOW}   Ручной запуск:${NC}"
echo -e "   ${CYAN}bash modules/backup-local.sh${NC}   — локальный бэкап сейчас"
echo -e "   ${CYAN}bash modules/backup-cloud.sh${NC}   — залить в облако сейчас"
echo ""
echo -e "${YELLOW}⚠️  Бэкапы содержат персональные данные клиентов и секреты (.env).${NC}"
echo -e "${YELLOW}   Ограничь доступ к Google Drive-аккаунту и папке /mnt/data/backups.${NC}"
echo ""
