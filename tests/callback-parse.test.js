// ============================================================================
// tests/callback-parse.test.js — разбор callback_data позиций заказа (v4.42.1)
// ============================================================================
// Защита от бага «тап по карточке позиции → Сессия устарела»: projectId у
// pitem_* лежит на разных сегментах; единый парсер обязан разбирать ВСЕ формы.
// Запуск: node --test tests/
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseItemCallback, parseCardCallback } = require('../shared/callback-parse');

test('save/cancel — без проекта (берётся из черновика сессии)', () => {
    assert.deepEqual(parseItemCallback('pitem_save'), { kind: 'save', itemId: null, projectId: null, value: null });
    assert.deepEqual(parseItemCallback('pitem_cancel'), { kind: 'cancel', itemId: null, projectId: null, value: null });
});

test('pitem_new_{projectId} — создание в проекте', () => {
    assert.deepEqual(parseItemCallback('pitem_new_42'), { kind: 'new', itemId: null, projectId: 42, value: null });
});

test('pitem_{itemId}_{projectId} — карточка (баг «сессия устарела»)', () => {
    assert.deepEqual(parseItemCallback('pitem_5_1'), { kind: 'view', itemId: 5, projectId: 1, value: null });
    assert.deepEqual(parseItemCallback('pitem_123_99'), { kind: 'view', itemId: 123, projectId: 99, value: null });
});

test('type/unit — значение в середине, проект в конце', () => {
    assert.deepEqual(parseItemCallback('pitem_type_Товар_1'), { kind: 'type', itemId: null, projectId: 1, value: 'Товар' });
    assert.deepEqual(parseItemCallback('pitem_type_Изделие_7'), { kind: 'type', itemId: null, projectId: 7, value: 'Изделие' });
    assert.deepEqual(parseItemCallback('pitem_unit_шт._3'), { kind: 'unit', itemId: null, projectId: 3, value: 'шт.' });
    assert.deepEqual(parseItemCallback('pitem_unit_кг._10'), { kind: 'unit', itemId: null, projectId: 10, value: 'кг.' });
});

test('price/qty/del/del_yes — itemId и проект', () => {
    assert.deepEqual(parseItemCallback('pitem_price_5_1'), { kind: 'price', itemId: 5, projectId: 1, value: null });
    assert.deepEqual(parseItemCallback('pitem_qty_5_1'), { kind: 'qty', itemId: 5, projectId: 1, value: null });
    assert.deepEqual(parseItemCallback('pitem_del_5_1'), { kind: 'del', itemId: 5, projectId: 1, value: null });
    assert.deepEqual(parseItemCallback('pitem_del_yes_5_1'), { kind: 'del_yes', itemId: 5, projectId: 1, value: null });
    assert.deepEqual(parseItemCallback('pitem_del_yes_123_42'), { kind: 'del_yes', itemId: 123, projectId: 42, value: null });
});

test('Битые/чужие колбэки → null', () => {
    assert.equal(parseItemCallback(null), null);
    assert.equal(parseItemCallback(undefined), null);
    assert.equal(parseItemCallback(''), null);
    assert.equal(parseItemCallback('pitem_'), null);
    assert.equal(parseItemCallback('pitem_new'), null);            // без проекта
    assert.equal(parseItemCallback('pitem_5'), null);              // карточка без проекта
    assert.equal(parseItemCallback('pitem_type_Товар'), null);     // тип без проекта
    assert.equal(parseItemCallback('pitem_price_x_1'), null);      // битый itemId
    assert.equal(parseItemCallback('proj_items_5'), null);         // чужой префикс
    assert.equal(parseItemCallback('ptasks_5_0'), null);           // чужой префикс
});

// ============================================================================
// v4.55.0: карточки контакта/юрлица + «возврат в проект» (хвостовой projectId)
// ============================================================================
test('ccard_{id} — карточка контакта без контекста проекта (старое поведение)', () => {
    assert.deepEqual(parseCardCallback('ccard_7'), { kind: 'contact', id: 7, returnProjectId: null });
    assert.deepEqual(parseCardCallback('ccard_15'), { kind: 'contact', id: 15, returnProjectId: null });
});

test('ccard_{id}_{projectId} — открыли из карточки проекта → возврат в проект', () => {
    assert.deepEqual(parseCardCallback('ccard_7_42'), { kind: 'contact', id: 7, returnProjectId: 42 });
    assert.deepEqual(parseCardCallback('ccard_123_1'), { kind: 'contact', id: 123, returnProjectId: 1 });
});

test('lcard_{id} / lcard_{id}_{projectId} — карточка юрлица', () => {
    assert.deepEqual(parseCardCallback('lcard_3'), { kind: 'legal', id: 3, returnProjectId: null });
    assert.deepEqual(parseCardCallback('lcard_3_42'), { kind: 'legal', id: 3, returnProjectId: 42 });
});

test('Нечисловой хвост трактуем как «без проекта» (старые кнопки не ломаются)', () => {
    assert.deepEqual(parseCardCallback('ccard_7_back'), { kind: 'contact', id: 7, returnProjectId: null });
});

test('Битые/чужие колбэки карточек → null', () => {
    assert.equal(parseCardCallback(null), null);
    assert.equal(parseCardCallback(undefined), null);
    assert.equal(parseCardCallback(''), null);
    assert.equal(parseCardCallback('ccard_'), null);          // без id
    assert.equal(parseCardCallback('ccard_x'), null);         // битый id
    assert.equal(parseCardCallback('lcard_x_5'), null);       // битый id
    assert.equal(parseCardCallback('pcard_5'), null);         // чужой префикс
    assert.equal(parseCardCallback('ccard_back'), null);      // exact-колбэк, не карточка
    assert.equal(parseCardCallback('lcard_back'), null);      // exact-колбэк, не карточка
});
