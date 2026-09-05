// ============================================================================
// bot/routes.js — РЕЕСТР callback_data (единый диспетчер callback_query)
// ============================================================================
// Исторически в bot.js было ДВА bot.on('callback_query'): «блок A» (задачи,
// проекты, контакты, юрлица, сроки, визарды, назначение исполнителей) и
// «блок B» (скрытый профиль, пересылки forward, комментарии, файлы/папки).
// Оба слушателя вызывались на КАЖДЫЙ клик (EventEmitter) и для «чужого»
// префикса пробегали вхолостую. Их callback_data НЕ пересекаются.
//
// Этот модуль — единственный реестр маршрутов. matchCallbackBlock(data)
// определяет, какой блок должен обработать клик, или возвращает null для
// неизвестного/битого колбэка. Диспетчер bot.js вызывает РОВНО один блок.
//
// Новые inline-флоу добавлять с УНИКАЛЬНЫМ префиксом и регистрировать префикс
// здесь (правило «ровно один слушатель на событие»; третий обработчик не
// регистрировать). Тесты: tests/routes.test.js.
// ============================================================================

// ──────────────────────────── Блок A (основной) ─────────────────────────────
const BLOCK_A = {
    // Префиксные колбэки — аналог data.startsWith(prefix)
    prefixes: [
        'dl_', 'assign_exec_', 'pick_exec_', 'keep_common_', 'reject_task_',
        'cancel_assign_', 'edit_', 'proj_contact_', 'proj_legal_', 'pnewtask_',
        'pattach_', 'messenger_', 'view_', 'ccard_', 'lcard_', 'pcard_',
        'pst_set_', 'pst_', 'ptasks_', 'ptask_new_', 'pnote_', 'pdeadline_',
        'ptransfer_set_', 'ptransfer_', 'arch_card_', 'done_', 'task_exec_',
        'project_', 'append_to_proj_',
        // v4.42.1: позиции заказа (ведение сделки, карточка проекта)
        'proj_items_', 'pitem_',
        // v4.42.2: документы проекта (список/визард/PDF в чат)
        'docs_',
        // v4.42.4: оплаты проекта («💵 Оплаты» в карточке)
        'pay_',
        // v4.43.0: правка карточки контакта/юрлица («✏️ Изменить» в карточке):
        // cc_edit_ — меню правки контакта; cc_field_ — выбор поля (ждём текст);
        // ccmsg_ — выбор мессенджера кнопками (ввод не нужен)
        'cc_edit_', 'cc_field_', 'ccmsg_',
        // v4.43.0: привязка контакта к юрлицу («🏢 Привязать юрлицо» в карточке контакта):
        // cc_link_ — открыть выбор юрлица; cc_unlink_ — отвязка (+ подтверждение cc_unlink_{id});
        // org_pick_{contactId}_{legalId} — выбор из списка; org_search_ — поиск текстом; org_cancel_ — отмена
        'cc_link_', 'cc_unlink_', 'org_pick_', 'org_search_', 'org_cancel_',
        // v4.43.0: правка карточки юрлица («✏️ Изменить»): lc_edit_ — меню, lc_field_ — выбор поля;
        // v4.45.0: lc_page_ — переключение экранов формы (основные / банк и адреса)
        'lc_edit_', 'lc_field_', 'lc_page_'
    ],
    // Точные колбэки — аналог data === value
    exacts: [
        'edit_deadline', 'edit_cancel', 'show_today', 'show_history',
        'use_existing_contact', 'create_new_anyway', 'create_new_anyway_username',
        'proj_tab_fiz', 'proj_tab_legal', 'proj_search_contact', 'proj_search_legal',
        'proj_search_all', 'proj_new_contact', 'proj_new_legal', 'proj_no_contact',
        'proj_task_yes', 'proj_task_no', 'pdone_dismiss', 'dup_use_existing',
        'dup_create_anyway', 'view_back', 'ccard_back', 'lcard_back', 'pcard_back',
        'arch_back', 'refresh_tasks', 'noop', 'start_new_task', 'task_exec_none',
        'project_none', 'create_new_project_for_task', 'show_contacts',
        'show_projects', 'create_new_project_from_menu', 'add_contact_from_menu',
        'proj_new_for_contact', 'proj_none_contact', 'append_to_project',
        'append_to_contact', 'cancel_msg_append'
    ],
    // Regex-колбэки — пагинация списков (tl_0, hl_1, ...), задач проекта (ptl_)
    // и селектора «выбор проекта» в визарде задачи (ptj_, v4.45.0)
    regexes: [
        /^(tl|td|hl|cl|pl|ll|al)_(\d+)$/,
        /^ptl_(\d+)_(\d+)$/,
        /^ptj_(\d+)$/
    ]
};

// ──────────────────── Блок B (скрытый профиль / пересылки / файлы) ──────────
const BLOCK_B = {
    prefixes: [
        'hidden_select_contact_', 'hidden_select_project_',
        'forward_select_contact_', 'forward_select_project_', 'fwd_append_',
        'comment_task_', 'file_task_', 'file_proj_', 'folder_proj_',
        'folder_yes_', 'files_proj_'
    ],
    exacts: [
        'hidden_create_new', 'hidden_add_to_contact', 'hidden_show_all_contacts',
        'hidden_add_to_project', 'hidden_cancel', 'forward_create_new',
        'forward_add_to_contact', 'forward_show_all_contacts',
        'forward_add_to_project', 'forward_cancel', 'fwd_create_task',
        'fwd_append_task', 'fwd_cancel', 'comment_cancel', 'file_cancel',
        'folder_cancel', 'files_cancel'
    ],
    // v4.45.0: навигация страниц селекторов блока B (pcm/pft — свои задачи,
    // pfu/pfd/pfl — выбор активного проекта) — формат {key}_{page}
    regexes: [
        /^(pcm|pft|pfu|pfd|pfl)_(\d+)$/
    ]
};

// ─────────────────── Колбэки ТОЛЬКО для Руководителя (ADMIN) ───────────────
// Заявки сотрудников (assign/pick/keep/reject/cancel_assign) и передача проекта
// (ptransfer_*). В UI кнопки показываются ТОЛЬКО Руководителю (см. генерацию в
// bot.js: уведомления о заявках шлются админу, «Передать менеджеру» рендерится
// при role === ADMIN), но исторически в ветках проверок роли НЕ было — любой
// сотрудник мог «подделать» callback_data и распорядиться чужой заявкой.
// Центральный guard: см. диспетчер в bot.js (isAdminOnlyCallback).
const ADMIN_ONLY_PREFIXES = [
    'assign_exec_',   // назначить исполнителя заявке
    'pick_exec_',     // выбор исполнителя (продолжение assign)
    'keep_common_',   // оставить заявку общей
    'reject_task_',   // отклонить заявку
    'cancel_assign_', // отмена выбора исполнителя
    'ptransfer_'      // передача проекта (открытие меню и выбор менеджера)
];

// ─────────────── Колбэки для Менеджера и Руководителя (НЕ Исполнитель) ──────
// Действия с проектами/папками/файлами проекта и клиентской базой. Исполнитель
// не видит проекты (canSeeProjects) и контакты (canSeeContacts), но ветки
// исторически не проверяли роль — он мог «подделать» callback_data: открыть
// файлы чужого проекта (files_proj_), список проектов для загрузки (file_proj_),
// создать папку (folder_proj_/folder_yes_), войти в визард задачи в проекте
// (pnewtask_) или создать/изменить контакта через пересылку (hidden_*/forward_*).
const MANAGER_ONLY_PREFIXES = [
    'pnewtask_',    // «Создать задачу» из карточки проекта
    'file_proj_',   // выбор проекта для загрузки файла
    'folder_proj_', // создание папки (шаг выбора проекта)
    'folder_yes_',  // подтверждение создания папки (вызывает webhook)
    'files_proj_',  // список файлов проекта
    'append_to_proj_', // добавить пересланный текст в проект
    // Скрытый профиль (создание/дополнение контакта, добавление в проект)
    'hidden_',
    // Пересылка в контакты/проекты (создание контакта, «добавить к контакту/проекту»)
    'forward_create_new',
    'forward_add_to_contact',
    'forward_show_all_contacts',
    'forward_select_contact_',
    'forward_add_to_project',
    'forward_select_project_',
    // v4.42.1: позиции заказа — ведение сделки доступно Менеджеру+ (не Исполнителю)
    'proj_items_',
    'pitem_',
    // v4.42.2: документы проекта — создание/PDF тоже Менеджер+ (отправка по флагу, Шаг 4)
    'docs_',
    // v4.42.4: оплаты — просмотр меню доступен Менеджеру+, внесение денег — по флагу
    'pay_',
    // v4.43.0: правка контактов/юрлиц и привязка контакта к юрлицу — то же право,
    // что на просмотр клиентской базы (Менеджер+; «видишь — с тем и работаешь»)
    'cc_edit_', 'cc_field_', 'ccmsg_', 'cc_link_', 'cc_unlink_',
    'org_pick_', 'org_search_', 'org_cancel_', 'lc_edit_', 'lc_field_'
];

function isAdminOnlyCallback(data) {
    if (typeof data !== 'string' || data.length === 0) return false;
    for (const prefix of ADMIN_ONLY_PREFIXES) {
        if (data.startsWith(prefix)) return true;
    }
    return false;
}

function isManagerOnlyCallback(data) {
    if (typeof data !== 'string' || data.length === 0) return false;
    for (const prefix of MANAGER_ONLY_PREFIXES) {
        if (data.startsWith(prefix)) return true;
    }
    return false;
}

// Порядок проверки важен: сначала ТОЧНЫЕ значения, потом префиксы, потом regex.
// Точное значение, начинающееся со «своего» префикса (например edit_deadline
// внутри edit_), обязано выигрывать у префикса — сейчас оба ведут в один блок,
// но при росте реестра до маршрутов с разными обработчиками это станет правилом.
function matchCallbackBlock(data) {
    if (typeof data !== 'string' || data.length === 0) return null;

    if (BLOCK_A.exacts.includes(data)) return 'A';
    for (const prefix of BLOCK_A.prefixes) {
        if (data.startsWith(prefix)) return 'A';
    }
    for (const re of BLOCK_A.regexes) {
        if (re.test(data)) return 'A';
    }

    if (BLOCK_B.exacts.includes(data)) return 'B';
    for (const prefix of BLOCK_B.prefixes) {
        if (data.startsWith(prefix)) return 'B';
    }
    for (const re of BLOCK_B.regexes) {
        if (re.test(data)) return 'B';
    }

    return null;
}

// ─────────── Колбэки отправки документов «наружу» (v4.42.3, Волна A) ──────────
// Отправка по email (docs_send_) и отметка ручной передачи (docs_manual_) — это
// «выстрел наружу»: недостаточно роли Менеджера, нужен ещё флаг «Отправка
// документов» (roles.canSendDocuments). Guard в диспетчере bot.js.
const DOC_SEND_ONLY_PREFIXES = [
    'docs_send_',
    'docs_manual_',
    // v4.42.4: внесение оплаты — «деньги наружу», по флагу «Отправка документов»
    'pay_'
];

function isDocsSendOnlyCallback(data) {
    if (typeof data !== 'string' || data.length === 0) return false;
    for (const prefix of DOC_SEND_ONLY_PREFIXES) {
        if (data.startsWith(prefix)) return true;
    }
    return false;
}

module.exports = {
    BLOCK_A,
    BLOCK_B,
    ADMIN_ONLY_PREFIXES,
    MANAGER_ONLY_PREFIXES,
    DOC_SEND_ONLY_PREFIXES,
    matchCallbackBlock,
    isAdminOnlyCallback,
    isManagerOnlyCallback,
    isDocsSendOnlyCallback
};
