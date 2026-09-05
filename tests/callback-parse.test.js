// ============================================================================
// tests/callback-parse.test.js — разбор callback_data позиций заказа (v4.42.1)
// ============================================================================
// Защита от бага «тап по карточке позиции → Сессия устарела»: projectId у
// pitem_* лежит на разных сегментах; единый парсер обязан разбирать ВСЕ формы.
// Запуск: node --test tests/
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseItemCallback } = require('../shared/callback-parse');

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
    assert.deepEqual(parseItemCallback('pitem_type_Товар+Работа_7'), { kind: 'type', itemId: null, projectId: 7, value: 'Товар+Работа' });
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
