// ============================================================================
// bot/handlers/files.js — домен «файлы/папки/комментарии/пересылки/скрытый профиль»
// ============================================================================
// Фаза 3: ветки callback_query «блока B» перенесены из bot.js БЕЗ изменения логики.
// Модуль — фабрика: получает контекст ctx (bot, config, сессии, роли, хелперы)
// и возвращает { handleCallbackBlockB }. Новые фичи этого домена — сюда,
// префикс колбэка регистрировать в ../routes.js (правило «один слушатель»).
// ============================================================================

module.exports = function createFilesHandlers(ctx) {
    const {
        bot, config, axios, sessions, employeesCache,
        STATE, ROLES, roles, WEBHOOK_URL, sorters,
        getSession, getEmployee, resetState, fetchAllRows, setListPage,
        appendTaskDetails, extractWebhookError, getForwardContacts,
        // v4.45.0: рендеры селекторов с пагинацией (навигация страниц блока B)
        showMyTasksForComment, showMyTasksForFile,
        showProjectsForFile, showProjectsForFolder, showProjectsForFilesList,
        escapeMarkdown
    } = ctx;

async function handleCallbackBlockB(callbackQuery) {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    const sess = getSession(sessions, chatId);
    
    if (data === 'hidden_create_new') {
        bot.answerCallbackQuery(callbackQuery.id);
        sess.state = STATE.WAITING_CONTACT_NAME;
        bot.sendMessage(chatId, `✏️ *Напиши ИМЯ этого человека:*`, { parse_mode: 'Markdown' });
        return;
    }
    
    if (data === 'hidden_add_to_contact') {
        bot.answerCallbackQuery(callbackQuery.id);
        // v4.21.5: контакты по зоне видимости роли (все проекты менеджера, включая закрытые)
        try {
            const emp = callbackQuery.from ? getEmployee(callbackQuery.from.id) : null;
            const contacts = await getForwardContacts(emp);

            let message = `👥 *Выбери контакт для добавления текста (${contacts.length}):*

`;
            if (contacts.length === 0) message += '📭 Нет контактов в ваших проектах.';

            const inlineKeyboard = [];
            contacts.slice(0, 10).forEach(c => {
                const phone = c['Телефон'] ? ` (${escapeMarkdown(c['Телефон'])})` : '';
                inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `hidden_select_contact_${c.Id}` }]);
            });
            if (contacts.length > 10) {
                inlineKeyboard.push([{ text: '📋 Показать все контакты', callback_data: 'hidden_show_all_contacts' }]);
            }
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'hidden_cancel' }]);
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data === 'hidden_show_all_contacts') {
        bot.answerCallbackQuery(callbackQuery.id);
        // v4.21.5: по зоне видимости роли (раньше — ВСЕ контакты системы)
        try {
            const emp = callbackQuery.from ? getEmployee(callbackQuery.from.id) : null;
            const contacts = await getForwardContacts(emp);
            let message = `👥 *Контакты (${contacts.length}):*\n\n`;
            const inlineKeyboard = [];
            contacts.forEach(c => {
                const phone = c['Телефон'] ? ` (${escapeMarkdown(c['Телефон'])})` : '';
                inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `hidden_select_contact_${c.Id}` }]);
            });
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'hidden_cancel' }]);
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data.startsWith('hidden_select_contact_')) {
        bot.answerCallbackQuery(callbackQuery.id);
        const contactId = parseInt(data.split('_')[3]);
        sess.pendingContactAction.contactId = contactId;
        
        // Добавляем текст в доп. инфо
        try {
            const timestamp = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });
            const newEntry = `[${timestamp}] Пересылка (скрытый профиль)\n💬 "${sess.pendingContactAction.hiddenProfileMessageText}"`;
            const current = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const oldExtra = String(current.data['Доп. информация'] || '').trim();
            const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { 'Доп. информация': newExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `✅ Текст добавлен в карточку контакта!`);
            
            // Сбрасываем состояние
            sess.pendingContactAction.isHiddenProfile = false;
            sess.pendingContactAction.hiddenProfileMessageText = '';
            sess.pendingContactAction.active = false;
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }
    
    if (data === 'hidden_add_to_project') {
        bot.answerCallbackQuery(callbackQuery.id);
        // Показываем список АКТИВНЫХ проектов для выбора
        try {
            const allProjectsRows = await fetchAllRows(config.TABLES.PROJECTS, 100, 'sort=-Id');
            const activeProjects = allProjectsRows.filter(p => p['Активно'] === 'Активно');
            
            let message = `📂 *Выбери АКТИВНЫЙ проект для добавления текста:*\n\n`;
            if (activeProjects.length === 0) {
                message += '📭 Нет активных проектов.';
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                return;
            }
            
            const inlineKeyboard = [];
            activeProjects.forEach(p => {
                inlineKeyboard.push([{ text: `📝 ${escapeMarkdown(p['Что делаем?'])} (ID:${p.Id})`, callback_data: `hidden_select_project_${p.Id}` }]);
            });
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'hidden_cancel' }]);
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }
    
    if (data.startsWith('hidden_select_project_')) {
        bot.answerCallbackQuery(callbackQuery.id);
        const projectId = parseInt(data.split('_')[3]);
        
        // Добавляем текст в подробности проекта
        try {
            const timestamp = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });
            const newEntry = `[${timestamp}] Пересылка (скрытый профиль)\n💬 "${sess.pendingContactAction.hiddenProfileMessageText}"`;
            const current = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const oldExtra = String(current.data['Подробности'] || '').trim();
            const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Подробности': newExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.sendMessage(chatId, `✅ Текст добавлен в проект!`);
            
            // Сбрасываем состояние
            sess.pendingContactAction.isHiddenProfile = false;
            sess.pendingContactAction.hiddenProfileMessageText = '';
            sess.pendingContactAction.active = false;
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }
    
    if (data === 'hidden_cancel') {
        bot.answerCallbackQuery(callbackQuery.id);
        sess.pendingContactAction.isHiddenProfile = false;
        sess.pendingContactAction.hiddenProfileMessageText = '';
        sess.pendingContactAction.active = false;
        bot.sendMessage(chatId, `❌ Отменено.`);
        return;
    }

    // ================== ОБРАБОТЧИКИ ДЛЯ ОТКРЫТЫХ ПРОФИЛЕЙ (forward_*) ==================
    if (data === 'forward_create_new') {
        bot.answerCallbackQuery(callbackQuery.id);
        
        // Если контакт уже существует — всё равно создаём нового
        if (sess.pendingContactAction.contactId && !sess.pendingContactAction.isNew) {
            // Контакт есть в базе, но пользователь хочет создать нового
            sess.pendingContactAction.contactId = null;
            sess.pendingContactAction.isNew = true;
        }
        
        sess.state = STATE.WAITING_CONTACT_NAME;
        // Если есть известное имя из открытого профиля — показываем его
        const knownName = sess.pendingContactAction.forwardedData?.contactName;
        if (knownName) {
            bot.sendMessage(chatId, `✏️ *Имя:* ${escapeMarkdown(knownName)}\n\n📄 Текст сообщения будет сохранён после создания контакта.\n\n💡 *Напиши новое имя* или /skip чтобы использовать указанное.`, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, `✏️ *Напиши ИМЯ этого человека:*\n\n📄 Текст сообщения будет сохранён после создания контакта.`, { parse_mode: 'Markdown' });
        }
        return;
    }

    if (data === 'forward_add_to_contact') {
        bot.answerCallbackQuery(callbackQuery.id);
        
        // Если контакт уже найден (по TG ID или username) — сразу добавляем текст
        if (sess.pendingContactAction.contactId) {
            const contactId = sess.pendingContactAction.contactId;
            const messageText = sess.pendingContactAction.forwardedData.messageText;
            const timestamp = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });

            try {
                const current = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, {
                    headers: { 'xc-token': config.NOCO_TOKEN }
                });
                const oldExtra = String(current.data['Доп. информация'] || '').trim();
                const newEntry = messageText ? `[${timestamp}] Пересылка\n💬 "${escapeMarkdown(messageText)}"` : `[${timestamp}] Переслано сообщение (без текста)`;
                const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;

                await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, {
                    'Доп. информация': newExtra
                }, { headers: { 'xc-token': config.NOCO_TOKEN } });

                bot.sendMessage(chatId, `✅ Текст добавлен в контакт *${escapeMarkdown(current.data['Имя'])}*\n\n📄 ${escapeMarkdown(messageText || '(без текста)')}`, { parse_mode: 'Markdown' });
                sess.pendingContactAction.active = false;
            } catch (err) {
                bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
            }
            return;
        }

        // v4.21.5: контакты по зоне видимости роли (все проекты менеджера, включая закрытые)
        try {
            const emp = callbackQuery.from ? getEmployee(callbackQuery.from.id) : null;
            const contacts = await getForwardContacts(emp);

            let message = `👤 *Выбери контакт для добавления текста:*\n\n`;
            if (contacts.length === 0) {
                message += '📭 Нет контактов в ваших проектах.';
            } else {
                message += `📋 Контакты (${contacts.length}):\n\n`;
            }

            const inlineKeyboard = [];
            contacts.slice(0, 10).forEach(c => {
                const phone = c['Телефон'] ? ` 📱${escapeMarkdown(c['Телефон'])}` : '';
                inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `forward_select_contact_${c.Id}` }]);
            });

            if (contacts.length > 10) {
                inlineKeyboard.push([{ text: '📋 Показать все контакты', callback_data: 'forward_show_all_contacts' }]);
            }
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'forward_cancel' }]);

            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data === 'forward_show_all_contacts') {
        bot.answerCallbackQuery(callbackQuery.id);
        try {
            // v4.21.5: по зоне видимости роли (раньше — ВСЕ контакты системы, включая чужие)
            const emp = callbackQuery.from ? getEmployee(callbackQuery.from.id) : null;
            const contacts = await getForwardContacts(emp);

            const inlineKeyboard = [];
            contacts.slice(0, 20).forEach(c => {
                const phone = c['Телефон'] ? ` 📱${escapeMarkdown(c['Телефон'])}` : '';
                inlineKeyboard.push([{ text: `👤 ${escapeMarkdown(c['Имя'])}${phone}`, callback_data: `forward_select_contact_${c.Id}` }]);
            });
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'forward_cancel' }]);

            await bot.sendMessage(chatId, `👤 *Контакты (${contacts.length}):*`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data.startsWith('forward_select_contact_')) {
        bot.answerCallbackQuery(callbackQuery.id);
        const contactId = parseInt(data.split('_')[3]);
        const messageText = sess.pendingContactAction.forwardedData.messageText;
        const timestamp = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });
        
        try {
            const current = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, {
                headers: { 'xc-token': config.NOCO_TOKEN }
            });
            const oldExtra = String(current.data['Доп. информация'] || '').trim();
            const newEntry = messageText ? `[${timestamp}] Пересылка\n💬 "${escapeMarkdown(messageText)}"` : `[${timestamp}] Переслано сообщение (без текста)`;
            const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
            
            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, {
                'Доп. информация': newExtra
            }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            
            bot.sendMessage(chatId, `✅ Текст добавлен в контакт *${escapeMarkdown(current.data['Имя'])}*`, { parse_mode: 'Markdown' });
            sess.pendingContactAction.active = false;
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data === 'forward_add_to_project') {
        bot.answerCallbackQuery(callbackQuery.id);
        try {
            const allProjectsRows = await fetchAllRows(config.TABLES.PROJECTS, 100, 'sort=-Id');
            const activeProjects = allProjectsRows.filter(p => p['Активно'] === 'Активно');
            
            let message = `📂 *Выбери АКТИВНЫЙ проект для добавления текста:*\n\n`;
            if (activeProjects.length === 0) {
                message += '📭 Нет активных проектов.';
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                return;
            }
            
            const inlineKeyboard = [];
            activeProjects.forEach(p => {
                inlineKeyboard.push([{ text: `📝 ${escapeMarkdown(p['Что делаем?'])} (ID:${p.Id})`, callback_data: `forward_select_project_${p.Id}` }]);
            });
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'forward_cancel' }]);
            
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data.startsWith('forward_select_project_')) {
        bot.answerCallbackQuery(callbackQuery.id);
        const projectId = parseInt(data.split('_')[3]);
        const messageText = sess.pendingContactAction.forwardedData.messageText;
        const timestamp = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });
        
        try {
            const current = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, {
                headers: { 'xc-token': config.NOCO_TOKEN }
            });
            const oldDetails = String(current.data['Подробности'] || '').trim();
            const newEntry = messageText ? `[${timestamp}] Пересылка\n💬 "${escapeMarkdown(messageText)}"` : `[${timestamp}] Переслано сообщение (без текста)`;
            const newDetails = oldDetails ? `${oldDetails}\n\n${newEntry}` : newEntry;
            
            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, {
                'Подробности': newDetails
            }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            
            bot.sendMessage(chatId, `✅ Текст добавлен в проект *${escapeMarkdown(current.data['Что делаем?'])}*`, { parse_mode: 'Markdown' });
            sess.pendingContactAction.active = false;
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
        }
        return;
    }

    if (data === 'forward_cancel') {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
        bot.sendMessage(chatId, '❌ Отменено.');
        sess.pendingContactAction.active = false;
        return;
    }

    // ================== ПЕРЕСЫЛКА: новые callback ==================
    if (data.startsWith('fwd_append_')) {
        const taskId = parseInt(data.split('_')[2]);
        const msgText = sess.pendingContactAction.forwardedData?.messageText || '(без текста)';
        const emp = callbackQuery.from ? getEmployee(callbackQuery.from.id) : null;

        try {
            if (!emp) { bot.sendMessage(chatId, '⛔ Доступ запрещён'); return; }
            // Владение задачей: пересылать текст можно только в свою задачу или
            // задачу своего проекта.
            const task = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
            if (!roles.canAccessTask(task, emp)) {
                bot.sendMessage(chatId, '⛔ Добавлять текст можно только в свою задачу или задачу своего проекта.');
                return;
            }
            await appendTaskDetails(taskId, `Переслано:\n${msgText}`, 'forward');
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Добавлено в Подробности!' });
            bot.editMessageText(`✅ Текст добавлен к задаче #${taskId}`, {
                chat_id: chatId, message_id: callbackQuery.message.message_id
            }).catch(() => {});
        } catch (err) {
            bot.answerCallbackQuery(callbackQuery.id, { text: `❌ ${err.message}` });
        }
        sess.pendingContactAction.active = false;
        return;
    }

    if (data === 'fwd_create_task') {
        bot.answerCallbackQuery(callbackQuery.id);
        sess.state = STATE.WAITING_TITLE;
        sess.taskDraft.title = sess.pendingContactAction.forwardedData?.messageText || '';
        bot.sendMessage(chatId, `📝 *Создать задачу из пересланного?*\n\n📄 ${escapeMarkdown(sess.taskDraft.title)}\n\nОтредактируй название или нажми /skip чтобы создать как есть.`, { parse_mode: 'Markdown' });
        return;
    }

    if (data === 'fwd_append_task') {
        bot.answerCallbackQuery(callbackQuery.id);
        // Показать список задач для выбора
        try {
            const rows = await fetchAllRows(config.TABLES.TASKS);
            const allActiveTasks = rows.filter(t => !t['Готово']);
            // Только задачи своей зоны: Руководитель — все, Менеджер — свои +
            // задачи своих проектов, Исполнитель — только свои (filterTasksByRole).
            const activeTasks = roles.filterTasksByRole(allActiveTasks, callbackQuery.from ? getEmployee(callbackQuery.from.id) : null);
            // v4.38.0: сортируем ДО slice — иначе «первые 15» = 15 самых старых задач.
            activeTasks.sort(sorters.compareTasksActive);
            const inlineKeyboard = activeTasks.slice(0, 15).map(t =>
                [{ text: `#${t.Id} ${t['Что делаем?']}`, callback_data: `fwd_append_${t.Id}` }]
            );
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'fwd_cancel' }]);
            bot.sendMessage(chatId, `📋 *Выбери задачу:*`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
        return;
    }

    if (data === 'fwd_cancel') {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
        bot.sendMessage(chatId, '❌ Отменено.');
        sess.pendingContactAction.active = false;
        return;
    }

    // ================== КОММЕНТАРИЙ К ЗАДАЧЕ (Исполнитель) ==================
    if (data.startsWith('comment_task_')) {
        const taskId = parseInt(data.split('_')[2]);
        bot.answerCallbackQuery(callbackQuery.id);
        const empC = callbackQuery.from ? getEmployee(callbackQuery.from.id) : null;
        if (!empC) return;
        // Владение задачей: комментировать можно только свою задачу или задачу
        // своего проекта («видишь ровно то, чем управляешь»).
        try {
            const taskC = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
            if (!roles.canAccessTask(taskC, empC)) {
                bot.sendMessage(chatId, '⛔ Вы можете комментировать только свою задачу или задачу своего проекта.');
                return;
            }
        } catch (errC) {
            bot.sendMessage(chatId, `❌ Ошибка: ${errC.message}`);
            return;
        }
        sess.taskDraft.commentTaskId = taskId;
        sess.state = STATE.WAITING_COMMENT_TEXT;
        bot.sendMessage(chatId, `💬 *Напиши комментарий к задаче #${taskId}:*\n\nТекст будет добавлен в Подробности задачи.`, { parse_mode: 'Markdown' });
        return;
    }
    if (data === 'comment_cancel') {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
        bot.sendMessage(chatId, '❌ Отменено.');
        resetState(chatId);
        return;
    }

    // ================== ЗАГРУЗКА ФАЙЛА ==================
    if (data.startsWith('file_task_')) {
        const taskId = parseInt(data.split('_')[2]);
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Проверяю папку...' });

        try {
            // 🛡️ Проблема 91: та же проверка папки, что и для Менеджера/Руководителя, но через задачу.
            // Исполнитель не должен отправлять файл в проект без клиента/папки — раньше ошибку
            // «Не указан клиент» он получал уже ПОСЛЕ отправки файла.
            const taskRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const empF = callbackQuery.from ? getEmployee(callbackQuery.from.id) : null;
            if (!empF || !roles.canAccessTask(taskRes.data, empF)) {
                bot.sendMessage(chatId, '⛔ Вы можете загружать файлы только в свою задачу или задачу своего проекта.');
                resetState(chatId);
                return;
            }
            const taskProj = taskRes.data['Какой проект'];
            const taskProjectId = Array.isArray(taskProj) ? taskProj[0]?.Id : taskProj?.Id;

            if (!taskProjectId) {
                bot.sendMessage(chatId, `❌ Задача #${taskId} не привязана к проекту — файл некуда сохранить.\n\nПопроси Руководителя привязать задачу к проекту и попробуй снова.`);
                resetState(chatId);
                return;
            }

            const folderCheck = await axios.get(`${WEBHOOK_URL}/create-folder?docId=${taskProjectId}&secret=${process.env.WEBHOOK_SECRET || ''}`, {
                timeout: 15000,
                validateStatus: () => true
            });

            if (folderCheck.status >= 400) {
                const errText = extractWebhookError(folderCheck.data) || `Вебхук вернул статус ${folderCheck.status}`;
                bot.sendMessage(chatId, `❌ Файл загрузить нельзя:\n${errText}\n\n💡 Если у проекта не указан клиент — привяжи Контакт или Юрлицо в карточке проекта и попробуй снова.`);
                resetState(chatId);
                return;
            }
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка проверки папки: ${err.response?.data?.error || err.message}`);
            resetState(chatId);
            return;
        }

        sess.taskDraft.fileTaskId = taskId;
        sess.taskDraft.fileProjectId = null;
        sess.state = STATE.WAITING_FILE_UPLOAD;
        bot.sendMessage(chatId, `📎 *Отправь файл для задачи #${taskId}*\n\nДокумент, фото, архив — что угодно (до 50MB).`, { parse_mode: 'Markdown' });
        return;
    }
    if (data.startsWith('file_proj_')) {
        const projectId = parseInt(data.split('_')[2]);
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Проверяю папку...' });

        try {
            // 🛡️ ПРОВЕРКА ПАПКИ ПЕРЕД ЗАГРУЗКОЙ (Проблема 90):
            // webhook /create-folder идемпотентен: создаст папку/подпапки, если их нет,
            // или вернёт «уже существует». Если у проекта нет клиента (Контакт/Юрлицо) —
            // вернёт ошибку, и мы НЕ пускаем пользователя в бесполезную загрузку файла,
            // которая раньше заканчивалась таймаутом/ошибкой после отправки файла.
            const folderCheck = await axios.get(`${WEBHOOK_URL}/create-folder?docId=${projectId}&secret=${process.env.WEBHOOK_SECRET || ''}`, {
                timeout: 15000,
                validateStatus: () => true
            });

            if (folderCheck.status >= 400) {
                const errText = extractWebhookError(folderCheck.data) || `Вебхук вернул статус ${folderCheck.status}`;
                bot.sendMessage(chatId, `❌ Файл загрузить нельзя:\n${errText}\n\n💡 Если у проекта не указан клиент — привяжи Контакт или Юрлицо в карточке проекта и попробуй снова.`);
                resetState(chatId);
                return;
            }
        } catch (err) {
            bot.sendMessage(chatId, `❌ Ошибка проверки папки: ${err.response?.data?.error || err.message}`);
            resetState(chatId);
            return;
        }

        sess.taskDraft.fileProjectId = projectId;
        sess.taskDraft.fileTaskId = null;
        sess.state = STATE.WAITING_FILE_UPLOAD;
        const proj = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
        bot.sendMessage(chatId, `📎 *Отправь файл для проекта "${proj['Что делаем?']}"*\n\nФайл будет сохранён в папку Рабочие.`, { parse_mode: 'Markdown' });
        return;
    }
    if (data === 'file_cancel') {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
        bot.sendMessage(chatId, '❌ Отменено.');
        resetState(chatId);
        return;
    }

    // ================== СОЗДАНИЕ ПАПКИ ПРОЕКТА ==================
    if (data.startsWith('folder_proj_')) {
        const projectId = parseInt(data.split('_')[2]);
        bot.answerCallbackQuery(callbackQuery.id);

        // Показываем превью имени папки
        try {
            const projRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const proj = projRes.data;
            const contactId = proj['Контакт']?.Id || (Array.isArray(proj['Контакт']) ? proj['Контакт'][0]?.Id : null);
            const legalId = proj['Юрлицо']?.Id || (Array.isArray(proj['Юрлицо']) ? proj['Юрлицо'][0]?.Id : null);

            let folderPreview = proj['Что делаем?'] || 'без_названия';

            if (!contactId && !legalId) {
                // 🛡️ Папку без клиента создать нельзя (v4.16.1 после ревью) — блокируем на уровне бота,
                // чтобы не показать ложный «успех» после ошибки вебхука.
                bot.sendMessage(chatId, '❌ Папку создать нельзя: у проекта не указан Контакт или Юрлицо.\n\n💡 Привяжи клиента (Контакт или Юрлицо) в карточке проекта и попробуй снова.');
                resetState(chatId);
                return;
            } else if (contactId) {
                try {
                    const cRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
                    const cName = cRes.data['Имя'] || 'контакт';
                    folderPreview = `${proj['Что делаем?'] || 'ID' + projectId} - ${cName}`;
                } catch(e) { folderPreview = `${proj['Что делаем?'] || 'ID' + projectId} - контакт`; }
            } else if (legalId) {
                try {
                    const lRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.LEGAL_ENTITIES}/${legalId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
                    const lName = lRes.data['Краткое Имя'] || lRes.data['Имя'] || 'юрлицо';
                    folderPreview = `${proj['Что делаем?'] || 'ID' + projectId} - ${lName}`;
                } catch(e) { folderPreview = `${proj['Что делаем?'] || 'ID' + projectId} - юрлицо`; }
            }

            sess.taskDraft.folderProjectId = projectId;
            const inlineKeyboard = [
                [{ text: '✅ Да, создать', callback_data: `folder_yes_${projectId}` }],
                [{ text: '❌ Нет, отмена', callback_data: `folder_cancel` }]
            ];
            bot.sendMessage(chatId, `📦 Папка будет: *${folderPreview}*\n\nУверены?`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
        } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
        return;
    }

    if (data.startsWith('folder_yes_')) {
        const projectId = parseInt(data.split('_')[2]);
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Создаю...' });

        try {
            const res = await axios.get(`${WEBHOOK_URL}/create-folder?docId=${projectId}&secret=${process.env.WEBHOOK_SECRET || ''}`, {
                timeout: 15000,
                validateStatus: () => true
            });

            // ❌ Вебхук вернул ошибку (папка не создана) — показываем текст ошибки, а не «успех»
            if (res.status >= 400) {
                const errText = extractWebhookError(res.data) || `Вебхук вернул статус ${res.status}`;
                bot.editMessageText(`❌ Не удалось создать папку:\n${errText}`, {
                    chat_id: callbackQuery.message.chat.id,
                    message_id: callbackQuery.message.message_id
                }).catch(() => {});
                resetState(chatId);
                return;
            }

            // Проверяем что вернул webhook
            const responseData = res.data;
            if (typeof responseData === 'string' && responseData.includes('Папка создана')) {
                bot.editMessageText('✅ Папка создана!', {
                    chat_id: callbackQuery.message.chat.id,
                    message_id: callbackQuery.message.message_id
                }).catch(() => {});
            } else if (typeof responseData === 'string' && responseData.includes('существующая')) {
                bot.editMessageText('ℹ️ Папка уже существует!', {
                    chat_id: callbackQuery.message.chat.id,
                    message_id: callbackQuery.message.message_id
                }).catch(() => {});
            } else if (responseData?.path) {
                bot.editMessageText(`✅ Папка создана!\n\n📁 ${responseData.path}`, {
                    chat_id: callbackQuery.message.chat.id,
                    message_id: callbackQuery.message.message_id
                }).catch(() => {});
            } else if (responseData?.message) {
                bot.editMessageText(`✅ ${responseData.message}\n\n📁 ${responseData.path || ''}`, {
                    chat_id: callbackQuery.message.chat.id,
                    message_id: callbackQuery.message.message_id
                }).catch(() => {});
            } else {
                bot.editMessageText('✅ Готово! Проверь проект.', {
                    chat_id: callbackQuery.message.chat.id,
                    message_id: callbackQuery.message.message_id
                }).catch(() => {});
            }
        } catch (err) {
            const errMsg = err.response?.data?.error || err.message;
            bot.sendMessage(chatId, `❌ Ошибка: ${errMsg}`);
        }
        resetState(chatId);
        return;
    }

    if (data === 'folder_cancel') {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
        bot.sendMessage(chatId, '❌ Отменено.');
        resetState(chatId);
        return;
    }

    // ================== ПРОСМОТР ФАЙЛОВ ПРОЕКТА ==================
    if (data.startsWith('files_proj_')) {
        const projectId = parseInt(data.split('_')[2]);
        bot.answerCallbackQuery(callbackQuery.id);

        // Отправляем промежуточное сообщение
        const loadingMsg = await bot.sendMessage(chatId, '⏳ Обновляю список файлов...');

        try {
            // Обновляем список файлов через webhook
            const refreshRes = await axios.get(`${WEBHOOK_URL}/refresh-files?docId=${projectId}&secret=${process.env.WEBHOOK_SECRET || ''}`, {
                timeout: 15000,
                validateStatus: () => true
            });

            // ❌ Вебхук вернул ошибку (нет клиента / папка не создана) — показываем текст ошибки
            if (refreshRes.status >= 400) {
                const errText = extractWebhookError(refreshRes.data) || `Вебхук вернул статус ${refreshRes.status}`;
                bot.editMessageText(`❌ Не удалось обновить список файлов:\n${errText}`, {
                    chat_id: loadingMsg.chat.id,
                    message_id: loadingMsg.message_id
                }).catch(() => {});
                resetState(chatId);
                return;
            }

            // Небольшая задержка чтобы NocoDB обновил поле
            await new Promise(r => setTimeout(r, 1500));

            // Получаем проект с обновлённым списком файлов
            const projRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const proj = projRes.data;
            const filesText = proj['Файлы в папке'] || '📭 Файлов пока нет.';

            // Убираем «⏳ Обновляю...» и отправляем список файлов
            bot.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id).catch(() => {});
            await bot.sendMessage(chatId, `📁 *${proj['Что делаем?'] || 'Проект'}*\n\n${filesText.replace(/[*_\[\]()~`>#+\-=|{}.!]/g, '\\$&')}`, { parse_mode: 'Markdown' });
        } catch (err) {
            const errMsg = err.response?.data?.error || err.message;
            bot.deleteMessage(loadingMsg.chat.id, loadingMsg.message_id).catch(() => {});
            await bot.sendMessage(chatId, `❌ Ошибка: ${errMsg}`);
        }
        resetState(chatId);
        return;
    }

    if (data === 'files_cancel') {
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
        bot.sendMessage(chatId, '❌ Отменено.');
        resetState(chatId);
        return;
    }

    // ================== ПАГИНАЦИЯ СЕЛЕКТОРОВ (v4.45.0) ==================
    // pcm/pft — свои задачи (комментарий/файл); pfu/pfd/pfl — активный проект.
    // Рендеры — общие в bot.js; здесь только вызываем нужный с новой страницей.
    const selNavMatch = data.match(/^(pcm|pft|pfu|pfd|pfl)_(\d+)$/);
    if (selNavMatch) {
        bot.answerCallbackQuery(callbackQuery.id);
        const pickerKey = selNavMatch[1];
        const page = parseInt(selNavMatch[2]) || 0;
        const cbTelegramId = callbackQuery.from?.id;
        const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
        const role = emp ? emp.Роль : ROLES.EXECUTOR;
        setListPage(cbTelegramId, pickerKey, page);
        if (pickerKey === 'pcm') await showMyTasksForComment(chatId, cbTelegramId, page, msg.message_id);
        else if (pickerKey === 'pft') await showMyTasksForFile(chatId, cbTelegramId, page, msg.message_id);
        else if (pickerKey === 'pfu') await showProjectsForFile(chatId, cbTelegramId, role, page, msg.message_id);
        else if (pickerKey === 'pfd') await showProjectsForFolder(chatId, cbTelegramId, role, page, msg.message_id);
        else if (pickerKey === 'pfl') await showProjectsForFilesList(chatId, cbTelegramId, role, page, msg.message_id);
        return;
    }
}


    return { handleCallbackBlockB };
};
