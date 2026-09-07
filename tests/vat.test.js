// ============================================================================
// tests/vat.test.js — контроль формул НДС (shared/vat.js, v4.37.0)
// ============================================================================
// Запуск (Node на хосте, без контейнеров и зависимостей):
//   node --test tests/
//
// Формулы зафиксированы в документации → раздел «Расчёт НДС» и применяются
// в двух местах: сводка карточки проекта (bot/bot.js getProjectSummary) и
// форма отправки email (bot/server.js). Если меняешь формулы — сначала сюда.
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const vat = require('../shared/vat');

const round2 = (n) => Math.round(n * 100) / 100;

// ─────────────────────────── Три режима НДС ─────────────────────────────────
// Таблица расчётов (из документации):
//   Без НДС            | 2000.00 | 0      | 2000.00
//   Начисляется сверху | 2000.00 | 400.00 | 2400.00
//   Включен в цену     | 2400.00 | 400.00 | 2400.00
test('Без НДС: НДС = 0, итого = база', () => {
    const r = vat.computeVat(2000, 20, vat.VAT_NONE);
    assert.equal(r.vatAmount, 0);
    assert.equal(r.totalWithVat, 2000);
});

test('Начисляется сверху (20%): НДС = база × 20/100, итого = база + НДС', () => {
    const r = vat.computeVat(2000, 20, vat.VAT_ON_TOP);
    assert.equal(r.vatAmount, 400);
    assert.equal(r.totalWithVat, 2400);
});

test('Включен в цену (20%): НДС вытаскивается из базы, итого = база', () => {
    const r = vat.computeVat(2400, 20, vat.VAT_INCLUDED);
    assert.equal(round2(r.vatAmount), 400);
    assert.equal(r.totalWithVat, 2400);
});

// ─────────────────────── Защита от кривых данных ────────────────────────────
test('Пустой тип НДС = «Без НДС» (fallback)', () => {
    const r = vat.computeVat(2000, 20, undefined);
    assert.equal(r.vatType, vat.VAT_NONE);
    assert.equal(r.vatAmount, 0);
    assert.equal(r.totalWithVat, 2000);
});

test('Ставка 0/пусто — НДС не начисляется даже при типе «сверху»', () => {
    const r = vat.computeVat(2000, 0, vat.VAT_ON_TOP);
    assert.equal(r.vatAmount, 0);
    assert.equal(r.totalWithVat, 2000);
});

test('Неизвестный тип НДС — без НДС, а не NaN', () => {
    const r = vat.computeVat(2000, 20, 'Включен');
    assert.equal(r.vatType, 'Включен');
    assert.equal(r.vatAmount, 0);
    assert.equal(r.totalWithVat, 2000);
});

test('Числа строкой парсятся', () => {
    const r = vat.computeVat('2000', '20', vat.VAT_ON_TOP);
    assert.equal(r.vatAmount, 400);
    assert.equal(r.totalWithVat, 2400);
});

// ─────────────────────── Материалы заказчика ────────────────────────────────
test('isCustomerMaterial: «Мат. заказчика» — да, остальное — нет', () => {
    assert.equal(vat.isCustomerMaterial({ Тип: 'Мат. заказчика' }), true);
    assert.equal(vat.isCustomerMaterial({ Тип: 'Товар' }), false);
    assert.equal(vat.isCustomerMaterial({ Тип: 'Работа' }), false);
    assert.equal(vat.isCustomerMaterial({}), false);
    assert.equal(vat.isCustomerMaterial(null), false);
});
