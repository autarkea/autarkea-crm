#!/bin/bash
# ============================================================================
# modules/ensure-modules.sh v1.0.0 — ДОКАТКА МОДУЛЕЙ УСТАНОВЛЕННОЙ CRM
# ============================================================================
# Назначение: фикс модуля должен доезжать до клиента САМ, а не «застревать» на
# версии, которая была при установке. Боевой кейс: у клиента Samba навсегда
# осталась v1.x — upgrade.sh перезапускал только два модуля из десяти, а
# install.sh ставит модули один раз (Проблема 129).
#
# Идея: помним sha256 ПРИМЕНЁННОГО файла модуля. Хеш изменился (или состояния
# нет) → модуль надо докатить. Именно хеш, а не «версия в шапке»: работает без
# дисциплины и ловит любую правку (для идемпотентных модулей повторный прогон
# безвреден, поэтому ложных срабатываний не боимся).
#
# Две категории (манифест ниже):
#   AUTO   — неинтерактивные и идемпотентные: докатываются сами;
#   MANUAL — спрашивают пароли/токены/домены: НЕ трогаем, только предупреждаем
#            с готовой командой (решение принимает владелец).
#
# Состояние: /mnt/data/nocodb-data/module-state.txt — строки «<sha256>|<имя>».
# Живёт в зоне данных: переживает git-обновления и попадает в бэкапы.
#
# Использование:
#   bash modules/ensure-modules.sh               # докатать изменившиеся модули
#   bash modules/ensure-modules.sh --dry-run     # показать план, ничего не менять
#   bash modules/ensure-modules.sh --force       # прогнать AUTO даже без изменений
#   bash modules/ensure-modules.sh --calibrate   # только записать состояние (install.sh)
#   ENSURE_MODULES="a.sh b.sh" bash ...          # ограничить список (диагностика/тесты)
#
# Переменные окружения (для тестов/нестандартной укладки):
#   MODULES_DIR  — где лежат модули (по умолчанию — каталог этого скрипта)
#   STATE_FILE   — файл состояния
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODULES_DIR="${MODULES_DIR:-$SCRIPT_DIR}"
STATE_FILE="${STATE_FILE:-/mnt/data/nocodb-data/module-state.txt}"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'
log() { echo -e "$*"; }

# ────────────────────────────────────────────────────────────────────────────
# МАНИФЕСТ. Меняешь поведение модуля — он докатится сам, править список не надо.
# ВАЖНО: в AUTO попадают ТОЛЬКО неинтерактивные идемпотентные модули.
# ────────────────────────────────────────────────────────────────────────────
AUTO_MODULES="health-alert.sh fix-fs-structure.sh samba-install.sh firewall-setup.sh"

MANUAL_MODULES="bot-install.sh email-install.sh backup-install.sh tailscale-install.sh heartbeat-install.sh setup-https.sh setup-cloudflare.sh setup-formulas.sh"

DRY_RUN=false
FORCE=false
CALIBRATE=false

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)   DRY_RUN=true ;;
        --force)     FORCE=true ;;
        --calibrate) CALIBRATE=true ;;
        -h|--help)   sed -n '2,30p' "$0"; exit 0 ;;
        *) echo -e "${RED}❌ Неизвестный аргумент: $1${NC}" >&2; exit 2 ;;
    esac
    shift
done

# ────────────────────────────────────────────────────────────────────────────
# Категория модуля и «применимость» на этом сервере
# ────────────────────────────────────────────────────────────────────────────
is_auto() {
    local n="$1" m
    for m in $AUTO_MODULES; do [ "$m" = "$n" ] && return 0; done
    return 1
}

# Применим ли модуль на ЭТОМ сервере (клиент мог не ставить Samba/firewall).
module_applicable() {
    case "$1" in
        samba-install.sh)
            command -v smbd >/dev/null 2>&1 && [ -f /etc/samba/smb.conf ] ;;
        firewall-setup.sh)
            ufw_active ;;
        *)
            return 0 ;;
    esac
}

# ────────────────────────────────────────────────────────────────────────────
# Проверки ufw — БЕЗ sudo (иначе откроется запрос пароля и скрипт «зависнет»).
# /etc/ufw/ufw.conf читается всеми; `sudo -n` никогда не спрашивает пароль.
# ────────────────────────────────────────────────────────────────────────────
ufw_active() {
    if [ -r /etc/ufw/ufw.conf ] && grep -q '^ENABLED=yes' /etc/ufw/ufw.conf 2>/dev/null; then
        return 0
    fi
    command -v ufw >/dev/null 2>&1 || return 1
    sudo -n ufw status 2>/dev/null | grep -q 'Status: active'
}

# Открыт ли 443 (клиент живёт на HTTPS/Cloudflare)? Best-effort: если не смогли
# определить — просто НЕ передаём --https. Это безопасно: firewall-setup.sh
# только ДОБАВЛЯЕТ правила и никогда не удаляет уже открытые.
ufw_https_open() {
    command -v ufw >/dev/null 2>&1 || return 1
    sudo -n ufw status 2>/dev/null | grep -q '443'
}

# Неинтерактивный прогон модуля. Всё, что спрашивает ввод, — НЕ сюда (MANUAL).
module_apply() {
    local name="$1"
    case "$name" in
        health-alert.sh|fix-fs-structure.sh)
            bash "$MODULES_DIR/$name" --install ;;
        samba-install.sh)
            # SAMBA_UPGRADE=1 — без паузы «запиши пароль» (иначе апгрейд зависает)
            SAMBA_UPGRADE=1 bash "$MODULES_DIR/$name" ;;
        firewall-setup.sh)
            local extra=""
            # Если у клиента уже открыт 443 (HTTPS/Cloudflare) — сохраняем этот режим
            if ufw_https_open; then extra="--https"; fi
            sudo bash "$MODULES_DIR/$name" $extra ;;
        *)
            bash "$MODULES_DIR/$name" ;;
    esac
}

# ────────────────────────────────────────────────────────────────────────────
# Состояние: «<sha256>|<имя>» — хеш ПРИМЕНЁННОГО файла модуля
# ────────────────────────────────────────────────────────────────────────────
state_get() {
    [ -f "$STATE_FILE" ] || return 1
    local line
    line=$(grep -F "|$1" "$STATE_FILE" 2>/dev/null | head -n1) || true
    [ -n "$line" ] || return 1
    printf '%s' "${line%%|*}"
}

state_set() {
    local hash="$1" name="$2"
    [ "$DRY_RUN" = true ] && return 0
    mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true
    local tmp
    tmp=$(mktemp) || return 1
    if [ -f "$STATE_FILE" ]; then
        grep -vF "|$name" "$STATE_FILE" > "$tmp" 2>/dev/null || true
    fi
    printf '%s|%s\n' "$hash" "$name" >> "$tmp"
    mv "$tmp" "$STATE_FILE"
}

# ────────────────────────────────────────────────────────────────────────────
# ОСНОВНОЙ ЦИКЛ
# ────────────────────────────────────────────────────────────────────────────
LIST="${ENSURE_MODULES:-$AUTO_MODULES $MANUAL_MODULES}"

FIRST_RUN=false
[ -f "$STATE_FILE" ] || FIRST_RUN=true

applied=0
manual=0
failed=0
unchanged=0

for name in $LIST; do
    f="$MODULES_DIR/$name"
    if [ ! -f "$f" ]; then
        log "${YELLOW}⚠️  $name: файл не найден в $MODULES_DIR — пропуск${NC}"
        continue
    fi

    cur=$(sha256sum "$f" 2>/dev/null | awk '{print $1}')
    if [ -z "$cur" ]; then
        log "${RED}❌ $name: не удалось посчитать хеш — пропуск${NC}"
        continue
    fi
    prev=$(state_get "$name" 2>/dev/null || true)

    # --calibrate: только фиксируем текущее состояние (вызывается из install.sh)
    if [ "$CALIBRATE" = true ]; then
        state_set "$cur" "$name"
        continue
    fi

    if [ "$prev" = "$cur" ] && [ "$FORCE" != true ]; then
        unchanged=$((unchanged + 1))
        continue
    fi

    if is_auto "$name"; then
        if ! module_applicable "$name"; then
            log "${BLUE}ℹ️  $name: на этом сервере не применяется (модуль не установлен) — пропуск${NC}"
            state_set "$cur" "$name"
            continue
        fi

        if [ "$DRY_RUN" = true ]; then
            log "${YELLOW}🔍 DRY: докатал бы $name${NC}"
            continue
        fi

        log "${BLUE}📦 Докатываю $name (код изменился со времени установки)...${NC}"
        if module_apply "$name" 2>&1 | sed 's/^/   /'; then
            state_set "$cur" "$name"
            log "${GREEN}✅ $name докатан${NC}"
            applied=$((applied + 1))
        else
            log "${RED}❌ $name упал при докатке — состояние НЕ обновлено, повторим в следующий раз${NC}"
            failed=$((failed + 1))
        fi
    else
        # MANUAL — интерактивный модуль: сами НЕ запускаем.
        if [ "$FIRST_RUN" = true ]; then
            # Первый прогон: что было применено — неизвестно. Молча калибруем,
            # чтобы не заваливать владельца «ложными» предупреждениями.
            state_set "$cur" "$name"
        elif [ "$DRY_RUN" = true ]; then
            log "${YELLOW}🔍 DRY: $name изменился — потребуется ручная докатка${NC}"
        else
            log "${YELLOW}⚠️  $name изменился — нужна РУЧНАЯ докатка (модуль интерактивный):${NC}"
            log "${YELLOW}      bash modules/$name${NC}"
            state_set "$cur" "$name"
            manual=$((manual + 1))
        fi
    fi
done

log "───────────────────────────────────────────────"
if [ "$CALIBRATE" = true ]; then
    log "${GREEN}✅ Состояние модулей откалибровано: $STATE_FILE${NC}"
elif [ "$FIRST_RUN" = true ] && [ "$DRY_RUN" = false ]; then
    log "${GREEN}✅ Первичная калибровка выполнена${NC} — автоматически докатано: $applied"
    log "   Дальше состояние сверяется по хешу файла модуля."
else
    log "Модули: докатано ${GREEN}$applied${NC}, требует ручной докатки ${YELLOW}$manual${NC}, ошибок ${RED}$failed${NC}, без изменений $unchanged"
fi
[ "$manual" -gt 0 ] && log "${YELLOW}⚠️  Команды для ручной докатки — выше в логе.${NC}"

[ "$failed" -gt 0 ] && exit 1
exit 0
