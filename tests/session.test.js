// ============================================================================
// tests/session.test.js — per-chat сессии (v4.29.0)
// ============================================================================
// Контрольный лист «у каждого чата своё состояние, чужие не пересекаются»:
//   - getSession лениво создаёт сессию с дефолтами;
//   - resetSession сбрасывает ТОЛЬКО свой чат;
//   - deleteSession освобождает память;
//   - cleanupStaleSessions чинит «залипшие» сессии без ущерба чужим;
//   - дефолтная сессия содержит ВСЕ поля черновиков (ни один флоу не должен
//     получить undefined там, где раньше поле существовало).
//
// Запуск (Node на хосте, без контейнеров и зависимостей):
//   node --test tests/
//
// Правило: меняешь структуру сессии (shared/session.js) — этот файл должен
// остаться зелёным. Меняешь флоу в bot.js — дефолты не трогай, а если нужно
// новое поле — добавь его сюда ПЕРВЫМ.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const sessionMod = require('../shared/session');
const { emptySession, getSession, resetSession, deleteSession, cleanupStaleSessions, cleanupIdleSessions, touchSession } = sessionMod;

// ─────────────────────────── Дефолтная сессия ───────────────────────────────
test('Дефолтная сессия: state=idle и ВСЕ черновики на месте', () => {
    const s = emptySession();
    assert.equal(s.state, 'idle');
    assert.ok(s.taskDraft, 'taskDraft должен существовать');
    assert.ok(s.legalDraft, 'legalDraft должен существовать');
    assert.ok(s.contactDraft, 'contactDraft должен существовать');
    assert.ok(s.projectDraft, 'projectDraft должен существовать');
    assert.ok(s.itemDraft, 'itemDraft должен существовать (v4.42.1: визард позиции заказа)');
    assert.ok(s.pendingContactAction, 'pendingContactAction должен существовать');
});

test('itemDraft содержит все поля визарда позиции заказа (v4.42.1)', () => {
    const s = emptySession();
    const fields = ['projectId', 'itemId', 'editField', 'type', 'name', 'unit', 'price', 'qty'];
    for (const f of fields) {
        assert.ok(f in s.itemDraft, `itemDraft.${f} должно существовать`);
    }
    assert.equal(s.itemDraft.unit, 'шт.');
    assert.equal(s.itemDraft.name, '');
});

test('docDraft содержит все поля визарда документа (v4.42.2)', () => {
    const s = emptySession();
    const fields = ['projectId', 'type', 'stamp', 'note'];
    for (const f of fields) {
        assert.ok(f in s.docDraft, `docDraft.${f} должно существовать`);
    }
    assert.equal(s.docDraft.stamp, true, '«С печатью» по умолчанию — ДА');
    assert.equal(s.docDraft.note, '');
});

test('payDraft содержит поля внесения оплаты (v4.42.4)', () => {
    const s = emptySession();
    assert.ok(s.payDraft, 'payDraft должен существовать');
    assert.ok('projectId' in s.payDraft, 'payDraft.projectId должно существовать');
    assert.equal(s.payDraft.projectId, null);
});

test('editDraft и orgDraft содержат поля правки карточек (v4.43.0)', () => {
    const s = emptySession();
    // «✏️ Изменить» в карточке контакта/юрлица: какое поле сейчас правим
    assert.ok(s.editDraft, 'editDraft должен существовать');
    for (const f of ['kind', 'id', 'field']) {
        assert.ok(f in s.editDraft, `editDraft.${f} должно существовать`);
    }
    assert.equal(s.editDraft.kind, null);
    assert.equal(s.editDraft.id, null);
    assert.equal(s.editDraft.field, null);
    // привязка контакта к юрлицу («🏢 Привязать юрлицо»)
    assert.ok(s.orgDraft, 'orgDraft должен существовать');
    for (const f of ['contactId', 'legalId']) {
        assert.ok(f in s.orgDraft, `orgDraft.${f} должно существовать`);
    }
    assert.equal(s.orgDraft.contactId, null);
    assert.equal(s.orgDraft.legalId, null);
});

test('taskDraft содержит все поля, которые использует бот', () => {
    const s = emptySession();
    const fields = ['title', 'deadline', 'projectId', 'editTaskId', 'commentTaskId', 'fileTaskId', 'fileProjectId', 'folderProjectId'];
    for (const f of fields) {
        assert.ok(f in s.taskDraft, `taskDraft.${f} должно существовать`);
    }
    assert.equal(s.taskDraft.title, '');
    assert.equal(s.taskDraft.deadline, null);
});

test('projectDraft содержит все поля, которые использует бот', () => {
    const s = emptySession();
    const fields = ['title', 'contactId', 'legalId', 'tab', 'noteProjectId', 'deadlineProjectId', 'transferProjectId', 'managerId', 'source', 'attachProjectId', 'dupProjectId'];
    for (const f of fields) {
        assert.ok(f in s.projectDraft, `projectDraft.${f} должно существовать`);
    }
    assert.equal(s.projectDraft.tab, 'fiz');
    assert.equal(s.projectDraft.source, 'menu');
});

test('pendingContactAction содержит все поля forward-флоу', () => {
    const s = emptySession();
    const fields = ['active', 'contactId', 'waitingPhone', 'waitingProjectForMessage', 'forwardedData', 'afterContactCreated', 'isHiddenProfile', 'hiddenProfileMessageText'];
    for (const f of fields) {
        assert.ok(f in s.pendingContactAction, `pendingContactAction.${f} должно существовать`);
    }
    assert.equal(s.pendingContactAction.active, false);
    assert.deepEqual(s.pendingContactAction.forwardedData, { messageText: '', projectId: null });
});

// ─────────────────────── getSession / resetSession ──────────────────────────
test('getSession лениво создаёт сессию и возвращает ту же при повторе', () => {
    const m = new Map();
    const s1 = getSession(m, 111);
    assert.equal(m.size, 1);
    const s2 = getSession(m, 111);
    assert.equal(s1, s2, 'повторный getSession должен вернуть ту же сессию');
    assert.equal(m.size, 1, 'не должно создаваться дублей');
});

test('Разные chatId — РАЗНЫЕ сессии (суть фикса)', () => {
    const m = new Map();
    const a = getSession(m, 1001);
    const b = getSession(m, 1002);
    assert.notEqual(a, b);
    a.state = 'waiting_title';
    a.taskDraft.title = 'Задача А';
    assert.equal(b.state, 'idle', 'состояние чата Б не должно измениться');
    assert.equal(b.taskDraft.title, '', 'черновик чата Б не должен измениться');
});

test('resetSession сбрасывает ТОЛЬКО свой чат', () => {
    const m = new Map();
    const a = getSession(m, 2001);
    const b = getSession(m, 2002);
    a.state = 'waiting_title';
    a.taskDraft.title = 'Черновик А';
    b.state = 'waiting_project_title';
    resetSession(m, 2001);
    assert.equal(a.state, 'idle');
    assert.equal(a.taskDraft.title, '');
    assert.equal(b.state, 'waiting_project_title', 'чужой чат не должен сброситься');
    assert.equal(m.size, 2, 'сессия остаётся в Map после сброса');
});

test('deleteSession полностью удаляет чат из памяти', () => {
    const m = new Map();
    getSession(m, 3001);
    getSession(m, 3002);
    assert.equal(m.size, 2);
    deleteSession(m, 3001);
    assert.equal(m.size, 1);
    assert.equal(m.has(3002), true);
});

// ─────────────────────── cleanupStaleSessions ───────────────────────────────
test('cleanupStaleSessions сбрасывает ТОЛЬКО залипшие (не-idle старше порога)', () => {
    const m = new Map();
    const stale = getSession(m, 4001);
    stale.state = 'waiting_title';
    touchSession(stale);
    stale._updatedAt = Date.now() - 3 * 3600 * 1000; // «залипла» 3 часа назад

    const active = getSession(m, 4002);
    active.state = 'waiting_title';
    touchSession(active); // свежая — не трогаем

    const idle = getSession(m, 4003);
    idle._updatedAt = Date.now() - 10 * 3600 * 1000; // старый, но IDLE — не трогаем

    const cleaned = cleanupStaleSessions(m, 2 * 3600 * 1000);
    assert.equal(cleaned, 1);
    assert.equal(stale.state, 'idle', 'залипшая сессия должна сброситься');
    assert.equal(active.state, 'waiting_title', 'свежая сессия не должна пострадать');
    assert.equal(idle.state, 'idle');
});

test('touchSession проставляет _updatedAt', () => {
    const s = emptySession();
    assert.equal(s._updatedAt, undefined);
    touchSession(s);
    assert.ok(typeof s._updatedAt === 'number', '_updatedAt должен стать числом');
});


test('getSession проставляет _updatedAt и обновляет его при повторе', () => {
    const m = new Map();
    const s1 = getSession(m, 5001);
    assert.ok(typeof s1._updatedAt === 'number', '_updatedAt должен стать числом');
    s1._updatedAt = 111;
    getSession(m, 5001);
    assert.notEqual(s1._updatedAt, 111, 'повторный getSession должен обновить время активности');
});

test('cleanupIdleSessions удаляет ТОЛЬКО старые пустые (idle) сессии', () => {
    const m = new Map();
    const oldIdle = getSession(m, 6001);
    oldIdle._updatedAt = Date.now() - 2 * 24 * 3600 * 1000; // не активен 2 суток

    const freshIdle = getSession(m, 6002); // свежая idle — не трогаем

    const busy = getSession(m, 6003);
    busy.state = 'waiting_title';
    busy._updatedAt = Date.now() - 10 * 24 * 3600 * 1000; // занят, но давно (лечит cleanupStaleSessions, не idle-очистка)

    const removed = cleanupIdleSessions(m, 24 * 3600 * 1000);
    assert.equal(removed, 1);
    assert.equal(m.has(6001), false, 'старая пустая сессия удалена');
    assert.equal(m.has(6002), true, 'свежая пустая не тронута');
    assert.equal(m.has(6003), true, 'занятая (даже старая) не тронута idle-очисткой');
});

test('cleanupStaleSessions не падает на пустом Map', () => {
    const m = new Map();
    assert.equal(cleanupStaleSessions(m, 1000), 0);
});

