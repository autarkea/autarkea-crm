#!/bin/bash
# ============================================================================
# Printed4U CRM - Модуль установки и настройки Samba (v2.0.2)
# ============================================================================
# Назначение: Безопасный сетевой доступ к папкам проектов и клиентов из Windows.
# ============================================================================
# 🆕 v2.0.2: ФИКС — pdbedit/smbpasswd падали с "Can't load /etc/samba/smb.conf"
#            на чистой системе: пароль ставился ДО создания smb.conf.
#            Теперь минимальный smb.conf создаётся перед установкой пароля
#            (полный конфиг генерируется позже, Шаг 5/6).
# ============================================================================
# 🆕 v2.0.1: ФИКС ПОРЯДКА УСТАНОВКИ (Проблема: на чистой системе smbpasswd/pdbedit
#            отсутствуют, пока samba не установлена. Раньше пароль ставился ДО
#            установки пакетов → скрипт падал на шаге smbpasswd).
#            Теперь пакеты ставятся В САМОМ НАЧАЛЕ, до создания smbuser.
# ============================================================================
# 🆕 v2.0.0: ЗАЩИТА ФАЙЛОВОЙ СИСТЕМЫ (защита от "кривых рук"):
# - Отдельный системный пользователь smbuser (НЕ владелец данных)
# - Каркас projects/clients + Документы: 0755 (только чтение для SMB)
# - Папки "Рабочие": 0775 (запись через Samba работает!)
# - force user = smbuser: SMB-клиент не может переименовать/удалить папки
# - Автогенерация пароля Samba (один раз показан на экране — "из коробки")
# - veto files для Windows-мусора + hide unreadable
# ============================================================================
# Сохранено из v1.2.3:
# - ОДНА шара "printed4u-crm" с двумя папками внутри: projects и clients
# - Папка backups НАМЕРЕННО скрыта от сетевого доступа
# - Поддержка кириллицы и симлинков
# - Правильные Windows-пути с двойными обратными слэшами (\\)
# - Динамический выбор основного пути (приоритет у Tailscale)
# - Фикс Проблемы 67 — проверка и создание /etc/samba/
# - Валидация конфига через testparm перед перезапуском
# ============================================================================
set -e

# Цвета
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   Printed4U CRM - Настройка Samba (Сетевые папки)      ║${NC}"
echo -e "${BLUE}║   Версия: v2.0.2 (Защита файловой системы)             ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# 1. Определение текущего пользователя и его UID/GID
CURRENT_USER=$(whoami)
CURRENT_UID=$(id -u)
CURRENT_GID=$(id -g)

echo -e "${BLUE}👤 Текущий пользователь: ${CURRENT_USER} (UID: ${CURRENT_UID}, GID: ${CURRENT_GID})${NC}"
echo ""

# ============================================================================
# ⚠️ v2.0.1: УСТАНОВКА ПАКЕТОВ SAMBA — В САМОМ НАЧАЛЕ!
# На чистой системе smbpasswd/pdbedit отсутствуют, пока samba не установлена.
# Поэтому пароль (см. ниже) можно ставить ТОЛЬКО после установки пакетов.
# ============================================================================
echo -e "${BLUE}📦 Установка пакетов Samba (нужны до создания пароля)...${NC}"
if ! command -v smbd &> /dev/null; then
    echo -e "${YELLOW}⚠️  Samba не установлена. Устанавливаю...${NC}"
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq samba smbclient
    echo -e "${GREEN}✅ Samba установлена${NC}"
else
    echo -e "${GREEN}✅ Samba уже установлена${NC}"
fi
echo ""

# ============================================================================
# 🆕 v2.0.0: ПРОВЕРКА ПРЕДВАРИТЕЛЬНЫХ УСЛОВИЙ
# ============================================================================
echo -e "${BLUE}🔍 Предварительная проверка структуры данных...${NC}"

if [ ! -d "/mnt/data/projects" ]; then
    echo -e "${YELLOW}⚠️  Папка /mnt/data/projects не найдена. Создаю...${NC}"
    sudo mkdir -p /mnt/data/projects
    sudo chown ${CURRENT_UID}:${CURRENT_GID} /mnt/data/projects
fi

if [ ! -d "/mnt/data/clients" ]; then
    echo -e "${YELLOW}⚠️  Папка /mnt/data/clients не найдена. Создаю...${NC}"
    sudo mkdir -p /mnt/data/clients
    sudo chown ${CURRENT_UID}:${CURRENT_GID} /mnt/data/clients
fi

# 🆕 v2.0.0: Принудительно выставляем безопасные права на каркас
# 0755 = владелец пишет (вебхук), остальные только читают (SMB не может переименовать)
sudo chmod 0755 /mnt/data/projects
sudo chmod 0755 /mnt/data/clients
sudo chown ${CURRENT_UID}:${CURRENT_GID} /mnt/data/projects /mnt/data/clients

# 🆕 v2.0.0: Приводим существующие папки проектов к безопасной схеме
# (каркас проекта и "Документы" — только чтение, "Рабочие" — запись для группы)
if [ -d "/mnt/data/projects" ]; then
    for proj_dir in /mnt/data/projects/*/; do
        [ -d "$proj_dir" ] || continue
        sudo chown ${CURRENT_UID}:${CURRENT_GID} "$proj_dir" || true
        sudo chmod 0755 "$proj_dir" || true
        if [ -d "$proj_dir/Рабочие" ]; then
            sudo chown ${CURRENT_UID}:${CURRENT_GID} "$proj_dir/Рабочие" || true
            sudo chmod 0775 "$proj_dir/Рабочие" || true
        fi
        if [ -d "$proj_dir/Документы" ]; then
            sudo chown ${CURRENT_UID}:${CURRENT_GID} "$proj_dir/Документы" || true
            sudo chmod 0755 "$proj_dir/Документы" || true
        fi
    done
fi

# 🆕 v2.0.0: То же для папок клиентов
if [ -d "/mnt/data/clients" ]; then
    for client_dir in /mnt/data/clients/*/; do
        [ -d "$client_dir" ] || continue
        sudo chown ${CURRENT_UID}:${CURRENT_GID} "$client_dir" || true
        sudo chmod 0755 "$client_dir" || true
    done
fi

echo -e "${GREEN}✅ Структура данных проверена и приведена к безопасной схеме прав${NC}"
echo ""

# ============================================================================
# 🆕 v2.0.0: СОЗДАНИЕ ОТДЕЛЬНОГО ПОЛЬЗОВАТЕЛЯ SMBUSER
# ============================================================================
echo -e "${BLUE}👤 Создание отдельного пользователя smbuser для Samba...${NC}"
SMB_USER="smbuser"

if id "$SMB_USER" &>/dev/null; then
    echo -e "${GREEN}✅ Пользователь $SMB_USER уже существует${NC}"
else
    sudo useradd -M -s /usr/sbin/nologin "$SMB_USER"
    echo -e "${GREEN}✅ Создан системный пользователь $SMB_USER (без входа в систему)${NC}"
fi

# Добавляем smbuser во вторичную группу данных (по имени группы!)
# Это даёт доступ через group-права: 0775 (Рабочие) = rwx для группы
DATA_GROUP=$(getent group $CURRENT_GID | cut -d: -f1)
if [ -z "$DATA_GROUP" ]; then
    # Если группа не найдена по GID (редкий случай) — используем имя пользователя
    DATA_GROUP="$CURRENT_USER"
fi

if ! id -nG "$SMB_USER" | grep -qw "$DATA_GROUP"; then
    sudo usermod -aG "$DATA_GROUP" "$SMB_USER"
    echo -e "${GREEN}✅ $SMB_USER добавлен в группу данных '$DATA_GROUP' (GID=$CURRENT_GID) — доступ к «Рабочим»${NC}"
else
    echo -e "${GREEN}✅ $SMB_USER уже в группе данных '$DATA_GROUP'${NC}"
fi
echo ""

# ============================================================================
# 🆕 v2.0.0: АВТОГЕНЕРАЦИЯ ПАРОЛЯ SAMBA (ИЗ КОРОБКИ)
# ============================================================================
echo -e "${BLUE}🔐 Настройка пароля Samba для пользователя $SMB_USER...${NC}"

# ⚠️ v2.0.2: pdbedit/smbpasswd НЕ работают без существующего /etc/samba/smb.conf
# ("Can't load /etc/samba/smb.conf - run testparm to debug it").
# Создаём каталог и минимальный конфиг ЗАРАНЕЕ — Шаг 5/6 перезапишет полным.
sudo mkdir -p /etc/samba
if [ ! -f /etc/samba/smb.conf ]; then
    echo -e "${YELLOW}⚠️  /etc/samba/smb.conf отсутствует — создаю минимальный (для pdbedit)${NC}"
    sudo tee /etc/samba/smb.conf > /dev/null <<'EOF'
[global]
   workgroup = WORKGROUP
   security = user
EOF
fi

# Если пароль уже установлен — не перезапрашиваем (повторный запуск модуля)
if sudo pdbedit -L 2>/dev/null | grep -q "^${SMB_USER}:"; then
    echo -e "${GREEN}✅ Пароль для $SMB_USER уже установлен ранее${NC}"
    SMB_PASS="(уже установлен)"
else
    # Генерируем надёжный пароль (буквы+цифры, без спецсимволов для удобства ввода)
    SMB_PASS=$(openssl rand -base64 12 | tr -d '/+=' | head -c 14)
    
    # Передаём пароль в smbpasswd через stdin
    if printf '%s\n%s\n' "$SMB_PASS" "$SMB_PASS" | sudo smbpasswd -s -a "$SMB_USER"; then
        echo -e "${GREEN}✅ Пароль установлен автоматически${NC}"
    else
        echo -e "${RED}❌ Не удалось установить пароль автоматически${NC}"
        echo -e "${YELLOW}💡 Установи вручную: sudo smbpasswd $SMB_USER${NC}"
        exit 1
    fi
    
    sudo smbpasswd -e "$SMB_USER"
    PASSWORD_SHOWN=true
fi
echo ""

# ============================================================================
# ШАГ 1: Проверка установки Samba (сами пакеты поставлены выше, v2.0.1)
# ============================================================================
echo -e "${BLUE}📦 Шаг 1/6: Проверка установки Samba...${NC}"
if command -v smbd &> /dev/null; then
    echo -e "${GREEN}✅ Samba установлена: $(smbd --version 2>/dev/null | head -1 || echo 'smbd')${NC}"
else
    echo -e "${RED}❌ Samba не установлена! Смотри вывод выше (apt).${NC}"
    exit 1
fi
echo ""

# ============================================================================
# 🆕 v1.2.3: ПРОВЕРКА И СОЗДАНИЕ /etc/samba/ (Проблема 67)
# ============================================================================
echo -e "${BLUE}🔧 Шаг 2/6: Проверка конфигурационной директории Samba...${NC}"

if [ ! -d "/etc/samba" ]; then
    echo -e "${YELLOW}⚠️  Папка /etc/samba/ не найдена. Создаю...${NC}"
    sudo mkdir -p /etc/samba
    sudo chown root:root /etc/samba
    sudo chmod 755 /etc/samba
    echo -e "${GREEN}✅ Папка /etc/samba/ создана${NC}"
else
    echo -e "${GREEN}✅ Папка /etc/samba/ существует${NC}"
fi

if [ ! -f "/etc/samba/smb.conf" ]; then
    echo -e "${YELLOW}⚠️  Файл /etc/samba/smb.conf не найден. Создаю пустой...${NC}"
    sudo touch /etc/samba/smb.conf
    sudo chown root:root /etc/samba/smb.conf
    sudo chmod 644 /etc/samba/smb.conf
    echo -e "${GREEN}✅ Создан пустой /etc/samba/smb.conf${NC}"
else
    echo -e "${GREEN}✅ Файл /etc/samba/smb.conf существует${NC}"
fi
echo ""

# ============================================================================
# ШАГ 3: Создание структуры папок для шары
# ============================================================================
echo -e "${BLUE}📁 Шаг 3/6: Создание структуры папок для шары...${NC}"
SHARED_DIR="/mnt/data/shared"
sudo mkdir -p "$SHARED_DIR"

if [ ! -L "$SHARED_DIR/projects" ]; then
    sudo ln -s /mnt/data/projects "$SHARED_DIR/projects"
    echo -e "${GREEN}✅ Создан симлинк: $SHARED_DIR/projects → /mnt/data/projects${NC}"
else
    echo -e "${YELLOW}⏭️  Симлинк projects уже существует${NC}"
fi

if [ ! -L "$SHARED_DIR/clients" ]; then
    sudo ln -s /mnt/data/clients "$SHARED_DIR/clients"
    echo -e "${GREEN}✅ Создан симлинк: $SHARED_DIR/clients → /mnt/data/clients${NC}"
else
    echo -e "${YELLOW}⏭️  Симлинк clients уже существует${NC}"
fi

# 🆕 v2.0.0: Права на шару — 755 (родитель), симлинки читаются всеми
sudo chown ${CURRENT_UID}:${CURRENT_GID} "$SHARED_DIR"
sudo chmod 0755 "$SHARED_DIR"
echo -e "${GREEN}✅ Права на шару установлены (0755, владелец: ${CURRENT_USER})${NC}"
echo ""

# ============================================================================
# ШАГ 4: Резервное копирование существующей конфигурации
# ============================================================================
echo -e "${BLUE}💾 Шаг 4/6: Резервное копирование конфигурации...${NC}"
if [ -f /etc/samba/smb.conf ] && [ -s /etc/samba/smb.conf ]; then
    BACKUP_FILE="/etc/samba/smb.conf.backup.$(date +%F_%H%M%S)"
    sudo cp /etc/samba/smb.conf "$BACKUP_FILE"
    echo -e "${GREEN}✅ Резервная копия создана: $BACKUP_FILE${NC}"
else
    echo -e "${YELLOW}ℹ️  Существующий конфиг пуст или отсутствует — пропускаю бэкап${NC}"
fi
echo ""

# ============================================================================
# ШАГ 5: Генерация новой конфигурации smb.conf (v2.0.0)
# ============================================================================
echo -e "${BLUE}⚙️  Шаг 5/6: Генерация конфигурации Samba...${NC}"

# 🆕 v2.0.0: force user = smbuser (отдельная личность, не владелец данных!)
# 🔒 Каркас 0755 → smbuser может читать, но НЕ переименовывать папки
# 🔒 Документы 0755 → только чтение PDF
# ✅ Рабочие 0775 → smbuser (в группе данных) может писать файлы
sudo tee /etc/samba/smb.conf > /dev/null <<EOF
[global]
   workgroup = WORKGROUP
   server string = Printed4U CRM Server
   security = user
   map to guest = bad user

   # 🔑 v2.0.0: Все сетевые действия выполняются от smbuser (не владельца данных)
   force user = ${SMB_USER}
   force group = ${CURRENT_USER}

   # 🔤 Корректная работа с кириллицей (Windows + Linux)
   unix charset = UTF-8
   dos charset = CP866
   mangled names = no

   # 🔗 Поддержка симлинков (критично для структуры папок клиентов CRM)
   wide links = yes
   follow symlinks = yes
   unix extensions = no

   # 🛡️ Безопасность и логи
   logging = file
   max log size = 1000
   panic action = /usr/share/samba/panic-action %d

# ----------------------------------------------------------------------
# ШАРА (SHARE)
# Одна шара "printed4u-crm" с двумя папками внутри: projects и clients
# Мы намеренно НЕ расшариваем /mnt/data/nocodb-data и /mnt/data/backups,
# чтобы предотвратить повреждение базы или удаление бэкапов из Windows.
# ----------------------------------------------------------------------

[printed4u-crm]
   comment = Printed4U CRM - Проекты и Клиенты
   path = ${SHARED_DIR}
   browseable = yes
   read only = no
   guest ok = no
   valid users = ${SMB_USER}
   create mask = 0664
   directory mask = 0775
   force create mode = 0664
   force directory mode = 0775

   # 🆕 v2.0.0: Прячем системный мусор Windows и Mac
   veto files = /Thumbs.db/desktop.ini/.DS_Store/
   delete veto files = no

   # 🆕 v2.0.0: read-only папки подсвечиваются в проводнике
   hide unreadable = yes
EOF

echo -e "${GREEN}✅ Конфигурация /etc/samba/smb.conf обновлена${NC}"
echo ""

# ============================================================================
# 🆕 v1.2.3: ВАЛИДАЦИЯ КОНФИГА ЧЕРЕЗ TESTPARM
# ============================================================================
echo -e "${BLUE}🔍 Валидация конфигурации через testparm...${NC}"
if command -v testparm &> /dev/null; then
    if sudo testparm -s > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Конфигурация валидна${NC}"
    else
        echo -e "${RED}❌ Ошибка в конфигурации smb.conf!${NC}"
        echo -e "${YELLOW}💡 Проверь вывод: sudo testparm${NC}"
        echo -e "${YELLOW}   Бэкап конфига: $BACKUP_FILE${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}⚠️  testparm не найден, пропускаю валидацию${NC}"
fi
echo ""

# ============================================================================
# ШАГ 6: Завершение (пароль уже установлен на предыдущем этапе)
# ============================================================================
echo -e "${BLUE}🔄 Перезапуск служб Samba...${NC}"
sudo systemctl enable smbd nmbd 2>/dev/null || true
sudo systemctl restart smbd nmbd
echo -e "${GREEN}✅ Службы Samba перезапущены${NC}"

sleep 2
if systemctl is-active --quiet smbd; then
    echo -e "${GREEN}✅ Служба smbd активна${NC}"
else
    echo -e "${RED}❌ Служба smbd НЕ запустилась! Проверь: sudo systemctl status smbd${NC}"
    exit 1
fi

if command -v ufw &> /dev/null; then
    if sudo ufw status | grep -q "Status: active"; then
        echo -e "${BLUE}🛡️  Брандмауэр UFW активен. Добавляю правила для Samba...${NC}"
        sudo ufw allow Samba
        echo -e "${GREEN}✅ Правила UFW обновлены${NC}"
    fi
fi

# ============================================================================
# ФИНАЛЬНОЕ СООБЩЕНИЕ С ПАУЗОЙ И ПОЛНОЙ ИНФОРМАЦИЕЙ
# ============================================================================
echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   🎉 Настройка Samba завершена успешно!                   ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Умно определяем, какой IP показать пользователю
TS_IP=$(ip -4 addr show tailscale0 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n 1)
LOCAL_IP=$(hostname -I | awk '{print $1}')

if [ -n "$TS_IP" ]; then
    TS_PATH="\\\\${TS_IP}\\printed4u-crm"
    LOCAL_PATH="\\\\${LOCAL_IP}\\printed4u-crm"
    PRIMARY_PATH="$TS_PATH"
else
    LOCAL_PATH="\\\\${LOCAL_IP}\\printed4u-crm"
    PRIMARY_PATH="$LOCAL_PATH"
fi

echo -e "${BLUE}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   📂 ДАННЫЕ ДЛЯ ПОДКЛЮЧЕНИЯ ИЗ WINDOWS                    ║${NC}"
echo -e "${BLUE}╠═══════════════════════════════════════════════════════════╣${NC}"

if [ -n "$TS_IP" ]; then
    echo -e "${BLUE}║                                                           ║${NC}"
    echo -e "${BLUE}║   🦎 Через Tailscale (из любой точки мира):              ║${NC}"
    echo -e "${YELLOW}║   Путь: ${TS_PATH}${NC}"
    echo -e "${BLUE}║                                                           ║${NC}"
    echo -e "${BLUE}║   🌐 Через локальную сеть (если ты дома/в офисе):        ║${NC}"
    echo -e "${YELLOW}║   Путь: ${LOCAL_PATH}${NC}"
else
    echo -e "${BLUE}║   🌐 Подключение по локальной сети:                      ║${NC}"
    echo -e "${YELLOW}║   Путь: ${LOCAL_PATH}${NC}"
fi

echo -e "${BLUE}║                                                           ║${NC}"
echo -e "${BLUE}║   👤 Логин:  ${GREEN}${SMB_USER}${NC}"
if [ "$PASSWORD_SHOWN" = true ]; then
    echo -e "${BLUE}║   🔐 Пароль: ${GREEN}${SMB_PASS}${NC}"
    echo -e "${BLUE}║   ⚠️  ЗАПИШИ ЕГО СЕЙЧАС — больше не покажем!            ║${NC}"
else
    echo -e "${BLUE}║   🔐 Пароль: ${GREEN}(уже установлен ранее)${NC}"
    echo -e "${BLUE}║   💡 Сменить: sudo smbpasswd ${SMB_USER}${NC}"
fi
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${BLUE}💡 Как подключиться из Windows:${NC}"
echo -e "   1. Откройте Проводник (Win+E)"
echo -e "   2. Нажмите ${GREEN}Ctrl+K${NC} (или 'Подключить сетевой диск' в меню)"
echo -e "   3. Вставьте путь: ${GREEN}${PRIMARY_PATH}${NC}"
echo -e "   4. Введите логин и пароль (см. выше)"
echo -e "   5. Поставьте галочку 'Восстанавливать при входе в систему'"
echo ""

echo -e "${GREEN}🔒 Напоминание о правах (v2.0.0):${NC}"
echo -e "   ✅ Папка «Рабочие» — можно класть и редактировать файлы (stl, доки)"
echo -e "   🔒 Папки проектов/клиентов и «Документы» — только чтение"
echo -e "   🔒 Переименовать/удалить папку проекта из Windows — НЕВОЗМОЖНО"
echo ""

if [ "$PASSWORD_SHOWN" = true ]; then
    # Пауза, чтобы пользователь успел записать данные
    read -p "📝 Запиши данные для подключения (путь, логин, пароль), затем нажми Enter для продолжения..." _
fi

echo ""
echo -e "${GREEN}✅ Продолжаем...${NC}"