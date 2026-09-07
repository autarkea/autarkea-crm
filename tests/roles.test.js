// ============================================================================
// tests/roles.test.js — контрольный лист «кто что видит и делает»
// ============================================================================
// По таблице из readme «Ролевая модель (v4.10.0)» + решениям:
//   - v4.21.3 (Проблема 84): у Менеджера НЕТ «общей корзины» задач
//   - v4.26.0: Менеджер видит ВСЮ клиентскую базу (общий справочник)
//
// Запуск (Node на хосте, без контейнеров и зависимостей):
//   node --test tests/
//
// Правило: если меняешь права в shared/roles.js — этот файл должен
// остаться зелёным. Если правило в readme меняется — сначала сюда.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const roles = require('../shared/roles');
const { ROLES } = roles;

// ─── «Подопытные» сотрудники (структура как из NocoDB Data API) ────────────
const boss    = { Id: 1, ФИО: 'Босс',       Роль: ROLES.ADMIN };
const manager = { Id: 2, ФИО: 'Менеджер',   Роль: ROLES.MANAGER };
// v4.42.0: Менеджер с флагом «Отправка документов» (модель «внутри/наружу»)
const managerDocs = { Id: 2, ФИО: 'Менеджер', Роль: ROLES.MANAGER, [roles.DOCS_FLAG_FIELD]: true };
const worker  = { Id: 3, ФИО: 'Исполнитель', Роль: ROLES.EXECUTOR };
const stranger = null; // не-сотрудник (запрещено всё)

// ─────────────────────────── Базовые проверки роли ──────────────────────────
test('Руководитель — админ и менеджер', () => {
    assert.equal(roles.isAdminRole(boss), true);
    assert.equal(roles.isManagerRole(boss), true);
});

test('Менеджер — менеджер, но не админ', () => {
    assert.equal(roles.isAdminRole(manager), false);
    assert.equal(roles.isManagerRole(manager), true);
});

test('Исполнитель — ни админ, ни менеджер', () => {
    assert.equal(roles.isAdminRole(worker), false);
    assert.equal(roles.isManagerRole(worker), false);
});

test('Не-сотрудник (null) — ничего не может', () => {
    assert.equal(roles.isAdminRole(stranger), false);
    assert.equal(roles.isManagerRole(stranger), false);
    assert.equal(roles.canSeeContacts(stranger), false);
    assert.equal(roles.canSeeProjects(stranger), false);
    assert.equal(roles.canSendDocuments(stranger), false);
    assert.equal(roles.canSendDocuments(null), false); // fail-closed
});

// ─────────────────────────── Доступ к разделам ──────────────────────────────
test('Руководитель видит всё и может всё', () => {
    assert.equal(roles.canSeeContacts(boss), true);
    assert.equal(roles.canSeeProjects(boss), true);
    assert.equal(roles.canSeeStatus(boss), true);
    assert.equal(roles.canSeeBackups(boss), true);
    assert.equal(roles.canCreateTask(boss), true);
    assert.equal(roles.canCreateProject(boss), true);
    assert.equal(roles.canSendDocuments(boss), true); // Руководитель всегда (флаг не нужен)
    assert.equal(roles.canSendPDF(boss), true);
    assert.equal(roles.canGetForwardContacts(boss), true);
    assert.equal(roles.canSuggestTask(boss), false); // Руководитель не «предлагает», а создаёт
});

test('Менеджер видит ВСЮ клиентскую базу (v4.26.0)', () => {
    assert.equal(roles.canSeeContacts(manager), true);
    assert.equal(roles.canGetForwardContacts(manager), true);
});

test('Менеджер управляет задачами и проектами, но НЕ статусом/бэкапами', () => {
    assert.equal(roles.canCreateTask(manager), true);
    assert.equal(roles.canCreateProject(manager), true);
    assert.equal(roles.canSeeProjects(manager), true);
    // v4.42.0: отправка документов («выстрел наружу») — НЕ право роли, а флаг.
    // Менеджер БЕЗ флага готовит сделки (позиции/черновики), но не отправляет.
    assert.equal(roles.canSendPDF(manager), false);
    assert.equal(roles.canSendDocuments(manager), false);
    assert.equal(roles.canSeeStatus(manager), false);  // только Руководитель
    assert.equal(roles.canSeeBackups(manager), false); // только Руководитель
});

test('Менеджер С флагом «Отправка документов» может отправлять (v4.42.0)', () => {
    assert.equal(roles.canSendDocuments(managerDocs), true);
    assert.equal(roles.canSendPDF(managerDocs), true);
});

test('Флаг «Отправка документов» читается в форматах NocoDB Checkbox', () => {
    for (const v of [1, '1', 'true']) {
        const m = { Id: 2, ФИО: 'Менеджер', Роль: ROLES.MANAGER, [roles.DOCS_FLAG_FIELD]: v };
        assert.equal(roles.canSendDocuments(m), true, `значение ${v} должно давать true`);
    }
    // Пусто/0/undefined/false — галочки нет → отправка запрещена (fail-safe дефолт)
    for (const v of [undefined, 0, '0', false]) {
        const m = { Id: 2, ФИО: 'Менеджер', Роль: ROLES.MANAGER, [roles.DOCS_FLAG_FIELD]: v };
        assert.equal(roles.canSendDocuments(m), false, `значение ${v} должно давать false`);
    }
});

test('Исполнитель — только свои задачи, НИЧЕГО больше (v4.21.3)', () => {
    assert.equal(roles.canSeeContacts(worker), false);
    assert.equal(roles.canSeeProjects(worker), false);
    assert.equal(roles.canCreateTask(worker), false);
    assert.equal(roles.canCreateProject(worker), false);
    assert.equal(roles.canSendPDF(worker), false);
    assert.equal(roles.canSendDocuments(worker), false);
    assert.equal(roles.canSeeStatus(worker), false);
    assert.equal(roles.canSeeBackups(worker), false);
    assert.equal(roles.canGetForwardContacts(worker), false);
    assert.equal(roles.canSuggestTask(worker), true); // «Предложить задачу» — его инструмент
});

// ─────────────────── Фильтрация задач (Проблема 84) ─────────────────────────
// t — задача: Исполнитель {Id} и/или Проект с Менеджером {Id}
const t = (id, executorId, managerId) => ({
    Id: id,
    'Что делаем?': `Задача ${id}`,
    'Исполнитель': executorId ? { Id: executorId } : null,
    'Какой проект': managerId ? { Менеджер: { Id: managerId } } : null
});

test('Руководитель видит все задачи (включая общую корзину)', () => {
    const tasks = [t(1, 3, 2), t(2, null, null)];
    assert.equal(roles.filterTasksByRole(tasks, boss).length, 2);
});

test('Менеджер: свои + свои проекты, НО НЕ общая корзина (Проблема 84)', () => {
    const tasks = [
        t(1, 2, 2),       // его задача в его проекте      → видит
        t(2, 3, 2),       // чужой исполнитель в его проекте → видит (управляет проектом)
        t(3, 3, 1),       // чужой проект                   → НЕ видит
        t(4, null, null)  // общая корзина                  → НЕ видит (v4.21.3)
    ];
    const seen = roles.filterTasksByRole(tasks, manager);
    assert.deepEqual(seen.map(x => x.Id).sort(), [1, 2]);
});

test('Исполнитель видит только свои задачи', () => {
    const tasks = [t(1, 3, 2), t(2, 1, 1)];
    const seen = roles.filterTasksByRole(tasks, worker);
    assert.deepEqual(seen.map(x => x.Id), [1]);
});

test('Пустой кэш (emp=null) не отсекает задачи (совместимость с ботом)', () => {
    const tasks = [t(1, 3, 2), t(2, null, null)];
    assert.equal(roles.filterTasksByRole(tasks, null).length, 2);
});

// ─────────────────── Доступ к КОНКРЕТНОЙ задаче (canAccessTask) ─────────────
// t(id, executorId, managerId) уже объявлен выше. Задача «вне проекта» = managerId null.
test('canAccessTask: Руководитель имеет доступ к любой задаче', () => {
    assert.equal(roles.canAccessTask(t(1, 3, 2), boss), true);    // чужая, чужой проект
    assert.equal(roles.canAccessTask(t(2, null, null), boss), true); // общая корзина
});

test('canAccessTask: Менеджер — своя задача или задача своего проекта', () => {
    assert.equal(roles.canAccessTask(t(1, 2, 1), manager), true);  // своя задача
    assert.equal(roles.canAccessTask(t(2, 3, 2), manager), true);  // чужой исполнитель в его проекте
    assert.equal(roles.canAccessTask(t(3, null, 2), manager), true); // без исполнителя в его проекте
    assert.equal(roles.canAccessTask(t(4, 3, 1), manager), false); // чужой проект
    assert.equal(roles.canAccessTask(t(5, null, null), manager), false); // общая корзина — только Руководитель
});

test('canAccessTask: Исполнитель — только свою задачу', () => {
    assert.equal(roles.canAccessTask(t(1, 3, 2), worker), true);   // своя
    assert.equal(roles.canAccessTask(t(2, 2, 3), worker), false);  // чужая
    assert.equal(roles.canAccessTask(t(3, null, null), worker), false); // общая корзина
});

test('canAccessTask: не-сотрудник (null) — fail-closed', () => {
    assert.equal(roles.canAccessTask(t(1, 3, 2), stranger), false);
    assert.equal(roles.canAccessTask(t(1, 3, 2), null), false);
});
