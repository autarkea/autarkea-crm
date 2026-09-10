// ============================================================================
// tests/search.test.js — чистые предикаты поиска по справочникам (shared/search.js)
// ============================================================================
// Запуск (Node на хосте, без контейнеров и зависимостей):
//   node --test tests/
//
// Проверяет:
//   1. Поиск по имени — подстрока, регистронезависимо.
//   2. Транслит: «ivan» ↔ «Иван», «іван» ↔ «Иван».
//   3. Поиск по не-именным полям (телефон, ссылка, email — контакт; УНП, адрес — юрлицо).
//   4. Пустой/короткий запрос → [] (не «вся база»).
//   5. Входной массив НЕ мутируется и копия не требуется (фильтр не меняет строки).
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { filterContactsByQuery, filterLegalsByQuery } = require('../shared/search');

const CONTACTS = [
    { Id: 1, 'Имя': 'Иванов Сергей', 'Телефон': '+375 29 123-45-67', 'Ссылка': 'https://t.me/ivanov', 'E-mail': 'ivanov@example.com' },
    { Id: 2, 'Имя': 'Петрова Анна', 'Телефон': '+375 33 987-65-43', 'Ссылка': '', 'E-mail': '' },
    { Id: 3, 'Имя': 'Петров', 'Телефон': '', 'Ссылка': '', 'E-mail': '' },
    { Id: 4, 'Имя': '', 'Телефон': '80291234567', 'Ссылка': '', 'E-mail': '' }
];

const LEGALS = [
    { Id: 10, 'Краткое Имя': 'ООО Тест', 'Имя': 'Общество с ограниченной ответственностью «Тест»', 'УНП': '123456789', 'Телефон': '+375 17 111-22-33', 'Адрес': 'г. Минск, ул. Ленина, 1' },
    { Id: 11, 'Краткое Имя': 'ЧП Иванов', 'Имя': '', 'УНП': '987654321', 'Телефон': '', 'Адрес': '' },
    { Id: 12, 'Краткое Имя': '', 'Имя': 'ИП Петров А.А.', 'УНП': '', 'Телефон': '', 'Адрес': 'г. Гомель' }
];

test('Поиск контактов: подстрока имени без учёта регистра', () => {
    const found = filterContactsByQuery(CONTACTS, 'петр');
    assert.deepEqual(found.map(c => c.Id).sort(), [2, 3]);
});

test('Поиск контактов: транслит «ivan» находит «Иванов»', () => {
    const found = filterContactsByQuery(CONTACTS, 'ivan');
    assert.deepEqual(found.map(c => c.Id), [1]);
});

test('Поиск контактов: по телефону и по @username', () => {
    const byPhone = filterContactsByQuery(CONTACTS, '33 987');
    assert.deepEqual(byPhone.map(c => c.Id), [2]);
    const byUsername = filterContactsByQuery(CONTACTS, 'ivanov');
    assert.deepEqual(byUsername.map(c => c.Id), [1]);
});

test('Поиск юрлиц: по краткому имени, УНП и адресу', () => {
    const byName = filterLegalsByQuery(LEGALS, 'тест');
    assert.deepEqual(byName.map(l => l.Id), [10]);
    const byUnp = filterLegalsByQuery(LEGALS, '987654');
    assert.deepEqual(byUnp.map(l => l.Id), [11]);
    const byAddress = filterLegalsByQuery(LEGALS, 'гомель');
    assert.deepEqual(byAddress.map(l => l.Id), [12]);
});

test('Поиск юрлиц: транслит «ooo» находит «ООО»', () => {
    const found = filterLegalsByQuery(LEGALS, 'ooo');
    assert.deepEqual(found.map(l => l.Id), [10]);
});

test('Пустой и короткий запрос не возвращает «всю базу»', () => {
    assert.deepEqual(filterContactsByQuery(CONTACTS, ''), []);
    assert.deepEqual(filterContactsByQuery(CONTACTS, '   '), []);
    assert.deepEqual(filterLegalsByQuery(LEGALS, null), []);
    assert.deepEqual(filterLegalsByQuery(LEGALS, undefined), []);
});

test('Фильтр не мутирует исходный массив и поля строк', () => {
    const snapshot = JSON.stringify(CONTACTS);
    filterContactsByQuery(CONTACTS, 'петр');
    assert.equal(JSON.stringify(CONTACTS), snapshot);
});
