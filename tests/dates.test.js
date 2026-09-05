// ============================================================================
// tests/dates.test.js — утилиты дат shared/dates.js (таймзона параметром)
// ============================================================================
// Запуск: node --test tests/
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const dates = require('../shared/dates');
const { formatFull, formatDayTime, formatTime, buildDateInTZ, parseSmartDeadline, parseQuickDeadline } = dates;

const MINSK = 'Europe/Minsk'; // UTC+3, без перехода на летнее время
const UTC_11 = '2026-09-05T11:00:00Z'; // 14:00 в Минске

// ─────────────────────────────── Форматы ────────────────────────────────────
test('formatFull: полная дата и время в таймзоне', () => {
    const out = formatFull(UTC_11, MINSK);
    assert.ok(out.startsWith('05.09.2026'), out);
    assert.ok(out.includes('14:00'), out);
});

test('formatFull: пусто/битое значение → null/как было', () => {
    assert.equal(formatFull(null, MINSK), null);
    assert.equal(formatFull('', MINSK), null);
});

test('formatDayTime: день.месяц + время (без года)', () => {
    const out = formatDayTime(UTC_11, MINSK);
    assert.ok(out.startsWith('05.09'), out);
    assert.ok(out.includes('14:00'), out);
    assert.ok(!out.includes('2026'), out);
});

test('formatTime: только время', () => {
    assert.equal(formatTime(UTC_11, MINSK), '14:00');
});

// ─────────────────────────────── Построение дат ─────────────────────────────
test('buildDateInTZ: сегодня 10:00 по Минску — локальные часы = 10', () => {
    const d = buildDateInTZ(MINSK, 0, 10, 0);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: MINSK, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    const hour = parts.find(p => p.type === 'hour').value;
    assert.equal(hour, '10');
});

test('buildDateInTZ: +1 день — дата сдвигается', () => {
    const nowTZ = new Date(new Date().toLocaleString('en-US', { timeZone: MINSK }));
    const tomorrow = buildDateInTZ(MINSK, 1, 9, 0);
    const tomorrowTZ = new Date(tomorrow.toLocaleString('en-US', { timeZone: MINSK }));
    const dayDiff = Math.round((Date.UTC(tomorrowTZ.getFullYear(), tomorrowTZ.getMonth(), tomorrowTZ.getDate())
        - Date.UTC(nowTZ.getFullYear(), nowTZ.getMonth(), nowTZ.getDate())) / 86400000);
    assert.equal(dayDiff, 1);
});

// ─────────────────────────── Умный парсер срока ─────────────────────────────
test('parseQuickDeadline: 3h → ~через 3 часа; week → ~через 7 дней; none → null', () => {
    const before = Date.now();
    const d3 = parseQuickDeadline('3h', MINSK);
    assert.ok(d3 instanceof Date);
    const diff3 = d3.getTime() - before;
    assert.ok(diff3 > 2.5 * 3600 * 1000 && diff3 < 3.5 * 3600 * 1000, `diff3=${diff3}`);

    const d7 = parseQuickDeadline('week', MINSK);
    const diff7 = d7.getTime() - before;
    assert.ok(diff7 > 6.5 * 86400000 && diff7 < 7.5 * 86400000, `diff7=${diff7}`);

    assert.equal(parseQuickDeadline('none', MINSK), null);
    assert.equal(parseQuickDeadline('garbage', MINSK), null);
});

test('parseSmartDeadline: завтра → дата в будущем на 1 день в 09:00', () => {
    const d = parseSmartDeadline('завтра', MINSK);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: MINSK, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    assert.equal(parts.find(p => p.type === 'hour').value, '09');
    assert.equal(parts.find(p => p.type === 'minute').value, '00');
});

test('parseSmartDeadline: явная дата 17.06.2026 14:00 (Минск, UTC+3)', () => {
    const d = parseSmartDeadline('17.06.2026 14:00', MINSK);
    assert.equal(d.toISOString(), '2026-06-17T11:00:00.000Z');
});

test('parseSmartDeadline: невалидные даты → null', () => {
    assert.equal(parseSmartDeadline('32.06', MINSK), null);
    assert.equal(parseSmartDeadline('17.13', MINSK), null);
    assert.equal(parseSmartDeadline('25:00', MINSK), null);
    assert.equal(parseSmartDeadline('совсем непонятно', MINSK), null);
});

test('parseSmartDeadline: относительные сроки «через 2 дня»/«через 5 часов»', () => {
    const before = Date.now();
    const d2 = parseSmartDeadline('через 2 дня', MINSK);
    assert.ok(d2.getTime() - before > 1.5 * 86400000);
    const h5 = parseSmartDeadline('через 5 часов', MINSK);
    assert.ok(h5.getTime() - before > 4 * 3600 * 1000 && h5.getTime() - before < 6 * 3600 * 1000);
});
