// ============================================================================
// bot/handlers/main.js — «ядро»: задачи/проекты/контакты/юрлица/визарды
// ============================================================================
// Фаза 3: callback-ветки «блока A» перенесены из bot.js БЕЗ изменения логики.
// Модуль — фабрика: получает контекст ctx (bot, config, сессии, роли, хелперы,
// функции-рендеры списков, оставшиеся в bot.js) и возвращает { handleCallbackBlockA }.
// ============================================================================

module.exports = function createMainHandlers(ctx) {
    const { parseItemCallback } = require('../shared/callback-parse');
    const {
        bot, config, axios, noco, sessions, employeesCache,
        STATE, ROLES, roles, PROJECT_STATUSES, PROJECT_INACTIVE_STATUSES,
        getSession, getEmployee, resetState, resetReminderState, loadAllowedUsers,
        fetchAllRows, invalidateTaskListCache, setListPage, getListPage, escapeMarkdown, plainTextFromMarkdown,
        formatMinskDate, parseQuickDeadline, extractLinkId,
        startContactWizard, startProjectWizard, startEditTask, startProjectTask,
        startProjectNote, startProjectDeadline, showProjectSelectionForContact,
        showProjectStep3, showContactSelectionForProject, showLegalSelectionForProject,
        showProjectSelectionForTask,
        showProjectAfterCreate, handleTaskDeadlineChosen, transferProject, createProjectRecord,
        sendTaskList, sendTodayTasks, sendTaskHistory, sendTaskDetails,
        sendContactsList, sendContactDetails, sendLegalList, sendLegalDetails,
        sendProjectsList, sendProjectDetails, sendProjectStatusMenu,
        sendProjectTasksList, sendProjectItemsList, sendProjectItemDetails,
        sendProjectDocsList, sendDocCard, sendDocCreateConfirm, generateDocPdfAndSend,
        todayNocoDate, docTypeKeyboard, sendPaymentMenu, sendArchivedProjects, sendTransferMenu, sendDeadlinePicker,
        sendContactEditMenu, sendLegalEditMenu,
        applyContactFieldEdit, applyContactMessengerEdit, applyLegalFieldEdit,
        sendOrgSelectionForContact, showFoundLegalsForOrg, setContactOrgLink, addContactHistoryEntry
    } = ctx;

async function handleCallbackBlockA(callbackQuery) {
    const msg = callbackQuery.message;
    const data = callbackQuery.data;
    const chatId = msg.chat.id;
    const sess = getSession(sessions, chatId);

    try {
        // ================== ВЫБОР СРОКА (быстрые кнопки dl_*) ==================
        if (data.startsWith('dl_')) {
            const option = data.split('_')[1];
            bot.answerCallbackQuery(callbackQuery.id);
            const cbTelegramId = callbackQuery.from?.id;

            // --- Редактирование срока задачи ---
            if (sess.state === STATE.WAITING_EDIT_DEADLINE) {
                if (option === 'none') {
                    try {
                        await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${sess.taskDraft.editTaskId}`, { 'Что делаем?': sess.taskDraft.title, 'Когда делаем': null }, { headers: { 'xc-token': config.NOCO_TOKEN } });
                        invalidateTaskListCache(); // v4.43.1: срок изменился — списки задач перерисуются свежими
                        resetReminderState(sess.taskDraft.editTaskId); // v4.27.0: срок убран — старые ключи напоминаний не актуальны

                        bot.editMessageText(`✅ Срок убран.\n📝 *${escapeMarkdown(sess.taskDraft.title)}*`, { chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown' }).catch(() => {});
                    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
                    resetState(chatId);
                    return;
                }
                const parsed = parseQuickDeadline(option);
                if (parsed) {
                    try {
                        await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${sess.taskDraft.editTaskId}`, { 'Что делаем?': sess.taskDraft.title, 'Когда делаем': parsed.toISOString() }, { headers: { 'xc-token': config.NOCO_TOKEN } });
                        invalidateTaskListCache(); // v4.43.1: срок изменился — списки задач перерисуются свежими
                        resetReminderState(sess.taskDraft.editTaskId); // v4.27.0: новый дедлайн = новые напоминания

                        bot.editMessageText(`✅ *Задача #${sess.taskDraft.editTaskId} обновлена!*\n\n📝 ${escapeMarkdown(sess.taskDraft.title)}\n📅 ${formatMinskDate(parsed)}`, { chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown' }).catch(() => {});
                    } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
                    resetState(chatId);
                }
                return;
            }

            // --- Создание задачи ---
            if (sess.state === STATE.WAITING_DEADLINE) {
                const deadline = option === 'none' ? null : parseQuickDeadline(option);
                await bot.editMessageText(`📅 Срок: ${deadline ? formatMinskDate(deadline) : 'Без срока'}`, {
                    chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [] }
                }).catch(() => {});
                await handleTaskDeadlineChosen(chatId, cbTelegramId, deadline);
                return;
            }

            bot.sendMessage(chatId, '⏳ Этот шаг уже завершён. Начни создание задачи заново.');
            return;
        }

        // ================== НАЗНАЧЕНИЕ ИСПОЛНИТЕЛЯ (заявка от сотрудника) ==================
        if (data.startsWith('assign_exec_')) {
            const taskId = parseInt(data.split('_')[2]);
            bot.answerCallbackQuery(callbackQuery.id);

            // Показываем список активных сотрудников (используем кэш с NocoDB Id)
            const allEmployees = Array.from(employeesCache.entries());
            const inlineKeyboard = allEmployees.map(([tid, e]) =>
                [{ text: `👤 ${e.Обращение} (${e.Роль})`, callback_data: `pick_exec_${taskId}_${e.Id}` }]
            );
            inlineKeyboard.push([{ text: '❌ Отмена', callback_data: `cancel_assign_${taskId}` }]);

            bot.sendMessage(chatId, `👥 *Выбери исполнителя для задачи #${taskId}:*`, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: inlineKeyboard }
            });
            return;
        }

        if (data.startsWith('pick_exec_')) {
            const parts = data.split('_');
            const taskId = parseInt(parts[2]);
            const executorNocoId = parseInt(parts[3]);
            const executor = Array.from(employeesCache.values()).find(e => e.Id === executorNocoId);

            if (!executor) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Сотрудник не найден в кэше' });
                return;
            }

            try {
                // ⚠️ NocoDB Data API v1 не поддерживает PATCH для M2O relation полей.
                // Workaround: GET задачу → DELETE → POST с Исполнитель.
                const taskUrl = `${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`;
                const task = (await axios.get(taskUrl, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                const proposerId = (() => {
                    const p = task['Кто предложил'];
                    if (Array.isArray(p)) return p[0]?.Id || null;
                    if (typeof p === 'object' && p) return p.Id || null;
                    return p || null;
                })();

                await axios.delete(taskUrl, { headers: { 'xc-token': config.NOCO_TOKEN } });

                const payload = {
                    'Что делаем?': task['Что делаем?'],
                    'Готово': task['Готово'],
                    'Исполнитель': executorNocoId
                };
                if (task['Какой проект']) payload['Какой проект'] = task['Какой проект'];
                if (task['Кто предложил']) payload['Кто предложил'] = task['Кто предложил'];
                if (task['Когда делаем']) payload['Когда делаем'] = task['Когда делаем'];

                const newTask = (await axios.post(
                    `${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}`,
                    payload,
                    { headers: { 'xc-token': config.NOCO_TOKEN } }
                )).data;
                invalidateTaskListCache(); // v4.43.1: исполнитель назначен — список задач обновится

                bot.answerCallbackQuery(callbackQuery.id, { text: `✅ ${executor.Обращение} назначен!` });
                bot.editMessageText(`✅ Задача #${newTask.Id} → *${executor.Обращение}*`, {
                    chat_id: chatId, message_id: callbackQuery.message.message_id, parse_mode: 'Markdown'
                }).catch(() => {});

                // Уведомление исполнителю НЕ шлём здесь — его пришлёт loadAllowedUsers()
                // при следующем обновлении кэша (≤1 мин) с защитой от дублей (Проблема 81).

                // Уведомить АВТОРА заявки (если это не сам исполнитель — иначе будет дубль с loadAllowedUsers)
                if (proposerId && proposerId !== executorNocoId) {
                    const proposerTgId = Array.from(employeesCache.entries()).find(([tid, e]) => e.Id === proposerId)?.[0];
                    if (proposerTgId) {
                        bot.sendMessage(Number(proposerTgId),
                            `✅ *Ваша заявка #${newTask.Id} принята:* назначен ${executor.Обращение}\n\n📝 ${task['Что делаем?']}`,
                            { parse_mode: 'Markdown' }).catch(() => {});
                    }
                }
            } catch (err) {
                bot.answerCallbackQuery(callbackQuery.id, { text: `❌ Ошибка: ${err.message}` });
                console.error('assign_exec error:', err.message);
            }
            return;
        }

        if (data.startsWith('keep_common_')) {
            const taskId = parseInt(data.split('_')[2]);
            bot.answerCallbackQuery(callbackQuery.id, { text: '📋 Оставлена общей' });
            bot.editMessageText(`📋 Задача #${taskId} оставлена общей (без исполнителя).`, {
                chat_id: chatId, message_id: callbackQuery.message.message_id
            }).catch(() => {});
            // Уведомить автора заявки
            try {
                const task = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                const proposerField = task['Кто предложил'];
                const proposerId = Array.isArray(proposerField) ? proposerField[0]?.Id : (proposerField?.Id || null);
                if (proposerId) {
                    const proposerTgId = Array.from(employeesCache.entries()).find(([tid, e]) => e.Id === proposerId)?.[0];
                    if (proposerTgId) {
                        bot.sendMessage(Number(proposerTgId),
                            `📋 *Ваша заявка #${taskId} оставлена общей.*\n\nМожет взять любой, но ответственный пока не назначен.`,
                            { parse_mode: 'Markdown' }).catch(() => {});
                    }
                }
            } catch (err) {}
            return;
        }

        if (data.startsWith('reject_task_')) {
            const taskId = parseInt(data.split('_')[2]);
            let proposerTgId = null;
            try {
                const current = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                const proposerField = current['Кто предложил'];
                const proposerId = Array.isArray(proposerField) ? proposerField[0]?.Id : (proposerField?.Id || null);
                if (proposerId) {
                    proposerTgId = Array.from(employeesCache.entries()).find(([tid, e]) => e.Id === proposerId)?.[0] || null;
                }
                await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, {
                    'Готово': true,
                    'Что делаем?': '❌ ОТКЛОНЕНА: ' + current['Что делаем?']
                }, { headers: { 'xc-token': config.NOCO_TOKEN } });
                invalidateTaskListCache(); // v4.43.1: заявка отклонена/закрыта — «Мои заявки» и списки обновятся
            } catch (err) {}
            bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Заявка отклонена' });
            bot.editMessageText(`❌ Заявка #${taskId} отклонена.`, {
                chat_id: chatId, message_id: callbackQuery.message.message_id
            }).catch(() => {});
            if (proposerTgId) {
                bot.sendMessage(Number(proposerTgId),
                    `❌ *Ваша заявка #${taskId} отклонена.*\n\nЕсли задача важная — обсудите с руководителем.`,
                    { parse_mode: 'Markdown' }).catch(() => {});
            }
            return;
        }

        if (data.startsWith('cancel_assign_')) {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
            return;
        }

        // ================== НОВОЕ: РЕДАКТИРОВАНИЕ ЗАДАЧИ ==================
        if (data.startsWith('edit_')) {
            const taskId = parseInt(data.split('_')[1]);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;

            // edit_{id} - начало редактирования (не edit_deadline/cancel)
            if (!data.startsWith('edit_deadline') && !data.startsWith('edit_cancel')) {
                // Проверяем права на редактирование
                if (role === ROLES.EXECUTOR) {
                    const task = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                    if (task['Исполнитель']?.Id !== emp.Id) {
                        bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Вы можете редактировать только свою задачу' });
                        return;
                    }
                } else if (role === ROLES.MANAGER) {
                    const task = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                    const isOwn = task['Исполнитель']?.Id === emp.Id;
                    const isOwnProject = task['Какой проект']?.['Менеджер']?.Id === emp.Id;
                    if (!isOwn && !isOwnProject) {
                        bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Вы можете редактировать только свою задачу или задачу своего проекта' });
                        return;
                    }
                }

                bot.answerCallbackQuery(callbackQuery.id);
                await startEditTask(chatId, taskId);
                return;
            }

            if (data === 'edit_deadline') {
                bot.answerCallbackQuery(callbackQuery.id);
                sess.state = STATE.WAITING_EDIT_DEADLINE;
                await sendDeadlinePicker(chatId, 'edit', `📅 *Введи новый срок для задачи #${taskId}:*`);
                return;
            }
            
            if (data === 'edit_cancel') {
                bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
                bot.sendMessage(chatId, '❌ Редактирование отменено.');
                resetState(chatId);
                return;
            }
            
            // edit_{id} - начало редактирования
            bot.answerCallbackQuery(callbackQuery.id);
            await startEditTask(chatId, taskId);
            return;
        }
        
        // ================== НОВОЕ: КОМАНДА /today из меню ==================
        if (data === 'show_today') {
            bot.answerCallbackQuery(callbackQuery.id);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            await sendTodayTasks(chatId, cbTelegramId, emp ? emp.Роль : ROLES.EXECUTOR);
            return;
        }

        // ================== НОВОЕ: ИСТОРИЯ ЗАДАЧ ==================
        if (data === 'show_history') {
            bot.answerCallbackQuery(callbackQuery.id);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            await sendTaskHistory(chatId, cbTelegramId, emp ? emp.Роль : ROLES.EXECUTOR);
            return;
        }

        if (data === 'use_existing_contact') {
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Используем существующий' });
            const duplicate = sess.pendingContactAction.duplicateContact;
            sess.pendingContactAction.waitingDuplicateResolve = false;
            
            if (sess.pendingContactAction.isHiddenProfile && sess.pendingContactAction.hiddenProfileMessageText) {
                const timestamp = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });
                const newEntry = `[${timestamp}] Пересылка (скрытый профиль)\n💬 "${sess.pendingContactAction.hiddenProfileMessageText}"`;
                const current = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${duplicate.Id}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
                const oldExtra = String(current.data['Доп. информация'] || '').trim();
                const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
                await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${duplicate.Id}`, { 'Доп. информация': newExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
                bot.sendMessage(chatId, `✅ Текст сообщения добавлен в карточку *${escapeMarkdown(duplicate['Имя'])}*`, { parse_mode: 'Markdown' });
                sess.pendingContactAction.isHiddenProfile = false;
                sess.pendingContactAction.hiddenProfileMessageText = '';
            }
            
            showProjectSelectionForContact(chatId, duplicate.Id);
            return;
        }
        
        if (data === 'create_new_anyway' || data === 'create_new_anyway_username') {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Создаём нового' });
            sess.pendingContactAction.waitingDuplicateResolve = false;
            if (data === 'create_new_anyway_username') {
                sess.state = STATE.WAITING_CONTACT_EMAIL;
                bot.sendMessage(chatId, `📧 *Напиши E-mail* (или /skip):`, { parse_mode: 'Markdown' });
            } else {
                sess.state = STATE.WAITING_CONTACT_USERNAME;
                bot.sendMessage(chatId, `🔗 *Введи Telegram username* (например, @vasiok) или /skip:`, { parse_mode: 'Markdown' });
            }
            return;
        }

        if (data.startsWith('proj_contact_')) {
            sess.projectDraft.contactId = parseInt(data.split('_')[2]);
            sess.projectDraft.legalId = null;
            sess.projectDraft.tab = 'fiz';
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Клиент выбран!' });
            await showProjectStep3(chatId, callbackQuery.from?.id);
            return;
        }

        if (data.startsWith('proj_legal_')) {
            sess.projectDraft.legalId = parseInt(data.split('_')[2]);
            sess.projectDraft.contactId = null;
            sess.projectDraft.tab = 'legal';
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Юрлицо выбрано!' });
            await showProjectStep3(chatId, callbackQuery.from?.id);
            return;
        }

        if (data === 'proj_tab_fiz') {
            bot.answerCallbackQuery(callbackQuery.id);
            await showContactSelectionForProject(chatId);
            return;
        }

        if (data === 'proj_tab_legal') {
            bot.answerCallbackQuery(callbackQuery.id);
            await showLegalSelectionForProject(chatId);
            return;
        }

        if (data === 'proj_search_contact') {
            bot.answerCallbackQuery(callbackQuery.id);
            sess.projectDraft.tab = 'fiz';
            sess.state = STATE.WAITING_CONTACT_SEARCH;
            bot.sendMessage(chatId, '🔍 *Введи часть имени, номер телефона, e-mail или username:*', { parse_mode: 'Markdown' });
            return;
        }

        if (data === 'proj_search_legal') {
            bot.answerCallbackQuery(callbackQuery.id);
            sess.projectDraft.tab = 'legal';
            sess.state = STATE.WAITING_PROJECT_LEGAL_SEARCH;
            bot.sendMessage(chatId, '🔍 *Введи часть имени юрлица, телефон, e-mail или УНП:*', { parse_mode: 'Markdown' });
            return;
        }

        if (data === 'proj_search_all') {
            bot.answerCallbackQuery(callbackQuery.id);
            sess.projectDraft.tab = 'all';
            sess.state = STATE.WAITING_PROJECT_CONTACT;
            bot.sendMessage(chatId, '🔍 *Введи имя, телефон, e-mail или УНП — ищем и физлиц, и юрлиц:*', { parse_mode: 'Markdown' });
            return;
        }

        if (data === 'proj_new_contact') {
            bot.answerCallbackQuery(callbackQuery.id);
            startContactWizard(chatId);
            sess.pendingContactAction.afterContactCreated = 'back_to_project';
            return;
        }

        if (data === 'proj_new_legal') {
            bot.answerCallbackQuery(callbackQuery.id);
            sess.legalDraft = { name: '', email: '', phone: '' };
            sess.state = STATE.WAITING_LEGAL_NAME;
            sess.pendingContactAction.afterContactCreated = 'back_to_project';
            bot.sendMessage(chatId, `🏢 *Создание юрлица*\n\nШаг 1️⃣ из 3\n\n✏️ *Напиши Краткое Имя:*`, { parse_mode: 'Markdown' });
            return;
        }

        if (data === 'proj_no_contact') {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Ок, без клиента' });
            sess.projectDraft.contactId = null;
            sess.projectDraft.legalId = null;
            await showProjectStep3(chatId, callbackQuery.from?.id);
            return;
        }

        if (data === 'proj_task_yes') {
            bot.answerCallbackQuery(callbackQuery.id);
            
            // СНАЧАЛА создаём проект (единая точка createProjectRecord — v4.25.0)
            try {
                const created = await createProjectRecord({
                    title: sess.projectDraft.title,
                    contactId: sess.projectDraft.contactId,
                    legalId: sess.projectDraft.legalId,
                    managerId: sess.projectDraft.managerId,
                    creator: getEmployee(callbackQuery.from?.id)
                });
                
                // Сохраняем ID созданного проекта
                sess.taskDraft.projectId = created.Id;
                console.log(`✅ Проект создан, projectId=${created.Id}, type=${typeof created.Id}`);
                
                bot.sendMessage(chatId, `🚀 *Проект создан!*\n📝 ${sess.projectDraft.title}\n🆔 ID: ${created.Id}\n\n📝 *Теперь напиши название задачи:*`, { parse_mode: 'Markdown' });
                
                sess.state = STATE.WAITING_PROJECT_TASK;
            } catch (err) {
                bot.sendMessage(chatId, `❌ Ошибка создания проекта: ${err.message}`);
                resetState(chatId);
            }
            return;
        }

        if (data === 'proj_task_no') {
            bot.answerCallbackQuery(callbackQuery.id);
            try {
                const created = await createProjectRecord({
                    title: sess.projectDraft.title,
                    contactId: sess.projectDraft.contactId,
                    legalId: sess.projectDraft.legalId,
                    managerId: sess.projectDraft.managerId,
                    creator: getEmployee(callbackQuery.from?.id)
                });
                // v4.25.0: финальный экран «Что дальше?» вместо сухого подтверждения
                await showProjectAfterCreate(chatId, created.Id, callbackQuery.from?.id);
                resetState(chatId);
            } catch (err) {
                bot.sendMessage(chatId, `❌ Ошибка создания проекта: ${err.message}`);
                resetState(chatId);
            }
            return;
        }

        // ================== v4.25.0: БЫСТРЫЕ ДЕЙСТВИЯ ПОСЛЕ СОЗДАНИЯ ПРОЕКТА ==================
        if (data.startsWith('pnewtask_')) {
            bot.answerCallbackQuery(callbackQuery.id);
            const projectId = parseInt(data.split('_')[1]);
            await startProjectTask(chatId, callbackQuery.from?.id, projectId);
            return;
        }

        if (data.startsWith('pattach_')) {
            bot.answerCallbackQuery(callbackQuery.id);
            const projectId = parseInt(data.split('_')[1]);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            if (role === ROLES.EXECUTOR) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Нет доступа' }); return; }
            // Менеджер — только свои проекты
            if (role === ROLES.MANAGER) {
                const proj = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                if (extractLinkId(proj['Менеджер']) !== emp?.Id) { bot.sendMessage(chatId, '⛔ Вы можете менять клиента только в своих проектах.'); return; }
            }
            sess.projectDraft = { title: '', contactId: null, legalId: null, tab: 'fiz', managerId: null, source: 'attach', attachProjectId: projectId, dupProjectId: null };
            await showContactSelectionForProject(chatId);
            return;
        }

        if (data === 'pdone_dismiss') {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Готово' });
            resetState(chatId);
            return;
        }

        // ================== v4.25.0: ДУБЛИКАТ НАЗВАНИЯ ПРОЕКТА ==================
        if (data === 'dup_use_existing') {
            bot.answerCallbackQuery(callbackQuery.id);
            const projectId = sess.projectDraft.dupProjectId;
            if (!projectId) { resetState(chatId); return; }
            if (sess.projectDraft.source === 'task') {
                // привязываем задачу к существующему проекту
                sess.taskDraft.projectId = projectId;
                await bot.sendMessage(chatId, `📁 Используем существующий проект #${projectId}.`);
                await handleTaskDeadlineChosen(chatId, callbackQuery.from?.id, sess.taskDraft.deadline);
            } else if (sess.projectDraft.source === 'contact') {
                // привязываем контакт к существующему проекту
                sess.projectDraft.attachProjectId = projectId;
                await showProjectStep3(chatId, callbackQuery.from?.id);
            } else {
                // меню: просто открываем карточку существующего проекта
                const cbTelegramId = callbackQuery.from?.id;
                const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
                const role = emp ? emp.Роль : ROLES.EXECUTOR;
                resetState(chatId);
                await sendProjectDetails(chatId, null, projectId, role, cbTelegramId);
            }
            return;
        }

        if (data === 'dup_create_anyway') {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Ок, создаём новый' });
            if (sess.projectDraft.source === 'contact' && sess.projectDraft.contactId) {
                await showProjectStep3(chatId, callbackQuery.from?.id);
            } else {
                await showContactSelectionForProject(chatId);
            }
            return;
        }

        if (data.startsWith('messenger_')) {
            const messenger = data.replace('messenger_', '');
            sess.contactDraft.messenger = messenger === 'skip' ? 'Telegram' : messenger;
            bot.answerCallbackQuery(callbackQuery.id, { text: `✅ Выбрано: ${sess.contactDraft.messenger}` });

            const payload = { 'Имя': sess.contactDraft.name, 'Мессенджер': sess.contactDraft.messenger };
            if (sess.contactDraft.phone) payload['Телефон'] = sess.contactDraft.phone;
            if (sess.contactDraft.username) payload['Ссылка'] = `https://t.me/${sess.contactDraft.username}`;
            if (sess.contactDraft.email) payload['E-mail'] = sess.contactDraft.email;
            if (sess.pendingContactAction.forwardedData?.tgId) payload['TG ID'] = String(sess.pendingContactAction.forwardedData.tgId);

            const res = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const contactId = res.data.Id;
            noco.invalidateTable(config.TABLES.CONTACTS); // новый контакт должен появиться в списке сразу

            let msgText = `✅ *Контакт создан!*\n\n👤 *${escapeMarkdown(sess.contactDraft.name)}*\n📱 ${escapeMarkdown(sess.contactDraft.phone || 'не указан')}\n🔗 ${sess.contactDraft.username ? escapeMarkdown(`https://t.me/${sess.contactDraft.username}`) : 'не указан'}\n🆔 ID: ${contactId}`;
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });

            if (sess.pendingContactAction.isHiddenProfile && sess.pendingContactAction.hiddenProfileMessageText) {
                const timestamp = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });
                const newEntry = `[${timestamp}] Пересылка (скрытый профиль)\n💬 "${sess.pendingContactAction.hiddenProfileMessageText}"`;
                const current = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
                const oldExtra = String(current.data['Доп. информация'] || '').trim();
                const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
                await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${contactId}`, { 'Доп. информация': newExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
                bot.sendMessage(chatId, `📄 Текст сообщения сохранён в "Доп. информацию" контакта.`, { parse_mode: 'Markdown' });
                sess.pendingContactAction.isHiddenProfile = false;
                sess.pendingContactAction.hiddenProfileMessageText = '';
            }

            if (sess.pendingContactAction.afterContactCreated === 'back_to_project') {
                sess.projectDraft.contactId = contactId;
                sess.projectDraft.legalId = null;
                sess.pendingContactAction.afterContactCreated = null;
                await showProjectStep3(chatId, callbackQuery.from?.id);
            } else {
                showProjectSelectionForContact(chatId, contactId);
            }
            return;
        }

        // ================== ПРОСМОТР КАРТОЧКИ ЗАДАЧИ (кнопка 👁) ==================
        if (data === 'view_back') {
            bot.answerCallbackQuery(callbackQuery.id);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            await sendTaskList(chatId, msg.message_id, cbTelegramId, emp ? emp.Роль : ROLES.EXECUTOR, getListPage(cbTelegramId, 'tl'));
            return;
        }
        if (data.startsWith('view_')) {
            const taskId = parseInt(data.split('_')[1]);
            if (!Number.isInteger(taskId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;

            // Проверяем права на просмотр (та же логика, что у edit_/done_)
            const task = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
            // Автор заявки («Кто предложил») тоже может смотреть задачу — даже если назначена другому
            const isProposer = (() => {
                const p = task['Кто предложил'];
                if (Array.isArray(p)) return p.some(x => x?.Id === emp?.Id);
                if (typeof p === 'object' && p) return p.Id === emp?.Id;
                return p == emp?.Id;
            })();
            if (role === ROLES.EXECUTOR) {
                if (task['Исполнитель']?.Id !== emp?.Id && !isProposer) {
                    bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Вы можете смотреть только свою задачу или свою заявку' });
                    return;
                }
            } else if (role === ROLES.MANAGER) {
                const isOwn = task['Исполнитель']?.Id === emp?.Id;
                const isOwnProject = task['Какой проект']?.['Менеджер']?.Id === emp?.Id;
                if (!isOwn && !isOwnProject && !isProposer) {
                    bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Вы можете смотреть только свою задачу, задачу своего проекта или свою заявку' });
                    return;
                }
            }

            bot.answerCallbackQuery(callbackQuery.id);
            await sendTaskDetails(chatId, msg.message_id, taskId, role);
            return;
        }

        // ================== КАРТОЧКА КОНТАКТА (кнопка 👁 в списке контактов) ==================
        if (data === 'ccard_back') {
            bot.answerCallbackQuery(callbackQuery.id);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            await sendContactsList(chatId, cbTelegramId, emp ? emp.Роль : ROLES.EXECUTOR, msg.message_id, getListPage(cbTelegramId, 'cl'));
            return;
        }
        if (data.startsWith('ccard_')) {
            const contactId = parseInt(data.split('_')[1]);
            if (!Number.isInteger(contactId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;

            if (role === ROLES.EXECUTOR) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к контактам' });
                return;
            }
            // v4.26.0: Менеджер видит ВСЮ клиентскую базу — проверка canManagerSeeContact удалена.

            bot.answerCallbackQuery(callbackQuery.id);
            await sendContactDetails(chatId, msg.message_id, contactId, role, cbTelegramId);
            return;
        }

        // ================== КАРТОЧКА ЮРЛИЦА (кнопка 👁 в списке юрлиц) ==================
        if (data === 'lcard_back') {
            bot.answerCallbackQuery(callbackQuery.id);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            await sendLegalList(chatId, cbTelegramId, emp ? emp.Роль : ROLES.EXECUTOR, msg.message_id, getListPage(cbTelegramId, 'll'));
            return;
        }
        if (data.startsWith('lcard_')) {
            const legalId = parseInt(data.split('_')[1]);
            if (!Number.isInteger(legalId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;

            if (role === ROLES.EXECUTOR) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к юрлицам' });
                return;
            }
            // v4.26.0: Менеджер видит ВСЕ юрлица — проверка canManagerSeeLegal удалена.

            bot.answerCallbackQuery(callbackQuery.id);
            await sendLegalDetails(chatId, msg.message_id, legalId, role, cbTelegramId);
            return;
        }

        // ================== v4.43.0: РЕДАКТИРОВАНИЕ КОНТАКТА (✏️ в карточке) ==================
        if (data.startsWith('cc_edit_')) {
            const rest = data.slice('cc_edit_'.length);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            if (role === ROLES.EXECUTOR) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к редактированию контактов' });
                return;
            }
            if (rest.startsWith('back_')) {
                const contactId = parseInt(rest.slice('back_'.length), 10);
                if (!Number.isInteger(contactId)) return;
                bot.answerCallbackQuery(callbackQuery.id);
                sess.state = STATE.IDLE;
                await sendContactDetails(chatId, msg.message_id, contactId, role, cbTelegramId);
                return;
            }
            const contactId = parseInt(rest, 10);
            if (!Number.isInteger(contactId)) return;
            bot.answerCallbackQuery(callbackQuery.id);
            sess.state = STATE.IDLE;
            await sendContactEditMenu(chatId, msg.message_id, contactId, role, cbTelegramId);
            return;
        }
        if (data.startsWith('cc_field_')) {
            const parts = data.slice('cc_field_'.length).split('_');
            const contactId = parseInt(parts[0], 10);
            const fieldKey = parts.slice(1).join('_');
            if (!Number.isInteger(contactId) || !fieldKey) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            if (role === ROLES.EXECUTOR) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к редактированию контактов' });
                return;
            }
            bot.answerCallbackQuery(callbackQuery.id);
            if (fieldKey === 'messenger') {
                // Мессенджер — кнопками (валидные опции), ввод текста не нужен.
                const kb = config.MESSENGERS.map(m => [{ text: `${m.icon} ${m.name}`, callback_data: `ccmsg_${contactId}_${m.name}` }]);
                kb.push([{ text: '⬅️ Отмена', callback_data: `cc_edit_back_${contactId}` }]);
                await bot.editMessageText('💬 *Выбери мессенджер:*', { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
                return;
            }
            sess.editDraft = { kind: 'contact', id: contactId, field: fieldKey };
            sess.state = STATE.WAITING_EDIT_VALUE;
            await bot.sendMessage(chatId, '✏️ Введи новое значение. Отмена — /cancel.', { parse_mode: 'Markdown' });
            return;
        }
        if (data.startsWith('ccmsg_')) {
            const rest = data.slice('ccmsg_'.length);
            const idx = rest.indexOf('_');
            const contactId = parseInt(rest.slice(0, idx), 10);
            const messenger = idx >= 0 ? rest.slice(idx + 1) : '';
            if (!Number.isInteger(contactId) || !messenger) return;
            const cbTelegramId = callbackQuery.from?.id;
            bot.answerCallbackQuery(callbackQuery.id);
            await applyContactMessengerEdit(chatId, cbTelegramId, contactId, messenger);
            return;
        }

        // ================== v4.43.0: ПРИВЯЗКА КОНТАКТА К ЮРЛИЦУ (карточка контакта) ==================
        if (data.startsWith('cc_link_')) {
            const contactId = parseInt(data.slice('cc_link_'.length), 10);
            if (!Number.isInteger(contactId)) return;
            bot.answerCallbackQuery(callbackQuery.id);
            sess.state = STATE.IDLE;
            await sendOrgSelectionForContact(chatId, contactId);
            return;
        }
        if (data.startsWith('cc_unlink_')) {
            const contactId = parseInt(data.slice('cc_unlink_'.length), 10);
            if (!Number.isInteger(contactId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            bot.answerCallbackQuery(callbackQuery.id);
            sess.state = STATE.IDLE;
            const res = await setContactOrgLink(contactId, 0);
            if (!res.ok) {
                bot.sendMessage(chatId, `❌ Не удалось отвязать юрлицо: ${res.error}`);
                return;
            }
            const who = (emp && (emp.Обращение || emp.Имя)) || 'Сотрудник';
            await addContactHistoryEntry(contactId, who, 'Юрлицо: отвязано');
            await bot.sendMessage(chatId, '✅ Контакт отвязан от юрлица.');
            await sendContactDetails(chatId, null, contactId, emp ? emp.Роль : ROLES.EXECUTOR, cbTelegramId);
            return;
        }
        if (data.startsWith('org_pick_')) {
            const parts = data.slice('org_pick_'.length).split('_');
            const contactId = parseInt(parts[0], 10);
            const legalId = parseInt(parts[1], 10);
            if (!Number.isInteger(contactId) || !Number.isInteger(legalId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            bot.answerCallbackQuery(callbackQuery.id);
            sess.state = STATE.IDLE;
            const res = await setContactOrgLink(contactId, legalId);
            if (!res.ok) {
                bot.sendMessage(chatId, `❌ Не удалось привязать юрлицо: ${res.error}`);
                return;
            }
            let legalName = `#${legalId}`;
            try {
                const lres = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.LEGAL_ENTITIES}/${legalId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
                legalName = lres.data['Краткое Имя'] || lres.data['Имя'] || legalName;
            } catch (e) { /* имя юрлица некритично для аудита */ }
            const who = (emp && (emp.Обращение || emp.Имя)) || 'Сотрудник';
            await addContactHistoryEntry(contactId, who, `Юрлицо: привязано «${legalName}»`);
            await bot.sendMessage(chatId, `✅ Контакт привязан к юрлицу «${escapeMarkdown(legalName)}».`);
            await sendContactDetails(chatId, null, contactId, emp ? emp.Роль : ROLES.EXECUTOR, cbTelegramId);
            return;
        }

        if (data.startsWith('org_search_')) {
            const contactId = parseInt(data.slice('org_search_'.length), 10);
            if (!Number.isInteger(contactId)) return;
            bot.answerCallbackQuery(callbackQuery.id);
            sess.state = STATE.WAITING_ORG_SEARCH;
            sess.orgDraft.contactId = contactId;
            bot.sendMessage(chatId, '🔍 Напиши название юрлица (или УНП) для поиска. Отмена — /cancel.');
            return;
        }
        if (data.startsWith('org_cancel_')) {
            const contactId = parseInt(data.slice('org_cancel_'.length), 10);
            if (!Number.isInteger(contactId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            bot.answerCallbackQuery(callbackQuery.id);
            sess.state = STATE.IDLE;
            await sendContactDetails(chatId, msg.message_id, contactId, emp ? emp.Роль : ROLES.EXECUTOR, cbTelegramId);
            return;
        }

        // ================== ПЕРЕКЛЮЧЕНИЕ ЭКРАНОВ ПРАВКИ ЮРЛИЦА (v4.45.0) ==================
        // lc_page_{legalId}_{basic|bank}: форма «✏️ Изменить» разбита на 2 экрана
        // («Основные реквизиты» / «Банк и адреса») — не было простыни из 12 полей.
        if (data.startsWith('lc_page_')) {
            const rest = data.slice('lc_page_'.length);
            const parts = rest.split('_');
            const legalId = parseInt(parts[0], 10);
            const nextPart = parts[1];
            if (!Number.isInteger(legalId) || (nextPart !== 'basic' && nextPart !== 'bank')) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            if (role === ROLES.EXECUTOR) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к редактированию юрлиц' });
                return;
            }
            bot.answerCallbackQuery(callbackQuery.id);
            sess.state = STATE.IDLE;
            await sendLegalEditMenu(chatId, msg.message_id, legalId, role, cbTelegramId, nextPart);
            return;
        }

        // ================== v4.43.0: РЕДАКТИРОВАНИЕ ЮРЛИЦА (✏️ в карточке) ==================
        if (data.startsWith('lc_edit_')) {
            const rest = data.slice('lc_edit_'.length);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            if (role === ROLES.EXECUTOR) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к редактированию юрлиц' });
                return;
            }
            if (rest.startsWith('back_')) {
                const legalId = parseInt(rest.slice('back_'.length), 10);
                if (!Number.isInteger(legalId)) return;
                bot.answerCallbackQuery(callbackQuery.id);
                sess.state = STATE.IDLE;
                await sendLegalDetails(chatId, msg.message_id, legalId, role, cbTelegramId);
                return;
            }
            const legalId = parseInt(rest, 10);
            if (!Number.isInteger(legalId)) return;
            bot.answerCallbackQuery(callbackQuery.id);
            sess.state = STATE.IDLE;
            await sendLegalEditMenu(chatId, msg.message_id, legalId, role, cbTelegramId);
            return;
        }
        if (data.startsWith('lc_field_')) {
            const parts = data.slice('lc_field_'.length).split('_');
            const legalId = parseInt(parts[0], 10);
            const fieldKey = parts.slice(1).join('_');
            if (!Number.isInteger(legalId) || !fieldKey) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            if (role === ROLES.EXECUTOR) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к редактированию юрлиц' });
                return;
            }
            bot.answerCallbackQuery(callbackQuery.id);
            sess.editDraft = { kind: 'legal', id: legalId, field: fieldKey };
            sess.state = STATE.WAITING_EDIT_VALUE;
            bot.sendMessage(chatId, '✏️ Введи новое значение. Отмена — /cancel.', { parse_mode: 'Markdown' });
            return;
        }

        // ================== КАРТОЧКА ПРОЕКТА (кнопка 👁 в списке проектов) ==================
        if (data === 'pcard_back') {
            bot.answerCallbackQuery(callbackQuery.id);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            await sendProjectsList(chatId, cbTelegramId, emp ? emp.Роль : ROLES.EXECUTOR, msg.message_id, getListPage(cbTelegramId, 'pl'));
            return;
        }
        if (data.startsWith('pcard_')) {
            const projectId = parseInt(data.split('_')[1]);
            if (!Number.isInteger(projectId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;

            if (role === ROLES.EXECUTOR) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к проектам' });
                return;
            }
            if (role === ROLES.MANAGER) {
                // Менеджер — только свои проекты
                const project = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                if (project['Менеджер']?.Id !== emp?.Id) {
                    bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Вы можете смотреть только свои проекты' });
                    return;
                }
            }

            bot.answerCallbackQuery(callbackQuery.id);
            await sendProjectDetails(chatId, msg.message_id, projectId, role, cbTelegramId);
            return;
        }

        // ================== СМЕНА СТАТУСА ПРОЕКТА (v4.17.0) ==================
        // Префикс `pst_`/`pst_set_` выбран специально: `pcard_` (карточка) и `project_` (задачи) заняты.
        if (data.startsWith('pst_set_')) {
            const parts = data.split('_'); // ['pst','set',projectId,idx]
            const projectId = parseInt(parts[2]);
            const idx = parseInt(parts[3]);
            const newStatus = PROJECT_STATUSES[idx];
            if (!Number.isInteger(projectId) || !newStatus) return;

            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;

            if (role === ROLES.EXECUTOR) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к проектам' });
                return;
            }
            const project = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
            if (role === ROLES.MANAGER && extractLinkId(project['Менеджер']) !== emp?.Id) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Вы можете менять статус только своих проектов' });
                return;
            }

            const oldStatus = project['Статус'] || '—';
            if (oldStatus === newStatus) {
                bot.answerCallbackQuery(callbackQuery.id, { text: `Статус уже «${newStatus}»` });
                return;
            }

            // История в «Подробности»: кто, когда, с чего на что
            const empName = emp?.Имя || 'Сотрудник';
            const dateStr = formatMinskDate(new Date().toISOString());
            const logEntry = `📌 Статус: ${oldStatus} → ${newStatus} (${empName}, ${dateStr})`;
            const oldDetails = String(project['Подробности'] || '').trim();
            const newDetails = oldDetails ? `${oldDetails}\n\n${logEntry}` : logEntry;

            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Статус': newStatus, 'Подробности': newDetails }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            noco.invalidateTable(config.TABLES.PROJECTS); // список проектов должен обновиться сразу

            let ackText = `✅ Статус: ${newStatus}`;
            if (PROJECT_INACTIVE_STATUSES.has(newStatus)) {
                ackText += '\nПроект стал неактивным и убран из активных списков';
            }
            bot.answerCallbackQuery(callbackQuery.id, { text: ackText });
            await sendProjectDetails(chatId, msg.message_id, projectId, role, cbTelegramId);
            return;
        }
        if (data.startsWith('pst_')) {
            const projectId = parseInt(data.split('_')[1]);
            if (!Number.isInteger(projectId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;

            if (role === ROLES.EXECUTOR) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к проектам' });
                return;
            }
            if (role === ROLES.MANAGER) {
                // Менеджер — только свои проекты (та же проверка, что в pcard_)
                const project = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                if (extractLinkId(project['Менеджер']) !== emp?.Id) {
                    bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Вы можете менять статус только своих проектов' });
                    return;
                }
            }

            bot.answerCallbackQuery(callbackQuery.id);
            await sendProjectStatusMenu(chatId, msg.message_id, projectId, role, cbTelegramId);
            return;
        }

        // ================== ЗАДАЧИ ПРОЕКТА / ЗАМЕТКА / СРОК (v4.18.0) ==================
        if (data.startsWith('ptasks_') || data.startsWith('ptask_new_') || data.startsWith('pnote_') || data.startsWith('pdeadline_')) {
            const parts = data.split('_');
            const projectId = parseInt(parts[1] === 'new' ? parts[2] : parts[1]);
            if (!Number.isInteger(projectId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            if (role === ROLES.EXECUTOR) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к проектам' }); return; }
            if (role === ROLES.MANAGER) {
                const project = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                if (extractLinkId(project['Менеджер']) !== emp?.Id) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только свои проекты' }); return; }
            }
            bot.answerCallbackQuery(callbackQuery.id);
            if (data.startsWith('ptasks_')) {
                await sendProjectTasksList(chatId, msg.message_id, projectId, role, cbTelegramId);
            } else if (data.startsWith('ptask_new_')) {
                await startProjectTask(chatId, cbTelegramId, projectId);
            } else if (data.startsWith('pnote_')) {
                await startProjectNote(chatId, projectId);
            } else if (data.startsWith('pdeadline_')) {
                await startProjectDeadline(chatId, projectId);
            }
            return;
        }



        // ================== ПОЗИЦИИ ЗАКАЗА (v4.42.1, Волна A) ==================
        // Ведение сделки — право роли Менеджер+ (центральный guard MANAGER_ONLY
        // в routes.js). Владение проектом проверяем здесь, как в pcard_/ptasks_.
        if (data.startsWith('proj_items_')) {
            const projectId = parseInt(data.split('_')[2]);
            if (!Number.isInteger(projectId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            if (role === ROLES.EXECUTOR) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к проектам' }); return; }
            if (role === ROLES.MANAGER) {
                const project = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                if (extractLinkId(project['Менеджер']) !== emp?.Id) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только свои проекты' }); return; }
            }
            bot.answerCallbackQuery(callbackQuery.id);
            await sendProjectItemsList(chatId, msg.message_id, projectId);
            return;
        }

        if (data.startsWith('pitem_')) {
            // v4.42.1: разбор — только через parseItemCallback (единый источник;
            // ручной разбор давал баг «тап по карточке → сессия устарела»).
            const parsed = parseItemCallback(data);
            if (!parsed) {
                try { await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Неизвестное действие' }); } catch (e) { /* ignore */ }
                return;
            }
            const { kind, itemId, projectId: parsedPid, value } = parsed;
            // projectId для save/cancel — из черновика сессии (в колбэке его нет)
            const projectId = (kind === 'save' || kind === 'cancel') ? (sess.itemDraft && sess.itemDraft.projectId) : parsedPid;
            if (!Number.isInteger(projectId)) {
                try { await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Сессия устарела — открой проект заново' }); } catch (e) { /* ignore */ }
                return;
            }
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            if (role === ROLES.EXECUTOR) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к проектам' }); return; }
            if (role === ROLES.MANAGER) {
                try {
                    const project = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                    if (extractLinkId(project['Менеджер']) !== emp?.Id) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только свои проекты' }); return; }
                } catch (err) { bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Проект не найден' }); return; }
            }
            bot.answerCallbackQuery(callbackQuery.id);

            if (data === 'pitem_save') {
                const d = sess.itemDraft || {};
                if (!d.name) { resetState(chatId); bot.sendMessage(chatId, '❌ Черновик пуст — начни добавление заново.'); return; }
                try {
                    const payload = {
                        'Название': String(d.name).trim(),
                        'Тип': d.type || 'Работа',
                        'Ед. изм.': d.unit || 'шт.',
                        'Кол-во': (d.qty === null || d.qty === undefined) ? 1 : d.qty,
                        'Проекты': [{ Id: projectId }]
                    };
                    if (d.type !== 'Мат. заказчика' && d.price !== null && d.price !== undefined) payload['Цена'] = d.price;
                    await noco.createRow(config.TABLES.ITEMS, payload);
                    noco.invalidateTable(config.TABLES.ITEMS);
                    resetState(chatId);
                    bot.sendMessage(chatId, '✅ Позиция добавлена.');
                    await sendProjectItemsList(chatId, null, projectId);
                } catch (err) { bot.sendMessage(chatId, `❌ Не удалось сохранить: ${err.message}`); resetState(chatId); }
                return;
            }
            if (data === 'pitem_cancel') { resetState(chatId); bot.sendMessage(chatId, '❌ Отменено.'); return; }

            if (kind === 'new') { // pitem_new_{pid}
                sess.itemDraft.projectId = projectId;
                sess.state = STATE.WAITING_ITEM_TYPE;
                const types = [['📦 Товар', 'Товар'], ['🔧 Работа', 'Работа'], ['📦+🔧 Товар+Работа', 'Товар+Работа'], ['🧱 Мат. заказчика', 'Мат. заказчика']];
                const kb = types.map(t => [{ text: t[0], callback_data: `pitem_type_${t[1]}_${projectId}` }]);
                kb.push([{ text: '❌ Отмена', callback_data: 'pitem_cancel' }]);
                bot.sendMessage(chatId,
                    '🏷 *Что это за позиция?*\n\n' +
                    '🔧 Работа — услуга/печать/монтаж\n' +
                    '📦 Товар — материал/изделие\n' +
                    '📦+🔧 Товар+Работа — комплекс одной строкой\n' +
                    '🧱 Мат. заказчика — материал клиента, БЕЗ цены, в счёт не входит\n\n' +
                    '_Совет: если в акт и в накладную нужны разные названия — заведи «Товар» и «Работу» двумя строками._',
                    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
                return;
            }
            if (kind === 'type') { // pitem_type_{тип}_{pid}
                sess.itemDraft.projectId = projectId;
                sess.itemDraft.type = value;
                sess.itemDraft.unit = 'шт.';
                sess.itemDraft.price = null;
                sess.itemDraft.qty = null;
                sess.state = STATE.WAITING_ITEM_NAME;
                const hint = value === 'Мат. заказчика'
                    ? '🧱 Материал заказчика — укажем без цены (в счёт не входит).'
                    : 'Отлично. Теперь название:';
                bot.sendMessage(chatId, `${hint}\n\n📝 *Название позиции:*`, { parse_mode: 'Markdown' });
                return;
            }
            if (kind === 'unit') { // pitem_unit_{ед}_{pid}
                sess.itemDraft.unit = value;
                if (sess.itemDraft.type === 'Мат. заказчика') {
                    sess.state = STATE.WAITING_ITEM_QTY;
                    bot.sendMessage(chatId, '🧮 *Кол-во?* (по умолчанию 1 — нажми /skip)', { parse_mode: 'Markdown' });
                } else {
                    sess.state = STATE.WAITING_ITEM_PRICE;
                    bot.sendMessage(chatId, `💰 *Цена за 1 «${value}»?* (BYN, число)`, { parse_mode: 'Markdown' });
                }
                return;
            }


            // Действия с конкретной позицией: itemId приходит из парсера,
            // projectId — тот же, что прошёл guard владения выше.
            if (kind === 'price' || kind === 'qty') { // правка цены/кол-ва существующей
                if (!Number.isInteger(itemId) || !Number.isInteger(projectId)) return;
                sess.itemDraft.itemId = itemId;
                sess.itemDraft.projectId = projectId;
                sess.itemDraft.editField = kind;
                sess.state = STATE.WAITING_ITEM_EDIT;
                bot.sendMessage(chatId, kind === 'price' ? '💰 *Новая цена за единицу?* (BYN, число)' : '🧮 *Новое кол-во?* (число)', { parse_mode: 'Markdown' });
                return;
            }
            if (kind === 'del_yes') { // подтверждённое удаление
                if (!Number.isInteger(itemId) || !Number.isInteger(projectId)) return;
                try {
                    await noco.deleteRow(config.TABLES.ITEMS, itemId);
                    noco.invalidateTable(config.TABLES.ITEMS);
                    bot.sendMessage(chatId, '🗑 Позиция удалена.');
                    await sendProjectItemsList(chatId, null, projectId);
                } catch (err) { bot.sendMessage(chatId, `❌ Ошибка удаления: ${err.message}`); }
                return;
            }
            if (kind === 'del') { // подтверждение удаления
                if (!Number.isInteger(itemId) || !Number.isInteger(projectId)) return;
                const kb = [[
                    { text: '✅ Да, удалить', callback_data: `pitem_del_yes_${itemId}_${projectId}` },
                    { text: '❌ Нет', callback_data: `proj_items_${projectId}` }
                ]];
                bot.sendMessage(chatId, '🗑 *Удалить позицию?*\n\n_Если документ уже сформирован или отправлен клиенту — удаление изменит его содержимое._', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
                return;
            }
            if (kind === 'view' && Number.isInteger(itemId) && Number.isInteger(projectId)) { // карточка позиции
                await sendProjectItemDetails(chatId, msg.message_id, itemId, projectId);
                return;
            }
            try { await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Неизвестное действие' }); } catch (e) { /* ignore */ }
            return;
        }


        // ================== ДОКУМЕНТЫ ПРОЕКТА (v4.42.2, Волна A) ==================
        // Создание документа (черновик) — право роли Менеджер+; владение проектом
        // проверяем как у pcard_/proj_items_. «Выстрел наружу» (отправка) — Шаг 4.
        if (data.startsWith('docs_')) {
            const D = data.split('_'); // D[0]==='docs'
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            // projectId — последний сегмент для форм с {pid} в конце; у docs_cancel — из черновика
            const isGlobal = data === 'docs_cancel';
            const projectId = isGlobal ? (sess.docDraft && sess.docDraft.projectId) : parseInt(D[D.length - 1], 10);
            if (!Number.isInteger(projectId)) {
                try { await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Сессия устарела — открой проект заново' }); } catch (e) { /* ignore */ }
                return;
            }
            if (role === ROLES.EXECUTOR) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к проектам' }); return; }
            if (role === ROLES.MANAGER) {
                try {
                    const project = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                    if (extractLinkId(project['Менеджер']) !== emp?.Id) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только свои проекты' }); return; }
                } catch (err) { bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Проект не найден' }); return; }
            }
            bot.answerCallbackQuery(callbackQuery.id);

            if (data === 'docs_cancel') { resetState(chatId); bot.sendMessage(chatId, '❌ Отменено.'); return; }

            const kind = D[1];
            // «Выстрел наружу» (email/вручную) — только с флагом canSendDocuments.
            // Центральный guard в диспетчере уже отсекает, здесь — для бизнес-текста.
            const canSendDocs = roles.canSendDocuments(emp);
            if (kind === 'list') { // список документов
                await sendProjectDocsList(chatId, msg.message_id, projectId);
                return;
            }
            if (kind === 'new') { // выбор типа
                sess.docDraft.projectId = projectId;
                sess.docDraft.type = null;
                sess.docDraft.stamp = true;
                sess.docDraft.note = '';
                sess.state = STATE.IDLE;
                const kb = docTypeKeyboard(projectId);
                kb.push([{ text: '❌ Отмена', callback_data: 'docs_cancel' }]);
                bot.sendMessage(chatId, '📄 *Какой документ создать?*\n\n🧾 Счёт — для оплаты (B2B или физлицо)\n📝 Акт — выполненные работы\n📦 Накладная — товар (печать в офисе и подписи)\n\n_Документ соберётся из позиций проекта._', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
                return;
            }
            if (kind === 'type') { // docs_type_{тип}_{pid}
                sess.docDraft.projectId = projectId;
                sess.docDraft.type = D.slice(2, -1).join('_');
                sess.docDraft.stamp = true;
                sess.docDraft.note = '';
                sendDocCreateConfirm(chatId, projectId);
                return;
            }


            if (kind === 'stamp') { // переключение «С печатью»
                sess.docDraft.projectId = projectId;
                sess.docDraft.stamp = !sess.docDraft.stamp;
                sendDocCreateConfirm(chatId, projectId);
                return;
            }
            if (kind === 'note') { // примечание к документу
                sess.docDraft.projectId = projectId;
                sess.state = STATE.WAITING_DOC_NOTE;
                bot.sendMessage(chatId, '📌 *Примечание к документу?*\n\nОно попадёт в документ (внизу). /skip — без примечания.', { parse_mode: 'Markdown' });
                return;
            }
            if (kind === 'create') { // создать запись и сформировать PDF
                const d = sess.docDraft || {};
                if (!d.type) { bot.sendMessage(chatId, '❌ Тип документа не выбран — начни заново.'); resetState(chatId); return; }
                try {
                    const payload = {
                        'Тип документа': d.type,
                        'Проект': [{ Id: projectId }],
                        'Дата документа': todayNocoDate(),
                        'С печатью': d.stamp ? true : false
                    };
                    if (d.note) payload['Примечания'] = d.note;
                    const created = await noco.createRow(config.TABLES.DOCUMENTS, payload);
                    noco.invalidateTable(config.TABLES.DOCUMENTS);
                    const docId = created && created.Id;
                    resetState(chatId);
                    if (!docId) { bot.sendMessage(chatId, '❌ Документ создан, но не получен его ID.'); return; }
                    bot.sendMessage(chatId, `📄 Документ №${docId} создан (${d.type}). Формирую PDF…`);
                    await generateDocPdfAndSend(chatId, docId);
                    await sendProjectDocsList(chatId, null, projectId);
                } catch (err) { bot.sendMessage(chatId, `❌ Не удалось создать документ: ${err.message}`); resetState(chatId); }
                return;
            }
            if (kind === 'card') { // карточка документа docs_card_{docId}_{pid}
                const docId = parseInt(D[2], 10);
                if (!Number.isInteger(docId)) return;
                await sendDocCard(chatId, msg.message_id, docId, projectId, canSendDocs);
                return;
            }
            if (kind === 'pdf') { // сформировать/получить PDF docs_pdf_{docId}_{pid}
                const docId = parseInt(D[2], 10);
                if (!Number.isInteger(docId)) return;
                await generateDocPdfAndSend(chatId, docId);
                return;
            }
            // ───────────── Отправка «наружу» (v4.42.3, только с флагом) ─────────────
            // v4.42.5: email идёт через ПРЕДПРОСМОТР. Все колбэки начинаются с
            // docs_send_ (guard по флагу в диспетчере работает для всех):
            //   docs_send_{docId}_{pid}         — показать предпросмотр
            //   docs_send_yes_{docId}_{pid}     — ✅ подтвердить отправку
            //   docs_send_no_{docId}_{pid}      — ❌ отмена
            //   docs_send_to_{i}_{docId}_{pid}  — сменить получателя (кандидат №i)
            const sendSub = /^\d+$/.test(D[2] || '') ? 'new' : (D[2] || '');
            if (kind === 'send' && sendSub === 'new') { // запрос предпросмотра
                if (!canSendDocs) { bot.sendMessage(chatId, '⛔ У вас нет права «Отправка документов». Попросите Руководителя поставить галочку в NocoDB.'); return; }
                const docId = parseInt(D[2], 10);
                if (!Number.isInteger(docId)) return;
                const sMsg = await bot.sendMessage(chatId, '⏳ Загружаю предпросмотр письма…');
                try {
                    const secret = process.env.WEBHOOK_SECRET || '';
                    const resp = await axios.post(`http://localhost:3000/api/preview-doc?secret=${secret}`, { docId }, { timeout: 60000, validateStatus: () => true });
                    const data = resp.data;
                    if (!data || !data.success || !Array.isArray(data.candidates) || data.candidates.length === 0) {
                        const errMsg = (data && data.error) || 'У документа нет получателя с E-mail';
                        await bot.editMessageText(`❌ ${errMsg}`, { chat_id: chatId, message_id: sMsg.message_id }).catch(() => {});
                        await sendDocCard(chatId, msg.message_id, docId, projectId, canSendDocs);
                        return;
                    }
                    sess.emailDraft = {
                        docId, projectId,
                        cardMessageId: msg.message_id, // сообщение карточки — сюда вернёмся после отправки/отмены
                        docType: data.docType, docNumber: data.docNumber, formattedDate: data.formattedDate,
                        signed: data.signed === true, pdfFileName: data.pdfFileName || '',
                        candidates: data.candidates.map(c => ({ kind: c.kind, name: c.name, email: c.email, subject: c.subject, text: c.text })),
                        selected: Number.isInteger(data.selected) ? data.selected : 0
                    };
                    await renderEmailPreview(chatId, sMsg.message_id, sess.emailDraft);
                } catch (err) {
                    await bot.editMessageText(`❌ Не удалось собрать предпросмотр: ${err.message}`, { chat_id: chatId, message_id: sMsg.message_id }).catch(() => {});
                    await sendDocCard(chatId, msg.message_id, docId, projectId, canSendDocs);
                }
                return;
            }
            if (kind === 'send' && sendSub === 'yes') { // ✅ подтверждение: отправить
                if (!canSendDocs) { bot.sendMessage(chatId, '⛔ У вас нет права «Отправка документов».'); return; }
                const docId = parseInt(D[3], 10);
                if (!Number.isInteger(docId)) return;
                const draft = sess.emailDraft;
                if (!draft || draft.docId !== docId || draft.projectId !== projectId) {
                    bot.sendMessage(chatId, '⏳ Предпросмотр устарел — открой карточку документа и нажми «📧 Отправить по email» ещё раз.').catch(() => {});
                    await sendDocCard(chatId, msg.message_id, docId, projectId, canSendDocs);
                    return;
                }
                const sel = draft.candidates[draft.selected];
                if (!sel || !sel.email) {
                    bot.sendMessage(chatId, '⏳ Предпросмотр устарел — открой карточку документа и нажми «📧 Отправить по email» ещё раз.').catch(() => {});
                    await sendDocCard(chatId, msg.message_id, docId, projectId, canSendDocs);
                    return;
                }
                const cardMessageId = draft.cardMessageId || msg.message_id;
                // v4.43.1 (гонка двойного тапа): пока письмо уходит, повторный клик по
                // «✅ Отправить» отклоняем — иначе клиенту уйдёт второе одинаковое письмо.
                // Флаг живёт в сессии (emailSending), снимается в finally. Вторая линия —
                // сам /api/send-doc не шлёт повторно (статус «Отправлен» + Set в server.js).
                if (sess.emailSending) {
                    try { await bot.answerCallbackQuery(callbackQuery.id, { text: '⏳ Письмо уже отправляется…' }); } catch (e) { /* ignore */ }
                    return;
                }
                sess.emailSending = true;
                try {
                    await bot.editMessageText('📧 Отправляю документ клиенту…', { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
                    try {
                        const secret = process.env.WEBHOOK_SECRET || '';
                        const resp = await axios.post(`http://localhost:3000/api/send-doc?secret=${secret}`, { docId, toEmail: sel.email }, { timeout: 90000, validateStatus: () => true });
                        const data = resp.data;
                        if (data && data.success) {
                            await bot.editMessageText(`✅ Документ отправлен по email: *${escapeMarkdown(data.toEmail || sel.email)}*`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown' }).catch(() => {});
                        } else {
                            await bot.editMessageText(`❌ ${(data && data.error) || 'Ошибка отправки'}`, { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
                        }
                    } catch (err) {
                        await bot.editMessageText(`❌ Не удалось отправить: ${err.message}`, { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
                    }
                    sess.emailDraft = null;
                    noco.invalidateTable(config.TABLES.DOCUMENTS);
                    await sendDocCard(chatId, cardMessageId, docId, projectId, canSendDocs);
                } finally {
                    sess.emailSending = false;
                }
                return;
            }
            if (kind === 'send' && sendSub === 'no') { // ❌ отмена
                const docId = parseInt(D[3], 10);
                if (!Number.isInteger(docId)) return;
                const cardMessageId = (sess.emailDraft && sess.emailDraft.cardMessageId) || msg.message_id;
                sess.emailDraft = null;
                try { await bot.editMessageText('❌ Отправка отменена.', { chat_id: chatId, message_id: msg.message_id }).catch(() => {}); } catch (e) { /* ignore */ }
                await sendDocCard(chatId, cardMessageId, docId, projectId, canSendDocs);
                return;
            }
            if (kind === 'send' && sendSub === 'to') { // смена получателя — перерисовка предпросмотра
                const idx = parseInt(D[3], 10);
                const docId = parseInt(D[4], 10);
                if (!Number.isInteger(idx) || !Number.isInteger(docId)) return;
                const draft = sess.emailDraft;
                if (!draft || draft.docId !== docId || draft.projectId !== projectId || !draft.candidates[idx]) {
                    await sendDocCard(chatId, msg.message_id, docId, projectId, canSendDocs);
                    return;
                }
                draft.selected = idx;
                await renderEmailPreview(chatId, msg.message_id, draft);
                return;
            }
            if (kind === 'manual' && D[2] === 'yes') { // подтверждённая ручная передача
                if (!canSendDocs) { bot.sendMessage(chatId, '⛔ У вас нет права «Отправка документов».'); return; }
                const docId = parseInt(D[3], 10);
                if (!Number.isInteger(docId)) return;
                try {
                    const doc = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.DOCUMENTS}/${docId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                    await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.DOCUMENTS}/${docId}`, { 'Статус': 'Отправлен', 'Дата отправки': new Date().toISOString() }, { headers: { 'xc-token': config.NOCO_TOKEN, 'Content-Type': 'application/json' } });
                    // Аудит в «Подробности» проекта: кто, когда, канал
                    const projRes = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
                    const oldDetails = String(projRes.data['Подробности'] || '').trim();
                    const empName = emp?.Имя || 'Сотрудник';
                    const dateStr = formatMinskDate(new Date().toISOString());
                    const logEntry = `📤 ${doc['Тип документа'] || 'Документ'} №${docId} передан вручную (${empName}, ${dateStr})`;
                    const newDetails = oldDetails ? `${oldDetails}\n\n${logEntry}` : logEntry;
                    await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Подробности': newDetails }, { headers: { 'xc-token': config.NOCO_TOKEN, 'Content-Type': 'application/json' } });
                    noco.invalidateTable(config.TABLES.DOCUMENTS);
                    noco.invalidateTable(config.TABLES.PROJECTS);
                    bot.sendMessage(chatId, `✅ Документ №${docId} отмечен отправленным вручную.`);
                } catch (err) { bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`); }
                await sendDocCard(chatId, msg.message_id, docId, projectId, canSendDocs);
                return;
            }
            if (kind === 'manual') { // подтверждение ручной передачи
                if (!canSendDocs) { bot.sendMessage(chatId, '⛔ У вас нет права «Отправка документов». Попросите Руководителя поставить галочку в NocoDB.'); return; }
                const docId = parseInt(D[2], 10);
                if (!Number.isInteger(docId)) return;
                const kb = [[
                    { text: '✅ Да, передан вручную', callback_data: `docs_manual_yes_${docId}_${projectId}` },
                    { text: '❌ Нет', callback_data: `docs_list_${projectId}` }
                ]];
                bot.sendMessage(chatId, '📤 *Отметить документ как переданный вручную?*\n\n_Для мессенджеров (Telegram/WhatsApp), передачи на руки или почты. Статус станет «Отправлен», в «Подробности» проекта появится запись._', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
                return;
            }
            try { await bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Неизвестное действие' }); } catch (e) { /* ignore */ }
            return;
        }


        // ================== ОПЛАТЫ (v4.42.4, Волна A) ==================
        // «💵 Оплаты» в карточке проекта. Внесение оплаты — «выстрел наружу»,
        // центральный guard по флагу (pay_ в DOC_SEND_ONLY_PREFIXES).
        if (data.startsWith('pay_')) {
            const D = data.split('_'); // pay_{pid} | pay_add_{pid}
            const projectId = parseInt(D[D.length - 1], 10);
            if (!Number.isInteger(projectId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            if (role === ROLES.EXECUTOR) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к проектам' }); return; }
            if (role === ROLES.MANAGER) {
                try {
                    const project = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                    if (extractLinkId(project['Менеджер']) !== emp?.Id) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только свои проекты' }); return; }
                } catch (err) { bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Проект не найден' }); return; }
            }
            bot.answerCallbackQuery(callbackQuery.id);
            if (D[1] === 'add') { // ввод суммы
                sess.payDraft.projectId = projectId;
                sess.state = STATE.WAITING_PAYMENT_AMOUNT;
                bot.sendMessage(chatId, '💵 *Сколько поступило?* (BYN, число)\n\n_Сумма добавится к «Получено», статус «По деньгам?» обновится автоматически._', { parse_mode: 'Markdown' });
                return;
            }
            await sendPaymentMenu(chatId, msg.message_id, projectId);
            return;
        }


        // ================== ПЕРЕДАЧА ПРОЕКТА (v4.18.0) ==================
        if (data.startsWith('ptransfer_set_')) {
            const parts = data.split('_'); // ['ptransfer','set',projectId,empId]
            const projectId = parseInt(parts[2]);
            const newEmpId = parseInt(parts[3]);
            if (!Number.isInteger(projectId) || !Number.isInteger(newEmpId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            if (emp?.Роль !== ROLES.ADMIN) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Передавать может только Руководитель' }); return; }
            try {
                // v4.21.5: старого менеджера узнаём ДО передачи (после — в проекте уже новый)
                const oldProj = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                const oldMgrNocoId = extractLinkId(oldProj['Менеджер']);

                const result = await transferProject(projectId, newEmpId);
                if (!result || result.success !== true) {
                    bot.answerCallbackQuery(callbackQuery.id, { text: `❌ ${result?.error || 'Ошибка передачи'}` });
                    return;
                }
                noco.invalidateTable(config.TABLES.PROJECTS); // проект сменил менеджера — списки обоих менеджеров
                noco.invalidateTable(config.TABLES.CONTACTS); // клиент «переехал» к новому менеджеру
                const proj = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                const oldDetails = String(proj['Подробности'] || '').trim();
                const newName = Array.from(employeesCache.values()).find(e => e.Id === newEmpId)?.Имя || 'Сотрудник';
                const dateStr = formatMinskDate(new Date().toISOString());
                const logEntry = `👥 Менеджер передан: → ${newName} (${emp?.Имя || 'Руководитель'}, ${dateStr})`;
                const newDetails = oldDetails ? `${oldDetails}\n\n${logEntry}` : logEntry;
                await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Подробности': newDetails }, { headers: { 'xc-token': config.NOCO_TOKEN } });

                // v4.21.5: уведомляем старого менеджера, что проект (и клиент) передан
                if (oldMgrNocoId && oldMgrNocoId !== emp?.Id) {
                    const oldMgrTgId = Array.from(employeesCache.entries()).find(([tid, e]) => e.Id === oldMgrNocoId)?.[0] || null;
                    if (oldMgrTgId) {
                        bot.sendMessage(Number(oldMgrTgId),
                            `📤 *Проект передан:*\n\n🔹 *${escapeMarkdown(proj['Что делаем?'] || 'Без названия')}* (#${projectId})\n👤 Теперь ведёт: *${escapeMarkdown(newName)}*\n\nКлиент проекта теперь виден новому менеджеру.`,
                            { parse_mode: 'Markdown' }).catch(() => {});
                    }
                }

                bot.answerCallbackQuery(callbackQuery.id, { text: `✅ Проект передан: ${newName}` });
                await sendProjectDetails(chatId, msg.message_id, projectId, emp.Роль, cbTelegramId);
            } catch (err) {
                bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка передачи' });
                console.error('Ошибка передачи проекта:', err.message);
            }
            return;
        }
        if (data.startsWith('ptransfer_')) {
            const projectId = parseInt(data.split('_')[1]);
            if (!Number.isInteger(projectId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            bot.answerCallbackQuery(callbackQuery.id);
            await sendTransferMenu(chatId, msg.message_id, projectId, emp ? emp.Роль : ROLES.EXECUTOR);
            return;
        }


        // ================== АРХИВ ПРОЕКТОВ (v4.18.0) ==================
        if (data === 'arch_back') {
            bot.answerCallbackQuery(callbackQuery.id);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            await sendArchivedProjects(chatId, cbTelegramId, emp ? emp.Роль : ROLES.EXECUTOR, msg.message_id, getListPage(cbTelegramId, 'al'));
            return;
        }
        if (data.startsWith('arch_card_')) {
            const projectId = parseInt(data.split('_')[2]);
            if (!Number.isInteger(projectId)) return;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            if (role === ROLES.EXECUTOR) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ У вас нет доступа к проектам' }); return; }
            if (role === ROLES.MANAGER) {
                const project = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                if (extractLinkId(project['Менеджер']) !== emp?.Id) { bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Только свои проекты' }); return; }
            }
            bot.answerCallbackQuery(callbackQuery.id);
            await sendProjectDetails(chatId, msg.message_id, projectId, role, cbTelegramId, 'arch_back');
            return;
        }

        if (data.startsWith('done_')) {
            const taskId = parseInt(data.split('_')[1]);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;

            // Проверяем права на закрытие
            if (role === ROLES.EXECUTOR) {
                // Исполнитель может закрыть только свою задачу
                const task = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                if (task['Исполнитель']?.Id !== emp.Id) {
                    bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Вы можете закрыть только свою задачу' });
                    return;
                }
            } else if (role === ROLES.MANAGER) {
                // Менеджер может закрыть свою задачу или задачу своего проекта
                const task = (await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { headers: { 'xc-token': config.NOCO_TOKEN } })).data;
                const isOwn = task['Исполнитель']?.Id === emp.Id;
                const isOwnProject = task['Какой проект']?.['Менеджер']?.Id === emp.Id;
                if (!isOwn && !isOwnProject) {
                    bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Вы можете закрыть только свою задачу или задачу своего проекта' });
                    return;
                }
            }
            // Руководитель может закрыть любую задачу (без проверки)

            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}/${taskId}`, { 'Готово': true }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            invalidateTaskListCache(); // v4.43.1: задача закрыта — список, который перерисуем ниже, будет свежим
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Задача закрыта!' });
            // v4.36.1: действия — только в карточке; после закрытия возврат во «Все задачи»
            await sendTaskList(chatId, msg.message_id, cbTelegramId, role, getListPage(cbTelegramId, 'tl'));
            return;
        }
        if (data === 'refresh_tasks') {
            bot.answerCallbackQuery(callbackQuery.id);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            await sendTaskList(chatId, msg.message_id, cbTelegramId, emp ? emp.Роль : ROLES.EXECUTOR, getListPage(cbTelegramId, 'tl'));
            return;
        }

        // ================== UI-ПАГИНАЦИЯ СПИСКОВ (v4.22.0) ==================
        if (data === 'noop') {
            // Информационная кнопка-счётчик «📄 2/5» — просто гасим пульс.
            bot.answerCallbackQuery(callbackQuery.id);
            return;
        }
        const pageNavMatch = data.match(/^(tl|td|hl|cl|pl|ll|al)_(\d+)$/);
        if (pageNavMatch) {
            bot.answerCallbackQuery(callbackQuery.id);
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            const prefix = pageNavMatch[1];
            const page = parseInt(pageNavMatch[2]) || 0;
            setListPage(cbTelegramId, prefix, page);
            if (prefix === 'tl') await sendTaskList(chatId, msg.message_id, cbTelegramId, role, page);
            else if (prefix === 'td') await sendTodayTasks(chatId, cbTelegramId, role, msg.message_id, page);
            else if (prefix === 'hl') await sendTaskHistory(chatId, cbTelegramId, role, msg.message_id, page);
            else if (prefix === 'cl') await sendContactsList(chatId, cbTelegramId, role, msg.message_id, page);
            else if (prefix === 'pl') await sendProjectsList(chatId, cbTelegramId, role, msg.message_id, page);
            else if (prefix === 'll') await sendLegalList(chatId, cbTelegramId, role, msg.message_id, page);
            else if (prefix === 'al') await sendArchivedProjects(chatId, cbTelegramId, role, msg.message_id, page);
            return;
        }
        const projTasksNavMatch = data.match(/^ptl_(\d+)_(\d+)$/);
        if (projTasksNavMatch) {
            bot.answerCallbackQuery(callbackQuery.id);
            const projectId = parseInt(projTasksNavMatch[1]) || 0;
            const page = parseInt(projTasksNavMatch[2]) || 0;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            setListPage(cbTelegramId, `ptasks:${projectId}`, page);
            await sendProjectTasksList(chatId, msg.message_id, projectId, role, cbTelegramId, page);
            return;
        }
        // v4.45.0: листание селектора «выбор проекта» в визарде задачи.
        // State визарда НЕ сбрасываем (taskDraft живёт в сессии) — перерисовка
        // того же сообщения (editMessageText), без спама новыми.
        const projSelNavMatch = data.match(/^ptj_(\d+)$/);
        if (projSelNavMatch) {
            bot.answerCallbackQuery(callbackQuery.id);
            const page = parseInt(projSelNavMatch[1]) || 0;
            const cbTelegramId = callbackQuery.from?.id;
            const emp = cbTelegramId ? getEmployee(cbTelegramId) : null;
            const role = emp ? emp.Роль : ROLES.EXECUTOR;
            setListPage(cbTelegramId, 'ptj', page);
            if (sess.state !== STATE.WAITING_PROJECT) sess.state = STATE.WAITING_PROJECT;
            await showProjectSelectionForTask(chatId, cbTelegramId, role, page, msg.message_id);
            return;
        }
        if (data === 'start_new_task') {
            bot.answerCallbackQuery(callbackQuery.id); resetState(chatId); sess.state = STATE.WAITING_TITLE;
            bot.sendMessage(chatId, '📝 *Что нужно сделать?*', { parse_mode: 'Markdown' }); return;
        }

        if (data.startsWith('task_exec_')) {
            const executorTgId = data.replace('task_exec_', '');
            const emp = executorTgId !== 'none' ? employeesCache.get(Number(executorTgId)) : null;
            const creator = getEmployee(callbackQuery.from?.id);

            const payload = { 'Что делаем?': sess.taskDraft.title, 'Готово': false };
            if (sess.taskDraft.deadline) payload['Когда делаем'] = sess.taskDraft.deadline.toISOString();
            if (sess.taskDraft.projectId) payload['Какой проект'] = [{ Id: sess.taskDraft.projectId }];

            // Если Менеджер выбирает Руководителя → создаём как предложение
            if (creator && creator.Роль === ROLES.MANAGER && emp && emp.Роль === ROLES.ADMIN) {
                payload['Кто предложил'] = [{ Id: creator.Id }];
                // Исполнитель НЕ назначается — Руководитель сам решит

                const res = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
                invalidateTaskListCache(); // v4.43.1: задача создана — «Все задачи»/«Мои заявки» обновятся

                bot.answerCallbackQuery(callbackQuery.id, { text: `✅ Предложение отправлено Руководителю` });
                bot.sendMessage(chatId, `✅ Предложение задачи создано! #${res.data.Id}\n\nРуководитель увидит и решит.`, { parse_mode: 'Markdown' });

                // Уведомить Руководителя
                for (const [tgId, e] of employeesCache.entries()) {
                    if (e.Роль === ROLES.ADMIN) {
                        const inlineKeyboard = [
                            [{ text: '✅ Назначить исполнителя', callback_data: `assign_exec_${res.data.Id}` }],
                            [{ text: '📋 Оставить общей', callback_data: `keep_common_${res.data.Id}` }],
                            [{ text: '❌ Отклонить', callback_data: `reject_task_${res.data.Id}` }]
                        ];
                        bot.sendMessage(Number(tgId), `📨 *Предложение от ${creator.Обращение}*\n\n📝 ${sess.taskDraft.title}\n🆔 Задача #${res.data.Id}`, {
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: inlineKeyboard }
                        }).catch(() => {});
                    }
                }
            } else {
                // Обычное назначение
                if (emp) payload['Исполнитель'] = emp.Id;

                const res = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
                invalidateTaskListCache(); // v4.43.1: задача создана — списки задач обновятся

                bot.answerCallbackQuery(callbackQuery.id, { text: `✅ ${emp ? emp.Обращение + ' назначен' : 'Задача создана'}` });
                let confirmText = `✅ Задача создана!\n📝 *${sess.taskDraft.title}*\n📅 ${sess.taskDraft.deadline ? formatMinskDate(sess.taskDraft.deadline) : 'Без срока'}\n🆔 ID: ${res.data.Id}`;
                if (emp) confirmText += `\n👤 Исполнитель: *${emp.Обращение}*`;
                bot.sendMessage(chatId, confirmText, { parse_mode: 'Markdown' });

                // Уведомление исполнителю НЕ шлём здесь — его пришлёт loadAllowedUsers()
                // при следующем обновлении кэша (≤1 мин) с защитой от дублей (Проблема 81).
            }

            resetState(chatId);
            return;
        }
        if (data === 'task_exec_none') {
            const payload = { 'Что делаем?': sess.taskDraft.title, 'Готово': false };
            if (sess.taskDraft.deadline) payload['Когда делаем'] = sess.taskDraft.deadline.toISOString();
            if (sess.taskDraft.projectId) payload['Какой проект'] = [{ Id: sess.taskDraft.projectId }];

            const res = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
            invalidateTaskListCache(); // v4.43.1: задача создана — списки задач обновятся
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Задача создана!' });
            bot.sendMessage(chatId, `✅ Задача создана!\n📝 *${sess.taskDraft.title}*\n📅 ${sess.taskDraft.deadline ? formatMinskDate(sess.taskDraft.deadline) : 'Без срока'}\n🆔 ID: ${res.data.Id}`, { parse_mode: 'Markdown' });
            resetState(chatId);
            return;
        }

        if (data.startsWith('project_')) {
            const projectId = parseInt(data.split('_')[1]);
            sess.taskDraft.projectId = projectId;

            // Для Руководителя и Менеджера — предлагаем выбрать исполнителя
            const emp = getEmployee(callbackQuery.from?.id);
            if (emp && (emp.Роль === ROLES.ADMIN || emp.Роль === ROLES.MANAGER)) {
                bot.answerCallbackQuery(callbackQuery.id);
                const allEmployees = Array.from(employeesCache.entries());
                const inlineKeyboard = allEmployees.map(([tid, e]) =>
                    [{ text: `👤 ${e.Обращение} (${e.Роль})`, callback_data: `task_exec_${tid}` }]
                );
                inlineKeyboard.push([{ text: '⏭️ Без исполнителя', callback_data: 'task_exec_none' }]);
                bot.sendMessage(chatId, `👥 *Назначить исполнителя?*`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: inlineKeyboard }
                });
                sess.state = STATE.WAITING_EXECUTOR;
            } else {
                // Исполнитель — сразу создаём задачу
                const payload = { 'Что делаем?': sess.taskDraft.title, 'Готово': false };
                if (sess.taskDraft.deadline) payload['Когда делаем'] = sess.taskDraft.deadline.toISOString();
                if (projectId) payload['Какой проект'] = [{ Id: projectId }];
                const res = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
                invalidateTaskListCache(); // v4.43.1: задача создана — списки задач обновятся
                bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Задача создана!' });
                bot.sendMessage(chatId, `✅ Задача создана!\n📝 *${sess.taskDraft.title}*\n📅 ${sess.taskDraft.deadline ? formatMinskDate(sess.taskDraft.deadline) : 'Без срока'}\n🆔 ID: ${res.data.Id}`, { parse_mode: 'Markdown' });
                resetState(chatId);
            }
            return;
        }
        if (data === 'project_none') {
            sess.taskDraft.projectId = null;

            const emp = getEmployee(callbackQuery.from?.id);
            if (emp && (emp.Роль === ROLES.ADMIN || emp.Роль === ROLES.MANAGER)) {
                bot.answerCallbackQuery(callbackQuery.id);
                const allEmployees = Array.from(employeesCache.entries());
                const inlineKeyboard = allEmployees.map(([tid, e]) =>
                    [{ text: `👤 ${e.Обращение} (${e.Роль})`, callback_data: `task_exec_${tid}` }]
                );
                inlineKeyboard.push([{ text: '⏭️ Без исполнителя', callback_data: 'task_exec_none' }]);
                bot.sendMessage(chatId, `👥 *Назначить исполнителя?*`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: inlineKeyboard }
                });
                sess.state = STATE.WAITING_EXECUTOR;
            } else {
                const payload = { 'Что делаем?': sess.taskDraft.title, 'Готово': false };
                if (sess.taskDraft.deadline) payload['Когда делаем'] = sess.taskDraft.deadline.toISOString();
                const res = await axios.post(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.TASKS}`, payload, { headers: { 'xc-token': config.NOCO_TOKEN } });
                invalidateTaskListCache(); // v4.43.1: задача создана — списки задач обновятся
                bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Задача создана!' });
                bot.sendMessage(chatId, `✅ Задача создана!\n📝 *${sess.taskDraft.title}*\n📅 ${sess.taskDraft.deadline ? formatMinskDate(sess.taskDraft.deadline) : 'Без срока'}\n🆔 ID: ${res.data.Id}`, { parse_mode: 'Markdown' });
                resetState(chatId);
            }
            return;
        }
        if (data === 'create_new_project_for_task') {
            bot.answerCallbackQuery(callbackQuery.id);
            // v4.25.0: единый визард — теперь с выбором клиента, после создания продолжаем флоу задачи
            startProjectWizard(chatId, callbackQuery.from?.id, { source: 'task' });
            return;
        }

        if (data === 'show_contacts') {
            bot.answerCallbackQuery(callbackQuery.id);
            const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}?limit=30`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            let message = `📇 *Контакты (${res.data.list.length})*\n\n`;
            if (res.data.list.length === 0) message += '📭 Пусто.';
            else res.data.list.forEach(c => { 
                const link = c['Ссылка'] ? `\n 🔗 ${escapeMarkdown(c['Ссылка'])}` : '';
                message += `👤 *${escapeMarkdown(c['Имя'])}*\n 📱 ${escapeMarkdown(c['Телефон'] || 'нет')}${link}\n\n`; 
            });
            try {
                await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
            } catch (e) {
                console.error('❌ Отправка списка контактов (callback):', e.message);
                await bot.sendMessage(chatId, plainTextFromMarkdown(message), {});
            }
            return;
        }
        if (data === 'show_projects') {
            bot.answerCallbackQuery(callbackQuery.id);
            const res = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}?limit=30`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const active = res.data.list.filter(p => p['Активно'] === 'Активно');
            let message = `🚀 *Активные проекты (${active.length})*\n\n`;
            if (active.length === 0) message += '📭 Пусто.';
            else active.forEach(p => { message += `🔹 *${escapeMarkdown(p['Что делаем?'])}*\n 📊 Статус: ${p['Статус']}\n🆔 ID: ${p.Id}\n\n`; });
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }); return;
        }
        if (data === 'create_new_project_from_menu') {
            bot.answerCallbackQuery(callbackQuery.id);
            const cbTelegramId = callbackQuery.from?.id;
            startProjectWizard(chatId, cbTelegramId);
            return;
        }
        if (data === 'add_contact_from_menu') { bot.answerCallbackQuery(callbackQuery.id); startContactWizard(chatId); return; }

        if (data === 'proj_new_for_contact') {
            bot.answerCallbackQuery(callbackQuery.id);
            // v4.25.0: единый визард — контакт уже известен, шаг выбора клиента пропускается
            startProjectWizard(chatId, callbackQuery.from?.id, { source: 'contact', contactId: sess.pendingContactAction.contactId });
            return;
        }
        if (data === 'proj_none_contact') {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Ок' });
            bot.sendMessage(chatId, `✅ Готово! Контакт создан без привязки к проекту.`);
            resetState(chatId); return;
        }

        if (data === 'append_to_project') {
            bot.answerCallbackQuery(callbackQuery.id);
            const contactId = sess.pendingContactAction.contactId;
            const messageText = sess.pendingContactAction.forwardedData.messageText;
            const timestamp = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });
            const newEntry = messageText ? `[${timestamp}] Сообщение от клиента:\n💬 "${messageText}"` : `[${timestamp}] Переслано сообщение (без текста)`;

            const allProjects = await fetchAllRows(config.TABLES.PROJECTS);
            const linkedProjects = allProjects.filter(p => {
                const contactField = p['Контакт'];
                if (!contactField) return false;
                if (Array.isArray(contactField)) {
                    return contactField.some(c => c.Id === contactId);
                } else if (typeof contactField === 'object') {
                    return contactField.Id === contactId;
                } else if (typeof contactField === 'number' || typeof contactField === 'string') {
                    return contactField == contactId;
                }
                return false;
            });

            if (linkedProjects.length === 1) {
                const proj = linkedProjects[0];
                const oldExtra = String(proj['Подробности'] || '').trim();
                const finalExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
                await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${proj.Id}`, { 'Подробности': finalExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
                bot.sendMessage(chatId, `✅ Текст добавлен в проект "${escapeMarkdown(proj['Что делаем?'])}"`, { parse_mode: 'Markdown' });
                resetState(chatId);
            } else if (linkedProjects.length > 1) {
                let text = `У контакта ${linkedProjects.length} активных проекта. Куда добавить?\n`;
                const inlineKeyboard = linkedProjects.map(p => [{ text: `📂 ${escapeMarkdown(p['Что делаем?'])}`, callback_data: `append_to_proj_${p.Id}` }]);
                inlineKeyboard.push([{ text: '❌ Отмена', callback_data: 'cancel_msg_append' }]);
                sess.pendingContactAction.tempMessageEntry = newEntry; 
                await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
            } else {
                const activeProjects = allProjects.filter(p => p['Активно'] === 'Активно');
                if (activeProjects.length === 0) {
                    bot.sendMessage(chatId, `❌ Нет активных проектов. Сначала создайте проект.`, { parse_mode: 'Markdown' });
                    resetState(chatId);
                } else {
                    let text = `У контакта нет активных проектов. Выберите любой проект для добавления:\n`;
                    const inlineKeyboard = activeProjects.map(p => [{ text: `📂 ${escapeMarkdown(p['Что делаем?'])}`, callback_data: `append_to_proj_${p.Id}` }]);
                    sess.pendingContactAction.tempMessageEntry = newEntry;
                    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
                }
            }
            return;
        }

        if (data.startsWith('append_to_proj_')) {
            const projectId = parseInt(data.split('_')[3]);
            const newEntry = sess.pendingContactAction.tempMessageEntry;
            const currentProj = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const oldExtra = String(currentProj.data['Подробности'] || '').trim();
            const finalExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.PROJECTS}/${projectId}`, { 'Подробности': finalExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Добавлено!' });
            bot.sendMessage(chatId, `✅ Текст добавлен в проект "${escapeMarkdown(currentProj.data['Что делаем?'])}"`, { parse_mode: 'Markdown' });
            resetState(chatId);
            return;
        }
        
        if (data === 'append_to_contact') {
            const cId = sess.pendingContactAction.contactId;
            const { contactName, messageText } = sess.pendingContactAction.forwardedData;
            const timestamp = new Date().toLocaleString('ru-RU', { timeZone: config.TZ });
            const current = await axios.get(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${cId}`, { headers: { 'xc-token': config.NOCO_TOKEN } });
            const oldExtra = String(current.data['Доп. информация'] || '').trim();
            const newEntry = messageText ? `[${timestamp}] Пересылка от ${contactName}\n💬 "${messageText}"` : `[${timestamp}] Пересылка от ${contactName}`;
            const newExtra = oldExtra ? `${oldExtra}\n\n${newEntry}` : newEntry;
            await axios.patch(`${config.NOCO_URL}/api/v1/db/data/noco/${config.BASE_ID}/${config.TABLES.CONTACTS}/${cId}`, { 'Доп. информация': newExtra }, { headers: { 'xc-token': config.NOCO_TOKEN } });
            bot.answerCallbackQuery(callbackQuery.id, { text: '✅ Добавлено!' });
            bot.sendMessage(chatId, `✅ Информация добавлена в контакт!`, { parse_mode: 'Markdown' });
            resetState(chatId); return;
        }
        if (data === 'cancel_msg_append') {
            bot.answerCallbackQuery(callbackQuery.id, { text: 'Отменено' });
            bot.sendMessage(chatId, '❌ Отменено.');
            resetState(chatId); return;
        }

    } catch (err) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '❌ Ошибка!' });
        console.error('Callback error:', err.message);
    }
}
// ────────────────────────────── РЕНДЕР ПРЕДПРОСМОТРА ПИСЬМА (v4.42.5) ──────────────────────────────
// Показывает получателя/тему/текст ДО отправки. Если адресатов несколько — под сообщением
// кнопки-«радио» (docs_send_to_{i}_) + «✅ Отправить» / «❌ Отмена». Данные лежат в sess.emailDraft
// (кандидаты приходят с готовыми subject/text от /api/preview-doc — переключение адресата не
// требует повторных запросов к server.js).
function renderEmailPreview(chatId, messageId, draft) {
    const c = (draft.candidates && draft.candidates[draft.selected]) || (draft.candidates && draft.candidates[0]);
    if (!c) return;
    const iconFor = (kind) => (kind === 'legal' ? '🏢' : '👤');
    const btnLabel = (s, max = 26) => {
        const t = String(s || '').replace(/\s+/g, ' ').trim();
        return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
    };

    let text = `📧 *Предпросмотр письма*\n\n`;
    text += `📄 *${escapeMarkdown(draft.docType || 'Документ')}*${draft.docNumber ? ` №${escapeMarkdown(draft.docNumber)}` : ''}${draft.formattedDate ? ` от ${escapeMarkdown(draft.formattedDate)}` : ''}\n`;
    if (draft.signed === false) {
        text += `⚠️ *БЕЗ печати и подписи!* Клиент получит неподписанный документ.\n`;
    }
    text += `\n📨 *Получатель:*\n`;
    if (draft.candidates.length > 1) {
        draft.candidates.forEach((cc, i) => {
            const mark = i === draft.selected ? '✅' : '◻️';
            text += `${mark} ${iconFor(cc.kind)} ${escapeMarkdown(cc.name)} — ${escapeMarkdown(cc.email)}\n`;
        });
        text += `\n_Нажми на получателя под сообщением, чтобы сменить — текст пересоберётся._\n`;
    } else {
        text += `${iconFor(c.kind)} ${escapeMarkdown(c.name)} — ${escapeMarkdown(c.email)}\n`;
    }
    text += `\n📋 *Тема:* ${escapeMarkdown(c.subject)}\n`;
    text += `\n📝 *Текст письма:*\n${escapeMarkdown(c.text)}\n`;
    text += `\n_📎 В письме будет PDF документа._\n`;

    const kb = [];
    if (draft.candidates.length > 1) {
        draft.candidates.forEach((cc, i) => {
            const mark = i === draft.selected ? '✅ ' : '';
            kb.push([{ text: `${mark}${iconFor(cc.kind)} ${btnLabel(cc.name)}`, callback_data: `docs_send_to_${i}_${draft.docId}_${draft.projectId}` }]);
        });
    }
    kb.push([
        { text: '✅ Отправить', callback_data: `docs_send_yes_${draft.docId}_${draft.projectId}` },
        { text: '❌ Отмена', callback_data: `docs_send_no_${draft.docId}_${draft.projectId}` }
    ]);

    if (text.length > 4000) text = `${text.slice(0, 3950)}\n…(письмо обрезано в предпросмотре)`;

    const options = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } };
    const doRender = async () => {
        if (messageId) await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
        else await bot.sendMessage(chatId, text, options);
    };
    doRender().catch((err) => {
        // 400 «message is not modified» — уже показано то же самое (клик по выбранному адресату) — не ошибка.
        const m = String((err && err.message) || '');
        if (!/message is not modified/i.test(m)) {
            const plain = plainTextFromMarkdown(text);
            bot.sendMessage(chatId, plain, { reply_markup: { inline_keyboard: kb } }).catch(() => {});
        }
    });
}

    return { handleCallbackBlockA };
};
