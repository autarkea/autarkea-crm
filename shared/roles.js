// ============================================================================
// shared/roles.js
// ============================================================================
// ЧИСТЫЕ функции ролевой модели — «кто что видит и делает».
// Не зависят от кэша сотрудников, Telegram и сети: принимают сотрудника (emp)
// и возвращают да/нет. Используются ботом (bot/bot.js) и тестами (tests/).
//
// ЕДИНСТВЕННЫЙ источник правил из readme «Ролевая модель (v4.10.0)»:
//   Руководитель — всё, назначает исполнителей
//   Менеджер     — свои задачи/проекты, ВСЕ контакты (v4.26.0)
//   Исполнитель  — только свои задачи
//
// Ключевое правило (Проблемы 83-87): «видишь ровно то, чем управляешь».
// Список, права на просмотр и права на действия должны совпадать.
// ============================================================================

const ROLES = {
    ADMIN: 'Руководитель',
    MANAGER: 'Менеджер',
    EXECUTOR: 'Исполнитель'
};

// ─────────────────────────── Базовые проверки роли ──────────────────────────
function isAdminRole(emp) {
    return !!(emp && emp.Роль === ROLES.ADMIN);
}

function isManagerRole(emp) {
    return !!(emp && (emp.Роль === ROLES.ADMIN || emp.Роль === ROLES.MANAGER));
}

// ─────────────────────────── Что умеет роль (readme) ────────────────────────
function canCreateTask(emp) {
    return isManagerRole(emp); // Руководитель и Менеджер
}

function canCreateProject(emp) {
    return isManagerRole(emp);
}

function canSeeBackups(emp) {
    return isAdminRole(emp); // только Руководитель (/backup)
}

function canSeeStatus(emp) {
    return isAdminRole(emp); // только Руководитель (/status)
}

function canSeeContacts(emp) {
    // v4.26.0: Менеджер видит ВСЮ клиентскую базу (общий справочник компании).
    return isManagerRole(emp);
}

function canSeeProjects(emp) {
    // v4.21.3 (Проблема 84): Исполнитель фактически нигде не видит проекты
    // (списки/карточки/архив блокируют) — функция приведена к реальному поведению.
    return isManagerRole(emp);
}

function canSuggestTask(emp) {
    // «Предложить задачу» — Менеджер и Исполнитель (Руководитель создаёт напрямую).
    return !!(emp && (emp.Роль === ROLES.MANAGER || emp.Роль === ROLES.EXECUTOR));
}

// ─────────────────── Отправка документов («выстрел наружу») ──────────────────
// v4.42.0, модель «внутри/наружу» (Волна A):
//   - «внутри» (ведение сделки: позиции заказа, черновики документов) — право
//     РОЛИ Менеджер, флаг не нужен;
//   - «наружу» (отправить документ клиенту email/вручную, статус «Отправлен»/
//     «Закрыт», внесение оплат) — только сотрудники с флагом «Отправка документов».
//   Руководитель — ВСЕГДА (владелец, флаг на него не влияет); Исполнитель — никогда.
//
// Имя колонки-галочки в «Сотрудники» — единый источник для roles.js и bot.js
// (кэш сотрудников обязан класть это поле в объект сотрудника).
const DOCS_FLAG_FIELD = 'Отправка документов';

function canSendDocuments(emp) {
    if (!emp) return false; // не-сотрудник: fail-closed
    if (isAdminRole(emp)) return true;
    if (emp.Роль !== ROLES.MANAGER) return false;
    // Checkbox из NocoDB приходит true/1/'1'/'true'; пусто/0 = галочки нет.
    const v = emp[DOCS_FLAG_FIELD];
    return v === true || v === 1 || v === '1' || v === 'true';
}

function canSendPDF(emp) {
    // Исторический хелпер «отправка PDF» — тот же «выстрел наружу».
    // Единый источник правды — canSendDocuments (тесты проверяют обе).
    return canSendDocuments(emp);
}

function canGetForwardContacts(emp) {
    // v4.26.0: пересылка контактов доступна Руководителю и Менеджеру (вся база).
    return isManagerRole(emp);
}

// ─────────────────── Фильтрация задач по роли (Проблема 84) ─────────────────
// tasks — массив задач из NocoDB. emp — сотрудник (или null).
// Менеджер: свои задачи + задачи по своим проектам (включая «без исполнителя» в них).
// Общая корзина (Исполнитель=null вне своих проектов) — ТОЛЬКО Руководитель-диспетчер.
// Исполнитель: только свои задачи.
function filterTasksByRole(tasks, emp) {
    if (!emp) return tasks;
    if (isAdminRole(emp)) return tasks;

    const empId = emp.Id;

    if (emp.Роль === ROLES.MANAGER) {
        return tasks.filter(t => {
            if (t['Исполнитель']?.Id === empId) return true;
            if (t['Какой проект'] && t['Какой проект']['Менеджер']?.Id === empId) return true;
            return false;
        });
    }

    // EXECUTOR — только свои задачи
    return tasks.filter(t => t['Исполнитель']?.Id === empId);
}

// ───────────── Доступ к КОНКРЕТНОЙ задаче (guard владения объектом) ─────────
// Для действий «по id» (комментарий, файл, пересылка в задачу, закрытие,
// редактирование): Руководитель — любая, Менеджер — своя или своего проекта,
// Исполнитель — только своя. То же правило, что filterTasksByRole, но для ОДНОЙ
// задачи (не даёт «подделать» callback_data с чужим taskId).
// Используется в ветках бота; чистая, покрыта тестами.
function canAccessTask(task, emp) {
    if (!emp) return false; // не-сотрудник: fail-closed
    if (isAdminRole(emp)) return true;

    const empId = emp.Id;
    const isOwnTask = task?.['Исполнитель']?.Id === empId;
    if (emp.Роль === ROLES.MANAGER) {
        const isOwnProjectTask = task?.['Какой проект']?.['Менеджер']?.Id === empId;
        return isOwnTask || isOwnProjectTask;
    }
    // EXECUTOR — только свои задачи
    return isOwnTask;
}

module.exports = {
    ROLES,
    DOCS_FLAG_FIELD,
    isAdminRole,
    isManagerRole,
    canCreateTask,
    canCreateProject,
    canSeeBackups,
    canSeeStatus,
    canSeeContacts,
    canSeeProjects,
    canSuggestTask,
    canSendDocuments,
    canSendPDF,
    canGetForwardContacts,
    filterTasksByRole,
    canAccessTask
};
