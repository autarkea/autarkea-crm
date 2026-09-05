// ============================================================================
// tests/text.test.js — утилиты shared/text.js (markdown/транслит/кнопки)
// ============================================================================
// Запуск: node --test tests/
// ============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { escapeMarkdown, cleanButtonText, plainTextFromMarkdown, normalizeSearch } = require('../shared/text');

test('escapeMarkdown экранирует спецсимволы Markdown v1, кириллицу не трогает', () => {
    assert.equal(escapeMarkdown('Привет_мир'), 'Привет\\_мир');
    // ] — НЕ экранируется (как было исторически в bot.js)
    assert.equal(escapeMarkdown('a*b`c[d]'), 'a\\*b\\`c\\[d]');
    assert.equal(escapeMarkdown(null), '');
    assert.equal(escapeMarkdown('обычный текст'), 'обычный текст');
});

test('escapeMarkdown: обратный слэш экранируется первым', () => {
    assert.equal(escapeMarkdown('a\\b'), 'a\\\\b');
});

test('cleanButtonText: схлопывает пробелы, режет с многоточием', () => {
    assert.equal(cleanButtonText('  много    пробелов  '), 'много пробелов');
    assert.equal(cleanButtonText('x'.repeat(100)).endsWith('…'), true);
    assert.equal(cleanButtonText('коротко', 5), 'корот…');
    assert.equal(cleanButtonText(''), '');
    assert.equal(cleanButtonText(null), '');
});

test('plainTextFromMarkdown: убирает разметку и экранирование', () => {
    assert.equal(plainTextFromMarkdown('*жирный* _курсив_ `код` [a](b)'), 'жирный курсив код a(b)');
    // Спецсимволы удаляются ДО бэкслешей, поэтому '_' тоже исчезает (поведение как в bot.js)
    assert.equal(plainTextFromMarkdown('\\_экранированный\\_'), 'экранированный');
    assert.equal(plainTextFromMarkdown(''), '');
});

test('plainTextFromMarkdown: длинный текст обрезается (лимит 3900)', () => {
    const long = 'абв'.repeat(2000);
    const out = plainTextFromMarkdown(long);
    assert.ok(out.length <= 3900 + 50, `len=${out.length}`);
    assert.ok(out.includes('…(обрезано'));
});

test('normalizeSearch: кириллица → транслит, регистр не важен', () => {
    assert.equal(normalizeSearch('Иван'), 'ivan');
    assert.equal(normalizeSearch('ivan'), 'ivan');
    assert.equal(normalizeSearch('Щука Ёж'), 'schuka ezh');
    assert.equal(normalizeSearch('  Иван  '), 'ivan');
    assert.equal(normalizeSearch(''), '');
    assert.equal(normalizeSearch(null), '');
});
