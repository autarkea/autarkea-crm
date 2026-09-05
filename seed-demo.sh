#!/bin/bash
# ============================================================================
# seed-demo.sh — ДЕМО-ДАННЫЕ ДЛЯ ПЕСОЧНИЦЫ РАЗРАБОТЧИКА
#
# Наполняет рабочую базу (НЕ эталон!) демонстрационным сценарием:
# сотрудники (Менеджер/Исполнитель), физлица, юрлица, проекты с разными
# статусами, позиции заказа и задачи с привязками (связи — через junction).
#
# Использование:
#   ./seed-demo.sh                 # наполнить (откажется, если данные уже есть)
#   ./seed-demo.sh --reset         # снапшот + очистка бизнес-данных + заливка
#   ./seed-demo.sh /путь/к/noco.db # своя база (по умолчанию песочница)
#
# ⚠️ Это инструмент разработки: он НЕ предназначен для клиентских установок и
# не трогает template.db. Демо-сценарий заточен под структуру рабочей базы
# (имя таблицы «Позиции заказа» и префикс nc_nw7q___ могут отличаться).
# ============================================================================
set -euo pipefail

NOCO_DB=''
RESET=0
for a in "$@"; do
    case "$a" in
        --reset) RESET=1 ;;
        *) [ -z "$NOCO_DB" ] && NOCO_DB="$a" ;;
    esac
done
[ -z "$NOCO_DB" ] && NOCO_DB="${NOCO_DB_ENV:-/mnt/data/nocodb-data/noco.db}"

if [ ! -f "$NOCO_DB" ]; then
    echo "❌ База не найдена: $NOCO_DB"
    exit 1
fi

q() { sqlite3 -batch -cmd '.timeout 10000' "$NOCO_DB" "$1"; }
ins() { q "INSERT INTO $1 ($2) VALUES ($3); SELECT last_insert_rowid();"; }

DBDIR=$(dirname "$NOCO_DB")
NOW=$(date '+%Y-%m-%d %H:%M:%S')

# Таблицы. Идентификаторы без пробелов не кавычим; две таблицы с пробелом —
# храним УЖЕ в кавычках, чтобы спокойно подставлять в SQL-строки.
T_EMP='nc_nw7q___Сотрудники'
T_PROJ='nc_nw7q___Проекты'
T_CONT='nc_nw7q___Контакты'
T_LEG='nc_nw7q___Юрлица'
T_ITEM='"nc_nw7q___Позиции заказа"'
T_TASK='nc_nw7q___Дела'
J_PROJ_EMP='nc_nw7q___nc_m2m_Проекты_Сотрудники'
J_PROJ_CONT='nc_nw7q___nc_m2m_Проекты_Контакты'
J_PROJ_LEG='nc_nw7q___nc_m2m_Проекты_Юрлица'
J_PROJ_ITEM='"nc_nw7q___nc_m2m_Проекты_Позиции заказа"'
J_TASK_PROJ='nc_nw7q___nc_m2m_Дела_Проекты'
J_TASK_EXEC='nc_nw7q___nc_m2m_Дела_Сотрудники'
J_TASK_PROP='nc_nw7q___nc_m2m_Дела_Сотрудники1'
J_CONT_LEG='nc_nw7q___nc_m2m_Контакты_Юрлица'

check_tables() {
    for t in 'nc_nw7q___Сотрудники' 'nc_nw7q___Проекты' 'nc_nw7q___Контакты' 'nc_nw7q___Юрлица' 'nc_nw7q___Позиции заказа' 'nc_nw7q___Дела'; do
        q "SELECT 1 FROM sqlite_master WHERE type='table' AND name='$t' LIMIT 1;" | grep -q 1 \
            || { echo "❌ Таблица не найдена: $t (другая схема?)"; exit 1; }
    done
}

reset_data() {
    echo "🧹 Очистка бизнес-данных ($DBDIR)..."
    BAK="$DBDIR/noco-before-seed-$(date '+%Y%m%d_%H%M%S').db"
    cp "$NOCO_DB" "$BAK"
    echo "💾 Снапшот до очистки: $BAK"
    q "BEGIN;
DELETE FROM $J_TASK_PROP; DELETE FROM $J_TASK_EXEC; DELETE FROM $J_TASK_PROJ;
DELETE FROM $J_PROJ_EMP; DELETE FROM $J_PROJ_CONT; DELETE FROM $J_PROJ_LEG; DELETE FROM $J_PROJ_ITEM;
DELETE FROM $J_CONT_LEG;
DELETE FROM $T_TASK; DELETE FROM $T_ITEM; DELETE FROM $T_PROJ; DELETE FROM $T_LEG; DELETE FROM $T_CONT;
COMMIT;"
}

is_empty() {
    local c
    c=$(q "SELECT (SELECT COUNT(*) FROM $T_PROJ) + (SELECT COUNT(*) FROM $T_CONT) + (SELECT COUNT(*) FROM $T_TASK);")
    [ "$c" = "0" ]
}

check_tables
if [ "$RESET" = "1" ]; then
    reset_data
elif ! is_empty; then
    echo "⚠️ В базе уже есть бизнес-данные. Для полной перезаливки запусти: $0 --reset"
    echo "   (снапшот текущей базы будет сохранён рядом с ней)"
    exit 1
fi

# ============================================================================
# 1. СОТРУДНИКИ (существующего Руководителя не дублируем)
# ============================================================================
echo '👥 Сотрудники...'
ADMIN_ID=$(q "SELECT id FROM $T_EMP WHERE Роль='Руководитель' ORDER BY id LIMIT 1;")
if [ -z "$ADMIN_ID" ]; then
    ADMIN_ID=$(ins "$T_EMP" 'ФИО, Обращение, Роль, Должность, Активен, created_at, updated_at' "'Александр Геннадьевич','Александр','Руководитель','Директор',1,'$NOW','$NOW'")
fi
ANNA_ID=$(q "SELECT id FROM $T_EMP WHERE ФИО='Анна Смирнова' LIMIT 1;")
if [ -z "$ANNA_ID" ]; then
    ANNA_ID=$(ins "$T_EMP" 'ФИО, Обращение, Роль, Должность, Telegram_ID, Активен, created_at, updated_at' "'Анна Смирнова','Анна','Менеджер','Менеджер проектов',1000000001,1,'$NOW','$NOW'")
fi
IGOR_ID=$(q "SELECT id FROM $T_EMP WHERE ФИО='Игорь Ковалёв' LIMIT 1;")
if [ -z "$IGOR_ID" ]; then
    IGOR_ID=$(ins "$T_EMP" 'ФИО, Обращение, Роль, Должность, Telegram_ID, Активен, created_at, updated_at' "'Игорь Ковалёв','Игорь','Исполнитель','Инженер-печатник',1000000002,1,'$NOW','$NOW'")
fi
echo "   Руководитель=#$ADMIN_ID, Менеджер=#$ANNA_ID, Исполнитель=#$IGOR_ID"

# ============================================================================
# 2. ЮРЛИЦА
# ============================================================================
echo '🏢 Юрлица...'
FORMAT_ID=$(q "SELECT id FROM $T_LEG WHERE Краткое_Имя='ООО «Формат»' LIMIT 1;")
if [ -z "$FORMAT_ID" ]; then
    FORMAT_ID=$(ins "$T_LEG" 'Краткое_Имя, Имя, УНП, Телефон, E_mail, Адрес, Адрес_доставки, р_с, Банк, БИК, Client_ID, Договор_основания, created_at, updated_at' "'ООО «Формат»','Общество с ограниченной ответственностью «Формат»',192345678,'+375 17 256-78-90','info@format.by','г. Дзержинск, ул. Ленина 12, оф. 5','г. Дзержинск, ул. Ленина 12','BY20PJCB30123456780000000999','ОАО «Приорбанк»','PJCBBY2X','K-001','Договор №14 от 12.08.2026','$NOW','$NOW'")
fi
TECHNO_ID=$(q "SELECT id FROM $T_LEG WHERE Краткое_Имя='ООО «ТехноМир»' LIMIT 1;")
if [ -z "$TECHNO_ID" ]; then
    TECHNO_ID=$(ins "$T_LEG" 'Краткое_Имя, Имя, УНП, Телефон, E_mail, Адрес, Client_ID, created_at, updated_at' "'ООО «ТехноМир»','Общество с ограниченной ответственностью «ТехноМир»',198765432,'+375 17 390-12-45','sales@technomir.by','г. Минск, ул. Промышленная 3','K-002','$NOW','$NOW'")
fi
echo "   Формат=#$FORMAT_ID, ТехноМир=#$TECHNO_ID"

# ============================================================================
# 3. КОНТАКТЫ (физлица)
# ============================================================================
echo '👤 Контакты...'
IVAN_ID=$(q "SELECT id FROM $T_CONT WHERE Имя='Иван Петров' LIMIT 1;")
if [ -z "$IVAN_ID" ]; then
    IVAN_ID=$(ins "$T_CONT" 'Имя, Телефон, E_mail, Мессенджер, Ссылка, Обращение, Client_ID, Адрес, Доп__информация, created_at, updated_at' "'Иван Петров','+375 29 123-45-67','petrov@example.com','Telegram','@petrov','Иван','K-100','г. Дзержинск, ул. Садовая 7','Закупщик в «Формат». Прислал модель шестерёнок 02.09.','$NOW','$NOW'")
fi
MARIA_ID=$(q "SELECT id FROM $T_CONT WHERE Имя='Мария Козлова' LIMIT 1;")
if [ -z "$MARIA_ID" ]; then
    MARIA_ID=$(ins "$T_CONT" 'Имя, Телефон, E_mail, Мессенджер, Ссылка, Обращение, Client_ID, created_at, updated_at' "'Мария Козлова','+375 33 987-65-43','kozlovam@example.com','Viber','@maria_koz','Мария','K-101','$NOW','$NOW'")
fi
SERGEY_ID=$(q "SELECT id FROM $T_CONT WHERE Имя='Сергей Волков' LIMIT 1;")
if [ -z "$SERGEY_ID" ]; then
    SERGEY_ID=$(ins "$T_CONT" 'Имя, Телефон, Мессенджер, Обращение, Client_ID, created_at, updated_at' "'Сергей Волков','+375 29 555-44-33','WhatsApp','Сергей','K-102','$NOW','$NOW'")
fi
# Иван — контакт/представитель ООО «Формат»
q "INSERT OR IGNORE INTO $J_CONT_LEG (nc_nw7q___Юрлица_id, nc_nw7q___Контакты_id) VALUES ($FORMAT_ID, $IVAN_ID);"
echo "   Иван=#$IVAN_ID, Мария=#$MARIA_ID, Сергей=#$SERGEY_ID"

# ============================================================================
# 4. ПРОЕКТЫ + привязки (менеджер / клиент / юрлицо)
# ============================================================================
echo '📁 Проекты...'
add_project() { # name status deadline manager
    local name="$1" status="$2" deadline="$3" manager="$4" nm dl id
    nm=$(printf '%s' "$name" | sed "s/'/''/g")
    if [ -n "$deadline" ]; then dl="'$deadline'"; else dl='NULL'; fi
    id=$(q "SELECT id FROM $T_PROJ WHERE Что_делаем_ = '$nm' LIMIT 1;")
    if [ -z "$id" ]; then
        id=$(ins "$T_PROJ" 'Что_делаем_, Статус, Срок_проекта, Имя_для_документов, created_at, updated_at' "'$nm','$status',$dl,'$nm','$NOW','$NOW'")
    fi
    if [ -n "$manager" ]; then
        q "INSERT OR IGNORE INTO $J_PROJ_EMP (nc_nw7q___Сотрудники_id, nc_nw7q___Проекты_id) VALUES ($manager, $id);"
    fi
    echo "$id"
}
link_contact() { q "INSERT OR IGNORE INTO $J_PROJ_CONT (nc_nw7q___Контакты_id, nc_nw7q___Проекты_id) VALUES ($2, $1);"; }
link_legal()   { q "INSERT OR IGNORE INTO $J_PROJ_LEG (nc_nw7q___Юрлица_id, nc_nw7q___Проекты_id) VALUES ($2, $1);"; }

P1=$(add_project 'Печать шестерёнок из полиамида — 50 шт' 'В работе' '2026-09-18' "$ANNA_ID")
link_contact "$P1" "$IVAN_ID"
P2=$(add_project 'Корпус вентиляционной решётки — прототип' 'В работе' '2026-09-10' "$ANNA_ID")
link_legal "$P2" "$FORMAT_ID"; link_contact "$P2" "$IVAN_ID"
P3=$(add_project 'Брелоки с логотипом — партия 200 шт' 'Обсуждение' '2026-09-22' "$ADMIN_ID")
link_contact "$P3" "$MARIA_ID"
P4=$(add_project 'Деталь для ЧПУ по чертежу клиента' 'Обсуждение' '' "$ADMIN_ID")
link_contact "$P4" "$SERGEY_ID"
P5=$(add_project 'Корпусные детали для «ТехноМир» — 2 итерации' 'В работе' '2026-09-08' "$ANNA_ID")
link_legal "$P5" "$TECHNO_ID"
P6=$(add_project 'Партия сувениров «8 марта» — 30 шт' 'Готов к сдаче' '2026-09-05' "$ADMIN_ID")
link_contact "$P6" "$MARIA_ID"
P7=$(add_project 'Стенды для выставки (завершён)' 'Успех' '2026-08-20' "$ADMIN_ID")
link_contact "$P7" "$SERGEY_ID"
P8=$(add_project 'Эксперимент: печать гибким пластиком' 'Мимо' '2026-08-25' "$ANNA_ID")
link_contact "$P8" "$IVAN_ID"
echo "   Активные: #$P1 #$P2 #$P3 #$P4 #$P5 #$P6 | Архив: #$P7 #$P8"

# ============================================================================
# 5. ПОЗИЦИИ ЗАКАЗА + привязка к проекту
# ============================================================================
echo '💰 Позиции заказа...'
add_item() { # name qty price unit type project_id
    local item_id
    item_id=$(ins "$T_ITEM" 'Название, Кол_во, Цена, Ед__изм_, Тип, created_at, updated_at' "'$1',$2,$3,'$4','$5','$NOW','$NOW'")
    q "INSERT OR IGNORE INTO $J_PROJ_ITEM (\"nc_nw7q___Позиции заказа_id\", \"nc_nw7q___Проекты_id\") VALUES ($item_id, $6);"
}
add_item 'Печать шестерёнки PA12' 50 12.50 'шт.' 'Товар' "$P1"
add_item 'Подготовка модели к печати' 1 60.00 'шт.' 'Работа' "$P1"
add_item 'Печать корпуса (прототип)' 1 145.00 'шт.' 'Работа' "$P2"
add_item 'Печать детали «Корпус-2»' 18 45.00 'шт.' 'Товар' "$P5"
add_item 'Постобработка (шлифовка)' 18 8.00 'шт.' 'Работа' "$P5"
add_item 'Сувениры из PLA' 30 9.90 'шт.' 'Товар' "$P6"
add_item 'Печать стендов для выставки' 2 220.00 'шт.' 'Товар' "$P7"

# ============================================================================
# 6. ЗАДАЧИ + привязки (проект / исполнитель / кто предложил)
# ============================================================================
echo '📋 Задачи...'
add_task() { # title deadline project executor proposer done_mark ts_done
    local title="$1" deadline="$2" project="$3" executor="$4" proposer="$5" done_mark="$6" ts_done="$7"
    local nm dl done_part ts tid
    nm=$(printf '%s' "$title" | sed "s/'/''/g")
    if [ -n "$deadline" ]; then dl="'$deadline'"; else dl='NULL'; fi
    if [ "$done_mark" = "done" ]; then done_part="1"; else done_part="0"; fi
    if [ -n "$ts_done" ]; then ts="'$ts_done'"; else ts='NULL'; fi
    tid=$(ins "$T_TASK" 'Что_делаем_, Когда_делаем, Готово, Когда_сделали_, created_at, updated_at' "'$nm',$dl,$done_part,$ts,'$NOW','$NOW'")
    if [ -n "$project" ]; then q "INSERT OR IGNORE INTO $J_TASK_PROJ (nc_nw7q___Проекты_id, nc_nw7q___Дела_id) VALUES ($project, $tid);"; fi
    if [ -n "$executor" ]; then q "INSERT OR IGNORE INTO $J_TASK_EXEC (nc_nw7q___Сотрудники_id, nc_nw7q___Дела_id) VALUES ($executor, $tid);"; fi
    if [ -n "$proposer" ]; then q "INSERT OR IGNORE INTO $J_TASK_PROP (nc_nw7q___Сотрудники_id, nc_nw7q___Дела_id) VALUES ($proposer, $tid);"; fi
}
#                название                                    дедлайн               проект  испол.   предл.  готово  когда сделали
add_task 'Согласовать цвет PLA с заказчиком'                '2026-09-06 10:00:00' "$P3" "$ANNA_ID" "$IGOR_ID" '' ''
add_task 'Проверить модель шестерни на дефекты'             '2026-09-05 09:00:00' "$P1" "$IGOR_ID" '' '' ''
add_task 'Запустить печать партии шестерёнок'               '2026-09-04 11:00:00' "$P1" "$IGOR_ID" '' '' ''
add_task 'Отправить прототип на проверку заказчику'         '2026-09-03 12:00:00' "$P2" "$IGOR_ID" '' done '2026-09-03 16:00:00'
add_task 'Снять замеры корпуса решётки'                     '2026-09-09 14:00:00' "$P2" "$ANNA_ID" '' '' ''
add_task 'Подготовить коммерческое по брелокам'             '2026-09-05 18:00:00' "$P3" "$ANNA_ID" "$IGOR_ID" '' ''
add_task 'Проверить эскиз детали с клиентом'                '2026-09-03 18:00:00' "$P4" "$IGOR_ID" '' '' ''
add_task 'Запустить печать деталей «ТехноМир»'             '2026-09-07 09:00:00' "$P5" "$IGOR_ID" '' '' ''
add_task 'Проверить качество после печати'                  '2026-09-08 10:00:00' "$P5" "$IGOR_ID" '' '' ''
add_task 'Упаковать сувениры к 8 марта'                     '2026-09-05 12:00:00' "$P6" "$IGOR_ID" '' done '2026-09-04 09:30:00'
add_task 'Созвон с заказчиком по статусу проекта'           '2026-09-06 15:00:00' "$P4" "$ANNA_ID" '' '' ''
add_task 'Перенести макет в формат STL'                     ''                    "$P4" "$IGOR_ID" '' done '2026-09-02 11:00:00'
add_task 'Разобрать рабочий стол и склад filament'          ''                    '' "$IGOR_ID" '' '' ''

# ============================================================================
# 7. ИТОГ
# ============================================================================
echo
echo '✅ Демо-данные залиты:'
q "SELECT '👥 Сотрудники: ' || COUNT(*) FROM $T_EMP UNION ALL
   SELECT '🏢 Юрлица: ' || COUNT(*) FROM $T_LEG UNION ALL
   SELECT '👤 Контакты: ' || COUNT(*) FROM $T_CONT UNION ALL
   SELECT '📁 Проекты: ' || COUNT(*) FROM $T_PROJ UNION ALL
   SELECT '💰 Позиции: ' || COUNT(*) FROM $T_ITEM UNION ALL
   SELECT '📋 Задачи: ' || COUNT(*) FROM $T_TASK;"
