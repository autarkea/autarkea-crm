// ============================================================================
// shared/session.js
// ============================================================================
// ПЕР-ЧАТ СЕССИИ (v4.29.0) — «у каждого сотрудника свой блокнот».
//
// Проблема (до v4.29.0): состояние всех визардов бота (создание задачи/проекта/
// контакта/юрлица, forward-флоу) хранилось в ГЛОБАЛЬНЫХ переменных bot.js
// (currentState, taskDraft, contactDraft, projectDraft, legalDraft,
// pendingContactAction). Два сотрудника, заполняющие формы одновременно,
// затирали состояние друг друга (см. документацию, раздел «Архитектура доступа»).
//
// Решение: состояние хранится в Map<chatId, session>. Каждый обработчик бота
// работает с СВОЕЙ сессией. Чистые функции этого модуля не зависят от Telegram
// и сети — они тестируются в tests/session.test.js (как shared/roles.js).
//
// Сессия содержит ровно те же поля, что были у глобальных переменных, поэтому
// поведение одиночного пользователя не меняется.
//
// ЕДИНСТВЕННЫЙ источник дефолтов черновиков. Меняешь структуру сессии —
// сначала тесты, потом код бота.
// ============================================================================

// Дефолтная сессия. Собираем САМЫЙ полный набор полей из старых объявлений
// bot.js (строки ~219-231) и resetState() (~442-455), чтобы ни один флоу не
// получил undefined там, где раньше поле существовало. Все дефолты falsy —
// семантика проверок `if (draft.x)` не меняется.
function emptySession() {
    return {
        state: 'idle',
        taskDraft: {
            title: '',
            deadline: null,
            projectId: null,
            editTaskId: null,
            commentTaskId: null,
            fileTaskId: null,
            fileProjectId: null,
            folderProjectId: null
        },
        legalDraft: { name: '', email: '', phone: '' },
        contactDraft: { name: '', phone: null, username: null, email: null, messenger: 'Telegram' },
        projectDraft: {
            title: '',
            contactId: null,
            legalId: null,
            tab: 'fiz',
            noteProjectId: null,
            deadlineProjectId: null,
            transferProjectId: null,
            managerId: null,
            source: 'menu',
            attachProjectId: null,
            dupProjectId: null
        },
        // v4.42.1: визард позиции заказа («📝 Позиции» в карточке проекта).
        itemDraft: {
            projectId: null,  // к какому проекту относится позиция
            itemId: null,     // при редактировании существующей позиции
            editField: null,  // 'price' | 'qty' — что редактируем
            type: null,       // Товар/Работа/Товар+Работа/Мат. заказчика
            name: '',
            unit: 'шт.',
            price: null,      // null = нет цены (Мат. заказчика)
            qty: null
        },
        // v4.42.2: визард создания документа («📄 Документы» в карточке проекта).
        docDraft: {
            projectId: null, // проект, для которого создаётся документ
            type: null,      // Счет / Счет (Физлицо) / Акт / Акт (Физлицо) / Накладная
            stamp: true,     // «С печатью» — по умолчанию ДА (электронный документ)
            note: ''         // опциональное примечание (LongText, попадает в PDF)
        },
        // v4.42.4: внесение оплаты («💵 Внести оплату» в карточке проекта).
        payDraft: {
            projectId: null // проект, в который вносим оплату
        },
        // v4.42.5: предпросмотр email перед отправкой документа («📧 Отправить по email»).
        // null — нет активного предпросмотра; иначе { docId, projectId, candidates, selected }.
        emailDraft: null,
        // v4.43.1 (защита от гонки двойного тапа): true, пока POST /api/send-doc в полёте.
        // Второй клик по «✅ Отправить» отклоняется — клиент не получает два письма.
        emailSending: false,
        // v4.43.0: правка полей карточки контакта/юрлица («✏️ Изменить» в карточке).
        // kind: 'contact' | 'legal'; id: Id записи; field: key поля из CONTACT_EDIT_FIELDS/LEGAL_EDIT_FIELDS.
        // Пока state === WAITING_EDIT_VALUE — ждём новое значение этого поля текстом.
        editDraft: { kind: null, id: null, field: null },
        // v4.43.0: привязка контакта к юрлицу (кнопка «🏢 Привязать юрлицо» в карточке контакта).
        // contactId — контакт, которому выбираем организацию; legalId — выбранное юрлицо.
        orgDraft: { contactId: null, legalId: null },
        pendingContactAction: {
            active: false,
            contactId: null,
            waitingPhone: false,
            waitingProjectForMessage: false,
            forwardedData: { messageText: '', projectId: null },
            afterContactCreated: null,
            isHiddenProfile: false,
            hiddenProfileMessageText: ''
        }
    };
}

// Лениво создаёт сессию для chatId и возвращает её.
// sessions — экземпляр Map (один на процесс бота).
// v4.29.0 (Заход 2): каждый вызов обновляет _updatedAt — это «время последней
// активности чата», на которое опирается cleanupStaleSessions (залипшие флоу).
function getSession(sessions, chatId) {
    if (!sessions.has(chatId)) {
        sessions.set(chatId, emptySession());
    }
    const s = sessions.get(chatId);
    s._updatedAt = Date.now();
    return s;
}

// Сбрасывает сессию chatId до дефолта (эквивалент старого resetState()).
// ВАЖНО: мутируем СУЩЕСТВУЮЩИЙ объект, а не подменяем его в Map.
// Причина: в bot.js после сброса часто сразу продолжают работать с уже
// полученной ссылкой (паттерн: const s = getSession(...); resetSession(...);
// s.state = ...). Если класть в Map новый объект — старая ссылка «умирает»
// и запись уходит в никуда.
function resetSession(sessions, chatId) {
    const existing = sessions.get(chatId);
    if (!existing) {
        const fresh = emptySession();
        sessions.set(chatId, fresh);
        return fresh;
    }
    for (const k of Object.keys(existing)) delete existing[k];
    Object.assign(existing, emptySession());
    return existing;
}

// Полностью удаляет сессию chatId из памяти (освобождение).
function deleteSession(sessions, chatId) {
    sessions.delete(chatId);
}

// Страховка от «залипших» сессий (v4.29.0).
// Раньше залипший флоу сбрасывал ЛЮБОЙ другой сотрудник нажатием кнопки меню
// (resetState на каждое меню). Теперь чужой не трогает чужое, поэтому сессия,
// висящая в НЕ-idle дольше maxAgeMs, сбрасывается автоматически.
// Возвращает количество очищенных сессий.
function cleanupStaleSessions(sessions, maxAgeMs, now = Date.now()) {
    let cleaned = 0;
    for (const [chatId, s] of sessions.entries()) {
        if (s.state !== 'idle' && s._updatedAt && (now - s._updatedAt) > maxAgeMs) {
            resetSession(sessions, chatId); // мутация — старые ссылки не «умирают»
            cleaned++;
        }
    }
    return cleaned;
}

// Помечает сессию «живой». Вызывается при каждом действии пользователя.
// Нужно для cleanupStaleSessions (без _updatedAt сессия не может «состариться»).
function touchSession(s) {
    if (s) s._updatedAt = Date.now();
    return s;
}

// Полная очистка ПУСТЫХ (idle) сессий старше maxIdleMs.
// Зачем: bot.on('message')/обработчики создают сессию на ЛЮБОЕ сообщение
// (включая случайных людей и каналы). Пустая сессия не мешает, но если их
// много — Map растёт. Idle-сессия, к которой не обращались сутки, удаляется.
// Возвращает количество удалённых сессий.
function cleanupIdleSessions(sessions, maxIdleMs, now = Date.now()) {
    let removed = 0;
    for (const [chatId, s] of sessions.entries()) {
        if (s.state === 'idle' && s._updatedAt && (now - s._updatedAt) > maxIdleMs) {
            sessions.delete(chatId);
            removed++;
        }
    }
    return removed;
}

module.exports = {
    emptySession,
    getSession,
    resetSession,
    deleteSession,
    cleanupStaleSessions,
    cleanupIdleSessions,
    touchSession
};
