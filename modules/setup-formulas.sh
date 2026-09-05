#!/bin/bash
# ============================================================================
# modules/setup-formulas.sh v4.8.0 — Синхронизация секретов и URL в формулах
# ============================================================================
# Универсальная замена WEBHOOK_HOST и WEBHOOK_SECRET в кнопках NocoDB
# через безопасное копирование БД и Python-regex с lambda-функциями.
# ============================================================================
set -e

# Цвета для вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}🔧 Синхронизация формул NocoDB (v4.8.0)${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Загружаем переменные из .env.
# ⚠️ v4.28.5: НЕ используем `source .env` — он ломается на значениях с пробелами
# и звёздочками (cron: MORNING_CRON=0 10 * * * -> «.env: line N: 10: command not found»).
# Безопасный построчный парсер: снимает кавычки, игнорирует комментарии/пустые строки.
load_env() {
    local file="$1" key val
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
load_env .env

if [ -z "$WEBHOOK_SECRET" ]; then
    echo -e "${RED}❌ Ошибка: Не найден WEBHOOK_SECRET в .env${NC}"
    exit 1
fi

WEBHOOK_HOST=${WEBHOOK_HOST:-127.0.0.1}
TEMP_DB="/tmp/noco_sync_fix_$$.db"

# 🆕 v4.8.0: Гарантированная очистка временного файла при выходе (даже при ошибке)
trap 'sudo rm -f "$TEMP_DB" 2>/dev/null || true' EXIT

echo -e "   📡 Целевой WEBHOOK_HOST из .env: ${GREEN}$WEBHOOK_HOST${NC}"
echo -e "   🔑 Целевой SECRET из .env: ${GREEN}${WEBHOOK_SECRET:0:16}...${NC}"

if [[ "$WEBHOOK_HOST" == "127.0.0.1" || "$WEBHOOK_HOST" == "localhost" ]]; then
    echo ""
    echo -e "${YELLOW}⚠️  ВНИМАНИЕ: WEBHOOK_HOST установлен в 127.0.0.1${NC}"
    echo -e "${YELLOW}   Кнопки будут работать ТОЛЬКО если открывать NocoDB прямо на этом сервере.${NC}"
    echo -e "${YELLOW}   Для работы с других ПК измените WEBHOOK_HOST в .env на реальный IP и запустите скрипт снова.${NC}"
    echo ""
fi

# 🆕 v4.8.0: Динамический поиск имени контейнера NocoDB
NOCO_CONTAINER=$(sudo docker ps --filter "name=nocodb" --format '{{.Names}}' | head -n 1)

if [ -z "$NOCO_CONTAINER" ]; then
    echo -e "${RED}❌ Ошибка: Контейнер NocoDB не найден или не запущен!${NC}"
    echo -e "${YELLOW}💡 Запустите его командой: docker compose up -d nocodb${NC}"
    exit 1
fi

echo -e "   🐳 Найден контейнер NocoDB: ${GREEN}$NOCO_CONTAINER${NC}"
echo ""

# Запускаем Python-скрипт для безопасной замены через Regex + lambda
python3 << PYTHONEOF
import sqlite3
import subprocess
import os
import time
import re

WEBHOOK_HOST = "${WEBHOOK_HOST}"
WEBHOOK_SECRET = "${WEBHOOK_SECRET}"
TEMP_DB = "${TEMP_DB}"
NOCO_CONTAINER = "${NOCO_CONTAINER}"

print("   📥 Копирую базу из контейнера на хост...")
subprocess.run(f"sudo docker cp {NOCO_CONTAINER}:/usr/app/data/noco.db {TEMP_DB}", shell=True, check=True, capture_output=True)
subprocess.run(f"sudo chown $USER:$USER {TEMP_DB}", shell=True, check=True)

conn = sqlite3.connect(TEMP_DB)
cursor = conn.cursor()

# Получаем все кнопки с формулами
cursor.execute("SELECT id, label, formula, formula_raw, parsed_tree FROM nc_col_button_v2 WHERE formula IS NOT NULL")
buttons = cursor.fetchall()

print(f"   📊 Найдено кнопок с формулами: {len(buttons)}")
print("")

# Универсальные регулярные выражения для замены
# 1. Ищет http:// или https://, затем любой домен/IP (с дефисами и точками), затем опциональный порт
HOST_PATTERN = r'(https?://)[a-zA-Z0-9.\-]+(:\d+)?'
# 2. Ищет "secret=" и любые буквенно-цифровые символы (и подчеркивания) после него
SECRET_PATTERN = r'(secret=)[a-zA-Z0-9_]+'

# ВАЖНО: Используем lambda-функции вместо строк замены,
# чтобы избежать ошибок с интерпретацией \1, \2, когда WEBHOOK_HOST
# начинается с цифры (например, "100.78.251.51" → "\1100..." ломается)
def replace_host(match):
    protocol = match.group(1)  # http:// или https://
    port = match.group(2) or ''  # :3000 или пустая строка
    return protocol + WEBHOOK_HOST + port

def replace_secret(match):
    return 'secret=' + WEBHOOK_SECRET

updated_count = 0
changes_log = []

for btn_id, label, formula, formula_raw, parsed_tree in buttons:
    updated = False
    new_f = formula or ""
    new_fr = formula_raw or ""
    new_pt = parsed_tree or ""
    
    original_f = new_f
    
    # 1. Универсальная замена ХОСТА (сохраняет http/https и :порт)
    if re.search(HOST_PATTERN, new_f):
        new_f = re.sub(HOST_PATTERN, replace_host, new_f)
        updated = True
    if re.search(HOST_PATTERN, new_fr):
        new_fr = re.sub(HOST_PATTERN, replace_host, new_fr)
        updated = True
    if re.search(HOST_PATTERN, new_pt):
        new_pt = re.sub(HOST_PATTERN, replace_host, new_pt)
        updated = True
    
    # 2. Универсальная замена СЕКРЕТА (заменяет ЛЮБОЙ старый секрет на новый)
    if re.search(SECRET_PATTERN, new_f):
        new_f = re.sub(SECRET_PATTERN, replace_secret, new_f)
        updated = True
    if re.search(SECRET_PATTERN, new_fr):
        new_fr = re.sub(SECRET_PATTERN, replace_secret, new_fr)
        updated = True
    if re.search(SECRET_PATTERN, new_pt):
        new_pt = re.sub(SECRET_PATTERN, replace_secret, new_pt)
        updated = True
    
    # Если были изменения, обновляем запись в БД
    if updated:
        cursor.execute("""
            UPDATE nc_col_button_v2 
            SET formula = ?, formula_raw = ?, parsed_tree = ? 
            WHERE id = ?
        """, (new_f, new_fr, new_pt, btn_id))
        updated_count += 1
        
        changes_log.append({
            'label': label or 'Без имени',
            'old': original_f[:100] + '...' if len(original_f) > 100 else original_f,
            'new': new_f[:100] + '...' if len(new_f) > 100 else new_f
        })

conn.commit()
conn.close()

if updated_count > 0:
    print(f"   ✅ Успешно обновлено формул: {updated_count}")
    print("")
    print("   📝 Детали изменений:")
    for change in changes_log:
        print(f"      • [{change['label']}]")
        print(f"        Было: {change['old']}")
        print(f"        Стало: {change['new']}")
        print("")
    
    print("   📤 Копирую обновлённую базу обратно в контейнер...")
    subprocess.run(f"sudo docker cp {TEMP_DB} {NOCO_CONTAINER}:/usr/app/data/noco.db", shell=True, check=True, capture_output=True)
    
    print("   🔄 Перезапускаем NocoDB для сброса кэша метаданных...")
    subprocess.run(f"sudo docker restart {NOCO_CONTAINER}", shell=True, check=True, capture_output=True)
    
    print("   ⏳ Ожидаем полного запуска NocoDB (15 сек)...")
    time.sleep(15)
    print("   🎉 Синхронизация завершена!")
else:
    print("   ℹ️ Все формулы в базе уже актуальны. Обновлений не требуется.")
    print("   💡 Если кнопки всё ещё не работают, проверь, что WEBHOOK_HOST в .env")
    print("      отличается от того, что уже записано в базе.")

# Очистка временного файла внутри Python (дублирует trap bash для надёжности)
if os.path.exists(TEMP_DB):
    os.remove(TEMP_DB)

PYTHONEOF

echo ""
echo -e "${GREEN}✅ Готово! Формулы синхронизированы.${NC}"