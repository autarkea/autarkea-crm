// ============================================================================
// tests/watchdog.test.js — Watchdog Telegram-поллинга (v4.46.0, Проблема 117)
// ============================================================================
// Чистая логика решения «завис ли поллинг» живёт в shared/watchdog.js
// (без сети и файлов). Правило: меняешь логику — сначала сюда.
//
// Запуск (Node на хосте, без контейнеров):
//   node --test tests/
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const watchdog = require('../shared/watchdog');
const { DEFAULTS } = watchdog;

// ─────────────────── Здоровый поллинг (апдейты доходят) ────────────────────
test('апдейты доходят — healthy, подозрения сброшены', () => {
    const r = watchdog.evaluatePollHealth({ pending: 5, processedSincePrev: true, strike: 1 });
    assert.equal(r.wedged, false);
    assert.equal(r.strike, 0);
});

test('апдейты доходят даже при большой очереди — healthy (очередь ещё не забрана)', () => {
    // Пачка сообщений уже пришла в процесс (processedSincePrev=true) — это
    // НЕ застревание: следующий getUpdates заберёт остаток очереди.
    const r = watchdog.evaluatePollHealth({ pending: 30, processedSincePrev: true, strike: 0 });
    assert.equal(r.wedged, false);
});

// ─────────────────── Тихий период (нет сообщений вообще) ───────────────────
test('очередь пуста и апдейтов нет — пауза, НЕ застревание', () => {
    const r = watchdog.evaluatePollHealth({ pending: 0, processedSincePrev: false, strike: 0 });
    assert.equal(r.wedged, false);
    assert.equal(r.strike, 0);
});

// ─────────────────── Подозрение и срабатывание по накоплению ────────────────
test('первый тик с pending>0 и без апдейтов — подозрение, но не срабатывание', () => {
    const r = watchdog.evaluatePollHealth({ pending: 3, processedSincePrev: false, strike: 0 });
    assert.equal(r.wedged, false);
    assert.equal(r.strike, 1);
});

test('второй тик подряд с pending>0 и без апдейтов — WEDGED (срабатывание)', () => {
    const r = watchdog.evaluatePollHealth({ pending: 4, processedSincePrev: false, strike: 1 });
    assert.equal(r.wedged, true);
    assert.equal(r.strike, 0); // счётчик сброшен — решение принято
});

test('срабатывание настраивается порогом wedgeStrikes', () => {
    const r3 = watchdog.evaluatePollHealth({ pending: 1, processedSincePrev: false, strike: 2, wedgeStrikes: 3 });
    assert.equal(r3.wedged, true);
    const r1 = watchdog.evaluatePollHealth({ pending: 1, processedSincePrev: false, strike: 0, wedgeStrikes: 1 });
    assert.equal(r1.wedged, true);
});

// ─────────────────── Мгновенное срабатывание по скачку очереди ──────────────
test('pending ≥ immediatePending — WEDGED сразу, без второго тика', () => {
    const r = watchdog.evaluatePollHealth({
        pending: DEFAULTS.immediatePending,
        processedSincePrev: false,
        strike: 0,
    });
    assert.equal(r.wedged, true);
});

test('срабатывание не наступает на первом тике при pending ниже immediate', () => {
    const r = watchdog.evaluatePollHealth({
        pending: DEFAULTS.immediatePending - 1,
        processedSincePrev: false,
        strike: 0,
    });
    assert.equal(r.wedged, false);
    assert.equal(r.strike, 1);
});

// ─────────────────── Восстановление после подозрений ───────────────────────
test('после подозрения апдейты пошли — счётчик сбрасывается', () => {
    let state = watchdog.evaluatePollHealth({ pending: 2, processedSincePrev: false, strike: 0 });
    assert.equal(state.wedged, false);
    state = watchdog.evaluatePollHealth({ pending: 2, processedSincePrev: true, strike: state.strike });
    assert.equal(state.wedged, false);
    assert.equal(state.strike, 0);
});

// ─────────────────── Устойчивость к кривым входным данным ───────────────────
test('кривые входные данные не валят функцию (fail-safe)', () => {
    assert.equal(watchdog.evaluatePollHealth().wedged, false);
    assert.equal(watchdog.evaluatePollHealth({ pending: 'x', processedSincePrev: false }).wedged, false);
    assert.equal(watchdog.evaluatePollHealth({ pending: -1, processedSincePrev: false }).wedged, false);
    assert.equal(watchdog.evaluatePollHealth({ pending: 0, processedSincePrev: false, strike: 'x' }).strike, 0);
});

// ─────────────────────────────── Дефолты ────────────────────────────────────
test('дефолтные пороги не «протекают» (не дают мгновенное срабатывание на малом pending)', () => {
    assert.equal(watchdog.evaluatePollHealth({ pending: 5, processedSincePrev: false }).wedged, false);
});
