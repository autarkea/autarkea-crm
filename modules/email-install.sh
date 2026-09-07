#!/bin/bash
# ============================================================================
# Printed4U CRM - Модуль настройки Email (SMTP)
# Версия: 1.1.3 (v4.34.3) — идемпотентная запись SMTP_* + опциональный рестарт
# ============================================================================
# Изменения v1.1.3:
# - SMTP_HOST/PORT/USER/PASS/FROM/SECURE/REJECT_UNAUTHORIZED пишутся через общую
#   идиому set_or_append: строка есть → замена, нет → дозапись. Раньше sed
#   обновлял ТОЛЬКО существующие строки — на старом .env без SMTP_HOST и др.
#   переменные молча не появлялись, а «✅ настройка завершена» ничего не меняла.
# - В конце модуля (если тестовое письмо не отправлялось) — вопрос «перезапустить
#   контейнер бота сейчас? (y/N)»: .env обновлён, но контейнер читает env при
#   старте. При запуске из install.sh финальный compose up -d перезапустит сам.
# ============================================================================
# Изменения v1.1.0:
# - Умный выбор протокола (SSL/TLS 465 vs STARTTLS 587) для кастомного сервера
# - Поддержка self-signed сертификатов (cPanel, Let's Encrypt)
# - Тестовая отправка с опцией игнорирования ошибок сертификата
# - Чёткие инструкции для cPanel-хостингов (hoster.by, activeby и др.)
#
# Изменения v1.1.1:
# - FIX (Проблема 105): перезапуск бота шёл по container_name (printed4u-bot) вместо
#   имени сервиса (bot) → docker compose падал «no such service» и молча глотал ошибку.
#   Имя сервиса вычисляется из docker-compose.yml, при неудаче — честное предупреждение.
#
# Изменения v1.1.2:
# - FIX (Проблема 107): гарантия перевода строки в конце .env ДО дозаписи SMTP_SECURE/
#   SMTP_REJECT_UNAUTHORIZED — иначе дозапись склеивается с последней строкой .env,
#   и docker compose падает («unable to find group 1000BACKUP_RETENTION_LOCAL=7»).
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

echo -e "${BLUE}═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║   📧 Настройка Email-отправки (SMTP) v1.1.3            ║${NC}"
echo -e "${BLUE}║   Поддержка cPanel, self-signed сертификатов           ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# ============================================================================
# ШАГ 0: Проверка наличия .env
# ============================================================================
if [ ! -f ".env" ]; then
    echo -e "${RED}❌ Файл .env не найден!${NC}"
    echo -e "${YELLOW}💡 Запусти сначала install.sh${NC}"
    exit 1
fi

# ============================================================================
# ШАГ 1: Пропустить настройку?
# ============================================================================
echo -e "${YELLOW}ℹ️  Email-отправка нужна для отправки PDF-документов клиентам.${NC}"
echo -e "${YELLOW}   Если не настроишь сейчас — сможешь сделать позже:${NC}"
echo -e "${CYAN}   bash modules/email-install.sh${NC}"
echo ""
read -p "Настроить email сейчас? (y/n, по умолчанию y): " setup_now
setup_now=${setup_now:-y}

if [[ "$setup_now" != "y" && "$setup_now" != "Y" ]]; then
    echo -e "${GREEN}✅ Пропускаем настройку email. CRM будет работать без отправки.${NC}"
    exit 0
fi

# ============================================================================
# ШАГ 2: Выбор SMTP-провайдера
# ============================================================================
echo ""
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "${MAGENTA}📬 Выбери почтового провайдера:${NC}"
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}1) Gmail (Google Workspace)${NC}"
echo -e "${BLUE}2) Яндекс.Почта (для бизнеса или личная)${NC}"
echo -e "${BLUE}3) Mail.ru / VK Работа${NC}"
echo -e "${BLUE}4) Outlook / Office 365${NC}"
echo -e "${BLUE}5) Свой SMTP-сервер (cPanel, корпоративный, hoster.by)${NC}"
echo ""
read -p "Выбери вариант (1-5, по умолчанию 1): " provider
provider=${provider:-1}

case "$provider" in
    1)
        PROVIDER_NAME="Gmail"
        DEFAULT_HOST="smtp.gmail.com"
        DEFAULT_PORT="465"
        SMTP_SECURE="true"
        REJECT_UNAUTHORIZED="true"
        INSTRUCTIONS="
📘 Gmail — инструкция по получению пароля приложения:

1. Зайди в аккаунт Google: https://myaccount.google.com/
2. Перейди в 'Безопасность' → '2-этапная аутентификация'
   ⚠️  ДВУХЭТАПКА ДОЛЖНА БЫТЬ ВКЛЮЧЕНА!
3. В поиске по настройкам введи: 'Пароли приложений'
4. Создай новый пароль:
   - Название: 'Printed4U CRM'
   - Приложение: 'Почта'
   - Устройство: 'Другое'
5. Скопируй 16-значный пароль (например: 'abcd efgh ijkl mnop')
   ВАЖНО: вводи БЕЗ ПРОБЕЛОВ!

❗ Обычный пароль от Google НЕ ПОДОЙДЁТ — только App Password!
"
        ;;
    2)
        PROVIDER_NAME="Yandex"
        DEFAULT_HOST="smtp.yandex.ru"
        DEFAULT_PORT="465"
        SMTP_SECURE="true"
        REJECT_UNAUTHORIZED="true"
        INSTRUCTIONS="
📘 Яндекс.Почта — настройка пароля приложения:

1. Зайди: https://id.yandex.ru/security
2. 'Пароли и авторизация' → 'Пароли приложений'
3. Создай новый пароль:
   - Тип: 'Почта'
   - Название: 'Printed4U CRM'
4. Скопируй пароль и используй его вместо обычного

❗ Для yandex.ru / yandex.com / yandex.by — один и тот же SMTP-хост!
"
        ;;
    3)
        PROVIDER_NAME="Mail.ru"
        DEFAULT_HOST="smtp.mail.ru"
        DEFAULT_PORT="465"
        SMTP_SECURE="true"
        REJECT_UNAUTHORIZED="true"
        INSTRUCTIONS="
📘 Mail.ru — настройка внешнего пароля:

1. Зайди: https://id.mail.ru/security
2. 'Внешние приложения' → 'Добавить'
3. Выбери 'Mail.ru Почта' и создай пароль
4. Используй этот пароль в SMTP

❗ Работает для всех доменов: mail.ru, list.ru, inbox.ru, bk.ru
"
        ;;
    4)
        PROVIDER_NAME="Outlook"
        DEFAULT_HOST="smtp-mail.outlook.com"
        DEFAULT_PORT="587"
        SMTP_SECURE="false"
        REJECT_UNAUTHORIZED="true"
        INSTRUCTIONS="
📘 Outlook / Office 365:

1. Зайди: https://account.microsoft.com/security
2. 'Расширенные параметры безопасности'
3. 'Создать пароль приложения'

⚠️  Для корпоративного Office 365 SMTP может быть заблокирован
    администратором — уточни у IT-отдела.
"
        ;;
    5)
        PROVIDER_NAME="Custom (cPanel/corporate)"
        DEFAULT_HOST=""
        DEFAULT_PORT=""
        SMTP_SECURE=""
        REJECT_UNAUTHORIZED="false"  # 🆕 Для cPanel часто self-signed сертификат
        INSTRUCTIONS="
📘 Свой SMTP-сервер (cPanel, корпоративный, hoster.by):

Типичные настройки для белорусских хостингов:
• hoster.by / activeby / cPanel:
  - Host: mail.ваш-домен.by (например: mail.printed4u.by)
  - Port: 465 (SSL/TLS) — рекомендуется
  - Port: 587 (STARTTLS) — альтернатива
  - Username: полный email (например: info@printed4u.by)
  - Password: пароль от почтового ящика

⚠️  Где взять настройки?
  1. Зайди в cPanel (обычно https://ваш-домен.by:2083)
  2. Раздел 'Электронная почта' → 'Учётные записи'
  3. Нажми 'Подключить устройства' (Connect Devices)
  4. Скопируй данные из раздела 'Secure SSL/TLS Settings'

💡 Совет: для cPanel обычно работает порт 465 (SSL).
💡 Для self-signed сертификатов (часто в cPanel) система
   автоматически включит опцию 'игнорировать ошибки сертификата'.
"
        ;;
    *)
        echo -e "${RED}❌ Неверный выбор${NC}"
        exit 1
        ;;
esac

echo -e "$INSTRUCTIONS"
echo -e "${YELLOW}═══════════════════════════════════════════════════════════${NC}"
read -p "Прочитал инструкцию? Нажми Enter для продолжения..."

# ============================================================================
# ШАГ 3: Ввод данных SMTP
# ============================================================================
echo ""
echo -e "${BLUE}🔧 Введи данные SMTP (Enter = значение по умолчанию):${NC}"
echo ""

# SMTP Host
if [ "$provider" == "5" ]; then
    echo -e "${YELLOW}💡 Для cPanel обычно: mail.ваш-домен.by${NC}"
    read -p "SMTP Host: " smtp_host
    while [ -z "$smtp_host" ]; do
        echo -e "${RED}❌ SMTP Host обязателен для кастомного сервера!${NC}"
        read -p "SMTP Host: " smtp_host
    done
else
    read -p "SMTP Host [$DEFAULT_HOST]: " smtp_host
    smtp_host=${smtp_host:-$DEFAULT_HOST}
fi

# SMTP Port + Protocol
if [ "$provider" == "5" ]; then
    echo ""
    echo -e "${YELLOW}🔐 Выбери тип соединения:${NC}"
    echo -e "${BLUE}1) SSL/TLS на порту 465 (рекомендуется для cPanel)${NC}"
    echo -e "${BLUE}2) STARTTLS на порту 587 (альтернатива)${NC}"
    read -p "Выбери (1/2, по умолчанию 1): " protocol_choice
    protocol_choice=${protocol_choice:-1}
    
    if [[ "$protocol_choice" == "2" ]]; then
        smtp_port="587"
        SMTP_SECURE="false"
        echo -e "${GREEN}✅ Выбрано: STARTTLS на порту 587${NC}"
    else
        smtp_port="465"
        SMTP_SECURE="true"
        echo -e "${GREEN}✅ Выбрано: SSL/TLS на порту 465${NC}"
    fi
else
    read -p "SMTP Port [$DEFAULT_PORT]: " smtp_port
    smtp_port=${smtp_port:-$DEFAULT_PORT}
fi

# SMTP User (обычно это email)
read -p "SMTP User (email для авторизации): " smtp_user
while [ -z "$smtp_user" ]; do
    echo -e "${RED}❌ SMTP User обязателен!${NC}"
    read -p "SMTP User (email): " smtp_user
done

# SMTP Password
read -s -p "SMTP Password (не показывается): " smtp_pass
echo ""
while [ -z "$smtp_pass" ]; do
    echo -e "${RED}❌ SMTP Password обязателен!${NC}"
    read -s -p "SMTP Password: " smtp_pass
    echo ""
done

# SMTP From (от чьего имени отправлять)
echo ""
echo -e "${YELLOW}💡 SMTP From — email, который увидит клиент в поле 'От кого'${NC}"
echo -e "${YELLOW}   Обычно совпадает с SMTP User${NC}"
read -p "SMTP From [$smtp_user]: " smtp_from
smtp_from=${smtp_from:-$smtp_user}

# ============================================================================
# ШАГ 4: Подтверждение данных
# ============================================================================
echo ""
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "${MAGENTA}📋 Проверь введённые данные:${NC}"
echo -e "${MAGENTA}═══════════════════════════════════════════════════════════${NC}"
echo -e "  Провайдер:   ${CYAN}$PROVIDER_NAME${NC}"
echo -e "  Host:        ${CYAN}$smtp_host${NC}"
echo -e "  Port:        ${CYAN}$smtp_port${NC}"
echo -e "  Протокол:    ${CYAN}$(if $SMTP_SECURE; then echo 'SSL/TLS'; else echo 'STARTTLS'; fi)${NC}"
echo -e "  User:        ${CYAN}$smtp_user${NC}"
echo -e "  Password:    ${CYAN}********${NC}"
echo -e "  From:        ${CYAN}$smtp_from${NC}"
if [ "$provider" == "5" ]; then
    echo -e "  Сертификат:  ${YELLOW}Игнорировать self-signed (рекомендуется для cPanel)${NC}"
fi
echo ""
read -p "Всё верно? (y/n, по умолчанию y): " confirm
confirm=${confirm:-y}

if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo -e "${YELLOW}⚠️  Прервано. Запусти скрипт заново.${NC}"
    exit 0
fi

# ============================================================================
# ШАГ 5: Сохранение в .env
# ============================================================================
echo -e "${BLUE}💾 Сохраняю настройки в .env...${NC}"

# ═══════════════════════════════════════════════════════════════════════════
# v1.1.3: единая идиома set_or_append — значение пишется и когда строка уже
# есть в .env (замена), и когда её нет (дозапись с гарантией перевода строки,
# Проблема 107). Раньше SMTP_* обновлялись ТОЛЬКО sed-заменой существующих
# строк: на старом .env без SMTP_HOST/SMTP_PORT/... переменные молча не
# появлялись, и модуль «успешно завершался» без реального результата.
# ═══════════════════════════════════════════════════════════════════════════
set_or_append() {
    local key="$1" value="$2" file="$3"
    if grep -q "^${key}=" "$file"; then
        sed -i "s|^${key}=.*|${key}=${value}|" "$file"
    else
        # Проблема 107: перевод строки в конце .env ДО дозаписи (иначе строки склеиваются)
        [ -n "$(tail -c1 "$file")" ] && echo "" >> "$file"
        echo "${key}=${value}" >> "$file"
    fi
}

# Экранируем спецсимволы в пароле для sed
smtp_pass_escaped=$(printf '%s\n' "$smtp_pass" | sed -e 's/[\/&]/\\&/g')

set_or_append "SMTP_HOST"                 "$smtp_host"                  ".env"
set_or_append "SMTP_PORT"                 "$smtp_port"                  ".env"
set_or_append "SMTP_USER"                 "$smtp_user"                  ".env"
set_or_append "SMTP_PASS"                 "$smtp_pass_escaped"          ".env"
set_or_append "SMTP_FROM"                 "$smtp_from"                  ".env"
set_or_append "SMTP_SECURE"               "$SMTP_SECURE"                ".env"
set_or_append "SMTP_REJECT_UNAUTHORIZED"  "$REJECT_UNAUTHORIZED"        ".env"

echo -e "${GREEN}✅ Настройки сохранены в .env${NC}"

# ============================================================================
# ШАГ 6: Тестовая отправка (опционально)
# ============================================================================
echo ""
echo -e "${BLUE}📤 Хотите отправить тестовое письмо?${NC}"
echo -e "${YELLOW}   Укажи свой email для проверки:${NC}"
read -p "Email для теста (Enter = пропустить): " test_email

if [ ! -z "$test_email" ]; then
    # Проблема 105: docker compose принимает имя СЕРВИСА (bot), а не container_name (printed4u-bot)
    BOT_SERVICE=$(awk '/^  [A-Za-z0-9_-]+:/{svc=$1; sub(":","",svc)} /container_name: printed4u-bot/{print svc; exit}' docker-compose.yml 2>/dev/null)
    BOT_SERVICE="${BOT_SERVICE:-bot}"
    echo -e "${BLUE}🔄 Перезапускаю контейнер бота ($BOT_SERVICE)...${NC}"
    if docker compose up -d --build "$BOT_SERVICE" 2>/dev/null; then
        echo -e "${GREEN}✅ Контейнер бота перезапущен${NC}"
    else
        echo -e "${YELLOW}⚠️  Не удалось перезапустить бот автоматически.${NC}"
        echo -e "${YELLOW}   Сделай вручную: docker compose up -d --build $BOT_SERVICE${NC}"
    fi
    sleep 5
    
    echo -e "${BLUE}📧 Отправляю тестовое письмо на $test_email...${NC}"
    
    # Создаём временный Node.js скрипт для отправки теста
    cat > /tmp/test-email.js << 'EOF'
const nodemailer = require('nodemailer');

// 🆕 v1.1.0: Поддержка self-signed сертификатов
const rejectUnauthorized = process.env.SMTP_REJECT_UNAUTHORIZED !== 'false';

const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    },
    // 🆕 Для cPanel/self-signed: игнорируем ошибки сертификата
    tls: {
        rejectUnauthorized: rejectUnauthorized,
        minVersion: 'TLSv1.2'
    }
});

async function sendTest() {
    try {
        console.log(`🔌 Подключение к ${process.env.SMTP_HOST}:${process.env.SMTP_PORT}`);
        console.log(`🔐 SSL: ${process.env.SMTP_SECURE === 'true' ? 'SSL/TLS' : 'STARTTLS'}`);
        console.log(`🔒 Проверка сертификата: ${rejectUnauthorized ? 'СТРОГАЯ' : 'ОТКЛЮЧЕНА (для cPanel)'}`);
        
        const info = await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: process.argv[2],
            subject: '✅ Printed4U CRM - тест email-отправки',
            html: `
                <div style="font-family: 'Segoe UI', sans-serif; padding: 20px;">
                    <h2 style="color: #2c5282;">🎉 Email-отправка работает!</h2>
                    <p>Если ты получил это письмо — настройки SMTP корректны.</p>
                    <hr style="margin: 20px 0;">
                    <p style="color: #666; font-size: 13px;">
                        <b>Хост:</b> ${process.env.SMTP_HOST}<br>
                        <b>Порт:</b> ${process.env.SMTP_PORT}<br>
                        <b>Протокол:</b> ${process.env.SMTP_SECURE === 'true' ? 'SSL/TLS' : 'STARTTLS'}<br>
                        <b>От:</b> ${process.env.SMTP_FROM}
                    </p>
                </div>
            `
        });
        console.log('✅ Письмо отправлено! Message ID:', info.messageId);
        process.exit(0);
    } catch (err) {
        console.error('❌ Ошибка отправки:', err.message);
        if (err.code === 'ECONNREFUSED') {
            console.error('💡 Сервер не отвечает. Проверь Host и Port.');
        } else if (err.code === 'EAUTH') {
            console.error('💡 Ошибка авторизации. Проверь User/Password.');
        } else if (err.code === 'CERT_HAS_EXPIRED' || err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
            console.error('💡 Ошибка сертификата. Попробуй SMTP_REJECT_UNAUTHORIZED=false в .env');
        } else if (err.code === 'ETIMEDOUT') {
            console.error('💡 Таймаут. Проверь брандмауэр и доступность порта.');
        }
        process.exit(1);
    }
}

sendTest();
EOF

    # Копируем в контейнер и запускаем
    docker cp /tmp/test-email.js printed4u-bot:/app/test-email.js 2>/dev/null || true
    TEST_RESULT=$(docker exec -e SMTP_HOST="$smtp_host" \
                           -e SMTP_PORT="$smtp_port" \
                           -e SMTP_USER="$smtp_user" \
                           -e SMTP_PASS="$smtp_pass" \
                           -e SMTP_FROM="$smtp_from" \
                           -e SMTP_SECURE="$SMTP_SECURE" \
                           -e SMTP_REJECT_UNAUTHORIZED="$REJECT_UNAUTHORIZED" \
                           printed4u-bot node /app/test-email.js "$test_email" 2>&1) || true
    
    echo "$TEST_RESULT"
    
    if [[ "$TEST_RESULT" == *"Message ID"* ]]; then
        echo -e "${GREEN}✅ Тестовое письмо успешно отправлено!${NC}"
        echo -e "${YELLOW}📬 Проверь почту: $test_email (включая папку 'Спам')${NC}"
    else
        echo -e "${RED}❌ Не удалось отправить тестовое письмо${NC}"
        echo -e "${YELLOW}💡 Возможные причины:${NC}"
        echo -e "   1. Неверный пароль (для Gmail/Yandex нужен App Password)${NC}"
        echo -e "   2. Заблокирован порт $smtp_port (проверь брандмауэр)${NC}"
        echo -e "   3. Self-signed сертификат (для cPanel попробуй ещё раз с опцией игнорирования)${NC}"
        echo -e "${YELLOW}💡 Попробуй позже: bash modules/email-install.sh${NC}"
    fi
    
    rm -f /tmp/test-email.js
fi

# ============================================================================
# ШАГ 7: Применение SMTP в контейнере (v1.1.3)
# .env обновлён, но контейнер бота читает переменные окружения при СТАРТЕ.
# Если тестовое письмо не отправлялось — контейнер ещё со старыми SMTP_*,
# а модуль уже напечатал «✅ Настройка завершена» (тихая ловушка «из коробки»).
# При запуске из install.sh контейнеры перезапустятся сами в конце установки.
# ============================================================================
if [ -z "$test_email" ]; then
    echo ""
    echo -e "${BLUE}🔄 SMTP сохранён в .env, но контейнер бота работает со старыми переменными.${NC}"
    echo -e "${YELLOW}   (при установке через install.sh контейнеры перезапустятся сами)${NC}"
    read -p "Перезапустить контейнер бота сейчас, чтобы применить SMTP? (y/N): " restart_now
    if [[ "$restart_now" == "y" || "$restart_now" == "Y" ]]; then
        BOT_SERVICE=$(awk '/^  [A-Za-z0-9_-]+:/{svc=$1; sub(":","",svc)} /container_name: printed4u-bot/{print svc; exit}' docker-compose.yml 2>/dev/null)
        BOT_SERVICE="${BOT_SERVICE:-bot}"
        echo -e "${BLUE}🔄 Перезапускаю контейнер бота ($BOT_SERVICE)...${NC}"
        if docker compose up -d --build "$BOT_SERVICE" 2>&1; then
            echo -e "${GREEN}✅ Контейнер бота перезапущен с новыми SMTP_*${NC}"
        else
            echo -e "${YELLOW}⚠️  Не удалось перезапустить автоматически. Сделай вручную:${NC}"
            echo -e "${YELLOW}   docker compose up -d --build $BOT_SERVICE${NC}"
        fi
    else
        echo -e "${YELLOW}ℹ️  SMTP применится при следующем перезапуске контейнеров:${NC}"
        echo -e "${YELLOW}   docker compose up -d --build${NC}"
    fi
fi
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Настройка Email завершена!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "   Провайдер:   ${CYAN}$PROVIDER_NAME${NC}"
echo -e "   От кого:     ${CYAN}$smtp_from${NC}"
echo -e "   Хост:        ${CYAN}$smtp_host:$smtp_port${NC}"
echo ""
echo -e "${YELLOW}💡 Теперь при отправке счёта/акта из бота — он придёт клиенту на почту.${NC}"
echo -e "${YELLOW}   Reply-To и BCC будут идти на email менеджера (если указан в проекте).${NC}"
echo ""
echo -e "${YELLOW}📋 Полезные переменные окружения (добавлены в .env):${NC}"
echo -e "   SMTP_HOST=$smtp_host"
echo -e "   SMTP_PORT=$smtp_port"
echo -e "   SMTP_SECURE=$SMTP_SECURE"
echo -e "   SMTP_REJECT_UNAUTHORIZED=$REJECT_UNAUTHORIZED"
echo ""