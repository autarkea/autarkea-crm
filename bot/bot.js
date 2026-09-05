require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const axios = require('axios');
const config = require('./config');
// Реестр callback_data — им пользуется ЕДИНЫЙ диспетчер callback_query (см. низ файла).
const { matchCallbackBlock, isAdminOnlyCallback, isManagerOnlyCallback, isDocsSendOnlyCallback } = require('./routes');
// Единый клиент NocoDB (Data API v1): чтения с кешем и записи с инвалидацией.
// Чистый модуль (shared/noco.js) — тесты без сети: tests/noco.test.js.
const { createNocoClient } = require('./shared/noco');
const textUtil = require('./shared/text');
const dates = require('./shared/dates');
const noco = createNocoClient({ axios, baseUrl: config.NOCO_URL, baseId: config.BASE_ID, token: config.NOCO_TOKEN });

// ================== WEBHOOK (project-webhook, контейнер printed4u-webhook) ==================
// Единый адрес внутренних вызовов бота (Проблема 91). Раньше URL захардкодивался в 8 местах:
// при смене хоста можно было рассинхронизировать половину вызовов. WEBHOOK_URL можно
// переопределить через .env, если архитектура клиента отличается от docker-сети.
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'http://printed4u-webhook:3001';

// ================== ПАГИНАЦИЯ (полная выборка всех строк) ==================
// Реализация переехала в shared/noco.js (клиент + кеш списков + инвалидация).
// Обёртка сохранена, чтобы не менять ~15 мест вызова. Кешированная версия:
// noco.fetchAllRowsCached(tableName, { extraParams, ttlMs }).
async function fetchAllRows(tableName, pageSize = 100, extraParams = '') {
    return noco.fetchAllRows(tableName, pageSize, extraParams);
}

// ================== КЕШ СПИСКОВ ЗАДАЧ (v4.43.1, скорость пагинации) ==================
// Перелистывание списков (Все задачи / На сегодня / История / Мои задачи / задачи проекта)
// на каждый клик делало ПОЛНУЮ выборку задач из NocoDB. Короткий кеш снимает нагрузку,
// а инвалидация после КАЖДОЙ мутации задачи (создание/закрытие/срок/исполнитель/заявка)
// не даёт списку «залипать»: после действия бот перерисовывает список свежими данными.
// Прямые правки из NocoDB UI видны в списках максимум через TTL (6 сек) — «горячих»
// строк в пагинации нет, а выигрыш на повторных кликах — порядок величины.
const TASK_LIST_CACHE_TTL_MS = 6000;
let taskListCache = { ts: 0, rows: null };

async function fetchTasksForListCached() {
    const now = Date.now();
    if (taskListCache.rows && now - taskListCache.ts < TASK_LIST_CACHE_TTL_MS) {
        return taskListCache.rows;
    }
    const rows = await noco.fetchAllRows(config.TABLES.TASKS);
    taskListCache = { ts: now, rows };
    return rows;
}

function invalidateTaskListCache() {
    taskListCache = { ts: 0, rows: null };
}

// ================== КЛАВИАТУРА ВЫБОРА МЕССЕНДЖЕРА ==================
// Строится из config.MESSENGERS (единый источник правды в config.js).
// Добавлять/убирать способы связи — ТОЛЬКО в config.js, здесь не трогать.
// Значения колбэков: messenger_{name} (например messenger_WhatsApp).
function messengerKeyboard() {
    const buttons = config.MESSENGERS.map(m => ({ text: `${m.icon} ${m.name}`, callback_data: `messenger_${m.name}` }));
    buttons.push({ text: '⏭️ Пропустить', callback_data: 'messenger_skip' });
    return pairRow(buttons);
}

// ================== РОЛЕВАЯ МОДЕЛЬ ==================
const ROLES = {
    ADMIN: 'Руководитель',
    MANAGER: 'Менеджер',
    EXECUTOR: 'Исполнитель'
};

// v4.28.0: правила ролей вынесены в shared/roles.js (чистые функции) — их тестирует
// tests/roles.test.js. Здесь — только тонкие обёртки над кэшем сотрудников.
// Менять права — ТОЛЬКО в shared/roles.js, иначе тест укажет на расхождение.
// ⚠️ ВАЖНО: путь './shared/roles' — потому что в контейнере bot.js лежит в КОРНЕ /app,
// а shared монтируется в /app/shared (Dockerfile сплющивает bot/* в /app).
// '../shared/roles' (как на хосте из папки bot/) в контейнере указывает на /shared — мимо!
const roles = require('./shared/roles');

// v4.29.0: per-chat сессии — состояние каждого пользователя (визарды, черновики)
// хранится в Map<chatId, session>, а не в глобальных переменных. Чистые функции —
// shared/session.js (тесты: tests/session.test.js). Здесь — только тонкие обёртки.
const sessionMod = require('./shared/session');
const { getSession, resetSession, cleanupStaleSessions, cleanupIdleSessions } = sessionMod;

// v4.37.0: единый расчёт НДС (сводка карточки проекта) — те же формулы,
// что в bot/server.js (форма отправки email). Менять формулы — только здесь.
const vat = require('./shared/vat');

// v4.38.0: единые компараторы сортировки списков. fetchAllRows() отдаёт строки
// БЕЗ sort (порядок = Id asc = «старые сверху») — при росте базы рабочие списки
// показывают на стр.1 старьё, а в лентах свежее прячется в хвосте. Гибрид:
// задачи — по сроку, проекты — по этапу и сроку, ленты — свежие сверху,
// справочники — алфавит. Сортировать ТОЛЬКО этим модулем (см. документацию).
const sorters = require('./shared/sorting');

// v4.46.0 (Проблема 117): watchdog Telegram-поллинга. Чистая логика решения
// «завис ли поллинг» — shared/watchdog.js (тесты: tests/watchdog.test.js).
// Здесь — только «сердцебиение» (lastIncomingUpdateAt) и реакция (рестарт).
const pollWatchdog = require('./shared/watchdog');

// 🆕 v4.17.0: Статусы проекта. Должны совпадать с вариантами Select «Статус»
// в таблице «Проекты» NocoDB (см. документацию, раздел «Статусы проекта»).
// «Успех»/«Мимо» — терминальные: формула «Активно» делает проект «Неактивно».
const PROJECT_STATUSES = ['Обсуждение', 'В работе', 'Готов к сдаче', 'Успех', 'Мимо'];
// Статусы, при которых проект НЕ попадает в «Активные проекты»
const PROJECT_INACTIVE_STATUSES = new Set(['Успех', 'Мимо']);

// 🆕 v4.10.0: Синхронный кэш сотрудников (Map с полными данными)
// 🆕 Кэш отправленных уведомлений о задачах (taskId → telegramId)
const notifiedTasks = new Set();

const employeesCache = new Map();
// v4.27.2 (Проблема 93): деактивированный сотрудник («Активен» снят) не должен получать
// уведомления/напоминания и фигурировать в назначениях (аутсорсеры, временные курьеры и т.п.).
// Пустое значение (галочка не заполнена) = считаем активным — чтобы фикс не «потерял» старых
// сотрудников, у которых поле не проставлено.
function isEmployeeActive(emp) {
    const v = emp['Активен'];
    return v !== false && v !== 0 && v !== '0' && v !== 'false';
}
async function loadAllowedUsers() {
    try {
        const prevCache = new Map(employeesCache);
        const response = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.EMPLOYEES}?limit=1000`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        employeesCache.clear();
        if (response.data && response.data.list) {
            response.data.list.forEach(emp => {
                if (emp['Telegram_ID'] && isEmployeeActive(emp)) {
                    employeesCache.set(Number(emp['Telegram_ID']), {
                        Id: emp.Id,
                        Имя: emp['ФИО'] || 'Коллега',
                        Обращение: emp['Обращение'] || emp['ФИО'] || 'Коллега',
                        Роль: emp['Роль'] || ROLES.EXECUTOR,
                        Должность: emp['Должность'] || '',
                        // v4.42.0: флаг «Отправка документов» (модель прав «внутри/наружу»).
                        // Хранится в кэше, чтобы roles.canSendDocuments работал без доп. запросов.
                        [roles.DOCS_FLAG_FIELD]: emp[roles.DOCS_FLAG_FIELD]
                    });
                }
            });
        }
        console.log(`✅ Кэш сотрудников обновлён: ${employeesCache.size} сотрудников`);

        // 🆕 Проверяем новые задачи для исполнителей
        // Горячий путь (раз в 60 сек): нужны ТОЛЬКО задачи, созданные за последние 2 минуты.
        // sort=-CreatedAt + limit=100 гарантирует их наличие без полной выборки таблицы.
        try {
            const tasksRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}?limit=100&sort=-CreatedAt`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const activeTasks = tasksRes.data.list.filter(t => !t['Готово'] && t['Исполнитель']);

            for (const [tgId, emp] of employeesCache.entries()) {
                const myTasks = activeTasks.filter(t => t['Исполнитель']?.Id === emp.Id);
                for (const task of myTasks) {
                    const key = `${task.Id}_${tgId}`;
                    if (!notifiedTasks.has(key)) {
                        // Проверяем что задача создана недавно (последние 2 минуты)
                        const created = task['CreatedAt'] ? new Date(task['CreatedAt']) : null;
                        const ageMin = created ? (Date.now() - created.getTime()) / 60000 : 999;
                        if (ageMin < 2) {
                            notifiedTasks.add(key);
                            const projectRef = task['Какой проект'] ? ` (проект: ${task['Какой проект']['Что делаем?']})` : '';
                            bot.sendMessage(Number(tgId),
                                `📋 *Тебе назначена задача #${task.Id}*${projectRef}\n\n📝 ${task['Что делаем?']}\n${task['Когда делаем'] ? '📅 ' + formatMinskDate(task['Когда делаем']) : '⏰ Без срока'}\n\nНажми «Мои задачи» чтобы увидеть все.`,
                                { parse_mode: 'Markdown' }
                            ).catch(() => {});
                        } else {
                            // Старая задача — просто отмечаем как увиденную
                            notifiedTasks.add(key);
                        }
                    }
                }
            }
        } catch (e) { console.log('⚠️ Ошибка проверки уведомлений:', e.message); }
    } catch (error) {
        console.error('❌ Ошибка загрузки кэша:', error.message);
    }
}
loadAllowedUsers();
setInterval(loadAllowedUsers, 60 * 1000);
function isAllowed(telegramId) {
    return employeesCache.has(Number(telegramId));
}
function getEmployee(telegramId) {
    return employeesCache.get(Number(telegramId)) || null;
}

// ================== ХЕЛПЕРЫ РОЛЕЙ (обёртки над shared/roles.js) ==================
function isAdmin(telegramId) {
    return roles.isAdminRole(getEmployee(telegramId));
}
function isManager(telegramId) {
    return roles.isManagerRole(getEmployee(telegramId));
}
function canCreateTask(telegramId) {
    return roles.canCreateTask(getEmployee(telegramId)); // Руководитель и Менеджер
}
function canCreateProject(telegramId) {
    return roles.canCreateProject(getEmployee(telegramId));
}
function canSeeBackups(telegramId) {
    return roles.canSeeBackups(getEmployee(telegramId));
}
function canSeeStatus(telegramId) {
    return roles.canSeeStatus(getEmployee(telegramId));
}
function canSeeContacts(telegramId) {
    return roles.canSeeContacts(getEmployee(telegramId)); // Руководитель + Менеджер
}
function canSeeProjects(telegramId) {
    return roles.canSeeProjects(getEmployee(telegramId));
}
function canSuggestTask(telegramId) {
    return roles.canSuggestTask(getEmployee(telegramId));
}
function canSendPDF(telegramId) {
    return roles.canSendPDF(getEmployee(telegramId));
}
// v4.42.0: «выстрел наружу» — отправка документов клиенту, статусы «Отправлен»,
// оплаты. Руководитель — всегда, Менеджер — по флагу «Отправка документов».
function canSendDocuments(telegramId) {
    return roles.canSendDocuments(getEmployee(telegramId));
}

// v4.27.0 (Проблема 92): Telegram ID Руководителя из кэша сотрудников.
// TELEGRAM_USER_ID устарел и удалён из .env → config.MY_ID = NaN — «владельца» теперь
// даёт только таблица «Сотрудники» (Роль = Руководитель). Fallback на config.MY_ID,
// если он вдруг число, на случай пустого кэша на самом старте.
function getAdminTgId() {
    for (const [tid, e] of employeesCache.entries()) {
        if (e.Роль === ROLES.ADMIN) return Number(tid);
    }
    return Number.isFinite(config.MY_ID) ? config.MY_ID : null;
}


const STATE = {
    IDLE: 'idle',
    WAITING_TITLE: 'waiting_title',
    WAITING_DEADLINE: 'waiting_deadline',
    WAITING_PROJECT: 'waiting_project',
    WAITING_CONTACT_NAME: 'waiting_contact_name',
    WAITING_CONTACT_PHONE: 'waiting_contact_phone',
    WAITING_CONTACT_USERNAME: 'waiting_contact_username',
    WAITING_CONTACT_EMAIL: 'waiting_contact_email',
    WAITING_CONTACT_MESSENGER: 'waiting_contact_messenger',
    WAITING_PROJECT_TITLE: 'waiting_project_title',
    WAITING_PROJECT_CONTACT: 'waiting_project_contact',
    WAITING_PROJECT_TASK: 'waiting_project_task',
    WAITING_CONTACT_SEARCH: 'waiting_contact_search',
    WAITING_PROJECT_LEGAL_SEARCH: 'waiting_project_legal_search',
    WAITING_EDIT_TITLE: 'waiting_edit_title',
    WAITING_EDIT_DEADLINE: 'waiting_edit_deadline',
    WAITING_SUGGEST_TASK: 'waiting_suggest_task',
    WAITING_ASSIGN_EXECUTOR: 'waiting_assign_executor',
    WAITING_EXECUTOR: 'waiting_executor',
    WAITING_APPEND_TASK: 'waiting_append_task',
    WAITING_COMMENT_TEXT: 'waiting_comment_text',
    WAITING_FILE_TASK: 'waiting_file_task',
    WAITING_FILE_UPLOAD: 'waiting_file_upload',
    WAITING_CREATE_FOLDER: 'waiting_create_folder',
    WAITING_SHOW_FILES: 'waiting_show_files',
    IN_SUBMENU: 'in_submenu',
    WAITING_LEGAL_NAME: 'waiting_legal_name',
    WAITING_LEGAL_EMAIL: 'waiting_legal_email',
    WAITING_LEGAL_PHONE: 'waiting_legal_phone',
    WAITING_PROJECT_NOTE: 'waiting_project_note',
    WAITING_PROJECT_DEADLINE: 'waiting_project_deadline',
    // v4.42.1: визард позиции заказа («📝 Позиции» в карточке проекта)
    WAITING_ITEM_TYPE: 'waiting_item_type',       // выбор типа (кнопки)
    WAITING_ITEM_NAME: 'waiting_item_name',       // ввод названия (text)
    WAITING_ITEM_UNIT: 'waiting_item_unit',       // выбор единицы (кнопки)
    WAITING_ITEM_PRICE: 'waiting_item_price',     // ввод цены (text, платные типы)
    WAITING_ITEM_QTY: 'waiting_item_qty',         // ввод кол-ва (text, дефолт 1)
    WAITING_ITEM_CONFIRM: 'waiting_item_confirm', // превью → «Сохранить/Отмена»
    WAITING_ITEM_EDIT: 'waiting_item_edit',       // правка цены/кол-ва существующей позиции
    // v4.42.2: ввод примечания к документу (визард «📄 Новый документ»)
    WAITING_DOC_NOTE: 'waiting_doc_note',
    // v4.42.4: ввод суммы поступившей оплаты («💵 Внести оплату»)
    WAITING_PAYMENT_AMOUNT: 'waiting_payment_amount',
    // v4.43.0: ввод нового значения поля карточки контакта/юрлица («✏️ Изменить»)
    WAITING_EDIT_VALUE: 'waiting_edit_value',
    // v4.43.0: поиск юрлица для привязки к контакту («🏢 Привязать юрлицо» в карточке контакта)
    WAITING_ORG_SEARCH: 'waiting_org_search'
};

// v4.29.0: состояние ВСЕХ визардов бота (создание задачи/проекта/контакта/юрлица,
// forward-флоу) перенесено из глобальных переменных (currentState, taskDraft,
// contactDraft, projectDraft, legalDraft, pendingContactAction) в ПЕР-ЧАТ СЕССИИ.
// Проблема глобалов: два сотрудника, заполняющие формы одновременно, затирали
// состояние друг друга (см. документацию, раздел «Архитектура доступа», v4.29.0).
// Теперь у каждого чата своя сессия; работать надо ТОЛЬКО через неё:
//   const sess = getSession(sessions, chatId);   // взять сессию чата
//   sess.state = STATE.WAITING_TITLE;            // вместо currentState = ...
//   sess.taskDraft.title = '...';                // вместо taskDraft.title = ...
//   resetSession(sessions, chatId);              // вместо resetState()
// Структура сессии и дефолты — в shared/session.js (тесты: tests/session.test.js).
const sessions = new Map();

const bot = new TelegramBot(config.TOKEN, { polling: true });

// ================== WATCHDOG ПОЛЛИНГА (v4.46.0, Проблема 117) ==================
// Клиентский кейс (05.09.2026): одиночный «EFATAL: read ECONNRESET» → следующий
// getUpdates «завис» навсегда (в node-telegram-bot-api нет клиентского таймаута),
// апдейты копились в очереди Telegram (pending_update_count рос), процесс был жив
// и /health отвечал — мониторинг молчал. Лечение: детект «апдейты не доходят»
// (см. shared/watchdog.js) + перезапуск процесса (docker restart поднимает
// чистый поллинг, очередь Telegram отдаёт накопленное заново — дублей нет).
let lastIncomingUpdateAt = null; // «сердцебиение»: ставится на КАЖДЫЙ входящий апдейт
// Минимальные невидимые слушатели — не дублируют логику обработчиков, только
// фиксируют факт: апдейт реально пришёл из Telegram (значит поллинг жив).
bot.on('message', () => { lastIncomingUpdateAt = Date.now(); });
bot.on('callback_query', () => { lastIncomingUpdateAt = Date.now(); });

// Ошибки поллинга логируем сами (иначе дефолт библиотеки печатает «голый»
// объект). Не спамим: строка раз в минуту + общий счётчик. Одиночная ошибка —
// норма (библиотека продолжает цикл); ловим мы ЗАВИСАНИЕ, т.е. тишину.
let pollingErrorCount = 0;
let pollingErrorLastLogAt = 0;
bot.on('polling_error', (err) => {
    pollingErrorCount++;
    const info = (err && (err.code || err.message)) || String(err);
    const now = Date.now();
    if (now - pollingErrorLastLogAt > 60 * 1000) {
        console.error(`⚠️ [polling_error] ${new Date().toISOString()} ${info} (всего за работу: ${pollingErrorCount})`);
        pollingErrorLastLogAt = now;
    }
});

// Защита от «шторма рестартов»: `docker restart` НЕ пересоздаёт контейнер,
// /tmp переживает рестарт → считаем рестарты watchdog за 30 минут в файле-флаге.
// Лимит 3 — дальше только алерт, без выхода: иначе вечный цикл, если поллинг
// «украден» вторым экземпляром (рестарт не поможет, пока жив чужой).
const POLL_RESTART_FLAG = '/tmp/polling-watchdog-restarts.json';
function countRecentPollRestarts(now) {
    const fs = require('fs');
    try {
        const data = JSON.parse(fs.readFileSync(POLL_RESTART_FLAG, 'utf8'));
        return Array.isArray(data.ts) ? data.ts.filter(t => now - t < 30 * 60 * 1000).length : 0;
    } catch (e) { return 0; }
}
function markPollRestart(now) {
    const fs = require('fs');
    try {
        let data = { ts: [] };
        try { data = JSON.parse(fs.readFileSync(POLL_RESTART_FLAG, 'utf8')); } catch (e) { /* первый запуск */ }
        if (!Array.isArray(data.ts)) data = { ts: [] };
        data.ts = data.ts.filter(t => now - t < 30 * 60 * 1000); // держим окно чистым
        data.ts.push(now);
        fs.writeFileSync(POLL_RESTART_FLAG, JSON.stringify(data));
    } catch (e) { /* флаг не критичен */ }
}
// Перезапуск процесса — финальный шаг watchdog: сначала алерт Руководителю
// (см. health-cron ниже), потом выход. docker restart поднимет чистый поллинг.
function schedulePollRestart(reason) {
    const now = Date.now();
    if (countRecentPollRestarts(now) >= 3) {
        console.error(`🔴 Watchdog: поллинг завис, но лимит авто-рестартов исчерпан (3 за 30 мин) — нужен ручной разбор: ${reason}`);
        return;
    }
    markPollRestart(now);
    console.error(`🔴 Watchdog: перезапуск процесса (поллинг завис): ${reason}`);
    setTimeout(() => {
        console.error('🔴 Watchdog: exit(1) — docker restart поднимет чистый поллинг');
        process.exit(1);
    }, 3000);
}

// ================== ГЛАВНОЕ МЕНЮ (Reply Keyboard, зависит от роли) ==================
function buildMainMenu(role) {
    const rows = [];
    if (role === ROLES.EXECUTOR) {
        // Исполнитель: компактное плоское меню (без подменю)
        rows.push([{ text: '📩 Предложить задачу' }, { text: '📩 Мои заявки' }, { text: '📋 Мои задачи' }]);
        rows.push([{ text: '💬 Комментарий к задаче' }, { text: '📎 Загрузить файл' }]);
    } else {
        // Руководитель и Менеджер: категории открывают подменю
        rows.push([{ text: '📋 Задачи' }, { text: '📁 Проекты' }]);
        rows.push([{ text: '👥 Контакты' }, { text: '📂 Файлы' }]);
        if (role === ROLES.ADMIN) {
            rows.push([{ text: '📊 Статус' }, { text: '💾 Бэкапы' }]);
        }
    }
    rows.push([{ text: '📅 На сегодня' }, { text: '📜 История' }]);

    return { keyboard: rows, resize_keyboard: true, one_time_keyboard: false };
}

// Текст кнопок главного меню (для распознавания в bot.on('text'))
const MAIN_MENU_COMMANDS = new Set([
    // Категории подменю (Руководитель/Менеджер)
    '📋 Задачи', '📁 Проекты', '👥 Контакты', '📂 Файлы',
    // Действия задач
    '📝 Новая задача', '📋 Все задачи', '📋 Мои задачи',
    '📩 Предложить задачу', '📩 Мои заявки', '💬 Комментарий к задаче',
    // Действия проектов
    '📁 Новый проект', '📚 Проекты', '📦 Создать папку', '🗄 Архив',
    // Действия контактов
    '👤 Добавить контакт', '🏢 Добавить юрлицо', '🏢 Юрлица', '📇 Контакты',
    // Действия файлов
    '📎 Загрузить файл', '🔄 Файлы проекта',
    // Панель Руководителя
    '📊 Статус', '💾 Бэкапы',
    // Общие действия
    '📅 На сегодня', '📜 История',
    '⬅️ Назад'
]);

// ================== ПОДМЕНЮ (только для Руководителя/Менеджера) ==================
// КАЖДОЕ действие встречается ровно ОДИН раз во всём дереве меню (главное + подменю) —
// это исключает дублирование кнопок, из-за которого предыдущая реализация сломалась.
const SUBMENU_TITLES = {
    tasks: '📋 *Раздел «Задачи»:*',
    projects: '📁 *Раздел «Проекты»:*',
    contacts: '👥 *Раздел «Контакты»:*',
    files: '📂 *Раздел «Файлы»:*'
};

const SUBMENUS = {
    tasks: ['📝 Новая задача', '📋 Все задачи', '📩 Мои заявки', '⬅️ Назад'],
    projects: ['📁 Новый проект', '📚 Проекты', '📦 Создать папку', '🗄 Архив', '⬅️ Назад'],
    contacts: ['👤 Добавить контакт', '📇 Контакты', '🏢 Юрлица', '🏢 Добавить юрлицо', '⬅️ Назад'],
    files: ['📎 Загрузить файл', '🔄 Файлы проекта', '⬅️ Назад']
};

// Категория главного меню → ключ подменю
const SUBMENU_CATEGORIES = {
    '📋 Задачи': 'tasks',
    '📁 Проекты': 'projects',
    '👥 Контакты': 'contacts',
    '📂 Файлы': 'files'
};

function sendMainMenu(chatId, extraText, role) {
    const menu = buildMainMenu(role);
    const text = extraText ? `${extraText}\n\n💡 *Выбери действие:*` : '💡 *Выбери действие:*';
    return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: menu });
}

function sendSubmenu(chatId, submenuKey) {
    const buttons = SUBMENUS[submenuKey];
    if (!buttons) return;
    const sess = getSession(sessions, chatId);
    sess.state = STATE.IN_SUBMENU;
    const keyboard = {
        // ⚠️ ВАЖНО: .map() возвращает результат для КАЖДОГО индекса. Нечётные индексы,
        // где пара уже создана чётным индексом, должны отдавать null и отфильтровываться
        // через .filter(Boolean). Иначе второй элемент каждой пары дублируется отдельной
        // кнопкой (баг: «Файлы проекта» появлялась дважды в подменю «Файлы»).
        keyboard: buttons
            .map((text, i) =>
                i % 2 === 0
                    ? (i + 1 < buttons.length
                        ? [{ text: buttons[i] }, { text: buttons[i + 1] }]
                        : [{ text: buttons[i] }])
                    : null
            )
            .filter(Boolean),
        resize_keyboard: true,
        one_time_keyboard: false
    };
    const title = SUBMENU_TITLES[submenuKey] || '💡 *Выбери действие:*';
    return bot.sendMessage(chatId, title, { parse_mode: 'Markdown', reply_markup: keyboard });
}

// ================== UI-ПАГИНАЦИЯ СПИСКОВ (v4.22.0) ==================
// Решает «полотно + сотни кнопок»: лимит Telegram 100 inline-кнопок и 4096 символов
// на сообщение. Задачи имеют 3 кнопки на строку → 6 на страницу; простые списки — 10.
const LIST_PAGE_SIZE = {
    tasks: 6,
    simple: 10
};

// Текущая страница списка на юзера (ключ `${tgId}:${listKey}`). Нужно, чтобы после
// возврата из карточки / обновления / закрытия пользователь оставался на той же странице.
const lastListPage = new Map();
function getListPage(tgId, listKey) {
    return lastListPage.get(`${tgId}:${listKey}`) || 0;
}
function setListPage(tgId, listKey, page) {
    if (tgId === undefined || tgId === null) return;
    lastListPage.set(`${tgId}:${listKey}`, page);
}

// Режет items на страницу. Возвращает { pageItems, page, totalPages }.
// page всегда приводится к валидному диапазону (если список сократился после закрытия).
function slicePage(items, page, pageSize) {
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.min(Math.max(0, page || 0), totalPages - 1);
    return {
        pageItems: items.slice(safePage * pageSize, safePage * pageSize + pageSize),
        page: safePage,
        totalPages
    };
}

// Строка навигации «⬅️ 📄 1/4 ➡️» для inline-клавиатуры.
// Возвращает null, если страница одна — навигацию не показываем.
// prefix — callback-префикс списка (например 'cl' → callback_data 'cl_0').
function paginationRow(prefix, page, totalPages) {
    if (totalPages <= 1) return null;
    const row = [];
    if (page > 0) row.push({ text: '⬅️', callback_data: `${prefix}_${page - 1}` });
    row.push({ text: `📄 ${page + 1}/${totalPages}`, callback_data: 'noop' });
    if (page < totalPages - 1) row.push({ text: '➡️', callback_data: `${prefix}_${page + 1}` });
    return row;
}

// v4.45.0: Спаривает кнопки по 2 в ряд — убирает «простыни» из меню-вариантов
// (статусы проекта, типы документов, мессенджеры, единицы измерения). Вход —
// ПЛОСКИЙ массив кнопок {text, callback_data}; на выходе — ряды по ≤2 кнопок.
// callback_data НЕ меняются → «залипшие» кнопки старых сообщений работают.
function pairRow(buttons) {
    const rows = [];
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
    return rows;
}

// Устанавливаем команды в меню бота (минимальный набор)
bot.setMyCommands([
    { command: 'start', description: '🚀 Главное меню со сводкой' },
    { command: 'cancel', description: '❌ Отмена / Назад' }
]).then(() => {
    console.log('✅ Меню команд установлено');
}).catch(err => {
    console.error('❌ Ошибка установки меню:', err.message);
});




// Функция экранирования спецсимволов Markdown
function escapeMarkdown(text) {
    return textUtil.escapeMarkdown(text);
}

// 🆕 v4.35.0: Подпись кнопки-пункта в списках-«меню» (Проекты/Контакты/Юрлица/Архив).
// Inline-кнопки Telegram не переваривают переносы строк и очень длинные подписи
// (вёрстка разъезжается) → схлопываем пробелы и режем до максимума с многоточием.
const BUTTON_TEXT_MAX = 60;
function cleanButtonText(text, max = BUTTON_TEXT_MAX) {
    return textUtil.cleanButtonText(text, max);
}

// ================== ЗАДАЧИ: кнопки-пункты (v4.36.1, вариант A) ==================
// Списки задач — тот же паттерн, что Проекты/Контакты: каждый пункт = широкая
// кнопка (тап = карточка). Действия (✅ Закрыть / ✏️ / 💬) — ТОЛЬКО в карточке:
// отдельные строки «✅ Закрыть» под списком путали — непонятно, к какой задаче
// кнопка относится.
function formatTaskShortDate(dateStr) {
    return dates.formatDayTime(dateStr, config.TZ);
}
function formatTaskTime(dateStr) {
    return dates.formatTime(dateStr, config.TZ);
}
// Просрочена (не выполнена, дедлайн уже прошёл по факту)
function isTaskOverdue(t) {
    return !!t['Когда делаем'] && !t['Готово'] && new Date(t['Когда делаем']).getTime() < Date.now();
}
// Строка inline-клавиатуры для одной задачи: одна широкая кнопка-пункт.
function taskListRows(t, todayMode) {
    const done = !!t['Готово'];
    const overdue = !done && isTaskOverdue(t);
    const icon = done ? '✅' : (overdue ? '🔴' : '🔹');
    let label = `${icon} #${t.Id} ${cleanButtonText(t['Что делаем?'] || 'Без названия', 55)}`;
    const proj = t['Какой проект'] ? t['Какой проект']['Что делаем?'] : '';
    if (proj && !todayMode) label += ` · 📁 ${cleanButtonText(proj, 32)}`;
    if (t['Когда делаем']) label += todayMode
        ? ` · 🕐 ${formatTaskTime(t['Когда делаем'])}`
        : ` · ${formatTaskShortDate(t['Когда делаем'])}`;
    return [[{ text: label, callback_data: `view_${t.Id}` }]];
}

// Стрип Markdown-разметки и обрезка до лимита Telegram (4096) для fallback-отправки.
// 🐛 v4.21.2: раньше ошибка 400 (напр. '_' в ссылке контакта ломает Markdown v1) молча
// глоталась — бот НЕ отвечал на команду. Теперь в этом случае шлём plain text.
function plainTextFromMarkdown(text) {
    return textUtil.plainTextFromMarkdown(text);
}

// Извлекает текст ошибки из HTML-страницы ошибки вебхука (getErrorHTML)
function extractWebhookError(html) {
    if (typeof html !== 'string') return '';
    const match = html.match(/<div class="info-box">[\s\S]*?<p>([\s\S]*?)<\/p>/);
    if (!match) return '';
    return match[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ================== НОРМАЛИЗАЦИЯ ПОИСКА (транслит кириллица↔латиница) ==================
// Реализация вынесена в shared/text.js (тесты). Здесь — тонкая обёртка.
function normalizeSearch(text) {
    return textUtil.normalizeSearch(text);
}

// v4.29.0: сброс состояния ОДНОГО чата (раньше — глобального для всех).
// Вызывать ТОЛЬКО с chatId текущего пользователя.
function resetState(chatId) {
    resetSession(sessions, chatId);
}

function formatMinskDate(dateStr) {
    return dates.formatFull(dateStr, config.TZ);
}

function formatMinskDateShort(dateStr) {
    return dates.formatFull(dateStr, config.TZ);
}

// Построение даты «N дней от сегодня» в H:M по часовому поясу CRM (config.TZ).
// В БД хранится UTC: берём «сейчас» в поясе, строим целевую дату в координатах пояса
// и вычитаем смещение — получаем корректный UTC-момент (раньше было жёсткое −3ч, v4.28.4).
function buildMinskDate(daysOffset, hourLocal, minute) {
    return dates.buildDateInTZ(config.TZ, daysOffset, hourLocal, minute);
}

// v2: Умный парсер дедлайна. Поддерживает:
//   быстрые слова: «сегодня»(+3ч), «завтра»(09:00 Минск), «послезавтра»(09:00), «неделя»(+7 дней в то же время)
//   слово + время: «завтра 14:00», «сегодня 18:00»
//   относительные: «через 2 дня», «через 5 часов», «через 7 дней»
//   время: «14:00» (сегодня если ещё не прошло, иначе завтра)
//   даты: 17.06, 17.06.2026, 17/06/2026, 2026-06-17 (+ время)
//   дни недели: пн/понедельник ... вс/воскресенье (ближайший будущий, 09:00 Минск)
// Валидация: несуществующие даты (32.06, 17.13, 25:00) → null
function parseSmartDeadline(text) {
    return dates.parseSmartDeadline(text, config.TZ);
}

// Быстрые кнопки выбора срока (callback_data dl_*) → дата через parseSmartDeadline
function parseQuickDeadline(option) {
    return dates.parseQuickDeadline(option, config.TZ);
}

// Единый пикер срока (создание задачи или редактирование срока)
async function sendDeadlinePicker(chatId, mode, headerText) {
    const inlineKeyboard = [
        [{ text: '⏱ Через 3 часа', callback_data: 'dl_3h' }, { text: '📅 Завтра 9:00', callback_data: 'dl_tomorrow9' }],
        [{ text: '📅 Через неделю', callback_data: 'dl_week' }, { text: '🚫 Без срока', callback_data: 'dl_none' }]
    ];
    let text = '';
    if (headerText) text += `${headerText}\n\n`;
    text += mode === 'edit' ? '📅 *Введи новый срок:*' : '⏰ *Когда нужно сделать?*';
    text += `\n\nНажми кнопку или напиши дату вручную, например: *17.06 14:00*.\n`;
    text += mode === 'edit'
        ? '«🚫 Без срока» или /skip — убрать срок.'
        : '«🚫 Без срока» или /skip — без дедлайна.';
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
}

// Общая логика «срок выбран» при создании задачи (текст, кнопки — один путь)
async function handleTaskDeadlineChosen(chatId, telegramId, deadline) {
    const sess = getSession(sessions, chatId);
    sess.taskDraft.deadline = deadline;
    const emp = getEmployee(telegramId);
    const role = emp ? emp.Роль : ROLES.EXECUTOR;

    // Если задача создаётся внутри проекта (projectId уже число) —
    // v4.25.0: Руководитель/Менеджер выбирают исполнителя (как в обычном флоу задачи,
    // с правилом «Менеджер назначает Руководителя → предложение»). Исполнитель — сразу.
    if (sess.taskDraft.projectId && typeof sess.taskDraft.projectId === 'number') {
        if (role === ROLES.ADMIN || role === ROLES.MANAGER) {
            const allEmployees = Array.from(employeesCache.entries());
            const inlineKeyboard = allEmployees.map(([tid, e]) =>
                [{ text: `👤 ${e.Обращение} (${e.Роль})`, callback_data: `task_exec_${tid}` }]
            );
            inlineKeyboard.push([{ text: '⏭️ Без исполнителя', callback_data: 'task_exec_none' }]);
            await bot.sendMessage(chatId, `👥 *Назначить исполнителя?*\n\n📝 Задача: *${escapeMarkdown(sess.taskDraft.title)}*\n📁 Проект: #${sess.taskDraft.projectId}\n\nЕсли назначить Руководителя — задача уйдёт ему как предложение.`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
            sess.state = STATE.WAITING_EXECUTOR;
            return;
        }
        // Исполнитель: прав на назначение нет — создаём задачу сразу
        try {
            const payload = { 'Что делаем?': sess.taskDraft.title, 'Готово': false };
            if (sess.taskDraft.deadline) payload['Когда делаем'] = sess.taskDraft.deadline.toISOString();
            payload['Какой проект'] = [{ Id: sess.taskDraft.projectId }];
            const taskRes = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
            invalidateTaskListCache(); // v4.43.1: задача создана — списки задач обновятся
            bot.sendMessage(chatId, `✅ *Задача создана и привязана к проекту!*\n📝 *${escapeMarkdown(sess.taskDraft.title)}*\n🆔 Задача ID: ${taskRes.data.Id}`, { parse_mode: 'Markdown' });
            resetState(chatId);
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка создания задачи: ${err.message}`);
            resetState(chatId);
        }
        return;
    }

    // Обычный поток: выбор проекта
    sess.state = STATE.WAITING_PROJECT;
    showProjectSelectionForTask(chatId, telegramId, role);
}

async function getActiveProjects() {
    const rows = await fetchAllRows(config.TABLES.PROJECTS);
    return rows.filter(p => p['Активно'] === 'Активно');
}

// Нормализация телефона для поиска (приводим к формату 375XXXXXXXXX)
function normalizePhone(p) {
    if (!p) return '';
    let digits = String(p).replace(/\D/g, '');
    if (digits.startsWith('80')) digits = '375' + digits.substring(2);
    else if (digits.startsWith('0') && digits.length === 10) digits = '375' + digits.substring(1);
    return digits;
}

async function findDuplicateContact(tgId, phone, username, excludeId = null) {
    const contacts = await fetchAllRows(config.TABLES.CONTACTS);
    // v4.43.0: excludeId — редактируемый контакт (правка поля не должна считать
    // дублем САМО себя: телефон/username уже заняты текущей записью).
    const notExcluded = (c) => !excludeId || c.Id != excludeId;

    // 1. TG ID - СТРОГОЕ СОВПАДЕНИЕ
    if (tgId) {
        const match = contacts.find(c => notExcluded(c) && String(c['TG ID'] || '') === String(tgId));
        if (match) return match;
    }

    // 2. Телефон - УМНОЕ СРАВНЕНИЕ (последние 9 цифр для РБ)
    if (phone) {
        const normPhone = normalizePhone(phone);
        const targetLast9 = normPhone.slice(-9);

        if (targetLast9.length === 9) {
            const match = contacts.find(c => notExcluded(c) && normalizePhone(c['Телефон']).slice(-9) === targetLast9);
            if (match) return match;
        } else if (targetLast9.length >= 7) {
            // Фоллбэк для коротких номеров
            const match = contacts.find(c => {
                if (!notExcluded(c)) return false;
                const cNormPhone = normalizePhone(c['Телефон']);
                return cNormPhone.endsWith(targetLast9);
            });
            if (match) return match;
        }
    }

    // 3. Username - СТРОГОЕ СОВПАДЕНИЕ
    if (username) {
        const cleanUsername = username.replace('@', '').toLowerCase();
        const match = contacts.find(c => notExcluded(c) && (() => {
            const cLink = String(c['Ссылка'] || '').toLowerCase();
            return cLink === `https://t.me/${cleanUsername}` || cLink.endsWith(`/${cleanUsername}`);
        })());
        if (match) return match;
    }

    return null;
}

async function startContactWizard(chatId) {
    const sess = getSession(sessions, chatId);
    sess.state = STATE.WAITING_CONTACT_NAME;
    sess.contactDraft = { name: '', phone: null, username: null, email: null, messenger: 'Telegram' };
    await bot.sendMessage(chatId, `👤 *Добавление нового контакта*\n\nШаг 1️⃣ из 5\n\n✏️ *Напиши имя контакта:*`, { parse_mode: 'Markdown' });
}

// 🆕 v4.25.0: ЕДИНАЯ точка создания проекта.
// Раньше POST /проекты был зашит в 4 копиях с разным набором полей —
// из-за этого проект из флоу задачи создавался без Менеджера и без клиента
// (папку нельзя создать, документы не привязать). Теперь все поля и история — здесь.
async function createProjectRecord({ title, contactId, legalId, managerId, creator }) {
    const payload = { 'Что делаем?': title, 'Статус': 'Обсуждение' };
    if (contactId) payload['Контакт'] = contactId;
    if (legalId) payload['Юрлицо'] = legalId;
    if (managerId) payload['Менеджер'] = managerId;
    const res = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
    const created = res.data;

    // Аудит в «Подробности»: кто и когда создал проект (как v4.17.0 пишет смену статуса)
    if (creator) {
        try {
            const ts = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });
            const who = creator.Обращение || creator.ФИО || 'Сотрудник';
            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${created.Id}`, { 'Подробности': `[${ts}] 🚀 Проект создан: ${who}` }, { headers: { 'xc-token': config.NOCO_TOKEN } });
        } catch (e) {
            console.log(`⚠️ Не удалось записать историю создания проекта #${created.Id}: ${e.message}`);
        }
    }
    console.log(`✅ Проект создан: #${created.Id} «${title}»`);
    return created;
}

// 🆕 v4.25.0: Шаг 3 визарда — единый финальный экран для всех источников.
// - source='task': проект создаётся сразу, затем продолжаем создание задачи
//   (title/deadline уже введены в флоу задачи; выбор исполнителя — след. шаг).
// - иначе: вопрос «создать задачу сразу?» + предупреждение про папку без клиента.
async function showProjectStep3(chatId, telegramId) {
    const sess = getSession(sessions, chatId);
    sess.state = STATE.IDLE;
    // 🆕 v4.25.0: режим «привязка клиента к существующему проекту» (кнопка 👤 Привязать клиента)
    if (sess.projectDraft.attachProjectId) {
        if (!sess.projectDraft.contactId && !sess.projectDraft.legalId) {
            await bot.sendMessage(chatId, '❌ Клиент не выбран. Привязка отменена.');
            resetState(chatId);
            return;
        }
        try {
            const attachRes = await axios.post(`${WEBHOOK_URL}/attach-client?secret=${process.env.WEBHOOK_SECRET || ''}`, {
                projectId: sess.projectDraft.attachProjectId,
                contactId: sess.projectDraft.contactId,
                legalId: sess.projectDraft.legalId
            }, { timeout: 15000, validateStatus: () => true });
            if (attachRes.status >= 400) {
                const errText = extractWebhookError(attachRes.data) || `Вебхук вернул статус ${attachRes.status}`;
                await bot.sendMessage(chatId, `❌ Не удалось привязать клиента:\n${errText}`);
                resetState(chatId);
                return;
            }
            const label = sess.projectDraft.legalId ? '🏢 Юрлицо' : '👤 Контакт';
            await bot.sendMessage(chatId, `✅ *${label} привязан к проекту #${sess.projectDraft.attachProjectId}!*`);
            const inlineKeyboard = [
                [{ text: '📦 Создать папку', callback_data: `folder_proj_${sess.projectDraft.attachProjectId}` }],
                [{ text: '✅ Готово', callback_data: 'pdone_dismiss' }]
            ];
            await bot.sendMessage(chatId, `📦 *Папку для проекта теперь можно создать.*\n\nХочешь?`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            resetState(chatId);
            return;
        } catch (err) {
            await bot.sendMessage(chatId, `❌ Ошибка привязки клиента: ${err.message}`);
            resetState(chatId);
            return;
        }
    }
    if (sess.projectDraft.source === 'task') {
        try {
            const created = await createProjectRecord({
                title: sess.projectDraft.title,
                contactId: sess.projectDraft.contactId,
                legalId: sess.projectDraft.legalId,
                managerId: sess.projectDraft.managerId,
                creator: telegramId ? getEmployee(telegramId) : null
            });
            sess.taskDraft.projectId = created.Id;
            console.log(`✅ Проект для задачи создан, projectId=${created.Id}, type=${typeof created.Id}`);
            await bot.sendMessage(chatId, `🚀 *Проект создан для задачи!*\n📝 ${sess.projectDraft.title}\n🆔 ID: ${created.Id}`, { parse_mode: 'Markdown' });
            // Продолжаем флоу задачи: projectId уже число → handleTaskDeadlineChosen создаст задачу
            await handleTaskDeadlineChosen(chatId, telegramId, sess.taskDraft.deadline);
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка создания проекта: ${err.message}`);
            resetState(chatId);
        }
        return;
    }
    // Обычный шаг 3 (menu / contact): «Хочешь сразу создать задачу?»
    const inlineKeyboard = [
        [{ text: '✅ Да, создать задачу', callback_data: 'proj_task_yes' }],
        [{ text: '❌ Нет, завершить', callback_data: 'proj_task_no' }]
    ];
    let text = '📋 *Шаг 3️⃣ из 3*\n\n*Хочешь сразу создать задачу?*';
    if (!sess.projectDraft.contactId && !sess.projectDraft.legalId) {
        text += '\n\n⚠️ *Важно:* папку для проекта можно будет создать после привязки клиента (Контакт или Юрлицо).';
    }
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
}

// 🆕 v4.25.0: ЕДИНЫЙ визард создания проекта для всех точек входа:
// - source='menu'    — из главного меню «📁 Новый проект» (клиент выбирается)
// - source='task'    — из флоу задачи «➕ Создать новый проект» (клиент опционально, после — задача)
// - source='contact' — из флоу контакта (клиент уже известен, шаг выбора пропускается)
async function startProjectWizard(chatId, telegramId, options = {}) {
    const source = options.source || 'menu';
    const sess = getSession(sessions, chatId);
    sess.state = STATE.WAITING_PROJECT_TITLE;
    // Перезапись черновика = полный сброс (как было при присваивании нового объекта).
    // Object.assign сохраняет ссылку на sess.projectDraft (важно: showProjectStep3 и др.
    // работают с той же ссылкой), поэтому СТАРЫЕ поля обнуляем явно.
    Object.assign(sess.projectDraft, {
        title: '',
        contactId: options.contactId || null,
        legalId: options.legalId || null,
        tab: 'fiz',
        noteProjectId: null,
        deadlineProjectId: null,
        transferProjectId: null,
        managerId: telegramId ? getEmployee(telegramId)?.Id : null,
        source: source,
        attachProjectId: null,
        dupProjectId: null
    });
    const header = source === 'task'
        ? '🚀 *Создание нового проекта для задачи*'
        : source === 'contact'
        ? '🚀 *Создание нового проекта для контакта*'
        : '🚀 *Создание нового проекта*';
    await bot.sendMessage(chatId, `${header}\n\nШаг 1️⃣ из 3\n\n✏️ *Напиши название проекта:*`, { parse_mode: 'Markdown' });
}

// 🆕 v4.25.0: Финальный экран после создания проекта — «Что дальше?»
// Вместо сухого «Проект создан!» — сводка и быстрые действия:
// 📝 задача / 📦 папка (если клиент есть) / 👤 привязать клиента (если нет).
async function showProjectAfterCreate(chatId, projectId, telegramId) {
    try {
        const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const p = res.data;
        let text = `🚀 *Проект создан!* (#${p.Id})\n\n`;
        text += `📝 *${escapeMarkdown(p['Что делаем?'] || 'Без названия')}*\n`;
        const org = p['Юрлицо'];
        const contact = p['Контакт'];
        if (org) {
            text += `🏢 Клиент: ${escapeMarkdown(org['Краткое Имя'] || org['Имя'] || '')}\n`;
        } else if (contact) {
            const contactField = Array.isArray(contact) ? contact[0] : contact;
            text += `👤 Клиент: ${escapeMarkdown(contactField?.['Имя'] || '')}\n`;
        } else {
            text += `⏭️ Без клиента\n`;
        }
        if (p['Менеджер']) text += `👤 Менеджер: ${escapeMarkdown(p['Менеджер']['ФИО'] || 'Сотрудник')}\n`;
        text += `\n*Что дальше?*`;

        const kb = [];
        kb.push([{ text: '📝 Создать задачу', callback_data: `pnewtask_${projectId}` }]);
        if (org || (Array.isArray(contact) ? contact[0] : contact)) {
            kb.push([{ text: '📦 Создать папку', callback_data: `folder_proj_${projectId}` }]);
        } else {
            kb.push([{ text: '👤 Привязать клиента', callback_data: `pattach_${projectId}` }]);
        }
        kb.push([{ text: '✅ Готово', callback_data: 'pdone_dismiss' }]);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
    } catch (err) {
        await bot.sendMessage(chatId, `🚀 *Проект создан!* (ID: ${projectId})`, { parse_mode: 'Markdown' });
    }
}

// 🆕 v4.25.0: Проверка дублей активных проектов по точному названию
async function findProjectDuplicate(title) {
    const q = String(title || '').trim().toLowerCase();
    const rows = await fetchAllRows(config.TABLES.PROJECTS);
    return rows.find(p =>
        p['Активно'] === 'Активно' &&
        String(p['Что делаем?'] || '').trim().toLowerCase() === q
    ) || null;
}

async function showContactSelectionForProject(chatId) {
    const sess = getSession(sessions, chatId);
    sess.state = STATE.WAITING_PROJECT_CONTACT;
    sess.projectDraft.tab = 'fiz';
    try {
        const contactsRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}?limit=5&sort=-Id`, {
            headers: { 'xc-token': config.NOCO_TOKEN }
        });
        const recentContacts = contactsRes.data.list;
        let text = sess.projectDraft.source === 'attach'
            ? `👥 *Выбери клиента для проекта #${sess.projectDraft.attachProjectId}:*\n\n`
            : `👥 *Шаг 2️⃣ из 3 — выбери клиента проекта*\n\n`;
        if (recentContacts.length > 0) text += `🕐 *Последние добавленные (физлица):*\n`;
        else text += `📭 Пока нет физлиц.\n`;
        const inlineKeyboard = [
            [{ text: '👤 Физлица', callback_data: 'proj_tab_fiz' }, { text: '🏢 Юрлица', callback_data: 'proj_tab_legal' }]
        ];
        recentContacts.forEach(c => {
            const phone = c['Телефон'] ? ` (${escapeMarkdown(c['Телефон'])})` : '';
            inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `proj_contact_${c.Id}` }]);
        });
        inlineKeyboard.push([{ text: '🔍 Поиск по всем', callback_data: 'proj_search_all' }]);
        inlineKeyboard.push([{ text: '➕ Новый контакт', callback_data: 'proj_new_contact' }, { text: '⏭️ Без клиента', callback_data: 'proj_no_contact' }]);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка получения контактов: ${err.message}`);
        resetState(chatId);
    }
}

async function showLegalSelectionForProject(chatId) {
    const sess = getSession(sessions, chatId);
    sess.state = STATE.WAITING_PROJECT_CONTACT;
    sess.projectDraft.tab = 'legal';
    try {
        const legalsRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.LEGAL_ENTITIES}?limit=5&sort=-Id`, {
            headers: { 'xc-token': config.NOCO_TOKEN }
        });
        const recentLegals = legalsRes.data.list;
        let text = sess.projectDraft.source === 'attach'
            ? `👥 *Выбери клиента для проекта #${sess.projectDraft.attachProjectId}:*\n\n`
            : `👥 *Шаг 2️⃣ из 3 — выбери клиента проекта*\n\n`;
        if (recentLegals.length > 0) text += `🕐 *Последние добавленные (юрлица):*\n`;
        else text += `📭 Пока нет юрлиц.\n`;
        const inlineKeyboard = [
            [{ text: '👤 Физлица', callback_data: 'proj_tab_fiz' }, { text: '🏢 Юрлица', callback_data: 'proj_tab_legal' }]
        ];
        recentLegals.forEach(l => {
            const name = l['Краткое Имя'] || l['Имя'] || 'Без имени';
            const phone = l['Телефон'] ? ` (${escapeMarkdown(l['Телефон'])})` : '';
            inlineKeyboard.push([{ text: `🏢 ${escapeMarkdown(name)}${phone}`, callback_data: `proj_legal_${l.Id}` }]);
        });
        inlineKeyboard.push([{ text: '🔍 Поиск по всем', callback_data: 'proj_search_all' }]);
        inlineKeyboard.push([{ text: '➕ Новое юрлицо', callback_data: 'proj_new_legal' }, { text: '⏭️ Без клиента', callback_data: 'proj_no_contact' }]);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка получения юрлиц: ${err.message}`);
        resetState(chatId);
    }
}

async function searchContacts(chatId, query) {
    try {
        const allContacts = await fetchAllRows(config.TABLES.CONTACTS);
        const q = normalizeSearch(query);
        const found = allContacts.filter(c => {
            return [c['Имя'], c['Телефон'], c['Ссылка'], c['E-mail']].some(f => normalizeSearch(f).includes(q));
        });
        if (found.length === 0) {
            const inlineKeyboard = [
                [{ text: '🔍 Попробовать другой запрос', callback_data: 'proj_search_contact' }],
                [{ text: '➕ Новый контакт', callback_data: 'proj_new_contact' }],
                [{ text: '⏭️ Без клиента', callback_data: 'proj_no_contact' }]
            ];
            await bot.sendMessage(chatId, `❌ Ничего не найдено по запросу "*${escapeMarkdown(query)}*"`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            return;
        }
        let text = `🔍 *Найдено ${found.length} контакт(ов):*\n`;
        if (found.length > 15) text += `_Показаны первые 15 — уточни запрос_\n`;
        text += `\n`;
        const inlineKeyboard = [];
        found.slice(0, 15).forEach(c => {
            const phone = c['Телефон'] ? ` 📱${escapeMarkdown(c['Телефон'])}` : '';
            inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `proj_contact_${c.Id}` }]);
        });
        inlineKeyboard.push([{ text: '🔍 Уточнить поиск...', callback_data: 'proj_search_contact' }]);
        inlineKeyboard.push([{ text: '➕ Новый контакт', callback_data: 'proj_new_contact' }, { text: '⏭️ Без клиента', callback_data: 'proj_no_contact' }]);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка поиска: ${err.message}`);
    }
}

async function searchLegalEntities(chatId, query) {
    try {
        const allLegals = await fetchAllRows(config.TABLES.LEGAL_ENTITIES);
        const q = normalizeSearch(query);
        const found = allLegals.filter(l => {
            return [l['Краткое Имя'], l['Имя'], l['Телефон'], l['E-mail'], l['УНП'], l['Адрес']].some(f => normalizeSearch(f).includes(q));
        });
        if (found.length === 0) {
            const inlineKeyboard = [
                [{ text: '🔍 Попробовать другой запрос', callback_data: 'proj_search_legal' }],
                [{ text: '➕ Новое юрлицо', callback_data: 'proj_new_legal' }],
                [{ text: '⏭️ Без клиента', callback_data: 'proj_no_contact' }]
            ];
            await bot.sendMessage(chatId, `❌ Ничего не найдено по запросу "*${escapeMarkdown(query)}*"`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            return;
        }
        let text = `🏢 *Найдено юрлиц: ${found.length}*\n`;
        if (found.length > 15) text += `_Показаны первые 15 — уточни запрос_\n`;
        text += `\n`;
        const inlineKeyboard = [];
        found.slice(0, 15).forEach(l => {
            const name = l['Краткое Имя'] || l['Имя'] || 'Без имени';
            const phone = l['Телефон'] ? ` 📱${escapeMarkdown(l['Телефон'])}` : '';
            inlineKeyboard.push([{ text: `🏢 ${escapeMarkdown(name)}${phone}`, callback_data: `proj_legal_${l.Id}` }]);
        });
        inlineKeyboard.push([{ text: '🔍 Уточнить поиск...', callback_data: 'proj_search_legal' }]);
        inlineKeyboard.push([{ text: '➕ Новое юрлицо', callback_data: 'proj_new_legal' }, { text: '⏭️ Без клиента', callback_data: 'proj_no_contact' }]);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка поиска юрлиц: ${err.message}`);
    }
}

// Единый поиск: и физлица, и юрлица разом. Для случая «заказчик позвонил, не помню физлицо это или ООО».
async function searchAllClients(chatId, query) {
    try {
        const [contacts, legals] = await Promise.all([
            fetchAllRows(config.TABLES.CONTACTS),
            fetchAllRows(config.TABLES.LEGAL_ENTITIES)
        ]);
        const q = normalizeSearch(query);
        const foundContacts = contacts.filter(c => {
            return [c['Имя'], c['Телефон'], c['Ссылка'], c['E-mail']].some(f => normalizeSearch(f).includes(q));
        });
        const foundLegals = legals.filter(l => {
            return [l['Краткое Имя'], l['Имя'], l['Телефон'], l['E-mail'], l['УНП'], l['Адрес']].some(f => normalizeSearch(f).includes(q));
        });
        const total = foundContacts.length + foundLegals.length;
        if (total === 0) {
            const inlineKeyboard = [
                [{ text: '🔍 Попробовать другой запрос', callback_data: 'proj_search_all' }],
                [{ text: '➕ Новый контакт', callback_data: 'proj_new_contact' }],
                [{ text: '➕ Новое юрлицо', callback_data: 'proj_new_legal' }],
                [{ text: '⏭️ Без клиента', callback_data: 'proj_no_contact' }]
            ];
            await bot.sendMessage(chatId, `❌ Ничего не найдено по запросу "*${escapeMarkdown(query)}*"`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            return;
        }
        let text = `🔍 *Найдено клиентов: ${total}*\n`;
        if (total > 30) text += `_Показаны первые 30 — уточни запрос_\n`;
        text += `\n`;
        const inlineKeyboard = [];
        foundContacts.slice(0, 15).forEach(c => {
            const phone = c['Телефон'] ? ` 📱${escapeMarkdown(c['Телефон'])}` : '';
            inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `proj_contact_${c.Id}` }]);
        });
        foundLegals.slice(0, 15).forEach(l => {
            const name = l['Краткое Имя'] || l['Имя'] || 'Без имени';
            const phone = l['Телефон'] ? ` 📱${escapeMarkdown(l['Телефон'])}` : '';
            inlineKeyboard.push([{ text: `🏢 ${escapeMarkdown(name)}${phone}`, callback_data: `proj_legal_${l.Id}` }]);
        });
        inlineKeyboard.push([{ text: '🔍 Уточнить поиск...', callback_data: 'proj_search_all' }]);
        inlineKeyboard.push([{ text: '➕ Новый контакт', callback_data: 'proj_new_contact' }, { text: '➕ Новое юрлицо', callback_data: 'proj_new_legal' }]);
        inlineKeyboard.push([{ text: '⏭️ Без клиента', callback_data: 'proj_no_contact' }]);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка поиска: ${err.message}`);
    }
}

async function showProjectSelectionForContact(chatId, contactId) {
    const sess = getSession(sessions, chatId);
    sess.pendingContactAction = { ...sess.pendingContactAction, active: true, contactId: contactId, waitingPhone: false, waitingProjectForMessage: false };
    sess.state = STATE.IDLE;
    const text = `🔗 *К какому проекту привязать?*\n\n1️⃣ Нажми "➕ Создать новый проект" (рекомендуется)\n2️⃣ Или "❌ Без проекта"`;
    const inlineKeyboard = [
        [{ text: '➕ Создать новый проект 🚀', callback_data: 'proj_new_for_contact' }],
        [{ text: '❌ Без проекта', callback_data: 'proj_none_contact' }]
    ];
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
}

async function showProjectSelectionForTask(chatId, telegramId, role, page = 0, messageId = null) {
    try {
        const sess = getSession(sessions, chatId);
        let projects = await getActiveProjects();

        // Менеджер видит только свои проекты
        if (role === ROLES.MANAGER) {
            const emp = getEmployee(telegramId);
            if (emp) {
                projects = projects.filter(p => p['Менеджер']?.Id === emp.Id);
            }
        }
        // v4.45.0: селектор пагинирован (как списки) — при десятках активных
        // проектов «простыни» нет. Навигация ptj_{page} НЕ сбивает визард задачи
        // (state/черновик остаются; листается только список).
        const { pageItems, page: safePage, totalPages } = slicePage(projects, page, LIST_PAGE_SIZE.simple);
        setListPage(telegramId, 'ptj', safePage);
        projects = pageItems;
        const navRow = paginationRow('ptj', safePage, totalPages);



        let text = `📅 *Срок:* ${sess.taskDraft.deadline ? formatMinskDate(sess.taskDraft.deadline) : 'Без срока'}\n\n🚀 *К какому проекту привязать?*`;
        const inlineKeyboard = projects.map(p => [{ text: `${escapeMarkdown(p['Что делаем?'])} (ID:${p.Id})`, callback_data: `project_${p.Id}` }]);
        if (navRow) inlineKeyboard.push(navRow);

        if (role === ROLES.ADMIN || role === ROLES.MANAGER) {
            inlineKeyboard.push([{ text: '➕ Создать новый проект', callback_data: 'create_new_project_for_task' }]);
        }
        inlineKeyboard.push([{ text: '❌ Без проекта', callback_data: 'project_none' }]);

        const pickerOptions = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...pickerOptions });
        else await bot.sendMessage(chatId, text, pickerOptions);
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); resetState(chatId); }
}

// ================== ФУНКЦИЯ: ДОБАВИТЬ В ПОДРОБНОСТИ ЗАДАЧИ ==================
async function appendTaskDetails(taskId, text, source) {
    const ts = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });
    const taskUrl = `${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`;

    const task = (await axios.get(taskUrl, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
    const oldDetails = String(task['Подробности'] || '').trim();
    const sourceLabels = { forward: '📨 Переслано', comment: '💬 Комментарий', file: '📎 Файл' };
    const sourceLabel = sourceLabels[source] || '📝 Заметка';
    const newEntry = `[${ts}] ${sourceLabel}:\n${text}`;
    const newDetails = oldDetails ? `${oldDetails}\n\n---\n${newEntry}` : newEntry;

    await axios.patch(taskUrl, { 'Подробности': newDetails }, { headers: { 'xc-token': config.NOCO_TOKEN } });
}

// ================== ОБЩИЙ СЕЛЕКТОР СВОИХ ЗАДАЧ (комментарий / файл) ==================
// v4.45.0: пагинация как у списков (pageKey свой на сценарий: pcm/pft), чтобы
// после листания пользователь оставался на своей странице. callbacks не меняются.
async function showMyTasksPicker(chatId, telegramId, pageKey, title, cbPrefix, cancelCb, emptyText, page = 0, messageId = null) {
    try {
        const emp = getEmployee(telegramId);
        if (!emp) return bot.sendMessage(chatId, '❌ Сотрудник не найден');

        const rows = await fetchTasksForListCached();
        const myTasks = rows.filter(t => !t['Готово'] && t['Исполнитель']?.Id === emp.Id);

        // v4.38.0: тот же порядок, что в списке задач (просроченные/ближайшие сверху).
        myTasks.sort(sorters.compareTasksActive);

        if (myTasks.length === 0) {
            return bot.sendMessage(chatId, emptyText);
        }

        // v4.45.0: пагинация селектора.
        const { pageItems, page: safePage, totalPages } = slicePage(myTasks, page, LIST_PAGE_SIZE.simple);
        setListPage(telegramId, pageKey, safePage);

        const inlineKeyboard = pageItems.map(t =>
            [{ text: `#${t.Id} ${t['Что делаем?']}`, callback_data: `${cbPrefix}${t.Id}` }]
        );
        const nav = paginationRow(pageKey, safePage, totalPages);
        if (nav) inlineKeyboard.push(nav);
        inlineKeyboard.push([{ text: '❌ Отмена', callback_data: cancelCb }]);

        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
        if (messageId) await bot.editMessageText(title, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, title, options);
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
}

async function showMyTasksForComment(chatId, telegramId, page = 0, messageId = null) {
    return showMyTasksPicker(chatId, telegramId, 'pcm', '📋 *Выбери задачу для комментария:*', 'comment_task_', 'comment_cancel', '📭 У вас нет активных задач.', page, messageId);
}

async function showMyTasksForFile(chatId, telegramId, page = 0, messageId = null) {
    return showMyTasksPicker(chatId, telegramId, 'pft', '📎 *Выбери задачу для загрузки файла:*', 'file_task_', 'file_cancel', '📭 У вас нет активных задач для загрузки файлов.', page, messageId);
}

// ================== ОБЩИЙ ВЫБОР АКТИВНОГО ПРОЕКТА (файл / папка / файлы) ==================
// v4.45.0: пагинация как у списков (pageKey: pfu/pfd/pfl). callbacks не меняются.
async function showActiveProjectsPicker(chatId, telegramId, role, pageKey, title, cbPrefix, cancelCb, page = 0, messageId = null) {
    try {
        const rows = await fetchAllRows(config.TABLES.PROJECTS);
        let projects = rows.filter(p => p['Активно'] === 'Активно');

        if (role === ROLES.MANAGER) {
            const emp = getEmployee(telegramId);
            if (emp) projects = projects.filter(p => p['Менеджер']?.Id === emp.Id);
        }

        if (projects.length === 0) {
            return bot.sendMessage(chatId, '📭 Нет активных проектов.');
        }

        // v4.38.0: тот же порядок, что в списке «Активные проекты» (этап → срок).
        projects.sort(sorters.compareActiveProjectsByStage);

        // v4.45.0: пагинация селектора.
        const { pageItems, page: safePage, totalPages } = slicePage(projects, page, LIST_PAGE_SIZE.simple);
        setListPage(telegramId, pageKey, safePage);

        const inlineKeyboard = pageItems.map(p =>
            [{ text: `📁 ${p['Что делаем?'] || '(без названия)'} (ID:${p.Id})`, callback_data: `${cbPrefix}${p.Id}` }]
        );
        const nav = paginationRow(pageKey, safePage, totalPages);
        if (nav) inlineKeyboard.push(nav);
        inlineKeyboard.push([{ text: '❌ Отмена', callback_data: cancelCb }]);

        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
        if (messageId) await bot.editMessageText(title, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, title, options);
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
}

async function showProjectsForFile(chatId, telegramId, role, page = 0, messageId = null) {
    return showActiveProjectsPicker(chatId, telegramId, role, 'pfu', '📎 *Выбери проект для загрузки файла:*', 'file_proj_', 'file_cancel', page, messageId);
}

async function showProjectsForFolder(chatId, telegramId, role, page = 0, messageId = null) {
    return showActiveProjectsPicker(chatId, telegramId, role, 'pfd', '📦 *Выбери проект для создания папки:*', 'folder_proj_', 'folder_cancel', page, messageId);
}

async function showProjectsForFilesList(chatId, telegramId, role, page = 0, messageId = null) {
    return showActiveProjectsPicker(chatId, telegramId, role, 'pfl', '🔄 *Выбери проект для просмотра файлов:*', 'files_proj_', 'files_cancel', page, messageId);
}


// ================== ФИЛЬТРАЦИЯ ЗАДАЧ ПО РОЛИ ==================
// v4.28.0: логика перенесена в shared/roles.js (roles.filterTasksByRole(tasks, emp))
// — её тестирует tests/roles.test.js (Проблема 84: «видишь ровно то, чем управляешь»).
// Здесь в bot.js больше НЕТ дублирующей функции — только вызовы ниже.

// ================== НОВОЕ: СПИСОК ЗАДАЧ НА СЕГОДНЯ ==================
async function sendTodayTasks(chatId, telegramId, role, messageId, page = 0) {
    try {
        const rows = await fetchTasksForListCached();
        let activeTasks = rows.filter(t => !t['Готово']);

        // Фильтрация по роли
        if (telegramId !== undefined && role !== undefined) {
            activeTasks = roles.filterTasksByRole(activeTasks, getEmployee(telegramId));
        }

        // Фильтруем задачи на сегодня (по минскому времени)
        const nowMinsk = new Date(new Date().toLocaleString("en-US", {timeZone: config.TZ}));
        const todayStart = new Date(nowMinsk); todayStart.setHours(0, 0, 0, 0);
        const todayEnd = new Date(nowMinsk); todayEnd.setHours(23, 59, 59, 999);

        const todayTasks = activeTasks.filter(t => {
            if (!t['Когда делаем']) return false;
            const taskDate = new Date(t['Когда делаем']);
            return taskDate >= todayStart && taskDate <= todayEnd;
        });

        // v4.38.0: внутри дня сортируем по времени (расписание), без времени — в конец.
        todayTasks.sort(sorters.compareTasksActive);

        // 🆕 v4.22.0: UI-пагинация
        const { pageItems, page: safePage, totalPages } = slicePage(todayTasks, page, LIST_PAGE_SIZE.tasks);
        setListPage(telegramId, 'td', safePage);

            let text = `📅 *Задачи на сегодня (${todayStart.toLocaleDateString('ru-RU')})* (${todayTasks.length})${totalPages > 1 ? ` · стр. ${safePage + 1}/${totalPages}` : ''}`;
    // 🆕 v4.36.0: список = кнопки-пункты; «✅ Закрыть» у каждой задачи (все они «горящие»).
    if (pageItems.length === 0) text += '\n\n🎉 На сегодня задач нет!';
    else text += '\n\n👇 *Нажми на задачу* — карточка с действиями.\n';

    const inlineKeyboard = [];
    pageItems.forEach(t => inlineKeyboard.push(...taskListRows(t, true)));
    const nav = paginationRow('td', safePage, totalPages);
        if (nav) inlineKeyboard.push(nav);
        inlineKeyboard.push([{ text: '📋 Все задачи', callback_data: 'refresh_tasks' }]);

        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
    }
}

// ================== НОВОЕ: ИСТОРИЯ ЗАДАЧ ==================
async function sendTaskHistory(chatId, telegramId, role, messageId, page = 0) {
    try {
        const rows = await fetchTasksForListCached();
        let doneTasks = rows.filter(t => t['Готово']);

        // Фильтрация по роли
        if (telegramId !== undefined && role !== undefined) {
            doneTasks = roles.filterTasksByRole(doneTasks, getEmployee(telegramId));
        }

        // Фильтруем задачи за последние 7 дней
        const now = new Date();
        const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);

        const recentDone = doneTasks.filter(t => {
            const updated = t['UpdatedAt'] ? new Date(t['UpdatedAt']) : null;
            return updated && updated >= weekAgo;
        });

        // v4.38.0: лента — свежезакрытые сверху (по UpdatedAt desc).
        recentDone.sort(sorters.compareByUpdatedAtDesc);

        // 🆕 v4.22.0: UI-пагинация
        const { pageItems, page: safePage, totalPages } = slicePage(recentDone, page, LIST_PAGE_SIZE.simple);
        setListPage(telegramId, 'hl', safePage);

            let text = `📜 *История задач (последние 7 дней)* (${recentDone.length})${totalPages > 1 ? ` · стр. ${safePage + 1}/${totalPages}` : ''}`;
    // 🆕 v4.36.0: список = кнопки-пункты (выполненные — только просмотр, действий нет)
    if (pageItems.length === 0) text += '\n\n📭 За последнюю неделю нет выполненных задач.';
    else text += '\n\n👇 *Нажми на задачу* — карточка с подробностями.\n';

    const inlineKeyboard = [];
    pageItems.forEach(t => {
        const proj = t['Какой проект'] ? t['Какой проект']['Что делаем?'] : '';
        let label = `✅ #${t.Id} ${cleanButtonText(t['Что делаем?'] || 'Без названия', 55)}`;
        if (proj) label += ` · 📁 ${cleanButtonText(proj, 32)}`;
        if (t['UpdatedAt']) label += ` · 📅 ${formatTaskShortDate(t['UpdatedAt'])}`;
        inlineKeyboard.push([{ text: label, callback_data: `view_${t.Id}` }]);
    });
    const nav = paginationRow('hl', safePage, totalPages);
        if (nav) inlineKeyboard.push(nav);

        const options = { parse_mode: 'Markdown' };
        if (inlineKeyboard.length > 0) options.reply_markup = { inline_keyboard: inlineKeyboard };

        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
    }
}

// ================== НОВОЕ: НАЧАЛО РЕДАКТИРОВАНИЯ ЗАДАЧИ ==================
async function startEditTask(chatId, taskId) {
    const sess = getSession(sessions, chatId);
    try {
        const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const task = res.data;
        
        sess.taskDraft.editTaskId = taskId;
        sess.taskDraft.title = task['Что делаем?'];
        sess.taskDraft.deadline = task['Когда делаем'] ? new Date(task['Когда делаем']) : null;
        
        sess.state = STATE.WAITING_EDIT_TITLE;
        
        const inlineKeyboard = [
            [{ text: '📅 Изменить срок', callback_data: 'edit_deadline' }],
            [{ text: '❌ Отмена', callback_data: 'edit_cancel' }]
        ];
        
        await bot.sendMessage(chatId, 
            `✏️ *Редактирование задачи #${taskId}*\n\n📝 *Текущее название:*\n${escapeMarkdown(task['Что делаем?'])}\n📅 *Срок:* ${task['Когда делаем'] ? formatMinskDate(task['Когда делаем']) : 'Без срока'}\n\n✏️ *Напиши новое название* (или оставь как есть, нажав "📅 Изменить срок"):`, 
            { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
    }
}

bot.onText(/\/skip/, async (msg) => {
    if (!msg.from || !isAllowed(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Доступ запрещён');
    const chatId = msg.chat.id;
    const sess = getSession(sessions, chatId);
    if (sess.state === STATE.WAITING_CONTACT_NAME) {
        // Если есть известное имя из пересылки — используем его
        const knownName = sess.pendingContactAction.forwardedData?.contactName;
        if (knownName) {
            sess.contactDraft.name = knownName;
            sess.state = STATE.WAITING_CONTACT_PHONE;
            bot.sendMessage(chatId, `✅ Имя: *${escapeMarkdown(knownName)}*\n\nШаг 2️⃣ из 5\n\n📱 *Напиши номер телефона* (или /skip):`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, '❌ Имя обязательно!');
        }
        return;
    }
    if (sess.state === STATE.WAITING_CONTACT_PHONE) {
        sess.contactDraft.phone = null;
        sess.state = STATE.WAITING_CONTACT_USERNAME;
        
        // Если есть известный username из пересылки — показываем его
        const knownUsername = sess.pendingContactAction.forwardedData?.username;
        if (knownUsername) {
            bot.sendMessage(chatId, `⏭️ Телефон пропущен.\n\n🔗 *Username:* @${escapeMarkdown(knownUsername)}\n\n💡 *Введи новый username* или /skip чтобы использовать указанный.`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, '⏭️ Телефон пропущен.\n\n🔗 *Введи Telegram username* (например, @vasiok) или /skip:', { parse_mode: 'Markdown' });
        }
        return;
    }
    if (sess.state === STATE.WAITING_CONTACT_USERNAME) {
        // Если есть известный username из пересылки — используем его
        const knownUsername = sess.pendingContactAction.forwardedData?.username;
        if (knownUsername) {
            sess.contactDraft.username = knownUsername;
        } else {
            sess.contactDraft.username = null;
        }
        sess.state = STATE.WAITING_CONTACT_EMAIL;
        bot.sendMessage(chatId, `⏭️ Username: ${sess.contactDraft.username ? '@' + escapeMarkdown(sess.contactDraft.username) : 'пропущен'}\n\n📧 *Напиши E-mail* (или /skip):`, { parse_mode: 'Markdown' }); return;
    }
    if (sess.state === STATE.WAITING_CONTACT_EMAIL) {
        sess.contactDraft.email = null;
        sess.state = STATE.WAITING_CONTACT_MESSENGER;
        const inlineKeyboard = messengerKeyboard();
        bot.sendMessage(chatId, '⏭️ E-mail пропущен.\n\n💬 *Выбери мессенджер:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }); return;
    }
    if (sess.state === STATE.WAITING_DEADLINE) {
        sess.taskDraft.deadline = null;
        const emp = getEmployee(msg.from.id);
        const role = emp ? emp.Роль : ROLES.EXECUTOR;
        sess.state = STATE.WAITING_PROJECT;
        showProjectSelectionForTask(chatId, msg.from.id, role); return;
    }
    if (sess.state === STATE.WAITING_EDIT_DEADLINE) {
        // /skip при редактировании = убрать срок (название при этом сохраняется)
        try {
            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${sess.taskDraft.editTaskId}`, { 'Что делаем?': sess.taskDraft.title, 'Когда делаем': null }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            invalidateTaskListCache(); // v4.43.1: срок убран — списки задач обновятся
            bot.sendMessage(chatId, `✅ Задача #${sess.taskDraft.editTaskId} обновлена! Срок убран.\n📝 ${sess.taskDraft.title}`);
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
        resetState(chatId);
        return;
    }
    if (sess.state === STATE.WAITING_PROJECT_DEADLINE) {
        const projectId = sess.projectDraft.deadlineProjectId;
        try {
            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Срок проекта': null }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `✅ Срок проекта #${projectId} убран.`);
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
        resetState(chatId);
        return;
    }

    if (sess.state === STATE.WAITING_ITEM_QTY) {
        // v4.42.1: /skip в визарде позиции = кол-во по умолчанию 1
        sess.itemDraft.qty = 1;
        sess.state = STATE.WAITING_ITEM_CONFIRM;
        sendItemDraftPreview(chatId, sess.itemDraft.projectId).catch(() => {});
        return;
    }


    if (sess.pendingContactAction.active && sess.pendingContactAction.waitingPhone) {
        sess.pendingContactAction.waitingPhone = false;
        bot.sendMessage(chatId, '⏭️ Телефон пропущен.');
        showProjectSelectionForContact(chatId, sess.pendingContactAction.contactId); return;
    }
    bot.sendMessage(chatId, '⚠️ Сейчас нечего пропускать.');
});

bot.on('text', async (msg) => {
    const text = msg.text.trim();
    const chatId = msg.chat.id;
    const sess = getSession(sessions, chatId);

    // Центральная авторизация входа (как в командах /start, /tasks, ...).
    // Раньше «незнакомец» (не в кэше сотрудников) получал роль Исполнителя
    // по умолчанию и мог вручную написать кнопку меню («📋 Все задачи» и т.п.) —
    // списки не фильтровались (emp = null → видно всё).
    if (!msg.from || !isAllowed(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Доступ запрещён');

    if (msg.forward_date) return;

    if (text.startsWith('/') && sess.state !== STATE.IDLE) {
        if (text === '/skip' || text === '/cancel') return;
        resetState(chatId);
    }

    // ================== СОСТОЯНИЯ «СВОБОДНОГО ТЕКСТОВОГО ВВОДА» ==================
    // v4.43.1 (гладкость): WAITING_EDIT_VALUE (ввод значения поля карточки) и
    // WAITING_ORG_SEARCH (поиск юрлица для привязки) принимают ЛЮБОЙ текст — его
    // обрабатываем ДО кнопок главного меню. Иначе текст, совпавший с reply-кнопкой
    // («📋 Задачи», «📇 Контакты» …), ушёл бы в меню и молча затёр черновик (resetState).
    // Выход из этих состояний: reply-«⬅️ Назад» (отмена → меню) или /cancel.
    if (sess.state === STATE.WAITING_EDIT_VALUE || sess.state === STATE.WAITING_ORG_SEARCH) {
        const isEditValue = sess.state === STATE.WAITING_EDIT_VALUE;
        const d = isEditValue ? sess.editDraft : sess.orgDraft;
        const hasTarget = isEditValue ? (d && d.id) : (d && d.contactId);
        if (!hasTarget) { resetState(chatId); return; }
        if (text === '⬅️ Назад') {
            resetState(chatId);
            const empL = msg.from ? getEmployee(msg.from.id) : null;
            bot.sendMessage(chatId, '❌ Изменение отменено.');
            sendMainMenu(chatId, null, empL ? empL.Роль : ROLES.EXECUTOR);
            return;
        }
        if (isEditValue) {
            if (d.kind === 'contact') {
                await applyContactFieldEdit(chatId, msg.from.id, d.id, d.field, text);
            } else if (d.kind === 'legal') {
                await applyLegalFieldEdit(chatId, msg.from.id, d.id, d.field, text);
            } else {
                resetState(chatId);
            }
        } else {
            await showFoundLegalsForOrg(chatId, d.contactId, text);
        }
        return;
    }

    // ================== ГЛАВНОЕ МЕНЮ: обработка кнопок ==================
    if (MAIN_MENU_COMMANDS.has(text)) {
        const emp = getEmployee(msg.from.id);
        const role = emp ? emp.Роль : ROLES.EXECUTOR;

        if (sess.state !== STATE.IDLE && text !== '⬅️ Назад') {
            resetState(chatId);
        }

        // Категории подменю (только для Руководителя/Менеджера)
        if (SUBMENU_CATEGORIES[text]) {
            if (role === ROLES.EXECUTOR) {
                return bot.sendMessage(chatId, '⛔ У вас нет доступа к этому разделу.');
            }
            sendSubmenu(chatId, SUBMENU_CATEGORIES[text]);
            return;
        }

        switch (text) {
            case '📝 Новая задача':
                if (!canCreateTask(msg.from.id)) return bot.sendMessage(chatId, '⛔ У вас нет прав для создания задач.');
                sess.state = STATE.WAITING_TITLE;
                bot.sendMessage(chatId, '📝 *Что нужно сделать?*', { parse_mode: 'Markdown' });
                return;
            case '📩 Предложить задачу':
                if (!canSuggestTask(msg.from.id)) return bot.sendMessage(chatId, '⛔');
                sess.state = STATE.WAITING_SUGGEST_TASK;
                bot.sendMessage(chatId, '📩 *Опиши, что нужно сделать:*\n\nРуководитель увидит заявку и назначит исполнителя.', { parse_mode: 'Markdown' });
                return;
            case '📩 Мои заявки':
                if (role === ROLES.EXECUTOR || role === ROLES.MANAGER) {
                    await sendMySuggestions(chatId, msg.from.id, role);
                }
                return;
            case '💬 Комментарий к задаче':
                if (role === ROLES.EXECUTOR) {
                    await showMyTasksForComment(chatId, msg.from.id);
                    sess.state = STATE.WAITING_APPEND_TASK;
                }
                return;
            case '📎 Загрузить файл':
                if (role === ROLES.EXECUTOR) {
                    await showMyTasksForFile(chatId, msg.from.id);
                    sess.state = STATE.WAITING_FILE_TASK;
                } else {
                    // Менеджер/Руководитель — выбор проекта
                    await showProjectsForFile(chatId, msg.from.id, role);
                    sess.state = STATE.WAITING_FILE_TASK;
                }
                return;
            case '📋 Все задачи':
                await sendTaskList(chatId, null, msg.from.id, role);
                return;
            case '📋 Мои задачи':
                await sendTaskList(chatId, null, msg.from.id, ROLES.EXECUTOR);
                return;
            case '📅 На сегодня':
                await sendTodayTasks(chatId, msg.from.id, role);
                return;
            case '📜 История':
                await sendTaskHistory(chatId, msg.from.id, role);
                return;
            case '👤 Добавить контакт':
                if (!canSeeContacts(msg.from.id)) return bot.sendMessage(chatId, '⛔ У вас нет прав.');
                startContactWizard(chatId);
                return;
            case '📇 Контакты':
                if (!canSeeContacts(msg.from.id)) return bot.sendMessage(chatId, '⛔ У вас нет прав.');
                await sendContactsList(chatId, msg.from.id, role);
                return;
            case '🏢 Добавить юрлицо':
                sess.legalDraft = { name: '', email: '', phone: '' };
                sess.state = STATE.WAITING_LEGAL_NAME;
                bot.sendMessage(chatId, `🏢 *Создание юрлица*\n\nШаг 1️⃣ из 3\n\n✏️ *Напиши Краткое Имя:*`, { parse_mode: 'Markdown' });
                return;
            case '🏢 Юрлица':
                if (!canSeeContacts(msg.from.id)) return bot.sendMessage(chatId, '⛔ У вас нет прав.');
                await sendLegalList(chatId, msg.from.id, role);
                return;
            case '📁 Новый проект':
                if (!canCreateProject(msg.from.id)) return bot.sendMessage(chatId, '⛔ У вас нет прав.');
                startProjectWizard(chatId, msg.from.id);
                return;
            case '📚 Проекты':
                await sendProjectsList(chatId, msg.from.id, role);
                return;
            case '📦 Создать папку':
                if (role !== ROLES.EXECUTOR) {
                    await showProjectsForFolder(chatId, msg.from.id, role);
                    sess.state = STATE.WAITING_CREATE_FOLDER;
                }
                return;
            case '🗄 Архив':
                if (!canSeeProjects(msg.from.id) || role === ROLES.EXECUTOR) return bot.sendMessage(chatId, '⛔ У вас нет доступа к архиву проектов.');
                await sendArchivedProjects(chatId, msg.from.id, role);
                return;
            case '🔄 Файлы проекта':
                if (role !== ROLES.EXECUTOR) {
                    await showProjectsForFilesList(chatId, msg.from.id, role);
                    sess.state = STATE.WAITING_SHOW_FILES;
                }
                return;
            case '📊 Статус':
                if (!canSeeStatus(msg.from.id)) return bot.sendMessage(chatId, '⛔ У вас нет прав.');
                await sendSystemStatus(chatId);
                return;
            case '💾 Бэкапы':
                if (!canSeeBackups(msg.from.id)) return bot.sendMessage(chatId, '⛔ У вас нет прав.');
                await sendBackupStatus(chatId);
                return;
            case '⬅️ Назад':
                resetState(chatId);
                sendMainMenu(chatId, null, role);
                return;
        }
    }

    // ================== ПРЕДЛОЖИТЬ ЗАДАЧУ ==================
    if (sess.state === STATE.WAITING_SUGGEST_TASK) {
        if (!text || text.length < 2) return bot.sendMessage(chatId, '❌ Слишком короткое описание.');
        const emp = getEmployee(msg.from.id);
        try {
            const payload = {
                'Что делаем?': text,
                'Готово': false,
                'Кто предложил': [{ Id: emp.Id }]
            };
            const res = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
            invalidateTaskListCache(); // v4.43.1: заявка создана — «Мои заявки»/руководитель увидят её сразу
            bot.sendMessage(chatId, `✅ Заявка создана! #${res.data.Id}\n\nРуководитель увидит и назначит исполнителя.`, { parse_mode: 'Markdown' });

            // Уведомить Руководителя
            for (const [tid, e] of employeesCache.entries()) {
                if (e.Роль === ROLES.ADMIN) {
                    const inlineKeyboard = [
                        [{ text: '✅ Назначить исполнителя', callback_data: `assign_exec_${res.data.Id}` }],
                        [{ text: '📋 Оставить общей', callback_data: `keep_common_${res.data.Id}` }],
                        [{ text: '❌ Отклонить', callback_data: `reject_task_${res.data.Id}` }]
                    ];
                    bot.sendMessage(tid, `📨 *Новая заявка от ${emp.Обращение}*\n\n📝 ${text}\n🆔 Задача #${res.data.Id}`, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: inlineKeyboard }
                    });
                }
            }
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
        resetState(chatId);
        return;
    }

    // ================== КОММЕНТАРИЙ К ЗАДАЧЕ (текст) ==================
    if (sess.state === STATE.WAITING_COMMENT_TEXT) {
        if (!text || text.length < 2) return bot.sendMessage(chatId, '❌ Комментарий слишком короткий.');
        try {
            await appendTaskDetails(sess.taskDraft.commentTaskId, text, 'comment');
            bot.sendMessage(chatId, `✅ Комментарий добавлен к задаче #${sess.taskDraft.commentTaskId}!`, { parse_mode: 'Markdown' });
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
        resetState(chatId);
        return;
    }

    // ================== ЗАМЕТКА К ПРОЕКТУ (v4.18.0) ==================
    if (sess.state === STATE.WAITING_PROJECT_NOTE) {
        if (!text || text.length < 2) return bot.sendMessage(chatId, '❌ Заметка слишком короткая.');
        try {
            const projectId = sess.projectDraft.noteProjectId;
            if (!projectId) { resetState(chatId); return; }
            const emp = getEmployee(msg.from.id);
            const empName = emp?.Имя || 'Сотрудник';
            const dateStr = formatMinskDate(new Date().toISOString());
            const projRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const oldDetails = String(projRes.data['Подробности'] || '').trim();
            const logEntry = `📝 Заметка (${empName}, ${dateStr}): ${text}`;
            const newDetails = oldDetails ? `${oldDetails}\n\n${logEntry}` : logEntry;
            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Подробности': newDetails }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `✅ Заметка добавлена к проекту #${projectId}!`);
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
        resetState(chatId);
        return;
    }

    // ================== ВИЗАРД ПОЗИЦИИ ЗАКАЗА (v4.42.1, Волна A) ==================
    // Шаги: тип (кнопки pitem_type_*) → название (text) → единица (кнопки pitem_unit_*)
    // → цена (text, платные типы) → кол-во (text, дефолт 1) → превью (pitem_save/cancel).
    // Редактирование существующей позиции (pitem_price_/pitem_qty_) — через WAITING_ITEM_EDIT.
    if (sess.state === STATE.WAITING_ITEM_NAME) {
        if (!text || text.length < 2) return bot.sendMessage(chatId, '❌ Название слишком короткое.');
        sess.itemDraft.name = text.trim();
        sess.state = STATE.WAITING_ITEM_UNIT;
        bot.sendMessage(chatId, `🧮 *Единица измерения?*`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: itemUnitKeyboard(sess.itemDraft.projectId) }
        });
        return;
    }

    if (sess.state === STATE.WAITING_ITEM_PRICE) {
        const price = parseMoneyInput(text);
        if (isNaN(price) || price < 0) return bot.sendMessage(chatId, '❌ Введи цену числом, например: *45* или *45,50*.');
        sess.itemDraft.price = price;
        sess.state = STATE.WAITING_ITEM_QTY;
        bot.sendMessage(chatId, '🧮 *Кол-во?* (по умолчанию 1 — нажми /skip)', { parse_mode: 'Markdown' });
        return;
    }

    if (sess.state === STATE.WAITING_ITEM_QTY) {
        let qty = 1;
        if (text !== '/skip') {
            qty = parseMoneyInput(text);
            if (isNaN(qty) || qty <= 0) return bot.sendMessage(chatId, '❌ Введи кол-во числом больше 0, или /skip для 1.');
        }
        sess.itemDraft.qty = qty;
        sess.state = STATE.WAITING_ITEM_CONFIRM;
        await sendItemDraftPreview(chatId, sess.itemDraft.projectId);
        return;
    }

    if (sess.state === STATE.WAITING_ITEM_CONFIRM) {
        return bot.sendMessage(chatId, 'Нажми «✅ Сохранить» или «❌ Отмена» на превью выше.');
    }

    if (sess.state === STATE.WAITING_ITEM_EDIT) {
        const d = sess.itemDraft;
        if (!d.itemId || !d.projectId) { resetState(chatId); return; }
        const val = parseMoneyInput(text);
        const isQty = d.editField === 'qty';
        if (isNaN(val)) return bot.sendMessage(chatId, '❌ Введи число.');
        if (!isQty && val < 0) return bot.sendMessage(chatId, '❌ Цена не может быть отрицательной.');
        if (isQty && val <= 0) return bot.sendMessage(chatId, '❌ Кол-во должно быть больше 0.');
        try {
            const field = isQty ? 'Кол-во' : 'Цена';
            await noco.updateRow(config.TABLES.ITEMS, d.itemId, { [field]: val });
            noco.invalidateTable(config.TABLES.ITEMS);
            const itemId = d.itemId;
            const projectId = d.projectId;
            resetState(chatId);
            bot.sendMessage(chatId, `✅ ${field} обновлено.`);
            await sendProjectItemDetails(chatId, null, itemId, projectId);
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
            resetState(chatId);
        }
        return;
    }


    // ================== ПРИМЕЧАНИЕ К ДОКУМЕНТУ (v4.42.2) ==================
    if (sess.state === STATE.WAITING_DOC_NOTE) {
        const projectId = sess.docDraft && sess.docDraft.projectId;
        if (!projectId) { resetState(chatId); return; }
        if (text === '/skip') sess.docDraft.note = '';
        else {
            if (!text || text.length < 2) return bot.sendMessage(chatId, '❌ Примечание слишком короткое (или /skip — без примечания).');
            sess.docDraft.note = text.trim();
        }
        sess.state = STATE.IDLE;
        bot.sendMessage(chatId, sess.docDraft.note ? '📌 Примечание сохранено.' : 'Примечание не добавлено.');
        sendDocCreateConfirm(chatId, projectId);
        return;
    }

    // ================== ВНЕСЕНИЕ ОПЛАТЫ (v4.42.4) ==================
    if (sess.state === STATE.WAITING_PAYMENT_AMOUNT) {
        const projectId = sess.payDraft && sess.payDraft.projectId;
        if (!projectId) { resetState(chatId); return; }
        const amount = parseMoneyInput(text);
        if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, '❌ Введи сумму больше 0, например: *620* или *310,50*.', { parse_mode: 'Markdown' });
        try {
            const fmtMoney = (n) => parseFloat(n || 0).toFixed(2).replace(/\.00$/, '').replace('.', ',');
            const projRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const p = projRes.data;
            const oldReceived = parseFloat(String(p['Предоплата']).replace(',', '.')) || 0;
            const newReceived = oldReceived + amount;
            const summary = await getProjectSummary(projectId);
            const total = summary.itemsTotalWithVat || 0;
            const nextStatus = (total > 0 && newReceived >= total - 0.005) ? 'Оплачен' : (newReceived > 0 ? 'Частично' : '');

            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Предоплата': newReceived, 'По деньгам?': nextStatus }, { headers: { 'xc-token': config.NOCO_TOKEN, 'Content-Type': 'application/json' } });
            // Аудит в «Подробности»
            const empName = (getEmployee(msg.from.id) && getEmployee(msg.from.id).Имя) || 'Сотрудник';
            const dateStr = formatMinskDate(new Date().toISOString());
            const oldDetails = String(p['Подробности'] || '').trim();
            const logEntry = `💵 Поступило: ${fmtMoney(amount)} BYN (${empName}, ${dateStr}). Всего получено: ${fmtMoney(newReceived)} BYN · статус «${nextStatus || '—'}»`;
            const newDetails = oldDetails ? `${oldDetails}\n\n${logEntry}` : logEntry;
            try {
                await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Подробности': newDetails }, { headers: { 'xc-token': config.NOCO_TOKEN, 'Content-Type': 'application/json' } });
            } catch (e) { console.log('⚠️ Аудит оплаты не записан:', e.message); }
            noco.invalidateTable(config.TABLES.PROJECTS);
            resetState(chatId);
            bot.sendMessage(chatId, `✅ Оплата зафиксирована: поступило *${fmtMoney(amount)} BYN*, всего получено *${fmtMoney(newReceived)} BYN*.${nextStatus ? `\n🏷 «По деньгам?»: ${nextStatus}` : ''}`, { parse_mode: 'Markdown' });
            await sendPaymentMenu(chatId, null, projectId);
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
            resetState(chatId);
        }
        return;
    }

    // ================== СРОК ПРОЕКТА (v4.18.0) ==================
    if (sess.state === STATE.WAITING_PROJECT_DEADLINE) {
        const projectId = sess.projectDraft.deadlineProjectId;
        if (!projectId) { resetState(chatId); return; }
        if (text === '/skip' || text === 'без срока' || text.toLowerCase().startsWith('нет')) {
            try {
                await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Срок проекта': null }, { headers: { 'xc-token': config.NOCO_TOKEN } });
                bot.sendMessage(chatId, `✅ Срок проекта #${projectId} убран.`);
            } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
            resetState(chatId);
            return;
        }
        const parsed = parseSmartDeadline(text);
        if (!parsed) return bot.sendMessage(chatId, '❌ Не понял дату. Например: *17.09*, *завтра*, *05.09.2026*. Или «без срока».', { parse_mode: 'Markdown' });
        try {
            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Срок проекта': parsed.toISOString() }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `✅ Срок проекта #${projectId}: *${escapeMarkdown(formatMinskDate(parsed))}*`, { parse_mode: 'Markdown' });
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
        resetState(chatId);
        return;
    }

    // ================== ДОБАВИТЬ К ЗАДАЧЕ (после пересылки, выбор задачи) ==================
    if (sess.state === STATE.WAITING_APPEND_TASK) {
        // Этот state обрабатывается через inline-кнопки comment_task_
        return;
    }

    // ================== НОВОЕ: РЕДАКТИРОВАНИЕ ЗАДАЧИ ==================
    if (sess.state === STATE.WAITING_EDIT_TITLE) {
        if (!text || text.length < 2) return bot.sendMessage(chatId, '❌ Название слишком короткое.');
        sess.taskDraft.title = text;
        sess.state = STATE.WAITING_EDIT_DEADLINE;
        await sendDeadlinePicker(chatId, 'edit', `✅ Новое название: *${escapeMarkdown(text)}*`);
        return;
    }
    
    if (sess.state === STATE.WAITING_EDIT_DEADLINE) {
        const parsed = parseSmartDeadline(text);
        if (parsed) {
            if (parsed.getTime() <= Date.now()) {
                return bot.sendMessage(chatId, '⏰ Это время уже прошло. Укажи будущую дату, например: завтра, 17.06 14:00.');
            }
            sess.taskDraft.deadline = parsed;
            try {
                await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${sess.taskDraft.editTaskId}`, { 
                    'Что делаем?': sess.taskDraft.title, 
                    'Когда делаем': parsed.toISOString() 
                }, { headers: { 'xc-token': config.NOCO_TOKEN } });
                invalidateTaskListCache(); // v4.43.1: дедлайн обновлён — списки задач перерисуются свежими
                resetReminderState(sess.taskDraft.editTaskId); // v4.27.0: новый дедлайн = новые напоминания

                bot.sendMessage(chatId, `✅ *Задача #${sess.taskDraft.editTaskId} обновлена!*\n\n📝 ${sess.taskDraft.title}\n📅 ${formatMinskDate(parsed)}`, { parse_mode: 'Markdown' });
            } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
            resetState(chatId);
        } else {
            bot.sendMessage(chatId, '❌ Не понял дату. Укажи понятно, например: *17.06*, *17.06 14:00*, «завтра», «через 3 часа».', { parse_mode: 'Markdown' });
        }
        return;
    }

    if (sess.state === STATE.WAITING_CONTACT_SEARCH) {
        await searchContacts(chatId, text);
        sess.state = STATE.WAITING_PROJECT_CONTACT;
        return;
    }

    if (sess.state === STATE.WAITING_PROJECT_LEGAL_SEARCH) {
        await searchLegalEntities(chatId, text);
        sess.state = STATE.WAITING_PROJECT_CONTACT;
        return;
    }

    // 🆕 v4.16.0: АВТОПОИСК — в состоянии выбора клиента любой текст сразу запускает поиск по активной вкладке
    if (sess.state === STATE.WAITING_PROJECT_CONTACT) {
        if (text.length < 2) return;
        if (sess.projectDraft.tab === 'legal') {
            await searchLegalEntities(chatId, text);
        } else if (sess.projectDraft.tab === 'all') {
            await searchAllClients(chatId, text);
        } else {
            await searchContacts(chatId, text);
        }
        return;
    }

    if (sess.state === STATE.WAITING_PROJECT_TITLE) {
        if (!text || text.length < 2) return bot.sendMessage(chatId, '❌ Название слишком короткое.');
        sess.projectDraft.title = text;
        // 🆕 v4.25.0: защита от дублей — уже есть активный проект с таким названием?
        try {
            const dup = await findProjectDuplicate(text);
            if (dup) {
                sess.projectDraft.dupProjectId = dup.Id;
                const inlineKeyboard = [
                    [{ text: `✅ Это он (#${dup.Id})`, callback_data: 'dup_use_existing' }],
                    [{ text: '➕ Всё равно создать новый', callback_data: 'dup_create_anyway' }]
                ];
                await bot.sendMessage(chatId, `⚠️ *Уже есть активный проект с таким названием:*\n\n📁 #${dup.Id} ${escapeMarkdown(dup['Что делаем?'])}\n\nЭто тот же проект?`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
                return;
            }
        } catch (e) { console.log(`⚠️ Ошибка проверки дублей проекта: ${e.message}`); }
        // из флоу контакта клиент уже известен — пропускаем шаг выбора
        if (sess.projectDraft.source === 'contact' && sess.projectDraft.contactId) {
            await showProjectStep3(chatId, msg.from.id);
            return;
        }
        showContactSelectionForProject(chatId);
        return;
    }

    if (sess.state === STATE.WAITING_PROJECT_TASK) {
        sess.taskDraft.title = text;
        console.log(`📝 WAITING_PROJECT_TASK: title=${text}, projectId=${sess.taskDraft.projectId}`);
        sess.state = STATE.WAITING_DEADLINE;
        await sendDeadlinePicker(chatId, 'create', `📝 *Задача: ${escapeMarkdown(text)}*`);
        return;
    }

    if (sess.state === STATE.WAITING_CONTACT_NAME) {
        if (!text || text.length < 2) return bot.sendMessage(chatId, '❌ Имя слишком короткое.');
        sess.contactDraft.name = text;
        sess.state = STATE.WAITING_CONTACT_PHONE;
        bot.sendMessage(chatId, `✅ Имя: *${text}*\n\nШаг 2️⃣ из 5\n\n📱 *Напиши номер телефона* (или /skip):`, { parse_mode: 'Markdown' });
        return;
    }

    if (sess.state === STATE.WAITING_CONTACT_PHONE) {
        sess.contactDraft.phone = /[\d\+\-\(\)\s]{7,}/.test(text) ? text.trim() : null;
        
        if (sess.contactDraft.phone) {
            const duplicate = await findDuplicateContact(null, sess.contactDraft.phone, null);
            if (duplicate) {
                const inlineKeyboard = [
                    [{ text: '✅ Использовать существующий', callback_data: 'use_existing_contact' }],
                    [{ text: '➕ Всё равно создать нового', callback_data: 'create_new_anyway' }]
                ];
                bot.sendMessage(chatId, `⚠️ *Контакт с таким номером уже есть!*\n\n👤 *${escapeMarkdown(duplicate['Имя'])}*\n📱 ${escapeMarkdown(duplicate['Телефон'])}\n\nЧто делаем?`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
                sess.pendingContactAction.duplicateContact = duplicate;
                sess.pendingContactAction.waitingDuplicateResolve = true;
                sess.state = STATE.IDLE;
                return;
            }
        }
        
        sess.state = STATE.WAITING_CONTACT_USERNAME;
        
        // Если есть известный username из пересылки — показываем его
        const knownUsername = sess.pendingContactAction.forwardedData?.username;
        if (knownUsername) {
            bot.sendMessage(chatId, `✅ Телефон: *${sess.contactDraft.phone || 'пропущен'}*\n\nШаг 3️⃣ из 5\n\n🔗 *Username:* @${escapeMarkdown(knownUsername)}\n\n💡 *Введи новый username* или /skip чтобы использовать указанный.`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, `✅ Телефон: *${sess.contactDraft.phone || 'пропущен'}*\n\nШаг 3️⃣ из 5\n\n🔗 *Введи Telegram username* (например, @vasiok) или /skip:`, { parse_mode: 'Markdown' });
        }
        return;
    }

    if (sess.state === STATE.WAITING_CONTACT_USERNAME) {
        const usernameMatch = text.match(/@?([a-zA-Z0-9_]{3,})/);
        if (usernameMatch) {
            sess.contactDraft.username = usernameMatch[1];
            
            const duplicate = await findDuplicateContact(null, null, sess.contactDraft.username);
            if (duplicate) {
                const inlineKeyboard = [
                    [{ text: '✅ Использовать существующий', callback_data: 'use_existing_contact' }],
                    [{ text: '➕ Всё равно создать нового', callback_data: 'create_new_anyway_username' }]
                ];
                bot.sendMessage(chatId, `⚠️ *Контакт с таким username уже есть!*\n\n👤 *${escapeMarkdown(duplicate['Имя'])}*\n🔗 ${escapeMarkdown(duplicate['Ссылка'])}\n\nЧто делаем?`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
                sess.pendingContactAction.duplicateContact = duplicate;
                sess.pendingContactAction.waitingDuplicateResolve = true;
                sess.state = STATE.IDLE;
                return;
            }
            
            sess.state = STATE.WAITING_CONTACT_EMAIL;
            bot.sendMessage(chatId, `✅ Username: *@${sess.contactDraft.username}*\n🔗 Ссылка: https://t.me/${sess.contactDraft.username}\n\nШаг 4️⃣ из 5\n\n📧 *Напиши E-mail* (или /skip):`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, '❌ Не похоже на username. Формат: @vasiok или vasiok. Или /skip.');
        }
        return;
    }

    if (sess.state === STATE.WAITING_CONTACT_EMAIL) {
        sess.contactDraft.email = (text.includes('@') && text.includes('.')) ? text.trim() : null;
        sess.state = STATE.WAITING_CONTACT_MESSENGER;
        const inlineKeyboard = messengerKeyboard();
        bot.sendMessage(chatId, `✅ E-mail: *${sess.contactDraft.email || 'пропущен'}*\n\nШаг 5️⃣ из 5\n\n💬 *Выбери мессенджер:*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        return;
    }

    // v4.25.0: старый флоу «проект из задачи» (WAITING_PROJECT_NAME + 'pending_new') удалён —
    // кнопка create_new_project_for_task теперь ведёт в единый визард startProjectWizard({source:'task'}).

    // ================== WIZARD ЮРЛИЦА ==================
    if (sess.state === STATE.WAITING_LEGAL_NAME) {
        if (!text || text.length < 2) return bot.sendMessage(chatId, '❌ Имя слишком короткое.');
        sess.legalDraft.name = text;
        sess.state = STATE.WAITING_LEGAL_EMAIL;
        bot.sendMessage(chatId, `✅ Краткое Имя: *${text}*\n\nШаг 2️⃣ из 3\n\n📧 *Напиши E-mail:*`, { parse_mode: 'Markdown' });
        return;
    }
    if (sess.state === STATE.WAITING_LEGAL_EMAIL) {
        if (text === '/skip') {
            sess.legalDraft.email = null;
            sess.state = STATE.WAITING_LEGAL_PHONE;
            return bot.sendMessage(chatId, `⏭️ E-mail пропущен.\n\nШаг 3️⃣ из 3\n\n📱 *Напиши телефон:*`, { parse_mode: 'Markdown' });
        }
        sess.legalDraft.email = text.includes('@') ? text.trim() : null;
        sess.state = STATE.WAITING_LEGAL_PHONE;
        bot.sendMessage(chatId, `✅ E-mail: *${sess.legalDraft.email || 'пропущен'}*\n\nШаг 3️⃣ из 3\n\n📱 *Напиши телефон:*`, { parse_mode: 'Markdown' });
        return;
    }
    if (sess.state === STATE.WAITING_LEGAL_PHONE) {
        if (text === '/skip') sess.legalDraft.phone = null;
        else sess.legalDraft.phone = text.trim();
        try {
            const payload = { 'Краткое Имя': sess.legalDraft.name };
            if (sess.legalDraft.email) payload['E-mail'] = sess.legalDraft.email;
            if (sess.legalDraft.phone) payload['Телефон'] = sess.legalDraft.phone;

            const res = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.LEGAL_ENTITIES}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `✅ *Юрлицо создано!*\n\n🏢 *${escapeMarkdown(sess.legalDraft.name)}*\n📧 ${escapeMarkdown(sess.legalDraft.email || '—')}\n📱 ${escapeMarkdown(sess.legalDraft.phone)}\n🆔 ID: ${res.data.Id}\n\n⚠️ *Не забудь:* заполни полные реквизиты в NocoDB (ИНН, адрес, банк).`, { parse_mode: 'Markdown' });

            if (sess.pendingContactAction.afterContactCreated === 'back_to_project') {
                // Возврат в визард проекта — привязываем созданное юрлицо
                sess.projectDraft.legalId = res.data.Id;
                sess.projectDraft.contactId = null;
                sess.projectDraft.tab = 'legal';
                sess.pendingContactAction.afterContactCreated = null;
                await showProjectStep3(chatId, msg.from.id);
            } else {
                resetState(chatId);
            }
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); resetState(chatId); }
        return;
    }

    if (text.startsWith('/')) return;

    if (sess.state === STATE.WAITING_TITLE) {
        sess.taskDraft.title = text;
        sess.state = STATE.WAITING_DEADLINE;
        await sendDeadlinePicker(chatId, 'create', `📝 *Задача: ${escapeMarkdown(text)}*`);
        return;
    }

    if (sess.state === STATE.WAITING_DEADLINE) {
        const parsed = parseSmartDeadline(text);
        if (parsed) {
            if (parsed.getTime() <= Date.now()) {
                return bot.sendMessage(chatId, '⏰ Это время уже прошло. Укажи будущую дату, например: завтра, 17.06 14:00.');
            }
            await handleTaskDeadlineChosen(chatId, msg.from.id, parsed);
        } else {
            const inlineKeyboard = [
                [{ text: '🚫 Без срока', callback_data: 'dl_none' }]
            ];
            bot.sendMessage(chatId, '❌ Не понял дату. Укажи понятно, например: *17.06*, *17.06 14:00*, «завтра», «через 3 часа».', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        return;
    }

    // v4.25.0: старый флоу «проект для контакта» (waitingNewProjectName) удалён —
    // кнопка proj_new_for_contact теперь ведёт в единый визард startProjectWizard({source:'contact'}).

    if (sess.pendingContactAction.active && sess.pendingContactAction.waitingPhone) {
        if (/[\d\+\-\(\)\s]{7,}/.test(text)) {
            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${sess.pendingContactAction.contactId}`, { 'Телефон': text }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `✅ Телефон *${text}* сохранен! 📱`, { parse_mode: 'Markdown' });
            sess.pendingContactAction.waitingPhone = false;
            showProjectSelectionForContact(chatId, sess.pendingContactAction.contactId);
        } else { bot.sendMessage(chatId, '❌ Не похоже на телефон.'); }
        return;
    }
});

// ================== НАДЁЖНОСТЬ: RETRY + «НИКОГДА НЕ МОЛЧИ» (v4.24.0) ==================
// withRetry: повтор асинхронной операции (3 попытки, задержка 1s/2s) — файл не теряется
// при кратковременном сбое сети или рестарте webhook.
// Проблема 90: ретраим ТОЛЬКО временные сбои — сетевые ошибки (нет err.response) и 5xx.
// Гарантированные 4xx (400/403/404: «не указан клиент», «неверный секрет», 404 роута)
// прерываем сразу: ретрай бессмыслен, а пользователь не должен ждать 3 попытки.
function isRetryableError(err) {
    const status = err.response?.status;
    if (!status) return true;   // ECONNREFUSED / ECONNRESET / ETIMEDOUT / timeout — пробуем ещё
    return status >= 500;       // 5xx — серверная проблема, возможен рестарт webhook
}

async function withRetry(fn, attempts = 3, delayMs = 1000) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isRetryableError(err)) throw err;
            if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs * (2 ** i)));
        }
    }
    throw lastErr;
}

// withTimeout: ограничение времени ожидания асинхронной операции (Проблема 91).
// bot.getFileLink() и скачивание с Telegram не имеют собственного таймаута — зависший
// Telegram CDN без этого вешал бота на «⏳ Файл загружается...» бесконечно.
function withTimeout(promise, ms, message = 'Превышено время ожидания') {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
    ]);
}

const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB — лимит multer в webhook (webhook/server.js)

// Подсказка при файле вне флоу загрузки — с троттлингом 5 минут на пользователя:
// «никогда не молчим», но и не спамим тех, кто кидает боту файлы просто так.
const lastFileHint = new Map();
function sendFileHint(chatId, telegramId) {
    const now = Date.now();
    if (now - (lastFileHint.get(telegramId) || 0) < 5 * 60 * 1000) return;
    lastFileHint.set(telegramId, now);
    bot.sendMessage(chatId, '📎 Чтобы загрузить файл в папку проекта: меню «📂 Файлы» → «📎 Загрузить файл».').catch(() => {});
}

// v4.30.0: безопасная отправка Markdown. Раньше имя файла или путь с '_' (а файлы webhook
// сохраняет как «время_имя.pdf») ломали Markdown v1 → Telegram 400, а sendMessage без await/.catch
// молча глотал ошибку: файл сохранялся, а «✅ Файл сохранён» до пользователя НЕ доходило.
// Теперь пробуем Markdown, при ошибке шлём plain text (паттерн v4.21.2), никогда не молчим.
async function safeSendMarkdown(chatId, text, options = {}) {
    try {
        return await bot.sendMessage(chatId, text, { ...options, parse_mode: 'Markdown' });
    } catch (err) {
        console.error('❌ Markdown send failed, fallback to plain text:', err.message);
        return await bot.sendMessage(chatId, plainTextFromMarkdown(text), { reply_markup: options.reply_markup });
    }
}


// ================== ОБРАБОТКА ФАЙЛОВ (загрузка к задаче) ==================
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const sess = getSession(sessions, chatId);
    // «Никогда не молчи»: файл вне флоу загрузки — подсказка вместо тихого игнора
    if (sess.state !== STATE.WAITING_FILE_UPLOAD) {
        if (msg.from) sendFileHint(chatId, msg.from.id);
        return;
    }
    const emp = getEmployee(msg.from.id);
    // Роль здесь НЕ проверяем: цель уже ограничена меню — Исполнитель выбирает свою задачу,
    // Менеджер/Руководитель выбирают проект. Повторный чек роли молча игнорировал
    // файлы Менеджера/Руководителя (симптом «отправил файл — тишина»).
    if (!emp) return;

    try {
        const taskId = sess.taskDraft.fileTaskId;
        // Менеджер/Руководитель грузят напрямую в проект (fileProjectId), Исполнитель — к задаче (fileTaskId).
        if (!taskId && !sess.taskDraft.fileProjectId) {
            return bot.sendMessage(chatId, '❌ Ошибка: задача или проект не выбраны. Начните заново через меню «📎 Загрузить файл».');
        }

        const fileName = msg.document.file_name || `file_${Date.now()}`;
        const fileSizeBytes = msg.document.file_size || 0;
        const fileSize = (fileSizeBytes / 1024).toFixed(1);

        // 🛡️ Проблема 91: проверяем лимит ДО скачивания — webhook принимает максимум 50MB.
        // Раньше бот сначала качал весь файл с Telegram (минуты ожидания), а потом получал 413.
        if (fileSizeBytes > MAX_UPLOAD_SIZE) {
            // v4.30.0: escapeMarkdown + safeSendMarkdown — имя файла с '_' ломало Markdown v1
            await safeSendMarkdown(chatId, `❌ Файл *${escapeMarkdown(fileName)}* (${(fileSizeBytes / 1024 / 1024).toFixed(1)} МБ) больше лимита 50 МБ.\n\nПришли файл до 50 МБ или положи его в папку проекта через Samba-шару.`);
            resetState(chatId);
            return;
        }

        await safeSendMarkdown(chatId, `⏳ Файл *${escapeMarkdown(fileName)}* (${fileSize} КБ) загружается...`);

        // Скачиваем файл (таймаут 60с — зависший Telegram CDN не должен вешать загрузку вечно)
        const fileId = msg.document.file_id;
        const fileLink = await withTimeout(bot.getFileLink(fileId), 30000);
        // Ретрай: кратковременный сбой Telegram/сети не должен терять файл
        const response = await withRetry(() => axios.get(fileLink, { responseType: 'arraybuffer', timeout: 60000 }), 3, 1000);

        // Загружаем на webhook
        const FormData = require('form-data');
        const formData = new FormData();
        formData.append('file', Buffer.from(response.data), { filename: fileName });
        if (sess.taskDraft.fileTaskId) formData.append('taskId', sess.taskDraft.fileTaskId);
        if (sess.taskDraft.fileProjectId) formData.append('projectId', sess.taskDraft.fileProjectId);
        // Идемпотентность (Проблема 91): ключ = контекст:имя:размер. При ретрае webhook
        // вернёт уже сохранённый файл вместо дубля, если предыдущая попытка успела записать.
        formData.append('clientFileId', `${sess.taskDraft.fileTaskId || sess.taskDraft.fileProjectId || 'x'}:${fileName}:${fileSizeBytes}`);
        formData.append('secret', process.env.WEBHOOK_SECRET || '');

        // Ретрай: webhook может перезапускаться — файл не должен теряться
        const uploadRes = await withRetry(() => axios.post(`${WEBHOOK_URL}/upload-file`, formData, {
            headers: { ...formData.getHeaders() },
            timeout: 30000
        }), 3, 1000);

        // В «Подробности» пишем только если грузили к задаче (у проекта нет Подробностей загрузки).
        // Отдельный try/catch (Проблема 91): файл УЖЕ сохранён — сбой записи в Подробности
        // не должен превращать успешную загрузку в ошибку.
        if (taskId) {
            try {
                await appendTaskDetails(taskId, `📎 Файл: ${fileName} (${fileSize} КБ) → ${uploadRes.data.fileName}`, 'file');
            } catch (detailsErr) {
                console.error('⚠️ Файл сохранён, но не удалось записать в Подробности:', detailsErr.message);
            }
        }

        // v4.30.0: главный фикс «файл сохранился, а уведомление не пришло» — путь/имя экранируем,
        // отправка безопасная и awaited (раньше fire-and-forget молча глотал 400 Markdown).
        await safeSendMarkdown(chatId, `✅ Файл *${escapeMarkdown(fileName)}* сохранён в папку проекта!\n\n📁 ${escapeMarkdown(uploadRes.data.path)}`);
    } catch (err) {
        console.error('File upload error:', err.message);
        const errorMsg = err.response?.data?.error || err.message;
        let userMsg = `❌ Ошибка загрузки: ${errorMsg}`;
        if (errorMsg.includes('не привязана к проекту')) {
            userMsg = '❌ Задача не привязана к проекту — некуда сохранить файл.\n\nПопроси Руководителя привязать задачу к проекту.';
        } else if (errorMsg.includes('Не указан клиент')) {
            userMsg = '❌ У проекта не указан клиент (Контакт или Юрлицо) — папку создать нельзя, файл некуда сохранить.\n\n💡 Привяжи клиента в карточке проекта и попробуй снова.';
        } else if (errorMsg.includes('секрет')) {
            userMsg = '❌ Ошибка авторизации. Попробуй ещё раз.';
        }
        await safeSendMarkdown(chatId, userMsg);
    }
    resetState(chatId);
});

bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const sess = getSession(sessions, chatId);
    // «Никогда не молчи»: фото вне флоу загрузки — подсказка вместо тихого игнора
    if (sess.state !== STATE.WAITING_FILE_UPLOAD) {
        if (msg.from) sendFileHint(chatId, msg.from.id);
        return;
    }
    const emp = getEmployee(msg.from.id);
    // Роль здесь НЕ проверяем (см. bot.on('document')) — иначе файлы Менеджера/Руководителя
    // молча игнорируются, хотя выбор проекта им уже предложен меню.
    if (!emp) return;

    try {
        const taskId = sess.taskDraft.fileTaskId;
        // Менеджер/Руководитель грузят напрямую в проект (fileProjectId), Исполнитель — к задаче (fileTaskId).
        if (!taskId && !sess.taskDraft.fileProjectId) {
            return bot.sendMessage(chatId, '❌ Ошибка: задача или проект не выбраны. Начните заново через меню «📎 Загрузить файл».');
        }

        const photoObj = msg.photo[msg.photo.length - 1];
        const photoSizeBytes = photoObj.file_size || 0;

        // 🛡️ Проблема 91: лимит 50MB проверяем ДО скачивания (фото с современных камер бывают большими)
        if (photoSizeBytes > MAX_UPLOAD_SIZE) {
            // v4.30.0: безопасная отправка (см. документ-хендлер)
            await safeSendMarkdown(chatId, `❌ Фото (${(photoSizeBytes / 1024 / 1024).toFixed(1)} МБ) больше лимита 50 МБ.\n\nПришли фото до 50 МБ или положи его в папку проекта через Samba-шару.`);
            resetState(chatId);
            return;
        }

        await bot.sendMessage(chatId, `⏳ Фото загружается...`, { parse_mode: 'Markdown' });

        const fileId = photoObj.file_id;
        const fileLink = await withTimeout(bot.getFileLink(fileId), 30000);
        // Ретрай: кратковременный сбой Telegram/сети не должен терять файл
        const response = await withRetry(() => axios.get(fileLink, { responseType: 'arraybuffer', timeout: 60000 }), 3, 1000);
        const fileName = `photo_${Date.now()}.jpg`;

        const FormData = require('form-data');
        const formData = new FormData();
        formData.append('file', Buffer.from(response.data), { filename: fileName });
        if (sess.taskDraft.fileTaskId) formData.append('taskId', sess.taskDraft.fileTaskId);
        if (sess.taskDraft.fileProjectId) formData.append('projectId', sess.taskDraft.fileProjectId);
        // Идемпотентность (Проблема 91) — как в document-хендлере
        formData.append('clientFileId', `${sess.taskDraft.fileTaskId || sess.taskDraft.fileProjectId || 'x'}:${fileName}:${photoSizeBytes}`);
        formData.append('secret', process.env.WEBHOOK_SECRET || '');

        // Ретрай: webhook может перезапускаться — файл не должен теряться
        const uploadRes = await withRetry(() => axios.post(`${WEBHOOK_URL}/upload-file`, formData, {
            headers: { ...formData.getHeaders() },
            timeout: 30000
        }), 3, 1000);

        // В «Подробности» пишем только если грузили к задаче (у проекта нет Подробностей загрузки).
        // Отдельный try/catch: фото УЖЕ сохранено — сбой записи не превращает успех в ошибку.
        if (taskId) {
            try {
                await appendTaskDetails(taskId, `📷 Фото: ${uploadRes.data.fileName}`, 'file');
            } catch (detailsErr) {
                console.error('⚠️ Фото сохранено, но не удалось записать в Подробности:', detailsErr.message);
            }
        }

        // v4.30.0: путь экранируем, отправка безопасная и awaited — фото сохранялось, а «✅» терялось
        await safeSendMarkdown(chatId, `✅ Фото сохранено в папку проекта!\n\n📁 ${escapeMarkdown(uploadRes.data.path)}`);
    } catch (err) {
        console.error('Photo upload error:', err.message);
        const errorMsg = err.response?.data?.error || err.message;
        let userMsg = `❌ Ошибка загрузки: ${errorMsg}`;
        if (errorMsg.includes('не привязана к проекту')) {
            userMsg = '❌ Задача не привязана к проекту — некуда сохранить фото.\n\nПопроси Руководителя привязать задачу к проекту.';
        } else if (errorMsg.includes('Не указан клиент')) {
            userMsg = '❌ У проекта не указан клиент (Контакт или Юрлицо) — папку создать нельзя, фото некуда сохранить.\n\n💡 Привяжи клиента в карточке проекта и попробуй снова.';
        } else if (errorMsg.includes('секрет')) {
            userMsg = '❌ Ошибка авторизации. Попробуй ещё раз.';
        }
        await safeSendMarkdown(chatId, userMsg);
    }
    resetState(chatId);
});

// ================== v4.30.0: ЗАГРУЗКА ЛЮБЫХ МЕДИА (видео/GIF/аудио/войс/видеосообщения) ==================
// Раньше бот реагировал только на document и photo: видео, гифки, войсы, аудио и видеосообщения
// молча игнорировались («отправил файл — тишина»). Теперь любой медиа-тип сохраняется в папку
// проекта через webhook по той же схеме, что и обычные файлы.
const EXTRA_MEDIA_LABELS = {
    video:      { icon: '🎬', label: 'Видео' },
    animation:  { icon: '🎞️', label: 'GIF' },
    audio:      { icon: '🎵', label: 'Аудио' },
    voice:      { icon: '🎤', label: 'Войс' },
    video_note: { icon: '📹', label: 'Видеосообщение' }
};
const MIME_TO_EXT = {
    'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'image/gif': '.gif'
};

// Нормализуем вложение любого медиа-типа в { fileId, fileName, fileSizeBytes, icon, label }.
function mediaUploadInfo(msg, type) {
    const field = msg[type];
    if (!field || !field.file_id) return null;
    const mimeType = field.mime_type || '';
    let fileName = field.file_name;
    if (!fileName) {
        const ext = MIME_TO_EXT[mimeType] || ({ voice: '.ogg', video_note: '.mp4' })[type] || '';
        fileName = `${type}_${Date.now()}${ext}`;
    }
    return { fileId: field.file_id, fileSizeBytes: field.file_size || 0, fileName, ...EXTRA_MEDIA_LABELS[type] };
}

async function handleExtraMediaUpload(msg, type) {
    const info = mediaUploadInfo(msg, type);
    if (!info) return;

    const chatId = msg.chat.id;
    const sess = getSession(sessions, chatId);
    // «Никогда не молчи»: медиа вне флоу загрузки — подсказка вместо тихого игнора
    if (sess.state !== STATE.WAITING_FILE_UPLOAD) {
        if (msg.from) sendFileHint(chatId, msg.from.id);
        return;
    }
    const emp = getEmployee(msg.from.id);
    if (!emp) return;

    const fileName = info.fileName;
    const fileSizeBytes = info.fileSizeBytes;
    const fileSize = (fileSizeBytes / 1024).toFixed(1);
    const { icon = '📎', label = 'Файл' } = info;

    try {
        const taskId = sess.taskDraft.fileTaskId;
        // Менеджер/Руководитель грузят напрямую в проект (fileProjectId), Исполнитель — к задаче (fileTaskId).
        if (!taskId && !sess.taskDraft.fileProjectId) {
            await safeSendMarkdown(chatId, '❌ Ошибка: задача или проект не выбраны. Начните заново через меню «📎 Загрузить файл».');
            return;
        }

        // 🛡️ Проблема 91: лимит 50MB проверяем ДО скачивания — webhook принимает максимум 50MB.
        if (fileSizeBytes > MAX_UPLOAD_SIZE) {
            await safeSendMarkdown(chatId, `❌ Файл *${escapeMarkdown(fileName)}* (${(fileSizeBytes / 1024 / 1024).toFixed(1)} МБ) больше лимита 50 МБ.\n\nПришли файл до 50 МБ или положи его в папку проекта через Samba-шару.`);
            resetState(chatId);
            return;
        }

        await safeSendMarkdown(chatId, `⏳ ${icon} Файл *${escapeMarkdown(fileName)}* (${fileSize} КБ) загружается...`);

        const fileLink = await withTimeout(bot.getFileLink(info.fileId), 30000);
        // Ретрай: кратковременный сбой Telegram/сети не должен терять файл
        const response = await withRetry(() => axios.get(fileLink, { responseType: 'arraybuffer', timeout: 60000 }), 3, 1000);

        const FormData = require('form-data');
        const formData = new FormData();
        formData.append('file', Buffer.from(response.data), { filename: fileName });
        if (sess.taskDraft.fileTaskId) formData.append('taskId', sess.taskDraft.fileTaskId);
        if (sess.taskDraft.fileProjectId) formData.append('projectId', sess.taskDraft.fileProjectId);
        formData.append('clientFileId', `${sess.taskDraft.fileTaskId || sess.taskDraft.fileProjectId || 'x'}:${fileName}:${fileSizeBytes}`);
        formData.append('secret', process.env.WEBHOOK_SECRET || '');

        // Ретрай: webhook может перезапускаться — файл не должен теряться
        const uploadRes = await withRetry(() => axios.post(`${WEBHOOK_URL}/upload-file`, formData, {
            headers: { ...formData.getHeaders() },
            timeout: 30000
        }), 3, 1000);

        if (taskId) {
            try {
                await appendTaskDetails(taskId, `${icon} ${label}: ${fileName} (${fileSize} КБ) → ${uploadRes.data.fileName}`, 'file');
            } catch (detailsErr) {
                console.error(`⚠️ ${label} сохранено, но не удалось записать в Подробности:`, detailsErr.message);
            }
        }

        await safeSendMarkdown(chatId, `✅ ${icon} Файл *${escapeMarkdown(fileName)}* сохранён в папку проекта!\n\n📁 ${escapeMarkdown(uploadRes.data.path)}`);
    } catch (err) {
        console.error(`${label} upload error:`, err.message);
        const errorMsg = err.response?.data?.error || err.message;
        let userMsg = `❌ Ошибка загрузки: ${errorMsg}`;
        if (errorMsg.includes('не привязана к проекту')) {
            userMsg = '❌ Задача не привязана к проекту — некуда сохранить файл.\n\nПопроси Руководителя привязать задачу к проекту.';
        } else if (errorMsg.includes('Не указан клиент')) {
            userMsg = '❌ У проекта не указан клиент (Контакт или Юрлицо) — папку создать нельзя, файл некуда сохранить.\n\n💡 Привяжи клиента в карточке проекта и попробуй снова.';
        } else if (errorMsg.includes('секрет')) {
            userMsg = '❌ Ошибка авторизации. Попробуй ещё раз.';
        }
        await safeSendMarkdown(chatId, userMsg);
    }
    resetState(chatId);
}

// Регистрируем новые типы: теперь «некоторые файлы» не молчат, а сохраняются в папку проекта.
['video', 'animation', 'audio', 'voice', 'video_note'].forEach(type => {
    bot.on(type, (msg) => handleExtraMediaUpload(msg, type).catch(err => console.error(`${type} handler error:`, err.message)));
});

// ================== DOMAIN-HANDLER: «ядро» задач/проектов/контактов (Фаза 3) ==================
// Callback-ветки блока A переехали в bot/handlers/main.js (фабрика ctx).
const { handleCallbackBlockA } = require('./handlers/main')({
    bot, config, axios, noco, sessions, employeesCache,
        STATE, ROLES, roles, PROJECT_STATUSES, PROJECT_INACTIVE_STATUSES,
        getSession, getEmployee, resetState, resetReminderState, loadAllowedUsers,
        fetchAllRows, invalidateTaskListCache, setListPage, getListPage, escapeMarkdown, plainTextFromMarkdown,
        formatMinskDate, parseQuickDeadline, extractLinkId,
        startContactWizard, startProjectWizard, startEditTask, startProjectTask,
        startProjectNote, startProjectDeadline, showProjectSelectionForContact,
        showProjectSelectionForTask,
        showProjectStep3, showContactSelectionForProject, showLegalSelectionForProject,
        showProjectAfterCreate, handleTaskDeadlineChosen, transferProject, createProjectRecord,
        sendTaskList, sendTodayTasks, sendTaskHistory, sendTaskDetails,
        sendContactsList, sendContactDetails, sendLegalList, sendLegalDetails,
        sendProjectsList, sendProjectDetails, sendProjectStatusMenu,
        sendProjectTasksList, sendProjectItemsList, sendProjectItemDetails,
        sendProjectDocsList, sendDocCard, sendDocCreateConfirm, generateDocPdfAndSend,
        todayNocoDate, docTypeKeyboard, sendPaymentMenu, sendArchivedProjects, sendTransferMenu, sendDeadlinePicker,
        // v4.43.0: правка карточек контакта/юрлица + привязка контакта к юрлицу
        sendContactEditMenu, sendLegalEditMenu,
        applyContactFieldEdit, applyContactMessengerEdit, applyLegalFieldEdit,
        sendOrgSelectionForContact, showFoundLegalsForOrg, setContactOrgLink, addContactHistoryEntry
    });



// ================== ОБНОВЛЁННЫЙ СПИСОК ЗАДАЧ (с кнопкой ✏️) ==================
async function sendTaskList(chatId, messageId, telegramId, role, page = 0) {
    const rows = await fetchTasksForListCached();
    let activeTasks = rows.filter(t => !t['Готово']);

    // Фильтрация по роли
    if (telegramId !== undefined && role !== undefined) {
        activeTasks = roles.filterTasksByRole(activeTasks, getEmployee(telegramId));
    }

    // v4.38.0: сортировка — просроченные/ближайшие по сроку сверху, без срока в конце (свежие сверху).
    activeTasks.sort(sorters.compareTasksActive);

    // 🆕 v4.22.0: UI-пагинация (лимит 100 кнопок / 4096 символов)
    const { pageItems, page: safePage, totalPages } = slicePage(activeTasks, page, LIST_PAGE_SIZE.tasks);
    setListPage(telegramId, 'tl', safePage);

        let text = `📋 *Активные задачи (${activeTasks.length})*${totalPages > 1 ? ` · стр. ${safePage + 1}/${totalPages}` : ''}`;
    // 🆕 v4.36.0: список = кнопки-пункты (как Проекты/Контакты). «✅ Закрыть» —
    // только у «горящих» задач и при наличии прав; ✏️ и остальное — в карточке.
    if (pageItems.length === 0) text += '\n\n🎉 Все задачи выполнены!';
    else text += '\n\n👇 *Нажми на задачу* — карточка с действиями.\n';

    const inlineKeyboard = [];
    pageItems.forEach(t => inlineKeyboard.push(...taskListRows(t)));
    const nav = paginationRow('tl', safePage, totalPages);
    if (nav) inlineKeyboard.push(nav);
    inlineKeyboard.push([{ text: '🔄 Обновить', callback_data: 'refresh_tasks' }]);

    const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
    try {
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (e) {
        console.error('❌ Отправка списка задач:', e.message);
        // 🐛 v4.21.2: не глотаем 400 молча — fallback plain text
        await bot.sendMessage(chatId, plainTextFromMarkdown(text), { reply_markup: options.reply_markup });
    }
}

// ================== КАРТОЧКА ЗАДАЧИ (просмотр подробностей) ==================
// Открывается кнопкой «👁 #id» из списков задач. Показывает название, срок, проект,
// исполнителя и блок «📝 Подробности» (комментарии, файлы, пересланное из appendTaskDetails).
async function sendTaskDetails(chatId, messageId, taskId, role) {
    const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
    const t = res.data;

    let text = `📋 *Задача #${t.Id}:* ${escapeMarkdown(t['Что делаем?'] || 'Без названия')}\n\n`;
    text += `📅 *Срок:* ${t['Когда делаем'] ? formatMinskDate(t['Когда делаем']) : 'Без срока'}\n`;
    if (t['Какой проект'] && t['Какой проект']['Что делаем?']) {
        text += `📁 *Проект:* ${escapeMarkdown(t['Какой проект']['Что делаем?'])}\n`;
    }
    if ((role === ROLES.ADMIN || role === ROLES.MANAGER) && t['Исполнитель']) {
        text += `👤 *Исполнитель:* ${escapeMarkdown(t['Исполнитель']['ФИО'] || 'Сотрудник')}\n`;
    }
    text += t['Готово'] ? '✅ *Статус:* выполнена\n' : '🔄 *Статус:* в работе\n';

    const details = String(t['Подробности'] || '').trim();
    if (details) {
        // Защита от превышения лимита сообщения Telegram (4096 символов)
        const maxLen = 3000;
        const shown = details.length > maxLen ? details.slice(0, maxLen) + '\n\n…(обрезано, полный текст — в NocoDB)' : details;
        text += `\n📝 *Подробности:*\n${escapeMarkdown(shown)}`;
    } else {
        text += '\n📝 *Подробности:* пока нет';
    }

    const row = [];
    if (!t['Готово']) row.push({ text: '✅ Закрыть', callback_data: `done_${t.Id}` });
    row.push({ text: '✏️ Изменить', callback_data: `edit_${t.Id}` });
    row.push({ text: '💬 Комментарий', callback_data: `comment_task_${t.Id}` });
    row.push({ text: '⬅️ Назад', callback_data: 'view_back' });

    const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [row] } };
    if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    else await bot.sendMessage(chatId, text, options);
}

// ================== МОИ ЗАЯВКИ (судьба предложенных задач) ==================
// Показывает задачи, предложенные текущим сотрудником (Кто предложил = emp.Id),
// и их статус: «⏳ Ожидает решения» / «👤 Назначена» / «❌ Отклонена».
// Статус выводится из данных задачи (без отдельного столбца):
//   - отклонена:  Готово=true и название начинается с «❌ ОТКЛОНЕНА: »
//   - назначена:  есть Исполнитель
//   - иначе:      без исполнителя и не готова → ждёт решения
async function sendMySuggestions(chatId, telegramId, role) {
    try {
        const emp = getEmployee(telegramId);
        if (!emp) return bot.sendMessage(chatId, '❌ Сотрудник не найден');

        const rows = await fetchTasksForListCached();
        const mySuggestions = rows.filter(t => {
            const proposer = t['Кто предложил'];
            if (!proposer) return false;
            if (Array.isArray(proposer)) return proposer.some(p => p?.Id === emp.Id);
            if (typeof proposer === 'object') return proposer.Id === emp.Id;
            return proposer == emp.Id;
        });

        if (mySuggestions.length === 0) {
            return bot.sendMessage(chatId, '📭 У вас пока нет заявок. Нажми «📩 Предложить задачу», чтобы создать.');
        }

        mySuggestions.sort((a, b) => (b.Id || 0) - (a.Id || 0));
            let text = `📩 *Мои заявки (${mySuggestions.length})*`;
    // 🆕 v4.36.0: список = кнопки-пункты со статусом заявки
    text += '\n\n👇 *Нажми на заявку* — посмотреть её статус.\n';
    const inlineKeyboard = [];
    mySuggestions.forEach(t => {
        const rawTitle = String(t['Что делаем?'] || 'Без названия');
        const isRejected = t['Готово'] && rawTitle.startsWith('❌ ОТКЛОНЕНА');
        const title = isRejected ? rawTitle.replace(/^❌ ОТКЛОНЕНА: /, '') : rawTitle;
        let icon, statusWord;
        if (isRejected) { icon = '❌'; statusWord = 'Отклонена'; }
        else if (t['Исполнитель']) { icon = '👤'; statusWord = `Назначена: ${t['Исполнитель']['ФИО'] || 'Сотрудник'}`; }
        else { icon = '⏳'; statusWord = 'Ожидает решения'; }
        const label = `${icon} #${t.Id} ${cleanButtonText(title, 50)} · ${cleanButtonText(statusWord, 28)}`;
        inlineKeyboard.push([{ text: label, callback_data: `view_${t.Id}` }]);
    });

    const options = { parse_mode: 'Markdown' };
        if (inlineKeyboard.length > 0) options.reply_markup = { inline_keyboard: inlineKeyboard };
        await bot.sendMessage(chatId, text, options);
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
}


// ================== УТИЛИТА: СОРТИРОВКА СТРОК rclone lsl (Проблема 111) ==================
// rclone lsl НЕ гарантирует порядок вывода — для Google Drive строки приходят в порядке,
// который отдаёт API, и «последняя» строка может оказаться САМЫМ СТАРЫМ бэкапом.
// Сортируем сами по имени файла: в имени зашита дата создания бэкапа
// `nocodb_full_backup_YYYYMMDD_HHMMSS.tar.gz`, лексикографический порядок = хронологический.
// Формат строки lsl: <size> <date> <time_with_nanos> <имя>.
function sortCloudBackupLines(lines) {
    const nameOf = s => s.trim().split(/\s+/).slice(3).join(' ');
    return lines.slice().sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}

// ================== ОБЛАЧНЫЕ БЭКАПЫ: КЕШ + ЕДИНАЯ ПРОВЕРКА (v4.39.0) ==================
// `rclone lsl grive:...` — самый медленный шаг статуса бэкапов (секунды-десятки секунд:
// сеть + возможный OAuth-рефреш токена). Раньше КАЖДЫЙ тап «💾 Бэкапы» и утренняя рассылка
// дёргали Google Drive заново и БЕЗ таймаута — при проблемах сети кнопка «молчала» минутами.
// Теперь (v4.39.0):
//   1) список облачных бэкапов кешируется в памяти (TTL 30 мин) — повторная проверка мгновенная;
//   2) single-flight: два быстрых тапа НЕ запускают два параллельных rclone;
//   3) на вызов есть жёсткий таймаут — бот гарантированно ответит, а не «зависнет».
// Единая точка для кнопки «💾 Бэкапы» и утренней рассылки (рассылка заодно греет кеш).
const CLOUD_RCLONE_CMD = 'rclone --config /home/node/.config/rclone/rclone.conf';
const CLOUD_BACKUP_TTL_MS = 30 * 60 * 1000; // свежесть кеша облачного списка
const CLOUD_BACKUP_TIMEOUT_MS = 25000;      // крайний срок ответа Google Drive (exec убьёт rclone)

// { ts: number, lines: string[] } — последний успешный список; ts=0/lines=null = кеш пуст
let cloudBackupCache = { ts: 0, lines: null };
// Promise текущего живого запроса (single-flight): пока идёт — новые вызовы ждут его же
let cloudBackupInFlight = null;

// Живой запрос списка облачных бэкапов (вне кеша). Возвращает уже ОТСОРТИРОВАННЫЕ строки lsl.
async function fetchCloudBackupLines() {
    const { exec } = require('child_process');
    const { promisify } = require('util');
    const execAsync = promisify(exec);

    // Проблема 109: путь АБСОЛЮТНЫЙ и совпадает с dest-монтированием в docker-compose.yml
    // (/home/node/.config/...), а не ~/.config — в контейнере процесс идёт от юзера node
    // (user: ${APP_UID}), его HOME=/home/node, и ~/... раскрывалась бы в /home/node/...,
    // тогда как старый compose монтировал в /root/.config (туда юзеру node нет доступа).
    const { stdout } = await execAsync(`${CLOUD_RCLONE_CMD} lsl grive:nocodb-backups 2>&1`, {
        timeout: CLOUD_BACKUP_TIMEOUT_MS,
        killSignal: 'SIGKILL'
    });
    // Проблема 111: сортируем сами по имени файла (rclone lsl порядок не гарантирует),
    // иначе «самым свежим» может оказаться самый старый бэкап.
    return sortCloudBackupLines(stdout.trim().split('\n').filter(l => l.includes('nocodb_full_backup_')));
}

// Единая точка чтения облачных бэкапов: свежий кеш → мгновенно; иначе — живой запрос
// (параллельные вызовы дедуплицируются; при ошибке/таймауте кеш НЕ трогаем — попробуем снова).
async function getCloudBackupLines() {
    if (cloudBackupCache.lines && Date.now() - cloudBackupCache.ts < CLOUD_BACKUP_TTL_MS) {
        return cloudBackupCache.lines;
    }
    if (!cloudBackupInFlight) {
        cloudBackupInFlight = fetchCloudBackupLines()
            .then(lines => {
                cloudBackupCache = { ts: Date.now(), lines };
                return lines;
            })
            .catch(err => {
                throw err; // ошибка уходит вызывающему; кеш остаётся прежним
            })
            .finally(() => { cloudBackupInFlight = null; });
    }
    return cloudBackupInFlight;
}

// ================== КОМАНДА /status ==================
// ================== ФУНКЦИЯ: СТАТУС БЭКАПОВ ==================
async function sendBackupStatus(chatId) {
    // v4.39.0: раньше «💾 Бэкапы» отвечал МОЛЧА, пока rclone ходил в Google Drive
    // (секунды-десятки секунд). Теперь сразу показываем «⏳…», а это же сообщение
    // заменяем полным статусом (editMessageText), когда данные готовы.
    let progressMsg = null;
    try {
        progressMsg = await bot.sendMessage(chatId,
            '💾 *Статус бэкапов:*\n\n⏳ Проверяю облако (Google Drive)…\nОбычно занимает 5–25 секунд, при свежем кеше — мгновенно.',
            { parse_mode: 'Markdown' });
    } catch (e) { /* прогресс не ушёл (сбой) — всё равно соберём и отправим итог ниже */ }

    let message = `💾 *Статус бэкапов:*\n\n`;

    // Локальный бэкап
    try {
        const fs = require('fs').promises;
        const path = require('path');
        const backupDir = '/mnt/data/backups';
        const files = await fs.readdir(backupDir);
        const backupFiles = files.filter(f => f.startsWith('nocodb_full_backup_') && f.endsWith('.tar.gz'));

        if (backupFiles.length > 0) {
            backupFiles.sort().reverse();
            const latest = backupFiles[0];
            const stats = await fs.stat(path.join(backupDir, latest));
            const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
            const age = Math.floor((Date.now() - stats.mtimeMs) / (1000 * 60 * 60));
            const ageText = age < 24 ? `${age}ч назад` : `${Math.floor(age / 24)}д ${age % 24}ч назад`;
            message += `✅ *Локальный:* ${sizeMB}MB (${ageText})\n`;
            message += `   📁 Всего: ${backupFiles.length} бэкапов\n`;
        } else {
            message += `❌ *Локальный:* не найден\n`;
        }
    } catch (err) {
        message += `❌ *Локальный:* ошибка (${err.message})\n`;
    }

    // Облачный бэкап — единая точка с кешем (v4.39.0): см. getCloudBackupLines
    try {
        // getCloudBackupLines() уже отфильтровал строки и отсортировал по имени файла.
        const lines = await getCloudBackupLines();

        if (lines.length > 0) {
            // После сортировки по имени последняя строка — самый свежий бэкап.
            const latest = lines[lines.length - 1];
            const parts = latest.trim().split(/\s+/);
            const sizeBytes = parseInt(parts[0]);
            const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
            const dateStr = parts[1] + ' ' + parts[2].substring(0, 5);
            message += `✅ *Облако:* ${sizeMB}MB (${dateStr})\n`;
            message += `   📁 Всего: ${lines.length} бэкапов\n`;
        } else {
            message += `❌ *Облако:* не найден\n`;
        }
    } catch (err) {
        // Проблема 106: человечное сообщение вместо сырого вывода rclone (в контейнере
        // rclone.conf может быть не смонтирован, remote не настроен и т.п.)
        if (err.killed) {
            // v4.39.0: exec убил rclone по таймауту — не показываем сырое «Command failed»
            message += `❌ *Облако:* Google Drive не ответил за ${Math.round(CLOUD_BACKUP_TIMEOUT_MS / 1000)} с. Попробуй позже.\n`;
        } else {
            const out = String(err.stdout || err.message || '');
            const notConfigured = !out || /config file .*not found|didn't find section|unknown remote|no remotes found|command not found|enoent/i.test(out);
            if (notConfigured) {
                message += `❌ *Облако:* не настроено.\n   Запусти на сервере:\n   ` + '`bash modules/backup-install.sh`' + `\n`;
            } else {
                const firstLine = out.split('\n').find(l => l.trim()) || 'ошибка';
                message += `❌ *Облако:* ошибка чтения Google Drive (${escapeMarkdown(firstLine)})\n`;
            }
        }
    }

    // v4.39.0: прогресс-сообщение уже на экране — заменяем его итогом; если edit не прошёл
    // (сообщение удалено/сбой сети) — дублируем обычной отправкой, чтобы ответ был гарантирован.
    if (progressMsg) {
        try {
            await bot.editMessageText(message, { chat_id: chatId, message_id: progressMsg.message_id, parse_mode: 'Markdown' });
            return;
        } catch (err) { /* fallthrough → обычная отправка */ }
    }
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// ================== КОМАНДА /BACKUP ==================
// canSeeBackups, а не isAllowed: кнопка «💾 Бэкапы» доступна только Руководителю —
// командный вход не должен быть шире кнопки (дыра зоны роли, Проблема 86/87).
bot.onText(/\/backup/, async (msg) => {
    if (!msg.from || !canSeeBackups(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ У вас нет прав.');
    await sendBackupStatus(msg.chat.id);
});

// ================== ФУНКЦИЯ: СТАТУС СИСТЕМЫ ==================
async function sendSystemStatus(chatId) {
    let message = '📊 *СОСТОЯНИЕ СИСТЕМЫ*\n\n';
    
    // 1. Проверяем NocoDB
    try {
        const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}?limit=1`, {
            headers: { 'xc-token': config.NOCO_TOKEN },
            timeout: 3000
        });
        message += '🟢 *NocoDB:* online\n';
    } catch (err) {
        message += '🔴 *NocoDB:* offline ❌\n';
    }
    
    // 2. Проверяем pdf-generator (сам себя через внутренний Docker-адрес)
    //    /health — без requireSecret (в отличие от /api/my-details, который даёт 403 → ложный offline)
    try {
        const res = await axios.get('http://localhost:3000/health', { timeout: 3000 });
        message += '🟢 *pdf-generator:* online\n';
    } catch (err) {
        message += '🔴 *pdf-generator:* offline ❌\n';
    }
    
    // 3. Проверяем project-webhook через внутренний Docker-адрес
    //    Сразу /health: корневой роут / в webhook отсутствует (404 → шум в логах)
    try {
        const res = await axios.get(`${WEBHOOK_URL}/health`, { timeout: 3000 });
        message += '🟢 *project-webhook:* online\n';
    } catch (err) {
        message += '🔴 *project-webhook:* offline ❌\n';
    }
    
    // 4. Диск (блок «Nginx» удалён в v4.23.1 — рудимент: nginx не входит в docker-стек,
    //    а localhost:8081 внутри контейнера бота мёртв → проверка всегда врала «inactive»)
    message += '\n💾 *Диск:*\n';
    try {
        const { execSync } = require('child_process');
        const dfOutput = execSync("df -h /mnt/data | tail -1").toString().trim();
        const parts = dfOutput.split(/\s+/);
        const df = `${parts[2]}/${parts[1]} (${parts[4]} занято)`;
        message += `   ${df}\n`;
    } catch (err) {
        message += '   ⚠️ Не удалось получить\n';
    }
    
    message += '\n🧠 *RAM:*\n';
    try {
        const { execSync } = require('child_process');
        const memOutput = execSync("free -h | grep Mem").toString().trim();
        const parts = memOutput.split(/\s+/);
        const mem = `${parts[2]}/${parts[1]}`;
        message += `   ${mem}\n`;
    } catch (err) {
        message += '   ⚠️ Не удалось получить\n';
    }
    
    // 5. Статистика из NocoDB
    //    fetchAllRows() вместо ?limit=1000 — иначе при >1000 записей счётчик молча обрезается (как v4.14.1)
    try {
        const [docs, projects, tasks, contacts, employees] = await Promise.all([
            fetchAllRows(config.TABLES.DOCUMENTS),
            fetchAllRows(config.TABLES.PROJECTS),
            fetchAllRows(config.TABLES.TASKS),
            fetchAllRows(config.TABLES.CONTACTS),
            fetchAllRows(config.TABLES.EMPLOYEES)
        ]);
        const activeTasks = tasks.filter(t => !t['Готово']).length;

        message += `\n📈 *Статистика:*\n`;
        message += `   • Документов: ${docs.length}\n`;
        message += `   • Проектов: ${projects.length}\n`;
        message += `   • Задач: ${tasks.length} (${activeTasks} активных)\n`;
        message += `   • Контактов: ${contacts.length}\n`;
        message += `   • Сотрудников: ${employees.length}\n`;
    } catch (err) {
        message += '\n⚠️ Не удалось получить статистику\n';
    }
    
    message += `\n⏰ *Время:* ${new Date().toLocaleString('ru-RU', { timeZone: config.TZ })}`;

    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// ================== КОМАНДА /status ==================
// canSeeStatus, а не isAllowed: кнопка «📊 Статус» доступна только Руководителю —
// командный вход не должен быть шире кнопки (дыра зоны роли, Проблема 86/87).
bot.onText(/\/status/, async (msg) => {
    if (!msg.from || !canSeeStatus(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ У вас нет прав.');
    await sendSystemStatus(msg.chat.id);
});

// ================== ФУНКЦИЯ: СПИСОК КОНТАКТОВ ==================
async function sendContactsList(chatId, telegramId, role, messageId, page = 0) {
    try {
        let contacts;
        if (role === ROLES.ADMIN) {
            // Руководитель видит все контакты
            contacts = await noco.fetchAllRowsCached(config.TABLES.CONTACTS, { ttlMs: 15000 });
        } else if (role === ROLES.MANAGER) {
            // v4.26.0: Менеджер видит ВСЮ клиентскую базу — общий ресурс компании.
            // (Решение 31.08.2026: увод клиентов кодом не решить, а анти-дубли и общий
            // справочник — решают. Раньше были только «свои проекты».)
            contacts = await noco.fetchAllRowsCached(config.TABLES.CONTACTS, { ttlMs: 15000 });
        } else {
            // Исполнитель — нет доступа
            bot.sendMessage(chatId, '📇 *Контакты:* У вас нет доступа к списку контактов.', { parse_mode: 'Markdown' });
            return;
        }

        // v4.38.0: справочник — по алфавиту (Имя, ru), пустые имена в конце.
        contacts.sort(sorters.compareContactsByName);

        // 🆕 v4.22.0: UI-пагинация
        const { pageItems, page: safePage, totalPages } = slicePage(contacts, page, LIST_PAGE_SIZE.simple);
        setListPage(telegramId, 'cl', safePage);

        let message = `📇 *Контакты (${contacts.length})*${totalPages > 1 ? ` · стр. ${safePage + 1}/${totalPages}` : ''}`;
        // 🆕 v4.35.0: список = кнопки-пункты. Полотно текста убрано: inline-кнопки в Telegram
        // идут ТОЛЬКО снизу сообщения, и «👁 #id» под простынёй из 10 описаний заставлял
        // сверять текст и кнопки глазами. Теперь сам пункт — широкая кнопка (тап = карточка).
        if (pageItems.length === 0) message += '\n\n📭 Пусто.';
        else message += '\n\n👇 *Нажми на контакт* — откроется карточка с реквизитами.\n';

        const inlineKeyboard = pageItems.map(c => [{
            text: `👤 #${c.Id} ${cleanButtonText(c['Имя'] || 'Без имени')}${c['Телефон'] ? ` · ${cleanButtonText(c['Телефон'], 25)}` : ''}`,
            callback_data: `ccard_${c.Id}`
        }]);
        const nav = paginationRow('cl', safePage, totalPages);
        if (nav) inlineKeyboard.push(nav);

        const options = { parse_mode: 'Markdown' };
        if (inlineKeyboard.length > 0) options.reply_markup = { inline_keyboard: inlineKeyboard };

        try {
            if (messageId) await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, ...options });
            else await bot.sendMessage(chatId, message, options);
        } catch (e) {
            console.error('❌ Отправка списка контактов:', e.message);
            // 🐛 v4.21.2: не глотаем 400 молча — fallback plain text (данные могли сломать Markdown)
            await bot.sendMessage(chatId, plainTextFromMarkdown(message), {});
        }
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
}

// ================== ФУНКЦИЯ: СПИСОК ПРОЕКТОВ ==================
async function sendProjectsList(chatId, telegramId, role, messageId, page = 0) {
    try {
        let projects;
        if (role === ROLES.ADMIN) {
            // Руководитель видит все проекты
            const rows = await noco.fetchAllRowsCached(config.TABLES.PROJECTS, { ttlMs: 15000 });
            projects = rows.filter(p => p['Активно'] === 'Активно');
        } else if (role === ROLES.MANAGER) {
            // Менеджер видит только свои проекты
            const emp = getEmployee(telegramId);
            if (!emp) {
                bot.sendMessage(chatId, '📇 *Проекты:* Не удалось определить сотрудника.', { parse_mode: 'Markdown' });
                return;
            }
            const empId = emp.Id;
            const rows = await noco.fetchAllRowsCached(config.TABLES.PROJECTS, { ttlMs: 15000 });
            projects = rows.filter(p => p['Активно'] === 'Активно' && p['Менеджер']?.Id === empId);
        } else {
            // Исполнитель — нет доступа
            bot.sendMessage(chatId, '📚 *Проекты:* У вас нет доступа к списку проектов.', { parse_mode: 'Markdown' });
            return;
        }

        // v4.38.0: по этапу «Готов к сдаче» → «В работе» → «Обсуждение», внутри — по сроку.
        projects.sort(sorters.compareActiveProjectsByStage);

        // v4.42.4: бейдж 💰 — проект ждёт оплату, если есть ОТПРАВЛЕННЫЙ счёт,
        // а «По деньгам?» не содержит «Оплач…». Бейджи некритичны: сбой — без них.
        let invoiceProjectIds = new Set();
        try {
            const docs = await noco.fetchAllRowsCached(config.TABLES.DOCUMENTS, { ttlMs: 15000 });
            invoiceProjectIds = collectInvoiceProjectIds(docs);
        } catch (e) { console.log('⚠️ Бейджи оплат недоступны:', e.message); }
        const moneyBadge = (p) => (invoiceProjectIds.has(Number(p.Id)) && !isProjectPaid(p['По деньгам?'])) ? '💰 ' : '';

        // 🆕 v4.22.0: UI-пагинация
        const { pageItems, page: safePage, totalPages } = slicePage(projects, page, LIST_PAGE_SIZE.simple);
        setListPage(telegramId, 'pl', safePage);

        let message = `🚀 *Активные проекты (${projects.length})*${totalPages > 1 ? ` · стр. ${safePage + 1}/${totalPages}` : ''}\n`;
        // 🆕 v4.18.0: счётчики по статусам (навигация, не дашборд)
        if (projects.length > 0) {
            const byStatus = {};
            projects.forEach(p => { byStatus[p['Статус']] = (byStatus[p['Статус']] || 0) + 1; });
            const counter = Object.entries(byStatus)
                .map(([s, n]) => `${s} — ${n}`)
                .join(' · ');
            message += `📊 ${escapeMarkdown(counter)}\n`;
        }
        // 🆕 v4.35.0: список = кнопки-пункты. Полотно текста убрано: inline-кнопки в Telegram
        // идут ТОЛЬКО снизу сообщения, и «👁 #id» под простынёй из 10 описаний заставлял
        // сверять текст и кнопки глазами. Теперь сам пункт — широкая кнопка (тап = карточка).
        if (pageItems.length === 0) message += '\n📭 Пусто.';
        else message += '\n👇 *Нажми на проект* — откроется карточка.\n';

        const inlineKeyboard = pageItems.map(p => [{
            text: `${moneyBadge(p)}📁 #${p.Id} ${cleanButtonText(p['Что делаем?'] || 'Без названия')}${p['Статус'] ? ` — ${cleanButtonText(p['Статус'], 20)}` : ''}`,
            callback_data: `pcard_${p.Id}`
        }]);
        const nav = paginationRow('pl', safePage, totalPages);
        if (nav) inlineKeyboard.push(nav);

        const options = { parse_mode: 'Markdown' };
        if (inlineKeyboard.length > 0) options.reply_markup = { inline_keyboard: inlineKeyboard };

        try {
            if (messageId) await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, ...options });
            else await bot.sendMessage(chatId, message, options);
        } catch (e) {
            console.error('❌ Отправка списка проектов:', e.message);
            // 🐛 v4.21.2: не глотаем 400 молча — fallback plain text
            await bot.sendMessage(chatId, plainTextFromMarkdown(message), { reply_markup: options.reply_markup });
        }
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
}

// ================== КАРТОЧКА КОНТАКТА (просмотр доп. информации) ==================
// Открывается кнопкой «👁 #id» из списка контактов. Показывает реквизиты контакта
// и блок «📝 Доп. информация» (пересланное, история из forward-флоу).
async function sendContactDetails(chatId, messageId, contactId, role, telegramId) {
    const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
    const c = res.data;

    let text = `👤 *${escapeMarkdown(c['Имя'] || 'Без имени')}* (#${c.Id})\n\n`;
    if (c['Телефон']) text += `📱 *Телефон:* ${escapeMarkdown(c['Телефон'])}\n`;
    if (c['E-mail']) text += `✉️ *E-mail:* ${escapeMarkdown(c['E-mail'])}\n`;
    if (c['Мессенджер']) text += `💬 *Мессенджер:* ${escapeMarkdown(c['Мессенджер'])}\n`;
    if (c['Ссылка']) text += `🔗 *Ссылка:* ${escapeMarkdown(c['Ссылка'])}\n`;
    if (c['Обращение']) text += `🙂 *Обращение:* ${escapeMarkdown(c['Обращение'])}\n`;
    // v4.43.0: связь «Организация» API может вернуть объектом или массивом — обрабатываем оба
    const orgField = Array.isArray(c['Организация']) ? (c['Организация'][0] || null) : c['Организация'];
    const orgName = orgField ? (orgField['Краткое Имя'] || orgField['Имя'] || '') : '';
    if (orgName) text += `🏢 *Организация:* ${escapeMarkdown(orgName)}\n`;
    if (c['Какой проект']) {
        const projField = Array.isArray(c['Какой проект']) ? c['Какой проект'][0] : c['Какой проект'];
        if (projField && projField['Что делаем?']) text += `📁 *Проект:* ${escapeMarkdown(projField['Что делаем?'])}\n`;
    }
    const contactProjects = Array.isArray(c['Проекты']) ? c['Проекты'].filter(p => p && p['Что делаем?']) : [];
    if (contactProjects.length > 0) {
        const names = contactProjects.map(p => escapeMarkdown(p['Что делаем?'])).join(', ');
        text += `📁 *Проекты:* ${names}\n`;
    }
    if (c['Client ID']) text += `🆔 *Client ID:* ${escapeMarkdown(c['Client ID'])}\n`;

    const extra = String(c['Доп. информация'] || '').trim();
    if (extra) {
        const maxLen = 3000;
        const shown = extra.length > maxLen ? extra.slice(0, maxLen) + '\n\n…(обрезано, полный текст — в NocoDB)' : extra;
        text += `\n📝 *Доп. информация:*\n${escapeMarkdown(shown)}`;
    } else {
        text += '\n📝 *Доп. информация:* пока нет';
    }

    // 🆕 v4.43.0: действия карточки — правка полей и привязка к юрлицу.
    const kb = [];
    kb.push([{ text: '✏️ Изменить', callback_data: `cc_edit_${c.Id}` }]);
    if (orgField) {
        kb.push([
            { text: '🔄 Сменить юрлицо', callback_data: `cc_link_${c.Id}` },
            { text: '❌ Отвязать юрлицо', callback_data: `cc_unlink_${c.Id}` }
        ]);
    } else {
        kb.push([{ text: '🏢 Привязать юрлицо', callback_data: `cc_link_${c.Id}` }]);
    }
    kb.push([{ text: '⬅️ Назад', callback_data: 'ccard_back' }]);

    const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } };
    if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    else await bot.sendMessage(chatId, text, options);
}

// Менеджер видит ВСЮ клиентскую базу (общий ресурс компании, решение 31.08.2026).
// Бывшие canManagerSeeContact/canManagerSeeLegal (фильтр «своих проектов») удалены —
// вместе с паранойей «увода клиентов», которую кодом всё равно не решить.

// ================== ФУНКЦИЯ: СПИСОК ЮРЛИЦ ==================
async function sendLegalList(chatId, telegramId, role, messageId, page = 0) {
    try {
        let legals;
        if (role === ROLES.ADMIN) {
            // Руководитель видит все юрлица
            legals = await noco.fetchAllRowsCached(config.TABLES.LEGAL_ENTITIES, { ttlMs: 15000 });
        } else if (role === ROLES.MANAGER) {
            // v4.26.0: Менеджер видит ВСЕ юрлица — общий справочник компании (см. Контакты).
            legals = await noco.fetchAllRowsCached(config.TABLES.LEGAL_ENTITIES, { ttlMs: 15000 });
        } else {
            // Исполнитель — нет доступа
            bot.sendMessage(chatId, '🏢 *Юрлица:* У вас нет доступа к списку юрлиц.', { parse_mode: 'Markdown' });
            return;
        }

        // v4.38.0: справочник — по алфавиту («Краткое Имя»/«Имя», ru), пустые в конце.
        legals.sort(sorters.compareLegalsByName);

        // 🆕 v4.22.0: UI-пагинация
        const { pageItems, page: safePage, totalPages } = slicePage(legals, page, LIST_PAGE_SIZE.simple);
        setListPage(telegramId, 'll', safePage);

        let message = `🏢 *Юрлица (${legals.length})*${totalPages > 1 ? ` · стр. ${safePage + 1}/${totalPages}` : ''}`;
        // 🆕 v4.35.0: список = кнопки-пункты. Полотно текста убрано: inline-кнопки в Telegram
        // идут ТОЛЬКО снизу сообщения, и «👁 #id» под простынёй из 10 описаний заставлял
        // сверять текст и кнопки глазами. Теперь сам пункт — широкая кнопка (тап = карточка).
        if (pageItems.length === 0) message += '\n\n📭 Пусто.';
        else message += '\n\n👇 *Нажми на юрлицо* — откроется карточка с реквизитами.\n';

        const inlineKeyboard = pageItems.map(l => [{
            text: `🏢 #${l.Id} ${cleanButtonText(l['Краткое Имя'] || l['Имя'] || 'Без имени')}`,
            callback_data: `lcard_${l.Id}`
        }]);
        const nav = paginationRow('ll', safePage, totalPages);
        if (nav) inlineKeyboard.push(nav);

        const options = { parse_mode: 'Markdown' };
        if (inlineKeyboard.length > 0) options.reply_markup = { inline_keyboard: inlineKeyboard };

        try {
            if (messageId) await bot.editMessageText(message, { chat_id: chatId, message_id: messageId, ...options });
            else await bot.sendMessage(chatId, message, options);
        } catch (e) {
            console.error('❌ Отправка списка юрлиц:', e.message);
            // 🐛 v4.21.2: не глотаем 400 молча — fallback plain text
            await bot.sendMessage(chatId, plainTextFromMarkdown(message), {});
        }
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
}

// ================== КАРТОЧКА ЮРЛИЦА (просмотр реквизитов) ==================
// Открывается кнопкой «👁 #id» из списка юрлиц. Показывает полные реквизиты юрлица.
async function sendLegalDetails(chatId, messageId, legalId, role, telegramId) {
    const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.LEGAL_ENTITIES}/${legalId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
    const l = res.data;

    const name = l['Краткое Имя'] || l['Имя'] || 'Без названия';
    let text = `🏢 *${escapeMarkdown(name)}* (#${l.Id})\n\n`;
    if (l['Имя']) text += `📛 *Полное имя:* ${escapeMarkdown(l['Имя'])}\n`;
    if (l['УНП']) text += `🧾 *УНП:* ${escapeMarkdown(String(l['УНП']))}\n`;
    if (l['Адрес']) text += `📍 *Адрес:* ${escapeMarkdown(l['Адрес'])}\n`;
    if (l['Адрес доставки']) text += `🚚 *Адрес доставки:* ${escapeMarkdown(l['Адрес доставки'])}\n`;
    if (l['Телефон']) text += `📱 *Телефон:* ${escapeMarkdown(l['Телефон'])}\n`;
    if (l['E-mail']) text += `✉️ *E-mail:* ${escapeMarkdown(l['E-mail'])}\n`;
    // v4.43.0: реквизиты хранятся РАЗДЕЛЬНЫМИ колонками (Банк / р/с / БИК) — показываем блоком
    const bankLine = [l['Банк'] ? `Банк: ${l['Банк']}` : '', l['р/с'] ? `р/с ${l['р/с']}` : '', l['БИК'] ? `БИК ${l['БИК']}` : ''].filter(Boolean).join('\n');
    if (bankLine) text += `🏦 *Банковские реквизиты:*\n${escapeMarkdown(bankLine)}\n`;
    if (l['Договор основания']) text += `📑 *Договор основания:* ${escapeMarkdown(l['Договор основания'])}\n`;
    if (l['Client ID']) text += `🆔 *Client ID:* ${escapeMarkdown(l['Client ID'])}\n`;
    if (l['Контакт/ответственный']) {
        const cp = l['Контакт/ответственный'];
        const cpName = Array.isArray(cp) ? (cp[0] && (cp[0]['Имя'] || '')) : (cp['Имя'] || '');
        if (cpName) text += `👤 *Контакт/ответственный:* ${escapeMarkdown(cpName)}\n`;
    }

    // 🆕 v4.43.0: правка реквизитов прямо из карточки (без похода в NocoDB).
    const kb = [
        [{ text: '✏️ Изменить', callback_data: `lc_edit_${l.Id}` }],
        [{ text: '⬅️ Назад', callback_data: 'lcard_back' }]
    ];
    const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } };
    if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    else await bot.sendMessage(chatId, text, options);
}

// ============================================================================
// 🆕 v4.43.0: РЕДАКТИРОВАНИЕ КАРТОЧЕК КОНТАКТА/ЮРЛИЦА ИЗ БОТА
// Кнопка «✏️ Изменить» в карточке → меню «что меняем?» → пофайловый PATCH.
// Каждая правка пишется в историю контакта: «Доп. информация» (контакт) /
// «Дополнительно» (юрлицо). История отделена заголовком «✏️ История правок».
// ============================================================================

// Единый источник скалярных полей контакта, доступных для правки из бота.
// key — идентификатор в callback_data (без «_»); column — колонка NocoDB.
const CONTACT_EDIT_FIELDS = [
    { key: 'name',      column: 'Имя',             icon: '👤', label: 'Имя',               minLen: 2 },
    { key: 'phone',     column: 'Телефон',         icon: '📱', label: 'Телефон' },
    { key: 'username',  column: 'Ссылка',          icon: '🔗', label: 'Username / Ссылка' },
    { key: 'email',     column: 'E-mail',          icon: '✉️', label: 'E-mail' },
    { key: 'greeting',  column: 'Обращение',       icon: '🙂', label: 'Обращение' },
    { key: 'extra',     column: 'Доп. информация', icon: '📝', label: 'Доп. информация' }
];
// Мессенджер правим КНОПКАМИ (валидные опции селекта NocoDB), а не текстом —
// поэтому его нет в CONTACT_EDIT_FIELDS, а меню дополняется отдельной кнопкой.
const CONTACT_EDIT_MESSENGER = { key: 'messenger', column: 'Мессенджер', icon: '💬', label: 'Мессенджер' };

// Единый источник скалярных полей юрлица, доступных для правки из бота.
const LEGAL_EDIT_FIELDS = [
    { key: 'shortName', column: 'Краткое Имя',        icon: '🏷', label: 'Краткое имя',       minLen: 2 },
    { key: 'fullName',  column: 'Имя',                icon: '📛', label: 'Полное имя',        minLen: 2 },
    { key: 'unp',       column: 'УНП',                icon: '🧾', label: 'УНП' },
    { key: 'phone',     column: 'Телефон',            icon: '📱', label: 'Телефон' },
    { key: 'email',     column: 'E-mail',             icon: '✉️', label: 'E-mail' },
    { key: 'address',   column: 'Адрес',              icon: '📍', label: 'Адрес' },
    { key: 'delivery',  column: 'Адрес доставки',     icon: '🚚', label: 'Адрес доставки' },
    { key: 'bank',      column: 'Банк',               icon: '🏦', label: 'Банк' },
    { key: 'account',   column: 'р/с',                icon: '💳', label: 'р/с' },
    { key: 'bik',       column: 'БИК',                icon: '🔢', label: 'БИК' },
    { key: 'agreement', column: 'Договор основания',  icon: '📑', label: 'Договор основания' },
    { key: 'extra',     column: 'Дополнительно',      icon: '📝', label: 'Дополнительно' }
];

// Значение для кнопок меню и строк истории: без переносов, обрезано.
function shortEditValue(v, maxLen = 40) {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return '—';
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

// Дописывает строку аудита в history-поле («Доп. информация»/«Дополнительно»).
// Блок «✏️ История правок:» отделяет служебные записи от клиентского содержимого;
// новые записи встают в начало блока (свежие сверху).
function appendHistoryEntry(extra, who, entry) {
    const ts = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });
    const line = `[${ts}] ${who}: ${entry}`;
    const marker = '✏️ История правок:';
    const oldExtra = String(extra || '').trim();
    if (!oldExtra) return `${marker}\n${line}`;
    if (oldExtra.includes(marker)) return oldExtra.replace(marker, `${marker}\n${line}`);
    return `${oldExtra}\n\n${marker}\n${line}`;
}

// Меню правки контакта: список полей кнопками с текущими значениями.
async function sendContactEditMenu(chatId, messageId, contactId, role, telegramId) {
    try {
        const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const c = res.data;
        const rows = [];
        for (const f of CONTACT_EDIT_FIELDS) {
            rows.push([{ text: `${f.icon} ${f.label}: ${cleanButtonText(shortEditValue(c[f.column], 26), 46)}`, callback_data: `cc_field_${contactId}_${f.key}` }]);
        }
        const m = CONTACT_EDIT_MESSENGER;
        rows.push([{ text: `${m.icon} ${m.label}: ${cleanButtonText(shortEditValue(c['Мессенджер'], 26), 46)}`, callback_data: `cc_field_${contactId}_${m.key}` }]);
        rows.push([{ text: '⬅️ Назад к карточке', callback_data: `cc_edit_back_${contactId}` }]);
        const text = `✏️ *Редактирование контакта #${contactId}*\n\nЧто меняем? Текущие значения — на кнопках. Тапни по полю — пришлю новое значение.`;
        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
}


// ================== ПРАВКА ЮРЛИЦА: 2 ЭКРАНА (v4.45.0) ==================
// Раньше «✏️ Изменить» показывал ВСЕ 12 реквизитов разом (13 рядов — простыня).
// Теперь поля разбиты по смыслу: «Основные реквизиты» и «Банк и адреса».
// Группы — явные списки ключей из LEGAL_EDIT_FIELDS (порядок полей сохраняется).
const LEGAL_EDIT_PART_BASIC = ['shortName', 'fullName', 'unp', 'phone', 'email', 'agreement', 'extra'];
const LEGAL_EDIT_PART_BANK = ['address', 'delivery', 'bank', 'account', 'bik'];
const LEGAL_EDIT_PART_TITLES = { basic: 'Основные реквизиты', bank: 'Банк и адреса' };

// Меню правки юрлица: реквизиты кнопками с текущими значениями (экран part).
async function sendLegalEditMenu(chatId, messageId, legalId, role, telegramId, part = 'basic') {
    try {
        const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.LEGAL_ENTITIES}/${legalId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const l = res.data;
        const allowed = part === 'bank' ? LEGAL_EDIT_PART_BANK : LEGAL_EDIT_PART_BASIC;
        const rows = [];
        for (const f of LEGAL_EDIT_FIELDS) {
            if (!allowed.includes(f.key)) continue;
            rows.push([{ text: `${f.icon} ${f.label}: ${cleanButtonText(shortEditValue(l[f.column], 26), 46)}`, callback_data: `lc_field_${legalId}_${f.key}` }]);
        }
        const otherPart = part === 'bank' ? 'basic' : 'bank';
        rows.push([{ text: part === 'bank' ? '⏮ Основные реквизиты' : '⏭ Банк и адреса', callback_data: `lc_page_${legalId}_${otherPart}` }]);
        rows.push([{ text: '⬅️ Назад к карточке', callback_data: `lc_edit_back_${legalId}` }]);
        const partTitle = LEGAL_EDIT_PART_TITLES[part] || 'Реквизиты';
        const text = `✏️ *Редактирование юрлица #${legalId}* — ${partTitle}\n\nРеквизиты — на кнопках. Тапни по полю — пришлю новое значение.\n\n_Счета/акты подтянут свежие реквизиты автоматически (PDF генерится из БД)._`;
        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
}

// 🆕 v4.17.0: Извлекает ID из Link-поля NocoDB (объект {Id}, массив [{Id}] или число)
async function editError(chatId, text) {
    await bot.sendMessage(chatId, `❌ ${text}\n\n_Можно ввести заново или /cancel._`, { parse_mode: 'Markdown' });
}

// Правка скалярного поля контакта (state WAITING_EDIT_VALUE, kind='contact').
// Валидация по типу поля → точечный PATCH → аудит в «Доп. информация» → карточка.
async function applyContactFieldEdit(chatId, telegramId, contactId, fieldKey, rawText) {
    // v4.43.1 (hardening): право на правку базы проверяем в МОМЕНТ записи, а не только
    // при клике по «✏️»/выбору поля. Между кликом и вводом значения роль могли понизить
    // или сотрудника убрать (кэш обновляется раз в минуту) — запись не должна пройти.
    if (!canSeeContacts(telegramId)) {
        await bot.sendMessage(chatId, '⛔ Право на редактирование базы изменилось — правка отменена.');
        resetState(chatId);
        return;
    }
    const meta = CONTACT_EDIT_FIELDS.find(f => f.key === fieldKey);
    if (!meta) { await bot.sendMessage(chatId, '❌ Неизвестное поле — правка отменена.'); resetState(chatId); return; }
    const value = String(rawText || '').trim();
    if (!value) return editError(chatId, 'Значение не может быть пустым.');
    if (meta.minLen && value.length < meta.minLen) return editError(chatId, `Слишком короткое значение: минимум ${meta.minLen} символа.`);
    if (fieldKey === 'email' && !value.includes('@')) return editError(chatId, 'Не похоже на e-mail — нужен знак «@».');
    if (fieldKey === 'phone' && (value.match(/\d/g) || []).length < 7) return editError(chatId, 'Не похоже на телефон. Пример: +375 29 123-45-67');

    let finalValue = value;
    let dupSearch = null;
    if (fieldKey === 'username') {
        const m = value.match(/@?([a-zA-Z0-9_]{3,})/);
        if (!m) return editError(chatId, 'Username: латиница, цифры и «_», минимум 3 символа. Пример: @ivanov');
        finalValue = `https://t.me/${m[1]}`;
        dupSearch = m[1];
    }

    // Дубли телефон/username — защита от задвоения контактов (себя не считаем).
    if (fieldKey === 'phone' || fieldKey === 'username') {
        const dup = await findDuplicateContact(null, fieldKey === 'phone' ? value : null, dupSearch, contactId);
        if (dup) return editError(chatId, `⛔ Это значение уже у контакта «${dup['Имя'] || ('#' + dup.Id)}» — дубль не сохраняем.`);
    }

    try {
        const emp = telegramId ? getEmployee(telegramId) : null;
        const who = (emp && (emp.Обращение || emp.Имя)) || 'Сотрудник';
        const current = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
        const oldVal = shortEditValue(current[meta.column], 60);
        const patch = { [meta.column]: finalValue };
        // Правка самой «Доп. информации» перезаписывает поле — историю в неё же не пишем,
        // иначе новая запись аудита затёрла бы новый текст (обе пишутся в одну колонку).
        if (fieldKey !== 'extra') patch['Доп. информация'] = appendHistoryEntry(current['Доп. информация'], who, `${meta.label}: ${oldVal} → ${shortEditValue(finalValue, 60)}`);
        await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, patch, { headers: { 'xc-token': config.NOCO_TOKEN } });
        noco.invalidateTable(config.TABLES.CONTACTS);
        resetState(chatId);
        await bot.sendMessage(chatId, `✅ ${meta.icon} *${meta.label}* обновлено: ${escapeMarkdown(shortEditValue(finalValue, 120))}`, { parse_mode: 'Markdown' });
        const emp2 = telegramId ? getEmployee(telegramId) : null;
        await sendContactDetails(chatId, null, contactId, emp2 ? emp2.Роль : ROLES.EXECUTOR, telegramId);
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка сохранения: ${err.message}`);
        resetState(chatId);
    }
}

// Правка мессенджера контакта (выбор кнопками ccmsg_* — text-ввод не нужен).
async function applyContactMessengerEdit(chatId, telegramId, contactId, messenger) {
    // v4.43.1 (hardening): см. applyContactFieldEdit — право проверяем на момент записи.
    if (!canSeeContacts(telegramId)) {
        await bot.sendMessage(chatId, '⛔ Право на редактирование базы изменилось — правка отменена.');
        resetState(chatId);
        return;
    }
    try {
        const emp = telegramId ? getEmployee(telegramId) : null;
        const who = (emp && (emp.Обращение || emp.Имя)) || 'Сотрудник';
        const current = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
        const oldVal = shortEditValue(current['Мессенджер'], 40);
        const patch = { 'Мессенджер': messenger };
        patch['Доп. информация'] = appendHistoryEntry(current['Доп. информация'], who, `Мессенджер: ${oldVal} → ${messenger}`);
        await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, patch, { headers: { 'xc-token': config.NOCO_TOKEN } });
        noco.invalidateTable(config.TABLES.CONTACTS);
        resetState(chatId);
        await bot.sendMessage(chatId, `✅ 💬 *Мессенджер* обновлён: ${messenger}`, { parse_mode: 'Markdown' });
        const emp2 = telegramId ? getEmployee(telegramId) : null;
        await sendContactDetails(chatId, null, contactId, emp2 ? emp2.Роль : ROLES.EXECUTOR, telegramId);
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка сохранения: ${err.message}`);
        resetState(chatId);
    }
}

// Правка скалярного поля юрлица (state WAITING_EDIT_VALUE, kind='legal').
async function applyLegalFieldEdit(chatId, telegramId, legalId, fieldKey, rawText) {
    // v4.43.1 (hardening): см. applyContactFieldEdit — право проверяем на момент записи.
    if (!canSeeContacts(telegramId)) {
        await bot.sendMessage(chatId, '⛔ Право на редактирование базы изменилось — правка отменена.');
        resetState(chatId);
        return;
    }
    const meta = LEGAL_EDIT_FIELDS.find(f => f.key === fieldKey);
    if (!meta) { await bot.sendMessage(chatId, '❌ Неизвестное поле — правка отменена.'); resetState(chatId); return; }
    const value = String(rawText || '').trim();
    if (!value) return editError(chatId, 'Значение не может быть пустым.');
    if (meta.minLen && value.length < meta.minLen) return editError(chatId, `Слишком короткое значение: минимум ${meta.minLen} символа.`);
    if (fieldKey === 'email' && !value.includes('@')) return editError(chatId, 'Не похоже на e-mail — нужен знак «@».');
    if (fieldKey === 'phone' && (value.match(/\d/g) || []).length < 7) return editError(chatId, 'Не похоже на телефон. Пример: +375 29 123-45-67');

    try {
        const emp = telegramId ? getEmployee(telegramId) : null;
        const who = (emp && (emp.Обращение || emp.Имя)) || 'Сотрудник';
        const current = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.LEGAL_ENTITIES}/${legalId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
        const oldVal = shortEditValue(current[meta.column], 60);
        const patch = { [meta.column]: value };
        // Правка «Дополнительно» перезаписывает поле — историю в неё же не пишем (см. контакт).
        if (fieldKey !== 'extra') patch['Дополнительно'] = appendHistoryEntry(current['Дополнительно'], who, `${meta.label}: ${oldVal} → ${shortEditValue(value, 60)}`);
        await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.LEGAL_ENTITIES}/${legalId}`, patch, { headers: { 'xc-token': config.NOCO_TOKEN } });
        noco.invalidateTable(config.TABLES.LEGAL_ENTITIES);
        resetState(chatId);
        await bot.sendMessage(chatId, `✅ ${meta.icon} *${meta.label}* обновлено: ${escapeMarkdown(shortEditValue(value, 120))}`, { parse_mode: 'Markdown' });
        const emp2 = telegramId ? getEmployee(telegramId) : null;
        await sendLegalDetails(chatId, null, legalId, emp2 ? emp2.Роль : ROLES.EXECUTOR, telegramId);
    } catch (err) {
        bot.sendMessage(chatId, `❌ Ошибка сохранения: ${err.message}`);
        resetState(chatId);
    }
}

// Привязка контакта к юрлицу. Открывает выбор юрлица: последние 5 + поиск.
async function sendOrgSelectionForContact(chatId, contactId) {
    try {
        const sess = getSession(sessions, chatId);
        sess.orgDraft.contactId = contactId;
        const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.LEGAL_ENTITIES}?limit=5&sort=-Id`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const legals = res.data.list || [];
        let text = `🏢 *К какому юрлицу привязать контакт?*`;
        if (legals.length === 0) text += '\n\n_В базе пока нет юрлиц._';
        const kb = [];
        for (const l of legals) {
            const name = l['Краткое Имя'] || l['Имя'] || 'Без имени';
            const phone = l['Телефон'] ? ` · ${cleanButtonText(l['Телефон'], 14)}` : '';
            kb.push([{ text: `🏢 ${cleanButtonText(name, 34)}${phone}`, callback_data: `org_pick_${contactId}_${l.Id}` }]);
        }
        kb.push([{ text: '🔍 Найти по названию/УНП', callback_data: `org_search_${contactId}` }]);
        kb.push([{ text: '⬅️ Отмена', callback_data: `org_cancel_${contactId}` }]);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
}

// Результат поиска юрлиц для привязки к контакту (state WAITING_ORG_SEARCH).
async function showFoundLegalsForOrg(chatId, contactId, query) {
    try {
        const allLegals = await fetchAllRows(config.TABLES.LEGAL_ENTITIES);
        const q = normalizeSearch(query);
        const found = allLegals.filter(l => {
            return [l['Краткое Имя'], l['Имя'], l['Телефон'], l['E-mail'], l['УНП'], l['Адрес']].some(f => normalizeSearch(f).includes(q));
        });
        if (found.length === 0) {
            const kb = [
                [{ text: '🔍 Уточнить запрос', callback_data: `org_search_${contactId}` }],
                [{ text: '⬅️ Отмена', callback_data: `org_cancel_${contactId}` }]
            ];
            await bot.sendMessage(chatId, `❌ Ничего не найдено по запросу "*${escapeMarkdown(query)}*"`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
            return;
        }
        let text = `🏢 *Найдено юрлиц: ${found.length}*`;
        if (found.length > 15) text += '\n_Показаны первые 15 — уточни запрос_';
        const kb = [];
        found.slice(0, 15).forEach(l => {
            const name = l['Краткое Имя'] || l['Имя'] || 'Без имени';
            const phone = l['Телефон'] ? ` 📱${escapeMarkdown(l['Телефон'])}` : '';
            kb.push([{ text: `🏢 ${escapeMarkdown(name)}${phone}`, callback_data: `org_pick_${contactId}_${l.Id}` }]);
        });
        kb.push([{ text: '🔍 Уточнить запрос...', callback_data: `org_search_${contactId}` }]);
        kb.push([{ text: '⬅️ Отмена', callback_data: `org_cancel_${contactId}` }]);
        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка поиска: ${err.message}`); }
}

// Вызов webhook привязки/отвязки (legalId <= 0 = отвязка). Правка junction напрямую —
// PATCH Link-полей NocoDB CE не умеет (Known Limitations). Возвращает { ok, error }.
async function setContactOrgLink(contactId, legalId) {
    try {
        const res = await axios.post(`${WEBHOOK_URL}/set-contact-org?secret=${process.env.WEBHOOK_SECRET || ''}`, { contactId, legalId: legalId || 0 }, { timeout: 15000, validateStatus: () => true });
        if (res.status >= 400) {
            return { ok: false, error: (res.data && res.data.error) || `Вебхук вернул статус ${res.status}` };
        }
        noco.invalidateTable(config.TABLES.CONTACTS);
        noco.invalidateTable(config.TABLES.LEGAL_ENTITIES);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// Дописывает в историю контакта событие, пришедшее НЕ из визарда правки поля
// (привязка/отвязка юрлица). Ошибка аудита не должна ронять основную операцию.
async function addContactHistoryEntry(contactId, who, entry) {
    try {
        const current = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
        await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { 'Доп. информация': appendHistoryEntry(current['Доп. информация'], who, entry) }, { headers: { 'xc-token': config.NOCO_TOKEN } });
        noco.invalidateTable(config.TABLES.CONTACTS);
        return true;
    } catch (err) {
        console.log(`⚠️ Не удалось записать историю контакта #${contactId}: ${err.message}`);
        return false;
    }
}

function extractLinkId(field) {
    if (Array.isArray(field)) return field[0]?.Id ?? field[0] ?? null;
    if (typeof field === 'object' && field !== null) return field.Id ?? null;
    return field ?? null;
}

// 🆕 v4.17.0: Сводка по проекту — задачи (всего/выполнено/просрочено) и позиции заказа (кол-во, сумма).
// Паттерн как в server.js `calculateProjectTotal` — связи фильтруем в коде (API не умеет).
// 🆕 v4.37.0: позиции «Мат. заказчика» исключаются из счёта и суммы (как в документах —
// они идут отдельной таблицей без цен); НДС считается единым модулем shared/vat.js
// по «Мои реквизиты» (ставка + тип), как в форме отправки email.
async function getProjectSummary(projectId) {
    try {
        const [tasks, items] = await Promise.all([
            fetchAllRows(config.TABLES.TASKS),
            fetchAllRows(config.TABLES.ITEMS)
        ]);
        // «Мои реквизиты» — отдельно: если таблица недоступна/пуста, сводка не должна падать
        // (НДС просто не покажется). Прямой GET ?limit=1 (БЕЗ offset — связка limit+offset
        // на этой таблице в NocoDB 2026.08.0 даёт 422; паттерн как в server.js /send-email).
        let myDetailsRows = [];
        try {
            if (config.TABLES.MY_DETAILS) {
                const mdRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.MY_DETAILS}?limit=1`, { headers: { 'xc-token': config.NOCO_TOKEN } });
                myDetailsRows = mdRes.data.list || [];
            }
        } catch (e) {
            console.log(`⚠️ Сводка: не удалось получить «Мои реквизиты» (НДС не покажем): ${e.message}`);
        }
        const now = Date.now();
        let tasksTotal = 0, tasksDone = 0, tasksOverdue = 0;
        for (const t of tasks) {
            if (extractLinkId(t['Какой проект']) != projectId) continue;
            tasksTotal++;
            if (t['Готово']) { tasksDone++; continue; }
            if (t['Когда делаем'] && new Date(t['Когда делаем']).getTime() < now) tasksOverdue++;
        }
        let itemsCount = 0, itemsTotal = 0;
        for (const it of items) {
            if (extractLinkId(it['Проекты']) != projectId) continue;
            if (vat.isCustomerMaterial(it)) continue; // материалы заказчика — не платные позиции
            itemsCount++;
            const s = parseFloat(String(it['Сумма']).replace(',', '.'));
            if (!isNaN(s)) itemsTotal += s;
        }
        const my = (myDetailsRows && myDetailsRows[0]) || {};
        const vatCalc = vat.computeVat(itemsTotal, my['Ставка НДС'], my['Тип НДС']);
        return {
            tasksTotal, tasksDone, tasksOverdue,
            itemsCount, itemsTotal, // itemsTotal — база БЕЗ НДС
            vatRate: vatCalc.vatRate,
            vatType: vatCalc.vatType,
            vatAmount: vatCalc.vatAmount,
            itemsTotalWithVat: vatCalc.totalWithVat
        };
    } catch (err) {
        console.error('Ошибка сводки проекта:', err.message);
        return { tasksTotal: 0, tasksDone: 0, tasksOverdue: 0, itemsCount: 0, itemsTotal: 0, vatRate: 0, vatType: vat.VAT_NONE, vatAmount: 0, itemsTotalWithVat: 0 };
    }
}

// 🆕 v4.17.0: Меню выбора нового статуса проекта (кнопка «📊 Изменить статус» в карточке)
async function sendProjectStatusMenu(chatId, messageId, projectId, role, telegramId) {
    const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
    const p = res.data;

    const emp = telegramId ? getEmployee(telegramId) : null;
    if (role === ROLES.EXECUTOR) {
        bot.sendMessage(chatId, '⛔ У вас нет доступа к проектам');
        return;
    }
    if (role === ROLES.MANAGER && extractLinkId(p['Менеджер']) !== emp?.Id) {
        bot.sendMessage(chatId, '⛔ Вы можете менять статус только своих проектов');
        return;
    }

    const current = p['Статус'] || '—';
    // v4.45.0: статусы спарены по 2 в ряд (pairRow) — было 5 рядов по одному.
    const statusButtons = pairRow(PROJECT_STATUSES.map((s, i) => ({
        text: `${s === current ? '✅ ' : ''}${s}`,
        callback_data: `pst_set_${projectId}_${i}`
    })));
    statusButtons.push([{ text: '⬅️ Назад', callback_data: `pcard_${projectId}` }]);

    const text = `🚀 *${escapeMarkdown(p['Что делаем?'] || 'Без названия')}* (#${p.Id})\n\n📊 *Текущий статус:* ${escapeMarkdown(current)}\n\nВыбери новый статус:`;
    try {
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: statusButtons } });
        else await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: statusButtons } });
    } catch (e) {
        console.error('❌ Отправка меню статуса:', e.message);
        await bot.sendMessage(chatId, plainTextFromMarkdown(text), { reply_markup: { inline_keyboard: statusButtons } });
    }
}


// ================== КАРТОЧКА ПРОЕКТА (просмотр подробностей) ==================
// Открывается кнопкой «👁 #id» из списка проектов. Показывает реквизиты проекта
// и блок «📝 Подробности» (пересланное, история из forward-флоу).
async function sendProjectDetails(chatId, messageId, projectId, role, telegramId, backTo = 'pcard_back') {
    const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
    const p = res.data;

    let text = `🚀 *${escapeMarkdown(p['Что делаем?'] || 'Без названия')}* (#${p.Id})\n\n`;
    if (p['Статус']) text += `📊 *Статус:* ${escapeMarkdown(p['Статус'])}\n`;
    // 🆕 v4.18.0: Срок проекта с подсветкой (🔴 просрочен / 🟡 скоро / 📅 в норме)
    if (p['Срок проекта']) {
        const deadlineMs = new Date(String(p['Срок проекта']).slice(0, 10) + 'T00:00:00').getTime();
        const daysLeft = Math.ceil((deadlineMs - Date.now()) / 86400000);
        let emoji = '📅';
        if (daysLeft < 0) emoji = '🔴';
        else if (daysLeft <= 3) emoji = '🟡';
        let datePart = escapeMarkdown(formatMinskDateShort(p['Срок проекта']));
        if (daysLeft < 0) datePart += ' (просрочен!)';
        else if (daysLeft === 0) datePart += ' (сегодня!)';
        else if (daysLeft === 1) datePart += ' (завтра)';
        else if (daysLeft <= 3) datePart += ` (через ${daysLeft} дн.)`;
        text += `${emoji} *Срок:* ${datePart}\\n`;
    }

    if (p['Менеджер'] && (role === ROLES.ADMIN || role === ROLES.MANAGER)) {
        text += `👤 *Менеджер:* ${escapeMarkdown(p['Менеджер']['ФИО'] || 'Сотрудник')}\n`;
    }
    // Клиент: приоритет Юрлицо → Контакт (как у webhook)
    const org = p['Юрлицо'];
    const contact = p['Контакт'];
    if (org) {
        const orgName = org['Краткое Имя'] || org['Имя'] || '';
        if (orgName) text += `🏢 *Клиент:* ${escapeMarkdown(orgName)}\n`;
    } else if (contact) {
        const contactField = Array.isArray(contact) ? contact[0] : contact;
        if (contactField && contactField['Имя']) text += `👤 *Клиент:* ${escapeMarkdown(contactField['Имя'])}\n`;
    }
    if (p['Имя для документов']) text += `📄 *Имя для документов:* ${escapeMarkdown(p['Имя для документов'])}\n`;
    if (p['Договор основания']) text += `📑 *Договор основания:* ${escapeMarkdown(p['Договор основания'])}\n`;
    if (p['По деньгам?']) text += `💰 *По деньгам?:* ${escapeMarkdown(p['По деньгам?'])}\n`;
    if (p['Предоплата']) text += `💵 *Предоплата:* ${escapeMarkdown(String(p['Предоплата']))}\n`;

    // 🆕 v4.17.0: Сводка задач и позиций проекта
    const summary = await getProjectSummary(projectId);
    if (summary.tasksTotal > 0 || summary.itemsCount > 0) {
        const sumParts = [];
        if (summary.tasksTotal > 0) {
            let taskPart = `📋 *Задачи:* ${summary.tasksTotal}`;
            if (summary.tasksDone > 0) taskPart += ` (✅ ${summary.tasksDone} выполнено)`;
            if (summary.tasksOverdue > 0) taskPart += `, ⏰ ${summary.tasksOverdue} просрочено`;
            sumParts.push(taskPart);
        }
        if (summary.itemsCount > 0) {
            // v4.37.0: сумма позиций — база БЕЗ НДС; для «Начисляется сверху» и «Включен в цену»
            // показываем разбивку по «Мои реквизиты» (ставка/тип), как в документах и email.
            const fmtMoney = (n) => n.toFixed(2).replace(/\.00$/, '').replace('.', ',');
            const baseStr = fmtMoney(summary.itemsTotal);
            const isVatOnTop = summary.vatType === vat.VAT_ON_TOP && summary.vatRate > 0;
            const isVatIncluded = summary.vatType === vat.VAT_INCLUDED && summary.vatRate > 0;
            if (isVatOnTop) {
                sumParts.push(`💰 *Позиции:* ${summary.itemsCount} шт, сумма без НДС ${baseStr} BYN`);
                sumParts.push(`   _НДС (${summary.vatRate}%, начисляется сверху):_ +${fmtMoney(summary.vatAmount)} BYN`);
                sumParts.push(`   *Итого к оплате: ${fmtMoney(summary.itemsTotalWithVat)} BYN*`);
            } else if (isVatIncluded) {
                sumParts.push(`💰 *Позиции:* ${summary.itemsCount} шт, сумма ${baseStr} BYN`);
                sumParts.push(`   _В т.ч. НДС (${summary.vatRate}%):_ ${fmtMoney(summary.vatAmount)} BYN`);
            } else {
                sumParts.push(`💰 *Позиции:* ${summary.itemsCount} шт, сумма ${baseStr} BYN`);
            }
        }
        if (sumParts.length > 0) text += `\n${sumParts.join('\n')}\n`;
    }

    const details = String(p['Подробности'] || '').trim();
    if (details) {
        const maxLen = 3000;
        const shown = details.length > maxLen ? details.slice(0, maxLen) + '\n\n…(обрезано, полный текст — в NocoDB)' : details;
        text += `\n📝 *Подробности:*\n${escapeMarkdown(shown)}`;
    } else {
        text += '\n📝 *Подробности:* пока нет';
    }

    // Кнопки действий карточки. Раньше каждая кнопка была отдельным рядом —
    // «простыня» из 9-10 рядов. Теперь кнопки спарены по 2 в ряд (смысловые
    // пары рядом: управление — статус/срок, работа — задачи/задача, сделка —
    // позиции/документы + деньги/заметка). callback_data НЕ меняются — «залипшие»
    // кнопки старых сообщений продолжают работать (правило BOT_REFACTORING.md).
    const inlineKeyboard = [];
    if (role === ROLES.ADMIN || role === ROLES.MANAGER) {
        // v4.42.4: внесение оплат — «выстрел наружу», только с флагом canSendDocuments
        const canPayDocs = roles.canSendDocuments(getEmployee(telegramId));
        const actions = [
            { text: '📊 Изменить статус', callback_data: `pst_${projectId}` },
            { text: '📅 Срок', callback_data: `pdeadline_${projectId}` },
            { text: '📋 Задачи проекта', callback_data: `ptasks_${projectId}` },
            { text: '➕ Задача в проект', callback_data: `ptask_new_${projectId}` },
            { text: '📝 Позиции', callback_data: `proj_items_${projectId}` },
            { text: '📄 Документы', callback_data: `docs_list_${projectId}` }
        ];
        if (canPayDocs) actions.push({ text: '💵 Оплаты', callback_data: `pay_${projectId}` });
        actions.push({ text: '➕ Заметка', callback_data: `pnote_${projectId}` });
        if (role === ROLES.ADMIN) {
            actions.push({ text: '👥 Передать менеджеру', callback_data: `ptransfer_${projectId}` });
        }
        // v4.25.0: проект без клиента — нельзя создать папку и документы. Даём способ привязать.
        const hasClient = p['Юрлицо'] || (Array.isArray(p['Контакт']) ? p['Контакт'][0] : p['Контакт']);
        if (!hasClient) {
            actions.push({ text: '👤 Привязать клиента', callback_data: `pattach_${p.Id}` });
        }
        // Спариваем по 2 в ряд (при нечётном количестве последняя кнопка одна).
        for (let i = 0; i < actions.length; i += 2) {
            inlineKeyboard.push(actions.slice(i, i + 2));
        }
    }
    inlineKeyboard.push([{ text: '⬅️ Назад', callback_data: backTo || 'pcard_back' }]);

    const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
    if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    else await bot.sendMessage(chatId, text, options);
}

// Карточка позиции (действия: цена/кол-во/удалить)
async function sendProjectItemDetails(chatId, messageId, itemId, projectId) {
    try {
        const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.ITEMS}/${itemId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const it = res.data;
        const fmtMoney = (n) => parseFloat(n || 0).toFixed(2).replace(/\.00$/, '').replace('.', ',');
        const price = parseFloat(String(it['Цена']).replace(',', '.')) || 0;
        const qty = parseFloat(String(it['Кол-во']).replace(',', '.')) || 0;
        const isMaterial = vat.isCustomerMaterial(it);
        const icon = ITEM_TYPE_ICONS[it['Тип']] || '📄';
        const name = it['Название'] || it['Название (ТН)'] || 'Без названия';

        let text = `${icon} *${escapeMarkdown(cleanButtonText(name, 60))}*\n`;
        text += `🆔 Позиция #${itemId} в проекте #${projectId}\n`;
        text += `🏷 Тип: ${it['Тип'] || '—'}\n`;
        text += `🧮 Кол-во: ${qty} ${it['Ед. изм.'] || 'шт.'}\n`;
        if (isMaterial) {
            text += `ℹ️ Материал заказчика — в счёт и сумму НЕ входит (в документах идёт отдельной таблицей).\n`;
        } else {
            text += `💰 Цена: ${fmtMoney(price)} BYN / ${it['Ед. изм.'] || 'шт.'}\n`;
            text += `💵 Сумма: *${fmtMoney(price * qty)} BYN* (без НДС)\n`;
        }
        if (it['Название (ТН)']) text += `\n📦 Для накладной (ТН): ${escapeMarkdown(cleanButtonText(String(it['Название (ТН)']), 60))}`;
        if (it['Примечания']) text += `\n📌 ${escapeMarkdown(cleanButtonText(String(it['Примечания']), 200))}`;

        const inlineKeyboard = [];
        if (!isMaterial) {
            inlineKeyboard.push([
                { text: '✏️ Цена', callback_data: `pitem_price_${itemId}_${projectId}` },
                { text: '✏️ Кол-во', callback_data: `pitem_qty_${itemId}_${projectId}` }
            ]);
        } else {
            inlineKeyboard.push([{ text: '✏️ Кол-во', callback_data: `pitem_qty_${itemId}_${projectId}` }]);
        }
        inlineKeyboard.push([{ text: '🗑 Удалить позицию', callback_data: `pitem_del_${itemId}_${projectId}` }]);
        inlineKeyboard.push([{ text: '⬅️ К позициям', callback_data: `proj_items_${projectId}` }]);

        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
        if (messageId) await editMessageIgnoreSame(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (err) {
        console.error('Ошибка карточки позиции:', err.message);
        bot.sendMessage(chatId, `❌ Не удалось загрузить позицию: ${err.message}`).catch(() => {});
    }
}

// Клавиатура выбора единицы измерения (callback: pitem_unit_{ед}_{projectId}).
// v4.45.0: пары по 2 в ряд (pairRow) — было 5 рядов по одному.
function itemUnitKeyboard(projectId) {
    return pairRow(ITEM_UNITS.map(u => ({ text: u, callback_data: `pitem_unit_${u}_${projectId}` })));
}

// Превью черновика позиции перед сохранением (из sess.itemDraft)
function sendItemDraftPreview(chatId, projectId) {
    const sess = getSession(sessions, chatId);
    const d = sess.itemDraft;
    const fmtMoney = (n) => parseFloat(n || 0).toFixed(2).replace(/\.00$/, '').replace('.', ',');
    const isMaterial = d.type === vat.CUSTOMER_MATERIAL;
    const price = parseFloat(d.price) || 0;
    const qty = parseFloat(d.qty) || 0;
    let text = '📝 *Проверь позицию:*\n';
    text += `🏷 Тип: ${(ITEM_TYPE_ICONS[d.type] || '') + ' ' + (d.type || '—')}\n`;
    text += `📝 ${escapeMarkdown(cleanButtonText(d.name || '—', 60))}\n`;
    text += `🧮 ${qty} ${d.unit || 'шт.'}\n`;
    if (isMaterial) text += `ℹ️ Материал заказчика — без цены, в счёт не входит.\n`;
    else text += `💰 Цена: ${fmtMoney(price)} BYN/${d.unit || 'шт.'} → *${fmtMoney(price * qty)} BYN*\n`;
    text += `\nПроект: #${projectId}`;

    const keyboard = [
        [{ text: '✅ Сохранить', callback_data: 'pitem_save' }, { text: '❌ Отмена', callback_data: 'pitem_cancel' }]
    ];
    return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
}


// ================== ПОЗИЦИИ ЗАКАЗА (v4.42.1, Волна A) ==================
// Тихий editMessageText: Telegram отклоняет edit, если новый контент идентичен
// текущему («400 message is not modified») — это НЕ ошибка, а «всё уже так».
// Используется в рендерах, которые могут вызываться повторно на том же сообщении
// (карточка документа после отправки и т.п.).
async function editMessageIgnoreSame(text, opts) {
    try {
        await bot.editMessageText(text, opts);
    } catch (e) {
        const m = String((e && e.message) || '');
        if (!/message is not modified/i.test(m)) {
            console.error('⚠️ editMessageText:', m);
        }
    }
}


// «📝 Позиции» в карточке проекта: ведение сделки (право роли Менеджер+).
// Модель «внутри/наружу»: позиции ничего наружу не отправляют — флаг не нужен.
// Платные (Товар/Работа/Товар+Работа) считаются в счёт; «Мат. заказчика» —
// отдельным блоком БЕЗ цен (как в документах, см. shared/vat.js).
const ITEM_TYPES_PAID = ['Товар', 'Работа', 'Товар+Работа'];
const ITEM_UNITS = ['шт.', 'л.', 'кг.', 'г.', 'к-т'];
const ITEM_TYPE_ICONS = { 'Товар': '📦', 'Работа': '🔧', 'Товар+Работа': '📦+🔧', 'Мат. заказчика': '🧱' };

// Число из текста менеджера: «45», «45,5», «45.5» → число (или NaN)
function parseMoneyInput(text) {
    if (text === null || text === undefined) return NaN;
    return parseFloat(String(text).trim().replace(',', '.'));
}

// Рендер списка позиций проекта (текст + кнопки-пункты). Guard владения —
// в main.js ДО вызова (как у pcard_/ptasks_); здесь — только рендер.
async function sendProjectItemsList(chatId, messageId, projectId) {
    try {
        const fmtMoney = (n) => parseFloat(n || 0).toFixed(2).replace(/\.00$/, '').replace('.', ',');
        const [projRes, items] = await Promise.all([
            axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } }),
            fetchAllRows(config.TABLES.ITEMS)
        ]);
        const project = projRes.data;
        const byId = (a, b) => (a.Id || 0) - (b.Id || 0);
        const projectItems = items.filter(it => extractLinkId(it['Проекты']) === projectId).sort(byId);
        const paid = projectItems.filter(it => !vat.isCustomerMaterial(it));
        const materials = projectItems.filter(it => vat.isCustomerMaterial(it));

        const projName = project ? cleanButtonText(project['Что делаем?'] || `#${projectId}`, 45) : `#${projectId}`;
        let text = `📝 *Позиции заказа* — «${escapeMarkdown(projName)}» (#${projectId})\n`;

        // Итог (база/НДС) — единый расчёт getProjectSummary (та же разбивка, что в карточке)
        const summary = await getProjectSummary(projectId);
        const isVatOnTop = summary.vatType === vat.VAT_ON_TOP && summary.vatRate > 0;
        const isVatIncluded = summary.vatType === vat.VAT_INCLUDED && summary.vatRate > 0;
        if (isVatOnTop) {
            text += `💰 *Итого без НДС:* ${fmtMoney(summary.itemsTotal)} BYN\n`;
            text += `   _НДС (${summary.vatRate}%, сверху):_ +${fmtMoney(summary.vatAmount)} BYN\n`;
            text += `   *К оплате: ${fmtMoney(summary.itemsTotalWithVat)} BYN*\n`;
        } else if (isVatIncluded) {
            text += `💰 *Итого:* ${fmtMoney(summary.itemsTotal)} BYN (в т.ч. НДС ${summary.vatRate}%: ${fmtMoney(summary.vatAmount)} BYN)\n`;
        } else {
            text += `💰 *Итого:* ${fmtMoney(summary.itemsTotal)} BYN (без НДС)\n`;
        }

        const inlineKeyboard = [];
        if (paid.length > 0) {
            text += `\n*Позиции к оплате:*\n`;
            paid.slice(0, 20).forEach((it, idx) => {
                const price = parseFloat(String(it['Цена']).replace(',', '.')) || 0;
                const qty = parseFloat(String(it['Кол-во']).replace(',', '.')) || 0;
                const sum = price * qty;
                const icon = ITEM_TYPE_ICONS[it['Тип']] || '';
                const label = `${idx + 1}. ${icon} ${cleanButtonText(it['Название'] || 'Без названия', 38)} · ${qty} ${it['Ед. изм.'] || 'шт.'} · ${fmtMoney(sum)} BYN`;
                inlineKeyboard.push([{ text: label, callback_data: `pitem_${it.Id}_${projectId}` }]);
            });
        }
        if (materials.length > 0) {
            text += `\n*🧱 Материалы заказчика* (в счёт не входят):\n`;
            materials.slice(0, 20).forEach((it, idx) => {
                const qty = parseFloat(String(it['Кол-во']).replace(',', '.')) || 0;
                const label = `${idx + 1}. 🧱 ${cleanButtonText(it['Название'] || 'Материал', 38)} · ${qty} ${it['Ед. изм.'] || 'шт.'}`;
                inlineKeyboard.push([{ text: label, callback_data: `pitem_${it.Id}_${projectId}` }]);
            });
        }
        if (paid.length === 0 && materials.length === 0) {
            text += `\n\n📭 Позиций пока нет. Добавь первую — из них соберётся счёт.`;
        }
        if (paid.length > 20 || materials.length > 20) {
            text += `\n_…показаны первые 20 строк блока (полный список — в NocoDB)_`;
        }
        text += `\n🧮 Суммы пересчитываются автоматически.`;

        inlineKeyboard.push([{ text: '➕ Добавить позицию', callback_data: `pitem_new_${projectId}` }]);
        inlineKeyboard.push([{ text: '⬅️ В карточку проекта', callback_data: `pcard_${projectId}` }]);

        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
        if (messageId) await editMessageIgnoreSame(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (err) {
        console.error('Ошибка списка позиций:', err.message);
        bot.sendMessage(chatId, `❌ Не удалось загрузить позиции: ${err.message}`).catch(() => {});
    }
}

// ================== ОПЛАТЫ (v4.42.4, Волна A) ==================
// «💵 Оплаты» в карточке проекта. Поступление пишем в «Предоплата» (накопительно),
// статус — в «По деньгам?» («Оплачен» при >= суммы к оплате, иначе «Частично»).
// Это «выстрел наружу» (деньги) — по флагу canSendDocuments (центральный guard).
function isProjectPaid(moneyText) {
    return /оплач/i.test(String(moneyText || ''));
}

// Set id проектов, где есть ОТПРАВЛЕННЫЙ счёт (для бейджа 💰 в списке проектов)
function collectInvoiceProjectIds(docs) {
    const set = new Set();
    (docs || []).forEach(d => {
        const t = d['Тип документа'];
        if ((t === 'Счет' || t === 'Счет (Физлицо)') && d['Статус'] === 'Отправлен') {
            const pid = extractLinkId(d['Проект']);
            if (pid !== null && pid !== undefined) set.add(Number(pid));
        }
    });
    return set;
}

// Меню оплат проекта (роль/владение и флаг проверены в main.js ДО вызова)
async function sendPaymentMenu(chatId, messageId, projectId) {
    try {
        const fmtMoney = (n) => parseFloat(n || 0).toFixed(2).replace(/\.00$/, '').replace('.', ',');
        const projRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const p = projRes.data;
        const summary = await getProjectSummary(projectId);
        const received = parseFloat(String(p['Предоплата']).replace(',', '.')) || 0;
        const projName = p['Что делаем?'] ? cleanButtonText(p['Что делаем?'], 45) : `#${projectId}`;

        let text = `💵 *Оплаты* — «${escapeMarkdown(projName)}» (#${projectId})\n`;
        if (summary.itemsTotalWithVat > 0) {
            text += `💰 К оплате (позиции с НДС): *${fmtMoney(summary.itemsTotalWithVat)} BYN*\n`;
        } else {
            text += `💰 Позиций с суммой пока нет — к оплате 0 BYN\n`;
        }
        text += `💵 Получено: *${fmtMoney(received)} BYN*\n`;
        text += `🏷 По деньгам?: ${p['По деньгам?'] ? escapeMarkdown(String(p['По деньгам?'])) : '—'}`;

        const inlineKeyboard = [
            [{ text: '💵 Внести оплату', callback_data: `pay_add_${projectId}` }],
            [{ text: '⬅️ В карточку проекта', callback_data: `pcard_${projectId}` }]
        ];
        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
        if (messageId) await editMessageIgnoreSame(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (err) {
        console.error('Ошибка меню оплат:', err.message);
        bot.sendMessage(chatId, `❌ Не удалось загрузить оплаты: ${err.message}`).catch(() => {});
    }
}


// ================== ДОКУМЕНТЫ (v4.42.2, Волна A) ==================
// «📄 Документы» в карточке проекта: список документов проекта, визард создания,
// генерация PDF (внутренний мотор server.js) и файл в чат. Создание/черновик —
// право роли Менеджер+ (guard владения в main.js). Отправка наружу — Шаг 4.
const DOC_TYPES = ['Счет', 'Счет (Физлицо)', 'Акт', 'Акт (Физлицо)', 'Накладная'];
const DOC_TYPE_ICONS = { 'Счет': '🧾', 'Счет (Физлицо)': '🧾', 'Акт': '📝', 'Акт (Физлицо)': '📝', 'Накладная': '📦' };
const DOC_STATUS_ICONS = { 'Черновик': '⏳', 'Отправлен': '📤', 'Закрыт': '✅' };

// Сегодня в таймзоне config.TZ как YYYY-MM-DD (формат Date-колонки NocoDB)
function todayNocoDate() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: config.TZ }).format(new Date());
}

// Номер документа: YYMMDD-Id (та же логика, что server.js generateDocNumber)
function docNumberFor(doc) {
    if (!doc || !doc.Id) return '—';
    const d = new Date(doc['Дата документа'] || new Date().toISOString());
    if (isNaN(d.getTime())) return String(doc.Id);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = String(d.getFullYear()).slice(-2);
    return `${year}${month}${day}-${doc.Id}`;
}

// Список документов проекта (роль/владение — проверены в main.js ДО вызова)
async function sendProjectDocsList(chatId, messageId, projectId) {
    try {
        const [projRes, docs] = await Promise.all([
            axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } }),
            fetchAllRows(config.TABLES.DOCUMENTS)
        ]);
        const project = projRes.data;
        const projectDocs = docs
            .filter(d => extractLinkId(d['Проект']) === projectId)
            .sort((a, b) => (b.Id || 0) - (a.Id || 0)); // новые сверху

        const projName = project ? cleanButtonText(project['Что делаем?'] || `#${projectId}`, 45) : `#${projectId}`;
        let text = `📄 *Документы* — «${escapeMarkdown(projName)}» (#${projectId})\n\n`;
        text += `Документ формируется из позиций проекта автоматически (с печатью) и приходит файлом в чат.\n`;

        const inlineKeyboard = [];
        if (projectDocs.length === 0) {
            text += `\n📭 Документов нет. Создай первый — счёт/акт соберутся из «📝 Позиций».`;
        }
        projectDocs.slice(0, 20).forEach((d, idx) => {
            const icon = DOC_TYPE_ICONS[d['Тип документа']] || '📄';
            const statusIcon = DOC_STATUS_ICONS[d['Статус']] || '';
            const noStamp = d['С печатью'] ? '' : ' (без печати)';
            const pdfReady = d['PDF сгенерирован'] ? ' 📎' : '';
            const label = `${idx + 1}. ${icon} ${cleanButtonText(d['Тип документа'] || 'Документ', 26)} №${docNumberFor(d)}${noStamp} ${statusIcon}${pdfReady}`.trim();
            inlineKeyboard.push([{ text: label, callback_data: `docs_card_${d.Id}_${projectId}` }]);
        });
        if (projectDocs.length > 20) text += `\n_…показаны последние 20 документов (полный список — в NocoDB)_`;

        inlineKeyboard.push([{ text: '➕ Новый документ', callback_data: `docs_new_${projectId}` }]);
        inlineKeyboard.push([{ text: '⬅️ В карточку проекта', callback_data: `pcard_${projectId}` }]);

        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
        if (messageId) await editMessageIgnoreSame(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (err) {
        console.error('Ошибка списка документов:', err.message);
        bot.sendMessage(chatId, `❌ Не удалось загрузить документы: ${err.message}`).catch(() => {});
    }
}


// Карточка документа (действия: PDF в чат; отправка наружу — по флагу, v4.42.3)
async function sendDocCard(chatId, messageId, docId, projectId, canSend = false) {
    try {
        const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.DOCUMENTS}/${docId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
        const d = res.data;
        const icon = DOC_TYPE_ICONS[d['Тип документа']] || '📄';
        const statusIcon = DOC_STATUS_ICONS[d['Статус']] || '';
        const date = d['Дата документа'] ? String(d['Дата документа']).slice(0, 10) : '—';

        let text = `${icon} *${escapeMarkdown(d['Тип документа'] || 'Документ')} №${docNumberFor(d)}*\n`;
        text += `📅 Дата документа: ${date}\n`;
        text += `🏷 Статус: ${statusIcon} ${d['Статус'] || 'Черновик'}\n`;
        text += d['С печатью'] ? '🖨 С печатью (электронный документ)\n' : '🖨 Без печати\n';
        text += d['PDF сгенерирован'] ? '📎 PDF сформирован\n' : '📎 PDF ещё не формировался\n';
        if (d['Примечания']) text += `\n📌 ${escapeMarkdown(cleanButtonText(String(d['Примечания']), 200))}`;

        const inlineKeyboard = [
            [{ text: d['PDF сгенерирован'] ? '📎 Получить PDF' : '🖨 Сформировать PDF', callback_data: `docs_pdf_${docId}_${projectId}` }]
        ];
        // v4.42.3: «выстрел наружу» — только с флагом canSendDocuments (guard центрально).
        // v4.42.5: уже отправленный документ повторно «наружу» не шлём (защита от дублей) —
        // кнопки email/ручной передачи скрываются, остаётся только заметка об отправке.
        const alreadySent = d['Статус'] === 'Отправлен';
        if (canSend && alreadySent) {
            const sentDate = d['Дата отправки'] ? ` ${String(d['Дата отправки']).slice(0, 10)}` : '';
            text += `\n\n✅ Документ уже отправлен${sentDate}. Клиенту он пришёл — повторную рассылку не делаем.`;
        } else if (canSend) {
            const isNakladnaya = d['Тип документа'] === 'Накладная' || d['Тип документа'] === 'ТН';
            if (!isNakladnaya) {
                // Счёт/Акт можно отправить по email: сначала покажем предпросмотр письма (v4.42.5)
                inlineKeyboard.push([{ text: '📧 Отправить по email', callback_data: `docs_send_${docId}_${projectId}` }]);
            } else {
                // Накладная — бумажный трек: печать в офисе и подписи, email нет
                text += `\n\n🖨 Накладная оформляется на бумаге — сформируй PDF, распечатай и подпиши в офисе.`;
            }
            inlineKeyboard.push([{ text: '📤 Отправил вручную (мессенджер/на руки)', callback_data: `docs_manual_${docId}_${projectId}` }]);
        }
        inlineKeyboard.push([{ text: '⬅️ К документам', callback_data: `docs_list_${projectId}` }]);
        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
        if (messageId) await editMessageIgnoreSame(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (err) {
        console.error('Ошибка карточки документа:', err.message);
        bot.sendMessage(chatId, `❌ Не удалось загрузить документ: ${err.message}`).catch(() => {});
    }
}

// Подтверждение создания документа (из sess.docDraft): печать + примечание + «Создать»
function sendDocCreateConfirm(chatId, projectId) {
    const sess = getSession(sessions, chatId);
    const d = sess.docDraft;
    const icon = DOC_TYPE_ICONS[d.type] || '📄';
    const fmtNote = d.note ? `📌 ${escapeMarkdown(cleanButtonText(d.note, 150))}` : '_без примечания_';
    let text = `📄 *Новый документ*\n\n`;
    text += `${icon} ${escapeMarkdown(d.type || '—')}\n`;
    text += `🖨 Печать: ${d.stamp ? '✅ в PDF (электронный документ)' : '❌ без печати (черновик/бумага)'}\n`;
    text += `${fmtNote}\n\n`;
    text += `Проект: #${projectId}`;

    const kb = [];
    kb.push([{ text: '✅ Создать', callback_data: `docs_create_${projectId}` }]);
    kb.push([
        { text: d.stamp ? '🖨 Без печати' : '🖨 С печатью', callback_data: `docs_stamp_${projectId}` },
        { text: d.note ? '✏️ Примечание' : '➕ Примечание', callback_data: `docs_note_${projectId}` }
    ]);
    kb.push([{ text: '❌ Отмена', callback_data: 'docs_cancel' }]);
    return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
}

// Генерация PDF через внутренний мотор (localhost:3000) и отправка файлом в чат
async function generateDocPdfAndSend(chatId, docId) {
    const statusMsg = await bot.sendMessage(chatId, '⏳ Формирую PDF…');
    try {
        const secret = process.env.WEBHOOK_SECRET || '';
        const genRes = await axios.post(`http://localhost:3000/generate-pdf?docId=${docId}&secret=${secret}`, null, { timeout: 150000 });
        const data = genRes.data;
        if (!data || !data.success || !data.url) throw new Error((data && data.error) || 'PDF не сформировался');
        const pathPart = String(data.url).replace(/^https?:\/\/[^/]+/, ''); // → /pdfs/имя.pdf
        const fileRes = await axios.get(`http://localhost:3000${pathPart}?secret=${secret}`, { responseType: 'arraybuffer', timeout: 40000 });
        const fileName = decodeURIComponent(pathPart.split('/').pop() || 'document.pdf');
        await bot.sendDocument(chatId, Buffer.from(fileRes.data), { filename: fileName });
        try { await bot.deleteMessage(chatId, statusMsg.message_id); } catch (e) { /* ignore */ }
        noco.invalidateTable(config.TABLES.DOCUMENTS);
    } catch (err) {
        console.error('Ошибка генерации PDF:', err.message);
        try { await bot.editMessageText(`❌ ${err.message}`, { chat_id: chatId, message_id: statusMsg.message_id }); } catch (e) { bot.sendMessage(chatId, `❌ ${err.message}`).catch(() => {}); }
    }
}

// Клавиатура выбора типа документа (v4.45.0: пары по 2 — было 5 рядов по одному)
function docTypeKeyboard(projectId) {
    return pairRow(DOC_TYPES.map(t => ({ text: `${DOC_TYPE_ICONS[t] || '📄'} ${t}`, callback_data: `docs_type_${t}_${projectId}` })));
}


// ================== ЗАДАЧИ ПРОЕКТА (v4.18.0) ==================
// Кнопка «📋 Задачи проекта» в карточке — список задач конкретного проекта.
async function sendProjectTasksList(chatId, messageId, projectId, role, telegramId, page = 0) {
    try {
        const rows = await fetchTasksForListCached();
        const projTasks = rows.filter(t => extractLinkId(t['Какой проект']) == projectId);
        const now = Date.now();

        // v4.38.0: активные сверху (по сроку), затем выполненные (свежезакрытые сверху).
        projTasks.sort(sorters.compareProjectTasks);

        // 🆕 v4.22.0: UI-пагинация (задачи проекта могут превысить лимит кнопок)
        const { pageItems, page: safePage, totalPages } = slicePage(projTasks, page, LIST_PAGE_SIZE.tasks);
        setListPage(telegramId, `ptasks:${projectId}`, safePage);

            let text = `📋 *Задачи проекта #${projectId}* (${projTasks.length})${totalPages > 1 ? ` · стр. ${safePage + 1}/${totalPages}` : ''}`;
    // 🆕 v4.36.0: список = кнопки-пункты; «✅ Закрыть» у «горящих» задач по правам
    if (pageItems.length === 0) text += '\n\n📭 Задач нет. Нажми «➕ Задача в проект».';
    else text += '\n\n👇 *Нажми на задачу* — карточка с действиями.\n';

    const inlineKeyboard = [];
    pageItems.forEach(t => inlineKeyboard.push(...taskListRows(t)));
    const nav = paginationRow(`ptl_${projectId}`, safePage, totalPages);
        if (nav) inlineKeyboard.push(nav);
        inlineKeyboard.push([{ text: '⬅️ Назад', callback_data: `pcard_${projectId}` }]);

        const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } };
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
}

// ================== ЗАДАЧА В ПРОЕКТ (v4.18.0) ==================
// Кнопка «➕ Задача в проект» — быстрый визард с предзаполненным projectId.
async function startProjectTask(chatId, telegramId, projectId) {
    const sess = getSession(sessions, chatId);
    const emp = getEmployee(telegramId);
    const role = emp ? emp.Роль : ROLES.EXECUTOR;
    if (role === ROLES.EXECUTOR) { bot.sendMessage(chatId, '⛔ У вас нет прав для создания задач.'); return; }
    if (role === ROLES.MANAGER) {
        const proj = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
        if (extractLinkId(proj['Менеджер']) !== emp?.Id) { bot.sendMessage(chatId, '⛔ Вы можете добавлять задачи только в свои проекты.'); return; }
    }
    sess.taskDraft = { title: '', deadline: null, projectId: projectId, editTaskId: null, commentTaskId: null, fileTaskId: null, fileProjectId: null, folderProjectId: null };
    sess.state = STATE.WAITING_TITLE;
    bot.sendMessage(chatId, `📝 *Что нужно сделать по проекту #${projectId}?*\n\nЗадача автоматически привяжется к проекту.`, { parse_mode: 'Markdown' });
}

// ================== ЗАМЕТКА К ПРОЕКТУ (v4.18.0) ==================
async function startProjectNote(chatId, projectId) {
    const sess = getSession(sessions, chatId);
    sess.projectDraft.noteProjectId = projectId;
    sess.state = STATE.WAITING_PROJECT_NOTE;
    bot.sendMessage(chatId, `✏️ *Напиши заметку по проекту #${projectId}:*\n\nТекст добавится в «Подробности» с автором и датой.`, { parse_mode: 'Markdown' });
}

// ================== СРОК ПРОЕКТА (v4.18.0) ==================
async function startProjectDeadline(chatId, projectId) {
    const sess = getSession(sessions, chatId);
    sess.projectDraft.deadlineProjectId = projectId;
    sess.state = STATE.WAITING_PROJECT_DEADLINE;
    bot.sendMessage(chatId, `📅 *Срок проекта #${projectId}*\n\nНапиши дату, например: *17.09*, *завтра*, *05.09.2026*. Или «без срока».`, { parse_mode: 'Markdown' });
}


// ================== ПЕРЕДАЧА ПРОЕКТА (v4.18.0) ==================
// Только Руководитель. Смена «Менеджера» через webhook-прокси: в NocoDB CE
// нет API для обновления связей (PATCH игнорируется), поэтому webhook правит
// junction-таблицу nc_m2m_Проекты_Сотрудники напрямую (см. TECH_REF 10.15).
async function sendTransferMenu(chatId, messageId, projectId, role) {
    if (role !== ROLES.ADMIN) { bot.sendMessage(chatId, '⛔ Передавать проекты может только Руководитель'); return; }
    const proj = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
    const currentMgrId = extractLinkId(proj['Менеджер']);
    const currentName = proj['Менеджер']?.['ФИО'] || 'не назначен';
    const candidates = Array.from(employeesCache.values())
        .filter(e => (e.Роль === ROLES.MANAGER || e.Роль === ROLES.ADMIN))
        .filter(e => e.Id !== currentMgrId);
    if (candidates.length === 0) { bot.sendMessage(chatId, '📭 Нет других менеджеров для передачи.'); return; }

    const kb = candidates.map(e => [{ text: `👤 ${e.Имя}`, callback_data: `ptransfer_set_${projectId}_${e.Id}` }]);
    kb.push([{ text: '⬅️ Назад', callback_data: `pcard_${projectId}` }]);
    const text = `👥 *Передача проекта #${projectId}*\n\nТекущий менеджер: *${escapeMarkdown(currentName)}*\n⚠️ Вместе с проектом передаётся и клиент: он станет виден новому менеджеру.\n\nКому передать?`;
    try {
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
        else await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
    } catch (e) {
        console.error('❌ Отправка меню передачи:', e.message);
        await bot.sendMessage(chatId, plainTextFromMarkdown(text), { reply_markup: { inline_keyboard: kb } });
    }
}

async function transferProject(projectId, newEmpId) {
    const res = await axios.post(`${WEBHOOK_URL}/transfer-project`, {
        projectId, newManagerId: newEmpId, secret: process.env.WEBHOOK_SECRET || ''
    }, { timeout: 10000, validateStatus: () => true });
    return res.data;
}

// ================== АРХИВ ПРОЕКТОВ (v4.18.0) ==================
// Проекты со статусом «Успех»/«Мимо» (формула «Активно» = «Неактивно»).
async function sendArchivedProjects(chatId, telegramId, role, messageId, page = 0) {
    try {
        const rows = await noco.fetchAllRowsCached(config.TABLES.PROJECTS, { ttlMs: 15000 });
        let projects;
        if (role === ROLES.ADMIN) {
            projects = rows.filter(p => PROJECT_INACTIVE_STATUSES.has(p['Статус']));
        } else if (role === ROLES.MANAGER) {
            const emp = getEmployee(telegramId);
            projects = rows.filter(p => PROJECT_INACTIVE_STATUSES.has(p['Статус']) && p['Менеджер']?.Id === emp?.Id);
        } else {
            bot.sendMessage(chatId, '⛔ У вас нет доступа к архиву проектов.');
            return;
        }

        // v4.38.0: лента — недавно закрытые сверху (по UpdatedAt desc).
        projects.sort(sorters.compareByUpdatedAtDesc);

        // 🆕 v4.22.0: UI-пагинация
        const { pageItems, page: safePage, totalPages } = slicePage(projects, page, LIST_PAGE_SIZE.simple);
        setListPage(telegramId, 'al', safePage);

        let text = `🗄 *Архив проектов (${projects.length})*${totalPages > 1 ? ` · стр. ${safePage + 1}/${totalPages}` : ''}`;
        // 🆕 v4.35.0: список = кнопки-пункты. Полотно текста убрано: inline-кнопки в Telegram
        // идут ТОЛЬКО снизу сообщения, и «👁 #id» под простынёй из 10 описаний заставлял
        // сверять текст и кнопки глазами. Теперь сам пункт — широкая кнопка (тап = карточка).
        if (pageItems.length === 0) text += '\n\n📭 Пусто. Проекты попадают сюда при статусе «Успех» или «Мимо».';
        else text += '\n\n👇 *Нажми на проект* — откроется карточка.\n';

        const inlineKeyboard = pageItems.map(p => [{
            text: `${p['Статус'] === 'Успех' ? '✅' : '❌'} #${p.Id} ${cleanButtonText(p['Что делаем?'] || 'Без названия')} — ${cleanButtonText(p['Статус'] || '—', 20)}`,
            callback_data: `arch_card_${p.Id}`
        }]);
        const nav = paginationRow('al', safePage, totalPages);
        if (nav) inlineKeyboard.push(nav);

        const options = { parse_mode: 'Markdown' };
        if (inlineKeyboard.length > 0) options.reply_markup = { inline_keyboard: inlineKeyboard };
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
}


bot.onText(/\/start/, async (msg) => {
    if (!msg.from || !isAllowed(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Доступ запрещён');
    const employee = getEmployee(msg.from.id);
    const greetingName = employee ? employee.Обращение : 'Коллега';
    resetState(msg.chat.id);
    const chatId = msg.chat.id;
    const role = employee ? employee.Роль : ROLES.EXECUTOR;

    try {
        const taskRows = await fetchAllRows(config.TABLES.TASKS);
        let activeTasks = taskRows.filter(t => !t['Готово']);

        // Фильтруем задачи по роли для сводки
        activeTasks = roles.filterTasksByRole(activeTasks, getEmployee(msg.from.id));

        let nearestTaskText = "Нет активных задач 🎉";
        if (activeTasks.length > 0) {
            const sortedTasks = activeTasks.sort((a, b) => {
                const dateA = a['Когда делаем'] ? new Date(a['Когда делаем']).getTime() : Infinity;
                const dateB = b['Когда делаем'] ? new Date(b['Когда делаем']).getTime() : Infinity;
                return dateA - dateB;
            });
            const nearest = sortedTasks[0];
            nearestTaskText = `🔹 *#${nearest.Id}* ${nearest['Что делаем?']} — ${nearest['Когда делаем'] ? formatMinskDate(nearest['Когда делаем']) : 'Без срока'}`;
        }

        let message = `👋 Привет, *${greetingName}*! Рад видеть тебя в системе.\n\n`;
        message += `📊 *ТВОЯ СВОДКА:*\n`;
        message += `📋 Активных задач: *${activeTasks.length}*\n`;

        // Руководитель и Менеджер видят проекты и контакты
        if (role === ROLES.ADMIN || role === ROLES.MANAGER) {
            const [allProjects, allContacts] = await Promise.all([
                fetchAllRows(config.TABLES.PROJECTS),
                fetchAllRows(config.TABLES.CONTACTS)
            ]);
            const activeProjects = allProjects.filter(p => p['Активно'] === 'Активно');
            const contactsCount = allContacts.length;

            if (role === ROLES.MANAGER) {
                // Менеджер видит только свои проекты
                const emp = getEmployee(msg.from.id);
                const myProjects = activeProjects.filter(p => p['Менеджер']?.Id === emp?.Id);
                message += `🚀 Моих проектов: *${myProjects.length}*\n`;
                // v4.26.0: Менеджер видит ВСЮ клиентскую базу — счётчик как у Руководителя.
                message += `👤 Контактов в базе: *${contactsCount}*\n\n`;
            } else {
                message += `🚀 Активных проектов: *${activeProjects.length}*\n`;
                message += `👤 Контактов в базе: *${contactsCount}*\n\n`;
            }
        } else {
            message += `\n`;
        }

        message += `⏰ *Ближайший дедлайн:*\n${nearestTaskText}\n\n`;
        message += `💡 *Лайфхак:* Просто перешли мне сообщение от клиента!`;

        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        sendMainMenu(chatId, null, role);
    } catch (err) {
        console.error('Ошибка сводки:', err.message);
        await bot.sendMessage(chatId, `❌ Ошибка подключения к базе: ${err.message}`);
    }
});

bot.onText(/\/cancel/, (msg) => { if (!msg.from || !isAllowed(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Доступ запрещён');  resetState(msg.chat.id); bot.sendMessage(msg.chat.id, '❌ Отменено.'); });
bot.onText(/\/tasks/, async (msg) => {
    if (!msg.from || !isAllowed(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Доступ запрещён');
    const emp = getEmployee(msg.from.id);
    resetState(msg.chat.id); await sendTaskList(msg.chat.id, null, msg.from.id, emp ? emp.Роль : ROLES.EXECUTOR);
});

// ================== НОВОЕ: КОМАНДА /today ==================
bot.onText(/\/today/, async (msg) => {
    if (!msg.from || !isAllowed(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Доступ запрещён');
    resetState(msg.chat.id);
    const emp = getEmployee(msg.from.id);
    await sendTodayTasks(msg.chat.id, msg.from.id, emp ? emp.Роль : ROLES.EXECUTOR);
});

// ================== НОВОЕ: КОМАНДА /history ==================
bot.onText(/\/history/, async (msg) => {
    if (!msg.from || !isAllowed(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Доступ запрещён');
    resetState(msg.chat.id);
    const emp = getEmployee(msg.from.id);
    await sendTaskHistory(msg.chat.id, msg.from.id, emp ? emp.Роль : ROLES.EXECUTOR);
});

bot.onText(/^\/add_contact$/, (msg) => { if (!msg.from || !isAllowed(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Доступ запрещён');  resetState(msg.chat.id); startContactWizard(msg.chat.id); });
bot.onText(/^\/add_contact (.+)/, async (msg, match) => {
    resetState(msg.chat.id);
    const input = match[1];
    const phoneMatch = input.match(/(\+?\d[\d\s\-\(\)]{7,}\d)/);
    const usernameMatch = input.match(/@([a-zA-Z0-9_]{3,})/);
    let name = input, phone = '', username = '', messenger = 'Telegram';
    if (phoneMatch) { phone = phoneMatch[1].trim(); name = input.replace(phone, '').trim(); }
    if (usernameMatch) { username = usernameMatch[1]; name = name.replace(`@${username}`, '').trim(); }
    if (!name) return bot.sendMessage(msg.chat.id, '❌ Пример: `/add_contact Иван +375291234567 @vasiok`', { parse_mode: 'Markdown' });
    
    const duplicate = await findDuplicateContact(null, phone, username);
    if (duplicate) {
        return bot.sendMessage(msg.chat.id, `⚠️ Контакт уже есть: *${escapeMarkdown(duplicate['Имя'])}* (${escapeMarkdown(duplicate['Телефон'] || 'нет тел.')}).\nID: ${duplicate.Id}`, { parse_mode: 'Markdown' });
    }

    try {
        const payload = { 'Имя': name, 'Мессенджер': messenger };
        if (phone) payload['Телефон'] = phone;
        if (username) payload['Ссылка'] = `https://t.me/${username}`;
        const res = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
        bot.sendMessage(msg.chat.id, `✅ *Контакт создан!*\n👤 ${escapeMarkdown(name)}\n📱 ${escapeMarkdown(phone || 'нет')}\n🔗 ${username ? escapeMarkdown(`https://t.me/${username}`) : 'нет'}\n🆔 ID: ${res.data.Id}`, { parse_mode: 'Markdown' });
        showProjectSelectionForContact(msg.chat.id, res.data.Id);
    } catch (err) { bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`); }
});

bot.onText(/^\/project$/, (msg) => { if (!msg.from || !isAllowed(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Доступ запрещён');  resetState(msg.chat.id); startProjectWizard(msg.chat.id, msg.from.id); });
bot.onText(/^\/project (.+)/, async (msg, match) => {
    resetState(msg.chat.id);
    const emp = getEmployee(msg.from.id);
    try {
        const projectData = { 'Что делаем?': match[1], 'Статус': 'Обсуждение' };
        if (emp) projectData['Менеджер'] = emp.Id;
        const res = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}`, projectData, { headers: { 'xc-token': config.NOCO_TOKEN } });
        bot.sendMessage(msg.chat.id, `🚀 *Проект создан!*\n📝 ${match[1]}\n🆔 ID: ${res.data.Id}`, { parse_mode: 'Markdown' });
    } catch (err) { bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`); }
});

bot.onText(/\/contacts/, async (msg) => {
    if (!msg.from || !isAllowed(msg.from.id)) return bot.sendMessage(msg.chat.id, '⛔ Доступ запрещён');
    resetState(msg.chat.id);
    const emp = getEmployee(msg.from.id);
    await sendContactsList(msg.chat.id, msg.from.id, emp ? emp.Роль : ROLES.EXECUTOR);
});

// 🆕 v4.21.5: Единый набор контактов для forward/hidden-флоу — правила = правилам списка «📇 Контакты»:
// Руководитель — все, Менеджер — контакты всех СВОИХ проектов (включая закрытые).
// Раньше forward показывал только АКТИВНЫЕ проекты → контакт из закрытого проекта нельзя было
// выбрать (несимметрия, Проблема 85), а «Показать все контакты» отдавал менеджеру вообще ВСЕ контакты.
// ⚠️ v4.29.1: функция была ошибочно объявлена ВНУТРИ bot.onText(/\/contacts/) — из других
// обработчиков (forward/hidden-флоу) она была не видна (ReferenceError «getForwardContacts is not
// defined» → молчаливый catch). Вынесена на уровень модуля.
async function getForwardContacts(emp) {
    const allContacts = await noco.fetchAllRowsCached(config.TABLES.CONTACTS, { extraParams: 'sort=-Id', ttlMs: 15000 });
    if (!emp || emp.Роль === ROLES.ADMIN) return allContacts;
    if (emp.Роль === ROLES.MANAGER) {
        // v4.26.0: Менеджер видит ВСЮ клиентскую базу (общий справочник) — как в списке «Контакты».
        return allContacts;
    }
    return []; // Исполнитель — контакты недоступны
}

async function handleForwardedMessage(msg) {
    const user = msg.forward_from;
    const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
    const username = user.username ? `@${user.username}` : '';
    const tgId = user.id;
    const chatId = msg.chat.id;
    const sess = getSession(sessions, chatId);
    const emp = getEmployee(msg.from.id);
    const role = emp ? emp.Роль : ROLES.EXECUTOR;
    const contactName = name;
    const messageText = msg.text || msg.caption || '';
    const shortText = messageText.length > 200 ? messageText.substring(0, 200) + '...' : messageText;

    // Сохраняем данные пересылки
    sess.pendingContactAction = {
        active: true,
        contactId: null,
        waitingPhone: false,
        waitingProjectForMessage: false,
        isNew: false,
        forwardedData: { contactName, messageText: shortText, projectId: null, tgId, username: user.username },
        tgId: tgId
    };

    const header = `📨 *Переслано сообщение*\n\n📄 *Текст:* ${escapeMarkdown(shortText) || '(без текста)'}\n\n*Что делаем?*`;

    if (role === ROLES.EXECUTOR) {
        // Исполнитель: только добавить к своей задаче
        try {
            const rows = await fetchAllRows(config.TABLES.TASKS);
            const myTasks = rows.filter(t => !t['Готово'] && t['Исполнитель']?.Id === emp.Id);

            // v4.38.0: тот же порядок, что в списке задач (просроченные/ближайшие сверху).
            myTasks.sort(sorters.compareTasksActive);

            if (myTasks.length === 0) {
                return bot.sendMessage(chatId, '📭 У вас нет активных задач для добавления.');
            }

            const inlineKeyboard = myTasks.map(t =>
                [{ text: `#${t.Id} ${t['Что делаем?']}`, callback_data: `fwd_append_${t.Id}` }]
            );
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'fwd_cancel' }]);

            await bot.sendMessage(chatId, header, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
    } else {
        // Руководитель / Менеджер: полный набор
        let text;
        const existingContact = await findDuplicateContact(tgId, null, user.username);
        sess.pendingContactAction.contactId = existingContact ? existingContact.Id : null;

        if (existingContact) {
            text = `⚠️ *Контакт уже есть в базе!*\n\n👤 *${existingContact['Имя']}*\n\n📄 *Текст:* ${escapeMarkdown(shortText) || '(без текста)'}\n\n*Что делаем?*`;
        } else {
            text = `🆕 *Новый контакт!*\n\n👤 *${escapeMarkdown(contactName)}*`;
            if (user.username) text += `\n🔗 ${escapeMarkdown(user.username)}`;
            text += `\n\n📄 *Текст:* ${escapeMarkdown(shortText) || '(без текста)'}\n\n*Что делаем?*`;
        }

        const inlineKeyboard = [
            [{ text: '➕ Создать задачу', callback_data: 'fwd_create_task' }],
            [{ text: '📎 Добавить к задаче', callback_data: 'fwd_append_task' }],
            [{ text: '👤 Создать контакт', callback_data: 'forward_create_new' }],
            [{ text: '📝 Добавить к контакту', callback_data: 'forward_add_to_contact' }],
            [{ text: '📂 Добавить к проекту', callback_data: 'forward_add_to_project' }]
        ];

        await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
    }
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const sess = getSession(sessions, chatId);
    // Пересылки и скрытый профиль — тоже инструмент СОТРУДНИКОВ: чужих
    // (не из кэша) молча игнорируем, чтобы не плодили контакты/задачи.
    if (!msg.from || !isAllowed(msg.from.id)) return;
    // Пересланные сообщения обрабатываем всегда
    if (msg.forward_date || msg.forward_from || msg.forward_from_chat) {
        // Продолжаем обработку ниже
    } else if (sess.state !== STATE.IDLE) {
        // Обычные текстовые сообщения игнорируем в других состояниях
        return;
    }
    
    if (!msg.text && !msg.forward_date) return;
    
    if (msg.forward_date && !msg.forward_from && !msg.forward_from_chat) {
        const messageText = msg.text || msg.caption || '';
        const shortText = messageText.length > 200 ? messageText.substring(0, 200) + '...' : messageText;

        sess.pendingContactAction = {
            active: true, contactId: null, waitingPhone: false,
            waitingProjectForMessage: false,
            forwardedData: { messageText: shortText, projectId: null },
            isHiddenProfile: true,
            hiddenProfileMessageText: shortText
        };
        
        // Скрытый профиль = работа с клиентской базой (контакт/проект): это зона
        // Руководителя и Менеджера. Исполнителю кнопки не показываем (раньше он
        // мог создать контакта в обход canSeeContacts).
        const empHidden = getEmployee(msg.from.id);
        if (empHidden?.Роль === ROLES.EXECUTOR) {
            bot.sendMessage(msg.chat.id, '⛔ Обработка скрытых профилей доступна Руководителю и Менеджеру. Если нужно сохранить текст — перешли сообщение ещё раз обычным способом: будет выбор для твоей задачи.');
            return;
        }
        
        // Сразу показываем меню действий
        const inlineKeyboard = [
            [{ text: '➕ Создать новый контакт', callback_data: 'hidden_create_new' }],
            [{ text: '📝 Добавить к существующему контакту', callback_data: 'hidden_add_to_contact' }],
            [{ text: '📂 Добавить к проекту', callback_data: 'hidden_add_to_project' }]
        ];
        
        bot.sendMessage(msg.chat.id, `🕵️ *Профиль отправителя скрыт.*\n\nTelegram не показывает мне имя и ID этого человека из-за его настроек приватности.\n\n📄 *Текст пересланного сообщения:*\n_${escapeMarkdown(shortText) || '(без текста)'}_\n\n*Что делаем?*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        return;
    }

    if (msg.forward_from_chat) {
        try {
            const res = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}`, { 'Имя': `${msg.forward_from_chat.title || 'Канал'}`, 'Мессенджер': 'Telegram' }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(msg.chat.id, `✅ *Контакт канала создан!*`, { parse_mode: 'Markdown' });
            showProjectSelectionForContact(msg.chat.id, res.data.Id);
        } catch (err) { bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`); }
        return;
    }
    if (msg.forward_from) { 
        console.log(`📨 Получено пересланное сообщение от ${msg.forward_from.first_name}`);
        await handleForwardedMessage(msg); 
    }
});


// ================== DOMAIN-HANDLERS: файлы/пересылки (Фаза 3) ==================
// Callback-ветки «скрытого профиля/файлов/комментариев/пересылок» переехали
// в bot/handlers/files.js (фабрика, получает контекст). Диспетчер ниже — один.
const { handleCallbackBlockB } = require('./handlers/files')({
    bot, config, axios, noco, sessions, employeesCache,
    STATE, ROLES, roles, WEBHOOK_URL, sorters,
    getSession, getEmployee, resetState, fetchAllRows, setListPage,
    appendTaskDetails, extractWebhookError, getForwardContacts,
    // v4.45.0: рендеры селекторов (пагинация) для навигации страниц блока B
    showMyTasksForComment, showMyTasksForFile,
    showProjectsForFile, showProjectsForFolder, showProjectsForFilesList,
    escapeMarkdown
});

// ============================================================================
// ЕДИНЫЙ ДИСПЕТЧЕР CALLBACK_QUERY (правило «ровно один слушатель на событие»)
// ============================================================================
// Раньше два обработчика bot.on('callback_query') вызывались на КАЖДЫЙ клик и
// для «чужого» префикса пробегали вхолостую (EventEmitter). Теперь по реестру
// bot/routes.js выполняется РОВНО один блок (A или B). Неизвестный/битый
// колбэк (кнопка от старой версии) молча гасится через answerCallbackQuery,
// чтобы у пользователя не висели «часики» загрузки.
bot.on('callback_query', async (callbackQuery) => {
    // Центральная входная авторизация: inline-кнопки может нажимать ТОЛЬКО
    // сотрудник из кэша. Раньше ветки делали `role = emp ? emp.Роль : ROLES.EXECUTOR`
    // — незнакомец (не в кэше сотрудников) молча получал права Исполнителя.
    // Теперь отсекается здесь, в единственной точке входа (fail-closed).
    const from = callbackQuery.from;
    if (!from || !isAllowed(from.id)) {
        try { await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Доступ запрещён' }); } catch (e) { /* ignore */ }
        return;
    }
    // Центральный guard по ролям. В ветках этих проверок исторически не было —
    // см. bot/routes.js: ADMIN_ONLY_PREFIXES (заявки/передача) и MANAGER_ONLY_PREFIXES
    // (задачи/папки/файлы проекта — Исполнитель не видит проекты).
    const data = callbackQuery.data || '';
    const emp = getEmployee(from.id);
    if (isAdminOnlyCallback(data)) {
        if (emp?.Роль !== ROLES.ADMIN) {
            try { await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только для Руководителя' }); } catch (e) { /* ignore */ }
            return;
        }
    }
    if (isManagerOnlyCallback(data)) {
        if (emp?.Роль === ROLES.EXECUTOR) {
            try { await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к проектам' }); } catch (e) { /* ignore */ }
            return;
        }
    }
    // v4.42.3 (модель «внутри/наружу»): отправка документов «наружу» (email/вручную)
    // — только с флагом «Отправка документов» (roles.canSendDocuments).
    if (isDocsSendOnlyCallback(data) && !roles.canSendDocuments(emp)) {
        try { await bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Нужно право «Отправка документов» (галочка у сотрудника)' }); } catch (e) { /* ignore */ }
        return;
    }
    let block = null;
    try {
        block = matchCallbackBlock(data);
    } catch (err) {
        console.error('Callback router error:', err.message);
        return;
    }
    try {
        if (block === 'A') {
            await handleCallbackBlockA(callbackQuery);
        } else if (block === 'B') {
            await handleCallbackBlockB(callbackQuery);
        } else {
            await bot.answerCallbackQuery(callbackQuery.id).catch(() => {});
        }
    } catch (err) {
        // Страховка от необработанного исключения: блоки ловят своё сами,
        // но если что-то упущено — логируем и не роняем процесс.
        console.error('Callback handler error:', err.message);
        try { await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка!' }); } catch (e) { /* ignore */ }
    }
});

// ================== HEALTH CHECK (каждые 5 минут) ==================
const healthLog = [];
const MAX_HEALTH_LOG = 100;
// v4.46.0 (Проблема 117): состояние проверки поллинга между тиками — для
// двухтактного решения (один тик подозрение, два — застревание, см. shared/watchdog.js).
let pollWatchState = { prevCheckAt: Date.now(), strike: 0 };

cron.schedule('*/5 * * * *', async () => {
    const ts = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });
    const issues = [];

    // 1. Проверка кэша сотрудников
    if (employeesCache.size === 0) {
        issues.push('Кэш сотрудников пуст — бот не может авторизовать пользователей');
    }

    // 2. Проверка NocoDB
    try {
        await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.EMPLOYEES}?limit=1`, {
            headers: { 'xc-token': config.NOCO_TOKEN }, timeout: 5000
        });
    } catch (e) {
        issues.push(`NocoDB не отвечает: ${e.message}`);
    }

    // 3. Проверка PDF-генератора
    try {
        await axios.get('http://localhost:3000/health', { timeout: 5000 });
    } catch (e) {
        issues.push(`PDF-генератор не отвечает: ${e.message}`);
    }

    // 4. Проверка Webhook
    try {
        await axios.get(`${WEBHOOK_URL}/health`, { timeout: 5000 });
    } catch (e) {
        issues.push(`Webhook не отвечает: ${e.message}`);
    }

    // 5. Проверка Telegram-поллинга (Проблема 117). Обычный /health (:3000) —
    // это server.js: он жив, даже когда поллинг «завис» и апдейты не доходят.
    // getWebhookInfo отдаёт pending_update_count — сколько апдейтов Telegram
    // держит в очереди, потому что бот за ними не приходит.
    const now = Date.now();
    let wedged = false;
    let pollPending = 0;
    try {
        // В node-telegram-bot-api@0.64 метод называется getWebHookInfo (WebHook),
        // хотя API Telegram — getWebhookInfo. Возвращает сам result-объект.
        const wi = await bot.getWebHookInfo();
        pollPending = (wi && wi.pending_update_count) || 0;
    } catch (e) {
        issues.push(`Telegram API не отвечает: ${e.message}`);
    }
    const verdict = pollWatchdog.evaluatePollHealth({
        pending: pollPending,
        processedSincePrev: lastIncomingUpdateAt != null && lastIncomingUpdateAt > pollWatchState.prevCheckAt,
        strike: pollWatchState.strike,
    });
    pollWatchState.strike = verdict.strike;
    if (verdict.wedged) {
        wedged = true;
        issues.push(`Telegram-поллинг завис: апдейты не доходят (pending=${pollPending}) — ${verdict.reason}`);
    }

    // Логируем
    const status = issues.length === 0 ? 'OK' : 'FAIL';
    healthLog.push({ ts, status, issues });
    if (healthLog.length > MAX_HEALTH_LOG) healthLog.shift();

    if (status === 'OK') {
        console.log(`🟡 Health check OK (${ts})`);
    } else {
        console.log(`🔴 Health check FAIL (${ts}): ${issues.join('; ')}`);
        // Уведомить Руководителя
        for (const [tgId, emp] of employeesCache.entries()) {
            if (emp.Роль === ROLES.ADMIN) {
                const msg = `🔴 *Проблема с CRM*\n\n${issues.map(i => '• ' + i).join('\n')}\n\n⏰ ${ts}`;
                bot.sendMessage(Number(tgId), msg, { parse_mode: 'Markdown' }).catch(() => {});
            }
        }
    }

    // Зависший поллинг лечится перезапуском процесса (docker restart поднимает
    // чистый поллинг; накопленные апдейты Telegram отдаст заново — дублей нет,
    // они ещё не обрабатывались). Алерт уже ушёл выше (issues непуст).
    if (wedged) {
        schedulePollRestart(`pending=${pollPending}, тик ${ts}`);
    }
    pollWatchState.prevCheckAt = now;
});

// ================== ЧИСТКА ЖУРНАЛОВ УВЕДОМЛЕНИЙ (v4.28.3) ==================
// notifiedTasks / notifiedDeadlines — «журналы отправленных уведомлений» (защита
// от дублей, Проблемы 81-82). Раньше они ТОЛЬКО росли (ключ добавлялся навсегда):
// за годы работы — тысячи записей в памяти, а после рестарта бота журналы
// «забывались» → риск повторных напоминаний.
// Чистим раз в сутки (вызов из утренней сводки): выкидываем ключи задач, которым
// напоминания больше не понадобятся НИКОГДА (закрыты, созданы давно, дедлайн
// протух). Удаляем только в безопасную сторону — «живые» ключи не трогаем.
function pruneNotificationSets(allTasks) {
    const now = Date.now();
    const HOUR = 60 * 60 * 1000;

    // Ключи напоминаний о дедлайнах (`<taskId>_<tgId>_1h|_due|_late2h`):
    // живы, пока задача не закрыта И дедлайн не «протух» больше чем на 48 часов.
    const aliveDeadline = new Set();
    // Ключи уведомлений о назначении (`<taskId>_<tgId>`): уведомление шлётся
    // только в первые 2 минуты жизни задачи — дольше 1 часа ключ бесполезен.
    const aliveNotify = new Set();

    for (const t of allTasks) {
        if (t['Готово']) continue; // закрытые — не нужны ни в одном журнале

        const created = t['CreatedAt'] ? new Date(t['CreatedAt']).getTime() : 0;
        if (now - created < HOUR) aliveNotify.add(String(t.Id));

        const deadline = t['Когда делаем'] ? new Date(t['Когда делаем']).getTime() : null;
        if (!deadline || deadline > now - 48 * HOUR) aliveDeadline.add(String(t.Id));
    }

    let removedDeadline = 0;
    for (const key of notifiedDeadlines) {
        if (!aliveDeadline.has(key.split('_')[0])) { notifiedDeadlines.delete(key); removedDeadline++; }
    }
    let removedNotify = 0;
    for (const key of notifiedTasks) {
        if (!aliveNotify.has(key.split('_')[0])) { notifiedTasks.delete(key); removedNotify++; }
    }

    if (removedDeadline > 0 || removedNotify > 0) {
        console.log(`🧹 Журналы уведомлений: deadlines ${notifiedDeadlines.size} (удалено ${removedDeadline}), tasks ${notifiedTasks.size} (удалено ${removedNotify})`);
    }
}

// ================== УТРЕННЯЯ РАССЫЛКА ==================
cron.schedule(config.CRON_TIME, async () => {
    console.log('⏰ Утренняя рассылка...');
    try {
        const rows = await fetchAllRows(config.TABLES.TASKS);
        pruneNotificationSets(rows); // v4.28.3: чистка журналов уведомлений раз в сутки
        const tasks = rows.filter(t => !t['Готово']);
        let message = `🌅 *Доброе утро!* (${new Date().toLocaleDateString('ru-RU', { timeZone: config.TZ })})\n\n`;

        // Health-сводка за последние 24ч
        const recentHealth = healthLog.filter(h => {
            const hTime = new Date(h.ts.split('.').reverse().join('-') + 'T' + h.ts.split('.')[1]?.split(',')[0] || '').getTime();
            return (Date.now() - hTime) < 24 * 60 * 60 * 1000;
        });
        const failCount = recentHealth.filter(h => h.status === 'FAIL').length;
        if (failCount > 0) {
            message += `⚠️ *Health: ${failCount} проблем за 24ч*\n`;
            const lastFail = recentHealth.filter(h => h.status === 'FAIL').pop();
            if (lastFail) message += `   Последняя: ${lastFail.issues.join('; ')} (${lastFail.ts})\n`;
        } else {
            message += `✅ *Health:* стабильно работает\n`;
        }
        message += `\n`;
        if (tasks.length === 0) message += '✅ Нет активных задач.\n\n';
        else {
            message += `📌 *Активных: ${tasks.length}*\n\n`;
            tasks.forEach(t => {
                const projectRef = t['Какой проект'] ? ` 📁${escapeMarkdown(t['Какой проект']['Что делаем?'])}` : '';
                message += `🔹 *#${t.Id}* ${escapeMarkdown(t['Что делаем?'])}${projectRef}\n   📅 ${t['Когда делаем'] ? formatMinskDate(t['Когда делаем']) : 'Без срока'}\n\n`;
            });
        }
        

        // 🆕 v4.18.0: Проекты по срокам (просроченные + ближайшие 3 дня)
        try {
            const projRows = await fetchAllRows(config.TABLES.PROJECTS);
            const nowMs = Date.now();
            const urgent = projRows.filter(p => {
                if (!p['Срок проекта'] || PROJECT_INACTIVE_STATUSES.has(p['Статус'])) return false;
                const d = new Date(String(p['Срок проекта']).slice(0, 10) + 'T00:00:00').getTime();
                return (d - nowMs) < 4 * 86400000; // просрочен или ≤ 3 дней
            });
            if (urgent.length > 0) {
                message += `⏳ *Сроки проектов:*\n`;
                urgent.forEach(p => {
                    const d = new Date(String(p['Срок проекта']).slice(0, 10) + 'T00:00:00').getTime();
                    const days = Math.ceil((d - nowMs) / 86400000);
                    const sign = days < 0 ? `🔴 просрочен на ${-days} дн.` : (days === 0 ? '🟡 сегодня!' : (days === 1 ? '🟡 завтра' : `🟡 через ${days} дн.`));
                    message += `🔹 *${escapeMarkdown(p['Что делаем?'] || 'Без названия')}* — ${sign}\n`;
                });
                message += '\n';
            }
        } catch (err) { console.error('Ошибка сроков проектов в рассылке:', err.message); }

        // Проверяем бэкапы
        message += `💾 *Бэкапы:*\n`;
        
        // Локальный бэкап
        try {
            const fs = require('fs').promises;
            const path = require('path');
            const backupDir = '/mnt/data/backups';
            const files = await fs.readdir(backupDir);
            const backupFiles = files.filter(f => f.startsWith('nocodb_full_backup_') && f.endsWith('.tar.gz'));
            
            if (backupFiles.length > 0) {
                // Сортируем по имени (дата в имени)
                backupFiles.sort().reverse();
                const latest = backupFiles[0];
                const stats = await fs.stat(path.join(backupDir, latest));
                const sizeMB = (stats.size / 1024 / 1024).toFixed(1);
                const age = Math.floor((Date.now() - stats.mtimeMs) / (1000 * 60 * 60));
                message += `✅ Локальный: ${sizeMB}MB (${age}ч назад)\n`;
            } else {
                message += `❌ Локальный: не найден\n`;
            }
        } catch (err) {
            message += `❌ Локальный: ошибка (${err.message})\n`;
        }
        
        // Облачный бэкап — единая точка с кешем (v4.39.0): рассылка использует
        // ту же функцию, что и «💾 Бэкапы», и заодно греет её кеш для бота.
        try {
            // getCloudBackupLines() уже отфильтровал строки и отсортировал по имени файла.
            const lines = await getCloudBackupLines();

            if (lines.length > 0) {
                // После сортировки по имени последняя строка — самый свежий бэкап.
                const latest = lines[lines.length - 1];
                const parts = latest.trim().split(/\s+/);
                const sizeBytes = parseInt(parts[0]);
                const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);
                // Отрезаем наносекунды (в lsl время вида 13:30:01.119006703) — как в /backup
                const dateStr = parts[1] + ' ' + parts[2].substring(0, 5);
                message += `✅ Облако: ${sizeMB}MB (${dateStr})\n`;
            } else {
                message += `❌ Облако: не найден\n`;
            }
        } catch (err) {
            // v4.39.0: таймаут/сбой rclone не роняет рассылку и не сыплет сырое «Command failed»
            message += err.killed ? `❌ Облако: таймаут Google Drive\n` : `❌ Облако: ошибка (${err.message})\n`;
        }
        
        // v4.27.0 (Проблема 92): рассылка идёт Руководителю из кэша, а не config.MY_ID (NaN).
        const digestRecipient = getAdminTgId();
        if (!digestRecipient) throw new Error('нет Telegram ID Руководителя в кэше');
        bot.sendMessage(digestRecipient, message, { parse_mode: 'Markdown' });
    } catch (err) { console.error('❌ Ошибка рассылки:', err.message); }
});

// ================== НАПОМИНАНИЯ О ДЕДЛАЙНАХ (v2) ==================
// Каждые 5 минут: «за 1 час до дедлайна» и «пора выполнять» (дедлайн наступил).
// Адресат — исполнитель задачи (любая роль). Без исполнителя — владельцу (MY_ID).
// v4.21.4: при просрочке (_due) дополнительный алерт менеджеру проекта (без _1h).
// v4.27.0 (Проблема 92): тик 30 мин → 5 мин. Раньше «пора выполнять» приходило на 15–40 мин
// позже дедлайна: напоминание отправлял ПЕРВЫЙ тик после наступления, а тики шли раз в 30 мин.
// Плюс node-cron v3 срабатывает в точную секунду :00 — занятый event loop пропускал запуск без догона.
// Окно «за 1 час» сужено до (0.85–1.15), иначе при 5-мин тике уведомление могло уйти за 45 мин до срока.
// v4.27.1: эскалация при просрочке ≥ 2 часов — алерт Руководителю (окно 2–6 ч, см. ниже).
// Set notifiedDeadlines защищает от дублей (Проблемы 81, 82).
const notifiedDeadlines = new Set();
// v4.27.0 (Проблема 92): при изменении срока задачи сбрасываем её ключи — иначе после
// переноса дедлайна напоминание не переотправится (ключ `${taskId}_...` уже «выдан»).
function resetReminderState(taskId) {
    for (const key of notifiedDeadlines) {
        if (key.startsWith(`${taskId}_`)) notifiedDeadlines.delete(key);
    }
}
// Guard от пересечения запусков: при медленном NocoDB проверка может длиться дольше тика —
// не плодим параллельные полные выборки задач и не рискуем гонками отправки.
let reminderRunInProgress = false;

cron.schedule(config.REMINDER_CRON || '*/5 * * * *', async () => {
    if (reminderRunInProgress) return;
    reminderRunInProgress = true;
    try {
        const rows = await fetchAllRows(config.TABLES.TASKS);
        const activeTasks = rows.filter(t => !t['Готово'] && t['Когда делаем']);

        const now = new Date();

        for (const task of activeTasks) {
            const deadline = new Date(task['Когда делаем']);
            const diffMs = deadline - now;
            const diffHours = diffMs / (1000 * 60 * 60);

            // Получатель: исполнитель задачи (по NocoDB Id сотрудника → Telegram ID из кэша)
            const executorNocoId = task['Исполнитель']?.Id;
            let recipientTgId = null;
            if (executorNocoId) {
                recipientTgId = Array.from(employeesCache.entries()).find(([tid, e]) => e.Id === executorNocoId)?.[0] || null;
            }
            const tgId = recipientTgId || getAdminTgId();
            if (!tgId) continue; // пустой кэш / нет Руководителя — некому напоминать
            const taskKey = `${task.Id}_${tgId}`;

            // За 1 час до дедлайна (±9 минут)
            if (diffHours > 0.85 && diffHours < 1.15) {
                const key = `${taskKey}_1h`;
                if (!notifiedDeadlines.has(key)) {
                    notifiedDeadlines.add(key);
                    console.log(`⏰ [1h] задача #${task.Id} → tg ${tgId}`);
                    bot.sendMessage(Number(tgId),
                        `⏰ *Через 1 час дедлайн!*\n\n🔹 *#${task.Id}* ${escapeMarkdown(task['Что делаем?'])}\n📅 ${formatMinskDate(task['Когда делаем'])}`,
                        { parse_mode: 'Markdown' }).catch(() => {});
                }
            }

            // Пора выполнять: дедлайн наступил в пределах последнего часа
            if (diffMs <= 0 && diffMs > -60 * 60 * 1000) {
                const key = `${taskKey}_due`;
                if (!notifiedDeadlines.has(key)) {
                    notifiedDeadlines.add(key);
                    console.log(`⏰ [due] задача #${task.Id} → tg ${tgId}`);
                    bot.sendMessage(Number(tgId),
                        `⏰ *Пора выполнять задачу!*\n\n🔹 *#${task.Id}* ${escapeMarkdown(task['Что делаем?'])}\n📅 ${formatMinskDate(task['Когда делаем'])}`,
                        { parse_mode: 'Markdown' }).catch(() => {});
                }

                // 🆕 v4.21.4: алерт менеджеру проекта о просрочке (только _due, без _1h).
                // Условие mgrTgId !== tgId закрывает все дубли сразу: менеджер === исполнитель
                // или менеджер === владелец (fallback MY_ID) → уже получает, не шлём повторно.
                const managerNocoId = task['Какой проект']?.['Менеджер']?.Id;
                if (managerNocoId) {
                    const mgrTgId = Array.from(employeesCache.entries()).find(([tid, e]) => e.Id === managerNocoId)?.[0] || null;
                    if (mgrTgId && mgrTgId !== tgId) {
                        const mgrKey = `${task.Id}_${mgrTgId}_due`;
                        if (!notifiedDeadlines.has(mgrKey)) {
                            notifiedDeadlines.add(mgrKey);
                            console.log(`⏰ [due:mgr] задача #${task.Id} → tg ${mgrTgId}`);
                            bot.sendMessage(Number(mgrTgId),
                                `⏰ *Просрочена задача в твоём проекте!*\n\n🔹 *#${task.Id}* ${escapeMarkdown(task['Что делаем?'])}\n📁 ${escapeMarkdown(task['Какой проект']?.['Что делаем?'] || 'Проект')}\n📅 Дедлайн был: ${formatMinskDate(task['Когда делаем'])}\n${task['Исполнитель'] ? `👤 Исполнитель: ${escapeMarkdown(task['Исполнитель']['ФИО'] || 'Сотрудник')}` : ''}`,
                                { parse_mode: 'Markdown' }).catch(() => {});
                        }
                    }
                }
            }

            // v4.27.1: эскалация при длительной просрочке — алерт Руководителю, один раз за задачу.
            // Окно 2–6 часов просрочки: «горячая» просрочка требует реакции здесь и сейчас, а старые
            // хвосты (часы+) покрывает утренняя сводка — иначе после рестарта бота (Set пуст)
            // руководитель получил бы пачку алертов по всем давно просроченным задачам.
            if (diffMs <= -2 * 60 * 60 * 1000 && diffMs > -6 * 60 * 60 * 1000) {
                const adminTgId = getAdminTgId();
                if (adminTgId) {
                    const lateKey = `${task.Id}_${adminTgId}_late2h`;
                    if (!notifiedDeadlines.has(lateKey)) {
                        notifiedDeadlines.add(lateKey);
                        console.log(`⏰ [late2h] задача #${task.Id} → tg ${adminTgId}`);
                        bot.sendMessage(Number(adminTgId),
                            `⏰ *Задача просрочена уже 2+ часа!*\n\n🔹 *#${task.Id}* ${escapeMarkdown(task['Что делаем?'])}\n📅 Дедлайн был: ${formatMinskDate(task['Когда делаем'])}\n${task['Какой проект'] ? `📁 ${escapeMarkdown(task['Какой проект']?.['Что делаем?'] || 'Проект')}\n` : ''}${task['Исполнитель'] ? `👤 Исполнитель: ${escapeMarkdown(task['Исполнитель']['ФИО'] || 'Сотрудник')}` : '👤 Без исполнителя'}`,
                            { parse_mode: 'Markdown' }).catch(() => {});
                    }
                }
            }
        }
    } catch (err) {
        console.error('❌ Ошибка напоминаний:', err.message);
    } finally {
        reminderRunInProgress = false;
    }
});

// v4.29.0 (Заход 2): страховка от «залипших» сессий.
// Раньше залипшего в флоу выбивал ЛЮБОЙ другой сотрудник нажатием кнопки меню
// (resetState на каждое меню). Теперь чужой не трогает чужое — поэтому сессия,
// висящая в НЕ-idle дольше SESSION_STALE_MS, сбрасывается сама (юзер просто ушёл).
// Заодно удаляем пустые (idle) сессии случайных людей, к которым не обращались сутки.
const SESSION_STALE_MS = 2 * 60 * 60 * 1000;   // 2 часа в незавершённом флоу → сброс
const SESSION_IDLE_TTL_MS = 24 * 60 * 60 * 1000; // сутки без активности → удалить из памяти
setInterval(() => {
    const staleCleaned = cleanupStaleSessions(sessions, SESSION_STALE_MS);
    const idleRemoved = cleanupIdleSessions(sessions, SESSION_IDLE_TTL_MS);
    if (staleCleaned > 0 || idleRemoved > 0) {
        console.log(`🧹 Очистка сессий: залипших сброшено=${staleCleaned}, пустых удалено=${idleRemoved}, всего=${sessions.size}`);
    }
}, 60 * 60 * 1000); // раз в час

console.log('🤖 Бот запущен и готов к работе! 🚀');
